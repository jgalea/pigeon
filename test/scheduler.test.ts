import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import Fastify from 'fastify'
import { openDb, type DB } from '../src/db/database.js'
import { ScheduleStore } from '../src/db/scheduleStore.js'
import { Scheduler } from '../src/core/scheduler.js'
import { registerV1 } from '../src/http/v1.js'
import { parseSendAt } from '../src/core/sendAt.js'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const logger = { info() {}, warn() {}, error() {} }
const T0 = Date.parse('2026-10-20T06:00:00Z')
const CHAT = '15551234567@s.whatsapp.net'

let db: DB
let store: ScheduleStore

function makeScheduler(opts: { status?: () => string; send?: ReturnType<typeof vi.fn> } = {}) {
  const send = opts.send ?? vi.fn(async () => ({ id: 'OUT1' }))
  const scheduler = new Scheduler(store, send, opts.status ?? (() => 'WORKING'), logger)
  return { send, scheduler }
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] })
  vi.setSystemTime(T0)
  db = openDb(mkdtempSync(join(tmpdir(), 'pigeon-sched-')))
  store = new ScheduleStore(db)
})

afterEach(() => {
  vi.useRealTimers()
  db.close()
})

describe('parseSendAt', () => {
  it('accepts offsets, Z and epoch ms, and rejects naive or past times', () => {
    expect(parseSendAt('2026-10-20T07:30:00+01:00')).toBe(Date.parse('2026-10-20T06:30:00Z'))
    expect(parseSendAt('2026-10-20T06:30:00Z')).toBe(T0 + 30 * 60_000)
    expect(parseSendAt(T0 + 5000)).toBe(T0 + 5000)
    expect(() => parseSendAt('2026-10-20T07:30:00')).toThrow(/offset/)
    expect(() => parseSendAt('2026-10-20')).toThrow(/offset/)
    expect(() => parseSendAt('2026-13-20T07:30:00Z')).toThrow(/valid/)
    expect(() => parseSendAt(T0 - 1)).toThrow(/past/)
    expect(() => parseSendAt(undefined)).toThrow(/required/)
  })
})

describe('ScheduleStore', () => {
  it('creates, lists by status and cancels only pending rows', () => {
    const a = store.create('default', CHAT, 'one', T0 + 2000)
    const b = store.create('default', CHAT, 'two', T0 + 1000)
    store.create('other', CHAT, 'elsewhere', T0 + 1000)
    expect(a).toMatchObject({ status: 'pending', sentAt: null, messageId: null, error: null, createdAt: T0 })
    expect(store.list('default').map((m) => m.text)).toEqual(['two', 'one'])
    expect(store.cancel('default', a.id)).toBe(true)
    expect(store.cancel('default', a.id)).toBe(false)
    expect(store.cancel('other', b.id)).toBe(false)
    expect(store.list('default', 'pending').map((m) => m.id)).toEqual([b.id])
    expect(store.list('default', 'cancelled').map((m) => m.id)).toEqual([a.id])
  })

  it('lets exactly one caller claim a row', () => {
    const m = store.create('default', CHAT, 'x', T0 + 1)
    expect(store.claim(m.id)).toBe(true)
    expect(store.claim(m.id)).toBe(false)
  })
})

describe('Scheduler', () => {
  it('sends a due message once and records the message id', async () => {
    const m = store.create('default', CHAT, 'hello', T0 + 1000)
    const { scheduler, send } = makeScheduler()
    await scheduler.tick()
    expect(send).not.toHaveBeenCalled()
    vi.setSystemTime(T0 + 1000)
    await scheduler.tick()
    await scheduler.tick()
    expect(send).toHaveBeenCalledTimes(1)
    expect(send).toHaveBeenCalledWith('default', { chatId: CHAT, type: 'text', text: 'hello' })
    expect(store.get(m.id)).toMatchObject({ status: 'sent', messageId: 'OUT1', sentAt: T0 + 1000, error: null })
  })

  it('marks the row failed with the error when the send throws', async () => {
    const m = store.create('default', CHAT, 'hello', T0 + 1)
    const send = vi.fn(async () => {
      throw new Error('blocked by anti-spam guard: cooldown')
    })
    vi.setSystemTime(T0 + 1)
    await makeScheduler({ send }).scheduler.tick()
    await makeScheduler({ send }).scheduler.tick()
    expect(send).toHaveBeenCalledTimes(1)
    expect(store.get(m.id)).toMatchObject({ status: 'failed', error: 'blocked by anti-spam guard: cooldown' })
  })

  it('does not double-send when two schedulers race over the same row', async () => {
    const m = store.create('default', CHAT, 'hello', T0 + 1)
    vi.setSystemTime(T0 + 1)
    const send = vi.fn(async () => ({ id: 'OUT1' }))
    const a = makeScheduler({ send }).scheduler
    const b = makeScheduler({ send }).scheduler
    await Promise.all([a.tick(), b.tick()])
    expect(send).toHaveBeenCalledTimes(1)
    expect(store.get(m.id)!.status).toBe('sent')
  })

  it('does not send a cancelled message', async () => {
    const m = store.create('default', CHAT, 'hello', T0 + 1000)
    expect(store.cancel('default', m.id)).toBe(true)
    vi.setSystemTime(T0 + 2000)
    const { scheduler, send } = makeScheduler()
    await scheduler.tick()
    expect(send).not.toHaveBeenCalled()
    expect(store.get(m.id)!.status).toBe('cancelled')
  })

  it('retries while the session is down, then sends once it is WORKING', async () => {
    const m = store.create('default', CHAT, 'hello', T0 + 1000)
    let status = 'STOPPED'
    const { scheduler, send } = makeScheduler({ status: () => status })
    vi.setSystemTime(T0 + 60_000)
    await scheduler.tick()
    expect(send).not.toHaveBeenCalled()
    expect(store.get(m.id)!.status).toBe('pending')
    status = 'WORKING'
    vi.setSystemTime(T0 + 120_000)
    await scheduler.tick()
    expect(send).toHaveBeenCalledTimes(1)
    expect(store.get(m.id)!.status).toBe('sent')
  })

  it('marks a message missed once the retry window has passed', async () => {
    const m = store.create('default', CHAT, 'hello', T0 + 1000)
    const { scheduler, send } = makeScheduler()
    vi.setSystemTime(T0 + 1000 + 31 * 60_000)
    await scheduler.tick()
    expect(send).not.toHaveBeenCalled()
    expect(store.get(m.id)).toMatchObject({ status: 'failed', error: expect.stringMatching(/missed/) })
  })

  it('on start sends a recently overdue message and fails one left mid-send', async () => {
    const recent = store.create('default', CHAT, 'recent', T0 + 1000)
    const stuck = store.create('default', CHAT, 'stuck', T0 + 1000)
    store.claim(stuck.id)
    vi.setSystemTime(T0 + 5 * 60_000)
    const { scheduler, send } = makeScheduler()
    scheduler.start()
    await vi.advanceTimersByTimeAsync(0)
    scheduler.stop()
    expect(send).toHaveBeenCalledTimes(1)
    expect(store.get(recent.id)!.status).toBe('sent')
    expect(store.get(stuck.id)).toMatchObject({ status: 'failed', error: expect.stringMatching(/interrupted/) })
  })

  it('fires from its own interval without any call to tick', async () => {
    const m = store.create('default', CHAT, 'hello', T0 + 30_000)
    const { scheduler, send } = makeScheduler()
    scheduler.start()
    await vi.advanceTimersByTimeAsync(60_000)
    scheduler.stop()
    expect(send).toHaveBeenCalledTimes(1)
    expect(store.get(m.id)!.status).toBe('sent')
  })
})

describe('scheduled REST routes', () => {
  async function app() {
    const a = Fastify()
    await registerV1(a, { schedule: store } as never)
    return a
  }
  const sendAt = () => new Date(Date.now() + 3600_000).toISOString()

  it('creates, lists and cancels', async () => {
    const a = await app()
    const created = await a.inject({
      method: 'POST',
      url: '/v1/sessions/default/scheduled',
      payload: { chatId: '15551234567', text: 'hi', sendAt: sendAt() },
    })
    expect(created.statusCode).toBe(200)
    expect(created.json()).toMatchObject({ chatId: CHAT, text: 'hi', status: 'pending' })
    const id = created.json().id
    const listed = await a.inject({ method: 'GET', url: '/v1/sessions/default/scheduled?status=pending' })
    expect(listed.json().map((m: { id: number }) => m.id)).toEqual([id])
    const cancelled = await a.inject({ method: 'DELETE', url: `/v1/sessions/default/scheduled/${id}` })
    expect(cancelled.json().status).toBe('cancelled')
    expect((await a.inject({ method: 'DELETE', url: `/v1/sessions/default/scheduled/${id}` })).statusCode).toBe(409)
    expect((await a.inject({ method: 'DELETE', url: '/v1/sessions/default/scheduled/999' })).statusCode).toBe(404)
    expect((await a.inject({ method: 'GET', url: '/v1/sessions/default/scheduled?status=bogus' })).statusCode).toBe(400)
    await a.close()
  })

  it('rejects past, naive and malformed requests', async () => {
    const a = await app()
    const post = (payload: unknown) => a.inject({ method: 'POST', url: '/v1/sessions/default/scheduled', payload: payload as object })
    expect((await post({ chatId: '15551234567', text: 'hi', sendAt: Date.now() - 1000 })).statusCode).toBe(400)
    expect((await post({ chatId: '15551234567', text: 'hi', sendAt: '2099-01-01T07:30:00' })).statusCode).toBe(400)
    expect((await post({ chatId: '15551234567', text: '  ', sendAt: sendAt() })).statusCode).toBe(400)
    expect((await post({ chatId: 'a,b', text: 'hi', sendAt: sendAt() })).statusCode).toBe(400)
    expect(store.list('default')).toEqual([])
    await a.close()
  })

  it('does not cancel another session\'s message', async () => {
    const other = store.create('other', CHAT, 'x', T0 + 1000)
    const a = await app()
    expect((await a.inject({ method: 'DELETE', url: `/v1/sessions/default/scheduled/${other.id}` })).statusCode).toBe(404)
    expect(store.get(other.id)!.status).toBe('pending')
    await a.close()
  })
})
