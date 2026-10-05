import { describe, it, expect } from 'vitest'
import { SendGuard } from '../src/core/sendGuard.js'
import { WaService } from '../src/core/waService.js'
import type { SendGuardConfig } from '../src/config.js'

const cfg = (over: Partial<SendGuardConfig> = {}): SendGuardConfig => ({
  enabled: true,
  postConnectCooldownMs: 0,
  coldMinGapMs: 0,
  coldMaxPerHour: 5,
  coldMaxPerDay: 20,
  participantsMaxPerHour: 3,
  ...over,
})

const T = 1_000_000_000_000
const HOUR = 3_600_000
const n = (i: number) => `3460000000${i}@s.whatsapp.net`

describe('SendGuard.checkParticipants', () => {
  it('caps distinct numbers added per rolling hour', () => {
    const g = new SendGuard(cfg())
    expect(g.checkParticipants('default', [n(1), n(2)], T).ok).toBe(true)
    g.recordParticipants('default', [n(1), n(2)], T)
    expect(g.checkParticipants('default', [n(3)], T + 1).ok).toBe(true)
    g.recordParticipants('default', [n(3)], T + 1)
    const v = g.checkParticipants('default', [n(4)], T + 2)
    expect(v.ok).toBe(false)
    expect(v.reason).toMatch(/hourly cap of 3 people added to groups \(3 already this hour\)/)
  })

  it('does not count a number twice, counts duplicates in one call once, and blocks a single oversized batch', () => {
    const g = new SendGuard(cfg())
    g.recordParticipants('default', [n(1), n(2), n(3)], T)
    expect(g.checkParticipants('default', [n(1), n(2)], T + 1).ok).toBe(true)
    expect(g.checkParticipants('default', [n(4), n(4)], T + 1).ok).toBe(false)
    expect(new SendGuard(cfg()).checkParticipants('default', [n(1), n(2), n(3), n(4)], T).ok).toBe(false)
    expect(new SendGuard(cfg()).checkParticipants('default', [n(1), n(1), n(1), n(1)], T).ok).toBe(true)
  })

  it('forgets adds older than an hour and keeps sessions apart', () => {
    const g = new SendGuard(cfg())
    g.recordParticipants('default', [n(1), n(2), n(3)], T)
    expect(g.checkParticipants('default', [n(4)], T + HOUR - 1).ok).toBe(false)
    expect(g.checkParticipants('default', [n(4)], T + HOUR).ok).toBe(true)
    expect(g.checkParticipants('other', [n(4), n(5), n(6)], T + 1).ok).toBe(true)
  })

  it('passes everything when the guard is off', () => {
    const g = new SendGuard(cfg({ enabled: false }))
    expect(g.checkParticipants('default', [n(1), n(2), n(3), n(4), n(5)], T).ok).toBe(true)
  })
})

describe('WaService group membership goes through the guard', () => {
  function service(guard?: SendGuard) {
    const calls: Array<{ fn: string; args: unknown[] }> = []
    const sock = {
      groupCreate: async (...args: unknown[]) => {
        calls.push({ fn: 'groupCreate', args })
        return { id: 'new@g.us' }
      },
      groupParticipantsUpdate: async (...args: unknown[]) => {
        calls.push({ fn: 'groupParticipantsUpdate', args })
        return [{ status: '200' }]
      },
    }
    const sessions = { status: () => 'WORKING', socket: () => sock }
    return { svc: new WaService(sessions as never, {} as never, guard), calls }
  }

  it('blocks a group creation that would pass the cap before touching the socket', async () => {
    const { svc, calls } = service(new SendGuard(cfg()))
    await expect(svc.groupCreate('default', 'Big', ['34600000001', '34600000002', '34600000003', '34600000004'])).rejects.toThrow(
      /blocked by anti-spam guard/,
    )
    expect(calls).toEqual([])
    await expect(svc.groupCreate('default', 'Small', ['34600000001', '34600000002'])).resolves.toMatchObject({ id: 'new@g.us' })
    expect(calls[0]).toEqual({ fn: 'groupCreate', args: ['Small', [n(1), n(2)]] })
  })

  it('counts creates and adds together, and only gates the add action', async () => {
    const { svc, calls } = service(new SendGuard(cfg()))
    await svc.groupCreate('default', 'A', ['34600000001', '34600000002'])
    await expect(svc.groupParticipants('default', 'g@g.us', ['34600000003', '34600000004'], 'add')).rejects.toThrow(
      /blocked by anti-spam guard/,
    )
    await expect(svc.groupParticipants('default', 'g@g.us', ['34600000003'], 'add')).resolves.toBeTruthy()
    await expect(svc.groupParticipants('default', 'g@g.us', ['34600000005', '34600000006'], 'remove')).resolves.toBeTruthy()
    await expect(svc.groupParticipants('default', 'g@g.us', ['34600000007'], 'promote')).resolves.toBeTruthy()
    expect(calls.map((c) => c.fn)).toEqual(['groupCreate', 'groupParticipantsUpdate', 'groupParticipantsUpdate', 'groupParticipantsUpdate'])
  })

  it('runs unguarded when no guard is wired in', async () => {
    const { svc, calls } = service()
    await svc.groupCreate('default', 'Big', ['1', '2', '3', '4', '5', '6'].map((d) => `3460000000${d}`))
    expect(calls).toHaveLength(1)
  })
})
