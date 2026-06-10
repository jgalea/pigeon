<p align="center">
  <img src="assets/banner.png" alt="Pigeon" width="100%">
</p>

# Pigeon 🐦

<p align="center">
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-MIT-4c9e31?style=for-the-badge" alt="License: MIT"></a>
  <img src="https://img.shields.io/badge/TypeScript-3178C6?style=for-the-badge&logo=typescript&logoColor=white" alt="TypeScript">
  <img src="https://img.shields.io/badge/Docker-2496ED?style=for-the-badge&logo=docker&logoColor=white" alt="Docker">
  <img src="https://img.shields.io/badge/Self--hosted-0174BE?style=for-the-badge" alt="Self-hosted">
  <a href="https://github.com/jgalea/pigeon/stargazers"><img src="https://img.shields.io/github/stars/jgalea/pigeon?style=for-the-badge&color=FFBC7D&labelColor=1c1206" alt="Stars"></a>
  <a href="https://agentvania.com"><img src="https://img.shields.io/badge/Built%20by-AgentVania-6A462F?style=for-the-badge" alt="Built by AgentVania"></a>
</p>

A self-hosted WhatsApp automation system. Send and receive WhatsApp messages over a simple REST interface, on a server you control — or plug it into AI tools through the built-in MCP server. Built on Baileys, runs in Docker, stores everything in SQLite.

## Features

| | |
| --- | --- |
| **Send anything** | Text, images, documents, video, voice notes, locations, contacts, and polls. |
| **Message actions** | React, edit, delete, and forward. |
| **Conversations** | Presence and typing indicators, read receipts, status posting, and channels. |
| **Groups & profile** | Create and manage groups (participants, invite links, settings); set your name, status, and picture; block and unblock. |
| **Receive & react** | Incoming messages persisted to SQLite, with per-session webhooks (retry, backoff, optional HMAC signing) and a Server-Sent Events stream. |
| **Multi-session** | Run several numbers from one instance. QR or phone-code pairing over HTTP. |
| **MCP server** | Built-in [MCP server](#mcp-server) so AI agents (Claude Code, Claude Desktop, and friends) can read chats and send messages as native tools. |
| **Built to run** | Auto-reconnect, per-session send queue with light rate limiting, one Docker container with two mounted volumes. |

## Requirements

- A running Docker engine with `docker compose`. On macOS that's Docker Desktop, OrbStack, or colima; on Linux, Docker Engine. The daemon must actually be running before you start.
- A phone with WhatsApp, to pair the number once via QR.
- Node 22+ only if you want to run it outside Docker (local development).

## Quick start

```bash
cp .env.example .env          # set WA_API_KEY to any secret string
docker compose up -d --build
curl -s localhost:4000/api/health     # {"status":"ok"}
```

The container listens inside on port 3000 and is published to `127.0.0.1:4000` by the compose file.

Pair a number:

1. `POST /api/sessions/default/start`
2. Open the QR: `GET /api/default/auth/qr` (PNG), scan it from the phone under Linked Devices
3. Poll `GET /api/sessions/default` until `status` is `WORKING`

Send a document:

```bash
curl -X POST localhost:4000/api/sendFile \
  -H "x-api-key: $WA_API_KEY" -H 'content-type: application/json' \
  -d '{"session":"default","chatId":"15551234567@s.whatsapp.net",
       "file":{"data":"<base64>","mimetype":"application/pdf","filename":"report.pdf"},
       "caption":"here you go"}'
```

## Local development

```bash
npm install
npm run build && npm start    # or: npm run dev
npm test                      # vitest
```

## API

Every route except `/api/health` requires `X-Api-Key: <WA_API_KEY>`. There are two route groups: a clean, versioned `/v1` API (recommended for new work) and a set of flatter `/api` endpoints with the session in the request body, convenient for simple clients.

### `/v1`

| Method | Path | Body / notes |
| --- | --- | --- |
| GET / POST | `/v1/sessions` | list / create `{name}` |
| GET / DELETE | `/v1/sessions/:name` | status (with qr) / logout |
| POST | `/v1/sessions/:name/start\|stop\|restart` | lifecycle |
| POST | `/v1/sessions/:name/messages` | `{chatId, type, text?, caption?, media?, location?, contact?, poll?}` |
| POST | `/v1/sessions/:name/react` | `{chatId, msgId, emoji, fromMe?}` |
| POST | `/v1/sessions/:name/edit` | `{chatId, msgId, text}` |
| POST | `/v1/sessions/:name/delete` | `{chatId, msgId, fromMe?}` |
| POST | `/v1/sessions/:name/forward` | `{toChatId, fromChatId, msgId}` |
| POST | `/v1/sessions/:name/presence` | `{type, chatId?}` |
| GET | `/v1/sessions/:name/chats` | recent chats |
| GET | `/v1/sessions/:name/chats/:chatId/messages?limit=` | history |
| GET | `/v1/sessions/:name/contacts/check?phone=` | is on WhatsApp |
| GET | `/v1/sessions/:name/contacts/:chatId/picture` | profile picture url |
| POST | `/v1/sessions/:name/contacts/:chatId/block` | `{blocked}` |
| PUT | `/v1/sessions/:name/profile/name\|status` | `{name}` / `{status}` |
| POST/GET | `/v1/sessions/:name/groups` | create `{subject, participants}` / list |
| GET | `/v1/sessions/:name/groups/:groupId` | metadata |
| POST | `/v1/sessions/:name/groups/:groupId/participants` | `{participants, action}` |
| PUT | `/v1/sessions/:name/groups/:groupId/subject\|description` | update |
| GET/POST | `/v1/sessions/:name/groups/:groupId/invite` | get / `invite/revoke` |
| POST | `/v1/sessions/:name/groups/accept` | `{code}` |
| POST | `/v1/sessions/:name/status` | `{text?, media?, statusJidList?}` |
| POST/GET/DELETE | `/v1/sessions/:name/channels` | create / metadata / follow / delete |
| POST | `/v1/sessions/:name/auth/pairing-code` | `{phone}` (alternative to QR) |
| PUT | `/v1/sessions/:name/webhooks` | `{urls:[...]}` |
| GET | `/v1/events` | Server-Sent Events stream |

### `/api`

Flatter endpoints with the session in the body: `sendText`, `sendImage`, `sendFile`, `sendVoice`, `sendVideo`, `sendLocation`, `sendContact`, `sendPoll`, `sendSeen`, `reaction`, `startTyping`/`stopTyping`, session lifecycle, `:session/auth/qr`, `:session/chats/:chatId/messages`, `:session/groups`, `contacts/check-exists`.

Media takes `{data}` (base64) or `{url}` (Pigeon fetches it server-side). Chat ids are `<number>@s.whatsapp.net` for people and `<id>@g.us` for groups.

## MCP server

Pigeon ships an MCP (Model Context Protocol) server so AI tools like Claude Code can use WhatsApp directly. It runs over stdio and talks to a running Pigeon instance via the REST API.

Tools: `session_status`, `list_chats`, `read_messages`, `send_message`, `send_media`, `mark_read`, `check_contact`.

Register it with your MCP client, e.g. in a `.mcp.json`:

```json
{
  "mcpServers": {
    "pigeon": {
      "command": "node",
      "args": ["/path/to/pigeon/dist/mcp.js"]
    }
  }
}
```

It reads `WA_API_KEY` (and optional `WA_API_URL`, `WA_SESSION`) from the environment, falling back to the `.env` in the project root. Build first with `npm run build`.

## Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `WA_API_KEY` | (required) | shared API key for the `X-Api-Key` header |
| `WA_PORT` | `4000` | listen port |
| `WA_HOST` | `127.0.0.1` | bind address |
| `WA_DATA_DIR` | `./data` | SQLite location (sessions + history) |
| `WA_MEDIA_DIR` | `./media` | downloaded media |
| `WA_MEDIA_LIFETIME_DAYS` | `180` | media cleanup window |
| `WA_LOG_LEVEL` | `info` | pino log level |
| `WA_WEBHOOK_SECRET` | (unset) | if set, sign webhooks with an `x-pigeon-signature` HMAC |
| `WA_API_URL` | `http://127.0.0.1:4000` | Pigeon base URL (MCP server only) |
| `WA_SESSION` | `default` | session the MCP server operates on |

## How it works

```
HTTP (Fastify)
 |- /v1/*    versioned API ----+
 |- /api/*   flat endpoints ---+
                               v   one core
   SessionManager . MessageService . MediaService
   HistoryStore . WebhookDispatcher . SQLite auth state
                               |
                         Baileys socket(s)
```

## Storage

SQLite under `WA_DATA_DIR` holds session auth state and message history. Media lives under `WA_MEDIA_DIR` with a lifetime cleanup. Both are mounted volumes, so they survive container rebuilds.

## Disclaimer

Pigeon is not affiliated with, endorsed by, or connected to WhatsApp or Meta. It uses Baileys, an unofficial library, to automate a WhatsApp account. This is not officially supported, and accounts using automation can be restricted. Use it at your own risk, on a number you control.

## Scope

Pigeon is built for personal automation, prototyping, and development. It has no bulk-send features by design. Message people who have agreed to hear from you, respect local law, and for business or marketing messaging at scale use the official WhatsApp Business Platform.

## Credits

Built by Jean Galea.

If you want WhatsApp, or any messaging, done properly for a business on the official APIs, that's what [AgentVania](https://agentvania.com) does.

## License

MIT. See [LICENSE](LICENSE).
