import type { SessionManager } from './sessionManager.js'
import type { MediaService } from './mediaService.js'
import type { SendGuard } from './sendGuard.js'
import type { PresenceType } from './types.js'
import { normalizeJid as toJid } from './jid.js'
import { summarizeGroup, type GroupSummary } from './groups.js'

type ParticipantAction = 'add' | 'remove' | 'promote' | 'demote'
type GroupSetting = 'announcement' | 'not_announcement' | 'locked' | 'unlocked'

interface RawGroup {
  id: string
  subject?: string
  desc?: string
  isCommunity?: boolean
  isCommunityAnnounce?: boolean
  announce?: boolean
  size?: number
  creation?: number
}

export interface CommunityGroup {
  id: string
  name: string
  description: string | null
  isMember: boolean
  isAnnounce: boolean
  adminsOnlyPosting: boolean
  memberCount: number | null
  createdAt: number | null
}

export interface CommunityGroups {
  communityId: string
  name: string
  description: string | null
  isMember: boolean
  groups: CommunityGroup[]
}

export class WaService {
  constructor(
    private sessions: SessionManager,
    private media: MediaService,
    private guard?: SendGuard,
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
  // Resolve every JID a person uses: their real number (@s.whatsapp.net) and
  // any privacy-masked @lid, using Baileys' LID mapping store. WhatsApp can
  // split one person's messages across both, so callers should read all of them.
  async linkedJids(session: string, chatId: string): Promise<{ jids: string[] }> {
    const jid = toJid(chatId)
    const stripDevice = (j: string) => j.replace(/:\d+@/, '@')
    const out = new Set<string>([stripDevice(jid)])
    const sock = this.sock(session) as unknown as {
      signalRepository?: {
        lidMapping?: {
          getLIDForPN?(pn: string): Promise<string | null>
          getPNForLID?(lid: string): Promise<string | null>
        }
      }
    }
    const lidMapping = sock?.signalRepository?.lidMapping
    try {
      if (jid.endsWith('@lid')) {
        const pn = await lidMapping?.getPNForLID?.(jid)
        if (pn) out.add(stripDevice(pn))
      } else {
        const lid = await lidMapping?.getLIDForPN?.(jid)
        if (lid) out.add(stripDevice(lid))
      }
    } catch {
      // mapping unavailable (not synced yet) — just return what we have
    }
    return { jids: [...out] }
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

  // Group creation and member adds go through the same hourly cap as cold
  // sends do, since both put this number in front of people who never wrote
  // to it.
  private guardParticipants(session: string, jids: string[]) {
    if (!this.guard) return
    const now = Date.now()
    const verdict = this.guard.checkParticipants(session, jids, now)
    if (!verdict.ok) throw new Error(`blocked by anti-spam guard: ${verdict.reason}`)
    this.guard.recordParticipants(session, jids, now)
  }

  // --- groups ---
  async groupCreate(session: string, subject: string, participants: string[]) {
    const sock = this.sock(session)
    const jids = participants.map(toJid)
    this.guardParticipants(session, jids)
    const meta = (await sock.groupCreate(subject as never, jids as never)) as { id?: string }
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
    const sock = this.sock(session)
    const jids = participants.map(toJid)
    if (action === 'add') this.guardParticipants(session, jids)
    return sock.groupParticipantsUpdate(groupId as never, jids as never, action as never)
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
  async groupJoinApproval(session: string, groupId: string, mode: 'on' | 'off') {
    await this.sock(session).groupJoinApprovalMode(groupId as never, mode as never)
    return { success: true }
  }
  async groupRequests(session: string, groupId: string) {
    return this.sock(session).groupRequestParticipantsList(groupId as never)
  }
  async groupRequestsUpdate(session: string, groupId: string, participants: string[], action: 'approve' | 'reject') {
    return this.sock(session).groupRequestParticipantsUpdate(
      groupId as never,
      participants.map(toJid) as never,
      action as never,
    )
  }
  async groupsList(session: string) {
    const groups = (await this.sock(session).groupFetchAllParticipating()) as Record<
      string,
      { id: string; subject: string }
    >
    return Object.values(groups).map((g) => ({ id: g.id, name: g.subject }))
  }

  // --- communities (read-only) ---
  // Communities you belong to. The parent shows up in the participating list
  // flagged isCommunity; the community-specific query is merged in as a
  // fallback since it has been less exercised in Baileys.
  async communitiesList(session: string): Promise<GroupSummary[]> {
    const sock = this.sock(session)
    const all = (await sock.groupFetchAllParticipating()) as Record<string, RawGroup>
    const found = new Map<string, RawGroup>()
    for (const g of Object.values(all)) if (g.isCommunity) found.set(g.id, g)
    try {
      const extra = (await sock.communityFetchAllParticipating()) as Record<string, RawGroup>
      for (const g of Object.values(extra)) if (!found.has(g.id)) found.set(g.id, g)
    } catch {
      // participating-groups query already answered; the community query is optional
    }
    return [...found.values()].map(summarizeGroup)
  }

  // Every group linked to a community, including ones you haven't joined.
  // Accepts the community id or any of its subgroups. Description is only
  // available where WhatsApp lets us read the group's metadata (member groups
  // and open subgroups); otherwise it is null.
  async communityGroups(session: string, jid: string): Promise<CommunityGroups> {
    const sock = this.sock(session)
    const linked = (await sock.communityFetchLinkedGroups(jid as never)) as {
      communityJid: string
      linkedGroups: Array<{ id?: string; subject: string; creation?: number; size?: number }>
    }
    const mine = (await sock.groupFetchAllParticipating()) as Record<string, RawGroup>
    const metaFor = async (id: string): Promise<RawGroup | undefined> => {
      if (mine[id]) return mine[id]
      try {
        return (await sock.groupMetadata(id as never)) as RawGroup
      } catch {
        return undefined
      }
    }
    const parent = await metaFor(linked.communityJid)
    const groups: CommunityGroup[] = []
    for (const g of linked.linkedGroups) {
      if (!g.id) continue
      const meta = await metaFor(g.id)
      groups.push({
        id: g.id,
        name: g.subject || meta?.subject || '',
        description: meta?.desc?.trim() || null,
        isMember: g.id in mine,
        isAnnounce: !!meta?.isCommunityAnnounce,
        adminsOnlyPosting: !!meta?.announce,
        memberCount: g.size ?? meta?.size ?? null,
        createdAt: g.creation ?? meta?.creation ?? null,
      })
    }
    return {
      communityId: linked.communityJid,
      name: parent?.subject ?? '',
      description: parent?.desc?.trim() || null,
      isMember: linked.communityJid in mine,
      groups,
    }
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
  // Not via sock(): that requires WORKING, but a pairing code is only ever
  // wanted while the session is still SCAN_QR_CODE, which made this
  // unreachable. Needs the socket to exist, not the session to be authed.
  //
  // Records the phone on the session first, so that if the socket churns
  // before the human finishes typing, the reconnect mints a fresh code
  // instead of leaving them holding one that silently stopped working.
  // Calling this again returns the current code rather than a new one.
  async requestPairingCode(session: string, phone: string) {
    const s = this.sessions.socket(session)
    if (!s) throw new Error(`session ${session} has no socket`)
    this.sessions.setPairingPhone(session, phone)
    const existing = this.sessions.pairingCode(session)
    if (existing) return { code: existing, reused: true }
    const sock = s as unknown as Record<string, (...args: never[]) => Promise<unknown>>
    const code = (await sock.requestPairingCode(phone.replace(/[^0-9]/g, '') as never)) as string
    this.sessions.setPairingCode(session, code)
    return { code, reused: false }
  }
}
