import { describe, it, expect } from 'vitest'
import { SendGuard } from '../src/core/sendGuard.js'
import type { SendGuardConfig } from '../src/config.js'

const cfg = (over: Partial<SendGuardConfig> = {}): SendGuardConfig => ({
  enabled: true,
  postConnectCooldownMs: 120_000,
  coldMinGapMs: 60_000,
  coldMaxPerHour: 5,
  coldMaxPerDay: 20,
  ...over,
})

const T = 1_000_000_000_000 // fixed base time

describe('SendGuard', () => {
  it('never gates warm (non-cold) sends', () => {
    const g = new SendGuard(cfg())
    expect(g.check('default', { now: T, isCold: false, connectedAt: T }).ok).toBe(true)
  })

  it('passes everything when disabled', () => {
    const g = new SendGuard(cfg({ enabled: false }))
    expect(g.check('default', { now: T, isCold: true, connectedAt: T }).ok).toBe(true)
  })

  it('blocks cold sends during the post-connect cooldown', () => {
    const g = new SendGuard(cfg())
    const v = g.check('default', { now: T + 10_000, isCold: true, connectedAt: T })
    expect(v.ok).toBe(false)
    expect(v.reason).toMatch(/after \(re\)linking/)
  })

  it('allows a cold send once past the cooldown', () => {
    const g = new SendGuard(cfg())
    expect(g.check('default', { now: T + 200_000, isCold: true, connectedAt: T }).ok).toBe(true)
  })

  it('enforces the minimum gap between cold sends', () => {
    const g = new SendGuard(cfg())
    g.record('default', T)
    const tooSoon = g.check('default', { now: T + 30_000, isCold: true })
    expect(tooSoon.ok).toBe(false)
    expect(g.check('default', { now: T + 61_000, isCold: true }).ok).toBe(true)
  })

  it('enforces the hourly cap', () => {
    const g = new SendGuard(cfg({ coldMinGapMs: 0 }))
    for (let i = 0; i < 5; i++) g.record('default', T + i)
    const v = g.check('default', { now: T + 10, isCold: true })
    expect(v.ok).toBe(false)
    expect(v.reason).toMatch(/hourly cap/)
  })

  it('enforces the daily cap while letting the hourly window roll over', () => {
    const g = new SendGuard(cfg({ coldMinGapMs: 0, coldMaxPerHour: 100, coldMaxPerDay: 3 }))
    g.record('default', T)
    g.record('default', T + 2 * 3_600_000)
    g.record('default', T + 4 * 3_600_000)
    const v = g.check('default', { now: T + 5 * 3_600_000, isCold: true })
    expect(v.ok).toBe(false)
    expect(v.reason).toMatch(/daily cap/)
  })

  it('forgets cold sends older than a day', () => {
    const g = new SendGuard(cfg({ coldMaxPerDay: 1, coldMinGapMs: 0 }))
    g.record('default', T)
    expect(g.check('default', { now: T + 86_400_001, isCold: true }).ok).toBe(true)
  })
})
