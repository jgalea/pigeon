import { loadConfig } from './config.js'
import { makeLogger } from './logger.js'
import { openDb } from './db/database.js'
import { HistoryStore } from './db/historyStore.js'
import { SessionManager } from './core/sessionManager.js'
import { MessageService } from './core/messageService.js'
import { MediaService } from './core/mediaService.js'
import { WebhookDispatcher } from './core/webhookDispatcher.js'
import { buildServer } from './http/server.js'

const config = loadConfig()
const logger = makeLogger(config.logLevel)
const db = openDb(config.dataDir)

const history = new HistoryStore(db)
const media = new MediaService(config.mediaDir, config.mediaLifetimeDays, logger)
const sessions = new SessionManager(db, history, logger)
const messages = new MessageService(sessions, history, media)
const webhooks = new WebhookDispatcher(logger)

sessions.on('event', (e) => {
  webhooks.dispatch(e).catch((err) => logger.warn({ err }, 'webhook dispatch failed'))
})

const app = await buildServer({ config, logger, sessions, messages, history, media, webhooks })
await app.listen({ host: config.host, port: config.port })
logger.info({ port: config.port, host: config.host }, 'pigeon listening')

await sessions.start('default').catch((e) => logger.error({ e }, 'default session start failed'))

const cleanupTimer = setInterval(() => media.cleanup(), 24 * 3600_000)

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, async () => {
    clearInterval(cleanupTimer)
    await app.close()
    db.close()
    process.exit(0)
  })
}
