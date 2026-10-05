import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import { assertPublicUrl, fetchPublic, isBlockedAddress, pinnedRequest, readCapped, resolvePublicUrl } from '../src/core/safeUrl.js'
import { MediaService } from '../src/core/mediaService.js'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const PUBLIC_V4 = '93.184.216.34'
const PUBLIC_V4_B = '198.51.100.7'

describe('isBlockedAddress', () => {
  it('blocks loopback, private, link-local, CGNAT, multicast, unspecified and reserved v4', () => {
    for (const ip of [
      '127.0.0.1',
      '127.255.255.254',
      '10.0.0.1',
      '172.16.0.1',
      '172.31.255.255',
      '192.168.1.1',
      '192.0.0.192',
      '169.254.169.254',
      '100.64.0.1',
      '100.127.255.255',
      '0.0.0.0',
      '0.1.2.3',
      '224.0.0.1',
      '239.255.255.250',
      '255.255.255.255',
    ]) {
      expect(isBlockedAddress(ip), ip).toBe(true)
    }
  })

  it('blocks ::1, ::, ULA, link-local, multicast and Teredo for v6', () => {
    for (const ip of ['::1', '::', 'fc00::1', 'fd12:3456::1', 'fe80::1', 'ff02::1', '[::1]', 'fe80::1%en0', '2001:0:4136:e378::1']) {
      expect(isBlockedAddress(ip), ip).toBe(true)
    }
  })

  it('blocks every IPv6 form that embeds a private IPv4 address', () => {
    for (const ip of [
      '::ffff:127.0.0.1', // mapped, dotted
      '::ffff:7f00:1', // mapped, hex
      '::FFFF:10.0.0.5',
      '::127.0.0.1', // IPv4-compatible (deprecated)
      '::7f00:1',
      '::ffff:a9fe:a9fe', // 169.254.169.254
      '64:ff9b::7f00:1', // NAT64 well-known prefix
      '64:ff9b::127.0.0.1',
      '64:ff9b:1::192.168.0.1', // NAT64 local-use prefix
      '2002:7f00:1::', // 6to4 of 127.0.0.1
      '2002:a00:1::1', // 6to4 of 10.0.0.1
      '2002:c0a8:101::', // 6to4 of 192.168.1.1
    ]) {
      expect(isBlockedAddress(ip), ip).toBe(true)
    }
  })

  it('passes public addresses, including public ones behind the transition prefixes', () => {
    for (const ip of [
      PUBLIC_V4,
      '8.8.8.8',
      '172.32.0.1',
      '100.128.0.1',
      '192.0.1.1',
      '2606:4700::1111',
      '::ffff:8.8.8.8',
      '::ffff:808:808',
      '64:ff9b::808:808',
      '2002:808:808::',
    ]) {
      expect(isBlockedAddress(ip), ip).toBe(false)
    }
  })

  it('treats garbage as blocked', () => {
    for (const ip of ['not-an-ip', '1.2.3', '1.2.3.4.5', '::ffff:999.1.1.1', 'fe80:::1', '']) {
      expect(isBlockedAddress(ip), ip).toBe(true)
    }
  })
})

describe('assertPublicUrl', () => {
  const lookup = vi.fn(async (host: string) => {
    if (host === 'public.example') return [PUBLIC_V4]
    if (host === 'evil.example') return [PUBLIC_V4, '127.0.0.1']
    if (host === 'lan.example') return ['192.168.1.20']
    if (host === 'v6.example') return ['fd00::1']
    if (host === 'mapped.example') return ['::ffff:10.0.0.1']
    throw new Error('ENOTFOUND')
  })

  it('allows http(s) to a host that only resolves publicly', async () => {
    await expect(assertPublicUrl('https://public.example/a.png', { lookup })).resolves.toBeInstanceOf(URL)
    await expect(assertPublicUrl(`http://${PUBLIC_V4}/a.png`, { lookup })).resolves.toBeInstanceOf(URL)
    await expect(assertPublicUrl('http://[2606:4700::1111]/a.png', { lookup })).resolves.toBeInstanceOf(URL)
  })

  it('refuses non-http schemes', async () => {
    for (const u of ['file:///etc/passwd', 'ftp://public.example/x', 'gopher://public.example', 'data:text/plain,hi']) {
      await expect(assertPublicUrl(u, { lookup }), u).rejects.toThrow(/http or https|invalid url/)
    }
  })

  it('refuses literal private addresses in every spelling, and the docker host names, before DNS', async () => {
    lookup.mockClear()
    for (const u of [
      'http://127.0.0.1:4000/v1/sessions',
      'http://[::1]:4000/',
      'http://10.0.0.1/',
      'http://169.254.169.254/latest/meta-data/',
      'http://0.0.0.0:4000/',
      'http://localhost:4000/',
      'http://foo.localhost/',
      'http://host.docker.internal:4000/',
      'http://HOST.DOCKER.INTERNAL/',
      'http://gateway.docker.internal/',
      'http://2130706433/', // decimal
      'http://0x7f.0.0.1/', // hex
      'http://0x7f000001/',
      'http://0177.0.0.1/', // octal
      'http://017700000001/',
      'http://127.1/', // short
      'http://127.0.0.1./', // trailing dot
      'http://localhost./',
      'http://host.docker.internal./',
      'http://[::ffff:127.0.0.1]/', // mapped
      'http://[::ffff:7f00:1]/',
      'http://[::127.0.0.1]/', // compatible
      'http://[64:ff9b::7f00:1]/', // NAT64
      'http://[2002:7f00:1::]/', // 6to4
      'http://[fe80::1]/',
      'http://[fd00::1]/',
      'http://user:pw@127.0.0.1/', // userinfo does not change the host
    ]) {
      await expect(assertPublicUrl(u, { lookup }), u).rejects.toThrow(/not allowed|private or local|invalid url|credentials/)
    }
    expect(lookup).not.toHaveBeenCalled()
  })

  it('refuses credentials in the url and zone ids, and takes the parsed host over @ and backslash tricks', async () => {
    await expect(assertPublicUrl('http://user:pw@public.example/', { lookup })).rejects.toThrow(/credentials/)
    await expect(assertPublicUrl('http://user@public.example/', { lookup })).rejects.toThrow(/credentials/)
    await expect(assertPublicUrl('http://[fe80::1%25en0]/', { lookup })).rejects.toThrow(/invalid url|not allowed|private/)
    // WHATWG parses these as host public.example with the rest in the path; we
    // use the parsed object, so what is checked is what is fetched.
    const a = await resolvePublicUrl('http://public.example\\@127.0.0.1/x', { lookup })
    expect(a.url.hostname).toBe('public.example')
    expect(a.addresses).toEqual([PUBLIC_V4])
  })

  it('refuses hosts that resolve (even partly) to private space, and unresolvable hosts', async () => {
    await expect(assertPublicUrl('http://evil.example/', { lookup })).rejects.toThrow(/127\.0\.0\.1/)
    await expect(assertPublicUrl('http://lan.example/', { lookup })).rejects.toThrow(/192\.168\.1\.20/)
    await expect(assertPublicUrl('http://v6.example/', { lookup })).rejects.toThrow(/fd00::1/)
    await expect(assertPublicUrl('http://mapped.example/', { lookup })).rejects.toThrow(/::ffff:10\.0\.0\.1/)
    await expect(assertPublicUrl('http://nope.example/', { lookup })).rejects.toThrow(/did not resolve/)
  })

  it('refuses extra blocked hosts from the policy', async () => {
    await expect(assertPublicUrl('http://public.example/', { lookup, blockedHosts: ['public.example'] })).rejects.toThrow(
      /not allowed/,
    )
  })
})

describe('fetchPublic', () => {
  const lookup = async (host: string) => {
    if (host === 'public.example') return [PUBLIC_V4]
    if (host === 'cdn.example') return [PUBLIC_V4_B]
    return []
  }

  it('pins the connection to the address that was validated', async () => {
    const transport = vi.fn(async () => new Response('ok'))
    await fetchPublic('https://public.example/x', { lookup, transport })
    expect(transport).toHaveBeenCalledTimes(1)
    const [url, address, signal] = transport.mock.calls[0] as unknown as [URL, string, AbortSignal]
    expect(url.hostname).toBe('public.example')
    expect(address).toBe(PUBLIC_V4)
    expect(signal).toBeInstanceOf(AbortSignal)
  })

  it('re-validates and re-pins every redirect hop', async () => {
    const transport = vi.fn(async (u: URL) => {
      if (u.hostname === 'public.example') {
        return new Response(null, { status: 302, headers: { location: 'http://127.0.0.1:4000/v1/sessions' } })
      }
      return new Response('leaked')
    })
    await expect(fetchPublic('https://public.example/r', { lookup, transport })).rejects.toThrow(/private or local/)
    expect(transport).toHaveBeenCalledTimes(1)

    const hop = vi.fn(async (u: URL) =>
      u.hostname === 'public.example'
        ? new Response(null, { status: 301, headers: { location: 'https://cdn.example/final' } })
        : new Response('final'),
    )
    const r = await fetchPublic('https://public.example/r', { lookup, transport: hop })
    expect(await r.text()).toBe('final')
    expect(hop.mock.calls.map((c) => [(c[0] as URL).hostname, c[1]])).toEqual([
      ['public.example', PUBLIC_V4],
      ['cdn.example', PUBLIC_V4_B],
    ])
  })

  it('follows public redirects up to the cap', async () => {
    let n = 0
    const transport = vi.fn(async () => {
      n++
      return new Response(null, { status: 301, headers: { location: `https://public.example/${n}` } })
    })
    await expect(fetchPublic('https://public.example/0', { lookup, transport, maxRedirects: 2 })).rejects.toThrow(
      /too many redirects/,
    )
    expect(transport).toHaveBeenCalledTimes(3)
  })
})

describe('pinnedRequest', () => {
  let app: FastifyInstance
  let port: number
  beforeAll(async () => {
    app = Fastify()
    app.get('/', async (req) => ({ host: req.headers.host }))
    app.get('/gone', async (_req, reply) => reply.code(301).header('location', '/elsewhere').send())
    app.get('/empty', async (_req, reply) => reply.code(204).send())
    await app.listen({ port: 0, host: '127.0.0.1' })
    port = (app.server.address() as { port: number }).port
  })
  afterAll(async () => {
    await app.close()
  })

  it('connects to the pinned address and keeps the Host header from the url', async () => {
    // rebind.example does not resolve anywhere; only the pin can make this work.
    const res = await pinnedRequest(new URL(`http://rebind.example:${port}/`), '127.0.0.1', AbortSignal.timeout(5000))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ host: `rebind.example:${port}` })
  })

  it('does not follow redirects itself and handles bodyless statuses', async () => {
    const r = await pinnedRequest(new URL(`http://rebind.example:${port}/gone`), '127.0.0.1', AbortSignal.timeout(5000))
    expect(r.status).toBe(301)
    expect(r.headers.get('location')).toBe('/elsewhere')
    const e = await pinnedRequest(new URL(`http://rebind.example:${port}/empty`), '127.0.0.1', AbortSignal.timeout(5000))
    expect(e.status).toBe(204)
    expect(e.body).toBeNull()
  })

  it('fails when the pinned address is not listening', async () => {
    await expect(
      pinnedRequest(new URL(`http://rebind.example:1/`), '127.0.0.1', AbortSignal.timeout(5000)),
    ).rejects.toThrow()
  })
})

describe('readCapped', () => {
  it('rejects by content-length and by streamed size', async () => {
    const declared = new Response('x', { headers: { 'content-length': '999' } })
    await expect(readCapped(declared, 10)).rejects.toThrow(/too large/)
    const streamed = new Response(Buffer.alloc(20))
    await expect(readCapped(streamed, 10)).rejects.toThrow(/too large/)
    const fine = new Response(Buffer.from('hello'))
    expect((await readCapped(fine, 10)).toString()).toBe('hello')
  })
})

describe('MediaService.resolveOutgoing', () => {
  const logger = { info() {}, warn() {}, error() {} } as never
  const dir = mkdtempSync(join(tmpdir(), 'pigeon-media-'))

  it('never opens a connection to a local or private url', async () => {
    const transport = vi.fn(async () => new Response('leaked'))
    const svc = new MediaService(dir, 1, logger, transport)
    for (const url of [
      'http://127.0.0.1:4000/v1/sessions',
      'http://host.docker.internal:4000/v1/sessions',
      'http://[::1]/',
      'http://[::ffff:127.0.0.1]/',
      'http://10.1.2.3/',
      'http://0x7f.1/',
      'http://169.254.169.254/latest/meta-data/',
      'file:///etc/passwd',
    ]) {
      await expect(svc.resolveOutgoing({ url }), url).rejects.toThrow()
    }
    expect(transport).not.toHaveBeenCalled()
  })

  it('fetches a public url over the pinned transport with a byte cap', async () => {
    const transport = vi.fn(async () => new Response(Buffer.from('IMG')))
    const svc = new MediaService(dir, 1, logger, transport)
    expect((await svc.resolveOutgoing({ url: `http://${PUBLIC_V4}/a.png` })).toString()).toBe('IMG')
    expect(transport.mock.calls[0][1]).toBe(PUBLIC_V4)
    const huge = vi.fn(async () => new Response('x', { headers: { 'content-length': String(65 * 1024 * 1024) } }))
    await expect(new MediaService(dir, 1, logger, huge).resolveOutgoing({ url: `http://${PUBLIC_V4}/a.png` })).rejects.toThrow(
      /too large/,
    )
  })

  it('still takes inline base64 data', async () => {
    const svc = new MediaService(dir, 1, logger, vi.fn() as never)
    expect((await svc.resolveOutgoing({ data: Buffer.from('hi').toString('base64') })).toString()).toBe('hi')
  })
})
