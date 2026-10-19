import type { DB } from './database.js'

export type ScheduleStatus = 'pending' | 'sending' | 'sent' | 'failed' | 'cancelled'

export const SCHEDULE_STATUSES: ScheduleStatus[] = ['pending', 'sending', 'sent', 'failed', 'cancelled']

export interface ScheduledMessage {
  id: number
  session: string
  chatId: string
  text: string
  sendAt: number
  status: ScheduleStatus
  createdAt: number
  sentAt: number | null
  messageId: string | null
  error: string | null
}

function toScheduled(r: Record<string, unknown>): ScheduledMessage {
  return {
    id: r.id as number,
    session: r.session as string,
    chatId: r.chat_id as string,
    text: r.text as string,
    sendAt: r.send_at as number,
    status: r.status as ScheduleStatus,
    createdAt: r.created_at as number,
    sentAt: (r.sent_at as number) ?? null,
    messageId: (r.message_id as string) ?? null,
    error: (r.error as string) ?? null,
  }
}

export class ScheduleStore {
  private insStmt
  private oneStmt
  private dueStmt
  private claimStmt
  private cancelStmt
  private doneStmt
  private failStmt
  private interruptedStmt

  constructor(private db: DB) {
    this.insStmt = db.prepare(
      `INSERT INTO scheduled_messages(session,chat_id,text,send_at,status,created_at) VALUES(?,?,?,?, 'pending', ?)`,
    )
    this.oneStmt = db.prepare(`SELECT * FROM scheduled_messages WHERE id=?`)
    this.dueStmt = db.prepare(
      `SELECT * FROM scheduled_messages WHERE status='pending' AND send_at<=? ORDER BY send_at ASC, id ASC`,
    )
    this.claimStmt = db.prepare(`UPDATE scheduled_messages SET status='sending' WHERE id=? AND status='pending'`)
    this.cancelStmt = db.prepare(
      `UPDATE scheduled_messages SET status='cancelled' WHERE id=? AND session=? AND status='pending'`,
    )
    this.doneStmt = db.prepare(
      `UPDATE scheduled_messages SET status='sent', sent_at=?, message_id=? WHERE id=? AND status='sending'`,
    )
    this.failStmt = db.prepare(
      `UPDATE scheduled_messages SET status='failed', error=? WHERE id=? AND status IN ('pending','sending')`,
    )
    this.interruptedStmt = db.prepare(
      `UPDATE scheduled_messages SET status='failed', error='interrupted while sending; delivery unknown' WHERE status='sending'`,
    )
  }

  create(session: string, chatId: string, text: string, sendAt: number, now = Date.now()): ScheduledMessage {
    const id = this.insStmt.run(session, chatId, text, sendAt, now).lastInsertRowid as number
    return this.get(id)!
  }

  get(id: number): ScheduledMessage | undefined {
    const row = this.oneStmt.get(id) as Record<string, unknown> | undefined
    return row ? toScheduled(row) : undefined
  }

  list(session: string, status?: ScheduleStatus, limit = 100): ScheduledMessage[] {
    const rows = (
      status
        ? this.db
            .prepare(`SELECT * FROM scheduled_messages WHERE session=? AND status=? ORDER BY send_at ASC, id ASC LIMIT ?`)
            .all(session, status, limit)
        : this.db
            .prepare(`SELECT * FROM scheduled_messages WHERE session=? ORDER BY send_at ASC, id ASC LIMIT ?`)
            .all(session, limit)
    ) as Array<Record<string, unknown>>
    return rows.map(toScheduled)
  }

  due(now: number): ScheduledMessage[] {
    return (this.dueStmt.all(now) as Array<Record<string, unknown>>).map(toScheduled)
  }

  // True only for the one caller whose UPDATE flipped the row out of pending.
  claim(id: number): boolean {
    return this.claimStmt.run(id).changes === 1
  }

  cancel(session: string, id: number): boolean {
    return this.cancelStmt.run(id, session).changes === 1
  }

  markSent(id: number, messageId: string, now = Date.now()) {
    this.doneStmt.run(now, messageId, id)
  }

  markFailed(id: number, error: string) {
    this.failStmt.run(error, id)
  }

  failInterrupted(): number {
    return this.interruptedStmt.run().changes
  }
}
