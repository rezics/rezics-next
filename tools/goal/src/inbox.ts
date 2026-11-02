import type { Database } from 'bun:sqlite';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { watchOrPoll } from './watch-or-poll.ts';
import { join } from 'node:path';
import type { ManagerEvent, ManagerEventKind, ManagerInbox } from './contracts.ts';
import { migrateSharedInbox, sharedInboxFields } from './inbox-shared.ts';

const wakingKinds = new Set<ManagerEventKind>([
  'width',
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
export type InboxEntry = {
  id: number;
  event: ManagerEvent;
  readAt: number | null;
  acknowledgedAt: number | null;
  /** Present when identical deliveries within an hour were folded into this row. */
  deliveries?: number;
};
/** Identical deliveries to one recipient within this window are stored once, with a count. */
export const INBOX_DEDUPE_WINDOW_MS = 60 * 60_000;
/** A completion result answers the manager's own request, so a repeated result still wakes it. */
const unfoldedKinds = new Set<string>(['goal-met', 'goal-unmet']);
export const MANAGER_SENDS_PER_HOUR = 6;
export const MANAGER_SEND_MAX_CHARACTERS = 600;
const SEND_WINDOW_MS = 60 * 60_000;

export class InboxSendRefusedError extends Error {
  override name = 'InboxSendRefusedError';
}

/**
 * A worker's `info` reports a decision it already made: it is stored for the manager's next read but never wakes the
 * manager on its own. Worker questions and blockers still wake.
 */
export function quietDelivery(event: Pick<ManagerEvent, 'kind' | 'from'>): boolean {
  return event.kind === 'info' && typeof event.from === 'string' && event.from.startsWith('worker:');
}

/** The delivery identity: recipient, kind, sender, task, reply target and the first line of the summary. */
function dedupeKey(manager: string, fields: ReturnType<typeof sharedInboxFields>): string {
  const firstLine = (fields.summary ?? '').split(/\r?\n/, 1)[0]!.trim();
  return createHash('sha256')
    .update(JSON.stringify([manager, fields.kind, fields.sender, fields.taskId, fields.replyToId, firstLine]))
    .digest('hex');
}

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
  /**
   * An identical delivery within the last hour only increments that row's count and wakes nobody. A quiet delivery
   * (see `quietDelivery`) is read with the next `inbox read` but sends no wakeup.
   */
  deliver(delivered: ManagerEvent): void {
    if (!wakingKinds.has(delivered.kind)) throw new Error(`Recorded-only event cannot be delivered: ${delivered.kind}`);
    // A summary is one line. Refusing a multi-line one failed every recovery sweep that settled the same worker result
    // (2026-11-02), so it is folded instead.
    const event = /[\r\n]/.test(delivered.summary)
      ? { ...delivered, summary: delivered.summary.replace(/\s*[\r\n]+\s*/g, ' ') }
      : delivered;
    const quiet = quietDelivery(event);
    if (!this.insert(event.managerId, event, true, quiet) || quiet) return;
    // The committed row is authoritative. A signal is only a wakeup hint.
    const signal = () => writeFileSync(this.signalPath(event.managerId), String(Date.now()));
    // Worker decisions may call us inside their shared synchronous transaction. Signal after its commit.
    if (this.db.inTransaction)
      queueMicrotask(() => {
        try {
          signal();
        } catch (error) {
          // Shutdown can remove state after commit but before this microtask. Never recreate removed state.
          if ((error as NodeJS.ErrnoException).code === 'ENOENT' && !existsSync(this.stateDirectory)) return;
          // The transaction has returned: throwing here bypasses its caller's error boundary and kills the host.
          // Keep the durable event and the actual signal failure visible without undoing delivery.
          console.error('manager inbox wakeup hint failed:', error);
        }
      });
    else signal();
  }
  /**
   * Refuse a Goal manager's send above six an hour or 600 characters. Call it in the transaction that delivers the
   * send. The continuation handshake is exempt from the hourly cap, since renewal waits for it.
   */
  assertManagerSend(sender: string, summary: string): void {
    if (summary.length > MANAGER_SEND_MAX_CHARACTERS)
      throw new InboxSendRefusedError(
        `inbox send refused: the summary has ${summary.length} characters and a manager message may have at most ${MANAGER_SEND_MAX_CHARACTERS} (about 60 words). Send the decision, question or handoff; put details in the brief or owner document.`,
      );
    if (/continuation written/i.test(summary)) return;
    const since = this.now() - SEND_WINDOW_MS;
    const { count } = this.db
      .query(
        "SELECT count(*) AS count FROM manager_inbox WHERE sender = ? AND created_at > ? AND summary NOT LIKE '%continuation written%'",
      )
      .get(sender, since) as { count: number };
    if (count >= MANAGER_SENDS_PER_HOUR)
      throw new InboxSendRefusedError(
        `inbox send refused: ${sender} has sent ${count} messages in the last hour and the limit is ${MANAGER_SENDS_PER_HOUR}. Send only decisions, blocking questions and handoffs; status, receipts and acknowledgements are not messages.`,
      );
  }
  record(manager: string, event: unknown): void {
    this.insert(manager, event, false);
  }
  private insert(manager: string, event: unknown, wakeable: boolean, quiet = false): boolean {
    const write = (): boolean => {
      const fields = sharedInboxFields(event);
      const key = wakeable && !unfoldedKinds.has(fields.kind ?? '') ? dedupeKey(manager, fields) : null;
      const createdAt = this.now();
      if (!Number.isSafeInteger(createdAt) || createdAt < 0)
        throw new Error('inbox clock returned an invalid timestamp');
      if (key) {
        const repeat = this.db
          .query(
            'SELECT id FROM manager_inbox WHERE dedupe_key = ? AND created_at > ? ORDER BY created_at DESC, id DESC LIMIT 1',
          )
          .get(key, createdAt - INBOX_DEDUPE_WINDOW_MS) as { id: number } | null;
        if (repeat) {
          this.db
            .query('UPDATE manager_inbox SET delivery_count = delivery_count + 1, last_delivered_at = ? WHERE id = ?')
            .run(createdAt, repeat.id);
          return false;
        }
      }
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
      const inserted = this.db
        .query(`INSERT INTO manager_inbox(
        manager, event, wakeable, created_at, sender, goal_id, task_id, kind, summary,
        reply_to_id, thread_root_id, document_refs, escalation, dedupe_key, quiet
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
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
          key,
          Number(quiet),
        );
      const id = Number(inserted.lastInsertRowid);
      if (rootId === null) {
        this.db.query('UPDATE manager_inbox SET thread_root_id = ? WHERE id = ?').run(id, id);
      }
      return true;
    };
    if (this.db.inTransaction) return write();
    return this.db.transaction(write).immediate();
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
  /** Unread events that wake the manager; quiet ones wait for a read caused by something else. */
  pending(manager: string): InboxEntry[] {
    return this.rows(manager, 'wakeable = 1 AND quiet = 0 AND read_at IS NULL');
  }
  private rows(manager: string, condition: string): InboxEntry[] {
    return (
      this.db
        .query(
          `SELECT id, event, read_at, acknowledged_at, delivery_count FROM manager_inbox WHERE manager = ? AND ${condition} ORDER BY id`,
        )
        .all(manager) as {
        id: number;
        event: string;
        read_at: number | null;
        acknowledged_at: number | null;
        delivery_count: number;
      }[]
    ).map((row) => ({
      id: row.id,
      event: JSON.parse(row.event),
      readAt: row.read_at,
      acknowledgedAt: row.acknowledged_at,
      ...(row.delivery_count > 1 ? { deliveries: row.delivery_count } : {}),
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
    return this.rows(manager, 'wakeable = 1 AND quiet = 0 AND notified = 0 AND read_at IS NULL');
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
