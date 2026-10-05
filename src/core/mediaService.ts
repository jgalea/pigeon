import { mkdirSync, writeFileSync, readdirSync, statSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { downloadMediaMessage } from '@whiskeysockets/baileys'
import type { Logger } from '../logger.js'
import type { OutgoingMedia } from './types.js'
import { fetchPublicBytes, type Transport } from './safeUrl.js'

// Same ceiling as the HTTP body limit, so a URL can't pull in more than a
// base64 upload could.
export const MAX_MEDIA_BYTES = 64 * 1024 * 1024
export const MEDIA_FETCH_TIMEOUT_MS = 30_000

export const URL_MEDIA_OFF =
  'fetching media from a url is off on this gateway: download the file first and send it by path or as base64 data, or set PIGEON_ALLOW_URL_MEDIA=1 to enable url fetching (this accepts residual SSRF risk)'

export interface MediaServiceOptions {
  // Server-side fetching of media urls (PIGEON_ALLOW_URL_MEDIA). Off by default.
  allowUrl?: boolean
  transport?: Transport
}

export class MediaService {
  constructor(
    private mediaDir: string,
    private lifetimeDays: number,
    private logger: Logger,
    private opts: MediaServiceOptions = {},
  ) {
    mkdirSync(mediaDir, { recursive: true })
  }

  // Media URLs come from API callers. They are only fetched when the operator
  // opted in, and then through the public-address check (no loopback, LAN,
  // link-local or Docker host), a pinned connection on every hop, and a
  // streamed byte cap.
  async resolveOutgoing(m: OutgoingMedia): Promise<Buffer> {
    if (m.data) return Buffer.from(m.data, 'base64')
    if (m.url) {
      if (!this.opts.allowUrl) throw new Error(URL_MEDIA_OFF)
      const r = await fetchPublicBytes(m.url, {
        transport: this.opts.transport,
        timeoutMs: MEDIA_FETCH_TIMEOUT_MS,
        maxBytes: MAX_MEDIA_BYTES,
      })
      if (!r.ok) throw new Error(`failed to fetch media url: ${r.status}`)
      return r.bytes
    }
    throw new Error('media requires data or url')
  }

  // WhatsApp deletes undownloaded media from its servers after a few weeks, and
  // then returns 410 Gone for a URL that still looks validly signed. Anything we
  // have not pulled by then is unrecoverable, so inbound media is fetched on
  // arrival rather than on demand.
  async saveIncoming(msg: unknown, reupload?: unknown): Promise<string | undefined> {
    try {
      const buf = await downloadMediaMessage(
        msg as never,
        'buffer',
        {},
        {
          logger: this.logger as never,
          reuploadRequest: (reupload ?? (async () => msg)) as never,
        },
      )
      const path = join(this.mediaDir, `${randomUUID()}${extensionFor(msg)}`)
      writeFileSync(path, buf as Buffer)
      return path
    } catch (e) {
      this.logger.warn({ e }, 'media download failed')
      return undefined
    }
  }

  cleanup(now = Date.now()) {
    const cutoff = now - this.lifetimeDays * 86400_000
    for (const f of readdirSync(this.mediaDir)) {
      const p = join(this.mediaDir, f)
      try {
        if (statSync(p).mtimeMs < cutoff) unlinkSync(p)
      } catch {
        /* ignore */
      }
    }
  }
}

// Media carriers Baileys can decrypt. Voice notes arrive as audioMessage with
// ptt set; ptvMessage is the round video note.
export const MEDIA_TYPES = new Set([
  'imageMessage',
  'videoMessage',
  'audioMessage',
  'documentMessage',
  'stickerMessage',
  'ptvMessage',
])

export function hasMedia(msg: unknown): boolean {
  const content = (msg as { message?: Record<string, unknown> })?.message ?? {}
  return Object.keys(content).some((k) => MEDIA_TYPES.has(k))
}

const EXT_BY_MIME: Record<string, string> = {
  'audio/ogg': '.ogg',
  'audio/mpeg': '.mp3',
  'audio/mp4': '.m4a',
  'audio/aac': '.aac',
  'audio/wav': '.wav',
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/webp': '.webp',
  'video/mp4': '.mp4',
  'video/quicktime': '.mov',
  'application/pdf': '.pdf',
}

// Name the file by its real type so ffmpeg and whisper can read it without
// being told what it is. A bare .bin makes every downstream tool guess.
function extensionFor(msg: unknown): string {
  const content = (msg as { message?: Record<string, unknown> })?.message ?? {}
  for (const k of Object.keys(content)) {
    if (!MEDIA_TYPES.has(k)) continue
    const m = content[k] as { mimetype?: string; fileName?: string } | undefined
    const name = m?.fileName
    if (name && name.includes('.')) return name.slice(name.lastIndexOf('.'))
    const mime = (m?.mimetype ?? '').split(';')[0].trim().toLowerCase()
    if (EXT_BY_MIME[mime]) return EXT_BY_MIME[mime]
  }
  return '.bin'
}
