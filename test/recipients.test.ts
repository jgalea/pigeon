import { describe, it, expect } from 'vitest'
import { parseRecipient } from '../src/core/recipients.js'

describe('parseRecipient', () => {
  it('normalises one phone number', () => {
    expect(parseRecipient('34600111222')).toBe('34600111222')
    expect(parseRecipient('+34 600 111 222')).toBe('34600111222')
    expect(parseRecipient('(34) 600-111.222')).toBe('34600111222')
  })

  it('passes person and group JIDs through unchanged', () => {
    for (const jid of ['34600111222@s.whatsapp.net', '111@lid', '120363001@g.us', '34600-1700000000@g.us']) {
      expect(parseRecipient(jid)).toBe(jid)
    }
  })

  it('refuses newsletters, broadcast, @c.us and malformed JIDs', () => {
    for (const bad of ['123@newsletter', 'status@broadcast', '34600111222@c.us', 'a@s.whatsapp.net', '@g.us', '1@2@g.us']) {
      expect(() => parseRecipient(bad), bad).toThrow(/unsupported JID/)
    }
  })

  it('refuses several numbers in one string instead of merging them', () => {
    for (const bad of [
      '34600111222, 34600111333',
      '34600111222;34600111333',
      '34600111222/34600111333',
      '34600111222 or 34600111333',
      '34600111222 OR 34600111333',
      '34600111222@s.whatsapp.net,111@lid',
    ]) {
      expect(() => parseRecipient(bad), bad).toThrow(/not several/)
    }
  })

  it('refuses text, empty and absurd lengths', () => {
    for (const bad of ['', '   ', 'hello', '1234', '123456789012345678901', 'abc34600111222']) {
      expect(() => parseRecipient(bad), JSON.stringify(bad)).toThrow()
    }
  })

  it('enforces the requested kind', () => {
    expect(parseRecipient('120363001@g.us', 'group')).toBe('120363001@g.us')
    expect(() => parseRecipient('34600111222', 'group')).toThrow(/group id/)
    expect(parseRecipient('34600111222', 'person')).toBe('34600111222')
    expect(() => parseRecipient('120363001@g.us', 'person')).toThrow(/person/)
    expect(parseRecipient('34600111222', 'phone')).toBe('34600111222')
    expect(() => parseRecipient('34600111222@s.whatsapp.net', 'phone')).toThrow(/bare phone/)
  })
})
