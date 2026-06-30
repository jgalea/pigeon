#!/usr/bin/env node

import { readFileSync } from 'node:fs'
import { basename, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'

export interface McpConfig {
  url: string
  apiKey: string
  session: string
  readOnly?: boolean
}

function envFlag(value: string | undefined): boolean {
  const v = (value ?? '').trim().toLowerCase()
  return v === '1' || v === 'true' || v === 'yes' || v === 'on'
}

function readEnvFile(): Record<string, string> {
  const out: Record<string, string> = {}
  try {
    const path = resolve(dirname(fileURLToPath(import.meta.url)), '..', '.env')
    for (const line of readFileSync(path, 'utf8').split('\n')) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/)
      if (m) out[m[1]] = m[2].replace(/^["']|["']$/g, '')
    }
  } catch {
    // no .env file; rely on process env
  }
  return out
}

export function loadMcpConfig(env = process.env): McpConfig {
  const fileEnv = readEnvFile()
  const apiKey = env.WA_API_KEY ?? fileEnv.WA_API_KEY
  if (!apiKey) throw new Error('WA_API_KEY is required (set in env or in .env next to package.json)')
  return {
    url: (env.WA_API_URL ?? fileEnv.WA_API_URL ?? 'http://127.0.0.1:4000').replace(/\/+$/, ''),
    apiKey,
    session: env.WA_SESSION ?? fileEnv.WA_SESSION ?? 'default',
    readOnly: envFlag(env.WA_MCP_READONLY ?? fileEnv.WA_MCP_READONLY),
  }
}

const MIME_BY_EXT: Record<string, string> = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  gif: 'image/gif',
  webp: 'image/webp',
  mp4: 'video/mp4',
  mp3: 'audio/mpeg',
  ogg: 'audio/ogg',
  opus: 'audio/ogg',
  m4a: 'audio/mp4',
  pdf: 'application/pdf',
}

export function buildServer(cfg: McpConfig): McpServer {
  async function api(method: string, path: string, body?: unknown): Promise<unknown> {
    const res = await fetch(`${cfg.url}${path}`, {
      method,
      headers: {
        'x-api-key': cfg.apiKey,
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    })
    const text = await res.text()
    if (!res.ok) throw new Error(`pigeon API ${res.status}: ${text}`)
    return text ? JSON.parse(text) : {}
  }

  const asResult = (data: unknown) => ({
    content: [{ type: 'text' as const, text: JSON.stringify(data, null, 1) }],
  })

  const s = cfg.session
  const server = new McpServer({ name: 'pigeon', version: '1.3.0' })

  const draftNote =
    ' DRAFT-ONLY MODE (WA_MCP_READONLY) is on: this does NOT send — it returns the composed draft for review.'
  const draftSuffix = cfg.readOnly ? draftNote : ''
  const notSent = 'NOT SENT. Pigeon is in draft-only mode (WA_MCP_READONLY). Present this draft to the user instead.'

  server.registerTool(
    'session_status',
    {
      description:
        'Get the WhatsApp session status. Must be WORKING before sending. Other statuses: STARTING, SCAN_QR_CODE, STOPPED, FAILED.',
      inputSchema: {},
    },
    async () => asResult(await api('GET', `/v1/sessions/${s}`)),
  )

  server.registerTool(
    'list_chats',
    {
      description: 'List recent WhatsApp chats, most recently active first.',
      inputSchema: {
        limit: z.number().int().positive().max(1000).optional().describe('Max chats to return (default 50)'),
      },
    },
    async ({ limit }) => asResult(await api('GET', `/v1/sessions/${s}/chats?limit=${limit ?? 50}`)),
  )

  server.registerTool(
    'list_groups',
    {
      description:
        'List the WhatsApp groups you belong to, each with its name (subject) and group id (...@g.us). Use this to resolve a group name to its id before posting. Optionally pass query to filter by a case-insensitive substring of the name.',
      inputSchema: {
        query: z.string().optional().describe('Case-insensitive substring to filter group names by'),
      },
    },
    async ({ query }) => {
      const groups = (await api('GET', `/v1/sessions/${s}/groups`)) as Array<{ id: string; name: string }>
      const filtered = query
        ? groups.filter((g) => (g.name ?? '').toLowerCase().includes(query.toLowerCase()))
        : groups
      return asResult(filtered)
    },
  )

  server.registerTool(
    'read_messages',
    {
      description:
        'Read stored messages from a chat, newest first. chatId is a phone number with country code (no +) or a full JID like 123456789@s.whatsapp.net or a group id ...@g.us.',
      inputSchema: {
        chatId: z.string().describe('Phone number or JID of the chat'),
        limit: z.number().int().positive().max(500).optional().describe('Max messages to return (default 30)'),
      },
    },
    async ({ chatId, limit }) => {
      const msgs = (await api(
        'GET',
        `/v1/sessions/${s}/chats/${encodeURIComponent(chatId)}/messages?limit=${limit ?? 30}`,
      )) as Array<Record<string, unknown>>
      return asResult(msgs.map(({ raw: _raw, session: _session, ...m }) => m))
    },
  )

  server.registerTool(
    'send_message',
    {
      description:
        'Send a WhatsApp text message. chatId is a phone number with country code (no +) or a full JID. Returns the sent message id.' +
        draftSuffix,
      inputSchema: {
        chatId: z.string().describe('Phone number or JID of the recipient'),
        text: z.string().min(1).describe('Message text'),
      },
    },
    async ({ chatId, text }) => {
      if (cfg.readOnly) {
        return asResult({ sent: false, mode: 'draft-only', draft: { to: chatId, type: 'text', text }, note: notSent })
      }
      return asResult(await api('POST', `/v1/sessions/${s}/messages`, { chatId, type: 'text', text }))
    },
  )

  server.registerTool(
    'send_media',
    {
      description:
        'Send an image, file, voice note, or video. Provide either a public url or a local file path.' + draftSuffix,
      inputSchema: {
        chatId: z.string().describe('Phone number or JID of the recipient'),
        type: z.enum(['image', 'file', 'voice', 'video']).describe('Kind of media message'),
        url: z.string().url().optional().describe('Public URL of the media'),
        path: z.string().optional().describe('Local file path of the media'),
        caption: z.string().optional().describe('Caption shown with the media'),
        mimetype: z.string().optional().describe('MIME type (inferred from file extension when omitted)'),
      },
    },
    async ({ chatId, type, url, path, caption, mimetype }) => {
      if (!url && !path) throw new Error('provide url or path')
      if (cfg.readOnly) {
        const source = url ? { url } : { path, filename: path ? basename(path) : undefined }
        return asResult({ sent: false, mode: 'draft-only', draft: { to: chatId, type, caption, ...source }, note: notSent })
      }
      const media: Record<string, string> = {}
      if (url) media.url = url
      if (path) {
        media.data = readFileSync(path).toString('base64')
        media.filename = basename(path)
        const ext = path.split('.').pop()?.toLowerCase() ?? ''
        media.mimetype = mimetype ?? MIME_BY_EXT[ext] ?? 'application/octet-stream'
      } else if (mimetype) {
        media.mimetype = mimetype
      }
      return asResult(await api('POST', `/v1/sessions/${s}/messages`, { chatId, type, caption, media }))
    },
  )

  server.registerTool(
    'delete_message',
    {
      description:
        'Delete a message for everyone (revoke). Pass the chatId and the message id returned when it was sent. Only your own messages can be deleted for everyone, and WhatsApp limits how long after sending this works.' +
        draftSuffix,
      inputSchema: {
        chatId: z.string().describe('Phone number or JID of the chat the message is in'),
        msgId: z.string().describe('The message id to delete (as returned by send_message / send_media)'),
        fromMe: z.boolean().optional().describe('Whether you sent the message (default true)'),
      },
    },
    async ({ chatId, msgId, fromMe }) => {
      if (cfg.readOnly) {
        return asResult({
          deleted: false,
          mode: 'draft-only',
          target: { chatId, msgId, fromMe: fromMe ?? true },
          note: 'NOT DELETED. Pigeon is in draft-only mode (WA_MCP_READONLY).',
        })
      }
      return asResult(await api('POST', `/v1/sessions/${s}/delete`, { chatId, msgId, fromMe: fromMe ?? true }))
    },
  )

  server.registerTool(
    'mark_read',
    {
      description: 'Mark a chat as read (send the read receipt).',
      inputSchema: {
        chatId: z.string().describe('Phone number or JID of the chat'),
      },
    },
    async ({ chatId }) => asResult(await api('POST', '/api/sendSeen', { session: s, chatId })),
  )

  server.registerTool(
    'check_contact',
    {
      description: 'Check whether a phone number is registered on WhatsApp and get its JID.',
      inputSchema: {
        phone: z.string().describe('Phone number with country code, digits only'),
      },
    },
    async ({ phone }) => asResult(await api('GET', `/v1/sessions/${s}/contacts/check?phone=${encodeURIComponent(phone)}`)),
  )

  return server
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (isMain) {
  const cfg = loadMcpConfig()
  const server = buildServer(cfg)
  await server.connect(new StdioServerTransport())
  console.error(`pigeon mcp server running on stdio${cfg.readOnly ? ' (draft-only mode: sending disabled)' : ''}`)
}
