import { describe, it, expect, vi } from 'vitest'
import { WebhookDispatcher } from '../src/core/webhookDispatcher.js'
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
})
