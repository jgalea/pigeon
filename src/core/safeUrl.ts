import { lookup as dnsLookup } from 'node:dns/promises'
import { isIP } from 'node:net'

// The gateway fetches caller-supplied URLs (outgoing media, webhooks). Inside
// Docker it can reach the host's loopback through host.docker.internal and
// anything on the LAN, so every URL is resolved and checked against the
// private, loopback, link-local and multicast ranges before a connection is
// opened, and again on every redirect hop.

export type Lookup = (host: string) => Promise<string[]>

export interface UrlPolicy {
  lookup?: Lookup
  // Hostnames refused outright, before DNS. Case-insensitive.
  blockedHosts?: string[]
}

const BLOCKED_HOSTS = new Set([
  'localhost',
  'host.docker.internal',
  'gateway.docker.internal',
  'host.containers.internal',
  'metadata.google.internal',
])

const defaultLookup: Lookup = async (host) => (await dnsLookup(host, { all: true })).map((a) => a.address)

function ipv4ToInt(ip: string): number {
  const [a, b, c, d] = ip.split('.').map(Number)
  return ((a << 24) >>> 0) + (b << 16) + (c << 8) + d
}

function inV4Range(ip: string, base: string, bits: number): boolean {
  const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0
  return ((ipv4ToInt(ip) & mask) >>> 0) === ((ipv4ToInt(base) & mask) >>> 0)
}

// 0.0.0.0/8 (this host), 10/8, 100.64/10 (CGNAT), 127/8, 169.254/16
// (link-local, cloud metadata), 172.16/12, 192.168/16, 224/4 (multicast),
// 240/4 (reserved and broadcast).
const V4_BLOCKED: Array<[string, number]> = [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.168.0.0', 16],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
]

function expandV6(ip: string): number[] {
  const [head, tail = ''] = ip.split('::')
  const parse = (s: string) => (s ? s.split(':').map((h) => parseInt(h, 16)) : [])
  const h = parse(head)
  const t = parse(tail)
  const fill = new Array(Math.max(0, 8 - h.length - t.length)).fill(0)
  return ip.includes('::') ? [...h, ...fill, ...t] : h
}

export function isBlockedAddress(address: string): boolean {
  let ip = address.toLowerCase().replace(/^\[|\]$/g, '').split('%')[0]
  // IPv4-mapped (::ffff:a.b.c.d) and NAT64 (64:ff9b::a.b.c.d) carry a v4 address.
  const mapped = ip.match(/^(?:::ffff:|64:ff9b::)(\d+\.\d+\.\d+\.\d+)$/)
  if (mapped) ip = mapped[1]
  const kind = isIP(ip)
  if (kind === 4) return V4_BLOCKED.some(([base, bits]) => inV4Range(ip, base, bits))
  if (kind !== 6) return true
  const words = expandV6(ip)
  if (words.length !== 8) return true
  if (words.every((w) => w === 0)) return true // ::
  if (words.slice(0, 7).every((w) => w === 0) && words[7] === 1) return true // ::1
  const first = words[0]
  if ((first & 0xfe00) === 0xfc00) return true // fc00::/7 ULA
  if ((first & 0xffc0) === 0xfe80) return true // fe80::/10 link-local
  if ((first & 0xff00) === 0xff00) return true // ff00::/8 multicast
  if (first === 0 && words[1] === 0 && words[2] === 0 && words[3] === 0 && words[4] === 0 && words[5] === 0xffff) {
    // ::ffff:0:0/96 written in hex form
    return isBlockedAddress(`${words[6] >> 8}.${words[6] & 0xff}.${words[7] >> 8}.${words[7] & 0xff}`)
  }
  return false
}

let hostGatewayAddresses: Promise<string[]> | undefined

// Whatever host.docker.internal resolves to from where we run (the host's LAN
// address, which is not in a private range on some setups) is also refused.
function gatewayAddresses(lookup: Lookup): Promise<string[]> {
  if (lookup !== defaultLookup) return Promise.resolve([])
  hostGatewayAddresses ??= lookup('host.docker.internal').catch(() => [])
  return hostGatewayAddresses
}

export async function assertPublicUrl(input: string, policy: UrlPolicy = {}): Promise<URL> {
  let url: URL
  try {
    url = new URL(input)
  } catch {
    throw new Error(`invalid url: ${input}`)
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`url must be http or https, got ${url.protocol.replace(/:$/, '')}`)
  }
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
      addresses = await lookup(host)
    } catch {
      throw new Error(`url host ${host} did not resolve`)
    }
    if (addresses.length === 0) throw new Error(`url host ${host} did not resolve`)
  }
  const gateway = await gatewayAddresses(lookup)
  for (const a of addresses) {
    if (isBlockedAddress(a) || gateway.includes(a)) {
      throw new Error(`url host ${host} resolves to ${a}, which is a private or local address`)
    }
  }
  return url
}

export interface FetchPublicOptions extends UrlPolicy {
  maxBytes?: number
  timeoutMs?: number
  maxRedirects?: number
  fetchImpl?: typeof fetch
}

// Fetch a validated public URL. Redirects are followed by hand so each hop is
// validated too; the body is read with a hard byte cap.
export async function fetchPublic(input: string, opts: FetchPublicOptions = {}): Promise<Response> {
  const maxRedirects = opts.maxRedirects ?? 3
  const fetchImpl = opts.fetchImpl ?? fetch
  const signal = AbortSignal.timeout(opts.timeoutMs ?? 30_000)
  let url = await assertPublicUrl(input, opts)
  for (let hop = 0; ; hop++) {
    const res = await fetchImpl(url, { redirect: 'manual', signal })
    if (res.status >= 300 && res.status < 400 && res.headers.get('location')) {
      if (hop >= maxRedirects) throw new Error(`too many redirects fetching ${input}`)
      url = await assertPublicUrl(new URL(res.headers.get('location')!, url).toString(), opts)
      continue
    }
    return res
  }
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
      await reader.cancel()
      throw new Error(`response too large: over ${maxBytes} bytes`)
    }
    chunks.push(value)
  }
  return Buffer.concat(chunks)
}
