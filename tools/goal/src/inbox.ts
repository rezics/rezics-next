import type { Database } from 'bun:sqlite';
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { watchOrPoll } from './watch-or-poll.ts';
import { join } from 'node:path';
import type { ManagerEvent, ManagerEventKind, ManagerInbox } from './contracts.ts';
import { migrate } from './db.ts';

const wakingKinds = new Set<ManagerEventKind>(['spec-conflict', 'scope-growth', 'environment', 'round-limit', 'stalled',
  'failed-after-consult', 'goal-unmet', 'goal-met', 'goal-idle', 'instruction']);
export type InboxEntry = { id: number; event: ManagerEvent; readAt: number | null; acknowledgedAt: number | null };

export class SqliteManagerInbox implements ManagerInbox {
  readonly signalDirectory: string;
  constructor(readonly db: Database, readonly stateDirectory: string) {
    this.signalDirectory = join(stateDirectory, 'manager-signals');
    mkdirSync(this.signalDirectory, { recursive: true });
    migrate(db, [{ module: 'inbox', version: 1, sql: `
      CREATE TABLE manager_inbox (
        id INTEGER PRIMARY KEY AUTOINCREMENT, manager TEXT NOT NULL, event TEXT NOT NULL,
        wakeable INTEGER NOT NULL, notified INTEGER NOT NULL DEFAULT 0, read_at INTEGER, acknowledged_at INTEGER
      );
      CREATE INDEX manager_inbox_pending ON manager_inbox(manager, wakeable, read_at);` }]);
  }
  signalPath(manager: string): string {
    return join(this.signalDirectory, createHash('sha256').update(manager).digest('hex'));
  }
  deliver(event: ManagerEvent): void {
    if (!wakingKinds.has(event.kind)) throw new Error(`Recorded-only event cannot be delivered: ${event.kind}`);
    if (/[\r\n]/.test(event.summary)) throw new Error('Manager event summary must be one line');
    this.insert(event.managerId, event, true);
    // The committed row is authoritative. A signal is only a wakeup hint.
    const signal = () => writeFileSync(this.signalPath(event.managerId), String(Date.now()));
    // Worker decisions may call us inside their shared synchronous transaction. Signal after its commit.
    if (this.db.inTransaction) queueMicrotask(signal); else signal();
  }
  record(manager: string, event: unknown): void { this.insert(manager, event, false); }
  private insert(manager: string, event: unknown, wakeable: boolean): void {
    this.db.query('INSERT INTO manager_inbox(manager, event, wakeable) VALUES (?, ?, ?)').run(manager, JSON.stringify(event), Number(wakeable));
  }
  pending(manager: string): InboxEntry[] {
    return this.rows(manager, 'wakeable = 1 AND read_at IS NULL');
  }
  private rows(manager: string, condition: string): InboxEntry[] {
    return (this.db.query(`SELECT id, event, read_at, acknowledged_at FROM manager_inbox WHERE manager = ? AND ${condition} ORDER BY id`)
      .all(manager) as { id: number; event: string; read_at: number | null; acknowledged_at: number | null }[])
      .map(row => ({ id: row.id, event: JSON.parse(row.event), readAt: row.read_at, acknowledgedAt: row.acknowledged_at }));
  }
  read(manager: string): InboxEntry[] {
    return this.db.transaction(() => {
      const entries = this.rows(manager, 'wakeable = 1 AND acknowledged_at IS NULL');
      this.db.query('UPDATE manager_inbox SET read_at = COALESCE(read_at, ?) WHERE manager = ? AND wakeable = 1 AND acknowledged_at IS NULL')
        .run(Date.now(), manager);
      return entries;
    }).immediate();
  }
  acknowledge(manager: string, ids?: readonly number[]): void {
    this.db.transaction(() => {
      if (ids) for (const id of ids) this.db.query('UPDATE manager_inbox SET acknowledged_at = ? WHERE manager = ? AND id = ? AND read_at IS NOT NULL')
        .run(Date.now(), manager, id);
      else this.db.query('UPDATE manager_inbox SET acknowledged_at = ? WHERE manager = ? AND read_at IS NOT NULL').run(Date.now(), manager);
    }).immediate();
  }
  notifications(manager: string): InboxEntry[] { return this.rows(manager, 'wakeable = 1 AND notified = 0 AND read_at IS NULL'); }
  notified(id: number): void { this.db.query('UPDATE manager_inbox SET notified = 1 WHERE id = ?').run(id); }

  /** Subscribe before checking the database so delivery in the setup window cannot be lost. */
  /**
   * Resolve with the pending events once there are any. With `settleMs`, keep collecting for that long after the first
   * event, so a burst of events costs the reader one turn instead of one per event.
   */
  wait(manager: string, signal?: AbortSignal, settleMs = 0): Promise<InboxEntry[]> {
    return new Promise((resolve, reject) => {
      let settling: ReturnType<typeof setTimeout> | undefined;
      const close = () => { watcher.close(); if (settling) clearTimeout(settling); signal?.removeEventListener('abort', abort); };
      const finish = () => {
        try { const events = this.read(manager); close(); resolve(events); }
        catch (error) { close(); reject(error); }
      };
      const check = () => {
        try {
          if (!this.pending(manager).length || settling) return;
          if (settleMs > 0) settling = setTimeout(finish, settleMs);
          else finish();
        } catch (error) { close(); reject(error); }
      };
      const abort = () => { close(); reject(signal?.reason ?? new Error('Inbox wait aborted')); };
      const watcher = watchOrPoll(this.signalDirectory, check, 2_000);
      signal?.addEventListener('abort', abort, { once: true });
      if (signal?.aborted) abort(); else check();
    });
  }
}
