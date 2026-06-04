import { EventEmitter } from 'node:events'
import makeWASocket, {
  DisconnectReason,
  fetchLatestBaileysVersion,
  type WASocket,
} from '@whiskeysockets/baileys'
import type { Boom } from '@hapi/boom'
import type { DB } from '../db/database.js'
import { useSqliteAuthState } from '../db/authStore.js'
import type { HistoryStore } from '../db/historyStore.js'
import type { Logger } from '../logger.js'
import type { SessionStatus, NormalizedMessage } from './types.js'

export type AuthFactory = (auth: unknown, logger: Logger) => Promise<WASocket>

export async function realMakeSocket(auth: unknown, logger: Logger): Promise<WASocket> {
  const { version } = await fetchLatestBaileysVersion()
  return makeWASocket({
    version,
    auth: auth as never,
    logger: logger as never,
    browser: ['pigeon', 'Chrome', '1.0'],
  })
}

interface Entry {
  sock?: WASocket
  status: SessionStatus
  qr?: string
  saveCreds?: () => Promise<void>
}

export class SessionManager extends EventEmitter {
  private entries = new Map<string, Entry>()

  constructor(
    private db: DB,
    private history: HistoryStore,
    private logger: Logger,
    private factory: AuthFactory = realMakeSocket,
  ) {
    super()
    db.prepare('INSERT OR IGNORE INTO sessions(name,created_at) VALUES(?,?)').run('default', Date.now())
  }

  private setStatus(name: string, status: SessionStatus) {
    const e = this.entries.get(name)
    if (e) e.status = status
    this.db.prepare('UPDATE sessions SET status=? WHERE name=?').run(status, name)
    this.emit('status', { name, status })
  }

  status(name: string): SessionStatus {
    return this.entries.get(name)?.status ?? 'STOPPED'
  }
  getQr(name: string): string | undefined {
    return this.entries.get(name)?.qr
  }
  socket(name: string): WASocket | undefined {
    return this.entries.get(name)?.sock
  }
  list(): { name: string; status: SessionStatus }[] {
    return [...this.entries].map(([name, e]) => ({ name, status: e.status }))
  }

  async start(name: string): Promise<void> {
    if (this.entries.get(name)?.status === 'WORKING') return
    this.db.prepare('INSERT OR IGNORE INTO sessions(name,created_at) VALUES(?,?)').run(name, Date.now())
    const entry: Entry = this.entries.get(name) ?? { status: 'STARTING' }
    this.entries.set(name, entry)
    this.setStatus(name, 'STARTING')

    const { state, saveCreds } = await useSqliteAuthState(this.db, name)
    entry.saveCreds = saveCreds
    const sock = await this.factory(state, this.logger)
    entry.sock = sock

    sock.ev.on('creds.update', saveCreds)

    sock.ev.on('connection.update', (u: { connection?: string; qr?: string; lastDisconnect?: { error?: unknown } }) => {
      if (u.qr) {
        entry.qr = u.qr
        this.setStatus(name, 'SCAN_QR_CODE')
      }
      if (u.connection === 'open') {
        entry.qr = undefined
        this.setStatus(name, 'WORKING')
      }
      if (u.connection === 'close') {
        const code = (u.lastDisconnect?.error as Boom)?.output?.statusCode
        if (code === DisconnectReason.loggedOut) {
          this.setStatus(name, 'FAILED')
        } else {
          this.setStatus(name, 'STARTING')
          setTimeout(() => {
            this.start(name).catch((e) => this.logger.error({ e, name }, 'reconnect failed'))
          }, 2000)
        }
      }
    })

    sock.ev.on('messages.upsert', (up: { messages: unknown[] }) => {
      for (const msg of up.messages) {
        const n = this.normalize(name, msg as Record<string, never>)
        if (!n) continue
        this.history.save(n)
        this.emit('message', n)
        this.emit('event', { session: name, event: 'message', payload: msg, timestamp: Date.now() })
      }
    })
  }

  private normalize(session: string, msg: Record<string, never>): NormalizedMessage | undefined {
    const key = (msg as { key?: { remoteJid?: string; id?: string; fromMe?: boolean } }).key
    const jid = key?.remoteJid
    if (!jid || !key?.id) return undefined
    const content = (msg as { message?: Record<string, unknown> }).message ?? {}
    const type = Object.keys(content)[0] ?? 'unknown'
    const body =
      (content.conversation as string) ??
      ((content.extendedTextMessage as { text?: string })?.text)
    const caption =
      (content.imageMessage as { caption?: string })?.caption ??
      (content.videoMessage as { caption?: string })?.caption ??
      (content.documentMessage as { caption?: string })?.caption
    const ts = (msg as { messageTimestamp?: number | { toNumber?: () => number } }).messageTimestamp
    const timestamp =
      typeof ts === 'number' ? ts : (ts?.toNumber?.() ?? Math.floor(Date.now() / 1000))
    return {
      session,
      chatId: jid,
      msgId: key.id,
      fromMe: !!key.fromMe,
      timestamp,
      type,
      body,
      caption,
      raw: msg,
    }
  }

  async stop(name: string): Promise<void> {
    const e = this.entries.get(name)
    try {
      e?.sock?.end?.(undefined as never)
    } catch {
      /* ignore */
    }
    this.setStatus(name, 'STOPPED')
  }

  async restart(name: string): Promise<void> {
    await this.stop(name)
    await this.start(name)
  }

  async logout(name: string): Promise<void> {
    const e = this.entries.get(name)
    try {
      await e?.sock?.logout?.()
    } catch {
      /* ignore */
    }
    this.db.prepare('DELETE FROM auth_state WHERE session=?').run(name)
    this.setStatus(name, 'STOPPED')
  }
}
