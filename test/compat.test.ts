import { describe, it, expect, vi } from 'vitest'
import Fastify from 'fastify'
import { registerCompat } from '../src/http/compat.js'
import type { Core } from '../src/http/server.js'

function coreMock(): Core {
  const sock = {
    onWhatsApp: async () => [{ exists: true, jid: '34600@s.whatsapp.net' }],
    groupFetchAllParticipating: async () => ({ g1: { id: 'g1@g.us', subject: 'Group One' } }),
  }
  return {
    config: { apiKey: 'k' } as never,
    logger: { info() {}, warn() {}, error() {} } as never,
    sessions: {
      status: vi.fn(() => 'WORKING'),
      getQr: vi.fn(() => undefined),
      start: vi.fn(),
      stop: vi.fn(),
      restart: vi.fn(),
      list: vi.fn(() => [{ name: 'default', status: 'WORKING' }]),
      socket: vi.fn(() => sock),
    } as never,
    messages: { send: vi.fn(async () => ({ id: 'OUT1' })), sendSeen: vi.fn() } as never,
    history: {
      list: vi.fn(() => [
        { session: 'default', chatId: 'a@c.us', msgId: '1', fromMe: false, timestamp: 1, type: 'text', body: 'hi', raw: {} },
      ]),
    } as never,
    media: {} as never,
    webhooks: {} as never,
  }
}

async function appWith(core: Core) {
  const app = Fastify()
  await registerCompat(app, core)
  return app
}

describe('compat /api', () => {
  it('GET /api/sessions/default returns name+status+engine', async () => {
    const app = await appWith(coreMock())
    const r = await app.inject({ method: 'GET', url: '/api/sessions/default' })
    expect(r.json()).toMatchObject({ name: 'default', status: 'WORKING', engine: { engine: 'PIGEON' } })
  })

  it('POST /api/sendText calls messages.send with a text message', async () => {
    const core = coreMock()
    const app = await appWith(core)
    const r = await app.inject({ method: 'POST', url: '/api/sendText', payload: { session: 'default', chatId: 'a@c.us', text: 'hi' } })
    expect(core.messages.send).toHaveBeenCalledWith('default', { chatId: 'a@c.us', type: 'text', text: 'hi' })
    expect(r.json()).toMatchObject({ id: 'OUT1' })
  })

  it('POST /api/sendFile maps the flat file object to a file send', async () => {
    const core = coreMock()
    const app = await appWith(core)
    await app.inject({
      method: 'POST',
      url: '/api/sendFile',
      payload: { session: 'default', chatId: 'a@c.us', file: { data: 'B64', mimetype: 'application/pdf', filename: 'r.pdf' }, caption: 'x' },
    })
    expect(core.messages.send).toHaveBeenCalledWith('default', {
      chatId: 'a@c.us',
      type: 'file',
      caption: 'x',
      media: { data: 'B64', url: undefined, mimetype: 'application/pdf', filename: 'r.pdf' },
    })
  })

  it('GET chats messages returns a flat array', async () => {
    const app = await appWith(coreMock())
    const r = await app.inject({ method: 'GET', url: '/api/default/chats/a%40c.us/messages?limit=10' })
    const body = r.json()
    expect(Array.isArray(body)).toBe(true)
    expect(body[0]).toMatchObject({ id: '1', body: 'hi', fromMe: false })
  })

  it('GET chats messages normalizes @c.us to the stored @s.whatsapp.net JID', async () => {
    const core = coreMock()
    const app = await appWith(core)
    await app.inject({ method: 'GET', url: '/api/default/chats/34600000000%40c.us/messages?limit=10' })
    expect(core.history.list).toHaveBeenCalledWith('default', '34600000000@s.whatsapp.net', 10)
  })

  it('GET groups returns id+name', async () => {
    const app = await appWith(coreMock())
    const r = await app.inject({ method: 'GET', url: '/api/default/groups' })
    expect(r.json()).toEqual([{ id: 'g1@g.us', name: 'Group One' }])
  })

  it('check-exists returns numberExists', async () => {
    const app = await appWith(coreMock())
    const r = await app.inject({ method: 'GET', url: '/api/contacts/check-exists?session=default&phone=34600' })
    expect(r.json()).toMatchObject({ numberExists: true, chatId: '34600@s.whatsapp.net' })
  })
})
