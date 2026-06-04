import type { SessionManager } from './sessionManager.js'
import type { HistoryStore } from '../db/historyStore.js'
import type { MediaService } from './mediaService.js'
import type { OutgoingMessage, OutgoingContact, OutgoingPoll } from './types.js'
import { normalizeJid } from './jid.js'

function buildVcard(c: OutgoingContact): string {
  const waid = c.phone.replace(/[^0-9]/g, '')
  return [
    'BEGIN:VCARD',
    'VERSION:3.0',
    `FN:${c.fullName}`,
    c.organization ? `ORG:${c.organization};` : undefined,
    `TEL;type=CELL;type=VOICE;waid=${waid}:${c.phone}`,
    'END:VCARD',
  ]
    .filter(Boolean)
    .join('\n')
}

export class MessageService {
  private queues = new Map<string, Promise<unknown>>()

  constructor(
    private sessions: SessionManager,
    private history: HistoryStore,
    private media: MediaService,
  ) {}

  private requireSocket(session: string) {
    if (this.sessions.status(session) !== 'WORKING') throw new Error(`session ${session} not WORKING`)
    const sock = this.sessions.socket(session)
    if (!sock) throw new Error(`session ${session} has no socket`)
    return sock
  }

  private enqueue<T>(session: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.queues.get(session) ?? Promise.resolve()
    const next = prev
      .catch(() => {})
      .then(async () => {
        await new Promise((r) => setTimeout(r, 350 + Math.floor(Math.random() * 400)))
        return fn()
      })
    this.queues.set(session, next)
    return next
  }

  async send(session: string, msg: OutgoingMessage): Promise<{ id: string }> {
    const sock = this.requireSocket(session)
    return this.enqueue(session, async () => {
      const content = await this.buildContent(msg)
      const res = (await sock.sendMessage(normalizeJid(msg.chatId), content as never)) as
        | { key?: { id?: string } }
        | undefined
      return { id: res?.key?.id ?? '' }
    })
  }

  private async buildContent(msg: OutgoingMessage): Promise<Record<string, unknown>> {
    switch (msg.type) {
      case 'text':
        return { text: msg.text ?? '' }
      case 'image':
        return { image: await this.media.resolveOutgoing(msg.media!), caption: msg.caption }
      case 'video':
        return { video: await this.media.resolveOutgoing(msg.media!), caption: msg.caption }
      case 'file':
        return {
          document: await this.media.resolveOutgoing(msg.media!),
          mimetype: msg.media!.mimetype ?? 'application/octet-stream',
          fileName: msg.media!.filename ?? 'file',
          caption: msg.caption,
        }
      case 'voice':
        return {
          audio: await this.media.resolveOutgoing(msg.media!),
          mimetype: 'audio/ogg; codecs=opus',
          ptt: true,
        }
      case 'location':
        return {
          location: {
            degreesLatitude: msg.location!.latitude,
            degreesLongitude: msg.location!.longitude,
          },
        }
      case 'contact': {
        const c = msg.contact!
        return {
          contacts: { displayName: c.fullName, contacts: [{ vcard: buildVcard(c) }] },
        }
      }
      case 'poll': {
        const p: OutgoingPoll = msg.poll!
        return { poll: { name: p.name, values: p.options, selectableCount: p.selectableCount ?? 1 } }
      }
      default:
        throw new Error(`unsupported type ${(msg as { type: string }).type}`)
    }
  }

  private key(chatId: string, msgId: string, fromMe: boolean) {
    return { remoteJid: normalizeJid(chatId), id: msgId, fromMe }
  }

  async react(session: string, chatId: string, msgId: string, emoji: string, fromMe = false) {
    const sock = this.requireSocket(session)
    return this.enqueue(session, async () => {
      await sock.sendMessage(normalizeJid(chatId), { react: { text: emoji, key: this.key(chatId, msgId, fromMe) } } as never)
      return { success: true }
    })
  }

  async edit(session: string, chatId: string, msgId: string, text: string, fromMe = true) {
    const sock = this.requireSocket(session)
    return this.enqueue(session, async () => {
      await sock.sendMessage(normalizeJid(chatId), { text, edit: this.key(chatId, msgId, fromMe) } as never)
      return { success: true }
    })
  }

  async remove(session: string, chatId: string, msgId: string, fromMe = true) {
    const sock = this.requireSocket(session)
    return this.enqueue(session, async () => {
      await sock.sendMessage(normalizeJid(chatId), { delete: this.key(chatId, msgId, fromMe) } as never)
      return { success: true }
    })
  }

  async forward(session: string, toChatId: string, fromChatId: string, msgId: string) {
    const sock = this.requireSocket(session)
    const stored = this.history.get(session, normalizeJid(fromChatId), msgId) ?? this.history.get(session, fromChatId, msgId)
    if (!stored) throw new Error('message not found in history; cannot forward')
    return this.enqueue(session, async () => {
      const res = (await sock.sendMessage(normalizeJid(toChatId), { forward: stored.raw } as never)) as
        | { key?: { id?: string } }
        | undefined
      return { id: res?.key?.id ?? '' }
    })
  }

  async sendSeen(session: string, chatId: string): Promise<void> {
    const sock = this.requireSocket(session)
    await sock.readMessages?.([{ remoteJid: normalizeJid(chatId), id: '', participant: undefined } as never])
  }
}
