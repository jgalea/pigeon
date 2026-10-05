import { resolve } from 'node:path'

export interface SendGuardConfig {
  enabled: boolean
  postConnectCooldownMs: number
  coldMinGapMs: number
  coldMaxPerHour: number
  coldMaxPerDay: number
  participantsMaxPerHour: number
}

export interface Config {
  apiKey: string
  port: number
  host: string
  dataDir: string
  mediaDir: string
  mediaLifetimeDays: number
  mediaAutoDownload: boolean
  logLevel: string
  webhookSecret?: string
  // Server-side fetching of caller-supplied urls. Both off unless opted in.
  allowUrlMedia: boolean
  allowWebhooks: boolean
  guard: SendGuardConfig
}

const on = (v: string | undefined) => ['1', 'true', 'yes', 'on'].includes((v ?? '').trim().toLowerCase())

export function loadConfig(env = process.env): Config {
  const apiKey = env.WA_API_KEY
  if (!apiKey) throw new Error('WA_API_KEY is required')
  return {
    apiKey,
    port: Number(env.WA_PORT ?? 4000),
    host: env.WA_HOST ?? '127.0.0.1',
    dataDir: resolve(env.WA_DATA_DIR ?? './data'),
    mediaDir: resolve(env.WA_MEDIA_DIR ?? './media'),
    mediaLifetimeDays: Number(env.WA_MEDIA_LIFETIME_DAYS ?? 180),
    mediaAutoDownload: (env.WA_MEDIA_AUTODOWNLOAD ?? 'on') !== 'off',
    logLevel: env.WA_LOG_LEVEL ?? 'info',
    webhookSecret: env.WA_WEBHOOK_SECRET || undefined,
    allowUrlMedia: on(env.PIGEON_ALLOW_URL_MEDIA),
    allowWebhooks: on(env.PIGEON_ALLOW_WEBHOOKS),
    guard: {
      enabled: (env.WA_SEND_GUARD ?? 'on') !== 'off',
      postConnectCooldownMs: Number(env.WA_GUARD_POST_CONNECT_MS ?? 120_000),
      coldMinGapMs: Number(env.WA_GUARD_COLD_MIN_GAP_MS ?? 60_000),
      coldMaxPerHour: Number(env.WA_GUARD_COLD_PER_HOUR ?? 5),
      coldMaxPerDay: Number(env.WA_GUARD_COLD_PER_DAY ?? 20),
      participantsMaxPerHour: Number(env.WA_GUARD_PARTICIPANTS_PER_HOUR ?? 20),
    },
  }
}
