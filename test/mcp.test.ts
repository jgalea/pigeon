import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { buildServer, loadMcpConfig } from '../src/mcp.js'

const sent: unknown[] = []
const seen: unknown[] = []

function stubApi(): FastifyInstance {
  const app = Fastify()
  app.addHook('onRequest', async (req, reply) => {
    if (req.headers['x-api-key'] !== 'k') reply.code(401).send({ error: 'unauthorized' })
  })
  app.get('/v1/sessions/default', async () => ({ name: 'default', status: 'WORKING' }))
  app.get('/v1/sessions/default/chats', async () => [{ chatId: 'a@s.whatsapp.net', lastTimestamp: 1, count: 2 }])
  app.get('/v1/sessions/default/chats/:chatId/messages', async () => [
    { session: 'default', chatId: 'a@s.whatsapp.net', msgId: '1', fromMe: false, timestamp: 1, type: 'text', body: 'hi', raw: { big: 'blob' } },
  ])
  app.post('/v1/sessions/default/messages', async (req) => {
    sent.push(req.body)
    return { id: 'OUT1' }
  })
  app.post('/api/sendSeen', async (req) => {
    seen.push(req.body)
    return { ok: true }
  })
  app.get('/v1/sessions/default/contacts/check', async (req) => {
    const q = req.query as { phone: string }
    return { exists: true, jid: `${q.phone}@s.whatsapp.net` }
  })
  return app
}

let app: FastifyInstance
let client: Client

beforeAll(async () => {
  app = stubApi()
  const url = await app.listen({ port: 0, host: '127.0.0.1' })
  const server = buildServer({ url, apiKey: 'k', session: 'default' })
  client = new Client({ name: 'test', version: '0.0.0' })
  const [ct, st] = InMemoryTransport.createLinkedPair()
  await server.connect(st)
  await client.connect(ct)
})

afterAll(async () => {
  await client.close()
  await app.close()
})

function textOf(result: Awaited<ReturnType<Client['callTool']>>): string {
  const content = result.content as Array<{ type: string; text: string }>
  return content[0].text
}

describe('pigeon mcp', () => {
  it('exposes the expected tools', async () => {
    const { tools } = await client.listTools()
    expect(tools.map((t) => t.name).sort()).toEqual([
      'check_contact',
      'list_chats',
      'mark_read',
      'read_messages',
      'send_media',
      'send_message',
      'session_status',
    ])
  })

  it('reports session status', async () => {
    const r = await client.callTool({ name: 'session_status', arguments: {} })
    expect(JSON.parse(textOf(r))).toEqual({ name: 'default', status: 'WORKING' })
  })

  it('lists chats', async () => {
    const r = await client.callTool({ name: 'list_chats', arguments: { limit: 5 } })
    expect(JSON.parse(textOf(r))[0].chatId).toBe('a@s.whatsapp.net')
  })

  it('reads messages and strips the raw payload', async () => {
    const r = await client.callTool({ name: 'read_messages', arguments: { chatId: 'a@s.whatsapp.net' } })
    const msgs = JSON.parse(textOf(r))
    expect(msgs[0].body).toBe('hi')
    expect(msgs[0].raw).toBeUndefined()
  })

  it('sends a text message', async () => {
    const r = await client.callTool({ name: 'send_message', arguments: { chatId: '34600111222', text: 'hello' } })
    expect(JSON.parse(textOf(r)).id).toBe('OUT1')
    expect(sent.at(-1)).toEqual({ chatId: '34600111222', type: 'text', text: 'hello' })
  })

  it('marks a chat read via the compat endpoint', async () => {
    await client.callTool({ name: 'mark_read', arguments: { chatId: 'a@s.whatsapp.net' } })
    expect(seen.at(-1)).toEqual({ session: 'default', chatId: 'a@s.whatsapp.net' })
  })

  it('checks a contact', async () => {
    const r = await client.callTool({ name: 'check_contact', arguments: { phone: '34600111222' } })
    expect(JSON.parse(textOf(r)).exists).toBe(true)
  })

  it('surfaces API errors as tool errors', async () => {
    const server = buildServer({ url: `http://127.0.0.1:${(app.server.address() as { port: number }).port}`, apiKey: 'wrong', session: 'default' })
    const c = new Client({ name: 't2', version: '0.0.0' })
    const [ct, st] = InMemoryTransport.createLinkedPair()
    await server.connect(st)
    await c.connect(ct)
    const r = await c.callTool({ name: 'session_status', arguments: {} })
    expect(r.isError).toBe(true)
    await c.close()
  })
})

describe('pigeon mcp draft-only mode', () => {
  it('drafts instead of sending and announces the mode', async () => {
    const url = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`
    const server = buildServer({ url, apiKey: 'k', session: 'default', readOnly: true })
    const c = new Client({ name: 'ro', version: '0.0.0' })
    const [ct, st] = InMemoryTransport.createLinkedPair()
    await server.connect(st)
    await c.connect(ct)

    const before = sent.length
    const r = await c.callTool({ name: 'send_message', arguments: { chatId: '34600111222', text: 'hello' } })
    const out = JSON.parse(textOf(r))
    expect(out.sent).toBe(false)
    expect(out.mode).toBe('draft-only')
    expect(out.draft).toEqual({ to: '34600111222', type: 'text', text: 'hello' })
    expect(sent.length).toBe(before)

    const { tools } = await c.listTools()
    expect(tools.find((t) => t.name === 'send_message')?.description).toContain('DRAFT-ONLY')
    await c.close()
  })
})

describe('loadMcpConfig', () => {
  it('uses env vars when set', () => {
    const cfg = loadMcpConfig({ WA_API_KEY: 'x', WA_API_URL: 'http://h:1/', WA_SESSION: 's1' } as NodeJS.ProcessEnv)
    expect(cfg).toEqual({ url: 'http://h:1', apiKey: 'x', session: 's1', readOnly: false })
  })

  it('parses WA_MCP_READONLY as a boolean flag', () => {
    expect(loadMcpConfig({ WA_API_KEY: 'x', WA_MCP_READONLY: 'true' } as NodeJS.ProcessEnv).readOnly).toBe(true)
    expect(loadMcpConfig({ WA_API_KEY: 'x', WA_MCP_READONLY: '1' } as NodeJS.ProcessEnv).readOnly).toBe(true)
    expect(loadMcpConfig({ WA_API_KEY: 'x', WA_MCP_READONLY: 'no' } as NodeJS.ProcessEnv).readOnly).toBe(false)
  })
})
