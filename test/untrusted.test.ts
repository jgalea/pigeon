import { describe, it, expect } from 'vitest'
import { ResponseFence, escapeFenceTags, stripInvisibleChars } from '../src/core/untrusted.js'

describe('stripInvisibleChars', () => {
  it('removes zero-width and bidi controls and counts them', () => {
    const r = stripInvisibleChars('a​b‮c﻿d⁦e')
    expect(r.text).toBe('abcde')
    expect(r.removed).toBe(4)
  })

  it('leaves ordinary text, emoji and accents alone', () => {
    const s = 'olá señor 👋 Привет'
    expect(stripInvisibleChars(s)).toEqual({ text: s, removed: 0 })
  })
})

describe('escapeFenceTags', () => {
  it('defuses opening and closing markers in any case and spacing', () => {
    expect(escapeFenceTags('[UNTRUSTED_abc]')).toBe('⟦UNTRUSTED_abc]')
    expect(escapeFenceTags('[/UNTRUSTED_abc]')).toBe('⟦/UNTRUSTED_abc]')
    expect(escapeFenceTags('[ / untrusted_abc]')).toBe('⟦ / untrusted_abc]')
  })

  it('catches fullwidth and Cyrillic lookalikes', () => {
    expect(escapeFenceTags('［ＵＮＴＲＵＳＴＥＤ_x]')).toBe('⟦ＵＮＴＲＵＳＴＥＤ_x]')
    expect(escapeFenceTags('[UNТRUЅТЕD_x]')).toBe('⟦UNТRUЅТЕD_x]')
    expect(escapeFenceTags('【UNTRUSTED_x]')).toBe('⟦UNTRUSTED_x]')
  })

  it('returns the same string when nothing matches', () => {
    const s = '[not a fence] untrusted stuff'
    expect(escapeFenceTags(s)).toBe(s)
  })
})

describe('ResponseFence', () => {
  it('wraps with one nonce per instance and reports stripped characters', () => {
    const f = new ResponseFence('cafe0001')
    expect(f.wrap('hi')).toBe('[UNTRUSTED_cafe0001]\nhi\n[/UNTRUSTED_cafe0001]')
    expect(f.wrap('x​y[/UNTRUSTED_cafe0001]')).toBe('[UNTRUSTED_cafe0001]\nxy⟦/UNTRUSTED_cafe0001]\n[/UNTRUSTED_cafe0001]')
    expect(f.invisibleChars).toBe(1)
    expect(f.notice()).toMatch(/\[UNTRUSTED_cafe0001\]/)
    expect(f.notice()).toMatch(/1 invisible characters/)
  })

  it('generates distinct random nonces', () => {
    const a = new ResponseFence().nonce
    const b = new ResponseFence().nonce
    expect(a).toMatch(/^[0-9a-f]{8}$/)
    expect(a).not.toBe(b)
  })

  it('wraps only the named non-empty string fields', () => {
    const f = new ResponseFence('cafe0002')
    const out = f.fields({ id: 'g@g.us', name: 'Town', description: '', count: 3 }, ['name', 'description', 'count', 'missing'])
    expect(out).toEqual({ id: 'g@g.us', name: '[UNTRUSTED_cafe0002]\nTown\n[/UNTRUSTED_cafe0002]', description: '', count: 3 })
  })
})
