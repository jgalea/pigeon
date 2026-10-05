import { lookup as dnsLookup } from 'node:dns/promises'
import http from 'node:http'
import https from 'node:https'
import { isIP, isIPv6 } from 'node:net'
import { Readable } from 'node:stream'

// The gateway can fetch caller-supplied URLs (outgoing media, webhooks), but
// only when the operator opts in (PIGEON_ALLOW_URL_MEDIA, PIGEON_ALLOW_WEBHOOKS).
// Inside Docker it can reach the host's loopback through host.docker.internal
// and anything on the LAN, so when enabled every URL is resolved, every
// resolved address is checked against the private, loopback, link-local and
// multicast ranges, the connection is pinned to one of those checked
// addresses (so a second DNS answer can't swap in a private one), and
// redirects repeat the whole thing per hop. DNS, connect, idle and total
// wall-clock time are bounded, as are the address count, redirect count and
// body size, and a body that goes over the cap aborts the socket.

export const MAX_ADDRESSES = 16
export const DEFAULT_MAX_BYTES = 64 * 1024 * 1024
export const DEFAULT_TIMEOUT_MS = 30_000
export const DEFAULT_IDLE_TIMEOUT_MS = 10_000
export const DEFAULT_DNS_TIMEOUT_MS = 5_000
export const DEFAULT_MAX_REDIRECTS = 3

export type Lookup = (host: string) => Promise<string[]>

export interface RequestInitLite {
  method?: string
  headers?: Record<string, string>
  body?: string
}

export type Transport = (
  url: URL,
  address: string,
  signal: AbortSignal,
  idleTimeoutMs: number,
  init?: RequestInitLite,
) => Promise<Response>

export interface UrlPolicy {
  lookup?: Lookup
  // Hostnames refused outright, before DNS. Case-insensitive.
  blockedHosts?: string[]
  dnsTimeoutMs?: number
}

const BLOCKED_HOSTS = new Set([
  'localhost',
  'host.docker.internal',
  'gateway.docker.internal',
  'host.containers.internal',
  'metadata.google.internal',
])

const defaultLookup: Lookup = async (host) => (await dnsLookup(host, { all: true })).map((a) => a.address)

function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined
  const expiry = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} timed out after ${ms}ms`)), ms)
  })
  return Promise.race([p, expiry]).finally(() => clearTimeout(timer))
}

// Only canonical dotted-quad input reaches this: URL hostnames come out of
// the WHATWG parser normalised (decimal, octal, hex and short forms all
// become a.b.c.d) and DNS answers are canonical already.
function parseIPv4(ip: string): number[] | undefined {
  return isIP(ip) === 4 ? ip.split('.').map(Number) : undefined
}

// 16 bytes, or undefined when not an IPv6 literal. Brackets and zone ids are
// dropped first; a dotted-quad tail (::ffff:a.b.c.d) is folded into the last
// two groups so every form ends up as the same bytes.
function parseIPv6(ip: string): number[] | undefined {
  const bare = ip.replace(/^\[|\]$/g, '').split('%')[0]
  if (!isIPv6(bare)) return undefined
  let s = bare
  const dotted = s.match(/(\d+\.\d+\.\d+\.\d+)$/)
  if (dotted) {
    const [a, b, c, d] = dotted[1].split('.').map(Number)
    s = `${s.slice(0, -dotted[1].length)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`
  }
  const [head, tail] = s.split('::')
  const h = head ? head.split(':').map((x) => parseInt(x, 16)) : []
  const t = tail ? tail.split(':').map((x) => parseInt(x, 16)) : []
  const words = s.includes('::') ? [...h, ...new Array(8 - h.length - t.length).fill(0), ...t] : h
  if (words.length !== 8) return undefined
  return words.flatMap((w) => [w >> 8, w & 0xff])
}

// 0/8 (this host), 10/8, 100.64/10 (CGNAT), 127/8, 169.254/16 (link-local,
// cloud metadata), 172.16/12, 192.0.0/24, 192.168/16, 224/4 (multicast),
// 240/4 (reserved and broadcast).
function v4Blocked([a, b, c]: number[]): boolean {
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 0 && c === 0) ||
    (a === 192 && b === 168) ||
    a >= 224
  )
}

// The IPv4 address an IPv6 address stands for, if it is one of the transition
// forms: ::ffff:a.b.c.d (mapped), ::a.b.c.d (compatible), 64:ff9b::/96 and
// 64:ff9b:1::/48 (NAT64), 2002::/16 (6to4).
function embeddedV4(b: number[]): number[] | undefined {
  const zero = (from: number, to: number) => b.slice(from, to).every((x) => x === 0)
  if (zero(0, 10) && ((b[10] === 0xff && b[11] === 0xff) || zero(10, 12))) return b.slice(12)
  if (b[0] === 0 && b[1] === 0x64 && b[2] === 0xff && b[3] === 0x9b && (zero(4, 12) || (b[4] === 0 && b[5] === 1))) {
    return b.slice(12)
  }
  if (b[0] === 0x20 && b[1] === 0x02) return b.slice(2, 6)
  return undefined
}

function v6Blocked(b: number[]): boolean {
  if (b.every((x) => x === 0)) return true // ::
  if (b.slice(0, 15).every((x) => x === 0) && b[15] === 1) return true // ::1
  if ((b[0] & 0xfe) === 0xfc) return true // fc00::/7 ULA
  if (b[0] === 0xfe && (b[1] & 0xc0) === 0x80) return true // fe80::/10 link-local
  if (b[0] === 0xff) return true // ff00::/8 multicast
  if (b[0] === 0x20 && b[1] === 0x01 && b[2] === 0 && b[3] === 0) return true // 2001::/32 Teredo
  const v4 = embeddedV4(b)
  return v4 ? v4Blocked(v4) : false
}

export function isBlockedAddress(address: string): boolean {
  const v4 = parseIPv4(address)
  if (v4) return v4Blocked(v4)
  const v6 = parseIPv6(address)
  if (v6) return v6Blocked(v6)
  return true
}

let hostGatewayAddresses: Promise<string[]> | undefined

// Whatever host.docker.internal resolves to from where we run (the host's LAN
// address, which is not in a private range on some setups) is also refused.
function gatewayAddresses(lookup: Lookup): Promise<string[]> {
  if (lookup !== defaultLookup) return Promise.resolve([])
  hostGatewayAddresses ??= withTimeout(lookup('host.docker.internal'), DEFAULT_DNS_TIMEOUT_MS, 'dns').catch(() => [])
  return hostGatewayAddresses
}

export interface ResolvedUrl {
  url: URL
  // Every address the host resolved to; all of them passed the checks.
  addresses: string[]
}

// The WHATWG URL object is the single source of truth: its hostname is what
// gets checked here and what node:http gets handed, so percent-encoding,
// IDNA, odd IPv4 spellings and bracket handling are settled once by the
// parser before any check runs.
export async function resolvePublicUrl(input: string, policy: UrlPolicy = {}): Promise<ResolvedUrl> {
  let url: URL
  try {
    url = new URL(input)
  } catch {
    throw new Error(`invalid url: ${input}`)
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`url must be http or https, got ${url.protocol.replace(/:$/, '')}`)
  }
  if (url.username || url.password) throw new Error('url must not carry credentials')
  const host = url.hostname.toLowerCase().replace(/\.$/, '')
  const blockedHosts = new Set([...BLOCKED_HOSTS, ...(policy.blockedHosts ?? []).map((h) => h.toLowerCase())])
  if (!host || blockedHosts.has(host) || host.endsWith('.localhost')) {
    throw new Error(`url host ${host || '(empty)'} is not allowed`)
  }
  const lookup = policy.lookup ?? defaultLookup
  const literal = host.replace(/^\[|\]$/g, '')
  let addresses: string[]
  if (isIP(literal)) {
    addresses = [literal]
  } else {
    try {
      addresses = await withTimeout(lookup(host), policy.dnsTimeoutMs ?? DEFAULT_DNS_TIMEOUT_MS, `dns lookup of ${host}`)
    } catch (e) {
      if (/timed out/.test((e as Error).message)) throw e
      throw new Error(`url host ${host} did not resolve`)
    }
    if (addresses.length === 0) throw new Error(`url host ${host} did not resolve`)
    if (addresses.length > MAX_ADDRESSES) {
      throw new Error(`url host ${host} resolves to ${addresses.length} addresses (limit ${MAX_ADDRESSES})`)
    }
  }
  const gateway = await gatewayAddresses(lookup)
  for (const a of addresses) {
    if (isBlockedAddress(a) || gateway.includes(a)) {
      throw new Error(`url host ${host} resolves to ${a}, which is a private or local address`)
    }
  }
  return { url, addresses }
}

export async function assertPublicUrl(input: string, policy: UrlPolicy = {}): Promise<URL> {
  return (await resolvePublicUrl(input, policy)).url
}

// Open the url over a socket to `address`: node is handed the validated
// address as the hostname, so it never resolves anything itself (a `lookup`
// hook would not do, node skips it for IP-literal hostnames). The Host header
// and TLS servername come from the url, so virtual hosting and certificates
// work as normal. The socket is destroyed when it sits idle for idleTimeoutMs
// (covers connect and a stalled body) or when `signal` fires (the total
// wall-clock budget).
export const pinnedRequest: Transport = (url, address, signal, idleTimeoutMs, init = {}) =>
  new Promise((resolve, reject) => {
    const secure = url.protocol === 'https:'
    const bare = url.hostname.replace(/^\[|\]$/g, '')
    const options: https.RequestOptions = {
      hostname: address,
      port: url.port || (secure ? 443 : 80),
      path: `${url.pathname}${url.search}`,
      method: init.method ?? 'GET',
      headers: { ...init.headers, host: url.host },
      signal,
      timeout: idleTimeoutMs,
      ...(secure && !isIP(bare) ? { servername: bare } : {}),
    }
    const req = (secure ? https : http).request(
      options,
      (res) => {
        const headers = new Headers()
        for (const [k, v] of Object.entries(res.headers)) {
          if (v !== undefined) headers.set(k, Array.isArray(v) ? v.join(', ') : v)
        }
        const status = res.statusCode && res.statusCode >= 200 ? res.statusCode : 502
        const bodyless = status === 204 || status === 205 || status === 304
        if (bodyless) res.resume()
        resolve(new Response(bodyless ? null : (Readable.toWeb(res) as unknown as ReadableStream), { status, headers }))
      },
    )
    req.on('timeout', () => req.destroy(new Error(`connection to ${address} idle for ${idleTimeoutMs}ms`)))
    req.on('error', reject)
    req.end(init.body)
  })

export interface FetchPublicOptions extends UrlPolicy {
  maxBytes?: number
  timeoutMs?: number
  idleTimeoutMs?: number
  maxRedirects?: number
  transport?: Transport
}

interface Opened {
  res: Response
  abort: () => void
}

// Resolve, pin, request, and follow GET redirects by hand so each hop is
// resolved and pinned again. One total wall-clock budget covers every hop and
// the body read that follows.
async function openPublic(input: string, init: RequestInitLite, opts: FetchPublicOptions): Promise<Opened> {
  const controller = new AbortController()
  const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(opts.timeoutMs ?? DEFAULT_TIMEOUT_MS)])
  const idle = opts.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS
  const transport = opts.transport ?? pinnedRequest
  const maxRedirects = opts.maxRedirects ?? DEFAULT_MAX_REDIRECTS
  const abort = () => controller.abort()
  let { url, addresses } = await resolvePublicUrl(input, opts)
  for (let hop = 0; ; hop++) {
    const res = await transport(url, addresses[0], signal, idle, init)
    const location = res.headers.get('location')
    if (res.status >= 300 && res.status < 400 && location && (init.method ?? 'GET') === 'GET') {
      await res.body?.cancel().catch(() => {})
      if (hop >= maxRedirects) {
        abort()
        throw new Error(`too many redirects fetching ${input}`)
      }
      ;({ url, addresses } = await resolvePublicUrl(new URL(location, url).toString(), opts))
      continue
    }
    return { res, abort }
  }
}

export async function fetchPublic(input: string, opts: FetchPublicOptions = {}): Promise<Response> {
  return (await openPublic(input, {}, opts)).res
}

export interface PublicBytes {
  ok: boolean
  status: number
  headers: Headers
  bytes: Buffer
}

// GET a public url and read at most maxBytes; anything over tears the
// connection down instead of being buffered.
export async function fetchPublicBytes(input: string, opts: FetchPublicOptions = {}): Promise<PublicBytes> {
  const { res, abort } = await openPublic(input, {}, opts)
  try {
    const bytes = await readCapped(res, opts.maxBytes ?? DEFAULT_MAX_BYTES)
    return { ok: res.ok, status: res.status, headers: res.headers, bytes }
  } catch (e) {
    abort()
    throw e
  }
}

export const WEBHOOK_TIMEOUT_MS = 10_000
export const WEBHOOK_MAX_RESPONSE_BYTES = 64 * 1024

// POST to a public webhook url over a pinned connection. Redirects are not
// followed; the response body is drained under a small cap and discarded.
export async function postWebhook(
  url: string,
  init: RequestInitLite,
  opts: FetchPublicOptions = {},
): Promise<{ ok: boolean; status: number }> {
  const { res, abort } = await openPublic(
    url,
    { ...init, method: 'POST' },
    { timeoutMs: WEBHOOK_TIMEOUT_MS, ...opts, maxRedirects: 0 },
  )
  try {
    await readCapped(res, opts.maxBytes ?? WEBHOOK_MAX_RESPONSE_BYTES)
  } catch {
    abort()
  }
  return { ok: res.ok, status: res.status }
}

export async function readCapped(res: Response, maxBytes: number): Promise<Buffer> {
  const declared = Number(res.headers.get('content-length') ?? 0)
  if (declared > maxBytes) throw new Error(`response too large: ${declared} bytes (limit ${maxBytes})`)
  if (!res.body) return Buffer.alloc(0)
  const chunks: Uint8Array[] = []
  let total = 0
  const reader = res.body.getReader()
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.byteLength
    if (total > maxBytes) {
      await reader.cancel().catch(() => {})
      throw new Error(`response too large: over ${maxBytes} bytes`)
    }
    chunks.push(value)
  }
  return Buffer.concat(chunks)
}
