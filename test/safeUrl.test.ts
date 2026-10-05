import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import {
  assertPublicUrl,
  fetchPublic,
  fetchPublicBytes,
  isBlockedAddress,
  pinnedRequest,
  postWebhook,
  readCapped,
  resolvePublicUrl,
  MAX_ADDRESSES,
  type Transport,
} from '../src/core/safeUrl.js'
import { MediaService, URL_MEDIA_OFF } from '../src/core/mediaService.js'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const PUBLIC_V4 = '93.184.216.34'
const PUBLIC_V4_B = '198.51.100.7'
// Whatever the WHATWG parser turns the IDNA host into is what DNS must be asked for.
const IDNA_HOST = new URL('http://lócalhost.example/').hostname

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
    if (host === 'many.example') return Array.from({ length: MAX_ADDRESSES + 1 }, (_, i) => `93.184.216.${i + 1}`)
    if (host === IDNA_HOST) return [PUBLIC_V4]
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
      'http://0:4000/',
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
      'http://%6cocalhost/', // percent-encoded hostname, decoded by the URL parser
      'http://%31%32%37.0.0.1/',
      'http://ｌｏｃａｌｈｏｓｔ/', // fullwidth, folded by IDNA
      'http://[::ffff:127.0.0.1]/', // mapped
      'http://[::ffff:7f00:1]/',
      'http://[0:0:0:0:0:ffff:127.0.0.1]/',
      'http://[::127.0.0.1]/', // compatible
      'http://[64:ff9b::7f00:1]/', // NAT64
      'http://[2002:7f00:1::]/', // 6to4
      'http://[fe80::1]/',
      'http://[fd00::1]/',
      'http://[127.0.0.1]/', // brackets around v4 are not a host
      'http://[fe80::1%25en0]/', // zone id
      'http://user:pw@127.0.0.1/', // userinfo does not change the host
    ]) {
      await expect(assertPublicUrl(u, { lookup }), u).rejects.toThrow(/not allowed|private or local|invalid url|credentials/)
    }
    expect(lookup).not.toHaveBeenCalled()
  })

  it('refuses credentials and takes the parsed host over @ and backslash tricks', async () => {
    await expect(assertPublicUrl('http://user:pw@public.example/', { lookup })).rejects.toThrow(/credentials/)
    await expect(assertPublicUrl('http://user@public.example/', { lookup })).rejects.toThrow(/credentials/)
    // WHATWG parses these as host public.example with the rest in the path; we
    // use the parsed object, so what is checked is what is connected to.
    const a = await resolvePublicUrl('http://public.example\\@127.0.0.1/x', { lookup })
    expect(a.url.hostname).toBe('public.example')
    expect(a.addresses).toEqual([PUBLIC_V4])
    // IDNA: the punycode form is what DNS is asked for.
    const i = await resolvePublicUrl('http://lócalhost.example/', { lookup })
    expect(i.url.hostname).toBe(IDNA_HOST)
    expect(IDNA_HOST).toMatch(/^xn--/)
  })

  it('refuses hosts that resolve (even partly) to private space, too many addresses, and unresolvable hosts', async () => {
    await expect(assertPublicUrl('http://evil.example/', { lookup })).rejects.toThrow(/127\.0\.0\.1/)
    await expect(assertPublicUrl('http://lan.example/', { lookup })).rejects.toThrow(/192\.168\.1\.20/)
    await expect(assertPublicUrl('http://v6.example/', { lookup })).rejects.toThrow(/fd00::1/)
    await expect(assertPublicUrl('http://mapped.example/', { lookup })).rejects.toThrow(/::ffff:10\.0\.0\.1/)
    await expect(assertPublicUrl('http://many.example/', { lookup })).rejects.toThrow(/17 addresses \(limit 16\)/)
    await expect(assertPublicUrl('http://nope.example/', { lookup })).rejects.toThrow(/did not resolve/)
  })

  it('gives up on a DNS lookup that never answers', { timeout: 2000 }, async () => {
    const hang = () => new Promise<string[]>(() => {})
    await expect(assertPublicUrl('http://slow.example/', { lookup: hang, dnsTimeoutMs: 50 })).rejects.toThrow(
      /dns lookup of slow.example timed out after 50ms/,
    )
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

  it('pins the connection to the address that was validated and passes the budgets', async () => {
    const transport = vi.fn(async () => new Response('ok'))
    await fetchPublic('https://public.example/x', { lookup, transport, idleTimeoutMs: 1234 })
    expect(transport).toHaveBeenCalledTimes(1)
    const [url, address, signal, idle] = transport.mock.calls[0] as unknown as [URL, string, AbortSignal, number]
    expect(url.hostname).toBe('public.example')
    expect(address).toBe(PUBLIC_V4)
    expect(signal).toBeInstanceOf(AbortSignal)
    expect(idle).toBe(1234)
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

  it('follows public redirects up to the cap, then aborts', async () => {
    let n = 0
    const transport = vi.fn(async () => {
      n++
      if (n > 10) throw new Error('runaway redirect loop')
      return new Response(null, { status: 301, headers: { location: `https://public.example/${n}` } })
    })
    await expect(
      fetchPublic('https://public.example/0', { lookup, transport, maxRedirects: 2, timeoutMs: 1000 }),
    ).rejects.toThrow(/too many redirects/)
    expect(transport).toHaveBeenCalledTimes(3)
    const signal = transport.mock.calls[0][2] as unknown as AbortSignal
    expect(signal.aborted).toBe(true)
  })
})

// A body that trickles one byte at a time until the request's signal fires.
function drip(signal: AbortSignal, everyMs: number, onCancel?: () => void): ReadableStream<Uint8Array> {
  return new ReadableStream({
    pull(controller) {
      return new Promise((resolve) => {
        setTimeout(() => {
          if (signal.aborted) controller.error(new Error('aborted'))
          else controller.enqueue(new Uint8Array(1))
          resolve()
        }, everyMs)
      })
    },
    cancel: onCancel,
  })
}

describe('fetchPublicBytes', () => {
  const lookup = async () => [PUBLIC_V4]

  it('returns the body under the cap', async () => {
    const transport = vi.fn(async () => new Response(Buffer.from('hello'), { status: 200 }))
    const r = await fetchPublicBytes('http://public.example/x', { lookup, transport, maxBytes: 10 })
    expect(r.ok).toBe(true)
    expect(r.bytes.toString()).toBe('hello')
  })

  it('aborts the request when a streamed body goes over the cap, without buffering it', async () => {
    let cancelled = false
    let sent = 0
    const transport: Transport = async (_u, _a, signal) =>
      new Response(
        new ReadableStream({
          // Finite on purpose: without the cap this resolves with 1 MB and the
          // rejection assertion below fails, instead of the worker running out of memory.
          pull(c) {
            if (signal.aborted) return c.error(new Error('aborted'))
            if (sent >= 1 << 20) return c.close()
            sent += 1024
            c.enqueue(new Uint8Array(1024))
          },
          cancel() {
            cancelled = true
          },
        }),
      )
    await expect(
      fetchPublicBytes('http://public.example/big', { lookup, transport, maxBytes: 4096, timeoutMs: 5000 }),
    ).rejects.toThrow(/too large/)
    expect(cancelled).toBe(true)
    expect(sent).toBeLessThanOrEqual(8192)
  })

  it('gives up on a slow-drip body when the total budget runs out', { timeout: 3000 }, async () => {
    let seen: AbortSignal | undefined
    const transport: Transport = async (_u, _a, signal) => {
      seen = signal
      return new Response(drip(signal, 20))
    }
    const started = Date.now()
    await expect(fetchPublicBytes('http://public.example/drip', { lookup, transport, timeoutMs: 200 })).rejects.toThrow()
    expect(Date.now() - started).toBeLessThan(1500)
    expect(seen?.aborted).toBe(true)
  })
})

describe('postWebhook', () => {
  const lookup = async () => [PUBLIC_V4]

  it('POSTs body and headers over the pinned transport and reports ok by status', async () => {
    const transport = vi.fn(async () => new Response('ignored', { status: 200 }))
    const r = await postWebhook('https://public.example/hook', { headers: { 'x-a': 'b' }, body: '{"e":1}' }, { lookup, transport })
    expect(r).toEqual({ ok: true, status: 200 })
    const [url, address, , , init] = transport.mock.calls[0] as unknown as [URL, string, AbortSignal, number, { method: string; headers: Record<string, string>; body: string }]
    expect(url.hostname).toBe('public.example')
    expect(address).toBe(PUBLIC_V4)
    expect(init).toEqual({ method: 'POST', headers: { 'x-a': 'b' }, body: '{"e":1}' })
  })

  it('does not follow redirects and refuses private targets', async () => {
    const transport = vi.fn(async () => new Response(null, { status: 302, headers: { location: 'http://127.0.0.1/' } }))
    const r = await postWebhook('https://public.example/hook', { body: '{}' }, { lookup, transport })
    expect(r).toEqual({ ok: false, status: 302 })
    expect(transport).toHaveBeenCalledTimes(1)
    await expect(postWebhook('http://127.0.0.1:4000/hook', { body: '{}' }, { lookup, transport })).rejects.toThrow(/private or local/)
    expect(transport).toHaveBeenCalledTimes(1)
  })
})

describe('pinnedRequest', () => {
  let app: FastifyInstance
  let port: number
  beforeAll(async () => {
    app = Fastify()
    app.get('/', async (req) => ({ host: req.headers.host }))
    app.post('/echo', async (req) => ({ body: req.body, ct: req.headers['content-type'] }))
    app.get('/gone', async (_req, reply) => reply.code(301).header('location', '/elsewhere').send())
    app.get('/empty', async (_req, reply) => reply.code(204).send())
    // Never answers: exercises the idle timeout.
    app.get('/hang', async (_req, reply) => {
      reply.hijack()
    })
    // Headers at once, then one byte a second: exercises the total budget mid-body.
    app.get('/drip', async (req, reply) => {
      reply.hijack()
      reply.raw.writeHead(200, { 'content-type': 'application/octet-stream' })
      const t = setInterval(() => reply.raw.write('x'), 50)
      req.raw.on('close', () => clearInterval(t))
    })
    await app.listen({ port: 0, host: '127.0.0.1' })
    port = (app.server.address() as { port: number }).port
  })
  afterAll(async () => {
    await app.close()
  })

  it('connects to the pinned address and keeps the Host header from the url', async () => {
    // rebind.example does not resolve anywhere; only the pin can make this work.
    const res = await pinnedRequest(new URL(`http://rebind.example:${port}/`), '127.0.0.1', AbortSignal.timeout(5000), 5000)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ host: `rebind.example:${port}` })
    // An IPv6 literal in the url is only a Host header; the socket still goes to the pin.
    const v6 = await pinnedRequest(new URL(`http://[2606:4700::1111]:${port}/`), '127.0.0.1', AbortSignal.timeout(5000), 5000)
    expect(await v6.json()).toEqual({ host: `[2606:4700::1111]:${port}` })
  })

  it('sends method, headers and body', async () => {
    const res = await pinnedRequest(new URL(`http://rebind.example:${port}/echo`), '127.0.0.1', AbortSignal.timeout(5000), 5000, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{"a":1}',
    })
    expect(await res.json()).toEqual({ body: { a: 1 }, ct: 'application/json' })
  })

  it('does not follow redirects itself and handles bodyless statuses', async () => {
    const r = await pinnedRequest(new URL(`http://rebind.example:${port}/gone`), '127.0.0.1', AbortSignal.timeout(5000), 5000)
    expect(r.status).toBe(301)
    expect(r.headers.get('location')).toBe('/elsewhere')
    const e = await pinnedRequest(new URL(`http://rebind.example:${port}/empty`), '127.0.0.1', AbortSignal.timeout(5000), 5000)
    expect(e.status).toBe(204)
    expect(e.body).toBeNull()
  })

  it('drops a connection that stays idle', { timeout: 3000 }, async () => {
    await expect(
      pinnedRequest(new URL(`http://rebind.example:${port}/hang`), '127.0.0.1', AbortSignal.timeout(10_000), 150),
    ).rejects.toThrow(/idle for 150ms/)
  })

  it('drops a connection when the total budget fires, even mid-body', { timeout: 3000 }, async () => {
    const lookup = async () => [PUBLIC_V4]
    // Route the "public" host to the local drip server to exercise real sockets.
    const transport: Transport = (url, _address, signal, idle, init) =>
      pinnedRequest(new URL(`http://rebind.example:${port}${url.pathname}`), '127.0.0.1', signal, idle, init)
    const started = Date.now()
    await expect(fetchPublicBytes('http://public.example/drip', { lookup, transport, timeoutMs: 300 })).rejects.toThrow()
    expect(Date.now() - started).toBeLessThan(2000)
    await expect(
      pinnedRequest(new URL(`http://rebind.example:${port}/hang`), '127.0.0.1', AbortSignal.timeout(100), 10_000),
    ).rejects.toThrow()
  })

  it('fails when the pinned address is not listening', async () => {
    await expect(
      pinnedRequest(new URL(`http://rebind.example:1/`), '127.0.0.1', AbortSignal.timeout(5000), 5000),
    ).rejects.toThrow()
  })
})

describe('readCapped', () => {
  it('rejects by content-length before reading, and by streamed size', async () => {
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

  it('refuses urls entirely unless url fetching is opted in', async () => {
    const transport = vi.fn(async () => new Response('leaked'))
    const svc = new MediaService(dir, 1, logger, { transport })
    await expect(svc.resolveOutgoing({ url: `http://${PUBLIC_V4}/a.png` })).rejects.toThrow(URL_MEDIA_OFF)
    await expect(svc.resolveOutgoing({ url: 'http://127.0.0.1:4000/' })).rejects.toThrow(/PIGEON_ALLOW_URL_MEDIA=1/)
    expect(transport).not.toHaveBeenCalled()
    expect((await svc.resolveOutgoing({ data: Buffer.from('hi').toString('base64') })).toString()).toBe('hi')
  })

  it('never opens a connection to a local or private url even when opted in', async () => {
    const transport = vi.fn(async () => new Response('leaked'))
    const svc = new MediaService(dir, 1, logger, { allowUrl: true, transport })
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
    const svc = new MediaService(dir, 1, logger, { allowUrl: true, transport })
    expect((await svc.resolveOutgoing({ url: `http://${PUBLIC_V4}/a.png` })).toString()).toBe('IMG')
    expect(transport.mock.calls[0][1]).toBe(PUBLIC_V4)
    const huge = vi.fn(async () => new Response('x', { headers: { 'content-length': String(65 * 1024 * 1024) } }))
    await expect(
      new MediaService(dir, 1, logger, { allowUrl: true, transport: huge }).resolveOutgoing({ url: `http://${PUBLIC_V4}/a.png` }),
    ).rejects.toThrow(/too large/)
    const notFound = vi.fn(async () => new Response('nope', { status: 404 }))
    await expect(
      new MediaService(dir, 1, logger, { allowUrl: true, transport: notFound }).resolveOutgoing({ url: `http://${PUBLIC_V4}/a.png` }),
    ).rejects.toThrow(/404/)
  })
})
