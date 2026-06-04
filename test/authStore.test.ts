import { describe, it, expect, beforeEach } from 'vitest'
import { openDb } from '../src/db/database.js'
import { useSqliteAuthState } from '../src/db/authStore.js'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

describe('useSqliteAuthState', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'wa-'))
  })

  it('initializes creds and persists across reload', async () => {
    const db = openDb(dir)
    const a = await useSqliteAuthState(db, 'default')
    expect(a.state.creds).toBeTruthy()
    a.state.creds.me = { id: '123@s.whatsapp.net', name: 'Test' }
    await a.saveCreds()
    const b = await useSqliteAuthState(db, 'default')
    expect(b.state.creds.me?.id).toBe('123@s.whatsapp.net')
  })

  it('stores and retrieves signal keys as Buffers', async () => {
    const db = openDb(dir)
    const a = await useSqliteAuthState(db, 'default')
    await a.state.keys.set({ 'pre-key': { '1': { public: Buffer.from([1, 2, 3]) } } } as never)
    const got = await a.state.keys.get('pre-key', ['1'])
    expect(Buffer.isBuffer((got['1'] as { public: Buffer }).public)).toBe(true)
  })
})
