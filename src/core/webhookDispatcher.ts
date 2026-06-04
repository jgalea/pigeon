import type { Logger } from '../logger.js'
import type { WebhookEvent } from './types.js'

type Fetch = typeof fetch

export class WebhookDispatcher {
  private urls = new Map<string, string[]>()
  private sse = new Set<(e: WebhookEvent) => void>()

  constructor(
    private logger: Logger,
    private fetchImpl: Fetch = fetch,
    private opts: { retries: number; baseDelayMs: number } = { retries: 3, baseDelayMs: 500 },
  ) {}

  setUrls(session: string, urls: string[]) {
    this.urls.set(session, urls)
  }
  getUrls(session: string) {
    return this.urls.get(session) ?? []
  }
  subscribe(fn: (e: WebhookEvent) => void) {
    this.sse.add(fn)
    return () => this.sse.delete(fn)
  }

  async dispatch(e: WebhookEvent, urlsOverride?: string[]) {
    for (const fn of this.sse) {
      try {
        fn(e)
      } catch {
        /* ignore subscriber errors */
      }
    }
    const urls = urlsOverride ?? this.getUrls(e.session)
    await Promise.all(urls.map((u) => this.deliver(u, e)))
  }

  private async deliver(url: string, e: WebhookEvent) {
    for (let attempt = 0; attempt <= this.opts.retries; attempt++) {
      try {
        const res = await this.fetchImpl(url, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(e),
        })
        if ((res as { ok: boolean }).ok) return
      } catch {
        this.logger.warn({ url, attempt }, 'webhook delivery failed')
      }
      if (attempt < this.opts.retries) {
        await new Promise((r) => setTimeout(r, this.opts.baseDelayMs * 2 ** attempt))
      }
    }
    this.logger.error({ url, event: e.event }, 'webhook gave up')
  }
}
