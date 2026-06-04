import { describe, it, expect, beforeEach } from 'vitest'
import { openDb } from '../src/db/database.js'
import { HistoryStore } from '../src/db/historyStore.js'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

describe('HistoryStore', () => {
  let store: HistoryStore
  beforeEach(() => {
    store = new HistoryStore(openDb(mkdtempSync(join(tmpdir(), 'wa-'))))
  })

  it('saves and returns messages newest-first', () => {
    store.save({ session: 'default', chatId: 'a@c.us', msgId: '1', fromMe: false, timestamp: 100, type: 'text', body: 'hi', raw: {} })
    store.save({ session: 'default', chatId: 'a@c.us', msgId: '2', fromMe: true, timestamp: 200, type: 'text', body: 'yo', raw: {} })
    const msgs = store.list('default', 'a@c.us', 10)
    expect(msgs.map((m) => m.msgId)).toEqual(['2', '1'])
  })

  it('upserts on duplicate id', () => {
    const m = { session: 'default', chatId: 'a@c.us', msgId: '1', fromMe: false, timestamp: 100, type: 'text', body: 'hi', raw: {} }
    store.save(m)
    store.save({ ...m, body: 'edited' })
    const list = store.list('default', 'a@c.us', 10)
    expect(list).toHaveLength(1)
    expect(list[0].body).toBe('edited')
  })

  it('returns the oldest message for a chat', () => {
    store.save({ session: 'default', chatId: 'a@c.us', msgId: '2', fromMe: true, timestamp: 200, type: 'text', body: 'newer', raw: {} })
    store.save({ session: 'default', chatId: 'a@c.us', msgId: '1', fromMe: false, timestamp: 100, type: 'text', body: 'older', raw: {} })
    expect(store.oldest('default', 'a@c.us')?.msgId).toBe('1')
    expect(store.oldest('default', 'empty@c.us')).toBeUndefined()
  })
})
