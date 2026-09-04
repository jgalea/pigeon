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
  sock.fetchHistoryCalls = [] as unknown[]
  sock.fetchMessageHistory = async (count: number, key: unknown, ts: number) => {
    ;(sock.fetchHistoryCalls as unknown[]).push({ count, key, ts })
    return 'REQ1'
  }
  return sock
}

function newManager(media?: unknown) {
  const db = openDb(mkdtempSync(join(tmpdir(), 'wa-')))
  const hs = new HistoryStore(db)
  const sock = fakeSocket()
  const mgr = new SessionManager(
    db,
    hs,
    makeLogger('silent'),
    async () => sock as never,
    media as never,
  )
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

  it('fetches inbound media on arrival and records the path', async () => {
    const calls: unknown[] = []
    const media = {
      saveIncoming: async (msg: unknown) => {
        calls.push(msg)
        return '/media/abc.ogg'
      },
    }
    const { mgr, sock, hs } = newManager(media)
    await mgr.start('default')
    sock.emit('messages.upsert', {
      type: 'notify',
      messages: [
        {
          key: { remoteJid: 'a@s.whatsapp.net', id: 'V1', fromMe: false },
          messageTimestamp: 123,
          message: { audioMessage: { mimetype: 'audio/ogg; codecs=opus', ptt: true } },
        },
      ],
    })
    await new Promise((r) => setTimeout(r, 0))
    expect(calls).toHaveLength(1)
    expect(hs.get('default', 'a@s.whatsapp.net', 'V1')?.mediaPath).toBe('/media/abc.ogg')
  })

  it('leaves text messages alone', async () => {
    const calls: unknown[] = []
    const media = {
      saveIncoming: async (msg: unknown) => {
        calls.push(msg)
        return '/media/nope.bin'
      },
    }
    const { mgr, sock } = newManager(media)
    await mgr.start('default')
    sock.emit('messages.upsert', {
      type: 'notify',
      messages: [
        {
          key: { remoteJid: 'a@s.whatsapp.net', id: 'T1', fromMe: false },
          messageTimestamp: 123,
          message: { conversation: 'hi' },
        },
      ],
    })
    await new Promise((r) => setTimeout(r, 0))
    expect(calls).toHaveLength(0)
  })

  it('stores the message even when the media fetch throws', async () => {
    const media = {
      saveIncoming: async () => {
        throw new Error('410 Gone')
      },
    }
    const { mgr, sock, hs } = newManager(media)
    await mgr.start('default')
    sock.emit('messages.upsert', {
      type: 'notify',
      messages: [
        {
          key: { remoteJid: 'a@s.whatsapp.net', id: 'V2', fromMe: false },
          messageTimestamp: 123,
          message: { audioMessage: { mimetype: 'audio/ogg' } },
        },
      ],
    })
    await new Promise((r) => setTimeout(r, 0))
    const stored = hs.get('default', 'a@s.whatsapp.net', 'V2')
    expect(stored).toBeDefined()
    expect(stored?.mediaPath).toBeUndefined()
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

  it('surfaces a shared contact card as name + number in body', async () => {
    const { mgr, sock, hs } = newManager()
    await mgr.start('default')
    sock.emit('messages.upsert', {
      type: 'notify',
      messages: [
        {
          key: { remoteJid: 'a@s.whatsapp.net', id: 'C1', fromMe: false },
          messageTimestamp: 200,
          message: {
            contactMessage: {
              displayName: 'Ana Costa',
              vcard:
                'BEGIN:VCARD\nVERSION:3.0\nN:Costa;Ana;;;\nFN:Ana Costa\nTEL;type=CELL;type=VOICE;waid=351912345678:+351 912 345 678\nEND:VCARD',
            },
          },
        },
      ],
    })
    const msgs = hs.list('default', 'a@s.whatsapp.net', 5)
    expect(msgs[0].body).toBe('Ana Costa — +351 912 345 678')
  })

  it('persists the history-sync backlog from messaging-history.set', async () => {
    const { mgr, sock, hs } = newManager()
    await mgr.start('default')
    sock.emit('messaging-history.set', {
      syncType: 2,
      messages: [
        { key: { remoteJid: 'b@s.whatsapp.net', id: 'H1', fromMe: false }, messageTimestamp: 50, message: { conversation: 'old one' } },
        { key: { remoteJid: 'b@s.whatsapp.net', id: 'H2', fromMe: true }, messageTimestamp: 60, message: { conversation: 'old two' } },
      ],
    })
    const msgs = hs.list('default', 'b@s.whatsapp.net', 5)
    expect(msgs.map((m) => m.msgId)).toEqual(['H2', 'H1'])
  })

  it('backfill calls fetchMessageHistory anchored on the oldest stored message', async () => {
    const { mgr, sock, hs } = newManager()
    await mgr.start('default')
    hs.save({ session: 'default', chatId: 'c@s.whatsapp.net', msgId: 'OLD', fromMe: false, timestamp: 10, type: 'text', body: 'anchor', raw: {} })
    hs.save({ session: 'default', chatId: 'c@s.whatsapp.net', msgId: 'NEW', fromMe: true, timestamp: 20, type: 'text', body: 'newer', raw: {} })
    const res = await mgr.backfill('default', 'c@c.us', 30)
    expect(res.requestId).toBe('REQ1')
    expect(sock.fetchHistoryCalls).toEqual([
      { count: 30, key: { remoteJid: 'c@s.whatsapp.net', id: 'OLD', fromMe: false }, ts: 10 },
    ])
  })

  it('backfill rejects when the chat has no stored anchor message', async () => {
    const { mgr } = newManager()
    await mgr.start('default')
    await expect(mgr.backfill('default', 'nobody@c.us', 30)).rejects.toThrow(/page back from/)
  })
})
