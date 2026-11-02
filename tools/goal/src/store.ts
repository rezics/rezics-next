import { nativeCheckId, proofFingerprint, ProofCapacityQueuedError } from './verification.ts';
import type { Database } from 'bun:sqlite';
import { isDeepStrictEqual } from 'node:util';
import { CheckResults, checkResultsMigration } from './check-results.ts';
import { groupMembers, sameProcess } from './process.ts';
import { makeRecord, readMeasurement } from './records.ts';
import { migrate } from './db.ts';
import { StaleAttemptError } from './contracts.ts';
import type { AttemptFence, AttemptRef, LandingRequest, ManagerEvent } from './contracts.ts';
import type {
  Attempt,
  AttemptRecord,
  Brief,
  DevVerifierFinding,
  DevVerifierRun,
  IntegrationPlan,
  PoolReading,
  PromotionRun,
  RetryIntent,
  Task,
  TerminationIntent,
  WorktreeCleanupDisposition,
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
export const MAX_ATTEMPT_PAGE_SIZE = 100;

function attemptPageOptions(taskId: string, options: AttemptPageOptions): Required<AttemptPageOptions> {
  const afterAttempt = options.afterAttempt ?? 0;
  if (!taskId) throw new Error('task id is required');
  if (!Number.isSafeInteger(afterAttempt) || afterAttempt < 0)
    throw new Error('after attempt must be a non-negative integer');
  if (!Number.isSafeInteger(options.limit) || options.limit < 1 || options.limit > MAX_ATTEMPT_PAGE_SIZE)
    throw new Error(`limit must be between 1 and ${MAX_ATTEMPT_PAGE_SIZE}`);
  return { afterAttempt, limit: options.limit };
}

export class WorkerStore implements AttemptFence {
  readonly checkResults: CheckResults;
  private readVersion = -1;
  private readonly taskSnapshot = new Map<string, Task>();
  private readonly attemptSnapshot = new Map<string, Attempt>();
  private decodedTaskRows = 0;
  private decodedAttemptRows = 0;
  private decodedTaskBytes = 0;
  private decodedAttemptBytes = 0;
  constructor(readonly db: Database) {
    migrate(db, workerMigrations);
    ensureFlow(db);
    this.checkResults = new CheckResults(db);
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
    this.refreshSnapshot();
    return this.db
      .query(
        "SELECT id, body FROM worker_tasks WHERE json_extract(body, '$.state') IN ('held','ready','running','landing','stopped') ORDER BY sequence",
      )
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
    const { afterAttempt, limit } = attemptPageOptions(taskId, options);
    this.refreshSnapshot();
    const rows = this.db
      .query('SELECT task_id, attempt, body FROM worker_attempts WHERE task_id=? AND attempt>? ORDER BY attempt LIMIT ?')
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
  /** Pending, running, waiting and exited attempts are the only attempts needed for host recovery. */
  activeAttempts(): Attempt[] {
    this.refreshSnapshot();
    return this.db
      .query(
        "SELECT task_id, attempt, body FROM worker_attempts WHERE json_extract(body, '$.state') IN ('pending','running','waiting','exited') ORDER BY task_id, attempt",
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
  /** Counts running attempts through the state index without reading or decoding attempt bodies. */
  runningAttemptsCount(): number {
    const row = this.db
      .query("SELECT count(*) AS count FROM worker_attempts WHERE json_extract(body, '$.state') = 'running'")
      .get() as { count: number };
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
        const body = JSON.stringify({ cause: cause.slice(0, 2000) });
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
      ordinary.filter((slot) => slot.taskId !== taskId).length + historical.length < 3 &&
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
      `Proof cap 3 pending: ${ordinary.length} current ordinary runs; current running/waiting checks: ` +
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
        ordinary.filter((slot) => slot.taskId !== binding.taskId).length + historical.length >= 3 ||
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
              !['stopped', 'exited', 'cancelled', 'superseded'].includes(owner.state) ||
              [owner.process, owner.driver, ...(owner.auxiliaryProcesses ?? [])].some(
                (identity) => identity && sameProcess(identity),
              ),
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
    const { afterAttempt, limit } = attemptPageOptions(taskId, options);
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
  clearIntegrationPlan(ref: AttemptRef): void {
    this.db.query('DELETE FROM worker_integration_plans WHERE task_id=? AND attempt=?').run(ref.taskId, ref.attempt);
  }
  promotion(): PromotionRun | undefined {
    return decode<PromotionRun>(this.db.query('SELECT body FROM worker_promotions WHERE id=1').get());
  }
  devVerifierRun(key: string): DevVerifierRun | undefined {
    return decode<DevVerifierRun>(this.db.query('SELECT body FROM dev_verifier_runs WHERE cache_key=?').get(key));
  }
  saveDevVerifierRun(run: DevVerifierRun): void {
    this.db
      .transaction(() => {
        this.db
          .query('INSERT OR REPLACE INTO dev_verifier_runs VALUES (?,?,?)')
          .run(run.key, run.createdAt, JSON.stringify(run));
        this.db
          .query(
            'DELETE FROM dev_verifier_runs WHERE cache_key IN (SELECT cache_key FROM dev_verifier_runs ORDER BY rowid DESC LIMIT -1 OFFSET 5000)',
          )
          .run();
      })
      .immediate();
  }
  devVerifierFindings(limit = 2000): DevVerifierFinding[] {
    return this.db
      .query('SELECT body FROM dev_verifier_findings ORDER BY rowid DESC LIMIT ?')
      .all(Math.max(0, Math.min(2000, limit)))
      .map((row) => decode<DevVerifierFinding>(row)!);
  }
  devVerifierHasKnownExisting(signature: string): boolean {
    return Boolean(
      this.db
        .query("SELECT 1 FROM dev_verifier_findings WHERE signature=? AND status='existing' LIMIT 1")
        .get(signature),
    );
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
            'DELETE FROM dev_verifier_findings WHERE range_key IN (SELECT range_key FROM dev_verifier_findings ORDER BY rowid DESC LIMIT -1 OFFSET 2000)',
          )
          .run();
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
        const intent: RetryIntent = { ...ref, options, status: 'pending' };
        this.db
          .query('INSERT OR REPLACE INTO worker_retry_intents VALUES (?,?,?)')
          .run(ref.taskId, ref.attempt, JSON.stringify(intent));
        const at = new Date().toISOString();
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
          const intent: RetryIntent = { ...ref, options, status: 'pending' };
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
      this.saveRecord(makeRecord(before, attempt, readMeasurement(attempt), 'stopped'));
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
      if (
        !['stopped', 'exited'].includes(attempt.state) ||
        [attempt.process, attempt.driver, ...(attempt.auxiliaryProcesses ?? [])].some(
          (identity) => identity && sameProcess(identity),
        )
      )
        throw new StaleAttemptError(ref, task.currentAttempt);
    }
    this.assertProofContract(task, brief);
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
        const intent: RetryIntent = { ...ref, options, status: 'pending' };
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
  ): Task {
    const task = this.db
      .transaction(() => {
        const after = brief.after ?? [];
        const dependencies = new Map(after.map((id) => [id, this.dependency(id)]));
        for (const dependency of after)
          if (!dependencies.get(dependency)) throw new Error(`unknown dependency task: ${dependency}`);
        const state = after.every((dependency) =>
          ['integrated', 'merged'].includes(dependencies.get(dependency)?.state ?? ''),
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
  nextAttempt(ref: AttemptRef, make: (n: number) => Attempt, configDirectory?: string, admitProof = false): Attempt {
    return this.write(ref, () => {
      this.assertRetryAllowed(ref);
      const task = this.task(ref.taskId);
      if (
        task.state === 'integrated' ||
        task.state === 'merged' ||
        task.state === 'verified' ||
        task.state === 'cancelled'
      )
        throw new Error(`cannot retry ${task.state} task`);
      if (admitProof && !this.proofCapacityAvailable(task.brief.goal, task.id)) throw new ProofCapacityQueuedError();
      if (ref.attempt) {
        const old = this.attempt(ref);
        old.state = 'superseded';
        this.saveAttempt(old);
        const record =
          this.record(ref) ?? makeRecord(task, old, readMeasurement(old, { configDirectory }), 'superseded');
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
          readMeasurement(old, { configDirectory: configDirectory(old) }),
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
  /** Notify from a committed cancellation without restoring a terminal worker's write authority. */
  notifyCancelledDependency(ref: AttemptRef, event: ManagerEvent, deliver: (event: ManagerEvent) => void): void {
    this.db
      .transaction(() => {
        const task = this.task(ref.taskId);
        if (task.currentAttempt !== ref.attempt || task.state !== 'cancelled')
          throw new StaleAttemptError(ref, task.currentAttempt);
        if (event.taskId !== ref.taskId) throw new Error('cancellation notice must name its dependency');
        const recorded = this.db
          .query(
            `SELECT 1 FROM worker_events WHERE task_id=? AND attempt=? AND kind='cancelled-dependency-notice'
             AND json_extract(body,'$.managerId')=? LIMIT 1`,
          )
          .get(ref.taskId, ref.attempt, event.managerId);
        if (recorded) return;
        this.db
          .query('INSERT INTO worker_events(task_id,attempt,kind,at,body) VALUES (?,?,?,?,?)')
          .run(ref.taskId, ref.attempt, 'cancelled-dependency-notice', new Date().toISOString(), JSON.stringify(event));
        deliver(event);
      })
      .immediate();
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
  events(
    taskId?: string,
    attempt?: number,
  ): { sequence: number; task_id: string; attempt: number; kind: string; at: string; body: string }[] {
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
        if (!intent) {
          const auxiliaryProcesses = [...(attempt.auxiliaryProcesses ?? [])];
          const started = this.events(ref.taskId, ref.attempt).some((event) => event.kind === 'worker-run-started');
          const processIdentity = attempt.process
            ? 'known'
            : attempt.state === 'pending' && !started && !auxiliaryProcesses.length
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
  /** Commit the requested terminal state once, only after known process groups are confirmed absent. */
  closeTerminated(ref: AttemptRef, after: PoolReading | null, configDirectory?: string): void {
    this.db
      .transaction(() => {
        const task = this.task(ref.taskId);
        if (task.currentAttempt !== ref.attempt) throw new StaleAttemptError(ref, task.currentAttempt);
        const attempt = this.attempt(ref);
        const intent = attempt.terminationIntent;
        if (intent?.state !== 'complete') throw new Error('physical termination is unconfirmed');
        const state = intent.operation === 'cancel' ? 'cancelled' : 'stopped';
        attempt.endedAt ??= new Date().toISOString();
        attempt.after ??= after;
        if (!this.record(ref))
          this.saveRecord(makeRecord(task, attempt, readMeasurement(attempt, { configDirectory }), state));
        if (!this.events(ref.taskId, ref.attempt).some((event) => event.kind === state))
          this.db
            .query('INSERT INTO worker_events(task_id,attempt,kind,at,body) VALUES (?,?,?,?,?)')
            .run(ref.taskId, ref.attempt, state, new Date().toISOString(), '{}');
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
