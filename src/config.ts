import { resolve } from 'node:path'

export interface Config {
  apiKey: string
  port: number
  host: string
  dataDir: string
  mediaDir: string
  mediaLifetimeDays: number
  logLevel: string
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
  }
}
