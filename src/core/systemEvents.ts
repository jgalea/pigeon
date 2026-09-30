import { WAMessageStubType } from '@whiskeysockets/baileys'
import type { NormalizedMessage } from './types.js'

// Baileys wraps group messages with key-distribution and context envelopes
// before the real content, so "first key of message" is the wrong type for
// them. Skip these when deciding what a message is.
const WRAPPER_KEYS = new Set(['senderKeyDistributionMessage', 'messageContextInfo'])

const STUB_NAME_BY_NUMBER = new Map<number, string>(
  Object.entries(WAMessageStubType).map(([name, n]) => [n as number, name]),
)

export const SYSTEM_TYPE = 'system'

type Raw = {
  messageStubType?: string | number
  messageStubParameters?: string[]
  message?: Record<string, unknown>
}

// What a message is, ignoring wrapper envelopes. Falls back to the wrapper
// name only when nothing else is inside.
export function contentType(content: Record<string, unknown> | undefined): string {
  const keys = Object.keys(content ?? {})
  return keys.find((k) => !WRAPPER_KEYS.has(k)) ?? keys[0] ?? 'unknown'
}

// Stub parameters are either a plain JID / string, or a JSON-encoded
// participant object like {"id":"123@lid","admin":null}.
function stubParam(p: string): string {
  if (p.startsWith('{')) {
    try {
      const o = JSON.parse(p) as { id?: string }
      if (o.id) return o.id
    } catch {
      // not JSON; use as-is
    }
  }
  return p
}

function who(params: string[]): string {
  const names = params.map(stubParam).filter(Boolean)
  return names.length ? names.join(', ') : 'someone'
}

function stubLabel(name: string, params: string[]): string {
  switch (name) {
    case 'GROUP_PARTICIPANT_ADD':
      return `added: ${who(params)}`
    case 'GROUP_PARTICIPANT_INVITE':
      return `joined via invite link: ${who(params)}`
    case 'GROUP_PARTICIPANT_LINKED_GROUP_JOIN':
      return `joined from the community: ${who(params)}`
    case 'GROUP_PARTICIPANT_ADD_REQUEST_JOIN':
    case 'GROUP_MEMBERSHIP_JOIN_APPROVAL_REQUEST_NON_ADMIN_ADD':
      return `join request: ${who(params)}`
    case 'GROUP_PARTICIPANT_LEAVE':
      return `left: ${who(params)}`
    case 'GROUP_PARTICIPANT_REMOVE':
      return `removed: ${who(params)}`
    case 'GROUP_PARTICIPANT_PROMOTE':
    case 'COMMUNITY_PARTICIPANT_PROMOTE':
      return `promoted to admin: ${who(params)}`
    case 'GROUP_PARTICIPANT_DEMOTE':
      return `demoted from admin: ${who(params)}`
    case 'GROUP_PARTICIPANT_CHANGE_NUMBER':
    case 'INDIVIDUAL_CHANGE_NUMBER':
      return `changed number: ${who(params)}`
    case 'REVOKE':
      return 'message deleted'
    case 'ADMIN_REVOKE':
      return 'message deleted by admin'
    case 'GROUP_CREATE':
      return 'group created'
    case 'COMMUNITY_CREATE':
      return 'community created'
    case 'GROUP_CHANGE_SUBJECT':
    case 'COMMUNITY_PARENT_GROUP_SUBJECT_CHANGED':
      return params[0] ? `subject changed to: ${params[0]}` : 'subject changed'
    case 'GROUP_CHANGE_DESCRIPTION':
    case 'COMMUNITY_CHANGE_DESCRIPTION':
      return 'description changed'
    case 'GROUP_CHANGE_ICON':
      return 'icon changed'
    case 'GROUP_CHANGE_INVITE_LINK':
      return 'invite link reset'
    case 'GROUP_CHANGE_RESTRICT':
      return 'group settings edit permission changed'
    case 'GROUP_CHANGE_ANNOUNCE':
      return 'group posting permission changed'
    case 'GROUP_MEMBER_ADD_MODE':
      return 'member add permission changed'
    case 'GROUP_MEMBERSHIP_JOIN_APPROVAL_MODE':
      return 'join approval setting changed'
    case 'CHANGE_EPHEMERAL_SETTING':
    case 'DISAPPEARING_MODE':
      return 'disappearing messages setting changed'
    case 'PINNED_MESSAGE_IN_CHAT':
      return 'message pinned'
    case 'COMMUNITY_LINK_SUB_GROUP':
    case 'COMMUNITY_LINK_SIBLING_GROUP':
      return params[1] ? `group linked to community: ${params[1]}` : 'group linked to community'
    case 'COMMUNITY_UNLINK_SUB_GROUP':
    case 'COMMUNITY_UNLINK_SIBLING_GROUP':
      return params[1] ? `group unlinked from community: ${params[1]}` : 'group unlinked from community'
    case 'E2E_ENCRYPTED':
    case 'E2E_ENCRYPTED_NOW':
      return 'messages are end-to-end encrypted'
    case 'E2E_IDENTITY_CHANGED':
    case 'E2E_DEVICE_CHANGED':
      return 'security code changed'
    case 'CIPHERTEXT':
      return 'message could not be decrypted'
    case 'FUTUREPROOF':
      return 'unsupported message type'
    case 'CALL_MISSED_VOICE':
    case 'CALL_MISSED_GROUP_VOICE':
      return 'missed voice call'
    case 'CALL_MISSED_VIDEO':
    case 'CALL_MISSED_GROUP_VIDEO':
      return 'missed video call'
    case 'BLOCK_CONTACT':
      return 'contact block status changed'
    default: {
      const text = name.toLowerCase().replace(/_/g, ' ')
      const extra = params.map(stubParam).filter(Boolean).join(', ')
      return extra ? `${text}: ${extra}` : text
    }
  }
}

function protocolLabel(p: Record<string, unknown>): string {
  const type = String(p.type ?? '')
  switch (type) {
    case 'REVOKE':
      return 'message deleted'
    case 'MESSAGE_EDIT': {
      const edited = p.editedMessage as { conversation?: string; extendedTextMessage?: { text?: string } } | undefined
      const text = edited?.conversation ?? edited?.extendedTextMessage?.text
      return text ? `message edited: ${text}` : 'message edited'
    }
    case 'EPHEMERAL_SETTING':
      return 'disappearing messages setting changed'
    case 'GROUP_MEMBER_LABEL_CHANGE':
      return 'member label changed'
    default:
      return type ? `sync: ${type.toLowerCase().replace(/_/g, ' ')}` : 'protocol message'
  }
}

// A stub or protocol event WhatsApp shows as a grey system line, or nothing
// at all. Returns the human-readable line, or undefined for a real message.
export function describeSystemEvent(raw: unknown): string | undefined {
  const r = (raw ?? {}) as Raw
  const stub = r.messageStubType
  if (stub !== undefined && stub !== null && stub !== 0 && stub !== 'UNKNOWN') {
    const name = typeof stub === 'number' ? (STUB_NAME_BY_NUMBER.get(stub) ?? `stub ${stub}`) : String(stub)
    return stubLabel(name, r.messageStubParameters ?? [])
  }
  const content = r.message ?? {}
  const type = contentType(content)
  if (type === 'protocolMessage') return protocolLabel((content.protocolMessage ?? {}) as Record<string, unknown>)
  if (type === 'senderKeyDistributionMessage') return 'encryption keys shared'
  return undefined
}

// Re-derive type and body from raw so rows stored before this classification
// existed read the same as new ones. Nothing is written back.
export function presentMessage(m: NormalizedMessage): NormalizedMessage {
  const system = describeSystemEvent(m.raw)
  if (system !== undefined) return { ...m, type: SYSTEM_TYPE, body: system }
  const content = (m.raw as Raw | undefined)?.message
  if (!content || typeof content !== 'object') return m
  const type = contentType(content)
  return type === m.type ? m : { ...m, type }
}

export function isSystem(m: Pick<NormalizedMessage, 'type'>): boolean {
  return m.type === SYSTEM_TYPE
}
