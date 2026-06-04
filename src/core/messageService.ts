import type { SessionManager } from './sessionManager.js'
import type { HistoryStore } from '../db/historyStore.js'
import type { MediaService } from './mediaService.js'
import type { OutgoingMessage } from './types.js'

export class MessageService {
  private queues = new Map<string, Promise<unknown>>()

  constructor(
    private sessions: SessionManager,
    private history: HistoryStore,
    private media: MediaService,
  ) {}

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
    if (this.sessions.status(session) !== 'WORKING') throw new Error(`session ${session} not WORKING`)
    const sock = this.sessions.socket(session)
    if (!sock) throw new Error(`session ${session} has no socket`)
    return this.enqueue(session, async () => {
      const content = await this.buildContent(msg)
      const res = (await sock.sendMessage(msg.chatId, content as never)) as
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
      default:
        throw new Error(`unsupported type ${(msg as { type: string }).type}`)
    }
  }

  async sendSeen(session: string, chatId: string): Promise<void> {
    const sock = this.sessions.socket(session)
    if (!sock) throw new Error('no socket')
    await sock.readMessages?.([{ remoteJid: chatId, id: '', participant: undefined } as never])
  }
}
