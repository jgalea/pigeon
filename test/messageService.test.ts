import { describe, it, expect, vi } from 'vitest'
import { MessageService } from '../src/core/messageService.js'

function deps(status = 'WORKING') {
  const sock = { sendMessage: vi.fn(async () => ({ key: { id: 'OUT1' } })), readMessages: vi.fn() }
  const sessions = { socket: () => sock, status: () => status } as never
  const media = { resolveOutgoing: async () => Buffer.from('x') } as never
  const history = { save: vi.fn() } as never
  return { sock, svc: new MessageService(sessions, history, media) }
}

describe('MessageService', () => {
  it('sends text and returns id', async () => {
    const { sock, svc } = deps()
    const r = await svc.send('default', { chatId: 'a@c.us', type: 'text', text: 'hi' })
    expect(sock.sendMessage).toHaveBeenCalledWith('a@c.us', { text: 'hi' })
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
})
