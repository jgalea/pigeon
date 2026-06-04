import { describe, it, expect } from 'vitest'
import { EventEmitter } from 'node:events'
import { openDb } from '../src/db/database.js'
import { HistoryStore } from '../src/db/historyStore.js'
import { SessionManager } from '../src/core/sessionManager.js'
import { makeLogger } from '../src/logger.js'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

function fakeSocket() {
  const sock = new EventEmitter() as EventEmitter & Record<string, unknown>
  ;(sock as { ev: unknown }).ev = sock
  sock.sendMessage = async () => ({ key: { id: 'OUT1' } })
  sock.logout = async () => {}
  sock.end = () => {}
  return sock
}

function newManager() {
  const db = openDb(mkdtempSync(join(tmpdir(), 'wa-')))
  const hs = new HistoryStore(db)
  const sock = fakeSocket()
  const mgr = new SessionManager(db, hs, makeLogger('silent'), async () => sock as never)
  return { mgr, sock, hs }
}

describe('SessionManager', () => {
  it('goes SCAN_QR_CODE on qr and WORKING on open', async () => {
    const { mgr, sock } = newManager()
    await mgr.start('default')
    sock.emit('connection.update', { qr: 'QRDATA' })
    expect(mgr.status('default')).toBe('SCAN_QR_CODE')
    expect(mgr.getQr('default')).toBe('QRDATA')
    sock.emit('connection.update', { connection: 'open' })
    expect(mgr.status('default')).toBe('WORKING')
    expect(mgr.getQr('default')).toBeUndefined()
  })

  it('persists incoming messages to history', async () => {
    const { mgr, sock, hs } = newManager()
    await mgr.start('default')
    sock.emit('messages.upsert', {
      type: 'notify',
      messages: [
        {
          key: { remoteJid: 'a@s.whatsapp.net', id: 'M1', fromMe: false },
          messageTimestamp: 123,
          message: { conversation: 'hello' },
        },
      ],
    })
    const msgs = hs.list('default', 'a@s.whatsapp.net', 5)
    expect(msgs[0].body).toBe('hello')
  })
})
