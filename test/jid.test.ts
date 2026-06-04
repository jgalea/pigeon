import { describe, it, expect } from 'vitest'
import { normalizeJid } from '../src/core/jid.js'

describe('normalizeJid', () => {
  it('maps @c.us to @s.whatsapp.net', () => {
    expect(normalizeJid('34670977312@c.us')).toBe('34670977312@s.whatsapp.net')
  })
  it('turns a bare number into an individual jid', () => {
    expect(normalizeJid('+34 670 977 312')).toBe('34670977312@s.whatsapp.net')
  })
  it('leaves group, newsletter, and already-correct jids untouched', () => {
    expect(normalizeJid('123-456@g.us')).toBe('123-456@g.us')
    expect(normalizeJid('123@newsletter')).toBe('123@newsletter')
    expect(normalizeJid('34670977312@s.whatsapp.net')).toBe('34670977312@s.whatsapp.net')
    expect(normalizeJid('status@broadcast')).toBe('status@broadcast')
  })
})
