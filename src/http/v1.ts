import type { FastifyInstance } from 'fastify'
import type { Core } from './server.js'
import type { OutgoingMessage } from '../core/types.js'

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

  app.get('/v1/sessions/:name/chats/:chatId/messages', async (req) => {
    const p = req.params as { name: string; chatId: string }
    const q = req.query as { limit?: string }
    return core.history.list(p.name, decodeURIComponent(p.chatId), Number(q.limit ?? 100))
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
