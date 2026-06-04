import type { DB } from './database.js'
import type { NormalizedMessage } from '../core/types.js'

export class HistoryStore {
  private ins
  private sel

  constructor(db: DB) {
    this.ins = db.prepare(`INSERT INTO messages(session,chat_id,msg_id,from_me,timestamp,type,body,caption,media_path,raw)
      VALUES(@session,@chatId,@msgId,@fromMe,@timestamp,@type,@body,@caption,@mediaPath,@raw)
      ON CONFLICT(session,chat_id,msg_id) DO UPDATE SET
        body=excluded.body, caption=excluded.caption, media_path=excluded.media_path, raw=excluded.raw, timestamp=excluded.timestamp`)
    this.sel = db.prepare(`SELECT * FROM messages WHERE session=? AND chat_id=? ORDER BY timestamp DESC LIMIT ?`)
  }

  save(m: NormalizedMessage) {
    this.ins.run({
      session: m.session,
      chatId: m.chatId,
      msgId: m.msgId,
      fromMe: m.fromMe ? 1 : 0,
      timestamp: m.timestamp,
      type: m.type ?? null,
      body: m.body ?? null,
      caption: m.caption ?? null,
      mediaPath: m.mediaPath ?? null,
      raw: JSON.stringify(m.raw),
    })
  }

  list(session: string, chatId: string, limit: number): NormalizedMessage[] {
    const rows = this.sel.all(session, chatId, limit) as Array<Record<string, unknown>>
    return rows.map((r) => ({
      session: r.session as string,
      chatId: r.chat_id as string,
      msgId: r.msg_id as string,
      fromMe: !!r.from_me,
      timestamp: r.timestamp as number,
      type: r.type as string,
      body: (r.body as string) ?? undefined,
      caption: (r.caption as string) ?? undefined,
      mediaPath: (r.media_path as string) ?? undefined,
      raw: JSON.parse(r.raw as string),
    }))
  }
}
