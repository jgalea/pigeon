// Recipient ids the MCP tools accept: one bare phone number, or one JID of a
// person (@s.whatsapp.net, @lid) or group (@g.us). Newsletters, the status
// broadcast and several numbers in one string are refused here, rather than
// letting normalizeJid strip the separators and squash two numbers into one.

const JID = /^\d+(?:-\d+)?@(?:s\.whatsapp\.net|lid|g\.us)$/
const SEVERAL = /[,;/]|\bor\b/i

export type RecipientKind = 'any' | 'person' | 'group' | 'phone'

export function parseRecipient(input: string, kind: RecipientKind = 'any'): string {
  const s = (input ?? '').trim()
  if (!s) throw new Error('recipient is empty')
  if (SEVERAL.test(s)) {
    throw new Error(`recipient must be one phone number or JID, not several: "${s}"`)
  }
  let id: string
  if (s.includes('@')) {
    if (!JID.test(s)) {
      throw new Error(`unsupported JID "${s}": only ...@s.whatsapp.net, ...@lid and ...@g.us are accepted`)
    }
    id = s
  } else {
    id = s.replace(/^\+/, '').replace(/[\s().-]/g, '')
    if (!/^\d{5,20}$/.test(id)) {
      throw new Error(`"${s}" is not a phone number (country code, digits, no +) or a JID`)
    }
  }
  const isGroup = id.endsWith('@g.us')
  if (kind === 'group' && !isGroup) throw new Error(`expected a group id (...@g.us), got "${s}"`)
  if (kind === 'person' && isGroup) throw new Error(`expected a person (phone number or JID), got group "${s}"`)
  if (kind === 'phone' && id.includes('@')) throw new Error(`expected a bare phone number, got "${s}"`)
  return id
}
