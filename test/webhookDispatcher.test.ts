import { describe, it, expect, vi } from 'vitest'
import { WebhookDispatcher } from '../src/core/webhookDispatcher.js'
import { openDb } from '../src/db/database.js'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { makeLogger } from '../src/logger.js'

describe('WebhookDispatcher', () => {
  it('POSTs the event to a configured url', async () => {
    const fetchMock = vi.fn(async () => ({ ok: true, status: 200 }))
    const d = new WebhookDispatcher(makeLogger('silent'), fetchMock as never)
    d.setUrls('default', ['https://hook.test/x'])
    await d.dispatch({ session: 'default', event: 'message', payload: { a: 1 }, timestamp: 1 })
    expect(fetchMock).toHaveBeenCalledOnce()
    expect(fetchMock.mock.calls[0][0]).toBe('https://hook.test/x')
  })

  it('fans out to SSE subscribers', async () => {
    const d = new WebhookDispatcher(makeLogger('silent'), (async () => ({ ok: true })) as never)
    const seen: unknown[] = []
    d.subscribe((e) => seen.push(e))
    await d.dispatch({ session: 'default', event: 'message', payload: {}, timestamp: 1 }, [])
    expect(seen).toHaveLength(1)
  })

  it('retries on failure then gives up', async () => {
    const fetchMock = vi.fn(async () => {
      throw new Error('down')
    })
    const d = new WebhookDispatcher(makeLogger('silent'), fetchMock as never, { retries: 2, baseDelayMs: 1 })
    await d.dispatch({ session: 'default', event: 'message', payload: {}, timestamp: 1 }, ['https://hook.test/x'])
    expect(fetchMock).toHaveBeenCalledTimes(3)
  })

  it('logs the status of a non-success response and keeps retrying', async () => {
    const warn = vi.fn()
    const logger = { info() {}, warn, error() {} } as never
    const send = vi.fn(async () => ({ ok: false, status: 504 }))
    const d = new WebhookDispatcher(logger, send as never, { retries: 1, baseDelayMs: 1 })
    await d.dispatch({ session: 'default', event: 'message', payload: {}, timestamp: 1 }, ['https://hook.test/x'])
    expect(send).toHaveBeenCalledTimes(2)
    expect(warn).toHaveBeenCalledWith(
      { url: 'https://hook.test/x', attempt: 0, status: 504 },
      'webhook delivery returned non-success status',
    )
  })

  it('retries after a timed-out attempt and then gives up', async () => {
    const warn = vi.fn()
    const error = vi.fn()
    const logger = { info() {}, warn, error } as never
    const send = vi.fn(async () => {
      throw new Error('request timed out after 10000ms')
    })
    const d = new WebhookDispatcher(logger, send as never, { retries: 1, baseDelayMs: 1 })
    await d.dispatch({ session: 'default', event: 'message', payload: {}, timestamp: 1 }, ['https://hook.test/x'])
    expect(send).toHaveBeenCalledTimes(2)
    expect(warn).toHaveBeenCalledTimes(2)
    expect(error).toHaveBeenCalledOnce()
  })

  it('delivers through the public-url check by default, so a private target is never connected to', async () => {
    const warn = vi.fn()
    const logger = { info() {}, warn, error() {} } as never
    const d = new WebhookDispatcher(logger, undefined, { retries: 0, baseDelayMs: 1 })
    await d.dispatch({ session: 'default', event: 'message', payload: {}, timestamp: 1 }, [
      'http://127.0.0.1:1/hook',
      'http://host.docker.internal:4000/hook',
    ])
    expect(warn).toHaveBeenCalledTimes(2)
    for (const call of warn.mock.calls) {
      expect((call[0] as { err: string }).err).toMatch(/private or local|not allowed/)
    }
  })

  it('restores configured urls after a restart and drops cleared ones', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pigeon-wh-'))
    const logger = makeLogger('silent')
    const db = openDb(dir)
    const first = new WebhookDispatcher(logger, vi.fn() as never, undefined, db)
    first.setUrls('default', ['https://hook.test/a', 'https://hook.test/b'])
    first.setUrls('other', ['https://hook.test/c'])
    db.close()

    const db2 = openDb(dir)
    const second = new WebhookDispatcher(logger, vi.fn() as never, undefined, db2)
    expect(second.getUrls('default')).toEqual(['https://hook.test/a', 'https://hook.test/b'])
    expect(second.getUrls('other')).toEqual(['https://hook.test/c'])
    second.setUrls('other', [])
    db2.close()

    const db3 = openDb(dir)
    const third = new WebhookDispatcher(logger, vi.fn() as never, undefined, db3)
    expect(third.getUrls('other')).toEqual([])
    expect(third.getUrls('default')).toHaveLength(2)
    db3.close()
  })

  it('does not load stored urls when webhooks are disabled, but still persists a clear', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pigeon-wh-'))
    const logger = makeLogger('silent')
    const db = openDb(dir)
    new WebhookDispatcher(logger, vi.fn() as never, undefined, db).setUrls('default', ['https://hook.test/a'])
    db.close()

    const db2 = openDb(dir)
    const off = new WebhookDispatcher(logger, vi.fn() as never, undefined, db2, false)
    expect(off.getUrls('default')).toEqual([])
    off.setUrls('default', [])
    db2.close()

    const db3 = openDb(dir)
    expect(new WebhookDispatcher(logger, vi.fn() as never, undefined, db3).getUrls('default')).toEqual([])
    db3.close()
  })
})
