import { describe, it, expect, vi } from 'vitest'
import Fastify from 'fastify'
import { apiKeyMatches, buildServer, type Core } from '../src/http/server.js'
import { registerV1 } from '../src/http/v1.js'
import { WebhookDispatcher } from '../src/core/webhookDispatcher.js'
import { loadConfig } from '../src/config.js'

const logger = { info() {}, warn() {}, error() {} } as never

function coreMock(over: { allowWebhooks?: boolean } = { allowWebhooks: true }): Core {
  return {
    config: { apiKey: 'secret-key', ...over } as never,
    logger,
    sessions: { list: vi.fn(() => [{ name: 'default', status: 'WORKING' }]) } as never,
    messages: {} as never,
    history: {} as never,
    media: {} as never,
    webhooks: new WebhookDispatcher(logger, vi.fn() as never),
    wa: {} as never,
  }
}

describe('apiKeyMatches', () => {
  it('matches only the exact key', () => {
    expect(apiKeyMatches('secret-key', 'secret-key')).toBe(true)
    expect(apiKeyMatches('secret-kez', 'secret-key')).toBe(false)
    expect(apiKeyMatches('secret-ke', 'secret-key')).toBe(false)
    expect(apiKeyMatches('', 'secret-key')).toBe(false)
    expect(apiKeyMatches(undefined, 'secret-key')).toBe(false)
    expect(apiKeyMatches(['secret-key'], 'secret-key')).toBe(false)
  })
})

describe('api key hook', () => {
  it('lets health through and gates everything else on the key', async () => {
    const app = await buildServer(coreMock())
    expect((await app.inject({ method: 'GET', url: '/api/health' })).statusCode).toBe(200)
    expect((await app.inject({ method: 'GET', url: '/v1/sessions' })).statusCode).toBe(401)
    expect((await app.inject({ method: 'GET', url: '/v1/sessions', headers: { 'x-api-key': 'secret-kez' } })).statusCode).toBe(401)
    const ok = await app.inject({ method: 'GET', url: '/v1/sessions', headers: { 'x-api-key': 'secret-key' } })
    expect(ok.statusCode).toBe(200)
    expect(ok.json()).toEqual([{ name: 'default', status: 'WORKING' }])
    await app.close()
  })
})

describe('opt-in flags', () => {
  it('default to off and read the usual truthy spellings', () => {
    const off = loadConfig({ WA_API_KEY: 'k' } as NodeJS.ProcessEnv)
    expect(off.allowUrlMedia).toBe(false)
    expect(off.allowWebhooks).toBe(false)
    const on = loadConfig({ WA_API_KEY: 'k', PIGEON_ALLOW_URL_MEDIA: '1', PIGEON_ALLOW_WEBHOOKS: 'true' } as NodeJS.ProcessEnv)
    expect(on.allowUrlMedia).toBe(true)
    expect(on.allowWebhooks).toBe(true)
    expect(loadConfig({ WA_API_KEY: 'k', PIGEON_ALLOW_WEBHOOKS: '0' } as NodeJS.ProcessEnv).allowWebhooks).toBe(false)
  })
})

describe('PUT /v1/sessions/:name/webhooks', () => {
  async function appWith(core: Core) {
    const app = Fastify()
    await registerV1(app, core)
    return app
  }

  it('refuses any url while webhooks are off, but still lets the list be cleared', async () => {
    const core = coreMock({ allowWebhooks: false })
    const app = await appWith(core)
    const r = await app.inject({
      method: 'PUT',
      url: '/v1/sessions/default/webhooks',
      payload: { urls: ['https://203.0.113.10/hook'] },
    })
    expect(r.statusCode).toBe(400)
    expect(r.json().error).toMatch(/PIGEON_ALLOW_WEBHOOKS=1/)
    expect(core.webhooks.getUrls('default')).toEqual([])
    const clear = await app.inject({ method: 'PUT', url: '/v1/sessions/default/webhooks', payload: { urls: [] } })
    expect(clear.statusCode).toBe(200)
    expect(clear.json()).toEqual({ urls: [] })
  })

  it('rejects local, private and docker-host urls without storing anything', async () => {
    const core = coreMock()
    const app = await appWith(core)
    for (const u of [
      'http://127.0.0.1:4000/v1/sessions',
      'http://host.docker.internal:4000/hook',
      'http://192.168.1.10/hook',
      'http://[::1]/hook',
      'http://169.254.169.254/',
      'file:///etc/passwd',
      'not a url',
    ]) {
      const r = await app.inject({ method: 'PUT', url: '/v1/sessions/default/webhooks', payload: { urls: [u] } })
      expect(r.statusCode, u).toBe(400)
      expect(r.json().error).toMatch(/webhook url rejected/)
    }
    const mixed = await app.inject({
      method: 'PUT',
      url: '/v1/sessions/default/webhooks',
      payload: { urls: ['https://203.0.113.10/hook', 'http://10.0.0.1/hook'] },
    })
    expect(mixed.statusCode).toBe(400)
    expect(core.webhooks.getUrls('default')).toEqual([])
  })

  it('stores public urls', async () => {
    const core = coreMock()
    const app = await appWith(core)
    const r = await app.inject({
      method: 'PUT',
      url: '/v1/sessions/default/webhooks',
      payload: { urls: ['https://203.0.113.10/hook'] },
    })
    expect(r.statusCode).toBe(200)
    expect(r.json()).toEqual({ urls: ['https://203.0.113.10/hook'] })
    expect(core.webhooks.getUrls('default')).toEqual(['https://203.0.113.10/hook'])
  })
})
