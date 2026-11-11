import { nativeCheckId, proofFingerprint, ProofCapacityQueuedError } from './verification.ts';
import type { Database } from 'bun:sqlite';
import { defaultPolicy } from './policy.ts';
import { isDeepStrictEqual } from 'node:util';
import { briefProposalHash, sameBriefProposalText } from './durable-follow-up.ts';
import type { OwnerDecisionDelivery } from './owner-decisions.ts';
import { CheckResults, checkResultsMigration } from './check-results.ts';
import { groupMembers, runPidFilePresence, sameProcess } from './process.ts';
import type { ProcessIdentity } from './process.ts';
import { makeRecord, readMeasurement } from './records.ts';
import { migrate } from './db.ts';
import { StaleAttemptError } from './contracts.ts';
import type { AttemptFence, AttemptRef, GateOutcome, LandingRequest, ManagerEvent } from './contracts.ts';
import type {
  Attempt,
  AttemptRecord,
  Brief,
  DevVerifierFinding,
  DevVerifierRun,
  BriefProposalRecord,
  MaintenanceBackfillProgress,
  MaintenanceCandidateRef,
  IntegrationPlan,
  PendingBriefProposal,
  PoolReading,
  PromotionRun,
  RetryIntent,
  Task,
  TaskState,
  TerminationIntent,
  WorktreeCleanupDisposition,
  WorktreeMaintenanceCandidate,
  ProcessMaintenanceCandidate,
  StrayWorktreeCandidate,
  WorktreeScanDirectory,
} from './types.ts';
import { recordFlow, ensureFlow, closePendingFlow } from './flow.ts';
import type {
  ProofBinding,
  ProofReservation,
  ProofBindResult,
  ProofObservation,
  HistoricalProofCheck,
  HistoricalProofAdmission,
} from './verification.ts';

export const workerRecordEndedAtExpression = "CASE WHEN json_valid(body) THEN json_extract(body, '$.endedAt') END";
export const workerRecordEndedAtMigration = {
  module: 'worker',
  version: 12,
  sql: `CREATE INDEX worker_records_ended_at ON worker_records (${workerRecordEndedAtExpression});`,
} as const;

export const workerMigrations = [
  {
    module: 'proof-admission',
    version: 1,
    sql: `CREATE TABLE worker_proof_reservations (
      token TEXT PRIMARY KEY, goal TEXT NOT NULL, task_id TEXT NOT NULL, attempt INTEGER NOT NULL,
      status TEXT NOT NULL, body TEXT NOT NULL, UNIQUE(task_id, attempt));
      CREATE INDEX worker_proof_active ON worker_proof_reservations(goal, status);`,
  },
  {
    module: 'worker',
    version: 1,
    sql: `
CREATE TABLE worker_tasks (id TEXT PRIMARY KEY, sequence INTEGER NOT NULL UNIQUE, current_attempt INTEGER NOT NULL, body TEXT NOT NULL);
CREATE TABLE worker_attempts (task_id TEXT NOT NULL REFERENCES worker_tasks(id), attempt INTEGER NOT NULL, body TEXT NOT NULL, PRIMARY KEY(task_id, attempt));
CREATE TABLE worker_events (sequence INTEGER PRIMARY KEY AUTOINCREMENT, task_id TEXT NOT NULL REFERENCES worker_tasks(id), attempt INTEGER NOT NULL, kind TEXT NOT NULL, at TEXT NOT NULL, body TEXT NOT NULL);
CREATE TABLE worker_records (task_id TEXT NOT NULL REFERENCES worker_tasks(id), attempt INTEGER NOT NULL, body TEXT NOT NULL, PRIMARY KEY(task_id, attempt));
`,
  },
  {
    module: 'worker',
    version: 2,
    sql: `
CREATE TABLE worker_integration_plans (task_id TEXT NOT NULL, attempt INTEGER NOT NULL, body TEXT NOT NULL, PRIMARY KEY(task_id, attempt));
CREATE TABLE worker_promotions (id INTEGER PRIMARY KEY CHECK (id=1), body TEXT NOT NULL);
CREATE TABLE worker_retry_intents (task_id TEXT NOT NULL, attempt INTEGER NOT NULL, body TEXT NOT NULL, PRIMARY KEY(task_id, attempt));
`,
  },
  {
    module: 'worker',
    version: 3,
    sql: `
CREATE INDEX worker_attempts_ended_at ON worker_attempts(json_extract(body, '$.endedAt'))
  WHERE json_extract(body, '$.endedAt') IS NOT NULL;
`,
  },
  {
    module: 'worker',
    version: 4,
    sql: `
CREATE INDEX worker_attempts_state ON worker_attempts(json_extract(body, '$.state'));
`,
  },
  {
    module: 'worker',
    version: 5,
    sql: `CREATE INDEX worker_events_task_attempt_sequence ON worker_events(task_id, attempt, sequence);`,
  },
  {
    module: 'worker',
    version: 6,
    sql: `CREATE INDEX worker_tasks_state ON worker_tasks(json_extract(body, '$.state'));`,
  },
  {
    module: 'worker',
    version: 7,
    sql: `CREATE TABLE worker_worktree_cleanup (task_id TEXT PRIMARY KEY REFERENCES worker_tasks(id), body TEXT NOT NULL);`,
  },
  {
    module: 'worker',
    version: 8,
    sql: `CREATE INDEX worker_tasks_width_current ON worker_tasks(sequence)
      WHERE json_extract(body, '$.state') IN ('ready', 'held', 'running', 'stopped');`,
  },
  {
    module: 'worker',
    version: 9,
    sql: `CREATE INDEX worker_events_kind_at ON worker_events(kind, at);`,
  },
  {
    module: 'worker',
    version: 10,
    sql: `CREATE INDEX worker_tasks_wait_current ON worker_tasks(id, current_attempt)
      WHERE COALESCE(json_extract(body, '$.state'), '') NOT IN
        ('integrated', 'merged', 'stopped', 'cancelled', 'verified');`,
  },
  {
    module: 'worker',
    version: 11,
    sql: `-- Keep JSON scalar storage classes unchanged, especially numeric-looking process start strings.
CREATE TABLE worker_current_attempts (
      task_id TEXT PRIMARY KEY,
      sequence INTEGER NOT NULL,
      current_attempt INTEGER NOT NULL,
      task_state BLOB,
      goal BLOB,
      manager BLOB,
      urgent BLOB NOT NULL,
      attempt_state BLOB,
      pid BLOB,
      process_start BLOB,
      process_boot BLOB,
      process_group BLOB,
      cli BLOB
    );
INSERT INTO worker_current_attempts
SELECT t.id, t.sequence, t.current_attempt,
       json_extract(t.body, '$.state'),
       json_extract(t.body, '$.brief.goal'),
       json_extract(t.body, '$.brief.manager'),
       COALESCE(json_extract(t.body, '$.brief.urgent'), 0),
       json_extract(a.body, '$.state'),
       json_extract(a.body, '$.process.pid'),
       json_extract(a.body, '$.process.start'),
       json_extract(a.body, '$.process.boot'),
       json_extract(a.body, '$.process.group'),
       json_extract(a.body, '$.profile.cli')
FROM worker_tasks AS t
LEFT JOIN worker_attempts AS a ON a.task_id=t.id AND a.attempt=t.current_attempt;
CREATE INDEX worker_current_attempts_state
  ON worker_current_attempts(attempt_state, urgent, task_id, current_attempt)
  WHERE attempt_state IN ('running', 'waiting');
CREATE INDEX worker_current_attempts_width ON worker_current_attempts(sequence)
  WHERE task_state IN ('ready', 'held', 'running', 'stopped');
DROP INDEX IF EXISTS worker_attempts_state;
DROP INDEX IF EXISTS worker_tasks_width_current;
CREATE TRIGGER worker_current_attempts_task_insert AFTER INSERT ON worker_tasks BEGIN
  INSERT OR REPLACE INTO worker_current_attempts
  SELECT t.id, t.sequence, t.current_attempt,
         json_extract(t.body, '$.state'),
         json_extract(t.body, '$.brief.goal'),
         json_extract(t.body, '$.brief.manager'),
         COALESCE(json_extract(t.body, '$.brief.urgent'), 0),
         json_extract(a.body, '$.state'),
         json_extract(a.body, '$.process.pid'),
         json_extract(a.body, '$.process.start'),
         json_extract(a.body, '$.process.boot'),
         json_extract(a.body, '$.process.group'),
         json_extract(a.body, '$.profile.cli')
  FROM worker_tasks AS t
  LEFT JOIN worker_attempts AS a ON a.task_id=t.id AND a.attempt=t.current_attempt
  WHERE t.id=NEW.id;
END;
CREATE TRIGGER worker_current_attempts_task_update AFTER UPDATE OF sequence, current_attempt, body ON worker_tasks BEGIN
  INSERT OR REPLACE INTO worker_current_attempts
  SELECT t.id, t.sequence, t.current_attempt,
         json_extract(t.body, '$.state'),
         json_extract(t.body, '$.brief.goal'),
         json_extract(t.body, '$.brief.manager'),
         COALESCE(json_extract(t.body, '$.brief.urgent'), 0),
         json_extract(a.body, '$.state'),
         json_extract(a.body, '$.process.pid'),
         json_extract(a.body, '$.process.start'),
         json_extract(a.body, '$.process.boot'),
         json_extract(a.body, '$.process.group'),
         json_extract(a.body, '$.profile.cli')
  FROM worker_tasks AS t
  LEFT JOIN worker_attempts AS a ON a.task_id=t.id AND a.attempt=t.current_attempt
  WHERE t.id=NEW.id;
END;
CREATE TRIGGER worker_current_attempts_task_delete AFTER DELETE ON worker_tasks BEGIN
  DELETE FROM worker_current_attempts WHERE task_id=OLD.id;
END;
CREATE TRIGGER worker_current_attempts_attempt_insert AFTER INSERT ON worker_attempts BEGIN
  UPDATE worker_current_attempts SET
    attempt_state=json_extract(NEW.body, '$.state'),
    pid=json_extract(NEW.body, '$.process.pid'),
    process_start=json_extract(NEW.body, '$.process.start'),
    process_boot=json_extract(NEW.body, '$.process.boot'),
    process_group=json_extract(NEW.body, '$.process.group'),
    cli=json_extract(NEW.body, '$.profile.cli')
  WHERE task_id=NEW.task_id AND current_attempt=NEW.attempt;
END;
CREATE TRIGGER worker_current_attempts_attempt_update AFTER UPDATE ON worker_attempts BEGIN
  UPDATE worker_current_attempts SET
    attempt_state=json_extract(NEW.body, '$.state'),
    pid=json_extract(NEW.body, '$.process.pid'),
    process_start=json_extract(NEW.body, '$.process.start'),
    process_boot=json_extract(NEW.body, '$.process.boot'),
    process_group=json_extract(NEW.body, '$.process.group'),
    cli=json_extract(NEW.body, '$.profile.cli')
  WHERE task_id=NEW.task_id AND current_attempt=NEW.attempt;
  UPDATE worker_current_attempts SET
    attempt_state=NULL, pid=NULL, process_start=NULL, process_boot=NULL, process_group=NULL, cli=NULL
  WHERE task_id=OLD.task_id AND current_attempt=OLD.attempt
    AND (OLD.task_id!=NEW.task_id OR OLD.attempt!=NEW.attempt);
END;
CREATE TRIGGER worker_current_attempts_attempt_delete AFTER DELETE ON worker_attempts BEGIN
  UPDATE worker_current_attempts SET
    attempt_state=NULL, pid=NULL, process_start=NULL, process_boot=NULL, process_group=NULL, cli=NULL
  WHERE task_id=OLD.task_id AND current_attempt=OLD.attempt;
END;`,
  },
  workerRecordEndedAtMigration,
  {
    module: 'worker',
    version: 13,
    sql: `CREATE TABLE worker_brief_proposals (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id TEXT NOT NULL REFERENCES worker_tasks(id),
      written_for_attempt INTEGER NOT NULL,
      body TEXT NOT NULL
    );
    CREATE INDEX worker_brief_proposals_task ON worker_brief_proposals(task_id, id);`,
  },
  {
    module: 'worker',
    version: 14,
    sql: `CREATE TABLE worker_maintenance_candidates (
      ticket INTEGER PRIMARY KEY AUTOINCREMENT,
      kind TEXT NOT NULL CHECK(kind IN ('worktree','reap')),
      task_id TEXT NOT NULL REFERENCES worker_tasks(id),
      attempt INTEGER NOT NULL,
      UNIQUE(kind, task_id, attempt)
    );
    CREATE INDEX worker_maintenance_candidates_page ON worker_maintenance_candidates(kind, ticket);
    CREATE INDEX worker_maintenance_candidates_task ON worker_maintenance_candidates(task_id);
    CREATE TABLE worker_maintenance_progress (
      id INTEGER PRIMARY KEY CHECK(id=1),
      task_sequence INTEGER NOT NULL DEFAULT 0,
      tasks_complete INTEGER NOT NULL DEFAULT 0,
      process_task_id TEXT NOT NULL DEFAULT '',
      process_attempt INTEGER NOT NULL DEFAULT 0,
      processes_complete INTEGER NOT NULL DEFAULT 0,
      worktree_ticket INTEGER NOT NULL DEFAULT 0,
      reap_ticket INTEGER NOT NULL DEFAULT 0,
      stray_ticket INTEGER NOT NULL DEFAULT 0,
      scan_watch_ticket INTEGER NOT NULL DEFAULT 0,
      prune_generation INTEGER NOT NULL DEFAULT 0,
      prune_completed INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE worker_maintenance_strays (
      ticket INTEGER PRIMARY KEY AUTOINCREMENT,
      path TEXT NOT NULL UNIQUE
    );
    CREATE INDEX worker_maintenance_strays_page ON worker_maintenance_strays(ticket);
    CREATE TABLE worker_maintenance_scan_directories (
      watch_ticket INTEGER PRIMARY KEY AUTOINCREMENT,
      root TEXT NOT NULL,
      path TEXT NOT NULL,
      generation TEXT,
      offset INTEGER NOT NULL DEFAULT 0,
      complete INTEGER NOT NULL DEFAULT 0,
      monitor INTEGER NOT NULL DEFAULT 0,
      UNIQUE(root, path)
    );
    CREATE INDEX worker_maintenance_scan_pending
      ON worker_maintenance_scan_directories(complete, root, path);
    CREATE INDEX worker_maintenance_scan_monitor
      ON worker_maintenance_scan_directories(monitor, watch_ticket);
    CREATE TABLE worker_maintenance_task_paths (
      path TEXT NOT NULL,
      task_id TEXT NOT NULL REFERENCES worker_tasks(id),
      sequence INTEGER NOT NULL,
      PRIMARY KEY(path, task_id)
    );
    CREATE INDEX worker_maintenance_task_paths_lookup
      ON worker_maintenance_task_paths(path, sequence DESC);
    CREATE INDEX worker_maintenance_task_paths_task ON worker_maintenance_task_paths(task_id);
    INSERT INTO worker_maintenance_progress(id) VALUES (1);
    CREATE TRIGGER worker_maintenance_task_path_insert AFTER INSERT ON worker_tasks BEGIN
      INSERT OR REPLACE INTO worker_maintenance_task_paths(path, task_id, sequence)
      SELECT json_extract(NEW.body, '$.worktree'), NEW.id, NEW.sequence
      WHERE json_type(NEW.body, '$.worktree')='text';
    END;
    CREATE TRIGGER worker_maintenance_task_path_update AFTER UPDATE OF sequence, body ON worker_tasks BEGIN
      DELETE FROM worker_maintenance_task_paths WHERE task_id=OLD.id;
      INSERT OR REPLACE INTO worker_maintenance_task_paths(path, task_id, sequence)
      SELECT json_extract(NEW.body, '$.worktree'), NEW.id, NEW.sequence
      WHERE json_type(NEW.body, '$.worktree')='text';
    END;
    CREATE TRIGGER worker_maintenance_task_path_delete AFTER DELETE ON worker_tasks BEGIN
      DELETE FROM worker_maintenance_task_paths WHERE task_id=OLD.id;
    END;
    CREATE TRIGGER worker_maintenance_task_insert AFTER INSERT ON worker_tasks BEGIN
      INSERT INTO worker_maintenance_candidates(kind, task_id, attempt)
      VALUES ('worktree', NEW.id, 0)
      ON CONFLICT(kind, task_id, attempt) DO UPDATE SET ticket=excluded.ticket;
    END;
    CREATE TRIGGER worker_maintenance_task_update AFTER UPDATE OF sequence, current_attempt, body ON worker_tasks BEGIN
      INSERT INTO worker_maintenance_candidates(kind, task_id, attempt)
      VALUES ('worktree', NEW.id, 0)
      ON CONFLICT(kind, task_id, attempt) DO UPDATE SET ticket=excluded.ticket;
    END;
    CREATE TRIGGER worker_maintenance_task_delete AFTER DELETE ON worker_tasks BEGIN
      DELETE FROM worker_maintenance_candidates WHERE task_id=OLD.id;
    END;
    CREATE TRIGGER worker_maintenance_attempt_insert AFTER INSERT ON worker_attempts BEGIN
      INSERT INTO worker_maintenance_candidates(kind, task_id, attempt)
      SELECT 'reap', NEW.task_id, NEW.attempt
      WHERE json_type(NEW.body, '$.process')='object'
      ON CONFLICT(kind, task_id, attempt) DO UPDATE SET ticket=excluded.ticket;
    END;
    CREATE TRIGGER worker_maintenance_attempt_update AFTER UPDATE ON worker_attempts BEGIN
      DELETE FROM worker_maintenance_candidates
      WHERE kind='reap' AND task_id=NEW.task_id AND attempt=NEW.attempt
        AND json_type(NEW.body, '$.process') IS NOT 'object';
      INSERT INTO worker_maintenance_candidates(kind, task_id, attempt)
      SELECT 'reap', NEW.task_id, NEW.attempt
      WHERE json_type(NEW.body, '$.process')='object'
      ON CONFLICT(kind, task_id, attempt) DO UPDATE SET ticket=excluded.ticket;
    END;
    CREATE TRIGGER worker_maintenance_attempt_delete AFTER DELETE ON worker_attempts BEGIN
      DELETE FROM worker_maintenance_candidates
      WHERE kind='reap' AND task_id=OLD.task_id AND attempt=OLD.attempt;
    END;`,
  },
  checkResultsMigration(),
  {
    module: 'dev-verifier',
    version: 1,
    sql: `
CREATE TABLE dev_verifier_runs (cache_key TEXT PRIMARY KEY, created_at TEXT NOT NULL, body TEXT NOT NULL);
CREATE INDEX dev_verifier_runs_created ON dev_verifier_runs(created_at);
CREATE TABLE dev_verifier_findings (
  range_key TEXT PRIMARY KEY,
  identity TEXT NOT NULL,
  signature TEXT NOT NULL,
  base_commit TEXT NOT NULL,
  head_commit TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('existing','new','unknown')),
  created_at TEXT NOT NULL,
  body TEXT NOT NULL
);
CREATE INDEX dev_verifier_findings_identity ON dev_verifier_findings(signature, status, created_at);
CREATE INDEX dev_verifier_findings_created ON dev_verifier_findings(created_at);
`,
  },
] as const;
type Body = { body: string };
const decode = <T>(row: unknown): T | undefined => (row ? (JSON.parse((row as Body).body) as T) : undefined);
export type AttemptPage<T> = { items: T[]; hasMore: boolean; nextAfter?: number };
export type AttemptPageOptions = { afterAttempt?: number; limit: number };
export const MAX_ATTEMPT_PAGE_SIZE = defaultPolicy.history.attemptPageSize;
export const MAINTENANCE_BOOTSTRAP_PAGE_SIZE = 32;
export const MAINTENANCE_CANDIDATE_BATCH_SIZE = 16;

function attemptPageOptions(
  taskId: string,
  options: AttemptPageOptions,
  max = MAX_ATTEMPT_PAGE_SIZE,
): Required<AttemptPageOptions> {
  const afterAttempt = options.afterAttempt ?? 0;
  if (!taskId) throw new Error('task id is required');
  if (!Number.isSafeInteger(afterAttempt) || afterAttempt < 0)
    throw new Error('after attempt must be a non-negative integer');
  if (!Number.isSafeInteger(options.limit) || options.limit < 1 || options.limit > max)
    throw new Error(`limit must be between 1 and ${max}`);
  return { afterAttempt, limit: options.limit };
}

export type WorkerEvent = {
  sequence: number;
  task_id: string;
  attempt: number;
  kind: string;
  at: string;
  body: string;
};
export class WorkerStore implements AttemptFence {
  readonly checkResults: CheckResults;
  private readVersion = -1;
  private readonly taskSnapshot = new Map<string, Task>();
  private readonly attemptSnapshot = new Map<string, Attempt>();
  private decodedTaskRows = 0;
  private decodedAttemptRows = 0;
  private decodedTaskBytes = 0;
  private decodedAttemptBytes = 0;
  constructor(
    readonly db: Database,
    readonly policy = defaultPolicy,
  ) {
    migrate(db, workerMigrations);
    ensureFlow(db);
    this.checkResults = new CheckResults(db, this.policy.storage);
  }
  /** Counts bodies decoded since the previous reset; useful for guarding host read budgets. */
  decodedRows(): { tasks: number; attempts: number } {
    return { tasks: this.decodedTaskRows, attempts: this.decodedAttemptRows };
  }
  decodedBytes(): { tasks: number; attempts: number } {
    return { tasks: this.decodedTaskBytes, attempts: this.decodedAttemptBytes };
  }
  resetDecodedRows(): void {
    this.decodedTaskRows = 0;
    this.decodedAttemptRows = 0;
    this.decodedTaskBytes = 0;
    this.decodedAttemptBytes = 0;
  }
  private refreshSnapshot(): void {
    const current = (this.db.query('PRAGMA data_version').get() as { data_version: number }).data_version;
    if (current !== this.readVersion) {
      this.taskSnapshot.clear();
      this.attemptSnapshot.clear();
      this.readVersion = current;
    }
  }
  private invalidateSnapshot(): void {
    this.taskSnapshot.clear();
    this.attemptSnapshot.clear();
    this.readVersion = (this.db.query('PRAGMA data_version').get() as { data_version: number }).data_version;
  }
  private taskBody(row: unknown): Task | undefined {
    if (!row) return undefined;
    this.decodedTaskRows++;
    this.decodedTaskBytes += Buffer.byteLength((row as Body).body);
    return decode<Task>(row);
  }
  private attemptBody(row: unknown): Attempt | undefined {
    if (!row) return undefined;
    this.decodedAttemptRows++;
    this.decodedAttemptBytes += Buffer.byteLength((row as Body).body);
    return decode<Attempt>(row);
  }
  private cachedTask(id: string, body: string): Task {
    const cached = this.taskSnapshot.get(id);
    if (cached) return structuredClone(cached);
    this.decodedTaskRows++;
    this.decodedTaskBytes += Buffer.byteLength(body);
    const task = JSON.parse(body) as Task;
    this.taskSnapshot.set(id, task);
    return structuredClone(task);
  }
  task(id: string): Task {
    this.refreshSnapshot();
    const cached = this.taskSnapshot.get(id);
    if (cached) return structuredClone(cached);
    const task = this.taskBody(this.db.query('SELECT body FROM worker_tasks WHERE id=?').get(id));
    if (!task) throw new Error(`unknown task: ${id}`);
    this.taskSnapshot.set(id, task);
    return structuredClone(task);
  }
  worktreeCleanup(taskId: string): WorktreeCleanupDisposition | undefined {
    const row = this.db.query('SELECT body FROM worker_worktree_cleanup WHERE task_id=?').get(taskId);
    return decode<WorktreeCleanupDisposition>(row);
  }
  /** Backfill task cleanup candidates in durable sequence pages; inserts and updates are also trigger-enqueued. */
  bootstrapMaintenanceTasks(limit = MAINTENANCE_BOOTSTRAP_PAGE_SIZE): MaintenanceBackfillProgress {
    return this.db
      .transaction(() => {
        const progress = this.db
          .query('SELECT task_sequence, tasks_complete FROM worker_maintenance_progress WHERE id=1')
          .get() as { task_sequence: number; tasks_complete: number };
        if (progress.tasks_complete) return { examined: 0, complete: true };
        const rows = this.db
          .query('SELECT sequence FROM worker_tasks WHERE sequence>? ORDER BY sequence LIMIT ?')
          .all(progress.task_sequence, limit) as { sequence: number }[];
        const last = rows.at(-1)?.sequence ?? progress.task_sequence;
        if (rows.length)
          this.db
            .query(`INSERT INTO worker_maintenance_candidates(kind, task_id, attempt)
              SELECT 'worktree', id, 0 FROM worker_tasks WHERE sequence>? AND sequence<=? ORDER BY sequence
              ON CONFLICT(kind, task_id, attempt) DO NOTHING`)
            .run(progress.task_sequence, last);
        if (rows.length)
          this.db
            .query(`INSERT OR REPLACE INTO worker_maintenance_task_paths(path, task_id, sequence)
              SELECT json_extract(body, '$.worktree'), id, sequence FROM worker_tasks
              WHERE sequence>? AND sequence<=? AND json_type(body, '$.worktree')='text'
              ORDER BY sequence`)
            .run(progress.task_sequence, last);
        const complete = rows.length < limit;
        this.db
          .query('UPDATE worker_maintenance_progress SET task_sequence=?, tasks_complete=? WHERE id=1')
          .run(last, Number(complete));
        return { examined: rows.length, complete };
      })
      .immediate();
  }
  /** Backfill attempt identities in primary-key pages; trigger-enqueued writes cover concurrent changes. */
  bootstrapMaintenanceProcesses(limit = MAINTENANCE_BOOTSTRAP_PAGE_SIZE): MaintenanceBackfillProgress {
    return this.db
      .transaction(() => {
        const progress = this.db
          .query(
            'SELECT process_task_id, process_attempt, processes_complete FROM worker_maintenance_progress WHERE id=1',
          )
          .get() as { process_task_id: string; process_attempt: number; processes_complete: number };
        if (progress.processes_complete) return { examined: 0, complete: true };
        const rows = this.db
          .query(`SELECT task_id, attempt, json_type(body, '$.process') AS process_type FROM worker_attempts
            WHERE (task_id, attempt)>(?, ?)
            ORDER BY task_id, attempt LIMIT ?`)
          .all(progress.process_task_id, progress.process_attempt, limit) as {
          task_id: string;
          attempt: number;
          process_type: string | null;
        }[];
        const last = rows.at(-1) ?? { task_id: progress.process_task_id, attempt: progress.process_attempt };
        const candidates = rows.filter((row) => row.process_type === 'object');
        if (candidates.length)
          this.db
            .query(`INSERT INTO worker_maintenance_candidates(kind, task_id, attempt) VALUES
              ${candidates.map(() => "('reap', ?, ?)").join(', ')}
              ON CONFLICT(kind, task_id, attempt) DO UPDATE SET ticket=excluded.ticket`)
            .run(...candidates.flatMap((row) => [row.task_id, row.attempt]));
        const complete = rows.length < limit;
        this.db
          .query(`UPDATE worker_maintenance_progress
            SET process_task_id=?, process_attempt=?, processes_complete=? WHERE id=1`)
          .run(last.task_id, last.attempt, Number(complete));
        return { examined: rows.length, complete };
      })
      .immediate();
  }
  /** Persist only actually visited owners when cleanup transport consumes the maintenance budget mid-page. */
  advanceWorktreeMaintenance(candidate: WorktreeMaintenanceCandidate): void {
    this.db.query('UPDATE worker_maintenance_progress SET worktree_ticket=? WHERE id=1').run(candidate.ticket);
  }
  /** Select a bounded, durable round-robin page of finished-task cleanup candidates. */
  worktreeMaintenanceCandidates(
    limit = MAINTENANCE_CANDIDATE_BATCH_SIZE,
    advance = true,
  ): WorktreeMaintenanceCandidate[] {
    this.refreshSnapshot();
    return this.db
      .transaction(() => {
        let cursor = (
          this.db.query('SELECT worktree_ticket FROM worker_maintenance_progress WHERE id=1').get() as {
            worktree_ticket: number;
          }
        ).worktree_ticket;
        const page = (after: number) =>
          this.db
            .query(`SELECT q.ticket, q.task_id, q.attempt, t.body
              FROM worker_maintenance_candidates AS q JOIN worker_tasks AS t ON t.id=q.task_id
              WHERE q.kind='worktree' AND q.ticket>?
              ORDER BY q.ticket LIMIT ?`)
            .all(after, limit) as { ticket: number; task_id: string; attempt: number; body: string }[];
        let rows = page(cursor);
        if (!rows.length && cursor !== 0) {
          this.db.query('UPDATE worker_maintenance_progress SET worktree_ticket=0 WHERE id=1').run();
          return [];
        }
        if (rows.length && advance)
          this.db.query('UPDATE worker_maintenance_progress SET worktree_ticket=? WHERE id=1').run(rows.at(-1)!.ticket);
        return rows.map((row) => ({
          ticket: row.ticket,
          kind: 'worktree' as const,
          taskId: row.task_id,
          attempt: row.attempt,
          task: this.cachedTask(row.task_id, row.body),
        }));
      })
      .immediate();
  }
  /** Select a bounded, durable round-robin page without decoding attempt history. */
  reapMaintenanceCandidates(limit = MAINTENANCE_CANDIDATE_BATCH_SIZE): ProcessMaintenanceCandidate[] {
    return this.db
      .transaction(() => {
        let cursor = (
          this.db.query('SELECT reap_ticket FROM worker_maintenance_progress WHERE id=1').get() as {
            reap_ticket: number;
          }
        ).reap_ticket;
        const page = (after: number) =>
          this.db
            .query(`SELECT q.ticket, q.task_id, q.attempt,
                json_extract(t.body, '$.worktree') AS worktree,
                json_extract(a.body, '$.process.pid') AS pid,
                json_extract(a.body, '$.process.start') AS start,
                json_extract(a.body, '$.process.boot') AS boot,
                json_extract(a.body, '$.process.group') AS process_group
              FROM worker_maintenance_candidates AS q
              JOIN worker_tasks AS t ON t.id=q.task_id
              JOIN worker_attempts AS a ON a.task_id=q.task_id AND a.attempt=q.attempt
              WHERE q.kind='reap' AND q.ticket>?
              ORDER BY q.ticket LIMIT ?`)
            .all(after, limit) as {
            ticket: number;
            task_id: string;
            attempt: number;
            worktree: string;
            pid: number;
            start: string;
            boot: string;
            process_group: number;
          }[];
        let rows = page(cursor);
        if (!rows.length && cursor !== 0) {
          cursor = 0;
          this.db.query('UPDATE worker_maintenance_progress SET reap_ticket=0 WHERE id=1').run();
          rows = page(cursor);
        }
        if (rows.length)
          this.db.query('UPDATE worker_maintenance_progress SET reap_ticket=? WHERE id=1').run(rows.at(-1)!.ticket);
        return rows.map((row) => ({
          ticket: row.ticket,
          kind: 'reap' as const,
          taskId: row.task_id,
          attempt: row.attempt,
          worktree: row.worktree,
          process: {
            pid: row.pid,
            start: row.start,
            boot: row.boot,
            group: row.process_group,
          } satisfies ProcessIdentity,
        }));
      })
      .immediate();
  }
  /** Delete only tickets observed by the caller so a concurrent writer cannot lose a new obligation. */
  completeMaintenanceCandidates(candidates: readonly MaintenanceCandidateRef[]): void {
    if (!candidates.length) return;
    const terms = candidates.map(() => '(ticket=? AND kind=? AND task_id=? AND attempt=?)').join(' OR ');
    const orderedBindings = candidates.flatMap(({ kind, taskId, attempt, ticket }) => [ticket, kind, taskId, attempt]);
    this.db.query(`DELETE FROM worker_maintenance_candidates WHERE ${terms}`).run(...orderedBindings);
  }
  /** A cheap existence check; it does not decode old blocked-worktree bodies. */
  hasWorktreeCleanupDispositions(): boolean {
    return Boolean(this.db.query('SELECT 1 FROM worker_worktree_cleanup LIMIT 1').get());
  }
  /** Return whether a root directory is still named by any task, without opening settled task bodies. */
  hasTaskAtWorktree(path: string): boolean {
    return Boolean(this.db.query('SELECT 1 FROM worker_maintenance_task_paths WHERE path=? LIMIT 1').get(path));
  }
  beginWorktreeCleanupScan(roots: readonly string[]): void {
    if (!roots.length) return;
    const values = roots.map(() => '(?, ?, NULL, 0, 0, 1)').join(', ');
    const bindings = roots.flatMap((root) => [root, root]);
    this.db
      .query(`INSERT OR IGNORE INTO worker_maintenance_scan_directories(root, path, generation, offset, complete, monitor)
        VALUES ${values}`)
      .run(...bindings);
  }
  worktreeScanMonitors(limit = MAINTENANCE_CANDIDATE_BATCH_SIZE): WorktreeScanDirectory[] {
    return this.db
      .transaction(() => {
        let cursor = (
          this.db.query('SELECT scan_watch_ticket FROM worker_maintenance_progress WHERE id=1').get() as {
            scan_watch_ticket: number;
          }
        ).scan_watch_ticket;
        const page = (after: number) =>
          this.db
            .query(`SELECT watch_ticket, root, path, generation, offset, complete
              FROM worker_maintenance_scan_directories
              WHERE monitor=1 AND watch_ticket>? ORDER BY watch_ticket LIMIT ?`)
            .all(after, limit) as {
            watch_ticket: number;
            root: string;
            path: string;
            generation: string | null;
            offset: number;
            complete: number;
          }[];
        let rows = page(cursor);
        if (!rows.length && cursor !== 0) {
          cursor = 0;
          this.db.query('UPDATE worker_maintenance_progress SET scan_watch_ticket=0 WHERE id=1').run();
          rows = page(cursor);
        }
        if (rows.length)
          this.db
            .query('UPDATE worker_maintenance_progress SET scan_watch_ticket=? WHERE id=1')
            .run(rows.at(-1)!.watch_ticket);
        return rows.map((row) => ({ ...row, complete: Boolean(row.complete) }));
      })
      .immediate();
  }
  worktreeScanComplete(): boolean {
    return !this.db.query('SELECT 1 FROM worker_maintenance_scan_directories WHERE complete=0 LIMIT 1').get();
  }
  nextWorktreeScanDirectory(): WorktreeScanDirectory | undefined {
    const row = this.db
      .query(`SELECT watch_ticket, root, path, generation, offset, complete FROM worker_maintenance_scan_directories
        WHERE complete=0 ORDER BY root, path LIMIT 1`)
      .get() as {
      watch_ticket: number;
      root: string;
      path: string;
      generation: string | null;
      offset: number;
      complete: number;
    } | null;
    return row ? { ...row, complete: Boolean(row.complete) } : undefined;
  }
  enqueueWorktreeScanDirectory(root: string, path: string): void {
    this.db
      .query(`INSERT OR IGNORE INTO worker_maintenance_scan_directories(root, path, generation, offset, complete, monitor)
        VALUES (?, ?, NULL, 0, 0, 1)`)
      .run(root, path);
  }
  removeWorktreeScanDirectory(root: string, path: string): void {
    this.db
      .query('DELETE FROM worker_maintenance_scan_directories WHERE root=? AND path=? AND root<>path')
      .run(root, path);
  }
  updateWorktreeScanDirectory(
    root: string,
    path: string,
    generation: string | null,
    offset: number,
    complete: boolean,
  ): void {
    this.db
      .query(`UPDATE worker_maintenance_scan_directories SET generation=?, offset=?, complete=?
        WHERE root=? AND path=?`)
      .run(generation, offset, Number(complete), root, path);
  }
  resetWorktreeScanRoot(root: string, generation: string | null): void {
    this.db
      .query(`UPDATE worker_maintenance_scan_directories SET generation=?, offset=0, complete=0
        WHERE root=? AND path=?`)
      .run(generation, root, root);
  }
  resetWorktreeScanDirectory(root: string, path: string, generation: string | null): void {
    this.db
      .query(`UPDATE worker_maintenance_scan_directories SET generation=?, offset=0, complete=0
        WHERE root=? AND path=?`)
      .run(generation, root, path);
  }
  enqueueStrayWorktree(path: string): void {
    this.db
      .query(`INSERT INTO worker_maintenance_strays(path) VALUES (?)
        ON CONFLICT(path) DO UPDATE SET ticket=excluded.ticket`)
      .run(path);
  }
  hasPendingStrayWorktrees(): boolean {
    return Boolean(this.db.query('SELECT 1 FROM worker_maintenance_strays LIMIT 1').get());
  }
  strayWorktreeCandidates(limit = MAINTENANCE_CANDIDATE_BATCH_SIZE): StrayWorktreeCandidate[] {
    return this.db
      .transaction(() => {
        let cursor = (
          this.db.query('SELECT stray_ticket FROM worker_maintenance_progress WHERE id=1').get() as {
            stray_ticket: number;
          }
        ).stray_ticket;
        const page = (after: number) =>
          this.db
            .query(`SELECT ticket, path FROM worker_maintenance_strays WHERE ticket>? ORDER BY ticket LIMIT ?`)
            .all(after, limit) as StrayWorktreeCandidate[];
        let rows = page(cursor);
        if (!rows.length && cursor !== 0) {
          cursor = 0;
          this.db.query('UPDATE worker_maintenance_progress SET stray_ticket=0 WHERE id=1').run();
          rows = page(cursor);
        }
        if (rows.length)
          this.db.query('UPDATE worker_maintenance_progress SET stray_ticket=? WHERE id=1').run(rows.at(-1)!.ticket);
        return rows;
      })
      .immediate();
  }
  completeStrayWorktrees(candidates: readonly StrayWorktreeCandidate[]): void {
    if (!candidates.length) return;
    const terms = candidates.map(() => '(ticket=? AND path=?)').join(' OR ');
    const bindings = candidates.flatMap(({ path, ticket }) => [ticket, path]);
    this.db.query(`DELETE FROM worker_maintenance_strays WHERE ${terms}`).run(...bindings);
  }
  maintenanceTasksBootstrapped(): boolean {
    return Boolean(
      (
        this.db.query('SELECT tasks_complete FROM worker_maintenance_progress WHERE id=1').get() as {
          tasks_complete: number;
        }
      ).tasks_complete,
    );
  }
  hasPendingWorktreeCandidates(): boolean {
    return Boolean(this.db.query("SELECT 1 FROM worker_maintenance_candidates WHERE kind='worktree' LIMIT 1").get());
  }
  markWorktreePruneNeeded(): void {
    this.db.query('UPDATE worker_maintenance_progress SET prune_generation=prune_generation+1 WHERE id=1').run();
  }
  worktreePruneProgress(): { generation: number; completed: number } {
    const row = this.db
      .query('SELECT prune_generation, prune_completed FROM worker_maintenance_progress WHERE id=1')
      .get() as { prune_generation: number; prune_completed: number };
    return { generation: row.prune_generation, completed: row.prune_completed };
  }
  completeWorktreePrune(generation: number): void {
    this.db
      .query('UPDATE worker_maintenance_progress SET prune_completed=? WHERE id=1 AND prune_generation=?')
      .run(generation, generation);
  }
  /** Record a new filesystem generation once; repeated sweeps on the same generation stay suppressed. */
  recordWorktreeCleanup(disposition: WorktreeCleanupDisposition): boolean {
    return this.db
      .transaction(() => {
        const current = this.worktreeCleanup(disposition.taskId);
        if (current?.generation === disposition.generation) return false;
        this.db
          .query(
            'INSERT INTO worker_worktree_cleanup(task_id, body) VALUES (?, ?) ON CONFLICT(task_id) DO UPDATE SET body=excluded.body',
          )
          .run(disposition.taskId, JSON.stringify(disposition));
        return true;
      })
      .immediate();
  }
  clearWorktreeCleanup(taskId: string): void {
    this.db.query('DELETE FROM worker_worktree_cleanup WHERE task_id=?').run(taskId);
  }
  tasks(): Task[] {
    this.refreshSnapshot();
    return this.db
      .query('SELECT id, body FROM worker_tasks ORDER BY sequence')
      .all()
      .map((row) => {
        const value = row as { id: string; body: string };
        const cached = this.taskSnapshot.get(value.id);
        if (cached) return structuredClone(cached);
        const task = this.taskBody(value)!;
        this.taskSnapshot.set(value.id, task);
        return structuredClone(task);
      });
  }
  /** All non-terminal tasks, bounded by the worker_tasks_state expression index. */
  activeTasks(): Task[] {
    return this.tasksInStates(['held', 'ready', 'running', 'landing', 'stopped']);
  }
  /** Tasks in the given states, read through the worker_tasks_state expression index instead of every task body. */
  tasksInStates(states: readonly TaskState[]): Task[] {
    this.refreshSnapshot();
    const marks = states.map(() => '?').join(', ');
    return this.db
      .query(`SELECT id, body FROM worker_tasks WHERE json_extract(body, '$.state') IN (${marks}) ORDER BY sequence`)
      .all(...states)
      .map((row) => {
        const value = row as { id: string; body: string };
        const cached = this.taskSnapshot.get(value.id);
        if (cached) return structuredClone(cached);
        const task = this.taskBody(value)!;
        this.taskSnapshot.set(value.id, task);
        return structuredClone(task);
      });
  }
  /** Current landing requests whose queue entry is missing; synthetic or legacy landing rows without a request are ignored. */
  orphanedLandingCandidates(): Task[] {
    this.refreshSnapshot();
    const queueExists = this.db.query("SELECT 1 FROM sqlite_master WHERE type='table' AND name='landing_queue'").get();
    if (!queueExists) return [];
    return this.db
      .query(`
        SELECT t.id, t.body
        FROM worker_tasks AS t
        WHERE json_extract(t.body, '$.state') = 'landing'
          AND t.current_attempt > 0
          AND EXISTS (
            SELECT 1 FROM worker_events AS e
            WHERE e.task_id=t.id AND e.attempt=t.current_attempt AND e.kind='landing-requested'
          )
          AND NOT EXISTS (
            SELECT 1 FROM landing_queue AS l
            WHERE l.task=t.id AND l.attempt=t.current_attempt AND l.delivered=0
          )
        ORDER BY t.sequence
      `)
      .all()
      .map((row) => {
        const value = row as { id: string; body: string };
        const cached = this.taskSnapshot.get(value.id);
        if (cached) return structuredClone(cached);
        const task = this.taskBody(value)!;
        this.taskSnapshot.set(value.id, task);
        return structuredClone(task);
      });
  }
  taskIds(): string[] {
    return this.db
      .query('SELECT id FROM worker_tasks ORDER BY sequence')
      .all()
      .map((row) => (row as { id: string }).id);
  }
  taskState(id: string): string | undefined {
    return (
      this.db.query("SELECT json_extract(body, '$.state') AS state FROM worker_tasks WHERE id=?").get(id) as {
        state?: string;
      } | null
    )?.state;
  }
  dependency(id: string): { state: string; target?: string; task_commit?: string } | undefined {
    return this.db
      .query(
        "SELECT json_extract(body, '$.state') AS state, json_extract(body, '$.brief.target') AS target, coalesce(json_extract(body, '$.integratedCommit'), json_extract(body, '$.mergedCommit')) AS task_commit FROM worker_tasks WHERE id=?",
      )
      .get(id) as { state: string; target?: string; task_commit?: string } | undefined;
  }
  goalStatus(goal: string): { hasDependencies: boolean; inFlight: boolean; latestTaskId?: string } {
    const value = this.db
      .query(
        "SELECT coalesce(max(CASE WHEN coalesce(json_array_length(json_extract(body, '$.brief.after')), 0) > 0 THEN 1 ELSE 0 END), 0) AS has_dependencies, coalesce(max(CASE WHEN json_extract(body, '$.state') IN ('ready','running','landing','held','integrated') THEN 1 ELSE 0 END), 0) AS in_flight, (SELECT id FROM worker_tasks WHERE json_extract(body, '$.brief.goal')=? ORDER BY sequence DESC LIMIT 1) AS latest_task_id FROM worker_tasks WHERE json_extract(body, '$.brief.goal')=?",
      )
      .get(goal, goal) as { has_dependencies: number; in_flight: number; latest_task_id?: string };
    return {
      hasDependencies: value.has_dependencies !== 0,
      inFlight: value.in_flight !== 0,
      ...(value.latest_task_id ? { latestTaskId: value.latest_task_id } : {}),
    };
  }
  attempt(ref: AttemptRef): Attempt {
    this.refreshSnapshot();
    const key = `${ref.taskId}:${ref.attempt}`;
    const cached = this.attemptSnapshot.get(key);
    if (cached) return structuredClone(cached);
    const attempt = this.attemptBody(
      this.db
        .query('SELECT task_id, attempt, body FROM worker_attempts WHERE task_id=? AND attempt=?')
        .get(ref.taskId, ref.attempt),
    );
    if (!attempt) throw new Error('unknown attempt');
    this.attemptSnapshot.set(key, attempt);
    return structuredClone(attempt);
  }
  attempts(taskId?: string): Attempt[] {
    const rows = taskId
      ? this.db.query('SELECT task_id, attempt, body FROM worker_attempts WHERE task_id=? ORDER BY attempt').all(taskId)
      : this.db.query('SELECT task_id, attempt, body FROM worker_attempts ORDER BY task_id, attempt').all();
    this.refreshSnapshot();
    return rows.map((row) => {
      const value = row as { task_id: string; attempt: number; body: string };
      const key = `${value.task_id}:${value.attempt}`;
      const cached = this.attemptSnapshot.get(key);
      if (cached) return structuredClone(cached);
      const attempt = this.attemptBody(value)!;
      this.attemptSnapshot.set(key, attempt);
      return structuredClone(attempt);
    });
  }
  /** Read one task's attempts in ascending order without decoding any other task's history. */
  attemptsPage(taskId: string, options: AttemptPageOptions): AttemptPage<Attempt> {
    const { afterAttempt, limit } = attemptPageOptions(taskId, options, this.policy.history.attemptPageSize);
    this.refreshSnapshot();
    const rows = this.db
      .query(
        'SELECT task_id, attempt, body FROM worker_attempts WHERE task_id=? AND attempt>? ORDER BY attempt LIMIT ?',
      )
      .all(taskId, afterAttempt, limit + 1) as { task_id: string; attempt: number; body: string }[];
    const pageRows = rows.slice(0, limit);
    const hasMore = rows.length > limit;
    const items = pageRows.map((value) => {
      const key = `${value.task_id}:${value.attempt}`;
      const cached = this.attemptSnapshot.get(key);
      if (cached) return structuredClone(cached);
      const attempt = this.attemptBody(value)!;
      this.attemptSnapshot.set(key, attempt);
      return structuredClone(attempt);
    });
    return {
      items,
      hasMore,
      ...(hasMore && pageRows.length ? { nextAfter: pageRows[pageRows.length - 1]!.attempt } : {}),
    };
  }
  /** Current process-bearing attempts are bounded by the active-task index and one attempt-key lookup each. */
  activeAttempts(): Attempt[] {
    this.refreshSnapshot();
    return this.db
      .query(
        `SELECT a.task_id, a.attempt, a.body
         FROM worker_tasks AS t INDEXED BY worker_tasks_state
         JOIN worker_attempts AS a ON a.task_id=t.id AND a.attempt=t.current_attempt
         WHERE json_extract(t.body, '$.state') IN ('held','ready','running','landing','stopped')
           AND json_extract(a.body, '$.state') IN ('pending','running','waiting','exited')
         ORDER BY a.task_id, a.attempt`,
      )
      .all()
      .map((row) => {
        const value = row as { task_id: string; attempt: number; body: string };
        const key = `${value.task_id}:${value.attempt}`;
        const cached = this.attemptSnapshot.get(key);
        if (cached) return structuredClone(cached);
        const attempt = this.attemptBody(value)!;
        this.attemptSnapshot.set(key, attempt);
        return structuredClone(attempt);
      });
  }
  /** Reads one state through the attempt state index; used for the host's pending launcher recovery. */
  attemptsInState(state: Attempt['state']): Attempt[] {
    this.refreshSnapshot();
    return this.db
      .query(
        "SELECT task_id, attempt, body FROM worker_attempts WHERE json_extract(body, '$.state') = ? ORDER BY task_id, attempt",
      )
      .all(state)
      .map((row) => {
        const value = row as { task_id: string; attempt: number; body: string };
        const key = `${value.task_id}:${value.attempt}`;
        const cached = this.attemptSnapshot.get(key);
        if (cached) return structuredClone(cached);
        const attempt = this.attemptBody(value)!;
        this.attemptSnapshot.set(key, attempt);
        return structuredClone(attempt);
      });
  }
  /**
   * Candidate work is anchored by running tasks, then follows each task's current-attempt primary key.
   * settle calls store.updateTask to write `landing`; failure paths write `ready`/`stopped`,
   * removing the task from the running-state range.
   */
  orphanSweepCandidates(): { attempt: Attempt; taskState: string; currentAttempt: number }[] {
    return this.db
      .query(`
        /* Running tasks and held tasks with a live worker are bounded before each current-attempt lookup. */
        SELECT a.body AS attempt_body,
               CASE WHEN json_extract(t.body, '$.state') = 'held' THEN 'running'
                    ELSE json_extract(t.body, '$.state') END AS task_state,
               t.current_attempt AS current_attempt
        FROM worker_tasks AS t
        JOIN worker_attempts AS a ON a.task_id = t.id AND a.attempt = t.current_attempt
        WHERE (json_extract(t.body, '$.state') = 'running'
               AND json_extract(a.body, '$.state') IN ('running', 'waiting', 'exited'))
           OR (json_extract(t.body, '$.state') = 'held'
               AND json_extract(a.body, '$.state') = 'running')
      `)
      .all()
      .map((row) => {
        const value = row as { attempt_body: string; task_state: string; current_attempt: number };
        return {
          attempt: JSON.parse(value.attempt_body) as Attempt,
          taskState: value.task_state,
          currentAttempt: value.current_attempt,
        };
      });
  }
  /** Counts current running attempts through the shared live-state index. */
  runningAttemptsCount(): number {
    return this.currentAttemptsCount();
  }
  /** Live sessions (pending start and running) on each pool, for `policy.maxConcurrent`. */
  runningAttemptsByPool(): Record<string, number> {
    return this.countAttemptsByPool(['pending', 'running']);
  }
  /** Started, waiting-check and landing tasks that count against one Goal's start cap. */
  goalInFlightCount(goal: string, excludeTaskId?: string): number {
    if (goal === 'control-plane') return 0;
    const excluded = excludeTaskId ? ' AND id != ?' : '';
    const row = this.db
      .query(
        `SELECT count(*) AS count FROM worker_tasks
         WHERE json_extract(body, '$.brief.goal') = ?
           AND coalesce(json_extract(body, '$.brief.urgent'), 0) != 1
           AND json_extract(body, '$.state') IN ('running', 'landing')${excluded}`,
      )
      .get(...(excludeTaskId ? [goal, excludeTaskId] : [goal])) as { count: number };
    return row.count;
  }
  /** Goal metadata for a live capacity ticket written by an older controller process. */
  taskGoal(taskId: string): string | undefined {
    const row = this.db
      .query("SELECT json_extract(body, '$.brief.goal') AS goal FROM worker_tasks WHERE id=?")
      .get(taskId) as { goal: string | null } | null;
    return typeof row?.goal === 'string' ? row.goal : undefined;
  }
  /** Dispatch sequence used to keep same-Goal ready starts in their accepted order. */
  taskSequence(taskId: string): number | undefined {
    const row = this.db.query('SELECT sequence FROM worker_tasks WHERE id=?').get(taskId) as {
      sequence: number;
    } | null;
    return row?.sequence;
  }
  /** Current task and attempt states let capacity reconcile old live tickets without reading their worktrees. */
  capacityLifecycle(taskId: string):
    | {
        currentAttempt: number;
        taskState: string;
        attemptState?: string;
        attemptStartedAt?: string;
        priorityHeadStart?: boolean;
      }
    | undefined {
    const row = this.db
      .query(`
        SELECT t.current_attempt AS current_attempt,
               json_extract(t.body, '$.state') AS task_state,
               json_extract(a.body, '$.state') AS attempt_state,
               json_extract(a.body, '$.startedAt') AS attempt_started_at,
               CASE WHEN json_extract(t.body, '$.taskClass') = 'critical-path'
                          OR json_extract(t.body, '$.brief.criticalPath') = 1
                          OR json_extract(t.body, '$.brief.target') = 'stabilize'
                    THEN 1 ELSE 0 END AS priority_head_start
        FROM worker_tasks AS t
        LEFT JOIN worker_attempts AS a ON a.task_id=t.id AND a.attempt=t.current_attempt
        WHERE t.id=?
      `)
      .get(taskId) as {
      current_attempt: number;
      task_state: string | null;
      attempt_state: string | null;
      attempt_started_at: string | null;
      priority_head_start: number;
    } | null;
    if (!row || typeof row.task_state !== 'string') return undefined;
    return {
      currentAttempt: row.current_attempt,
      taskState: row.task_state,
      ...(typeof row.attempt_state === 'string' ? { attemptState: row.attempt_state } : {}),
      ...(typeof row.attempt_started_at === 'string' ? { attemptStartedAt: row.attempt_started_at } : {}),
      priorityHeadStart: row.priority_head_start === 1,
    };
  }
  /** Ready, nonurgent tasks accepted earlier than one queued start for the same Goal. */
  goalReadyTaskIdsBefore(goal: string, sequence: number): string[] {
    return (
      this.db
        .query(
          `SELECT id FROM worker_tasks
           WHERE json_extract(body, '$.brief.goal') = ?
             AND coalesce(json_extract(body, '$.brief.urgent'), 0) != 1
             AND json_extract(body, '$.state') = 'ready'
             AND sequence < ?
           ORDER BY sequence`,
        )
        .all(goal, sequence) as { id: string }[]
    ).map((row) => row.id);
  }
  /** Attempts parked on checks; they do not occupy `policy.maxConcurrent`. */
  waitingAttemptsByPool(): Record<string, number> {
    return this.countAttemptsByPool(['waiting']);
  }
  private countAttemptsByPool(states: readonly string[]): Record<string, number> {
    const placeholders = states.map(() => '?').join(', ');
    const rows = this.db
      .query(
        `SELECT json_extract(a.body, '$.pool') AS pool, count(*) AS count
         FROM worker_current_attempts AS c
         JOIN worker_attempts AS a ON a.task_id = c.task_id AND a.attempt = c.current_attempt
         WHERE c.attempt_state IN (${placeholders})
         GROUP BY 1`,
      )
      .all(...states) as { pool: string | null; count: number }[];
    const counts: Record<string, number> = {};
    for (const row of rows) if (typeof row.pool === 'string' && row.pool) counts[row.pool] = row.count;
    return counts;
  }
  /** Count current attempts in the requested host lane; a waiting urgent attempt retains its reserved slot. */
  capacityAttemptsCount(urgent: boolean, taskId?: string, attempt?: number): number {
    // Both lanes count live sessions only. Counting parked urgent attempts filled all 8 urgent slots with checks
    // waiting and starved every urgent start for hours (2026-11-06).
    return this.currentAttemptsCount(urgent, false, taskId, attempt);
  }
  private currentAttemptsCount(urgent?: boolean, includeWaiting = false, taskId?: string, attempt?: number): number {
    const liveStates = "attempt_state IN ('running', 'waiting')";
    const states = includeWaiting ? liveStates : `${liveStates} AND attempt_state='running'`;
    const lane = urgent === undefined ? '' : ` AND urgent=${urgent ? 1 : 0}`;
    let excludeCurrent = '';
    let bindings: (string | number)[] = [];
    if (taskId !== undefined && attempt !== undefined) {
      excludeCurrent = ' AND NOT (task_id=? AND current_attempt=?)';
      bindings = [taskId, attempt];
    }
    const row = this.db
      .query(
        `SELECT count(*) AS count FROM worker_current_attempts INDEXED BY worker_current_attempts_state WHERE ${states}${lane}${excludeCurrent}`,
      )
      .get(...bindings) as { count: number };
    return row.count;
  }
  /** Retained unbound UUID evidence. Classification affects only logical admission, never physical custody. */
  historicalProofChecks(goal?: string): HistoricalProofCheck[] {
    return this.db
      .query(`SELECT a.task_id, a.attempt, a.body, t.body AS task FROM worker_attempts a JOIN worker_tasks t ON t.id=a.task_id
      WHERE a.attempt=json_extract(t.body,'$.currentAttempt')
      AND json_extract(a.body,'$.state') IN ('running','waiting')
      AND json_extract(t.body,'$.state') NOT IN ('stopped','cancelled','integrated','merged','verified')
      AND json_array_length(json_extract(a.body,'$.checks')) > 0
      AND (? IS NULL OR json_extract(t.body,'$.brief.goal')=?)
      AND NOT EXISTS (SELECT 1 FROM worker_proof_reservations p WHERE p.task_id=a.task_id AND p.attempt=a.attempt)`)
      .all(goal ?? null, goal ?? null)
      .flatMap((raw) => {
        const row = raw as { task_id: string; attempt: number; body: string; task: string };
        const attempt = decode<Attempt>(row)!;
        const task = decode<Task>({ body: row.task })!;
        return [...new Set(attempt.checks ?? [])]
          .filter(
            (checkId) =>
              nativeCheckId.test(checkId) &&
              !this.db
                .query(`SELECT 1 FROM worker_events
          WHERE task_id=? AND attempt=? AND kind='historical-proof-terminal' AND json_extract(body,'$.checkId')=?`)
                .get(row.task_id, row.attempt, checkId),
          )
          .map((checkId) => ({ taskId: row.task_id, attempt: row.attempt, checkId, cwd: task.worktree }));
      });
  }
  classifyHistoricalProof(check: HistoricalProofCheck, admission: HistoricalProofAdmission): void {
    this.db
      .transaction(() => {
        if (!this.historicalProofChecks().some((entry) => isDeepStrictEqual(entry, check))) return;
        const previous = this.db
          .query(`SELECT body FROM worker_events WHERE task_id=? AND attempt=?
        AND kind='historical-proof-classified' AND json_extract(body,'$.checkId')=? ORDER BY sequence DESC LIMIT 1`)
          .get(check.taskId, check.attempt, check.checkId) as { body: string } | null;
        const body = { checkId: check.checkId, admission };
        if (previous && isDeepStrictEqual(JSON.parse(previous.body), body)) return;
        this.db
          .query('INSERT INTO worker_events(task_id,attempt,kind,at,body) VALUES (?,?,?,?,?)')
          .run(
            check.taskId,
            check.attempt,
            'historical-proof-classified',
            new Date().toISOString(),
            JSON.stringify(body),
          );
      })
      .immediate();
  }
  /** Diagnostic only: a missing reader cannot reclassify history or release logical/physical custody. */
  historicalProofReaderUnavailable(check: HistoricalProofCheck, cause: string): void {
    this.db
      .transaction(() => {
        const previous = this.db
          .query(`SELECT body FROM worker_events
        WHERE kind='historical-proof-reader-unavailable' ORDER BY sequence DESC LIMIT 1`)
          .get() as { body: string } | null;
        const body = JSON.stringify({ cause: cause.slice(0, this.policy.history.diagnosticCharacters) });
        if (previous?.body === body) return;
        this.db
          .query('INSERT INTO worker_events(task_id,attempt,kind,at,body) VALUES (?,?,?,?,?)')
          .run(check.taskId, check.attempt, 'historical-proof-reader-unavailable', new Date().toISOString(), body);
      })
      .immediate();
  }
  /** Only the current running/waiting check IDs count; optional historical custody cannot gate execution. */
  historicalProofSlots(goal?: string): HistoricalProofCheck[] {
    return this.historicalProofChecks(goal);
  }
  observeHistoricalProof(check: HistoricalProofCheck, observation: ProofObservation): void {
    if (observation.status !== 'terminal' || observation.passed)
      throw new Error('Historical custody cannot authorize proof');
    this.db
      .transaction(() => {
        if (!this.historicalProofChecks().some((entry) => isDeepStrictEqual(entry, check))) return;
        this.db
          .query('INSERT INTO worker_events(task_id,attempt,kind,at,body) VALUES (?,?,?,?,?)')
          .run(
            check.taskId,
            check.attempt,
            'historical-proof-terminal',
            new Date().toISOString(),
            JSON.stringify({ checkId: check.checkId, observation }),
          );
      })
      .immediate();
  }
  /** Current ordinary proof incarnations reserve one slot before preparation, across waits and controller crashes. */
  private ordinaryProofSlots(goal: string): { taskId: string; attempt: number; state: Attempt['state'] }[] {
    return this.db
      .query(`SELECT t.id AS taskId, a.attempt, json_extract(a.body,'$.state') AS state
      FROM worker_tasks t JOIN worker_attempts a ON a.task_id=t.id AND a.attempt=json_extract(t.body,'$.currentAttempt')
      WHERE json_extract(t.body,'$.brief.goal')=? AND json_extract(t.body,'$.brief.kind')='verification'
      AND json_extract(t.body,'$.proofAuthorization.fingerprint') IS NOT NULL
      AND json_extract(t.body,'$.state') NOT IN ('stopped','cancelled','integrated','merged','verified')
      AND json_extract(a.body,'$.state') IN ('pending','running','waiting')`)
      .all(goal) as { taskId: string; attempt: number; state: Attempt['state'] }[];
  }
  proofCapacityAvailable(goal: string, taskId: string): boolean {
    const ordinary = this.ordinaryProofSlots(goal);
    const historical = this.historicalProofSlots(goal).filter(
      (check) => !ordinary.some((slot) => slot.taskId === check.taskId && slot.attempt === check.attempt),
    );
    // An orphaned pending preparation may be replaced, but an active command cannot be retried by admission.
    return (
      ordinary.filter((slot) => slot.taskId !== taskId).length + historical.length < this.policy.proof.concurrency &&
      !ordinary.some((slot) => slot.taskId === taskId && slot.state !== 'pending') &&
      !historical.some((check) => check.taskId === taskId)
    );
  }
  proofCapacityReason(goal: string, taskId: string): string {
    const ordinary = this.ordinaryProofSlots(goal);
    const checks = this.historicalProofSlots(goal).filter(
      (check) => !ordinary.some((slot) => slot.taskId === check.taskId && slot.attempt === check.attempt),
    );
    return (
      `Proof cap ${this.policy.proof.concurrency} pending: ${ordinary.length} current ordinary runs; current running/waiting checks: ` +
      (checks.map((check) => `${check.checkId} (${check.taskId}/${check.attempt})`).join(', ') || 'none') +
      `; requesting task ${taskId}. Historical and stopped/exited runs do not occupy logical slots; physical leases remain independent`
    );
  }
  /** The existing store write transaction owns admission across every controller and detached model exit. */
  reserveProof(binding: ProofBinding): ProofReservation | null {
    return this.write(binding, () => {
      const task = this.task(binding.taskId);
      if (
        task.brief.kind !== 'verification' ||
        binding.attempt < 1 ||
        task.proofAuthorization?.fingerprint !== proofFingerprint(task.brief) ||
        binding.goal !== task.brief.goal ||
        binding.sourceCommit !== task.brief.proof?.sourceCommit ||
        binding.sourceTree !== task.proofAuthorization.sourceTree ||
        binding.cwd !== task.worktree ||
        !isDeepStrictEqual(binding.argv, task.brief.acceptance.command)
      )
        throw new Error('proof admission requires registered exact source and command');
      const existing = this.proofReservation(binding.taskId, binding.attempt);
      if (existing) return existing;
      const ordinary = this.ordinaryProofSlots(binding.goal);
      const historical = this.historicalProofSlots(binding.goal).filter(
        (check) => !ordinary.some((slot) => slot.taskId === check.taskId && slot.attempt === check.attempt),
      );
      if (
        ordinary.filter((slot) => slot.taskId !== binding.taskId).length + historical.length >=
          this.policy.proof.concurrency ||
        historical.some((check) => check.taskId === binding.taskId)
      )
        return null;
      const run: ProofReservation = { binding: structuredClone(binding), status: 'reserved' };
      this.db
        .query('INSERT INTO worker_proof_reservations VALUES (?,?,?,?,?,?)')
        .run(binding.reservationToken, binding.goal, binding.taskId, binding.attempt, run.status, JSON.stringify(run));
      this.event(binding, 'proof-reserved', run);
      return run;
    });
  }
  proofReservation(taskId: string, attempt: number): ProofReservation | undefined {
    return decode<ProofReservation>(
      this.db.query('SELECT body FROM worker_proof_reservations WHERE task_id=? AND attempt=?').get(taskId, attempt),
    );
  }
  bindProof(binding: ProofBinding, outcome: ProofBindResult): ProofReservation {
    return this.write(binding, () => {
      const run = this.proofReservation(binding.taskId, binding.attempt);
      if (!run || !isDeepStrictEqual(run.binding, binding)) throw new Error('proof reservation identity changed');
      if (run.status !== 'reserved')
        throw new Error('proof binding may be attempted only once; recover its durable result');
      if (outcome.status === 'bound' && isDeepStrictEqual(outcome.binding, binding)) {
        run.status = 'bound';
        if (outcome.native) run.native = structuredClone(outcome.native);
      } else if (outcome.status === 'refused' && outcome.provenNeverStarted) run.status = 'released';
      else run.status = 'unknown';
      if (outcome.status !== 'bound') run.cause = outcome.cause;
      this.saveProof(run);
      this.event(binding, 'proof-binding', { outcome, run });
      return run;
    });
  }
  activeProofReservations(): ProofReservation[] {
    return this.db
      .query("SELECT body FROM worker_proof_reservations WHERE status!='released'")
      .all()
      .map((row) => decode<ProofReservation>(row)!);
  }
  boundProofReservations(): ProofReservation[] {
    return this.db
      .query("SELECT body FROM worker_proof_reservations WHERE status='bound'")
      .all()
      .map((row) => decode<ProofReservation>(row)!);
  }
  observeProof(binding: ProofBinding, observation: ProofObservation): void {
    // Native ownership survives task cancellation/supersession. Reconcile its token without advancing source state.
    this.db
      .transaction(() => {
        const run = this.proofReservation(binding.taskId, binding.attempt);
        if (
          !run ||
          !isDeepStrictEqual(run.binding, binding) ||
          !['bound', 'released', ...(observation.status === 'terminal' ? ['reserved', 'unknown'] : [])].includes(
            run.status,
          )
        )
          throw new Error('proof observation has no owned binding');
        if (run.status === 'released') {
          if (!isDeepStrictEqual(run.observation, observation)) throw new Error('terminal proof evidence is immutable');
          return;
        }
        run.observation = observation;
        if (observation.status === 'terminal') run.status = 'released';
        this.saveProof(run);
        this.db
          .query('INSERT INTO worker_events(task_id,attempt,kind,at,body) VALUES (?,?,?,?,?)')
          .run(
            binding.taskId,
            binding.attempt,
            'proof-observed',
            new Date().toISOString(),
            JSON.stringify(observation),
          );
      })
      .immediate();
  }
  /** Release logical permits only. Never signal checks, rewrite observations or release physical leases. */
  releaseExitedProofReservations(ref: AttemptRef, requireExitedOwners = false): string[] {
    return this.db
      .transaction(() => {
        const task = this.task(ref.taskId);
        if (task.currentAttempt !== ref.attempt) throw new StaleAttemptError(ref, task.currentAttempt);
        const current = ref.attempt ? this.attempt(ref) : undefined;
        if (
          !current ||
          !['stopped', 'exited', 'cancelled', 'superseded'].includes(current.state) ||
          ['running', 'landing'].includes(task.state)
        )
          throw new Error('logical proof release requires a stopped or exited current attempt');
        const reservation = this.proofReservation(task.id, ref.attempt);
        const starts = this.events(task.id, ref.attempt).filter((event) =>
          ['proof-reserved', 'proof-binding', 'proof-command-ready'].includes(event.kind),
        );
        if (task.brief.kind !== 'verification' && !reservation && !starts.length) return [];
        const owners = [current];
        if (
          owners.some(
            (owner) =>
              !['stopped', 'exited', 'cancelled', 'superseded'].includes(owner.state) || this.hasLiveProofOwner(owner),
          )
        ) {
          if (requireExitedOwners)
            throw new Error('logical proof release refuses live or uncertain worker/driver ownership');
          return []; // An unrelated host sweep/settler must continue without granting continuation authority.
        }
        const released: string[] = [];
        for (const run of reservation && reservation.status !== 'released' ? [reservation] : []) {
          const owner = this.attempt(run.binding);
          if (!['stopped', 'exited', 'cancelled', 'superseded'].includes(owner.state)) continue;
          run.status = 'released';
          run.logicalRelease = {
            reason:
              'Ordinary proof policy: stopped or exited logical run; native custody remains independent and may be unknown',
            at: new Date().toISOString(),
          };
          this.saveProof(run);
          this.db
            .query('INSERT INTO worker_events(task_id,attempt,kind,at,body) VALUES (?,?,?,?,?)')
            .run(task.id, run.binding.attempt, 'proof-logical-released', run.logicalRelease.at, JSON.stringify(run));
          released.push(run.binding.checkId);
        }
        // Retain the policy disposition for this generation, including ordinary runs without optional bindings.
        // It is evidence only: a stopped/exited retry never requires this event or physical cleanup.
        for (const owner of owners) {
          if (this.events(task.id, owner.attempt).some((event) => event.kind === 'proof-logical-reconciled')) continue;
          this.db.query('INSERT INTO worker_events(task_id,attempt,kind,at,body) VALUES (?,?,?,?,?)').run(
            task.id,
            owner.attempt,
            'proof-logical-reconciled',
            new Date().toISOString(),
            JSON.stringify({
              reason:
                'Ordinary proof policy: exited logical incarnation may be followed by a newly authorized capture; physical custody remains unknown or independently recorded',
              expectedAttempt: ref.attempt,
              state: owner.state,
              process: owner.process,
              driver: owner.driver,
              auxiliaryProcesses: owner.auxiliaryProcesses ?? [],
              checks: owner.checks,
            }),
          );
        }
        return released;
      })
      .immediate();
  }
  private saveProof(run: ProofReservation): void {
    this.db
      .query('UPDATE worker_proof_reservations SET status=?,body=? WHERE token=?')
      .run(run.status, JSON.stringify(run), run.binding.reservationToken);
    const task = this.task(run.binding.taskId);
    if (task.currentAttempt === run.binding.attempt) {
      task.proofRun = run;
      this.saveTask(task);
    }
  }
  /** Attempts that ended within a time window, using an index so older attempt bodies are not read. */
  attemptsEndedBetween(start: string, end: string): Attempt[] {
    return this.db
      .query(
        "SELECT body FROM worker_attempts WHERE json_extract(body, '$.endedAt') >= ? AND json_extract(body, '$.endedAt') <= ? ORDER BY task_id, attempt",
      )
      .all(start, end)
      .map((row) => decode<Attempt>(row)!);
  }
  records(): AttemptRecord[] {
    return this.db
      .query('SELECT body FROM worker_records ORDER BY task_id, attempt')
      .all()
      .map((row) => decode<AttemptRecord>(row)!);
  }
  /** Read a bounded page of one task's records without decoding unrelated task histories. */
  recordsPage(taskId: string, options: AttemptPageOptions): AttemptPage<AttemptRecord> {
    const { afterAttempt, limit } = attemptPageOptions(taskId, options, this.policy.history.attemptPageSize);
    const rows = this.db
      .query('SELECT attempt, body FROM worker_records WHERE task_id=? AND attempt>? ORDER BY attempt LIMIT ?')
      .all(taskId, afterAttempt, limit + 1) as { attempt: number; body: string }[];
    const pageRows = rows.slice(0, limit);
    const hasMore = rows.length > limit;
    return {
      items: pageRows.map((row) => decode<AttemptRecord>(row)!),
      hasMore,
      ...(hasMore && pageRows.length ? { nextAfter: pageRows[pageRows.length - 1]!.attempt } : {}),
    };
  }
  record(ref: AttemptRef): AttemptRecord | undefined {
    return decode<AttemptRecord>(
      this.db.query('SELECT body FROM worker_records WHERE task_id=? AND attempt=?').get(ref.taskId, ref.attempt),
    );
  }
  assertCurrent(ref: AttemptRef): void {
    const task = this.task(ref.taskId);
    if (task.currentAttempt !== ref.attempt) throw new StaleAttemptError(ref, task.currentAttempt);
    // An accepted stop owns settlement even if its controller died before closing the attempt.
    if (ref.attempt > 0) {
      const intent = this.attempt(ref).terminationIntent;
      if (intent && !intent.settledAt) throw new StaleAttemptError(ref, task.currentAttempt);
    }
    // A hold advances the task's delivery generation without manufacturing another worker attempt. A request or
    // outcome already in the train must be acknowledged as stale instead of integrating over that held generation.
    if (task.state === 'held' && ('branch' in ref || 'stage' in ref))
      throw new StaleAttemptError(ref, task.currentAttempt);
    // A pending launcher or check wake belongs to the old contract; only an already-running worker may finish settling.
    if (task.state === 'held' && ref.attempt > 0 && ['pending', 'waiting'].includes(this.attempt(ref).state))
      throw new StaleAttemptError(ref, task.currentAttempt);
    if (ref.attempt > 0 && ['superseded', 'stopped', 'cancelled'].includes(this.attempt(ref).state))
      throw new StaleAttemptError(ref, task.currentAttempt);
  }
  commitMerge(ref: AttemptRef, merge: () => string): string {
    return this.write(ref, () => {
      const task = this.task(ref.taskId);
      if (task.state === 'integrated' || task.state === 'merged') throw new Error('attempt already integrated');
      const commit = merge();
      if (!commit) return '';
      const plan = this.integrationPlan(ref);
      task.state = 'integrated';
      task.integratedCommit = commit;
      if (plan) {
        task.integratedBase = plan.base;
        task.integratedCommits = plan.commits;
      }
      this.saveTask(task);
      recordFlow(this.db, {
        taskId: ref.taskId,
        attempt: ref.attempt,
        stage: 'integration',
        action: 'integrated',
        at: new Date().toISOString(),
      });
      recordFlow(this.db, {
        taskId: ref.taskId,
        attempt: ref.attempt,
        stage: 'dev-update',
        action: 'updated',
        at: new Date().toISOString(),
      });
      if (plan) this.clearIntegrationPlan(ref);
      return commit;
    });
  }
  planIntegration(ref: AttemptRef, base: string, commit: string, commits: readonly string[]): void {
    this.write(ref, () => {
      const plan: IntegrationPlan = { ...ref, base, commit, commits: [...commits] };
      this.db
        .query('INSERT OR REPLACE INTO worker_integration_plans VALUES (?,?,?)')
        .run(ref.taskId, ref.attempt, JSON.stringify(plan));
    });
  }
  integrationPlan(ref: AttemptRef): IntegrationPlan | undefined {
    return decode<IntegrationPlan>(
      this.db
        .query('SELECT body FROM worker_integration_plans WHERE task_id=? AND attempt=?')
        .get(ref.taskId, ref.attempt),
    );
  }
  /** Reopen only a delivered successful dev landing whose saved candidate differs from its reported commit. */
  reconcileFalseIntegratedLanding(
    ref: AttemptRef,
    evidence: { publishedCommit: string; candidate: string; request: LandingRequest; outcome: GateOutcome },
  ): boolean {
    return this.write(ref, () => {
      if (this.events(ref.taskId, ref.attempt).some((event) => event.kind === 'false-integration-reconciled'))
        return false;
      const task = this.task(ref.taskId);
      if (
        task.state !== 'integrated' ||
        task.integratedCommit !== evidence.publishedCommit ||
        task.brief.target === 'main' ||
        task.brief.target === 'stabilize' ||
        task.brief.kind === 'verification'
      )
        throw new Error('Task is not the expected current dev integration');
      const row = this.db
        .query('SELECT id, request, outcome, delivered, candidate, batch FROM landing_queue WHERE task=? AND attempt=?')
        .get(ref.taskId, ref.attempt) as {
        id: number;
        request: string;
        outcome: string | null;
        delivered: number;
        candidate: string | null;
        batch: string | null;
      } | null;
      if (!row || !row.outcome || row.delivered !== 1 || row.batch !== null)
        throw new Error('False integration has no delivered single-landing outcome');
      const request = JSON.parse(row.request) as LandingRequest;
      const outcome = JSON.parse(row.outcome) as GateOutcome;
      if (
        !isDeepStrictEqual(request, evidence.request) ||
        !isDeepStrictEqual(outcome, evidence.outcome) ||
        row.candidate !== evidence.candidate ||
        request.taskId !== ref.taskId ||
        request.attempt !== ref.attempt ||
        request.branch !== task.branch ||
        request.worktree !== task.worktree ||
        !request.workerCommit ||
        request.unchangedClaim ||
        !outcome.passed ||
        outcome.stage !== 'merge' ||
        outcome.mergedCommit !== evidence.publishedCommit ||
        !outcome.changedFiles.length ||
        !evidence.candidate
      )
        throw new Error('False integration provenance changed before reconciliation');

      const replay = { ...request };
      delete replay.devResolution;
      const updated = this.db
        .query(
          'UPDATE landing_queue SET request=?, outcome=NULL, delivered=0, candidate=NULL, batch=NULL, resolving=0 WHERE id=? AND outcome=? AND delivered=1 AND candidate=? AND batch IS NULL',
        )
        .run(JSON.stringify(replay), row.id, row.outcome, evidence.candidate);
      if (updated.changes !== 1) throw new Error('False integration landing changed before reconciliation');

      const at = new Date().toISOString();
      this.db.query('INSERT INTO worker_events(task_id,attempt,kind,at,body) VALUES (?,?,?,?,?)').run(
        ref.taskId,
        ref.attempt,
        'false-integration-reconciled',
        at,
        JSON.stringify({
          publishedCommit: evidence.publishedCommit,
          candidate: evidence.candidate,
          request,
          outcome,
          taskIntegration: {
            integratedBase: task.integratedBase,
            integratedCommits: task.integratedCommits,
            integratedCommit: task.integratedCommit,
            mergedCommit: task.mergedCommit,
          },
        }),
      );
      task.state = 'landing';
      delete task.integratedBase;
      delete task.integratedCommits;
      delete task.integratedCommit;
      delete task.mergedCommit;
      this.saveTask(task);
      recordFlow(this.db, {
        taskId: ref.taskId,
        attempt: ref.attempt,
        stage: 'landing',
        action: 'false-integration-reconciled',
        at,
        detail: JSON.stringify({ publishedCommit: evidence.publishedCommit, candidate: evidence.candidate }),
      });
      return true;
    });
  }
  clearIntegrationPlan(ref: AttemptRef): void {
    this.db.query('DELETE FROM worker_integration_plans WHERE task_id=? AND attempt=?').run(ref.taskId, ref.attempt);
  }
  promotion(): PromotionRun | undefined {
    return decode<PromotionRun>(this.db.query('SELECT body FROM worker_promotions WHERE id=1').get());
  }
  devVerifierRun(key: string): DevVerifierRun | undefined {
    return decode<DevVerifierRun>(this.db.query('SELECT body FROM dev_verifier_runs WHERE cache_key=?').get(key));
  }
  devVerifierLatestRound(): DevVerifierRun | undefined {
    const run = decode<DevVerifierRun>(
      this.db
        .query(
          "SELECT body FROM dev_verifier_runs WHERE cache_key LIKE 'dev-verifier-round:%' ORDER BY rowid DESC LIMIT 1",
        )
        .get(),
    );
    return run?.round ? run : undefined;
  }
  saveDevVerifierRun(run: DevVerifierRun): void {
    this.db
      .transaction(() => {
        this.db
          .query('INSERT OR REPLACE INTO dev_verifier_runs VALUES (?,?,?)')
          .run(run.key, run.createdAt, JSON.stringify(run));
        this.db
          .query(
            'DELETE FROM dev_verifier_runs WHERE cache_key IN (SELECT cache_key FROM dev_verifier_runs ORDER BY rowid DESC LIMIT -1 OFFSET ?)',
          )
          .run(this.policy.verifier.runRows);
      })
      .immediate();
  }
  devVerifierFindings(limit = this.policy.verifier.findingRows): DevVerifierFinding[] {
    return this.db
      .query('SELECT body FROM dev_verifier_findings ORDER BY rowid DESC LIMIT ?')
      .all(Math.max(0, Math.min(this.policy.verifier.findingRows, limit)))
      .map((row) => decode<DevVerifierFinding>(row)!);
  }
  saveDevVerifierFinding(finding: DevVerifierFinding): void {
    this.db
      .transaction(() => {
        this.db
          .query('INSERT OR REPLACE INTO dev_verifier_findings VALUES (?,?,?,?,?,?,?,?)')
          .run(
            finding.rangeKey,
            finding.identity,
            finding.signature,
            finding.baseCommit,
            finding.headCommit,
            finding.status,
            finding.createdAt,
            JSON.stringify(finding),
          );
        this.db
          .query(
            'DELETE FROM dev_verifier_findings WHERE range_key IN (SELECT range_key FROM dev_verifier_findings ORDER BY rowid DESC LIMIT -1 OFFSET ?)',
          )
          .run(this.policy.verifier.findingRows);
      })
      .immediate();
  }
  savePromotion(run: PromotionRun): void {
    this.db
      .transaction(() => {
        this.db.query('INSERT OR REPLACE INTO worker_promotions VALUES (1,?)').run(JSON.stringify(run));
      })
      .immediate();
  }
  commitBatchMerge(members: readonly (AttemptRef & { commit: string })[], merge: () => string): string {
    if (!members.length) throw new Error('a landing batch must contain at least one member');
    return this.db
      .transaction(() => {
        const tasks = members.map((member) => {
          this.assertCurrent(member);
          const task = this.task(member.taskId);
          if (task.state === 'integrated' || task.state === 'merged') return { member, task, plan: undefined };
          const plan = this.integrationPlan(member);
          if (plan && plan.commit !== member.commit)
            throw new Error('batch member does not match its integration plan');
          return { member, task, plan };
        });
        const pending = tasks.filter(({ task }) => task.state !== 'integrated' && task.state !== 'merged');
        if (!pending.length) return members[members.length - 1]!.commit;
        const head = merge();
        if (!head) return '';
        if (head !== members[members.length - 1]!.commit)
          throw new Error('batch head does not match its final member commit');
        for (const { member, task, plan } of pending) {
          task.state = 'integrated';
          task.integratedCommit = member.commit;
          if (plan) {
            task.integratedBase = plan.base;
            task.integratedCommits = plan.commits;
          }
          this.saveTask(task);
          recordFlow(this.db, {
            taskId: member.taskId,
            attempt: member.attempt,
            stage: 'integration',
            action: 'integrated',
            at: new Date().toISOString(),
          });
          recordFlow(this.db, {
            taskId: member.taskId,
            attempt: member.attempt,
            stage: 'dev-update',
            action: 'updated',
            at: new Date().toISOString(),
          });
          if (plan) this.clearIntegrationPlan(member);
        }
        return head;
      })
      .immediate();
  }
  /** Recover a current landing attempt only when its durable queue entry has disappeared. */
  recoverOrphanedLanding(
    ref: AttemptRef,
    failure: NonNullable<Attempt['failure']>,
    options: RetryIntent['options'],
    event: ManagerEvent,
  ): boolean {
    const recovered = this.db
      .transaction(() => {
        this.assertCurrent(ref);
        const task = this.task(ref.taskId);
        if (task.state !== 'landing' || this.retryIntent(ref)?.status === 'pending') return false;
        const queueExists = this.db
          .query("SELECT 1 FROM sqlite_master WHERE type='table' AND name='landing_queue'")
          .get();
        if (!queueExists) return false;
        if (
          this.db
            .query('SELECT 1 FROM landing_queue WHERE task=? AND attempt=? AND delivered=0 LIMIT 1')
            .get(ref.taskId, ref.attempt)
        )
          return false;
        if (
          this.db
            .query(
              "SELECT 1 FROM worker_events WHERE task_id=? AND attempt=? AND kind='orphaned-landing-recovered' LIMIT 1",
            )
            .get(ref.taskId, ref.attempt)
        )
          return false;

        const attempt = this.attempt(ref);
        attempt.failure = failure;
        attempt.failureLogPath = attempt.logPath;
        attempt.escalation = 'environment';
        attempt.approaches.push({
          approach: `Attempt ${attempt.attempt}: recover orphaned landing`,
          result: failure.assertion,
        });
        this.saveAttempt(attempt);
        const record = this.record(ref);
        if (record) {
          record.escalation = 'environment';
          record.firstFailure = failure.fingerprint;
          record.outcome = 'gate-failed';
          this.saveRecord(record);
        }
        task.state = 'ready';
        this.saveTask(task);
        const at = new Date().toISOString();
        const intent: RetryIntent = { ...ref, options, status: 'pending', queuedAt: at };
        this.db
          .query('INSERT OR REPLACE INTO worker_retry_intents VALUES (?,?,?)')
          .run(ref.taskId, ref.attempt, JSON.stringify(intent));
        this.db
          .query('INSERT INTO worker_events(task_id,attempt,kind,at,body) VALUES (?,?,?,?,?)')
          .run(ref.taskId, ref.attempt, 'orphaned-landing-recovered', at, JSON.stringify({ failure, options }));
        this.db
          .query('INSERT INTO worker_events(task_id,attempt,kind,at,body) VALUES (?,?,?,?,?)')
          .run(ref.taskId, ref.attempt, 'manager-event', at, JSON.stringify(event));
        return true;
      })
      .immediate();
    this.invalidateSnapshot();
    return recovered;
  }
  clearPromotion(): void {
    this.db.query('DELETE FROM worker_promotions WHERE id=1').run();
  }
  applyPromotionFailure(culprit: string, dependents: readonly string[]): void {
    this.db
      .transaction(() => {
        const task = this.task(culprit);
        if (task.state === 'integrated') {
          task.state = 'landing';
          this.saveTask(task);
        }
        for (const id of dependents) {
          const dependent = this.task(id);
          if (dependent.state === 'integrated') {
            dependent.state = 'held';
            this.saveTask(dependent);
          }
        }
      })
      .immediate();
  }
  markPromoted(taskIds: readonly string[], commit: string): void {
    this.db
      .transaction(() => {
        for (const id of taskIds) {
          const task = this.task(id);
          if (task.state === 'integrated') {
            task.state = 'merged';
            task.mergedCommit = commit;
            this.saveTask(task);
          }
        }
      })
      .immediate();
  }
  publishPromotion(taskIds: readonly string[], commit: string, advance: () => void): void {
    this.db
      .transaction(() => {
        const tasks = taskIds.map((id) => this.task(id));
        if (tasks.some((task) => !['integrated', 'merged'].includes(task.state)))
          throw new Error('promotion batch changed before main advanced');
        advance();
        for (const task of tasks)
          if (task.state === 'integrated') {
            task.state = 'merged';
            task.mergedCommit = commit;
            this.saveTask(task);
          }
      })
      .immediate();
  }
  saveRetryIntent(ref: AttemptRef, options: RetryIntent['options']): void {
    this.db
      .transaction(() => {
        const existing = this.retryIntent(ref);
        if (!existing) {
          const intent: RetryIntent = { ...ref, options, status: 'pending', queuedAt: new Date().toISOString() };
          this.db
            .query('INSERT INTO worker_retry_intents VALUES (?,?,?)')
            .run(ref.taskId, ref.attempt, JSON.stringify(intent));
        }
      })
      .immediate();
  }
  /** Save the old contract's real classification before a supported proof conversion, never source/token facts. */
  private retainProofPredecessor(before: Task, after: Task): void {
    if (!before.currentAttempt || after.brief.kind !== 'verification') return;
    if (before.brief.kind === 'verification') {
      if (proofFingerprint(before.brief) === proofFingerprint(after.brief)) return;
      this.db.query('INSERT INTO worker_events(task_id,attempt,kind,at,body) VALUES (?,?,?,?,?)').run(
        before.id,
        before.currentAttempt,
        'proof-registration-replaced',
        new Date().toISOString(),
        JSON.stringify({
          previousFingerprint: proofFingerprint(before.brief),
          newFingerprint: proofFingerprint(after.brief),
          brief: before.brief,
          briefPath: before.briefPath,
          authorization: before.proofAuthorization,
          worktree: before.worktree,
          base: before.base,
          proofRun: before.proofRun,
        }),
      );
    }
    const ref = { taskId: before.id, attempt: before.currentAttempt };
    if (!this.record(ref)) {
      const attempt = this.attempt(ref);
      this.saveRecord(makeRecord(before, attempt, readMeasurement(attempt, { policy: this.policy }), 'stopped'));
    }
  }
  /** Called inside the lifecycle transaction as well as before writing a submitted brief. */
  assertProofRegistration(ref: AttemptRef, brief: Brief): void {
    const task = this.task(ref.taskId);
    this.assertProofFirstStart(ref, brief);
    if (task.brief.goal !== brief.goal || task.brief.manager !== brief.manager)
      throw new Error('a reshaped brief must keep the same goal and manager');
  }
  /** A stopped/exited generation may register its next capture; historical reservations are evidence only. */
  assertProofFirstStart(ref: AttemptRef, brief: Brief): void {
    const task = this.task(ref.taskId);
    if (task.currentAttempt !== ref.attempt) throw new StaleAttemptError(ref, task.currentAttempt);
    const attempt = ref.attempt > 0 ? this.attempt(ref) : undefined;
    const retryable =
      ['ready', 'held', 'stopped'].includes(task.state) ||
      (['running', 'landing'].includes(task.state) && attempt?.state === 'exited');
    if (!retryable) throw new StaleAttemptError(ref, task.currentAttempt);
    if (attempt) {
      if (!['stopped', 'exited'].includes(attempt.state) || this.hasLiveProofOwner(attempt))
        throw new StaleAttemptError(ref, task.currentAttempt);
    }
    this.assertProofContract(task, brief);
  }
  private hasLiveProofOwner(attempt: Attempt): boolean {
    if ([attempt.process, ...(attempt.auxiliaryProcesses ?? [])].some((identity) => identity && sameProcess(identity)))
      return true;
    if (!attempt.driver || !sameProcess(attempt.driver)) return false;
    // An adopting resident driver remains alive after its per-attempt proof settlement is routed.
    return !(
      attempt.state === 'exited' &&
      this.db
        .query("SELECT 1 FROM worker_events WHERE task_id=? AND attempt=? AND kind='proof-failure-routed' LIMIT 1")
        .get(attempt.taskId, attempt.attempt)
    );
  }
  private assertProofContract(task: Task, brief: Brief): void {
    if (
      task.brief.kind === 'verification' &&
      task.brief.proof &&
      !isDeepStrictEqual({ ...task.brief.proof, sourceCommit: brief.proof?.sourceCommit }, brief.proof)
    )
      throw new Error('proof refresh must retain the exact original metadata');
    if (task.brief.kind === 'verification' && !isDeepStrictEqual(task.brief.acceptance, brief.acceptance))
      throw new Error('proof command may never be replaced: proof refresh must retain the exact original acceptance');
  }
  /** Called after publishing the new pending attempt, before preparing its immutable source. */
  assertProofPreparation(ref: AttemptRef): void {
    const task = this.task(ref.taskId);
    if (task.currentAttempt !== ref.attempt) throw new StaleAttemptError(ref, task.currentAttempt);
    const attempt = this.attempt(ref);
    if (
      attempt.state !== 'pending' ||
      [attempt.process, attempt.driver, ...(attempt.auxiliaryProcesses ?? [])].some(
        (identity) => identity && sameProcess(identity),
      ) ||
      this.proofReservation(task.id, ref.attempt) ||
      this.events(task.id, ref.attempt).some((event) =>
        ['proof-reserved', 'proof-binding', 'proof-command-ready'].includes(event.kind),
      )
    )
      throw new Error('a current prepared or reserved proof source may never be replaced');
  }
  /**
   * Record an explicit retry. With amendPending, a retry already waiting to start keeps its place and options, adding
   * the explicit ones, and starts the task as this update leaves it.
   */
  recordExplicitRetry(
    ref: AttemptRef,
    update: (task: Task) => void,
    options: RetryIntent['options'],
    { amendPending = false }: { amendPending?: boolean } = {},
  ): void {
    this.db
      .transaction(() => {
        const task = this.task(ref.taskId);
        if (
          task.currentAttempt !== ref.attempt ||
          ['cancelled', 'integrated', 'merged', 'verified'].includes(task.state) ||
          (ref.attempt > 0 && ['superseded', 'cancelled'].includes(this.attempt(ref).state))
        )
          throw new StaleAttemptError(ref, task.currentAttempt);
        this.assertRetryAllowed(ref, true);
        const before = structuredClone(task);
        update(task);
        this.retainProofPredecessor(before, task);
        if (task.id !== ref.taskId || task.currentAttempt !== ref.attempt)
          throw new Error('task identity cannot be updated');
        this.saveTask(task);
        const existing = this.retryIntent(ref);
        if (existing?.status === 'pending') {
          if (!amendPending) throw new Error('a retry is already pending');
          existing.options = { ...existing.options, ...options };
          this.db
            .query('UPDATE worker_retry_intents SET body=? WHERE task_id=? AND attempt=?')
            .run(JSON.stringify(existing), ref.taskId, ref.attempt);
          return;
        }
        const intent: RetryIntent = { ...ref, options, status: 'pending', queuedAt: new Date().toISOString() };
        this.db
          .query('INSERT OR REPLACE INTO worker_retry_intents VALUES (?,?,?)')
          .run(ref.taskId, ref.attempt, JSON.stringify(intent));
      })
      .immediate();
  }
  retryIntents(): RetryIntent[] {
    return (
      this.db
        // SQLite's rowid is the durable insertion order for intents. A replacement
        // intent receives a new rowid, so recovery follows the order managers queued them.
        .query('SELECT body FROM worker_retry_intents ORDER BY rowid')
        .all()
        .map((row) => decode<RetryIntent>(row)!)
    );
  }
  retryIntent(ref: AttemptRef): RetryIntent | undefined {
    return decode<RetryIntent>(
      this.db.query('SELECT body FROM worker_retry_intents WHERE task_id=? AND attempt=?').get(ref.taskId, ref.attempt),
    );
  }
  saveBriefProposal(record: BriefProposalRecord): PendingBriefProposal {
    return this.db
      .transaction(() => {
        const inserted = this.db
          .query('INSERT INTO worker_brief_proposals(task_id, written_for_attempt, body) VALUES (?,?,?)')
          .run(record.taskId, record.writtenForAttempt, JSON.stringify(record));
        return { ...record, id: Number(inserted.lastInsertRowid) };
      })
      .immediate();
  }
  pendingBriefProposals(taskId: string): PendingBriefProposal[] {
    return this.db
      .query('SELECT id, body FROM worker_brief_proposals WHERE task_id=? ORDER BY id')
      .all(taskId)
      .map((row) => {
        const value = row as { id: number; body: string };
        return { ...JSON.parse(value.body), id: value.id } as PendingBriefProposal;
      });
  }
  newestPendingBriefProposal(taskId: string): PendingBriefProposal | undefined {
    return this.pendingBriefProposals(taskId).at(-1);
  }
  takePendingBriefProposals(taskId: string): PendingBriefProposal[] {
    return this.db
      .transaction(() => {
        const pending = this.pendingBriefProposals(taskId);
        if (pending.length) this.db.query('DELETE FROM worker_brief_proposals WHERE task_id=?').run(taskId);
        return pending;
      })
      .immediate();
  }
  updateRetryIntent(ref: AttemptRef, update: (intent: RetryIntent) => void): RetryIntent {
    return this.db
      .transaction(() => {
        const intent = this.retryIntent(ref);
        if (!intent) throw new Error('unknown retry intent');
        if (intent.status === 'abandoned') return intent;
        const wasPending = intent.status === 'pending';
        const task = this.task(ref.taskId);
        update(intent);
        // Recovery may observe TaskHeldForDependenciesError just after successfully recording the hold. Keep that
        // retry pending until the held generation is released and its next attempt can actually start.
        if (wasPending && intent.status === 'started' && task.state === 'held' && task.currentAttempt === ref.attempt) {
          intent.status = 'pending';
          delete intent.nextAttempt;
        }
        this.db
          .query('UPDATE worker_retry_intents SET body=? WHERE task_id=? AND attempt=?')
          .run(JSON.stringify(intent), ref.taskId, ref.attempt);
        return intent;
      })
      .immediate();
  }
  /** Keep the check and every associated write under BEGIN IMMEDIATE. */
  write<T>(ref: AttemptRef, action: () => T): T {
    try {
      return this.db
        .transaction(() => {
          this.assertCurrent(ref);
          const result = action();
          if (result instanceof Promise) throw new Error('store transactions must be synchronous');
          return result;
        })
        .immediate();
    } finally {
      // Nested task/event writes may populate the cache before the enclosing transaction rolls back.
      this.invalidateSnapshot();
    }
  }
  createTask(
    brief: Brief,
    paths: { briefPath: string; worktree: string; branch: string; base: string },
    taskClass: Task['taskClass'],
    id: string = crypto.randomUUID(),
    proofAuthorization?: Task['proofAuthorization'],
  ): Task {
    const task = this.db
      .transaction(() => {
        const after = brief.after ?? [];
        const dependencies = new Map(after.map((id) => [id, this.dependency(id)]));
        for (const dependency of after)
          if (!dependencies.get(dependency)) throw new Error(`unknown dependency task: ${dependency}`);
        const state = after.every((dependency) =>
          ['integrated', 'merged', 'stopped', 'cancelled'].includes(dependencies.get(dependency)?.state ?? ''),
        )
          ? 'ready'
          : 'held';
        const sequence = (
          this.db.query('SELECT coalesce(max(sequence),0)+1 AS n FROM worker_tasks').get() as { n: number }
        ).n;
        const task: Task = {
          id,
          sequence,
          brief,
          ...paths,
          taskClass,
          state,
          currentAttempt: 0,
          createdAt: new Date().toISOString(),
          ...(proofAuthorization ? { proofAuthorization } : {}),
        };
        this.db.query('INSERT INTO worker_tasks VALUES (?,?,?,?)').run(id, sequence, 0, JSON.stringify(task));
        recordFlow(this.db, { taskId: id, attempt: 0, stage: 'dispatch', action: 'dispatched', at: task.createdAt });
        return task;
      })
      .immediate();
    this.invalidateSnapshot();
    return task;
  }
  private saveTask(task: Task): void {
    if (task.brief.kind === 'verification' && ['landing', 'integrated', 'merged'].includes(task.state))
      throw new Error('proof tasks cannot land or publish source integration');
    if (['integrated', 'merged', 'cancelled', 'stopped'].includes(task.state)) closePendingFlow(this.db, task);
    const previous = this.task(task.id);
    if (
      !sameBriefProposalText(previous.brief.markdown, task.brief.markdown) ||
      previous.brief.manager !== task.brief.manager
    ) {
      // Canonical replacement supersedes existing intent atomically, including if an older brief is later restored.
      this.db
        .query(`INSERT INTO worker_events(task_id,attempt,kind,at,body)
        SELECT ?,?,'owner-contract-decisions-superseded',?,?
        WHERE EXISTS (SELECT 1 FROM worker_events WHERE task_id=? AND kind='owner-contract-decision-accepted')`)
        .run(
          task.id,
          task.currentAttempt,
          new Date().toISOString(),
          JSON.stringify({
            previousContractSha256: briefProposalHash(previous.brief.markdown),
            contractSha256: briefProposalHash(task.brief.markdown),
            previousManager: previous.brief.manager,
            manager: task.brief.manager,
          }),
          task.id,
        );
    }
    this.db
      .query('UPDATE worker_tasks SET current_attempt=?, body=? WHERE id=?')
      .run(task.currentAttempt, JSON.stringify(task), task.id);
    this.invalidateSnapshot();
  }
  private saveAttempt(attempt: Attempt): void {
    this.db
      .query('INSERT OR REPLACE INTO worker_attempts VALUES (?,?,?)')
      .run(attempt.taskId, attempt.attempt, JSON.stringify(attempt));
    this.invalidateSnapshot();
  }
  updateTask(ref: AttemptRef, update: (task: Task) => void): Task {
    return this.write(ref, () => {
      const task = this.task(ref.taskId);
      const previousState = task.state;
      update(task);
      if (task.id !== ref.taskId || task.currentAttempt !== ref.attempt)
        throw new Error('task identity cannot be updated');
      // A held contract is its own delivery generation. A worker or check that was already in flight may settle,
      // but its old contract cannot move the task out of held and publish a landing request.
      if (ref.attempt > 0 && previousState === 'held' && task.state !== 'held')
        throw new StaleAttemptError(ref, task.currentAttempt);
      this.saveTask(task);
      if (previousState !== task.state && task.state === 'running')
        recordFlow(this.db, {
          taskId: ref.taskId,
          attempt: ref.attempt,
          stage: 'start',
          action: 'started',
          at: new Date().toISOString(),
        });
      if (previousState !== task.state && ['integrated', 'merged'].includes(task.state))
        recordFlow(this.db, {
          taskId: ref.taskId,
          attempt: ref.attempt,
          stage: 'integration',
          action: 'integrated',
          at: new Date().toISOString(),
        });
      return task;
    });
  }
  /** Change task-level priority metadata for the exact current generation, even when its attempt is stopped. */
  updatePriorityMetadata(ref: AttemptRef, update: (task: Task) => void): Task {
    const task = this.db
      .transaction(() => {
        const current = this.task(ref.taskId);
        if (current.currentAttempt !== ref.attempt) throw new StaleAttemptError(ref, current.currentAttempt);
        if (current.state === 'cancelled') throw new StaleAttemptError(ref, current.currentAttempt);
        if (ref.attempt > 0) {
          const attempt = this.attempt(ref);
          if (
            ['superseded', 'cancelled'].includes(attempt.state) ||
            (attempt.state === 'stopped' && !['held', 'stopped'].includes(current.state))
          )
            throw new StaleAttemptError(ref, current.currentAttempt);
        }
        const before = structuredClone(current);
        update(current);
        if (current.id !== ref.taskId || current.currentAttempt !== ref.attempt)
          throw new Error('task identity cannot be updated');
        const expected = structuredClone(before);
        expected.brief.criticalPath = current.brief.criticalPath;
        expected.taskClass = current.taskClass;
        if (current.priorityHistory !== undefined) expected.priorityHistory = structuredClone(current.priorityHistory);
        else delete expected.priorityHistory;
        if (current.priorityGrants !== undefined) expected.priorityGrants = structuredClone(current.priorityGrants);
        else delete expected.priorityGrants;
        if (!isDeepStrictEqual(expected, current))
          throw new Error('priority metadata update changed non-priority task fields');
        this.saveTask(current);
        return current;
      })
      .immediate();
    this.invalidateSnapshot();
    return task;
  }
  /** Update a retryable task; abandoning pending is valid only while the caller holds the task lease. */
  updateHeldRetryTask(
    ref: AttemptRef,
    update: (task: Task) => void,
    options: { abandonPending?: boolean; reshapeHeld?: boolean } = {},
  ): Task {
    return this.db
      .transaction(() => {
        const task = this.task(ref.taskId);
        const attempt = ref.attempt > 0 ? this.attempt(ref) : undefined;
        this.assertRetryAllowed(ref, options.reshapeHeld === true);
        const reshapingHeld = options.reshapeHeld === true && task.state === 'held';
        if (task.currentAttempt !== ref.attempt)
          throw new Error(
            `task cannot be held for retry: ${ref.taskId} attempt ${ref.attempt} (task ${task.state} at attempt ${task.currentAttempt}${attempt ? `, attempt ${attempt.state}` : ''})`,
          );
        // A release sweep leaves a live worker in held until that worker settles; it must not touch its worktree.
        if (options.abandonPending && task.state === 'held' && attempt?.state === 'running') return task;
        const abandonPending =
          options.abandonPending === true &&
          !reshapingHeld &&
          (attempt?.state === 'pending' || attempt?.state === 'waiting');
        const abandonHeldTerminal =
          options.abandonPending === true &&
          !reshapingHeld &&
          task.state === 'held' &&
          ['superseded', 'cancelled'].includes(attempt?.state ?? '');
        const abandonAttempt = abandonPending || abandonHeldTerminal;
        const holdableTaskState =
          ['ready', 'stopped', 'held'].includes(task.state) ||
          (['running', 'landing'].includes(task.state) && attempt?.state === 'exited');
        if (
          (attempt && !reshapingHeld && !['stopped', 'exited'].includes(attempt.state) && !abandonAttempt) ||
          !holdableTaskState
        )
          throw new Error(
            `task cannot be held for retry: ${ref.taskId} attempt ${ref.attempt} (task ${task.state} at attempt ${task.currentAttempt}${attempt ? `, attempt ${attempt.state}` : ''})`,
          );
        if (abandonAttempt && attempt) {
          attempt.state = 'stopped';
          attempt.endedAt ??= new Date().toISOString();
          this.saveAttempt(attempt);
        }
        const before = structuredClone(task);
        update(task);
        this.retainProofPredecessor(before, task);
        if (task.id !== ref.taskId || task.currentAttempt !== ref.attempt)
          throw new Error('task identity cannot be updated');
        this.saveTask(task);
        if (reshapingHeld) {
          const intent = this.retryIntent(ref);
          if (intent) {
            if (intent.status === 'started') intent.status = 'pending';
            if (intent.status === 'pending') delete intent.nextAttempt;
            this.db
              .query('UPDATE worker_retry_intents SET body=? WHERE task_id=? AND attempt=?')
              .run(JSON.stringify(intent), ref.taskId, ref.attempt);
          }
        }
        return task;
      })
      .immediate();
  }
  /** Release a held task and record the exact next attempt boundary in the same durable transaction. */
  releaseHeldRetryTask(ref: AttemptRef, update: (task: Task) => void): Task {
    const task = this.db
      .transaction(() => {
        const current = this.task(ref.taskId);
        const attempt = ref.attempt > 0 ? this.attempt(ref) : undefined;
        this.assertRetryAllowed(ref);
        const abandonPending = attempt?.state === 'pending' || attempt?.state === 'waiting';
        if (
          current.currentAttempt !== ref.attempt ||
          (attempt && !['stopped', 'exited'].includes(attempt.state) && !abandonPending) ||
          current.state !== 'held'
        )
          throw new Error(
            `task cannot be released: ${ref.taskId} attempt ${ref.attempt} (task ${current.state} at attempt ${current.currentAttempt}${attempt ? `, attempt ${attempt.state}` : ''})`,
          );
        if (abandonPending && attempt) {
          attempt.state = 'stopped';
          attempt.endedAt ??= new Date().toISOString();
          this.saveAttempt(attempt);
        }
        update(current);
        const updatedState = current.state as Task['state'];
        if (current.id !== ref.taskId || current.currentAttempt !== ref.attempt || updatedState !== 'ready')
          throw new Error('held task release must preserve identity and move it to ready');
        this.saveTask(current);
        this.db
          .query('INSERT INTO worker_events(task_id,attempt,kind,at,body) VALUES (?,?,?,?,?)')
          .run(
            ref.taskId,
            ref.attempt,
            'held-task-released',
            new Date().toISOString(),
            JSON.stringify({ releasedAttempt: ref.attempt + 1 }),
          );
        return current;
      })
      .immediate();
    this.invalidateSnapshot();
    return task;
  }
  updateAttempt(ref: AttemptRef, update: (attempt: Attempt) => void): Attempt {
    return this.write(ref, () => {
      const attempt = this.attempt(ref);
      const previousState = attempt.state;
      update(attempt);
      if (attempt.taskId !== ref.taskId || attempt.attempt !== ref.attempt)
        throw new Error('attempt identity cannot be updated');
      this.saveAttempt(attempt);
      if (previousState !== attempt.state && attempt.state === 'running')
        recordFlow(this.db, {
          taskId: ref.taskId,
          attempt: ref.attempt,
          stage: 'worker',
          action: 'started',
          at: new Date().toISOString(),
          ...(attempt.prompt ? { detail: JSON.stringify({ prompt: { overBudget: attempt.prompt.overBudget } }) } : {}),
        });
      if (previousState === 'running' && attempt.state !== 'running')
        recordFlow(this.db, {
          taskId: ref.taskId,
          attempt: ref.attempt,
          stage: 'worker',
          action: 'finished',
          at: attempt.endedAt ?? new Date().toISOString(),
        });
      return attempt;
    });
  }
  /** Record the exact operator-authorized check while preserving a stopped attempt's stop tombstone. */
  recordWithdrawnTypingRecoveryAuthorization(
    ref: AttemptRef,
    expectedResult: string,
    pending: NonNullable<Attempt['typingEvidencePending']>,
    eventBody: unknown,
  ): void {
    this.db
      .transaction(() => {
        const { attempt } = this.withdrawnTypingRecoveryRows(ref, expectedResult);
        if (
          attempt.state !== 'stopped' ||
          JSON.stringify(pending.command) !== JSON.stringify(['bun', 'run', '--cwd', 'apps/web', 'typecheck'])
        )
          throw new Error('stopped attempt no longer accepts its exact Web typing recovery grant');
        attempt.typingEvidencePending = pending;
        this.saveAttempt(attempt);
        this.db
          .query('INSERT INTO worker_events(task_id,attempt,kind,at,body) VALUES (?,?,?,?,?)')
          .run(ref.taskId, ref.attempt, 'typing-recovery-authorized', new Date().toISOString(), JSON.stringify(eventBody));
      })
      .immediate();
    this.invalidateSnapshot();
  }
  /** Move a stopped attempt into ordinary settlement only after exact current Web compiler evidence exists. */
  beginWithdrawnTypingRecoverySettlement(
    ref: AttemptRef,
    expectedResult: string,
    command: readonly string[],
    eventBody: unknown,
  ): void {
    this.db
      .transaction(() => {
        const { attempt } = this.withdrawnTypingRecoveryRows(ref, expectedResult);
        if (
          JSON.stringify(command) !== JSON.stringify(['bun', 'run', '--cwd', 'apps/web', 'typecheck']) ||
          (attempt.state !== 'stopped' && attempt.state !== 'exited') ||
          (attempt.typingEvidencePending?.command !== undefined &&
            JSON.stringify(attempt.typingEvidencePending.command) !== JSON.stringify(command))
        )
          throw new Error('stopped attempt no longer accepts its exact Web typing receipt');
        attempt.state = 'exited';
        attempt.typingEvidencePending ??= {
          result: 'Compiler evidence for the retained Web source is being reconciled.',
          command: [...command],
        };
        this.saveAttempt(attempt);
        this.db
          .query('INSERT INTO worker_events(task_id,attempt,kind,at,body) VALUES (?,?,?,?,?)')
          .run(ref.taskId, ref.attempt, 'typing-evidence-recovery', new Date().toISOString(), JSON.stringify(eventBody));
      })
      .immediate();
    this.invalidateSnapshot();
  }
  /** Preserve compiler diagnostics on a stopped source attempt without starting a source-writing retry. */
  recordWithdrawnTypingRecoveryFailure(
    ref: AttemptRef,
    expectedResult: string,
    result: string,
    eventBody: unknown,
  ): void {
    this.db
      .transaction(() => {
        const { attempt } = this.withdrawnTypingRecoveryRows(ref, expectedResult);
        if (attempt.state !== 'stopped') throw new Error('stopped attempt no longer accepts compiler failure evidence');
        attempt.failureKind = 'tool';
        attempt.result = result;
        delete attempt.typingEvidencePending;
        this.saveAttempt(attempt);
        this.db
          .query('INSERT INTO worker_events(task_id,attempt,kind,at,body) VALUES (?,?,?,?,?)')
          .run(ref.taskId, ref.attempt, 'typing-evidence-failed', new Date().toISOString(), JSON.stringify(eventBody));
      })
      .immediate();
    this.invalidateSnapshot();
  }
  private withdrawnTypingRecoveryRows(ref: AttemptRef, expectedResult: string): { attempt: Attempt } {
    const task = decode<Task>(
      this.db.query('SELECT body FROM worker_tasks WHERE id=?').get(ref.taskId),
    );
    const attempt = decode<Attempt>(
      this.db.query('SELECT body FROM worker_attempts WHERE task_id=? AND attempt=?').get(ref.taskId, ref.attempt),
    );
    const retry = decode<RetryIntent>(
      this.db.query('SELECT body FROM worker_retry_intents WHERE task_id=? AND attempt=?').get(ref.taskId, ref.attempt),
    );
    const stop = attempt?.terminationIntent;
    if (
      !task ||
      task.currentAttempt !== ref.attempt ||
      task.state !== 'stopped' ||
      task.brief.goal !== 'web' ||
      task.brief.kind !== 'interface' ||
      !attempt ||
      attempt.result !== expectedResult ||
      attempt.exitCode !== 0 ||
      attempt.failureKind !== 'tool' ||
      !stop ||
      stop.operation !== 'stop' ||
      stop.state !== 'complete' ||
      stop.processIdentity !== 'known' ||
      !stop.settledAt ||
      retry?.status !== 'abandoned' ||
      retry.abandonedBy !== 'stop' ||
      retry.nextAttempt !== undefined ||
      retry.options.escalation !== 'environment'
    )
      throw new Error('stopped source or withdrawn retry changed before typing recovery persistence');
    return { attempt };
  }
  /** Do not publish a replacement while an accepted operator stop still owns this generation. */
  assertRetryAllowed(ref: AttemptRef, explicit = false): void {
    const task = this.task(ref.taskId);
    if (task.currentAttempt !== ref.attempt) throw new StaleAttemptError(ref, task.currentAttempt);
    if (!ref.attempt) return;
    const intent = this.attempt(ref).terminationIntent;
    if (
      (!explicit && this.retryIntent(ref)?.status === 'abandoned') ||
      (intent && (intent.operation === 'cancel' || intent.state !== 'complete' || !intent.settledAt))
    )
      throw new StaleAttemptError(ref, task.currentAttempt);
  }
  /** Superseding and publishing the next sequence are atomic, before stopping any external process. */
  nextAttempt(
    ref: AttemptRef,
    make: (n: number) => Attempt,
    configDirectory?: string,
    admitProof = false,
    pageDataRepair = false,
  ): Attempt {
    return this.write(ref, () => {
      this.assertRetryAllowed(ref);
      const task = this.task(ref.taskId);
      if (
        (!pageDataRepair && task.state === 'integrated') ||
        (!pageDataRepair && task.state === 'merged') ||
        task.state === 'verified' ||
        task.state === 'cancelled'
      )
        throw new Error(`cannot retry ${task.state} task`);
      if (admitProof && !this.proofCapacityAvailable(task.brief.goal, task.id))
        throw new ProofCapacityQueuedError(this.policy.proof.concurrency);
      if (ref.attempt) {
        const old = this.attempt(ref);
        old.state = 'superseded';
        this.saveAttempt(old);
        const record =
          this.record(ref) ??
          makeRecord(task, old, readMeasurement(old, { configDirectory, policy: this.policy }), 'superseded');
        const retainedProof = record.taskKind === 'verification';
        if (record.outcome === 'pending-gate' && !retainedProof) {
          record.outcome = 'superseded';
        }
        this.saveRecord(record);
      }
      const next = make(ref.attempt + 1);
      if (next.taskId !== task.id || next.attempt !== ref.attempt + 1) throw new Error('invalid next attempt identity');
      task.currentAttempt = next.attempt;
      task.state = 'ready';
      this.saveTask(task);
      this.saveAttempt(next);
      return next;
    });
  }
  /** The replacement's fence authorizes accounting for revoked writers only after their groups are gone. */
  finalizeSuperseded(
    current: AttemptRef,
    after: (attempt: Attempt) => PoolReading | null,
    configDirectory: (attempt: Attempt) => string | undefined,
  ): void {
    this.write(current, () => {
      const task = this.task(current.taskId);
      for (const old of this.attempts(current.taskId).filter(
        (a) => a.state === 'superseded' && !a.supersededFinalized,
      )) {
        if ([old.process, ...old.auxiliaryProcesses].some((p) => p && groupMembers(p.group).length))
          throw new Error('superseded process group is still alive');
        old.endedAt ??= new Date().toISOString();
        old.after ??= after(old);
        old.supersededFinalized = true;
        const previous = this.record(old);
        const record = makeRecord(
          task,
          old,
          readMeasurement(old, { configDirectory: configDirectory(old), policy: this.policy }),
          previous?.outcome ?? 'superseded',
        );
        if (previous) {
          if (previous.taskKind === undefined) delete record.taskKind;
          else record.taskKind = previous.taskKind;
          record.taskClass = previous.taskClass;
          record.criticalPath = previous.criticalPath;
          record.diffLines = previous.diffLines;
          record.changedFiles = previous.changedFiles;
          if (previous.outsidePaths) record.outsidePaths = previous.outsidePaths;
          if (previous.estimateOverrun) record.estimateOverrun = previous.estimateOverrun;
          record.hostMs = previous.hostMs;
          record.earlyStop = previous.earlyStop;
          if (previous.guardIds) record.guardIds = [...previous.guardIds];
        }
        this.saveAttempt(old);
        // A new capture cannot recalculate the old proof's report/evidence using its new contract or logs.
        if (!previous || previous.taskKind !== 'verification') this.saveRecord(record);
      }
    });
  }
  private saveRecord(record: AttemptRecord): void {
    this.db
      .query('INSERT OR REPLACE INTO worker_records VALUES (?,?,?)')
      .run(record.taskId, record.attempt, JSON.stringify(record));
  }
  putRecord(record: AttemptRecord): void {
    this.write(record, () => this.saveRecord(record));
  }
  /** Notify from a dropped terminal predecessor without restoring a worker's write authority. */
  notifyDroppedDependency(ref: AttemptRef, event: ManagerEvent, deliver: (event: ManagerEvent) => void): void {
    this.db
      .transaction(() => {
        const task = this.task(ref.taskId);
        if (task.currentAttempt !== ref.attempt || !['cancelled', 'stopped'].includes(task.state))
          throw new StaleAttemptError(ref, task.currentAttempt);
        if (event.taskId !== ref.taskId) throw new Error('dropped dependency notice must name its predecessor');
        const recorded = this.db
          .query(
            `SELECT 1 FROM worker_events WHERE task_id=? AND attempt=? AND kind IN ('cancelled-dependency-notice','dropped-dependency-notice')
             AND json_extract(body,'$.managerId')=? LIMIT 1`,
          )
          .get(ref.taskId, ref.attempt, event.managerId);
        if (recorded) return;
        this.db
          .query('INSERT INTO worker_events(task_id,attempt,kind,at,body) VALUES (?,?,?,?,?)')
          .run(ref.taskId, ref.attempt, 'dropped-dependency-notice', new Date().toISOString(), JSON.stringify(event));
        deliver(event);
      })
      .immediate();
  }
  notifyCancelledDependency(ref: AttemptRef, event: ManagerEvent, deliver: (event: ManagerEvent) => void): void {
    this.notifyDroppedDependency(ref, event, deliver);
  }
  event(ref: AttemptRef, kind: string, body: unknown): void {
    this.write(ref, () => {
      this.db
        .query('INSERT INTO worker_events(task_id,attempt,kind,at,body) VALUES (?,?,?,?,?)')
        .run(ref.taskId, ref.attempt, kind, new Date().toISOString(), JSON.stringify(body));
      if (kind === 'check-slot-requested' || kind === 'check-slot-acquired' || kind === 'check-slot-released')
        recordFlow(this.db, {
          taskId: ref.taskId,
          attempt: ref.attempt,
          stage: 'check',
          action: kind.replace('check-slot-', ''),
          at: new Date().toISOString(),
        });
      if (kind === 'start-requested')
        recordFlow(this.db, {
          taskId: ref.taskId,
          attempt: ref.attempt,
          stage: 'start',
          action: 'requested',
          at: new Date().toISOString(),
        });
    });
  }
  ownerDecisionEvents(ref: AttemptRef): WorkerEvent[] {
    const events = this.db
      .query(
        `SELECT sequence, task_id, attempt, kind, at, body FROM worker_events
         WHERE task_id=? AND attempt<=? AND kind IN ('owner-contract-decision-accepted', 'owner-contract-decision-delivery', 'owner-contract-decisions-superseded')
         ORDER BY sequence`,
      )
      .all(ref.taskId, ref.attempt) as WorkerEvent[];
    // Older accepted events have no contract hash. Retained retry metadata still proves a later canonical rewrite.
    const legacy = events.filter((event) => {
      if (event.kind !== 'owner-contract-decision-accepted') return false;
      try {
        return !JSON.parse(event.body)?.contractSha256;
      } catch {
        return false;
      }
    });
    if (!legacy.length) return events;
    const changed = this.db
      .query(`SELECT max(attempt) AS attempt FROM worker_attempts
      WHERE task_id=? AND attempt<=? AND json_extract(body, '$.newBriefHash') IS NOT NULL`)
      .get(ref.taskId, ref.attempt) as { attempt: number | null };
    const pending = this.task(ref.taskId).pendingBriefChange;
    const superseded = legacy.filter((event) => pending || event.attempt < (changed.attempt ?? 0));
    if (superseded.length)
      events.push({
        task_id: ref.taskId,
        attempt: ref.attempt,
        kind: 'owner-contract-decisions-superseded',
        at: '',
        sequence: Math.max(...superseded.map((event) => event.sequence)),
        body: '{}',
      });
    return events;
  }
  recordOwnerDecisionDelivery(ref: AttemptRef, receipt: OwnerDecisionDelivery): void {
    const launched = this.db
      .query(`SELECT max(sequence) AS sequence FROM worker_events
      WHERE task_id=? AND attempt=? AND kind='worker-run-started'`)
      .get(ref.taskId, ref.attempt) as { sequence: number | null };
    this.event(ref, 'owner-contract-decision-delivery', {
      ...receipt,
      receivingAttempt: ref.attempt,
      ...(launched.sequence !== null ? { launchSequence: launched.sequence } : {}),
    });
  }
  events(taskId?: string, attempt?: number): WorkerEvent[] {
    return (
      taskId && attempt !== undefined
        ? this.db
            .query('SELECT * FROM worker_events WHERE task_id=? AND attempt=? ORDER BY sequence')
            .all(taskId, attempt)
        : taskId
          ? this.db.query('SELECT * FROM worker_events WHERE task_id=? ORDER BY sequence').all(taskId)
          : this.db.query('SELECT * FROM worker_events ORDER BY sequence').all()
    ) as ReturnType<WorkerStore['events']>;
  }
  landing(request: LandingRequest, enqueue: (request: LandingRequest) => void): void {
    this.write(request, () => {
      if (this.task(request.taskId).brief.kind === 'verification')
        throw new Error('verification proof cannot enter source landing');
      const sent = this.db
        .query("SELECT 1 FROM worker_events WHERE task_id=? AND attempt=? AND kind='landing-requested'")
        .get(request.taskId, request.attempt);
      if (sent) return;
      this.event(request, 'landing-requested', request);
      recordFlow(this.db, {
        taskId: request.taskId,
        attempt: request.attempt,
        stage: 'landing',
        action: 'enqueued',
        at: new Date().toISOString(),
      });
      enqueue(request);
    });
  }
  private abandonRetry(ref: AttemptRef, operation: 'stop' | 'cancel'): void {
    const retry = this.retryIntent(ref);
    if (!retry || retry.status !== 'pending') return;
    retry.status = 'abandoned';
    retry.abandonedBy = operation;
    delete retry.nextAttempt;
    this.db
      .query('UPDATE worker_retry_intents SET body=? WHERE task_id=? AND attempt=?')
      .run(JSON.stringify(retry), ref.taskId, ref.attempt);
  }
  /** Persist the operator's disposition before terminating any process. */
  beginTermination(ref: AttemptRef, operation: 'stop' | 'cancel'): TerminationIntent {
    return this.db
      .transaction(() => {
        const task = this.task(ref.taskId);
        if (task.currentAttempt !== ref.attempt) throw new StaleAttemptError(ref, task.currentAttempt);
        if (['integrated', 'merged', 'cancelled'].includes(task.state))
          throw new Error(`cannot terminate ${task.state} task`);
        const attempt = this.attempt(ref);
        const at = new Date().toISOString();
        let intent = attempt.terminationIntent;
        const waitingWithoutWorker = attempt.state === 'waiting' && attempt.process == null;
        if (!intent) {
          const auxiliaryProcesses = [...(attempt.auxiliaryProcesses ?? [])];
          const started = this.events(ref.taskId, ref.attempt).some((event) => event.kind === 'worker-run-started');
          const processIdentity = attempt.process
            ? 'known'
            : waitingWithoutWorker
              ? 'waiting'
              : !started && !auxiliaryProcesses.length && runPidFilePresence(attempt.logPath) === 'absent'
                ? 'not-started'
                : 'unknown';
          intent = {
            operation,
            requestedAt: at,
            state: processIdentity === 'unknown' ? 'unknown' : 'requested',
            processIdentity,
            process: attempt.process,
            auxiliaryProcesses,
            ...(processIdentity === 'unknown' ? { error: 'process identity unavailable' } : {}),
          };
          attempt.terminationIntent = intent;
          this.db
            .query('INSERT INTO worker_events(task_id,attempt,kind,at,body) VALUES (?,?,?,?,?)')
            .run(ref.taskId, ref.attempt, 'termination-requested', at, JSON.stringify({ operation, processIdentity }));
        } else if (waitingWithoutWorker && intent.processIdentity === 'unknown' && intent.state !== 'complete') {
          intent.processIdentity = 'waiting';
          intent.state = 'requested';
          delete intent.error;
          if (operation === 'cancel') {
            intent.operation = 'cancel';
            delete intent.settledAt;
          }
        } else if (operation === 'cancel' && intent.operation !== 'cancel') {
          intent.operation = 'cancel';
          delete intent.settledAt;
        }
        this.abandonRetry(ref, intent.operation);
        this.saveAttempt(attempt);
        return intent;
      })
      .immediate();
  }
  /** Record physical confirmation separately from the durable operator request. */
  finishTermination(ref: AttemptRef, error?: string): void {
    this.db
      .transaction(() => {
        const task = this.task(ref.taskId);
        if (task.currentAttempt !== ref.attempt) throw new StaleAttemptError(ref, task.currentAttempt);
        const attempt = this.attempt(ref);
        const intent = attempt.terminationIntent;
        if (!intent) throw new Error('termination request is missing');
        if (error) {
          intent.state = 'unknown';
          intent.error = error;
        } else {
          if (intent.processIdentity === 'unknown') throw new Error('process identity is unknown');
          intent.state = 'complete';
          delete intent.error;
        }
        this.saveAttempt(attempt);
      })
      .immediate();
  }
  /** Commit the terminal state after known processes or explicit absence evidence are confirmed. */
  closeTerminated(
    ref: AttemptRef,
    after: PoolReading | null,
    configDirectory?: string,
    confirmUnknownAbsence?: () => boolean,
  ): void {
    this.db
      .transaction(() => {
        const task = this.task(ref.taskId);
        if (task.currentAttempt !== ref.attempt) throw new StaleAttemptError(ref, task.currentAttempt);
        const attempt = this.attempt(ref);
        const intent = attempt.terminationIntent;
        if (!intent) throw new Error('termination request is missing');
        const confirmedAbsent = intent.state === 'unknown' && intent.processIdentity === 'unknown';
        if (intent.state !== 'complete' && !confirmedAbsent) throw new Error('physical termination is unconfirmed');
        const state = intent.operation === 'cancel' ? 'cancelled' : 'stopped';
        attempt.endedAt ??= new Date().toISOString();
        attempt.after ??= after;
        if (!this.record(ref))
          this.saveRecord(
            makeRecord(task, attempt, readMeasurement(attempt, { configDirectory, policy: this.policy }), state),
          );
        if (!this.events(ref.taskId, ref.attempt).some((event) => event.kind === state))
          this.db
            .query('INSERT INTO worker_events(task_id,attempt,kind,at,body) VALUES (?,?,?,?,?)')
            .run(ref.taskId, ref.attempt, state, new Date().toISOString(), '{}');
        if (confirmedAbsent) {
          if (!confirmUnknownAbsence?.()) throw new Error('physical termination is unconfirmed');
          intent.state = 'complete';
          delete intent.error;
        }
        task.state = state;
        attempt.state = state;
        intent.settledAt ??= new Date().toISOString();
        this.saveTask(task);
        this.saveAttempt(attempt);
      })
      .immediate();
  }
  /** Stopping invalidates the current writer without inventing an attempt that never ran. */
  close(ref: AttemptRef, state: 'stopped' | 'cancelled'): void {
    this.write(ref, () => {
      const task = this.task(ref.taskId),
        attempt = this.attempt(ref);
      task.state = state;
      attempt.state = state;
      attempt.endedAt ??= new Date().toISOString();
      this.saveTask(task);
      this.saveAttempt(attempt);
    });
  }
  /** A previously stopped attempt is already fenced, but its task can still be cancelled. */
  cancelStopped(ref: AttemptRef): void {
    this.db
      .transaction(() => {
        const task = this.task(ref.taskId),
          attempt = this.attempt(ref);
        // A held or released task whose current attempt has stopped has no worker either.
        if (
          task.currentAttempt !== ref.attempt ||
          !['stopped', 'held', 'ready'].includes(task.state) ||
          !['stopped', 'exited'].includes(attempt.state)
        )
          throw new Error('only a stopped current task can be cancelled');
        task.state = 'cancelled';
        this.saveTask(task);
      })
      .immediate();
  }
  /** A stopped task may be explicitly retried; it remains fenced until the replacement is published. */
  retryStopped(taskId: string, make: (n: number) => Attempt, configDirectory?: string, admitProof = false): Attempt {
    return this.db
      .transaction(() => {
        const task = this.task(taskId);
        if (!['stopped', 'ready', 'held'].includes(task.state)) throw new Error('task is not stopped or released');
        const old = this.attempt({ taskId, attempt: task.currentAttempt });
        if (old.state !== 'stopped') throw new Error('current attempt is not stopped');
        old.state = 'exited';
        this.saveAttempt(old);
        return this.nextAttempt(old, make, configDirectory, admitProof);
      })
      .immediate();
  }
}
