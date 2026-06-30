import { describe, it, expect, vi } from 'vitest'
import { MessageService } from '../src/core/messageService.js'

function deps(status = 'WORKING') {
  const sock = { sendMessage: vi.fn(async () => ({ key: { id: 'OUT1' } })), readMessages: vi.fn() }
  const sessions = { socket: () => sock, status: () => status, connectedAt: () => undefined } as never
  const media = { resolveOutgoing: async () => Buffer.from('x') } as never
  const history = {
    save: vi.fn(),
    get: vi.fn(() => ({ raw: { key: { id: 'M1' }, message: { conversation: 'hi' } } })),
    hasInbound: () => true,
  } as never
  const guard = { check: () => ({ ok: true }), record: vi.fn() } as never
  return { sock, svc: new MessageService(sessions, history, media, guard) }
}

describe('MessageService', () => {
  it('sends text and returns id', async () => {
    const { sock, svc } = deps()
    const r = await svc.send('default', { chatId: 'a@c.us', type: 'text', text: 'hi' })
    // chatId is normalized from WAHA-style @c.us to Baileys @s.whatsapp.net
    expect(sock.sendMessage).toHaveBeenCalledWith('a@s.whatsapp.net', { text: 'hi' })
    expect(r.id).toBe('OUT1')
  })

  it('sends a file as document with filename + mimetype', async () => {
    const { sock, svc } = deps()
    await svc.send('default', {
      chatId: 'a@c.us',
      type: 'file',
      media: { data: 'BASE64', mimetype: 'application/pdf', filename: 'r.pdf' },
    })
    const arg = sock.sendMessage.mock.calls[0][1] as { document: Buffer; fileName: string; mimetype: string }
    expect(Buffer.isBuffer(arg.document)).toBe(true)
    expect(arg.fileName).toBe('r.pdf')
    expect(arg.mimetype).toBe('application/pdf')
  })

  it('sends a voice note as ptt audio', async () => {
    const { sock, svc } = deps()
    await svc.send('default', { chatId: 'a@c.us', type: 'voice', media: { data: 'B64' } })
    const arg = sock.sendMessage.mock.calls[0][1] as { ptt: boolean; mimetype: string }
    expect(arg.ptt).toBe(true)
    expect(arg.mimetype).toBe('audio/ogg; codecs=opus')
  })

  it('throws if session not WORKING', async () => {
    const { svc } = deps('STOPPED')
    await expect(svc.send('default', { chatId: 'a@c.us', type: 'text', text: 'hi' })).rejects.toThrow()
  })

  it('sends a contact as a vcard', async () => {
    const { sock, svc } = deps()
    await svc.send('default', {
      chatId: 'a@c.us',
      type: 'contact',
      contact: { fullName: 'Jeff Singh', phone: '+91 12345 67890', organization: 'Ashoka' },
    })
    const arg = sock.sendMessage.mock.calls[0][1] as { contacts: { contacts: { vcard: string }[] } }
    expect(arg.contacts.contacts[0].vcard).toContain('FN:Jeff Singh')
    expect(arg.contacts.contacts[0].vcard).toContain('waid=911234567890')
  })

  it('sends a poll', async () => {
    const { sock, svc } = deps()
    await svc.send('default', {
      chatId: 'a@c.us',
      type: 'poll',
      poll: { name: 'Best?', options: ['A', 'B'], selectableCount: 1 },
    })
    const arg = sock.sendMessage.mock.calls[0][1] as { poll: { name: string; values: string[] } }
    expect(arg.poll.name).toBe('Best?')
    expect(arg.poll.values).toEqual(['A', 'B'])
  })

  it('reacts to a message', async () => {
    const { sock, svc } = deps()
    await svc.react('default', 'a@c.us', 'M1', '👍')
    const arg = sock.sendMessage.mock.calls[0][1] as { react: { text: string; key: { id: string } } }
    expect(arg.react.text).toBe('👍')
    expect(arg.react.key.id).toBe('M1')
  })

  it('edits a message', async () => {
    const { sock, svc } = deps()
    await svc.edit('default', 'a@c.us', 'M1', 'new text')
    const arg = sock.sendMessage.mock.calls[0][1] as { text: string; edit: { id: string } }
    expect(arg.text).toBe('new text')
    expect(arg.edit.id).toBe('M1')
  })

  it('deletes a message', async () => {
    const { sock, svc } = deps()
    await svc.remove('default', 'a@c.us', 'M1')
    const arg = sock.sendMessage.mock.calls[0][1] as { delete: { id: string } }
    expect(arg.delete.id).toBe('M1')
  })

  it('forwards a stored message', async () => {
    const { sock, svc } = deps()
    const r = await svc.forward('default', 'b@c.us', 'a@c.us', 'M1')
    const arg = sock.sendMessage.mock.calls[0][1] as { forward: unknown }
    expect(arg.forward).toBeTruthy()
    expect(r.id).toBe('OUT1')
  })
})
