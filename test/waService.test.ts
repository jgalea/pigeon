import { describe, it, expect } from 'vitest'
import { WaService } from '../src/core/waService.js'
import { summarizeGroup } from '../src/core/groups.js'

const parent = { id: 'c@g.us', subject: 'Town', desc: 'Local community', isCommunity: true }
const announce = { id: 'a@g.us', subject: 'Town', linkedParent: 'c@g.us', isCommunityAnnounce: true, announce: true, size: 900 }
const joined = { id: 'j@g.us', subject: 'Events', desc: 'Post events only', linkedParent: 'c@g.us', size: 120 }

function fakeSocket(calls: string[]) {
  return {
    groupFetchAllParticipating: async () => {
      calls.push('participating')
      return { [parent.id]: parent, [announce.id]: announce, [joined.id]: joined }
    },
    communityFetchAllParticipating: async () => {
      calls.push('communities')
      return { [parent.id]: parent }
    },
    communityFetchLinkedGroups: async (jid: string) => {
      calls.push(`linked:${jid}`)
      return {
        communityJid: 'c@g.us',
        isCommunity: jid === 'c@g.us',
        linkedGroups: [
          { id: 'a@g.us', subject: 'Town', size: 900 },
          { id: 'j@g.us', subject: 'Events', size: 120 },
          { id: 'open@g.us', subject: 'Services', size: 40, creation: 1700000000 },
          { id: 'closed@g.us', subject: 'Admins', size: 3 },
        ],
      }
    },
    groupMetadata: async (jid: string) => {
      calls.push(`meta:${jid}`)
      if (jid === 'open@g.us') return { id: jid, subject: 'Services', desc: 'Offer services here. No spam.' }
      throw new Error('not-authorized')
    },
  }
}

function newService(calls: string[]) {
  const sock = fakeSocket(calls)
  const sessions = { status: () => 'WORKING', socket: () => sock }
  return new WaService(sessions as never, {} as never)
}

describe('WaService communities', () => {
  it('lists only communities from the participating groups, merged with the community query', async () => {
    const calls: string[] = []
    const out = await newService(calls).communitiesList('default')
    expect(out).toHaveLength(1)
    expect(out[0]).toMatchObject({ id: 'c@g.us', name: 'Town', description: 'Local community', isCommunity: true })
    expect(calls).toEqual(['participating', 'communities'])
  })

  it('lists linked groups with membership and description where readable', async () => {
    const calls: string[] = []
    const out = await newService(calls).communityGroups('default', 'j@g.us')
    expect(out.communityId).toBe('c@g.us')
    expect(out.name).toBe('Town')
    expect(out.isMember).toBe(true)
    expect(out.groups).toEqual([
      { id: 'a@g.us', name: 'Town', description: null, isMember: true, isAnnounce: true, adminsOnlyPosting: true, memberCount: 900, createdAt: null },
      { id: 'j@g.us', name: 'Events', description: 'Post events only', isMember: true, isAnnounce: false, adminsOnlyPosting: false, memberCount: 120, createdAt: null },
      { id: 'open@g.us', name: 'Services', description: 'Offer services here. No spam.', isMember: false, isAnnounce: false, adminsOnlyPosting: false, memberCount: 40, createdAt: 1700000000 },
      { id: 'closed@g.us', name: 'Admins', description: null, isMember: false, isAnnounce: false, adminsOnlyPosting: false, memberCount: 3, createdAt: null },
    ])
    // metadata is only fetched for groups not already in the participating list
    expect(calls.filter((c) => c.startsWith('meta:'))).toEqual(['meta:open@g.us', 'meta:closed@g.us'])
  })

  it('refuses when the session is not WORKING', async () => {
    const sessions = { status: () => 'STARTING', socket: () => undefined }
    const svc = new WaService(sessions as never, {} as never)
    await expect(svc.communitiesList('default')).rejects.toThrow('not WORKING')
  })
})

describe('summarizeGroup', () => {
  it('trims metadata to the posting-relevant fields', () => {
    const out = summarizeGroup({
      id: 'g@g.us',
      subject: 'Traders',
      desc: '  Rules: be nice  ',
      announce: true,
      restrict: false,
      joinApprovalMode: true,
      linkedParent: 'c@g.us',
      owner: '1@lid',
      ownerPn: '34600000001@s.whatsapp.net',
      creation: 1700000000,
      participants: [
        { id: '1@lid', phoneNumber: '34600000001@s.whatsapp.net', admin: 'superadmin' },
        { id: '2@lid', admin: 'admin' },
        { id: '3@lid', admin: null },
      ],
    })
    expect(out).toEqual({
      id: 'g@g.us',
      name: 'Traders',
      description: 'Rules: be nice',
      isCommunity: false,
      isCommunityAnnounce: false,
      communityId: 'c@g.us',
      adminsOnlyPosting: true,
      adminsOnlySettings: false,
      joinApprovalRequired: true,
      memberCount: 3,
      admins: ['34600000001@s.whatsapp.net', '2@lid'],
      owner: '34600000001@s.whatsapp.net',
      createdAt: 1700000000,
    })
  })

  it('nulls an empty description and unknown counts', () => {
    const out = summarizeGroup({ id: 'g@g.us', subject: 'X', desc: '' })
    expect(out.description).toBeNull()
    expect(out.memberCount).toBeNull()
    expect(out.admins).toEqual([])
  })
})
