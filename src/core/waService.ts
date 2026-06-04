import type { SessionManager } from './sessionManager.js'
import type { MediaService } from './mediaService.js'
import type { PresenceType } from './types.js'

type ParticipantAction = 'add' | 'remove' | 'promote' | 'demote'
type GroupSetting = 'announcement' | 'not_announcement' | 'locked' | 'unlocked'

const toJid = (idOrPhone: string) =>
  idOrPhone.includes('@') ? idOrPhone : `${idOrPhone.replace(/[^0-9]/g, '')}@s.whatsapp.net`

export class WaService {
  constructor(
    private sessions: SessionManager,
    private media: MediaService,
  ) {}

  private sock(session: string) {
    if (this.sessions.status(session) !== 'WORKING') throw new Error(`session ${session} not WORKING`)
    const s = this.sessions.socket(session)
    if (!s) throw new Error(`session ${session} has no socket`)
    return s as unknown as Record<string, (...args: never[]) => Promise<unknown>>
  }

  // --- presence ---
  async setPresence(session: string, type: PresenceType, chatId?: string) {
    await this.sock(session).sendPresenceUpdate(type as never, chatId as never)
    return { success: true }
  }
  async subscribePresence(session: string, chatId: string) {
    await this.sock(session).presenceSubscribe(chatId as never)
    return { success: true }
  }

  // --- contacts ---
  async checkExists(session: string, phone: string) {
    const res = (await this.sock(session).onWhatsApp(toJid(phone) as never)) as
      | Array<{ exists?: boolean; jid?: string }>
      | undefined
    const hit = res?.[0]
    return { numberExists: !!hit?.exists, chatId: hit?.jid }
  }
  async profilePicture(session: string, chatId: string) {
    try {
      const url = (await this.sock(session).profilePictureUrl(toJid(chatId) as never, 'image' as never)) as
        | string
        | undefined
      return { url: url ?? null }
    } catch {
      return { url: null }
    }
  }
  async setBlocked(session: string, chatId: string, blocked: boolean) {
    await this.sock(session).updateBlockStatus(toJid(chatId) as never, (blocked ? 'block' : 'unblock') as never)
    return { success: true }
  }

  // --- profile (own account) ---
  async setProfileName(session: string, name: string) {
    await this.sock(session).updateProfileName(name as never)
    return { success: true }
  }
  async setProfileStatus(session: string, status: string) {
    await this.sock(session).updateProfileStatus(status as never)
    return { success: true }
  }
  async setProfilePicture(session: string, chatId: string, media: { data?: string; url?: string }) {
    const buf = await this.media.resolveOutgoing(media)
    await this.sock(session).updateProfilePicture(toJid(chatId) as never, buf as never)
    return { success: true }
  }

  // --- groups ---
  async groupCreate(session: string, subject: string, participants: string[]) {
    const meta = (await this.sock(session).groupCreate(
      subject as never,
      participants.map(toJid) as never,
    )) as { id?: string }
    return { id: meta?.id, metadata: meta }
  }
  async groupLeave(session: string, groupId: string) {
    await this.sock(session).groupLeave(groupId as never)
    return { success: true }
  }
  async groupMetadata(session: string, groupId: string) {
    return this.sock(session).groupMetadata(groupId as never)
  }
  async groupParticipants(session: string, groupId: string, participants: string[], action: ParticipantAction) {
    return this.sock(session).groupParticipantsUpdate(
      groupId as never,
      participants.map(toJid) as never,
      action as never,
    )
  }
  async groupUpdateSubject(session: string, groupId: string, subject: string) {
    await this.sock(session).groupUpdateSubject(groupId as never, subject as never)
    return { success: true }
  }
  async groupUpdateDescription(session: string, groupId: string, description: string) {
    await this.sock(session).groupUpdateDescription(groupId as never, description as never)
    return { success: true }
  }
  async groupInviteCode(session: string, groupId: string) {
    const code = (await this.sock(session).groupInviteCode(groupId as never)) as string
    return { code, link: `https://chat.whatsapp.com/${code}` }
  }
  async groupRevokeInvite(session: string, groupId: string) {
    const code = (await this.sock(session).groupRevokeInvite(groupId as never)) as string
    return { code, link: `https://chat.whatsapp.com/${code}` }
  }
  async groupAcceptInvite(session: string, code: string) {
    const id = (await this.sock(session).groupAcceptInvite(code as never)) as string
    return { id }
  }
  async groupSetting(session: string, groupId: string, setting: GroupSetting) {
    await this.sock(session).groupSettingUpdate(groupId as never, setting as never)
    return { success: true }
  }
  async groupsList(session: string) {
    const groups = (await this.sock(session).groupFetchAllParticipating()) as Record<
      string,
      { id: string; subject: string }
    >
    return Object.values(groups).map((g) => ({ id: g.id, name: g.subject }))
  }

  // --- status / stories ---
  async postStatus(
    session: string,
    o: { text?: string; media?: { data?: string; url?: string; mimetype?: string }; statusJidList?: string[] },
  ) {
    const sock = this.sock(session)
    const content = o.media
      ? { image: await this.media.resolveOutgoing(o.media), caption: o.text }
      : { text: o.text ?? '' }
    const opts = { statusJidList: (o.statusJidList ?? []).map(toJid), broadcast: true }
    const res = (await sock.sendMessage('status@broadcast' as never, content as never, opts as never)) as {
      key?: { id?: string }
    }
    return { id: res?.key?.id ?? '' }
  }

  // --- channels (newsletters) ---
  async channelCreate(session: string, name: string, description?: string) {
    return this.sock(session).newsletterCreate(name as never, { description } as never)
  }
  async channelMetadata(session: string, channelId: string) {
    return this.sock(session).newsletterMetadata('jid' as never, channelId as never)
  }
  async channelFollow(session: string, channelId: string) {
    await this.sock(session).newsletterFollow(channelId as never)
    return { success: true }
  }
  async channelUnfollow(session: string, channelId: string) {
    await this.sock(session).newsletterUnfollow(channelId as never)
    return { success: true }
  }
  async channelDelete(session: string, channelId: string) {
    await this.sock(session).newsletterDelete(channelId as never)
    return { success: true }
  }

  // --- pairing code (alternative to QR) ---
  async requestPairingCode(session: string, phone: string) {
    const code = (await this.sock(session).requestPairingCode(phone.replace(/[^0-9]/g, '') as never)) as string
    return { code }
  }
}
