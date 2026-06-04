import Fastify from 'fastify'
import type { Config } from '../config.js'
import type { Logger } from '../logger.js'
import type { SessionManager } from '../core/sessionManager.js'
import type { MessageService } from '../core/messageService.js'
import type { HistoryStore } from '../db/historyStore.js'
import type { MediaService } from '../core/mediaService.js'
import type { WebhookDispatcher } from '../core/webhookDispatcher.js'
import type { WaService } from '../core/waService.js'
import { registerCompat } from './compat.js'
import { registerV1 } from './v1.js'

export interface Core {
  config: Config
  logger: Logger
  sessions: SessionManager
  messages: MessageService
  history: HistoryStore
  media: MediaService
  webhooks: WebhookDispatcher
  wa: WaService
}

export async function buildServer(core: Core) {
  const app = Fastify({ logger: false, bodyLimit: 64 * 1024 * 1024 })

  app.get('/api/health', async () => ({ status: 'ok' }))

  app.addHook('onRequest', async (req, reply) => {
    if (req.url.startsWith('/api/health')) return
    if (req.headers['x-api-key'] !== core.config.apiKey) {
      reply.code(401).send({ error: 'unauthorized' })
    }
  })

  await registerCompat(app, core)
  await registerV1(app, core)
  return app
}
