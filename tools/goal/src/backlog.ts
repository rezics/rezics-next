import { defaultPolicy, type ControlPolicy } from './policy.ts';
import { createHash } from 'node:crypto';
import { Buffer } from 'node:buffer';
import type { Database } from 'bun:sqlite';
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import type { ManagerEvent, ManagerInbox } from './contracts.ts';
import { migrate } from './db.ts';
import { acquireDirectoryLease, LeaseHeldError } from './lease.ts';
import { readBriefContinuation } from './briefs.ts';
import type { BriefContinuation } from './types.ts';

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
const CLAIM_DIRECTORY = '.dispatching';
const DISPATCHED_DIRECTORY = 'dispatched';
const FAILED_DIRECTORY = 'failed';

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
] as const;

export type BacklogGoalCounts = { goal: string; ready: number; dispatched: number; failed: number };

export type BacklogRuntime = {
  db: Database;
  stateDirectory: string;
  inbox: ManagerInbox;
  /** The `goal dispatch` path: create the task and request its first attempt. Returns the new task ID. */
  dispatch(briefFile: string): Promise<string>;
  /** Queue a continuation through the existing task retry path. */
  continueTask(goal: string, continuation: BriefContinuation, briefFile: string): Promise<void>;
  /** The `goal cancel` path. */
  cancel(taskId: string): Promise<void>;
  now?: () => number;
  policy?: ControlPolicy;
  /** Active-task cap; defaults to `maxWorkers` in `<state>/capacity.json`, else 32. */
  workerCap?: number;
  perSweep?: number;
};

export type BacklogSweep = {
  /** Another run held the backlog lease, so this one did nothing. */
  skipped?: true;
  dispatched: { goal: string; taskId: string; brief: string }[];
  continued: { goal: string; taskId: string; attempt: number; brief: string }[];
  refused: { goal: string; brief: string; reason: string }[];
  expired: { goal: string; taskId: string }[];
  woken: string[];
};

export function backlogDirectory(stateDirectory: string, goal?: string): string {
  return goal === undefined ? join(stateDirectory, 'backlog') : join(stateDirectory, 'backlog', goal);
}

function tableExists(db: Database, name: string): boolean {
  return Boolean(db.query("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name));
}

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
function briefs(path: string, settledBefore = Number.POSITIVE_INFINITY): string[] {
  let entries;
  try {
    entries = readdirSync(path, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  const files: { path: string; name: string; modified: number }[] = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.md') || entry.name.startsWith('.')) continue;
    const file = join(path, entry.name);
    try {
      const modified = statSync(file).mtimeMs;
      if (modified < settledBefore) files.push({ path: file, name: entry.name, modified });
    } catch {
      // A manager may move a brief away between listing and stat.
    }
  }
  return files.sort((a, b) => a.modified - b.modified || a.name.localeCompare(b.name)).map((file) => file.path);
}

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
        `SELECT count(*) AS count FROM worker_tasks WHERE json_extract(body, '$.state') = 'ready' OR (json_extract(body, '$.state') = 'running'${waiting})`,
      )
      .get() as { count: number }
  ).count;
}

function oneLine(text: string, limit: number): string {
  const line = text.replace(/\s+/g, ' ').trim();
  return line.length > limit ? `${line.slice(0, limit - 1)}…` : line;
}

function errorText(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}

function stem(file: string): string {
  return basename(file, '.md');
}

function recordGoalDispatch(runtime: BacklogRuntime, goal: string, writtenMs: number): void {
  runtime.db
    .query(
      `INSERT INTO backlog_goals(goal, last_dispatch_at, last_written_at) VALUES (?, ?, ?)
        ON CONFLICT(goal) DO UPDATE SET last_dispatch_at = excluded.last_dispatch_at,
          last_written_at = max(coalesce(last_written_at, 0), excluded.last_written_at)`,
    )
    .run(goal, (runtime.now ?? Date.now)(), Math.floor(writtenMs));
}

function failedBriefName(file: string, sequence: number): string {
  if (sequence === 1) return basename(file);
  const suffix = `-${sequence}`;
  // POSIX filename components are bounded in bytes, independently of control-plane policy.
  const maxStemBytes = 255 - Buffer.byteLength(`${suffix}.md`);
  let name = '';
  for (const character of stem(file)) {
    const next = name + character;
    if (Buffer.byteLength(next) > maxStemBytes) break;
    name = next;
  }
  return `${name}${suffix}.md`;
}

function failureFingerprint(file: string): string {
  return createHash('sha256').update(readFileSync(file)).digest('hex');
}

function finishInterruptedFailure(
  failed: string,
  file: string,
  fingerprint: string,
): { brief: string; reason: string } | undefined {
  const marker = `<!-- backlog-refusal:${fingerprint} -->`;
  for (let sequence = 1; ; sequence++) {
    const name = failedBriefName(file, sequence);
    const briefPath = join(failed, name);
    const reasonPath = join(failed, `${stem(name)}.reason`);
    if (existsSync(briefPath)) continue;
    if (!existsSync(reasonPath)) return undefined;
    const storedReason = readFileSync(reasonPath, 'utf8');
    if (!storedReason.trimEnd().endsWith(marker)) continue;
    renameSync(file, briefPath);
    const markerStart = storedReason.lastIndexOf('\n\n<!-- backlog-refusal:');
    return { brief: name, reason: storedReason.slice(0, markerStart).trimEnd() };
  }
}

/** Move a brief into `failed/` beside a `.reason` file holding the refusal. */
function fail(goalDirectory: string, file: string, reason: string): string {
  const failed = join(goalDirectory, FAILED_DIRECTORY);
  mkdirSync(failed, { recursive: true });
  const refusal = reason.trim();
  const fingerprint = failureFingerprint(file);
  const marker = `<!-- backlog-refusal:${fingerprint} -->`;
  const resumed = finishInterruptedFailure(failed, file, fingerprint);
  if (resumed) return resumed.brief;
  for (let sequence = 1; ; sequence++) {
    const name = failedBriefName(file, sequence);
    const briefPath = join(failed, name);
    const reasonPath = join(failed, `${stem(name)}.reason`);
    if (existsSync(briefPath)) continue;
    if (existsSync(reasonPath)) {
      if (readFileSync(reasonPath, 'utf8').trimEnd().endsWith(marker)) {
        renameSync(file, briefPath);
        return name;
      }
      continue;
    }

    const temporaryReason = join(failed, `.${name}.reason.tmp`);
    writeFileSync(temporaryReason, `${refusal}\n\n${marker}\n`);
    renameSync(temporaryReason, reasonPath);
    renameSync(file, briefPath);
    return name;
  }
}

function returnClaimToReady(goalDirectory: string, file: string): void {
  const ready = join(goalDirectory, basename(file));
  if (existsSync(ready)) throw new Error(`cannot recover claim because ${basename(file)} already exists`);
  renameSync(file, ready);
}

function taskHasDispatchArchive(goalDirectory: string, taskId: string): boolean {
  try {
    const prefix = `${taskId}-`;
    return readdirSync(join(goalDirectory, DISPATCHED_DIRECTORY)).some(
      (name) => name.startsWith(prefix) && name.endsWith('.md'),
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

/** Unarchived tasks in this Goal whose stored brief text is this claim. */
function unarchivedTasksForBrief(runtime: BacklogRuntime, goal: string, markdown: string): string[] {
  if (!tableExists(runtime.db, 'worker_tasks')) return [];
  const goalDirectory = backlogDirectory(runtime.stateDirectory, goal);
  const ids: string[] = [];
  for (const row of runtime.db.query('SELECT id, body FROM worker_tasks').all() as { id: string; body: string }[]) {
    let brief: { goal?: string; markdown?: string } | undefined;
    try {
      brief = (JSON.parse(row.body) as { brief?: { goal?: string; markdown?: string } }).brief;
    } catch {
      continue;
    }
    if (brief?.goal !== goal || brief.markdown !== markdown) continue;
    if (taskHasDispatchArchive(goalDirectory, row.id)) continue;
    ids.push(row.id);
  }
  return ids.sort();
}

function archiveCommittedClaim(runtime: BacklogRuntime, goal: string, file: string, taskId: string): void {
  const goalDirectory = backlogDirectory(runtime.stateDirectory, goal);
  const target = join(goalDirectory, DISPATCHED_DIRECTORY);
  mkdirSync(target, { recursive: true });
  const dest = join(target, `${taskId}-${basename(file)}`);
  if (existsSync(dest)) {
    if (readFileSync(dest, 'utf8') !== readFileSync(file, 'utf8'))
      throw new Error(
        `cannot archive interrupted dispatch of ${basename(file)} onto task ${taskId} because ${dest} already exists with different contents`,
      );
    rmSync(file);
    return;
  }
  const written = statSync(file).mtimeMs;
  renameSync(file, dest);
  recordGoalDispatch(runtime, goal, written);
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

/**
 * A claim left by a host that stopped mid-dispatch: archive a unique committed task, return an uncommitted
 * claim to ready, and refuse when several unarchived tasks share this brief.
 */
function recoverClaims(
  runtime: BacklogRuntime,
  goal: string,
): { dispatched: { taskId: string; brief: string }[]; refused: { brief: string; reason: string }[] } {
  const goalDirectory = backlogDirectory(runtime.stateDirectory, goal);
  const dispatched: { taskId: string; brief: string }[] = [];
  const refused: { brief: string; reason: string }[] = [];
  for (const file of briefs(join(goalDirectory, CLAIM_DIRECTORY))) {
    try {
      const interruptedFailure = finishInterruptedFailure(
        join(goalDirectory, FAILED_DIRECTORY),
        file,
        failureFingerprint(file),
      );
      if (interruptedFailure) {
        refused.push(interruptedFailure);
        continue;
      }
      const markdown = readFileSync(file, 'utf8');
      if (readBriefContinuation(markdown)) {
        returnClaimToReady(goalDirectory, file);
        continue;
      }
      const matches = unarchivedTasksForBrief(runtime, goal, markdown);
      if (matches.length > 1)
        throw new Error(
          `Interrupted dispatch of ${basename(file)} matches multiple unarchived tasks (${matches.join(', ')}). Inspect those tasks and archive or fail this brief by hand; do not submit it again.`,
        );
      if (matches.length === 1) {
        archiveCommittedClaim(runtime, goal, file, matches[0]!);
        dispatched.push({ taskId: matches[0]!, brief: basename(file) });
        continue;
      }
      returnClaimToReady(goalDirectory, file);
    } catch (error) {
      const reason = errorText(error);
      try {
        const archivedBrief = fail(goalDirectory, file, reason);
        refused.push({ brief: archivedBrief, reason });
      } catch (moveError) {
        console.error(`backlog claim recovery failed for ${file}:`, moveError);
      }
    }
  }
  return { dispatched, refused };
}

type BriefPick = { goal: string; file: string };

function pickBriefs(runtime: BacklogRuntime, goals: string[], need: number, now: number): BriefPick[] {
  if (need <= 0) return [];
  const order = new Map(
    (
      runtime.db.query('SELECT goal, last_dispatch_at FROM backlog_goals').all() as {
        goal: string;
        last_dispatch_at: number | null;
      }[]
    ).map((row) => [row.goal, row.last_dispatch_at ?? 0]),
  );
  // The Goal served longest ago goes first, so a run with one free slot does not always serve the same Goal.
  const queues = goals
    .map((goal) => ({
      goal,
      files: briefs(
        backlogDirectory(runtime.stateDirectory, goal),
        now - (runtime.policy ?? defaultPolicy).backlog.settleMs,
      ),
    }))
    .filter((queue) => queue.files.length)
    .sort((a, b) => (order.get(a.goal) ?? 0) - (order.get(b.goal) ?? 0) || a.goal.localeCompare(b.goal));
  const picks: BriefPick[] = [];
  while (picks.length < need) {
    let any = false;
    for (const queue of queues) {
      if (picks.length >= need) break;
      const file = queue.files.shift();
      if (!file) continue;
      picks.push({ goal: queue.goal, file });
      any = true;
    }
    if (!any) break;
  }
  return picks;
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
  for (const goal of goals) {
    const recovered = recoverClaims(runtime, goal);
    for (const entry of recovered.dispatched) dispatched.push({ goal, ...entry });
    for (const entry of recovered.refused) refuse(goal, entry.brief, entry.reason);
  }

  const cap =
    runtime.workerCap ??
    backlogWorkerCap(runtime.stateDirectory, (runtime.policy ?? defaultPolicy).capacity.maxWorkers);
  const perSweep = runtime.perSweep ?? (runtime.policy ?? defaultPolicy).backlog.dispatchesPerSweep;
  const need = Math.min(cap - activeTaskCount(runtime.db), perSweep);
  for (const pick of pickBriefs(runtime, goals, need, now)) {
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
    let continuation: BriefContinuation | undefined;
    try {
      continuation = readBriefContinuation(readFileSync(claimed, 'utf8'));
      if (continuation) {
        await runtime.continueTask(pick.goal, continuation, claimed);
        taskId = continuation.taskId;
      } else taskId = await runtime.dispatch(claimed);
    } catch (error) {
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
    if (continuation)
      continued.push({ goal: pick.goal, taskId, attempt: continuation.expectedAttempt, brief: basename(pick.file) });
    else dispatched.push({ goal: pick.goal, taskId, brief: basename(pick.file) });
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
      owner.tasks.slice(0, 5).join(', ') + (owner.tasks.length > 5 ? ` and ${owner.tasks.length - 5} more` : '');
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
            `Backlog low: ${ready} ready brief(s) in ${directory}. Write ready briefs there to keep at least ${(runtime.policy ?? defaultPolicy).backlog.lowWater}; ` +
            'the controller dispatches the oldest whenever worker slots are free.',
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
 * limit, dispatch the oldest ready briefs round-robin across Goals while active tasks are below the cap, and wake
 * managers with a low backlog.
 */
export async function sweepBacklog(runtime: BacklogRuntime): Promise<BacklogSweep> {
  // One run at a time, across host restarts too: claim recovery assumes no other run holds a claim.
  let lease;
  try {
    lease = acquireDirectoryLease(join(runtime.stateDirectory, 'leases', 'backlog'));
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
    const woken = wakeLowBacklogs(runtime, now);
    return { dispatched, continued, refused, expired, woken };
  } finally {
    lease.release();
  }
}
