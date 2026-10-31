import type { Database } from 'bun:sqlite';
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { watchOrPoll } from './watch-or-poll.ts';
import { join } from 'node:path';
import type { ManagerEvent, ManagerEventKind, ManagerInbox } from './contracts.ts';
import { migrateSharedInbox, sharedInboxFields } from './inbox-shared.ts';

const wakingKinds = new Set<ManagerEventKind>([
  'spec-conflict',
  'scope-growth',
  'environment',
  'round-limit',
  'stalled',
  'failed-after-consult',
  'goal-unmet',
  'goal-met',
  'goal-idle',
  'instruction',
  'question',
  'decision',
  'blocker',
  'handoff',
  'info',
]);
export type InboxEntry = { id: number; event: ManagerEvent; readAt: number | null; acknowledgedAt: number | null };

export class SqliteManagerInbox implements ManagerInbox {
  readonly signalDirectory: string;
  constructor(
    readonly db: Database,
    readonly stateDirectory: string,
    private readonly now: () => number = Date.now,
  ) {
    this.signalDirectory = join(stateDirectory, 'manager-signals');
    mkdirSync(this.signalDirectory, { recursive: true });
    migrateSharedInbox(db);
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
    if (this.db.inTransaction) queueMicrotask(signal);
    else signal();
  }
  record(manager: string, event: unknown): void {
    this.insert(manager, event, false);
  }
  private insert(manager: string, event: unknown, wakeable: boolean): void {
    const write = () => {
      const fields = sharedInboxFields(event);
      const replyToId = fields.replyToId;
      type ParentRow = {
        id: number;
        reply_to_id: number | null;
        thread_root_id: number | null;
        task_id: string | null;
        goal_id: string | null;
      };
      let parent: ParentRow | null = null;
      let rootId: number | null = null;
      if (replyToId !== null) {
        parent = this.db
          .query('SELECT id, reply_to_id, thread_root_id, task_id, goal_id FROM manager_inbox WHERE id = ?')
          .get(replyToId) as ParentRow | null;
        if (!parent) throw new Error(`inbox reply target does not exist: ${replyToId}`);
        if (parent.task_id && fields.taskId && parent.task_id !== fields.taskId)
          throw new Error(`inbox reply task does not match its parent message ${replyToId}`);
        if (parent.goal_id && fields.goalId && parent.goal_id !== fields.goalId)
          throw new Error(`inbox reply Goal does not match its parent message ${replyToId}`);
        rootId = this.replyRoot(replyToId);
      }

      const taskId = fields.taskId ?? parent?.task_id ?? null;
      const goalId = fields.goalId ?? parent?.goal_id ?? this.goalFor(fields.sender, taskId);
      const storedEvent =
        event && typeof event === 'object' && !Array.isArray(event)
          ? { ...event, ...(taskId ? { taskId } : {}), ...(goalId ? { goalId } : {}) }
          : event;
      const createdAt = this.now();
      if (!Number.isSafeInteger(createdAt) || createdAt < 0)
        throw new Error('inbox clock returned an invalid timestamp');
      const inserted = this.db
        .query(`INSERT INTO manager_inbox(
        manager, event, wakeable, created_at, sender, goal_id, task_id, kind, summary,
        reply_to_id, thread_root_id, document_refs, escalation
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(
          manager,
          JSON.stringify(storedEvent),
          Number(wakeable),
          createdAt,
          fields.sender,
          goalId,
          taskId,
          fields.kind,
          fields.summary,
          replyToId,
          rootId,
          fields.documentRefs ? JSON.stringify(fields.documentRefs) : null,
          fields.escalation ? JSON.stringify(fields.escalation) : null,
        );
      const id = Number(inserted.lastInsertRowid);
      if (rootId === null) {
        this.db.query('UPDATE manager_inbox SET thread_root_id = ? WHERE id = ?').run(id, id);
      }
    };
    if (this.db.inTransaction) write();
    else this.db.transaction(write).immediate();
  }
  private replyRoot(id: number): number {
    const ancestry = this.db
      .query(`WITH RECURSIVE chain(id, reply_to_id, depth, path, cycle) AS (
      SELECT id, reply_to_id, 0, printf('/%d/', id), 0 FROM manager_inbox WHERE id = ?
      UNION ALL
      SELECT parent.id, parent.reply_to_id, chain.depth + 1, chain.path || parent.id || '/',
        instr(chain.path, printf('/%d/', parent.id)) > 0
      FROM chain JOIN manager_inbox AS parent ON parent.id = chain.reply_to_id
      WHERE chain.reply_to_id IS NOT NULL AND chain.cycle = 0 AND chain.depth < 10000
    ) SELECT id, reply_to_id, depth, cycle FROM chain ORDER BY depth DESC`)
      .all(id) as { id: number; reply_to_id: number | null; depth: number; cycle: number }[];
    const oldest = ancestry[0];
    const newest = ancestry[ancestry.length - 1];
    if (!oldest || !newest) throw new Error(`inbox reply target does not exist: ${id}`);
    if (ancestry.some((entry) => entry.cycle) || oldest.depth >= 10000 || oldest.reply_to_id !== null)
      throw new Error(`inbox reply target has an invalid or cyclic thread: ${id}`);
    return oldest.id;
  }
  private goalFor(sender: string | null, taskId: string | null): string | null {
    if (taskId && this.db.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'worker_tasks'").get()) {
      const row = this.db.query('SELECT body FROM worker_tasks WHERE id = ?').get(taskId) as { body: string } | null;
      if (!row) return null;
      try {
        const task = JSON.parse(row.body) as { brief?: { goal?: unknown } };
        return typeof task.brief?.goal === 'string' && task.brief.goal ? task.brief.goal : null;
      } catch {
        return null;
      }
    }
    if (
      taskId ||
      !sender ||
      !this.db.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'manager_sessions'").get()
    )
      return null;
    const row = this.db.query('SELECT state FROM manager_sessions WHERE id = ?').get(sender) as {
      state: string;
    } | null;
    if (!row) return null;
    try {
      const state = JSON.parse(row.state) as { goal?: unknown };
      return typeof state.goal === 'string' && state.goal ? state.goal : null;
    } catch {
      return null;
    }
  }
  pending(manager: string): InboxEntry[] {
    return this.rows(manager, 'wakeable = 1 AND read_at IS NULL');
  }
  private rows(manager: string, condition: string): InboxEntry[] {
    return (
      this.db
        .query(
          `SELECT id, event, read_at, acknowledged_at FROM manager_inbox WHERE manager = ? AND ${condition} ORDER BY id`,
        )
        .all(manager) as { id: number; event: string; read_at: number | null; acknowledged_at: number | null }[]
    ).map((row) => ({
      id: row.id,
      event: JSON.parse(row.event),
      readAt: row.read_at,
      acknowledgedAt: row.acknowledged_at,
    }));
  }
  read(manager: string): InboxEntry[] {
    return this.db
      .transaction(() => {
        const entries = this.rows(manager, 'wakeable = 1 AND acknowledged_at IS NULL');
        this.db
          .query(
            'UPDATE manager_inbox SET read_at = COALESCE(read_at, ?) WHERE manager = ? AND wakeable = 1 AND acknowledged_at IS NULL',
          )
          .run(Date.now(), manager);
        return entries;
      })
      .immediate();
  }
  acknowledge(manager: string, ids?: readonly number[]): void {
    this.db
      .transaction(() => {
        if (ids)
          for (const id of ids)
            this.db
              .query(
                'UPDATE manager_inbox SET acknowledged_at = ? WHERE manager = ? AND id = ? AND read_at IS NOT NULL',
              )
              .run(Date.now(), manager, id);
        else
          this.db
            .query('UPDATE manager_inbox SET acknowledged_at = ? WHERE manager = ? AND read_at IS NOT NULL')
            .run(Date.now(), manager);
      })
      .immediate();
  }
  notifications(manager: string): InboxEntry[] {
    return this.rows(manager, 'wakeable = 1 AND notified = 0 AND read_at IS NULL');
  }
  notified(id: number): void {
    this.db.query('UPDATE manager_inbox SET notified = 1 WHERE id = ?').run(id);
  }

  /** Subscribe before checking the database so delivery in the setup window cannot be lost. */
  /**
   * Resolve with the pending events once there are any. With `settleMs`, keep collecting for that long after the first
   * event, so a burst of events costs the reader one turn instead of one per event.
   */
  wait(manager: string, signal?: AbortSignal, settleMs = 0): Promise<InboxEntry[]> {
    return new Promise((resolve, reject) => {
      let settling: ReturnType<typeof setTimeout> | undefined;
      const close = () => {
        watcher.close();
        if (settling) clearTimeout(settling);
        signal?.removeEventListener('abort', abort);
      };
      const finish = () => {
        try {
          const events = this.read(manager);
          close();
          resolve(events);
        } catch (error) {
          close();
          reject(error);
        }
      };
      const check = () => {
        try {
          if (!this.pending(manager).length || settling) return;
          if (settleMs > 0) settling = setTimeout(finish, settleMs);
          else finish();
        } catch (error) {
          close();
          reject(error);
        }
      };
      const abort = () => {
        close();
        reject(signal?.reason ?? new Error('Inbox wait aborted'));
      };
      const watcher = watchOrPoll(this.signalDirectory, check, 2_000);
      signal?.addEventListener('abort', abort, { once: true });
      if (signal?.aborted) abort();
      else check();
    });
  }
}
