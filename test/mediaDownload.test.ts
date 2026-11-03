import { describe, it, expect, vi, beforeEach } from 'vitest'
import Fastify from 'fastify'

const download = vi.hoisted(() => vi.fn())
vi.mock('@whiskeysockets/baileys', () => ({ downloadMediaMessage: download }))

import { registerV1 } from '../src/http/v1.js'
import type { Core } from '../src/http/server.js'

const logger = { info() {}, warn() {}, error() {} } as never

async function appWith(message: Record<string, unknown> | undefined) {
  const core = {
    config: {} as never,
    logger,
    sessions: { socket: vi.fn(() => ({ updateMediaMessage: vi.fn() })) } as never,
    history: {
      get: vi.fn(() => (message ? { raw: { message }, mediaPath: undefined } : undefined)),
    } as never,
  } as unknown as Core
  const app = Fastify()
  registerV1(app, core)
  await app.ready()
  return app
}

const url = '/v1/sessions/default/chats/15551234567%40s.whatsapp.net/messages/MSG1/media'

describe('GET .../media', () => {
  beforeEach(() => download.mockReset())

  it('downloads a sticker as webp', async () => {
    download.mockResolvedValue(Buffer.from('webp-bytes'))
    const app = await appWith({ stickerMessage: { mimetype: 'image/webp' } })
    const res = await app.inject({ method: 'GET', url })
    expect(res.statusCode).toBe(200)
    expect(res.headers['content-type']).toContain('image/webp')
    expect(res.headers['content-disposition']).toBe('attachment; filename="MSG1.webp"')
    expect(res.body).toBe('webp-bytes')
    await app.close()
  })

  it('falls back to .bin for a sticker with another mimetype', async () => {
    download.mockResolvedValue(Buffer.from('x'))
    const app = await appWith({ stickerMessage: { mimetype: 'application/octet-stream' } })
    const res = await app.inject({ method: 'GET', url })
    expect(res.headers['content-disposition']).toBe('attachment; filename="MSG1.bin"')
    await app.close()
  })

  it('still rejects messages with no media', async () => {
    const app = await appWith({ conversation: 'hi' })
    const res = await app.inject({ method: 'GET', url })
    expect(res.statusCode).toBe(415)
    await app.close()
  })
})
