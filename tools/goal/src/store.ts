import type { Database } from 'bun:sqlite';
import { groupMembers } from './process.ts';
import { makeRecord, readMeasurement } from './records.ts';
import { migrate } from './db.ts';
import { StaleAttemptError } from './contracts.ts';
import type { AttemptFence, AttemptRef, LandingRequest } from './contracts.ts';
import type {
  Attempt,
  AttemptRecord,
  Brief,
  IntegrationPlan,
  PoolReading,
  PromotionRun,
  RetryIntent,
  Task,
} from './types.ts';

export const workerMigrations = [
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
] as const;
type Body = { body: string };
const decode = <T>(row: unknown): T | undefined => (row ? (JSON.parse((row as Body).body) as T) : undefined);
export class WorkerStore implements AttemptFence {
  constructor(readonly db: Database) {
    migrate(db, workerMigrations);
  }
  task(id: string): Task {
    const task = decode<Task>(this.db.query('SELECT body FROM worker_tasks WHERE id=?').get(id));
    if (!task) throw new Error(`unknown task: ${id}`);
    return task;
  }
  tasks(): Task[] {
    return this.db
      .query('SELECT body FROM worker_tasks ORDER BY sequence')
      .all()
      .map((row) => decode<Task>(row)!);
  }
  attempt(ref: AttemptRef): Attempt {
    const attempt = decode<Attempt>(
      this.db.query('SELECT body FROM worker_attempts WHERE task_id=? AND attempt=?').get(ref.taskId, ref.attempt),
    );
    if (!attempt) throw new Error('unknown attempt');
    return attempt;
  }
  attempts(taskId?: string): Attempt[] {
    const rows = taskId
      ? this.db.query('SELECT body FROM worker_attempts WHERE task_id=? ORDER BY attempt').all(taskId)
      : this.db.query('SELECT body FROM worker_attempts ORDER BY task_id, attempt').all();
    return rows.map((row) => decode<Attempt>(row)!);
  }
  /** Reads one state through the attempt state index; used for the host's pending launcher recovery. */
  attemptsInState(state: Attempt['state']): Attempt[] {
    return this.db
      .query("SELECT body FROM worker_attempts WHERE json_extract(body, '$.state') = ? ORDER BY task_id, attempt")
      .all(state)
      .map((row) => decode<Attempt>(row)!);
  }
  /**
   * Candidate work is anchored by running tasks, then follows each task's current-attempt primary key.
   * settle calls store.updateTask to write `landing`; failure paths write `ready`/`stopped`,
   * removing the task from the running-state range.
   */
  orphanSweepCandidates(): { attempt: Attempt; taskState: string; currentAttempt: number }[] {
    return this.db
      .query(`
        /* worker_tasks_state bounds work to unsettled tasks; each current attempt is a primary-key lookup. */
        SELECT a.body AS attempt_body,
               json_extract(t.body, '$.state') AS task_state,
               t.current_attempt AS current_attempt
        FROM worker_tasks AS t
        JOIN worker_attempts AS a ON a.task_id = t.id AND a.attempt = t.current_attempt
        WHERE json_extract(t.body, '$.state') = 'running'
          AND json_extract(a.body, '$.state') IN ('running', 'exited')
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
  record(ref: AttemptRef): AttemptRecord | undefined {
    return decode<AttemptRecord>(
      this.db.query('SELECT body FROM worker_records WHERE task_id=? AND attempt=?').get(ref.taskId, ref.attempt),
    );
  }
  assertCurrent(ref: AttemptRef): void {
    const task = this.task(ref.taskId);
    if (task.currentAttempt !== ref.attempt) throw new StaleAttemptError(ref, task.currentAttempt);
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
          if (task.state === 'integrated' || task.state === 'merged') throw new Error('attempt already integrated');
          const plan = this.integrationPlan(member);
          if (plan && plan.commit !== member.commit)
            throw new Error('batch member does not match its integration plan');
          return { member, task, plan };
        });
        const head = merge();
        if (!head) return '';
        if (head !== members[members.length - 1]!.commit)
          throw new Error('batch head does not match its final member commit');
        for (const { member, task, plan } of tasks) {
          task.state = 'integrated';
          task.integratedCommit = member.commit;
          if (plan) {
            task.integratedBase = plan.base;
            task.integratedCommits = plan.commits;
          }
          this.saveTask(task);
          if (plan) this.clearIntegrationPlan(member);
        }
        return head;
      })
      .immediate();
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
  retryIntents(): RetryIntent[] {
    return this.db
      .query('SELECT body FROM worker_retry_intents ORDER BY task_id, attempt')
      .all()
      .map((row) => decode<RetryIntent>(row)!);
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
        update(intent);
        this.db
          .query('UPDATE worker_retry_intents SET body=? WHERE task_id=? AND attempt=?')
          .run(JSON.stringify(intent), ref.taskId, ref.attempt);
        return intent;
      })
      .immediate();
  }
  /** Keep the check and every associated write under BEGIN IMMEDIATE. */
  write<T>(ref: AttemptRef, action: () => T): T {
    return this.db
      .transaction(() => {
        this.assertCurrent(ref);
        const result = action();
        if (result instanceof Promise) throw new Error('store transactions must be synchronous');
        return result;
      })
      .immediate();
  }
  createTask(
    brief: Brief,
    paths: { briefPath: string; worktree: string; branch: string; base: string },
    taskClass: Task['taskClass'],
    id = crypto.randomUUID(),
  ): Task {
    return this.db
      .transaction(() => {
        const after = brief.after ?? [];
        const dependencies = new Map(this.tasks().map((task) => [task.id, task]));
        for (const dependency of after)
          if (!dependencies.has(dependency)) throw new Error(`unknown dependency task: ${dependency}`);
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
        return task;
      })
      .immediate();
  }
  private saveTask(task: Task): void {
    this.db
      .query('UPDATE worker_tasks SET current_attempt=?, body=? WHERE id=?')
      .run(task.currentAttempt, JSON.stringify(task), task.id);
  }
  private saveAttempt(attempt: Attempt): void {
    this.db
      .query('INSERT OR REPLACE INTO worker_attempts VALUES (?,?,?)')
      .run(attempt.taskId, attempt.attempt, JSON.stringify(attempt));
  }
  updateTask(ref: AttemptRef, update: (task: Task) => void): Task {
    return this.write(ref, () => {
      const task = this.task(ref.taskId);
      update(task);
      if (task.id !== ref.taskId || task.currentAttempt !== ref.attempt)
        throw new Error('task identity cannot be updated');
      this.saveTask(task);
      return task;
    });
  }
  /** Update a ready or stopped task; abandoning pending is valid only while the caller holds the task lease. */
  updateHeldRetryTask(ref: AttemptRef, update: (task: Task) => void, options: { abandonPending?: boolean } = {}): Task {
    return this.db
      .transaction(() => {
        const task = this.task(ref.taskId);
        const attempt = ref.attempt > 0 ? this.attempt(ref) : undefined;
        const abandonPending = options.abandonPending === true && attempt?.state === 'pending';
        if (
          task.currentAttempt !== ref.attempt ||
          (attempt && !['stopped', 'exited'].includes(attempt.state) && !abandonPending) ||
          !['ready', 'stopped', 'held'].includes(task.state)
        )
          throw new Error(
            `task cannot be held for retry: ${ref.taskId} attempt ${ref.attempt} (task ${task.state} at attempt ${task.currentAttempt}${attempt ? `, attempt ${attempt.state}` : ''})`,
          );
        if (abandonPending && attempt) {
          attempt.state = 'stopped';
          attempt.endedAt ??= new Date().toISOString();
          this.saveAttempt(attempt);
        }
        update(task);
        if (task.id !== ref.taskId || task.currentAttempt !== ref.attempt)
          throw new Error('task identity cannot be updated');
        this.saveTask(task);
        return task;
      })
      .immediate();
  }
  updateAttempt(ref: AttemptRef, update: (attempt: Attempt) => void): Attempt {
    return this.write(ref, () => {
      const attempt = this.attempt(ref);
      update(attempt);
      if (attempt.taskId !== ref.taskId || attempt.attempt !== ref.attempt)
        throw new Error('attempt identity cannot be updated');
      this.saveAttempt(attempt);
      return attempt;
    });
  }
  /** Superseding and publishing the next sequence are atomic, before stopping any external process. */
  nextAttempt(ref: AttemptRef, make: (n: number) => Attempt, configDirectory?: string): Attempt {
    return this.write(ref, () => {
      const task = this.task(ref.taskId);
      if (task.state === 'integrated' || task.state === 'merged' || task.state === 'cancelled')
        throw new Error(`cannot retry ${task.state} task`);
      if (ref.attempt) {
        const old = this.attempt(ref);
        old.state = 'superseded';
        this.saveAttempt(old);
        const record =
          this.record(ref) ?? makeRecord(task, old, readMeasurement(old, { configDirectory }), 'superseded');
        if (record && record.outcome === 'pending-gate') {
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
          record.diffLines = previous.diffLines;
          record.changedFiles = previous.changedFiles;
          record.hostMs = previous.hostMs;
          record.earlyStop = previous.earlyStop;
        }
        this.saveAttempt(old);
        this.saveRecord(record);
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
  event(ref: AttemptRef, kind: string, body: unknown): void {
    this.write(ref, () => {
      this.db
        .query('INSERT INTO worker_events(task_id,attempt,kind,at,body) VALUES (?,?,?,?,?)')
        .run(ref.taskId, ref.attempt, kind, new Date().toISOString(), JSON.stringify(body));
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
      const sent = this.db
        .query("SELECT 1 FROM worker_events WHERE task_id=? AND attempt=? AND kind='landing-requested'")
        .get(request.taskId, request.attempt);
      if (sent) return;
      this.event(request, 'landing-requested', request);
      enqueue(request);
    });
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
  retryStopped(taskId: string, make: (n: number) => Attempt, configDirectory?: string): Attempt {
    return this.db
      .transaction(() => {
        const task = this.task(taskId);
        if (!['stopped', 'ready', 'held'].includes(task.state)) throw new Error('task is not stopped or released');
        const old = this.attempt({ taskId, attempt: task.currentAttempt });
        if (old.state !== 'stopped') throw new Error('current attempt is not stopped');
        old.state = 'exited';
        this.saveAttempt(old);
        return this.nextAttempt(old, make, configDirectory);
      })
      .immediate();
  }
}
