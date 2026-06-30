import type { SendGuardConfig } from '../config.js'

export interface GuardContext {
  now: number
  isCold: boolean
  connectedAt?: number
}

export interface GuardVerdict {
  ok: boolean
  reason?: string
}

const HOUR = 3_600_000
const DAY = 86_400_000

// Guards outbound "cold" messages — first contact with a number that has never
// messaged this account — against the patterns WhatsApp flags as spam: blasting
// many new numbers, sending right after (re)linking a device, and back-to-back
// cold sends. Warm replies and group messages are never gated.
export class SendGuard {
  private coldSends = new Map<string, number[]>()

  constructor(private cfg: SendGuardConfig) {}

  check(session: string, ctx: GuardContext): GuardVerdict {
    if (!this.cfg.enabled || !ctx.isCold) return { ok: true }

    if (ctx.connectedAt !== undefined) {
      const since = ctx.now - ctx.connectedAt
      if (since < this.cfg.postConnectCooldownMs) {
        const wait = Math.ceil((this.cfg.postConnectCooldownMs - since) / 1000)
        return {
          ok: false,
          reason: `session linked ${Math.round(since / 1000)}s ago; first contact to new numbers is paused for ${wait}s more after (re)linking, to avoid WhatsApp spam flags`,
        }
      }
    }

    const recent = (this.coldSends.get(session) ?? []).filter((t) => ctx.now - t < DAY)
    const last = recent[recent.length - 1]
    if (last !== undefined && ctx.now - last < this.cfg.coldMinGapMs) {
      const wait = Math.ceil((this.cfg.coldMinGapMs - (ctx.now - last)) / 1000)
      return {
        ok: false,
        reason: `wait ${wait}s before messaging another new contact (min ${Math.round(this.cfg.coldMinGapMs / 1000)}s gap between first contacts)`,
      }
    }
    const inHour = recent.filter((t) => ctx.now - t < HOUR).length
    if (inHour >= this.cfg.coldMaxPerHour) {
      return {
        ok: false,
        reason: `hit the hourly cap of ${this.cfg.coldMaxPerHour} first-contact messages; space them out or save the numbers as contacts first`,
      }
    }
    if (recent.length >= this.cfg.coldMaxPerDay) {
      return { ok: false, reason: `hit the daily cap of ${this.cfg.coldMaxPerDay} first-contact messages` }
    }
    return { ok: true }
  }

  record(session: string, now: number): void {
    const recent = (this.coldSends.get(session) ?? []).filter((t) => now - t < DAY)
    recent.push(now)
    this.coldSends.set(session, recent)
  }
}
