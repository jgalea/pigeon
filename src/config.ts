import { resolve } from 'node:path'

export interface SendGuardConfig {
  enabled: boolean
  postConnectCooldownMs: number
  coldMinGapMs: number
  coldMaxPerHour: number
  coldMaxPerDay: number
}

export interface Config {
  apiKey: string
  port: number
  host: string
  dataDir: string
  mediaDir: string
  mediaLifetimeDays: number
  logLevel: string
  webhookSecret?: string
  guard: SendGuardConfig
}

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
    logLevel: env.WA_LOG_LEVEL ?? 'info',
    webhookSecret: env.WA_WEBHOOK_SECRET || undefined,
    guard: {
      enabled: (env.WA_SEND_GUARD ?? 'on') !== 'off',
      postConnectCooldownMs: Number(env.WA_GUARD_POST_CONNECT_MS ?? 120_000),
      coldMinGapMs: Number(env.WA_GUARD_COLD_MIN_GAP_MS ?? 60_000),
      coldMaxPerHour: Number(env.WA_GUARD_COLD_PER_HOUR ?? 5),
      coldMaxPerDay: Number(env.WA_GUARD_COLD_PER_DAY ?? 20),
    },
  }
}
