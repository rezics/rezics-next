import type { Database } from 'bun:sqlite';
import type {
  AttemptFence,
  LandingQueue,
  LandingRequest,
  GateOutcome,
  ControlPlaneBatchDevHandoff,
} from './contracts.ts';
import type { GateResult } from './merge.ts';
import { migrate } from './db.ts';
import { recordFlow } from './flow.ts';
import { controlPlaneReleaseBrief } from './briefs.ts';

export type LandingEntry = {
  id: number;
  request: LandingRequest;
  outcome: GateOutcome | null;
  delivered: number;
  candidate: string | null;
  batchId?: string | null;
};

/** Requests and outcomes survive a train restart. Sink delivery is at least once. */
export class SqliteLandingQueue implements LandingQueue {
  constructor(
    readonly db: Database,
    private readonly fence: AttemptFence,
  ) {
    migrate(db, [
      {
        module: 'landing',
        version: 1,
        sql: `
      CREATE TABLE landing_queue (
        id INTEGER PRIMARY KEY AUTOINCREMENT, task TEXT NOT NULL, attempt INTEGER NOT NULL,
        request TEXT NOT NULL, outcome TEXT, delivered INTEGER NOT NULL DEFAULT 0, candidate TEXT,
        UNIQUE(task, attempt)
      );`,
      },
      {
        module: 'landing',
        version: 2,
        sql: `
      CREATE TABLE landing_baselines (main_commit TEXT NOT NULL, gate_command TEXT NOT NULL, result TEXT NOT NULL,
        PRIMARY KEY(main_commit, gate_command));`,
      },
      { module: 'landing', version: 3, sql: 'ALTER TABLE landing_queue ADD COLUMN batch TEXT;' },
      {
        module: 'landing',
        version: 4,
        sql: `
        CREATE TABLE landing_batch_claims (
          batch TEXT NOT NULL, task TEXT NOT NULL, attempt INTEGER NOT NULL, previous_batch TEXT,
          request TEXT NOT NULL, claimed_at TEXT NOT NULL, PRIMARY KEY(batch, task, attempt)
        );`,
      },
      {
        module: 'landing',
        version: 5,
        sql: `
        CREATE TABLE landing_batch_supersessions (
          previous_batch TEXT PRIMARY KEY, replacement_batch TEXT NOT NULL UNIQUE, body TEXT NOT NULL
        );`,
      },
      {
        module: 'landing',
        version: 6,
        sql: `
        CREATE TABLE landing_batch_dev_handoffs (
          previous_batch TEXT PRIMARY KEY, body TEXT NOT NULL, consumed_at TEXT NOT NULL
        );`,
      },
      {
        module: 'landing',
        version: 7,
        sql: `
        CREATE TABLE landing_scope_approvals (
          task TEXT NOT NULL, attempt INTEGER NOT NULL, body TEXT NOT NULL,
          PRIMARY KEY(task, attempt)
        );
        CREATE TRIGGER landing_scope_approvals_no_update BEFORE UPDATE ON landing_scope_approvals
          BEGIN SELECT RAISE(ABORT, 'Native scope approvals are immutable'); END;
        CREATE TRIGGER landing_scope_approvals_no_delete BEFORE DELETE ON landing_scope_approvals
          BEGIN SELECT RAISE(ABORT, 'Native scope approvals are immutable'); END;`,
      },
      {
        module: 'landing',
        version: 8,
        sql: `
        CREATE TABLE landing_batch_ref_continuations (batch TEXT PRIMARY KEY, body TEXT NOT NULL);
        CREATE TRIGGER landing_batch_ref_continuations_no_update BEFORE UPDATE ON landing_batch_ref_continuations
          BEGIN SELECT RAISE(ABORT, 'Native ref continuations are immutable'); END;
        CREATE TRIGGER landing_batch_ref_continuations_no_delete BEFORE DELETE ON landing_batch_ref_continuations
          BEGIN SELECT RAISE(ABORT, 'Native ref continuations are immutable'); END;`,
      },
    ]);
  }
  controlPlaneRefContinuation(batchId: string): string | undefined {
    return (
      this.db.query('SELECT body FROM landing_batch_ref_continuations WHERE batch=?').get(batchId) as {
        body: string;
      } | null
    )?.body;
  }
  /** Called inside the native store fence, before the single fresh candidate can start. */
  recordControlPlaneRefContinuation(batchId: string, body: string): void {
    this.db.query('INSERT INTO landing_batch_ref_continuations(batch, body) VALUES (?, ?)').run(batchId, body);
  }
  /** Native transfer receipt is committed in the same transaction as every exact claim. */
  controlPlaneSupersession(previousBatchId: string): string | undefined {
    return (
      this.db.query('SELECT body FROM landing_batch_supersessions WHERE previous_batch=?').get(previousBatchId) as {
        body: string;
      } | null
    )?.body;
  }
  controlPlaneReplacement(batchId: string): string | undefined {
    return (
      this.db.query('SELECT body FROM landing_batch_supersessions WHERE replacement_batch=?').get(batchId) as {
        body: string;
      } | null
    )?.body;
  }
  enqueue(request: LandingRequest): void {
    this.db
      .transaction(() => {
        this.fence.assertCurrent(request);
        this.db
          .query(
            'INSERT INTO landing_queue(task, attempt, request) VALUES (?, ?, ?) ON CONFLICT(task, attempt) DO NOTHING',
          )
          .run(request.taskId, request.attempt, JSON.stringify(request));
        recordFlow(this.db, {
          taskId: request.taskId,
          attempt: request.attempt,
          stage: 'landing',
          action: 'enqueued',
          at: new Date().toISOString(),
        });
      })
      .immediate();
  }
  baseline(commit: string, command: string): GateResult | undefined {
    const row = this.db
      .query('SELECT result FROM landing_baselines WHERE main_commit=? AND gate_command=?')
      .get(commit, command) as { result: string } | null;
    return row ? JSON.parse(row.result) : undefined;
  }
  saveBaseline(commit: string, command: string, result: GateResult): void {
    this.db
      .query('INSERT OR REPLACE INTO landing_baselines VALUES (?,?,?)')
      .run(commit, command, JSON.stringify(result));
  }
  next(): LandingEntry | undefined {
    return this.nextBatch(1)[0];
  }
  /** Exact durable identity, including delivered rows needed for post-publication recovery. */
  entry(ref: { taskId: string; attempt: number }): LandingEntry | undefined {
    const row = this.db
      .query('SELECT * FROM landing_queue WHERE task=? AND attempt=?')
      .get(ref.taskId, ref.attempt) as {
      id: number;
      request: string;
      outcome: string | null;
      delivered: number;
      candidate: string | null;
      batch: string | null;
    } | null;
    return row
      ? {
          ...row,
          batchId: row.batch,
          request: JSON.parse(row.request),
          outcome: row.outcome ? JSON.parse(row.outcome) : null,
        }
      : undefined;
  }
  /** Reserve real requests for explicit cohort release. Ordinary pumps must never retry them as serial landings. */
  claimControlPlaneBatch(
    batchId: string,
    members: readonly { taskId: string; attempt: number }[],
    readmissions: readonly { taskId: string; attempt: number; fromBatchId: string; request: LandingRequest }[] = [],
    verifyReadmissions?: () => void,
    supersession?: {
      previousBatchId: string;
      body: string;
      historicalClaims?: readonly { taskId: string; attempt: number; request: LandingRequest }[];
    },
  ): void {
    this.db
      .transaction(() => {
        if (readmissions.length || supersession) {
          if (!verifyReadmissions) throw new Error('Readmission requires the native journal fence');
          verifyReadmissions();
        }
        if (this.controlPlaneSupersession(batchId)) throw new Error('This cohort was superseded/interrupted');
        for (const member of supersession?.historicalClaims ?? []) {
          const entry = this.entry(member);
          if (
            !entry ||
            entry.batchId !== supersession!.previousBatchId ||
            entry.outcome ||
            entry.delivered ||
            entry.candidate ||
            JSON.stringify(entry.request) !== JSON.stringify(member.request)
          )
            throw new Error('Historical supersession claim changed');
          // These may be stale generations. Retain their claim without asserting that they are current or releasing it.
          this.db
            .query('INSERT OR IGNORE INTO landing_batch_claims VALUES (?,?,?,?,?,?)')
            .run(
              supersession!.previousBatchId,
              member.taskId,
              member.attempt,
              null,
              JSON.stringify(member.request),
              new Date().toISOString(),
            );
        }
        for (const member of members) {
          this.fence.assertCurrent(member);
          const entry = this.entry(member);
          const transfer = readmissions.find(
            (item) => item.taskId === member.taskId && item.attempt === member.attempt,
          );
          if (
            !entry ||
            (entry.batchId && entry.batchId !== batchId && entry.batchId !== transfer?.fromBatchId) ||
            ((!entry.batchId || transfer) && (entry.outcome || entry.delivered || entry.candidate))
          )
            throw new Error(`Landing request for ${member.taskId} is unavailable for this batch`);
          if (
            transfer &&
            (JSON.stringify(entry.request) !== JSON.stringify(transfer.request) ||
              (entry.batchId !== transfer.fromBatchId && entry.batchId !== batchId))
          )
            throw new Error(`Readmission request changed for ${member.taskId}`);
          if (entry.batchId === batchId) continue;
          const at = new Date().toISOString();
          const claim = (batch: string, previous: string | null) =>
            this.db
              .query('INSERT OR IGNORE INTO landing_batch_claims VALUES (?,?,?,?,?,?)')
              .run(batch, member.taskId, member.attempt, previous, JSON.stringify(entry.request), at);
          // Older controllers stored only the queue tag. Preserve that claim before transferring it.
          if (entry.batchId) claim(entry.batchId, null);
          claim(batchId, entry.batchId ?? null);
          this.db.query('UPDATE landing_queue SET batch=? WHERE id=?').run(batchId, entry.id);
          recordFlow(this.db, {
            ...member,
            stage: 'landing',
            action: transfer ? 'cohort-readmitted' : 'cohort-claimed',
            at,
            detail: JSON.stringify({ batchId, previousBatchId: entry.batchId ?? null }),
          });
        }
        if (supersession)
          this.db
            .query('INSERT INTO landing_batch_supersessions VALUES (?,?,?)')
            .run(supersession.previousBatchId, batchId, supersession.body);
      })
      .immediate();
  }
  /** Native migration receiver only: its synchronous store migration and exact claim handoff share one transaction. */
  consumeControlPlaneDevHandoff(
    handoff: ControlPlaneBatchDevHandoff,
    verify: () => void,
    receiveDev: (handoff: ControlPlaneBatchDevHandoff) => void,
  ): void {
    this.db
      .transaction(() => {
        const saved = this.db
          .query('SELECT body FROM landing_batch_dev_handoffs WHERE previous_batch=?')
          .get(handoff.previousBatchId) as { body: string } | null;
        const body = JSON.stringify(handoff);
        if (saved) {
          if (saved.body !== body) throw new Error('Dev handoff already consumed with different identities');
          return;
        }
        verify();
        receiveDev(handoff);
        for (const member of handoff.members) {
          this.fence.assertCurrent(member);
          const entry = this.entry(member);
          const row = this.db.query('SELECT body FROM worker_tasks WHERE id=?').get(member.taskId) as {
            body: string;
          } | null;
          const task = row
            ? (JSON.parse(row.body) as { state: string; brief: { goal: string; manager: string; target?: string } })
            : undefined;
          if (
            !entry ||
            entry.id !== member.queueEntryId ||
            entry.batchId !== member.claimBatchId ||
            entry.outcome ||
            entry.delivered ||
            entry.candidate ||
            JSON.stringify(entry.request) !== JSON.stringify(member.request) ||
            task?.state !== 'landing' ||
            task.brief.manager !== handoff.ownerId ||
            controlPlaneReleaseBrief(task.brief) ||
            task.brief.target === 'main' ||
            task.brief.target === 'stabilize'
          )
            throw new Error('Dev receiver must migrate the exact unchanged accepted request to the normal dev lane');
          this.db.query('UPDATE landing_queue SET batch=NULL WHERE id=?').run(entry.id);
          recordFlow(this.db, {
            taskId: member.taskId,
            attempt: member.attempt,
            stage: 'landing',
            action: 'cohort-deferred-to-dev',
            at: new Date().toISOString(),
            detail: JSON.stringify({
              previousBatchId: handoff.previousBatchId,
              replacementBatchId: handoff.replacementBatchId,
              cause: member.cause,
            }),
          });
        }
        this.db
          .query('INSERT INTO landing_batch_dev_handoffs VALUES (?,?,?)')
          .run(handoff.previousBatchId, body, new Date().toISOString());
      })
      .immediate();
  }
  nextBatch(limit: number, excludedIds: readonly number[] = [], lane?: 'main' | 'dev'): LandingEntry[] {
    if (!Number.isInteger(limit) || limit < 1) throw new Error('landing batch size must be a positive integer');
    // Control-plane changes land first, since they change how fast everything else lands; then critical-path and
    // stabilize fixes, which unblock other work (a fix for dev's red typecheck once waited behind 37 landings).
    const tasks = this.db.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'worker_tasks'").get();
    const laneFilter = lane
      ? !tasks
        ? lane === 'main'
          ? ' AND 0'
          : ''
        : lane === 'main'
          ? ` AND (
            COALESCE(json_extract((SELECT body FROM worker_tasks WHERE id = task), '$.brief.target'), '') = 'main'
            OR (
              json_extract((SELECT body FROM worker_tasks WHERE id = task), '$.brief.goal') = 'control-plane'
              AND COALESCE(json_extract((SELECT body FROM worker_tasks WHERE id = task), '$.brief.target'), '') = 'stabilize'
              AND json_array_length(request, '$.declaredPaths') > 0
              AND NOT EXISTS (
                SELECT 1 FROM json_each(request, '$.declaredPaths')
                WHERE value NOT GLOB 'tools/goal/*'
              )
            )
          )`
          : ` AND NOT (
            COALESCE(json_extract((SELECT body FROM worker_tasks WHERE id = task), '$.brief.target'), '') = 'main'
            OR (
              json_extract((SELECT body FROM worker_tasks WHERE id = task), '$.brief.goal') = 'control-plane'
              AND COALESCE(json_extract((SELECT body FROM worker_tasks WHERE id = task), '$.brief.target'), '') = 'stabilize'
              AND json_array_length(request, '$.declaredPaths') > 0
              AND NOT EXISTS (
                SELECT 1 FROM json_each(request, '$.declaredPaths')
                WHERE value NOT GLOB 'tools/goal/*'
              )
            )
          )`
      : '';
    const priority = tasks
      ? "COALESCE((SELECT json_extract(body, '$.brief.goal') = 'control-plane' FROM worker_tasks WHERE id = task), 0) DESC, " +
        "COALESCE((SELECT json_extract(body, '$.brief.criticalPath') = 1 OR json_extract(body, '$.brief.target') = 'stabilize' FROM worker_tasks WHERE id = task), 0) DESC, "
      : '';
    const excluded = excludedIds.length ? ` AND id NOT IN (${excludedIds.map(() => '?').join(',')})` : '';
    const rows = this.db
      .query(
        `SELECT * FROM landing_queue WHERE delivered = 0 AND batch IS NULL${laneFilter}${excluded} ORDER BY ${priority}id LIMIT ?`,
      )
      .all(...excludedIds, limit) as {
      id: number;
      request: string;
      outcome: string | null;
      delivered: number;
      candidate: string | null;
    }[];
    return rows.map((row) => {
      const request = JSON.parse(row.request) as LandingRequest;
      recordFlow(this.db, {
        taskId: request.taskId,
        attempt: request.attempt,
        stage: 'landing',
        action: 'started',
        at: new Date().toISOString(),
      });
      return {
        ...row,
        request,
        outcome: row.outcome ? JSON.parse(row.outcome) : null,
      };
    });
  }
  candidate(id: number, commit: string): void {
    this.db.query('UPDATE landing_queue SET candidate = ? WHERE id = ?').run(commit, id);
  }
  finish(id: number, outcome: GateOutcome): void {
    this.db.query('UPDATE landing_queue SET outcome = ? WHERE id = ?').run(JSON.stringify(outcome), id);
    const row = this.db.query('SELECT task,attempt FROM landing_queue WHERE id=?').get(id) as {
      task: string;
      attempt: number;
    } | null;
    if (row)
      recordFlow(this.db, {
        taskId: row.task,
        attempt: row.attempt,
        stage: 'landing',
        action: 'finished',
        at: new Date().toISOString(),
      });
  }
  acknowledge(id: number): void {
    this.db.query('UPDATE landing_queue SET delivered = 1 WHERE id = ?').run(id);
  }
}
