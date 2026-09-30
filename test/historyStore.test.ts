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

  it('presents old stub rows as system events and can filter them out', () => {
    const stubRaw = (id: string) => ({
      key: { remoteJid: 'g@g.us', id },
      messageStubType: 'GROUP_PARTICIPANT_ADD',
      messageStubParameters: ['{"id":"9@lid","admin":null}'],
    })
    for (let i = 1; i <= 60; i++) {
      store.save({ session: 'default', chatId: 'g@g.us', msgId: `s${i}`, fromMe: false, timestamp: 1000 + i, type: 'unknown', raw: stubRaw(`s${i}`) })
    }
    store.save({ session: 'default', chatId: 'g@g.us', msgId: 'real', fromMe: false, timestamp: 500, type: 'conversation', body: 'hello', raw: { message: { conversation: 'hello' } } })

    const all = store.list('default', 'g@g.us', 5)
    expect(all).toHaveLength(5)
    expect(all[0]).toMatchObject({ type: 'system', body: 'added: 9@lid' })

    const noSystem = store.list('default', 'g@g.us', 5, { includeSystem: false })
    expect(noSystem.map((m) => m.msgId)).toEqual(['real'])

    expect(store.list('default', 'empty@g.us', 5, { includeSystem: false })).toEqual([])
  })

  it('returns the oldest message for a chat', () => {
    store.save({ session: 'default', chatId: 'a@c.us', msgId: '2', fromMe: true, timestamp: 200, type: 'text', body: 'newer', raw: {} })
    store.save({ session: 'default', chatId: 'a@c.us', msgId: '1', fromMe: false, timestamp: 100, type: 'text', body: 'older', raw: {} })
    expect(store.oldest('default', 'a@c.us')?.msgId).toBe('1')
    expect(store.oldest('default', 'empty@c.us')).toBeUndefined()
  })
})
