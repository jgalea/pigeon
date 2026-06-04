import pino from 'pino'

export function makeLogger(level: string) {
  return pino({
    level: level === 'silent' ? 'silent' : level,
    redact: {
      paths: ['req.headers["x-api-key"]', 'apiKey', 'data', '*.data'],
      censor: '[redacted]',
    },
    transport: level === 'debug' ? { target: 'pino-pretty' } : undefined,
  })
}

export type Logger = ReturnType<typeof makeLogger>
