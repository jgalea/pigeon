import type { FastifyInstance } from 'fastify'
import type { Core } from './server.js'
import type { OutgoingMessage, OutgoingType } from '../core/types.js'

interface WahaFile {
  data?: string
  url?: string
  mimetype?: string
  filename?: string
}

const mapFile = (file?: WahaFile) =>
  file && { data: file.data, url: file.url, mimetype: file.mimetype, filename: file.filename }

export async function registerCompat(app: FastifyInstance, core: Core) {
  app.get('/api/sessions', async () =>
    core.sessions.list().map((s) => ({ name: s.name, status: s.status, engine: { engine: 'PIGEON' } })),
  )

  app.get('/api/sessions/:name', async (req) => {
    const name = (req.params as { name: string }).name
    return { name, status: core.sessions.status(name), config: null, engine: { engine: 'PIGEON' } }
  })

  for (const action of ['start', 'stop', 'restart'] as const) {
    app.post(`/api/sessions/:name/${action}`, async (req) => {
      const name = (req.params as { name: string }).name
      await core.sessions[action](name)
      return { name, status: core.sessions.status(name) }
    })
  }

  app.get('/api/:session/auth/qr', async (req, reply) => {
    const session = (req.params as { session: string }).session
    const qr = core.sessions.getQr(session)
    if (!qr) return reply.code(404).send({ error: 'no qr available' })
    const { toBuffer } = await import('qrcode')
    const png = await toBuffer(qr, { type: 'png', width: 384 })
    return reply.header('content-type', 'image/png').send(png)
  })

  const sender = (type: OutgoingType) => async (req: { body: unknown }) => {
    const b = req.body as {
      session?: string
      chatId: string
      text?: string
      caption?: string
      file?: WahaFile
      latitude?: number
      longitude?: number
    }
    const msg: OutgoingMessage = { chatId: b.chatId, type }
    if (type === 'text') msg.text = b.text
    else if (type === 'location') msg.location = { latitude: b.latitude!, longitude: b.longitude! }
    else {
      msg.media = mapFile(b.file)
      if (b.caption) msg.caption = b.caption
    }
    const r = await core.messages.send(b.session ?? 'default', msg)
    return { id: r.id, _data: { id: r.id } }
  }

  app.post('/api/sendText', sender('text'))
  app.post('/api/sendImage', sender('image'))
  app.post('/api/sendFile', sender('file'))
  app.post('/api/sendVoice', sender('voice'))
  app.post('/api/sendVideo', sender('video'))
  app.post('/api/sendLocation', sender('location'))

  app.post('/api/sendSeen', async (req) => {
    const b = req.body as { session?: string; chatId: string }
    await core.messages.sendSeen(b.session ?? 'default', b.chatId)
    return { success: true }
  })

  app.post('/api/sendContact', async (req) => {
    const b = req.body as { session?: string; chatId: string; fullName: string; phone: string; organization?: string }
    const r = await core.messages.send(b.session ?? 'default', {
      chatId: b.chatId,
      type: 'contact',
      contact: { fullName: b.fullName, phone: b.phone, organization: b.organization },
    })
    return { id: r.id }
  })

  app.post('/api/sendPoll', async (req) => {
    const b = req.body as {
      session?: string
      chatId: string
      name: string
      options: string[]
      selectableCount?: number
    }
    const r = await core.messages.send(b.session ?? 'default', {
      chatId: b.chatId,
      type: 'poll',
      poll: { name: b.name, options: b.options, selectableCount: b.selectableCount },
    })
    return { id: r.id }
  })

  app.post('/api/reaction', async (req) => {
    const b = req.body as { session?: string; chatId: string; messageId: string; reaction: string; fromMe?: boolean }
    return core.messages.react(b.session ?? 'default', b.chatId, b.messageId, b.reaction, b.fromMe ?? false)
  })

  app.post('/api/startTyping', async (req) => {
    const b = req.body as { session?: string; chatId: string }
    return core.wa.setPresence(b.session ?? 'default', 'composing', b.chatId)
  })
  app.post('/api/stopTyping', async (req) => {
    const b = req.body as { session?: string; chatId: string }
    return core.wa.setPresence(b.session ?? 'default', 'paused', b.chatId)
  })

  app.get('/api/:session/chats/:chatId/messages', async (req) => {
    const p = req.params as { session: string; chatId: string }
    const q = req.query as { limit?: string }
    const limit = Number(q.limit ?? 100)
    return core.history.list(p.session, decodeURIComponent(p.chatId), limit).map((m) => ({
      id: m.msgId,
      timestamp: m.timestamp,
      fromMe: m.fromMe,
      type: m.type,
      body: m.body ?? m.caption ?? '',
      hasMedia: !!m.mediaPath,
      from: m.chatId,
    }))
  })

  app.get('/api/:session/groups', async (req) => {
    const session = (req.params as { session: string }).session
    const sock = core.sessions.socket(session)
    if (!sock) return []
    const groups = await sock.groupFetchAllParticipating()
    return Object.values(groups).map((g) => ({ id: g.id, name: g.subject }))
  })

  app.get('/api/contacts/check-exists', async (req) => {
    const q = req.query as { session?: string; phone: string }
    const sock = core.sessions.socket(q.session ?? 'default')
    if (!sock) return { numberExists: false }
    const res = await sock.onWhatsApp(`${String(q.phone).replace(/[^0-9]/g, '')}@s.whatsapp.net`)
    const hit = res?.[0]
    return { numberExists: !!hit?.exists, chatId: hit?.jid }
  })
}
