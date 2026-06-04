# Pigeon

A self-hosted WhatsApp HTTP API. Send and receive WhatsApp messages over a simple REST interface, including images, documents, and voice notes, with multiple sessions and webhooks. Built on Baileys, runs in Docker, stores everything in SQLite.

Pigeon is a drop-in replacement for WAHA's local setup: same port, same `X-Api-Key` header, same request shapes for the common endpoints, with media and voice sending available out of the box.

## Why

WAHA Core blocks media and voice sending behind its paid tier across every engine, even though the underlying Baileys library it wraps supports them. Pigeon is a small, owned alternative: one clean core, a WAHA-compatible surface so existing tooling keeps working, and a clean `/v1` API for new work. No gated features, no per-message fees, no external dependency.

In short: the WAHA-compatible basics, without the paywall.

## Features

- Send text, images, documents, video, voice notes, locations, contacts, and polls
- Message actions: react, edit, delete, forward
- Presence and typing indicators
- Group management: create, leave, participants, subject and description, invite links, settings
- Profile: set display name and status, fetch profile pictures, block and unblock
- Receive messages, with history persisted to SQLite
- Multiple sessions (numbers) from one instance
- Webhooks per session with retry, backoff, optional HMAC signing, and a Server-Sent Events stream
- Typed events: messages, acks, reactions, presence, group changes
- QR pairing and phone pairing-code over HTTP
- Auto-reconnect that tells a real logout apart from a transient drop
- Per-session send queue with light rate limiting
- WAHA-compatible `/api` surface and a clean `/v1` surface
- One Docker container, two mounted volumes

## Quick start

```bash
cp .env.example .env          # set WA_API_KEY
docker compose up -d --build
curl -s localhost:4000/api/health     # {"status":"ok"}
```

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

Every route except `/api/health` requires `X-Api-Key: <WA_API_KEY>`.

### Compat surface (`/api/*`)

WAHA-shaped, for drop-in compatibility. Session goes in the body for sends.

| Method | Path | Body / notes |
| --- | --- | --- |
| GET | `/api/health` | no auth |
| GET | `/api/sessions` / `/api/sessions/:name` | status |
| POST | `/api/sessions/:name/start\|stop\|restart` | lifecycle |
| GET | `/api/:session/auth/qr` | PNG QR for pairing |
| POST | `/api/sendText` | `{session, chatId, text}` |
| POST | `/api/sendImage\|sendFile\|sendVideo` | `{session, chatId, file:{data\|url, mimetype, filename}, caption}` |
| POST | `/api/sendVoice` | `{session, chatId, file:{data\|url}}` |
| POST | `/api/sendLocation` | `{session, chatId, latitude, longitude}` |
| POST | `/api/sendSeen` | `{session, chatId}` |
| GET | `/api/:session/chats/:chatId/messages?limit=` | history |
| GET | `/api/:session/groups` | id + name |
| GET | `/api/contacts/check-exists?session=&phone=` | is on WhatsApp |

`file.data` is base64. `file.url` makes Pigeon fetch the bytes server-side.

### Native surface (`/v1/*`)

Cleaner and consistent. Session in the path, one unified send shape.

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
| POST | `/v1/sessions/:name/presence` | `{type, chatId?}` (available, composing, paused, ...) |
| GET | `/v1/sessions/:name/chats` | recent chats from history |
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
| POST | `/v1/sessions/:name/auth/pairing-code` | `{phone}` (alternative to QR) |
| PUT | `/v1/sessions/:name/webhooks` | `{urls:[...]}` |
| GET | `/v1/events` | Server-Sent Events stream |

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

## How it works

```
HTTP (Fastify)
 |- /api/*   WAHA-compat adapter --+
 |- /v1/*    native API ----------+
                                  v   one clean core
   SessionManager . MessageService . MediaService
   HistoryStore . WebhookDispatcher . SQLite auth state
                                  |
                            Baileys socket(s)
```

The compat adapter is a thin translation over the same core the native API uses, so there is one implementation of each capability, not two.

## Pigeon vs WAHA

Pigeon covers most of WAHA's messaging surface: sends, message actions, presence, groups, profile, and webhooks. The headline difference is that what WAHA charges for (media and voice sending, multiple sessions, HMAC-signed webhooks) is free here. Pigeon deliberately skips the human-facing extras (a dashboard, Swagger UI) that don't fit an automation-first tool.

| Feature | WAHA | Pigeon |
| --- | --- | --- |
| License / cost | Core free, Plus paid | MIT, fully free |
| Send text | Core | Yes |
| Send image / file / video | Plus only | Yes |
| Send voice note | Plus only | Yes |
| Send location | Yes | Yes |
| Send contact (vCard) | Yes | Yes |
| Send poll | Yes | Yes |
| Reactions, edit, delete, forward | Yes | Yes |
| Typing / presence | Yes | Yes |
| Multiple sessions | Limited in Core | Unlimited |
| Receive messages + webhooks | Yes | Yes |
| Webhook HMAC signing | Plus only | Yes |
| Webhook event types | Many typed | Message, ack, reaction, presence, group |
| Live event stream | WebSocket | Server-Sent Events |
| Message history | Yes (S3/Postgres are Plus) | Built-in SQLite |
| Media download | Yes | Yes |
| Groups: list + full management | Yes | Yes |
| Contacts: check, picture, block | Yes | Yes |
| Contacts: full address book | Yes | No |
| Profile: name, status, picture | Yes | Yes |
| Pairing: QR + phone code | Yes | Yes |
| Status / stories | Yes | Yes |
| Channels: create / follow / metadata | Yes | Yes |
| Labels (WhatsApp Business) | Yes | No |
| Buttons / lists / interactive | Yes (gated) | No (gated by Meta) |
| Engines | NOWEB, WEBJS, GOWS | Baileys (NOWEB) |
| Dashboard UI / Swagger | Yes | No (by design) |
| Maturity | Mature product | New, single maintainer |

What's left to WAHA: alternative engines to fall back on, the full contact address book, labels, status, channels, and a dashboard UI. If you need those, use WAHA. If you want a clean, automation-first API with media and the rest ungated, self-hosted and MIT, use Pigeon.

## Storage

SQLite under `WA_DATA_DIR` holds session auth state and message history. Media lives under `WA_MEDIA_DIR` with a lifetime cleanup. Both are mounted volumes, so they survive container rebuilds.

## Disclaimer

Pigeon is not affiliated with, endorsed by, or connected to WhatsApp or Meta. It uses Baileys, an unofficial library, to automate a WhatsApp account. This is not officially supported, and accounts using automation can be restricted. Use it at your own risk, on a number you control.

## Scope

Pigeon is built for personal automation, prototyping, and development. It has no bulk-send features by design. Message people who have agreed to hear from you, respect local law, and for business or marketing messaging at scale use the official WhatsApp Business Platform.

## Credits

Built by [Jean Galea](https://jeangalea.com).

If you want WhatsApp, or any messaging, done properly for a business on the official APIs, that's what [AgentVania](https://agentvania.com) does.

## License

MIT. See [LICENSE](LICENSE).
