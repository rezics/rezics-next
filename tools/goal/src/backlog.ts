import { defaultPolicy, type ControlPolicy } from './policy.ts';
import type { Database } from 'bun:sqlite';
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import type { ManagerEvent, ManagerInbox } from './contracts.ts';
import { migrate } from './db.ts';
import { acquireDirectoryLease, LeaseHeldError } from './lease.ts';
import {
  continuationAdmissionProjection,
  continuationOverlap,
  continuationReview,
  continuationReleased,
  proposeContinuation,
  withContinuationAfter,
} from './continuation.ts';
import { parseBrief, readBriefContinuation, readResearchFanout, type RiskOwnership } from './briefs.ts';
import type { Brief, BriefContinuation, Pool, PoolReading, Profile, TaskClass } from './types.ts';
import { findAllowedPool, poolBurnStatus } from './allowance.ts';
import { nearCeilingSweepAdmissions, readRetainedPoolReadings } from './pacing.ts';
import { admissionProfiles, type RoutingTable } from './routing.ts';
import {
  BACKLOG_DISPATCHED_DIRECTORY as DISPATCHED_DIRECTORY,
  BACKLOG_DISPATCHING_DIRECTORY as CLAIM_DIRECTORY,
  BACKLOG_FAILED_DIRECTORY as FAILED_DIRECTORY,
  backlogDirectory,
  briefs,
  dispatchResult,
  errorText,
  tableExists,
  taskLintWarnings,
  type BacklogDispatchResult,
} from './backlog-shared.ts';
import { fail, recordGoalDispatch, recoverClaims } from './backlog-claims.ts';
import { deliverResearchCompletions, dispatchResearchClaim, recoverResearchClaims } from './backlog-research.ts';

export { backlogDirectory };

/** A manager is woken when its Goal has fewer ready briefs than this. */
export const BACKLOG_LOW_WATER = defaultPolicy.backlog.lowWater;
/** At most one low-backlog wake per Goal in this interval. */
export const BACKLOG_WAKE_INTERVAL_MS = defaultPolicy.backlog.wakeIntervalMs;
/** A product task stopped this long without a manager action is cancelled into its Goal's failed backlog. */
export const STOPPED_TASK_LIMIT_MS = defaultPolicy.backlog.stoppedTaskLimitMs;
/** At most this many stopped tasks per Goal are cancelled in one run, oldest first, so owners get them in batches. */
export const STOPPED_TASKS_PER_GOAL_PER_RUN = defaultPolicy.backlog.stoppedTasksPerGoalPerRun;
/** Dispatch runs synchronous Git and install work, so one run dispatches only a few briefs and the next run continues. */
export const BACKLOG_DISPATCHES_PER_SWEEP = defaultPolicy.backlog.dispatchesPerSweep;

export const backlogMigrations = [
  {
    module: 'backlog',
    version: 1,
    sql: `CREATE TABLE backlog_goals (
      goal TEXT PRIMARY KEY,
      last_dispatch_at INTEGER,
      last_written_at INTEGER,
      low_wake_at INTEGER
    );`,
  },
  {
    module: 'backlog',
    version: 2,
    sql: `CREATE TABLE research_groups (
      id TEXT PRIMARY KEY,
      goal TEXT NOT NULL,
      manager TEXT NOT NULL,
      source_name TEXT NOT NULL,
      researchers TEXT NOT NULL,
      reports TEXT NOT NULL,
      dispatch_failures TEXT NOT NULL DEFAULT '{}',
      notified_at INTEGER
    );`,
  },
] as const;

export type BacklogGoalCounts = { goal: string; ready: number; dispatched: number; failed: number };

export type BacklogRuntime = {
  db: Database;
  stateDirectory: string;
  inbox: ManagerInbox;
  /** The `goal dispatch` path: create the task and request its first attempt. Returns the new task ID. */
  dispatch(briefFile: string): Promise<BacklogDispatchResult>;
  /** Queue a continuation through the existing task retry path. */
  continueTask(goal: string, continuation: BriefContinuation, briefFile: string): Promise<void>;
  /** The `goal cancel` path. */
  cancel(taskId: string): Promise<void>;
  now?: () => number;
  policy?: ControlPolicy | undefined;
  /** Active-task cap; defaults to `maxWorkers` in `<state>/capacity.json`, else 32. */
  workerCap?: number;
  perSweep?: number;
  /** When set, the sweep routes candidates and spends the allowance that exists. */
  routing?: {
    table: RoutingTable;
    ownership: RiskOwnership;
    pools: Pool[];
    readings?: PoolReading[];
  };
};

export type BacklogSweep = {
  /** Another run held the backlog lease, so this one did nothing. */
  skipped?: true;
  dispatched: { goal: string; taskId: string; brief: string; lintWarnings?: string[] }[];
  continued: { goal: string; taskId: string; attempt: number; brief: string }[];
  refused: { goal: string; brief: string; reason: string }[];
  expired: { goal: string; taskId: string }[];
  woken: string[];
};

function directories(path: string): string[] {
  try {
    return readdirSync(path, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
      .map((entry) => entry.name)
      .sort();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
}

/** Markdown briefs directly in a directory, oldest first by modification time. */
/** Ready, dispatched and refused brief counts for every Goal backlog directory. */
export function backlogStatus(stateDirectory: string): BacklogGoalCounts[] {
  const root = backlogDirectory(stateDirectory);
  return directories(root).map((goal) => ({
    goal,
    ready: briefs(join(root, goal)).length,
    dispatched: briefs(join(root, goal, DISPATCHED_DIRECTORY)).length,
    failed: briefs(join(root, goal, FAILED_DIRECTORY)).length,
  }));
}

export function formatBacklogStatus(rows: BacklogGoalCounts[]): string {
  if (!rows.length) return 'No Goal backlog directories.';
  const width = Math.max(4, ...rows.map((row) => row.goal.length));
  const line = (goal: string, ready: string, dispatched: string, failed: string) =>
    `${goal.padEnd(width)}  ${ready.padStart(5)}  ${dispatched.padStart(10)}  ${failed.padStart(6)}`;
  return [
    line('goal', 'ready', 'dispatched', 'failed'),
    ...rows.map((row) => line(row.goal, String(row.ready), String(row.dispatched), String(row.failed))),
  ].join('\n');
}

export function backlogWorkerCap(stateDirectory: string, fallback = defaultPolicy.capacity.maxWorkers): number {
  try {
    const value = (JSON.parse(readFileSync(join(stateDirectory, 'capacity.json'), 'utf8')) as { maxWorkers?: unknown })
      .maxWorkers;
    if (typeof value === 'number' && Number.isSafeInteger(value) && value > 0) return value;
  } catch {
    // Absent or unreadable capacity policy: the admission default.
  }
  return fallback;
}

/** Tasks that hold or are about to take a worker slot. */
// A task whose current attempt waits for a check holds no worker: counting it stopped all dispatch on 2026-11-03,
// when 68 of 77 running tasks were waiting and 8 workers were live. Host admission still bounds live workers.
function activeTaskCount(db: Database): number {
  if (!tableExists(db, 'worker_tasks')) return 0;
  const waiting = tableExists(db, 'worker_attempts')
    ? " AND NOT EXISTS (SELECT 1 FROM worker_attempts a WHERE a.task_id = worker_tasks.id AND a.attempt = worker_tasks.current_attempt AND json_extract(a.body, '$.state') = 'waiting')"
    : '';
  return (
    db
      .query(
        `SELECT count(*) AS count FROM worker_tasks WHERE coalesce(json_extract(body, '$.brief.urgent'),0) != 1 AND (json_extract(body, '$.state') = 'ready' OR (json_extract(body, '$.state') = 'running'${waiting}))`,
      )
      .get() as { count: number }
  ).count;
}

function runningTaskCount(db: Database): number {
  if (!tableExists(db, 'worker_tasks')) return 0;
  const waiting = tableExists(db, 'worker_attempts')
    ? " AND NOT EXISTS (SELECT 1 FROM worker_attempts a WHERE a.task_id = worker_tasks.id AND a.attempt = worker_tasks.current_attempt AND json_extract(a.body, '$.state') = 'waiting')"
    : '';
  return (
    db
      .query(
        `SELECT count(*) AS count FROM worker_tasks WHERE coalesce(json_extract(body, '$.brief.urgent'),0) != 1 AND json_extract(body, '$.state') = 'running'${waiting}`,
      )
      .get() as { count: number }
  ).count;
}

function storedAdmission(
  body: { sequence?: number; taskClass?: TaskClass; brief?: Brief },
  table: RoutingTable,
): { first: Profile; fallbacks: Profile[] } | undefined {
  const brief = body.brief;
  if (!brief || typeof brief !== 'object') return undefined;
  const sequence = Number.isSafeInteger(body.sequence) && (body.sequence ?? 0) > 0 ? body.sequence! : 1;
  return admissionProfiles(brief, table, sequence);
}

type ActiveBreakdown = { running: number; readyOther: number; readyWaiting: number };

function activeBreakdown(runtime: BacklogRuntime, now: number): ActiveBreakdown {
  const { db } = runtime;
  if (!runtime.routing || !tableExists(db, 'worker_tasks'))
    return { running: activeTaskCount(db), readyOther: 0, readyWaiting: 0 };
  const readings = runtime.routing.readings ?? readRetainedPoolReadings(runtime.stateDirectory);
  const options = {
    now,
    spanMs: (runtime.policy ?? defaultPolicy).pacing.burnSpanMs,
    history: readings,
    policy: (runtime.policy ?? defaultPolicy).provider,
  };
  const rows = db
    .query(
      `SELECT sequence, body FROM worker_tasks WHERE coalesce(json_extract(body, '$.brief.urgent'),0) != 1 AND json_extract(body, '$.state') = 'ready'`,
    )
    .all() as { sequence: number; body: string }[];
  let readyWaiting = 0;
  let readyOther = 0;
  for (const row of rows) {
    let parsed: { sequence?: number; taskClass?: TaskClass; brief?: Brief };
    try {
      parsed = { ...(JSON.parse(row.body) as { taskClass?: TaskClass; brief?: Brief }), sequence: row.sequence };
    } catch {
      readyOther += 1;
      continue;
    }
    const profiles = storedAdmission(parsed, runtime.routing.table);
    if (!profiles) {
      readyOther += 1;
      continue;
    }
    if (findAllowedPool(profiles.first, profiles.fallbacks, runtime.routing.pools, readings, options)) readyOther += 1;
    else readyWaiting += 1;
  }
  return { running: runningTaskCount(db), readyOther, readyWaiting };
}

function oneLine(text: string, limit: number): string {
  const line = text.replace(/\s+/g, ' ').trim();
  return line.length > limit ? `${line.slice(0, limit - 1)}…` : line;
}

function notifyRefusals(runtime: BacklogRuntime, goal: string, refused: { brief: string; reason: string }[]): void {
  if (!refused.length) return;
  const directory = backlogDirectory(runtime.stateDirectory, goal);
  const listed = refused
    .slice(0, (runtime.policy ?? defaultPolicy).backlog.refusalBriefs)
    .map(
      (entry) =>
        `${entry.brief} (${oneLine(entry.reason, (runtime.policy ?? defaultPolicy).backlog.refusalReasonCharacters)})`,
    )
    .join('; ');
  const more =
    refused.length > (runtime.policy ?? defaultPolicy).backlog.refusalBriefs
      ? `; and ${refused.length - (runtime.policy ?? defaultPolicy).backlog.refusalBriefs} more`
      : '';
  runtime.inbox.deliver({
    managerId: goal,
    goalId: goal,
    kind: 'instruction',
    summary: oneLine(
      `Backlog dispatch refused ${refused.length} brief(s): ${listed}${more}. The briefs and their .reason files are in ${join(directory, FAILED_DIRECTORY)}; fix each and move it back to ${directory}.`,
      (runtime.policy ?? defaultPolicy).backlog.refusalSummaryCharacters,
    ),
  });
}

type BriefPick = { goal: string; file: string; allowed: boolean };

type GoalQueue = { goal: string; files: string[] };

function goalDispatchOrder(runtime: BacklogRuntime, goals: string[], now: number): GoalQueue[] {
  const order = new Map(
    (
      runtime.db.query('SELECT goal, last_dispatch_at FROM backlog_goals').all() as {
        goal: string;
        last_dispatch_at: number | null;
      }[]
    ).map((row) => [row.goal, row.last_dispatch_at ?? 0]),
  );
  // The Goal served longest ago goes first, so a run with one free slot does not always serve the same Goal.
  return goals
    .map((goal) => ({
      goal,
      files: briefs(
        backlogDirectory(runtime.stateDirectory, goal),
        now - (runtime.policy ?? defaultPolicy).backlog.settleMs,
      ),
    }))
    .filter((queue) => queue.files.length)
    .sort((a, b) => (order.get(a.goal) ?? 0) - (order.get(b.goal) ?? 0) || a.goal.localeCompare(b.goal));
}

function takeRoundRobin(queues: GoalQueue[], need: number, allowed: boolean): BriefPick[] {
  const picks: BriefPick[] = [];
  while (picks.length < need) {
    let any = false;
    for (const queue of queues) {
      if (picks.length >= need) break;
      const file = queue.files.shift();
      if (!file) continue;
      picks.push({ goal: queue.goal, file, allowed });
      any = true;
    }
    if (!any) break;
  }
  return picks;
}

function remainingNearCeilingStarts(
  pool: Pool,
  started: Map<string, number>,
  burns: ReturnType<typeof poolBurnStatus>,
  policy: ControlPolicy['pacing'],
): number | undefined {
  const status = burns.find((entry) => entry.name === pool.name);
  if (status?.maxBurnPerHour === undefined) return undefined;
  return nearCeilingSweepAdmissions(
    status.burnPerHour,
    status.maxBurnPerHour,
    started.get(pool.allowanceKey) ?? 0,
    policy,
  );
}

function candidatePool(
  markdown: string,
  runtime: BacklogRuntime,
  now: number,
  readings: PoolReading[],
  exclude: string[],
): { allowed: boolean; pool?: Pool } {
  const routing = runtime.routing;
  if (!routing) return { allowed: true };
  try {
    if (readResearchFanout(markdown)) return { allowed: true };
    const brief = parseBrief(markdown, routing.ownership, (runtime.policy ?? defaultPolicy).brief);
    const profiles = admissionProfiles(brief, routing.table);
    const found = findAllowedPool(profiles.first, profiles.fallbacks, routing.pools, readings, {
      now,
      spanMs: (runtime.policy ?? defaultPolicy).pacing.burnSpanMs,
      history: readings,
      policy: (runtime.policy ?? defaultPolicy).provider,
      exclude,
    });
    return found ? { allowed: true, pool: found.pool } : { allowed: false };
  } catch {
    // Untrusted brief text: keep it in the waiting group so ordinary dispatch can refuse it.
    return { allowed: false };
  }
}

function pickBriefs(
  runtime: BacklogRuntime,
  goals: string[],
  allowedNeed: number,
  waiterNeed: number,
  now: number,
): BriefPick[] {
  if (allowedNeed <= 0 && waiterNeed <= 0) return [];
  const queues = goalDispatchOrder(runtime, goals, now);
  if (!runtime.routing) return takeRoundRobin(queues, allowedNeed, true);
  const policy = runtime.policy ?? defaultPolicy;
  const readings = runtime.routing.readings ?? readRetainedPoolReadings(runtime.stateDirectory);
  const burns = poolBurnStatus(runtime.routing.pools, readings, now, policy.pacing.burnSpanMs);
  const started = new Map<string, number>();
  const allowed: GoalQueue[] = queues.map((queue) => ({ goal: queue.goal, files: [] }));
  const waiting: GoalQueue[] = queues.map((queue) => ({ goal: queue.goal, files: [] }));
  const allowedByGoal = new Map(allowed.map((queue) => [queue.goal, queue]));
  const waitingByGoal = new Map(waiting.map((queue) => [queue.goal, queue]));
  for (const queue of queues) {
    for (const file of queue.files) {
      let markdown: string;
      try {
        markdown = readFileSync(file, 'utf8');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
        throw error;
      }
      const candidate = candidatePool(markdown, runtime, now, readings, []);
      (candidate.allowed ? allowedByGoal : waitingByGoal).get(queue.goal)?.files.push(file);
    }
  }
  const allowedPicks: BriefPick[] = [];
  const allowedQueues = allowed.filter((queue) => queue.files.length);
  while (allowedPicks.length < allowedNeed) {
    let any = false;
    for (const queue of allowedQueues) {
      if (allowedPicks.length >= allowedNeed) break;
      while (queue.files.length) {
        const file = queue.files.shift();
        if (!file) break;
        let markdown: string;
        try {
          markdown = readFileSync(file, 'utf8');
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
          throw error;
        }
        const exhausted = runtime.routing.pools
          .filter((pool) => remainingNearCeilingStarts(pool, started, burns, policy.pacing) === 0)
          .map((pool) => pool.name);
        const candidate = candidatePool(markdown, runtime, now, readings, exhausted);
        if (!candidate.allowed) continue;
        if (candidate.pool) {
          const remaining = remainingNearCeilingStarts(candidate.pool, started, burns, policy.pacing);
          if (remaining === 0) continue;
          if (remaining !== undefined)
            started.set(candidate.pool.allowanceKey, (started.get(candidate.pool.allowanceKey) ?? 0) + 1);
        }
        allowedPicks.push({ goal: queue.goal, file, allowed: true });
        any = true;
        break;
      }
    }
    if (!any) break;
  }
  return [
    ...allowedPicks,
    ...takeRoundRobin(
      waiting.filter((queue) => queue.files.length),
      Math.max(0, Math.min(waiterNeed, allowedNeed + waiterNeed - allowedPicks.length)),
      false,
    ),
  ];
}

async function dispatchReady(
  runtime: BacklogRuntime,
  now: number,
): Promise<Pick<BacklogSweep, 'dispatched' | 'continued' | 'refused'>> {
  const root = backlogDirectory(runtime.stateDirectory);
  const goals = directories(root);
  const dispatched: BacklogSweep['dispatched'] = [];
  const continued: BacklogSweep['continued'] = [];
  const refused: BacklogSweep['refused'] = [];
  const refusedByGoal = new Map<string, { brief: string; reason: string }[]>();
  const refuse = (goal: string, brief: string, reason: string) => {
    refused.push({ goal, brief, reason });
    refusedByGoal.set(goal, [...(refusedByGoal.get(goal) ?? []), { brief, reason }]);
  };
  const cap =
    runtime.workerCap ??
    backlogWorkerCap(runtime.stateDirectory, (runtime.policy ?? defaultPolicy).capacity.maxWorkers);
  const perSweep = runtime.perSweep ?? (runtime.policy ?? defaultPolicy).backlog.dispatchesPerSweep;
  const policy = runtime.policy ?? defaultPolicy;
  const breakdown = activeBreakdown(runtime, now);
  const allowedSlots = Math.max(0, cap - breakdown.running - breakdown.readyOther);
  const waiterSlots = Math.max(
    0,
    cap -
      breakdown.running -
      breakdown.readyOther -
      Math.max(0, breakdown.readyWaiting - policy.backlog.allowanceWaitingBound),
  );
  let available = Math.max(0, Math.min(allowedSlots, perSweep));
  let sweepLeft = perSweep;
  for (const goal of goals) {
    const research = await recoverResearchClaims(runtime, goal, available);
    for (const entry of research.dispatched) dispatched.push({ goal, ...entry });
    for (const completion of research.completed) recordGoalDispatch(runtime, completion.goal, completion.writtenMs);
    available -= research.started;
    sweepLeft -= research.started;
    const recovered = recoverClaims(runtime, goal);
    for (const entry of recovered.dispatched) dispatched.push({ goal, ...entry });
    for (const entry of recovered.refused) refuse(goal, entry.brief, entry.reason);
  }

  const waiterNeed = Math.max(0, Math.min(sweepLeft, waiterSlots));
  let waiterLeft = waiterNeed;
  for (const pick of pickBriefs(runtime, goals, available, waiterNeed, now)) {
    if (sweepLeft <= 0) break;
    if (pick.allowed ? available <= 0 : waiterLeft <= 0) continue;
    const goalDirectory = join(root, pick.goal);
    const claimDirectory = join(goalDirectory, CLAIM_DIRECTORY);
    const claimed = join(claimDirectory, basename(pick.file));
    mkdirSync(claimDirectory, { recursive: true });
    let written: number;
    try {
      written = statSync(pick.file).mtimeMs;
      // The rename is the claim: a manager that moved the brief away in the meantime keeps it.
      renameSync(pick.file, claimed);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw error;
    }
    let taskId: string;
    let lintWarnings: string[] = [];
    let continuation: BriefContinuation | undefined;
    let groupedResearch = false;
    try {
      const markdown = readFileSync(claimed, 'utf8');
      continuation = readBriefContinuation(markdown);
      // Worker remainders create new work; manager-authored retries retain their exact-owner validation.
      if (basename(claimed).startsWith('continuation-')) {
        // Each claimed brief gets a fresh projection so the next admission sees completed dispatches and edits.
        const admission = continuationAdmissionProjection(runtime.stateDirectory, pick.goal, runtime.policy);
        const claimedName = basename(claimed);
        const source =
          continuation?.taskId ??
          (
            runtime.db
              .query("SELECT id FROM worker_tasks WHERE json_extract(body, '$.brief.goal') = ?")
              .all(pick.goal) as { id: string }[]
          ).find((row) => claimedName.startsWith(`continuation-${row.id.slice(0, 8)}-`))?.id;
        const sourcePrefix = source ? `continuation-${source.slice(0, 8)}-` : undefined;
        const parsedAttempt =
          sourcePrefix && claimedName.startsWith(sourcePrefix)
            ? Number(/^(\d+)-/.exec(claimedName.slice(sourcePrefix.length))?.[1])
            : Number.NaN;
        const overlap = continuationOverlap(
          runtime.db,
          runtime.stateDirectory,
          pick.goal,
          markdown,
          source,
          [claimed],
          runtime.policy?.brief,
          Number.isSafeInteger(parsedAttempt) && parsedAttempt > 0 ? parsedAttempt : undefined,
          admission,
        );
        const reason =
          overlap.reason ??
          (continuationReview(runtime.stateDirectory, pick.goal, runtime.policy, 0, admission) &&
          !continuationReleased(runtime.stateDirectory, pick.goal, claimedName, markdown)
            ? 'Goal continuation review is enabled; release or retire this proposal'
            : undefined);
        if (reason) {
          const proposed = proposeContinuation(claimed, runtime.stateDirectory, pick.goal, reason);
          runtime.inbox.deliver({
            managerId: pick.goal,
            goalId: pick.goal,
            kind: 'instruction',
            summary: `Continuation proposed at ${proposed}: ${reason}`,
          });
          continue;
        }
        if (overlap.after.length) writeFileSync(claimed, withContinuationAfter(markdown, overlap.after));
      }
      if (continuation) {
        await runtime.continueTask(pick.goal, continuation, claimed);
        taskId = continuation.taskId;
      } else {
        const research = readResearchFanout(markdown);
        if (research) {
          groupedResearch = true;
          const group = await dispatchResearchClaim(runtime, pick.goal, claimed, markdown, written, available);
          available -= group.started;
          sweepLeft -= group.started;
          for (const entry of group.dispatched) dispatched.push({ goal: pick.goal, ...entry });
          if (group.complete) recordGoalDispatch(runtime, pick.goal, group.writtenMs);
          continue;
        }
        const dispatchedTask = dispatchResult(await runtime.dispatch(claimed));
        taskId = dispatchedTask.taskId;
        lintWarnings = dispatchedTask.lintWarnings.length
          ? dispatchedTask.lintWarnings
          : taskLintWarnings(runtime.db, taskId);
      }
    } catch (error) {
      if (groupedResearch) throw error;
      const reason = errorText(error);
      let archivedBrief = basename(pick.file);
      try {
        archivedBrief = fail(goalDirectory, claimed, reason);
      } catch (moveError) {
        console.error(`backlog could not move refused brief ${claimed}:`, moveError);
      }
      refuse(pick.goal, archivedBrief, reason);
      continue;
    }
    const target = join(goalDirectory, continuation ? 'continued' : DISPATCHED_DIRECTORY);
    mkdirSync(target, { recursive: true });
    const targetName = continuation
      ? `${taskId}-${continuation.expectedAttempt}-${basename(pick.file)}`
      : `${taskId}-${basename(pick.file)}`;
    renameSync(claimed, join(target, targetName));
    // The write time lets turn accounting see a brief its manager wrote in a turn that the run already dispatched.
    recordGoalDispatch(runtime, pick.goal, written);
    sweepLeft -= 1;
    if (pick.allowed) available -= 1;
    else waiterLeft -= 1;
    if (continuation)
      continued.push({ goal: pick.goal, taskId, attempt: continuation.expectedAttempt, brief: basename(pick.file) });
    else
      dispatched.push({
        goal: pick.goal,
        taskId,
        brief: basename(pick.file),
        ...(lintWarnings.length ? { lintWarnings } : {}),
      });
  }
  for (const [goal, entries] of refusedByGoal) notifyRefusals(runtime, goal, entries);
  return { dispatched, continued, refused };
}

type StoppedRow = { id: string; current_attempt: number; body: string };
type StoppedTask = {
  id: string;
  state?: string;
  createdAt?: string;
  branch?: string;
  brief?: { goal?: string; manager?: string; target?: string; kind?: string; markdown?: string };
};

function lastActivity(db: Database, task: StoppedTask, attempt: number): number | null {
  const event = db
    .query('SELECT at FROM worker_events WHERE task_id=? AND attempt=? ORDER BY sequence DESC LIMIT 1')
    .get(task.id, attempt) as { at: string } | null;
  const times = [event?.at, task.createdAt].map((value) => (value ? Date.parse(value) : Number.NaN));
  if (attempt > 0 && tableExists(db, 'worker_attempts')) {
    const ended = db
      .query("SELECT json_extract(body, '$.endedAt') AS ended FROM worker_attempts WHERE task_id=? AND attempt=?")
      .get(task.id, attempt) as { ended: string | null } | null;
    if (ended?.ended) times.push(Date.parse(ended.ended));
  }
  const known = times.filter((value) => Number.isFinite(value));
  return known.length ? Math.max(...known) : null;
}

function hasPendingRetry(db: Database, taskId: string, attempt: number): boolean {
  if (!tableExists(db, 'worker_retry_intents')) return false;
  return Boolean(
    db
      .query(
        "SELECT 1 FROM worker_retry_intents WHERE task_id=? AND attempt=? AND json_extract(body, '$.status')='pending'",
      )
      .get(taskId, attempt),
  );
}

function blocker(db: Database, taskId: string, attempt: number): string {
  if (attempt > 0 && tableExists(db, 'worker_attempts')) {
    const row = db
      .query(
        `SELECT json_extract(body, '$.blocker') AS blocker, json_extract(body, '$.result') AS result
        FROM worker_attempts WHERE task_id=? AND attempt=?`,
      )
      .get(taskId, attempt) as { blocker: string | null; result: string | null } | null;
    const text = row?.blocker?.trim() || row?.result?.trim();
    if (text) return text;
  }
  const event = db
    .query("SELECT body FROM worker_events WHERE task_id=? AND kind='manager-event' ORDER BY sequence DESC LIMIT 1")
    .get(taskId) as { body: string } | null;
  try {
    const summary = event ? (JSON.parse(event.body) as { summary?: unknown }).summary : undefined;
    if (typeof summary === 'string' && summary.trim()) return summary.trim();
  } catch {
    // An unreadable event body leaves the blocker unknown.
  }
  return 'The stopped attempt recorded no blocker.';
}

/**
 * A product task stopped for more than an hour without a manager action is cancelled; its brief and blocker go to
 * `backlog/<goal>/failed/`, and its owner receives one event per run. At most 20 per Goal go per run, longest stopped
 * first; control-plane and stabilize work is exempt.
 */
async function expireStoppedTasks(runtime: BacklogRuntime, now: number): Promise<BacklogSweep['expired']> {
  const { db } = runtime;
  if (!tableExists(db, 'worker_tasks') || !tableExists(db, 'worker_events')) return [];
  const rows = db
    .query(
      "SELECT id, current_attempt, body FROM worker_tasks WHERE json_extract(body, '$.state')='stopped' ORDER BY sequence",
    )
    .all() as StoppedRow[];
  const expired: BacklogSweep['expired'] = [];
  const byOwner = new Map<string, { goal: string; tasks: string[] }>();
  const candidates: { row: StoppedRow; task: StoppedTask; goal: string; manager: string; since: number }[] = [];
  for (const row of rows) {
    let task: StoppedTask;
    try {
      task = { ...(JSON.parse(row.body) as StoppedTask), id: row.id };
    } catch {
      continue;
    }
    const goal = task.brief?.goal;
    const manager = task.brief?.manager;
    if (!goal || !manager || goal === 'control-plane' || task.brief?.target === 'stabilize') continue;
    // Original proofs hold check custody that cancellation does not release; their owner decides.
    if (task.brief?.kind === 'verification') continue;
    if (hasPendingRetry(db, task.id, row.current_attempt)) continue;
    const since = lastActivity(db, task, row.current_attempt);
    if (since === null || now - since <= (runtime.policy ?? defaultPolicy).backlog.stoppedTaskLimitMs) continue;
    candidates.push({ row, task, goal, manager, since });
  }
  const perGoal = new Map<string, number>();
  for (const { row, task, goal, manager, since } of candidates.sort((a, b) => a.since - b.since)) {
    const count = perGoal.get(goal) ?? 0;
    if (count >= (runtime.policy ?? defaultPolicy).backlog.stoppedTasksPerGoalPerRun) continue;
    perGoal.set(goal, count + 1);
    const failed = join(backlogDirectory(runtime.stateDirectory, goal), FAILED_DIRECTORY);
    const brief = join(failed, `${task.id}.md`);
    const reason = join(failed, `${task.id}.reason`);
    try {
      mkdirSync(failed, { recursive: true });
      writeFileSync(brief, task.brief?.markdown ?? '');
      writeFileSync(
        reason,
        `Task ${task.id} (branch ${task.branch ?? 'unknown'}) was stopped from ${new Date(since).toISOString()} ` +
          `without a manager action and was cancelled.\n\n${blocker(db, task.id, row.current_attempt)}\n`,
      );
      await runtime.cancel(task.id);
    } catch (error) {
      rmSync(brief, { force: true });
      rmSync(reason, { force: true });
      console.error(`stopped-task limit could not cancel ${task.id}:`, error);
      continue;
    }
    expired.push({ goal, taskId: task.id });
    const key = `${manager}\u0000${goal}`;
    const owner = byOwner.get(key) ?? { goal, tasks: [] };
    owner.tasks.push(task.id);
    byOwner.set(key, owner);
  }
  for (const [key, owner] of byOwner) {
    const managerId = key.split('\u0000', 1)[0]!;
    const listed =
      owner.tasks.slice(0, (runtime.policy ?? defaultPolicy).backlog.expiredTaskExamples).join(', ') +
      (owner.tasks.length > (runtime.policy ?? defaultPolicy).backlog.expiredTaskExamples
        ? ` and ${owner.tasks.length - (runtime.policy ?? defaultPolicy).backlog.expiredTaskExamples} more`
        : '');
    const event: ManagerEvent = {
      managerId,
      goalId: owner.goal,
      kind: 'instruction',
      summary:
        `Stopped-task limit: ${owner.tasks.length} task(s) stopped for over an hour without action were cancelled: ${listed}. ` +
        `Each brief and blocker is in ${join(backlogDirectory(runtime.stateDirectory, owner.goal), FAILED_DIRECTORY)}; ` +
        'rewrite it into the backlog, split it or drop it.',
    };
    runtime.inbox.deliver(event);
  }
  return expired;
}

type ManagerRow = { id: string; state: string };

/** Wake each running Goal manager below the low-water mark, at most once an hour. */
function wakeLowBacklogs(runtime: BacklogRuntime, now: number): string[] {
  const { db } = runtime;
  if (!tableExists(db, 'manager_sessions')) return [];
  const woken: string[] = [];
  for (const row of db.query('SELECT id, state FROM manager_sessions ORDER BY id').all() as ManagerRow[]) {
    let state: { kind?: string; status?: string; goal?: string; goalState?: { status?: string } | null };
    try {
      state = JSON.parse(row.state);
    } catch {
      continue;
    }
    if (state.kind === 'resident-supermanager' || state.status !== 'running' || !state.goal) continue;
    if (['paused', 'budgetLimited', 'complete'].includes(state.goalState?.status ?? '')) continue;
    const goal = state.goal;
    const directory = backlogDirectory(runtime.stateDirectory, goal);
    const ready = briefs(directory).length;
    if (ready >= (runtime.policy ?? defaultPolicy).backlog.lowWater) continue;
    const delivered = db
      .transaction(() => {
        const last = db.query('SELECT low_wake_at FROM backlog_goals WHERE goal=?').get(goal) as {
          low_wake_at: number | null;
        } | null;
        if (
          last?.low_wake_at != null &&
          now - last.low_wake_at < (runtime.policy ?? defaultPolicy).backlog.wakeIntervalMs
        )
          return false;
        db.query(
          `INSERT INTO backlog_goals(goal, low_wake_at) VALUES (?, ?)
          ON CONFLICT(goal) DO UPDATE SET low_wake_at = excluded.low_wake_at`,
        ).run(goal, now);
        runtime.inbox.deliver({
          managerId: row.id,
          goalId: goal,
          kind: 'instruction',
          summary:
            `Backlog low: ${ready} ready brief(s) in ${directory}. Write ready briefs there to keep about ${(runtime.policy ?? defaultPolicy).backlog.lowWater}, ` +
            "each a complete outcome from your Goal definition's Done when list not yet accepted; when fewer exist, say so in a handoff instead of writing slivers. " +
            'The controller dispatches the oldest whenever worker slots are free.',
        });
        return true;
      })
      .immediate();
    if (delivered) woken.push(row.id);
  }
  return woken;
}

/**
 * One controller run, in a child process the manager host starts each minute: cancel stopped tasks past their
 * limit, dispatch briefs that have an allowed pool now (then others) round-robin across Goals while active tasks are
 * below the cap, and wake managers with a low backlog.
 */
export async function sweepBacklog(runtime: BacklogRuntime): Promise<BacklogSweep> {
  // One run at a time, across host restarts too: claim recovery assumes no other run holds a claim.
  let lease;
  try {
    lease = acquireDirectoryLease(join(runtime.stateDirectory, 'leases', 'backlog'), runtime.policy?.leases);
  } catch (error) {
    if (error instanceof LeaseHeldError)
      return { skipped: true, dispatched: [], continued: [], refused: [], expired: [], woken: [] };
    throw error;
  }
  try {
    migrate(runtime.db, backlogMigrations);
    const now = (runtime.now ?? Date.now)();
    const expired = await expireStoppedTasks(runtime, now);
    const { dispatched, continued, refused } = await dispatchReady(runtime, now);
    deliverResearchCompletions(runtime, now);
    const woken = wakeLowBacklogs(runtime, now);
    return { dispatched, continued, refused, expired, woken };
  } finally {
    lease.release();
  }
}
