import { EventEmitter } from 'node:events'
import makeWASocket, {
  Browsers,
  DisconnectReason,
  fetchLatestBaileysVersion,
  type WASocket,
} from '@whiskeysockets/baileys'
import type { Boom } from '@hapi/boom'
import type { DB } from '../db/database.js'
import { useSqliteAuthState } from '../db/authStore.js'
import { normalizeJid } from './jid.js'
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
    // WhatsApp validates the browser fingerprint at pairing; Business app
    // accounts reject unrecognized names like the old ['pigeon', ...] triple.
    browser: Browsers.macOS('Google Chrome'),
  })
}

interface Entry {
  sock?: WASocket
  status: SessionStatus
  qr?: string
  saveCreds?: () => Promise<void>
  connectedAt?: number
}

// Reduce a shared-contact vCard to a readable "Name — +phone" summary. The full
// vCard is always kept in raw; this just surfaces the name and number(s) in body
// so contact cards aren't blank in read_messages.
function vcardSummary(vcard: string): string {
  let name = ''
  const phones: string[] = []
  for (const line of vcard.split(/\r?\n/)) {
    if (line.startsWith('FN:')) {
      name = line.slice(3).trim()
    } else if (/^TEL/i.test(line)) {
      const colon = line.indexOf(':')
      const value = colon >= 0 ? line.slice(colon + 1).trim() : ''
      const waid = /waid=(\d+)/i.exec(line)?.[1]
      const num = value || (waid ? `+${waid}` : '')
      if (num) phones.push(num)
    }
  }
  return [name, ...phones].filter(Boolean).join(' — ')
}

function contactBody(content: Record<string, unknown>): string | undefined {
  const single = content.contactMessage as { displayName?: string; vcard?: string } | undefined
  if (single?.vcard) return vcardSummary(single.vcard) || single.displayName
  const arr = content.contactsArrayMessage as
    | { displayName?: string; contacts?: { displayName?: string; vcard?: string }[] }
    | undefined
  if (arr?.contacts?.length) {
    const parts = arr.contacts
      .map((c) => (c.vcard ? vcardSummary(c.vcard) : c.displayName))
      .filter(Boolean)
    if (parts.length) return parts.join('\n')
  }
  return undefined
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
    if (e) {
      e.status = status
      // Stamp the moment the link goes live so the send guard can pause cold
      // outreach for a cooldown right after (re)linking a device.
      if (status === 'WORKING') e.connectedAt = Date.now()
    }
    this.db.prepare('UPDATE sessions SET status=? WHERE name=?').run(status, name)
    this.emit('status', { name, status })
  }

  status(name: string): SessionStatus {
    return this.entries.get(name)?.status ?? 'STOPPED'
  }
  connectedAt(name: string): number | undefined {
    return this.entries.get(name)?.connectedAt
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

    // Backlog from WhatsApp: the sync pushed at pairing, plus on-demand batches
    // returned by fetchMessageHistory(). Persist quietly; no per-message webhooks.
    sock.ev.on('messaging-history.set', (h: { messages?: unknown[]; syncType?: unknown }) => {
      let saved = 0
      for (const msg of h.messages ?? []) {
        const n = this.normalize(name, msg as Record<string, never>)
        if (!n) continue
        this.history.save(n)
        saved++
      }
      if (saved) this.emit('event', { session: name, event: 'history.set', payload: { saved, syncType: h.syncType }, timestamp: Date.now() })
    })

    const relay = (event: string) => (payload: unknown) =>
      this.emit('event', { session: name, event, payload, timestamp: Date.now() })

    sock.ev.on('messages.update', relay('message.update'))
    sock.ev.on('messages.reaction', relay('message.reaction'))
    sock.ev.on('message-receipt.update', relay('message.ack'))
    sock.ev.on('presence.update', relay('presence.update'))
    sock.ev.on('group-participants.update', relay('group.participants'))
    sock.ev.on('groups.update', relay('group.update'))
  }

  private normalize(session: string, msg: Record<string, never>): NormalizedMessage | undefined {
    const key = (msg as {
      key?: { remoteJid?: string; remoteJidAlt?: string; id?: string; fromMe?: boolean }
    }).key
    const rawJid = key?.remoteJid
    if (!rawJid || !key?.id) return undefined
    // WhatsApp's lid addressing files a 1:1 chat under an @lid JID, while
    // remoteJidAlt carries the stable phone-number JID. Key the conversation by
    // the phone JID so inbound replies aren't split off under a separate @lid id
    // that lookups (which use the phone JID) never match.
    const jid =
      rawJid.endsWith('@lid') && key.remoteJidAlt?.endsWith('@s.whatsapp.net')
        ? key.remoteJidAlt
        : rawJid
    const content = (msg as { message?: Record<string, unknown> }).message ?? {}
    const type = Object.keys(content)[0] ?? 'unknown'
    const body =
      (content.conversation as string) ??
      ((content.extendedTextMessage as { text?: string })?.text) ??
      contactBody(content)
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

  // Request older messages for a chat from WhatsApp. Results arrive
  // asynchronously via the 'messaging-history.set' handler above and are
  // persisted there; this returns the request id, not the messages.
  async backfill(name: string, chatId: string, count = 50): Promise<{ requestId: string }> {
    const sock = this.entries.get(name)?.sock
    if (!sock) throw new Error('session not started')
    const anchor =
      this.history.oldest(name, normalizeJid(chatId)) ?? this.history.oldest(name, chatId)
    if (!anchor) {
      throw new Error('no stored message in this chat to page back from; send or receive one first')
    }
    const key = { remoteJid: anchor.chatId, id: anchor.msgId, fromMe: anchor.fromMe }
    const fetchHistory = (sock as { fetchMessageHistory?: (c: number, k: unknown, t: number) => Promise<string> })
      .fetchMessageHistory
    if (!fetchHistory) throw new Error('fetchMessageHistory not supported by this engine')
    const requestId = await fetchHistory(count, key, anchor.timestamp)
    return { requestId }
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
