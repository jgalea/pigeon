import { describe, it, expect } from 'vitest'
import { contentType, describeSystemEvent, presentMessage } from '../src/core/systemEvents.js'
import type { NormalizedMessage } from '../src/core/types.js'

const stub = (messageStubType: string | number, messageStubParameters: string[] = []) => ({
  key: { remoteJid: 'g@g.us', id: '1', fromMe: false },
  messageStubType,
  messageStubParameters,
})

describe('describeSystemEvent', () => {
  it('labels participant events with the JID from JSON-encoded parameters', () => {
    expect(describeSystemEvent(stub('GROUP_PARTICIPANT_ADD', ['{"id":"123@lid","admin":null}']))).toBe('added: 123@lid')
    expect(describeSystemEvent(stub('GROUP_PARTICIPANT_LEAVE', ['{"id":"123@lid","admin":null}']))).toBe('left: 123@lid')
    expect(describeSystemEvent(stub('GROUP_PARTICIPANT_REMOVE', ['456@s.whatsapp.net']))).toBe('removed: 456@s.whatsapp.net')
    expect(describeSystemEvent(stub('GROUP_PARTICIPANT_INVITE', []))).toBe('joined via invite link: someone')
  })

  it('labels group lifecycle and setting changes', () => {
    expect(describeSystemEvent(stub('GROUP_CREATE'))).toBe('group created')
    expect(describeSystemEvent(stub('GROUP_CHANGE_SUBJECT', ['NextGenHub', '']))).toBe('subject changed to: NextGenHub')
    expect(describeSystemEvent(stub('COMMUNITY_LINK_SUB_GROUP', ['120@g.us', 'Brunch Club']))).toBe(
      'group linked to community: Brunch Club',
    )
    expect(describeSystemEvent(stub('REVOKE'))).toBe('message deleted')
    expect(describeSystemEvent(stub('ADMIN_REVOKE'))).toBe('message deleted by admin')
  })

  it('accepts numeric stub types', () => {
    expect(describeSystemEvent(stub(2))).toBe('message could not be decrypted')
    expect(describeSystemEvent(stub(20))).toBe('group created')
  })

  it('falls back to a readable name for unmapped stub types', () => {
    expect(describeSystemEvent(stub('BIZ_PRIVACY_MODE_TO_FB'))).toBe('biz privacy mode to fb')
  })

  it('treats UNKNOWN / 0 as not a system event', () => {
    expect(describeSystemEvent({ messageStubType: 0, message: { conversation: 'hi' } })).toBeUndefined()
    expect(describeSystemEvent({ messageStubType: 'UNKNOWN', message: { conversation: 'hi' } })).toBeUndefined()
  })

  it('labels protocol messages', () => {
    expect(describeSystemEvent({ message: { protocolMessage: { type: 'REVOKE', key: {} } } })).toBe('message deleted')
    expect(
      describeSystemEvent({
        message: { protocolMessage: { type: 'MESSAGE_EDIT', editedMessage: { conversation: 'fixed typo' } } },
      }),
    ).toBe('message edited: fixed typo')
    expect(describeSystemEvent({ message: { protocolMessage: { type: 'GROUP_MEMBER_LABEL_CHANGE' } } })).toBe(
      'member label changed',
    )
    expect(describeSystemEvent({ message: { protocolMessage: { type: 'HISTORY_SYNC_NOTIFICATION' } } })).toBe(
      'sync: history sync notification',
    )
  })

  it('sees through the sender-key wrapper to a protocol message', () => {
    expect(
      describeSystemEvent({
        message: { senderKeyDistributionMessage: {}, protocolMessage: { type: 'REVOKE' } },
      }),
    ).toBe('message deleted')
  })

  it('leaves real messages alone', () => {
    expect(describeSystemEvent({ message: { conversation: 'hi' } })).toBeUndefined()
    expect(describeSystemEvent({ message: { senderKeyDistributionMessage: {}, imageMessage: {} } })).toBeUndefined()
    expect(describeSystemEvent({})).toBeUndefined()
  })
})

describe('contentType', () => {
  it('skips wrapper envelopes', () => {
    expect(contentType({ senderKeyDistributionMessage: {}, messageContextInfo: {}, conversation: 'x' })).toBe(
      'conversation',
    )
    expect(contentType({ messageContextInfo: {}, extendedTextMessage: { text: 'x' } })).toBe('extendedTextMessage')
    expect(contentType({ senderKeyDistributionMessage: {} })).toBe('senderKeyDistributionMessage')
    expect(contentType({})).toBe('unknown')
    expect(contentType(undefined)).toBe('unknown')
  })
})

describe('presentMessage', () => {
  const base: NormalizedMessage = {
    session: 'default',
    chatId: 'g@g.us',
    msgId: '1',
    fromMe: false,
    timestamp: 1,
    type: 'unknown',
    raw: {},
  }

  it('relabels a stored stub row as a system event', () => {
    const m = presentMessage({ ...base, raw: stub('GROUP_PARTICIPANT_ADD', ['{"id":"9@lid"}']) })
    expect(m.type).toBe('system')
    expect(m.body).toBe('added: 9@lid')
  })

  it('fixes wrapper-typed rows without touching the body', () => {
    const m = presentMessage({
      ...base,
      type: 'senderKeyDistributionMessage',
      body: 'hello',
      raw: { message: { senderKeyDistributionMessage: {}, conversation: 'hello' } },
    })
    expect(m.type).toBe('conversation')
    expect(m.body).toBe('hello')
  })

  it('returns rows with no message content unchanged', () => {
    const m = { ...base, type: 'text', body: 'hi' }
    expect(presentMessage(m)).toBe(m)
  })
})
