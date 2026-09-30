// Trim Baileys group metadata down to what a caller deciding whether and how
// to post needs: the description (where posting rules usually live), who may
// post, and how the group sits inside a community.

export interface GroupSummary {
  id: string
  name: string
  description: string | null
  isCommunity: boolean
  isCommunityAnnounce: boolean
  communityId: string | null
  adminsOnlyPosting: boolean
  adminsOnlySettings: boolean
  joinApprovalRequired: boolean
  memberCount: number | null
  admins: string[]
  owner: string | null
  createdAt: number | null
}

interface RawMeta {
  id: string
  subject?: string
  desc?: string
  isCommunity?: boolean
  isCommunityAnnounce?: boolean
  linkedParent?: string
  announce?: boolean
  restrict?: boolean
  joinApprovalMode?: boolean
  size?: number
  owner?: string
  ownerPn?: string
  creation?: number
  participants?: Array<{ id: string; phoneNumber?: string; admin?: string | null }>
}

export function summarizeGroup(meta: unknown): GroupSummary {
  const m = meta as RawMeta
  const participants = m.participants ?? []
  return {
    id: m.id,
    name: m.subject ?? '',
    description: m.desc?.trim() || null,
    isCommunity: !!m.isCommunity,
    isCommunityAnnounce: !!m.isCommunityAnnounce,
    communityId: m.linkedParent ?? null,
    adminsOnlyPosting: !!m.announce,
    adminsOnlySettings: !!m.restrict,
    joinApprovalRequired: !!m.joinApprovalMode,
    memberCount: m.size ?? (participants.length || null),
    admins: participants.filter((p) => p.admin).map((p) => p.phoneNumber ?? p.id),
    owner: m.ownerPn ?? m.owner ?? null,
    createdAt: m.creation ?? null,
  }
}
