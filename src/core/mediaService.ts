import { mkdirSync, writeFileSync, readdirSync, statSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { downloadMediaMessage } from '@whiskeysockets/baileys'
import type { Logger } from '../logger.js'
import type { OutgoingMedia } from './types.js'

export class MediaService {
  constructor(
    private mediaDir: string,
    private lifetimeDays: number,
    private logger: Logger,
  ) {
    mkdirSync(mediaDir, { recursive: true })
  }

  async resolveOutgoing(m: OutgoingMedia): Promise<Buffer> {
    if (m.data) return Buffer.from(m.data, 'base64')
    if (m.url) {
      const r = await fetch(m.url)
      if (!r.ok) throw new Error(`failed to fetch media url: ${r.status}`)
      return Buffer.from(await r.arrayBuffer())
    }
    throw new Error('media requires data or url')
  }

  async saveIncoming(msg: unknown): Promise<string | undefined> {
    try {
      const buf = await downloadMediaMessage(
        msg as never,
        'buffer',
        {},
        { logger: this.logger as never, reuploadRequest: (async () => msg) as never },
      )
      const path = join(this.mediaDir, `${randomUUID()}.bin`)
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
