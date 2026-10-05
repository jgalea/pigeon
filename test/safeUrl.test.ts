import { describe, it, expect, vi } from 'vitest'
import { assertPublicUrl, fetchPublic, isBlockedAddress, readCapped } from '../src/core/safeUrl.js'
import { MediaService } from '../src/core/mediaService.js'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const PUBLIC_V4 = '93.184.216.34'

describe('isBlockedAddress', () => {
  it('blocks loopback, private, link-local, CGNAT, multicast, unspecified and reserved v4', () => {
    for (const ip of [
      '127.0.0.1',
      '127.255.255.254',
      '10.0.0.1',
      '172.16.0.1',
      '172.31.255.255',
      '192.168.1.1',
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

  it('blocks ::1, ::, ULA, link-local, multicast and mapped v4 for v6', () => {
    for (const ip of [
      '::1',
      '::',
      'fc00::1',
      'fd12:3456::1',
      'fe80::1',
      'ff02::1',
      '::ffff:127.0.0.1',
      '::ffff:10.0.0.5',
      '::ffff:7f00:1',
      '64:ff9b::192.168.0.1',
      '[::1]',
      'fe80::1%en0',
    ]) {
      expect(isBlockedAddress(ip), ip).toBe(true)
    }
  })

  it('passes public addresses', () => {
    for (const ip of [PUBLIC_V4, '8.8.8.8', '172.32.0.1', '100.128.0.1', '2606:4700::1111', '::ffff:8.8.8.8']) {
      expect(isBlockedAddress(ip), ip).toBe(false)
    }
  })

  it('treats garbage as blocked', () => {
    expect(isBlockedAddress('not-an-ip')).toBe(true)
  })
})

describe('assertPublicUrl', () => {
  const lookup = vi.fn(async (host: string) => {
    if (host === 'public.example') return [PUBLIC_V4]
    if (host === 'evil.example') return [PUBLIC_V4, '127.0.0.1']
    if (host === 'lan.example') return ['192.168.1.20']
    if (host === 'v6.example') return ['fd00::1']
    throw new Error('ENOTFOUND')
  })

  it('allows http(s) to a host that only resolves publicly', async () => {
    await expect(assertPublicUrl('https://public.example/a.png', { lookup })).resolves.toBeInstanceOf(URL)
    await expect(assertPublicUrl(`http://${PUBLIC_V4}/a.png`, { lookup })).resolves.toBeInstanceOf(URL)
  })

  it('refuses non-http schemes', async () => {
    for (const u of ['file:///etc/passwd', 'ftp://public.example/x', 'gopher://public.example', 'data:text/plain,hi']) {
      await expect(assertPublicUrl(u, { lookup }), u).rejects.toThrow(/http or https|invalid url/)
    }
  })

  it('refuses literal private addresses and the docker host names before DNS', async () => {
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
      'http://2130706433/',
      'http://0x7f.0.0.1/',
      'http://127.1/',
    ]) {
      await expect(assertPublicUrl(u, { lookup }), u).rejects.toThrow(/not allowed|private or local/)
    }
    expect(lookup).not.toHaveBeenCalled()
  })

  it('refuses hosts that resolve (even partly) to private space, and unresolvable hosts', async () => {
    await expect(assertPublicUrl('http://evil.example/', { lookup })).rejects.toThrow(/127\.0\.0\.1/)
    await expect(assertPublicUrl('http://lan.example/', { lookup })).rejects.toThrow(/192\.168\.1\.20/)
    await expect(assertPublicUrl('http://v6.example/', { lookup })).rejects.toThrow(/fd00::1/)
    await expect(assertPublicUrl('http://nope.example/', { lookup })).rejects.toThrow(/did not resolve/)
  })

  it('refuses extra blocked hosts from the policy', async () => {
    await expect(assertPublicUrl('http://public.example/', { lookup, blockedHosts: ['public.example'] })).rejects.toThrow(
      /not allowed/,
    )
  })
})

describe('fetchPublic', () => {
  const lookup = async (host: string) => (host === 'public.example' ? [PUBLIC_V4] : [])

  it('re-validates every redirect hop', async () => {
    const fetchImpl = vi.fn(async (u: URL | RequestInfo) => {
      if (String(u).startsWith('https://public.example/')) {
        return new Response(null, { status: 302, headers: { location: 'http://127.0.0.1:4000/v1/sessions' } })
      }
      return new Response('leaked')
    })
    await expect(fetchPublic('https://public.example/r', { lookup, fetchImpl })).rejects.toThrow(/private or local/)
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    expect(fetchImpl.mock.calls[0][1]).toMatchObject({ redirect: 'manual' })
  })

  it('follows public redirects up to the cap', async () => {
    let n = 0
    const fetchImpl = vi.fn(async () => {
      n++
      return new Response(null, { status: 301, headers: { location: `https://public.example/${n}` } })
    })
    await expect(fetchPublic('https://public.example/0', { lookup, fetchImpl, maxRedirects: 2 })).rejects.toThrow(
      /too many redirects/,
    )
    expect(fetchImpl).toHaveBeenCalledTimes(3)
  })

  it('returns the final response', async () => {
    const fetchImpl = vi.fn(async () => new Response('ok'))
    const r = await fetchPublic('https://public.example/x', { lookup, fetchImpl })
    expect(await r.text()).toBe('ok')
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
    const fetchImpl = vi.fn(async () => new Response('leaked'))
    const svc = new MediaService(dir, 1, logger, fetchImpl)
    for (const url of [
      'http://127.0.0.1:4000/v1/sessions',
      'http://host.docker.internal:4000/v1/sessions',
      'http://[::1]/',
      'http://10.1.2.3/',
      'http://169.254.169.254/latest/meta-data/',
      'file:///etc/passwd',
    ]) {
      await expect(svc.resolveOutgoing({ url }), url).rejects.toThrow()
    }
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('fetches a public url with a byte cap', async () => {
    const fetchImpl = vi.fn(async () => new Response(Buffer.from('IMG')))
    const svc = new MediaService(dir, 1, logger, fetchImpl)
    expect((await svc.resolveOutgoing({ url: `http://${PUBLIC_V4}/a.png` })).toString()).toBe('IMG')
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
