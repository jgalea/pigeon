import type { FastifyInstance } from 'fastify'
import { downloadMediaMessage } from '@whiskeysockets/baileys'
import type { Core } from './server.js'
import type { OutgoingMessage, PresenceType } from '../core/types.js'

export async function registerV1(app: FastifyInstance, core: Core) {
  app.get('/v1/sessions', async () => core.sessions.list())

  app.post('/v1/sessions', async (req) => {
    const name = (req.body as { name: string }).name
    await core.sessions.start(name)
    return { name, status: core.sessions.status(name) }
  })

  app.get('/v1/sessions/:name', async (req) => {
    const name = (req.params as { name: string }).name
    return { name, status: core.sessions.status(name), qr: core.sessions.getQr(name) }
  })

  app.delete('/v1/sessions/:name', async (req) => {
    await core.sessions.logout((req.params as { name: string }).name)
    return { ok: true }
  })

  for (const a of ['start', 'stop', 'restart'] as const) {
    app.post(`/v1/sessions/:name/${a}`, async (req) => {
      const name = (req.params as { name: string }).name
      await core.sessions[a](name)
      return { status: core.sessions.status(name) }
    })
  }

  app.post('/v1/sessions/:name/messages', async (req) => {
    const name = (req.params as { name: string }).name
    return core.messages.send(name, req.body as OutgoingMessage)
  })

  app.get('/v1/sessions/:name/chats', async (req) => {
    const name = (req.params as { name: string }).name
    const q = req.query as { limit?: string }
    return core.history.chats(name, Number(q.limit ?? 200))
  })

  app.get('/v1/sessions/:name/chats/:chatId/messages', async (req) => {
    const p = req.params as { name: string; chatId: string }
    const q = req.query as { limit?: string }
    return core.history.list(p.name, decodeURIComponent(p.chatId), Number(q.limit ?? 100))
  })

  // Download (decrypt) inbound media for a stored message. Returns the raw bytes.
  app.get('/v1/sessions/:name/chats/:chatId/messages/:msgId/media', async (req, reply) => {
    const p = req.params as { name: string; chatId: string; msgId: string }
    const msg = core.history.get(p.name, decodeURIComponent(p.chatId), p.msgId)
    if (!msg) return reply.code(404).send({ error: 'message not found' })
    const sock = core.sessions.socket(p.name)
    if (!sock) return reply.code(409).send({ error: 'session not started' })
    const content = (msg.raw as { message?: Record<string, unknown> } | undefined)?.message ?? {}
    const docLike =
      (content.documentMessage ??
        content.imageMessage ??
        content.videoMessage ??
        content.audioMessage) as { fileName?: string; mimetype?: string } | undefined
    if (!docLike) return reply.code(415).send({ error: 'message has no downloadable media' })
    const buffer = (await downloadMediaMessage(
      msg.raw as Parameters<typeof downloadMediaMessage>[0],
      'buffer',
      {},
      {
        logger: core.logger,
        reuploadRequest: sock.updateMediaMessage,
      } as NonNullable<Parameters<typeof downloadMediaMessage>[3]>,
    )) as Buffer
    const filename = docLike.fileName ?? `${p.msgId}.bin`
    reply.header('Content-Type', docLike.mimetype ?? 'application/octet-stream')
    reply.header('Content-Disposition', `attachment; filename="${filename.replace(/"/g, '')}"`)
    return reply.send(buffer)
  })

  // Request older history for a chat. Persists asynchronously; re-query messages after.
  app.post('/v1/sessions/:name/chats/:chatId/backfill', async (req) => {
    const p = req.params as { name: string; chatId: string }
    const b = (req.body ?? {}) as { count?: number }
    return core.sessions.backfill(p.name, decodeURIComponent(p.chatId), b.count ?? 50)
  })

  // --- message actions ---
  app.post('/v1/sessions/:name/react', async (req) => {
    const name = (req.params as { name: string }).name
    const b = req.body as { chatId: string; msgId: string; emoji: string; fromMe?: boolean }
    return core.messages.react(name, b.chatId, b.msgId, b.emoji, b.fromMe ?? false)
  })
  app.post('/v1/sessions/:name/edit', async (req) => {
    const name = (req.params as { name: string }).name
    const b = req.body as { chatId: string; msgId: string; text: string }
    return core.messages.edit(name, b.chatId, b.msgId, b.text)
  })
  app.post('/v1/sessions/:name/delete', async (req) => {
    const name = (req.params as { name: string }).name
    const b = req.body as { chatId: string; msgId: string; fromMe?: boolean }
    return core.messages.remove(name, b.chatId, b.msgId, b.fromMe ?? true)
  })
  app.post('/v1/sessions/:name/forward', async (req) => {
    const name = (req.params as { name: string }).name
    const b = req.body as { toChatId: string; fromChatId: string; msgId: string }
    return core.messages.forward(name, b.toChatId, b.fromChatId, b.msgId)
  })

  // --- presence ---
  app.post('/v1/sessions/:name/presence', async (req) => {
    const name = (req.params as { name: string }).name
    const b = req.body as { type: PresenceType; chatId?: string }
    return core.wa.setPresence(name, b.type, b.chatId)
  })
  app.post('/v1/sessions/:name/presence/subscribe', async (req) => {
    const name = (req.params as { name: string }).name
    return core.wa.subscribePresence(name, (req.body as { chatId: string }).chatId)
  })

  // --- contacts ---
  app.get('/v1/sessions/:name/contacts/check', async (req) => {
    const name = (req.params as { name: string }).name
    return core.wa.checkExists(name, (req.query as { phone: string }).phone)
  })
  app.get('/v1/sessions/:name/contacts/:chatId/picture', async (req) => {
    const p = req.params as { name: string; chatId: string }
    return core.wa.profilePicture(p.name, decodeURIComponent(p.chatId))
  })
  app.post('/v1/sessions/:name/contacts/:chatId/block', async (req) => {
    const p = req.params as { name: string; chatId: string }
    const b = req.body as { blocked?: boolean }
    return core.wa.setBlocked(p.name, decodeURIComponent(p.chatId), b.blocked ?? true)
  })

  // --- profile (own account) ---
  app.put('/v1/sessions/:name/profile/name', async (req) => {
    const name = (req.params as { name: string }).name
    return core.wa.setProfileName(name, (req.body as { name: string }).name)
  })
  app.put('/v1/sessions/:name/profile/status', async (req) => {
    const name = (req.params as { name: string }).name
    return core.wa.setProfileStatus(name, (req.body as { status: string }).status)
  })

  // --- groups ---
  app.post('/v1/sessions/:name/groups', async (req) => {
    const name = (req.params as { name: string }).name
    const b = req.body as { subject: string; participants?: string[] }
    return core.wa.groupCreate(name, b.subject, b.participants ?? [])
  })
  app.get('/v1/sessions/:name/groups', async (req) => {
    return core.wa.groupsList((req.params as { name: string }).name)
  })
  app.get('/v1/sessions/:name/groups/:groupId', async (req) => {
    const p = req.params as { name: string; groupId: string }
    return core.wa.groupMetadata(p.name, decodeURIComponent(p.groupId))
  })
  app.post('/v1/sessions/:name/groups/:groupId/leave', async (req) => {
    const p = req.params as { name: string; groupId: string }
    return core.wa.groupLeave(p.name, decodeURIComponent(p.groupId))
  })
  app.post('/v1/sessions/:name/groups/:groupId/participants', async (req) => {
    const p = req.params as { name: string; groupId: string }
    const b = req.body as { participants: string[]; action: 'add' | 'remove' | 'promote' | 'demote' }
    return core.wa.groupParticipants(p.name, decodeURIComponent(p.groupId), b.participants, b.action)
  })
  app.put('/v1/sessions/:name/groups/:groupId/subject', async (req) => {
    const p = req.params as { name: string; groupId: string }
    return core.wa.groupUpdateSubject(p.name, decodeURIComponent(p.groupId), (req.body as { subject: string }).subject)
  })
  app.put('/v1/sessions/:name/groups/:groupId/description', async (req) => {
    const p = req.params as { name: string; groupId: string }
    return core.wa.groupUpdateDescription(
      p.name,
      decodeURIComponent(p.groupId),
      (req.body as { description: string }).description,
    )
  })
  app.get('/v1/sessions/:name/groups/:groupId/invite', async (req) => {
    const p = req.params as { name: string; groupId: string }
    return core.wa.groupInviteCode(p.name, decodeURIComponent(p.groupId))
  })
  app.post('/v1/sessions/:name/groups/:groupId/invite/revoke', async (req) => {
    const p = req.params as { name: string; groupId: string }
    return core.wa.groupRevokeInvite(p.name, decodeURIComponent(p.groupId))
  })
  app.post('/v1/sessions/:name/groups/accept', async (req) => {
    const name = (req.params as { name: string }).name
    return core.wa.groupAcceptInvite(name, (req.body as { code: string }).code)
  })
  app.put('/v1/sessions/:name/groups/:groupId/setting', async (req) => {
    const p = req.params as { name: string; groupId: string }
    const b = req.body as { setting: 'announcement' | 'not_announcement' | 'locked' | 'unlocked' }
    return core.wa.groupSetting(p.name, decodeURIComponent(p.groupId), b.setting)
  })

  // --- status / stories ---
  app.post('/v1/sessions/:name/status', async (req) => {
    const name = (req.params as { name: string }).name
    const b = req.body as {
      text?: string
      media?: { data?: string; url?: string; mimetype?: string }
      statusJidList?: string[]
    }
    return core.wa.postStatus(name, b)
  })

  // --- channels (newsletters) ---
  app.post('/v1/sessions/:name/channels', async (req) => {
    const name = (req.params as { name: string }).name
    const b = req.body as { name: string; description?: string }
    return core.wa.channelCreate(name, b.name, b.description)
  })
  app.get('/v1/sessions/:name/channels/:channelId', async (req) => {
    const p = req.params as { name: string; channelId: string }
    return core.wa.channelMetadata(p.name, decodeURIComponent(p.channelId))
  })
  app.post('/v1/sessions/:name/channels/:channelId/follow', async (req) => {
    const p = req.params as { name: string; channelId: string }
    return core.wa.channelFollow(p.name, decodeURIComponent(p.channelId))
  })
  app.post('/v1/sessions/:name/channels/:channelId/unfollow', async (req) => {
    const p = req.params as { name: string; channelId: string }
    return core.wa.channelUnfollow(p.name, decodeURIComponent(p.channelId))
  })
  app.delete('/v1/sessions/:name/channels/:channelId', async (req) => {
    const p = req.params as { name: string; channelId: string }
    return core.wa.channelDelete(p.name, decodeURIComponent(p.channelId))
  })

  // --- pairing code (alternative to QR) ---
  app.post('/v1/sessions/:name/auth/pairing-code', async (req) => {
    const name = (req.params as { name: string }).name
    return core.wa.requestPairingCode(name, (req.body as { phone: string }).phone)
  })

  app.put('/v1/sessions/:name/webhooks', async (req) => {
    const name = (req.params as { name: string }).name
    const urls = (req.body as { urls?: string[] }).urls ?? []
    core.webhooks.setUrls(name, urls)
    return { urls: core.webhooks.getUrls(name) }
  })

  app.get('/v1/events', (req, reply) => {
    reply.raw.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    })
    const unsub = core.webhooks.subscribe((e) => reply.raw.write(`data: ${JSON.stringify(e)}\n\n`))
    req.raw.on('close', unsub)
  })
}
