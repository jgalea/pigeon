import type { ScheduleStore } from '../db/scheduleStore.js'
import type { OutgoingMessage } from './types.js'
import type { Logger } from '../logger.js'

export interface SchedulerOptions {
  intervalMs?: number
  graceMs?: number
}

export class Scheduler {
  private timer?: NodeJS.Timeout
  private running = false
  private intervalMs: number
  private graceMs: number

  constructor(
    private store: ScheduleStore,
    private send: (session: string, msg: OutgoingMessage) => Promise<{ id: string }>,
    private sessionStatus: (session: string) => string,
    private logger: Pick<Logger, 'info' | 'warn' | 'error'>,
    opts: SchedulerOptions = {},
  ) {
    this.intervalMs = opts.intervalMs ?? 20_000
    this.graceMs = opts.graceMs ?? 30 * 60_000
  }

  start() {
    const interrupted = this.store.failInterrupted()
    if (interrupted) this.logger.warn({ interrupted }, 'scheduled messages were mid-send at shutdown; marked failed')
    this.timer = setInterval(() => void this.tick(), this.intervalMs)
    void this.tick()
  }

  stop() {
    if (this.timer) clearInterval(this.timer)
    this.timer = undefined
  }

  async tick(now = Date.now()) {
    if (this.running) return
    this.running = true
    try {
      for (const m of this.store.due(now)) {
        if (now - m.sendAt > this.graceMs) {
          this.store.markFailed(m.id, 'missed: overdue beyond the retry window')
          continue
        }
        if (this.sessionStatus(m.session) !== 'WORKING') continue
        if (!this.store.claim(m.id)) continue
        try {
          const res = await this.send(m.session, { chatId: m.chatId, type: 'text', text: m.text })
          this.store.markSent(m.id, res.id)
        } catch (e) {
          const error = e instanceof Error ? e.message : String(e)
          this.store.markFailed(m.id, error)
          this.logger.warn({ id: m.id, error }, 'scheduled message failed')
        }
      }
    } catch (e) {
      this.logger.error({ e }, 'scheduler tick failed')
    } finally {
      this.running = false
    }
  }
}
