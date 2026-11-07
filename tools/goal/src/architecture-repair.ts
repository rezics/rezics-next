import type { Database } from 'bun:sqlite';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { defaultPolicy } from './policy.ts';
import { runHostProcess } from './process.ts';
import type { Task } from './types.ts';

/** Task states after which a repair no longer blocks its Goal. */
const SETTLED_STATES: ReadonlySet<string> = new Set(['integrated', 'merged', 'stopped', 'cancelled']);

export type ArchitectureViolation = { goal: string; manager: string; line: string; paths: readonly string[] };

type ViolationRow = { goal: string; manager: string; line: string; paths: string; candidate: string };
type ObservationRow = { seq: number; candidate: string; through_seq: number; present: string };

/**
 * Boundary violations that landed on dev, one row per Goal and diagnostic line. A line is open until a complete
 * architecture audit of a candidate that is on dev no longer reports it. `seq` orders rows against observations.
 */
export function ensureArchitectureRepairs(db: Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS architecture_violations (
      goal TEXT NOT NULL,
      line TEXT NOT NULL,
      manager TEXT NOT NULL,
      candidate TEXT NOT NULL,
      paths TEXT NOT NULL,
      seq INTEGER NOT NULL,
      recorded_at TEXT NOT NULL,
      resolved_at TEXT,
      repair_task_id TEXT,
      PRIMARY KEY (goal, line)
    );
    CREATE INDEX IF NOT EXISTS architecture_violations_open ON architecture_violations (resolved_at, goal);
    CREATE TABLE IF NOT EXISTS architecture_observations (
      seq INTEGER PRIMARY KEY AUTOINCREMENT,
      candidate TEXT NOT NULL,
      through_seq INTEGER NOT NULL,
      present TEXT NOT NULL,
      observed_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS architecture_repair_runs (
      goal TEXT NOT NULL,
      day TEXT NOT NULL,
      task_id TEXT NOT NULL,
      failure TEXT,
      resolved_at TEXT,
      PRIMARY KEY (goal, day)
    );
  `);
}

/** A ref predicate: whether a commit is on the given branch, which is the only state a repair may act on. */
export function commitPublishedOn(cwd: string, ref: string): (commit: string) => boolean {
  const memo = new Map<string, boolean>();
  return (commit) => {
    let published = memo.get(commit);
    if (published === undefined) {
      published = spawnSync('git', ['merge-base', '--is-ancestor', commit, ref], { cwd, stdio: 'ignore' }).status === 0;
      memo.set(commit, published);
    }
    return published;
  };
}

/** Open architecture-repair candidates, so the host can resolve ancestry off its event loop. */
export function openArchitectureCandidates(db: Database): string[] {
  ensureArchitectureRepairs(db);
  return (
    db.query('SELECT DISTINCT candidate FROM architecture_violations WHERE resolved_at IS NULL').all() as {
      candidate: string;
    }[]
  ).map((row) => row.candidate);
}

/** Async ancestry check for the manager host: git merge-base must not use spawnSync on that loop. */
export async function publishedOnRef(
  cwd: string,
  ref: string,
  commits: readonly string[],
  policy = defaultPolicy.merge,
): Promise<(commit: string) => boolean> {
  const published = new Set<string>();
  await Promise.all(
    [...new Set(commits)].map(async (commit) => {
      const result = await runHostProcess('git', ['merge-base', '--is-ancestor', commit, ref], {
        cwd,
        timeoutMs: policy.commandTimeoutMs,
      });
      if (result.code === 0) published.add(commit);
    }),
  );
  return (commit) => published.has(commit);
}

/** Whether any recorded boundary violation is still open, so the next check must audit the complete graph. */
export function hasOpenArchitectureViolations(db: Database): boolean {
  ensureArchitectureRepairs(db);
  return db.query('SELECT 1 FROM architecture_violations WHERE resolved_at IS NULL LIMIT 1').get() !== null;
}

/**
 * Records net-new violation lines a dev candidate introduced. A line that is already open keeps its repair link;
 * a resolved line that reappears is open again and is newer than any observation taken before it.
 */
export function recordArchitectureViolations(
  db: Database,
  candidate: string,
  violations: readonly ArchitectureViolation[],
  at = new Date().toISOString(),
): void {
  ensureArchitectureRepairs(db);
  if (!violations.length) return;
  db.transaction(() => {
    const upsert = db.query(`
      INSERT INTO architecture_violations (goal, line, manager, candidate, paths, seq, recorded_at, resolved_at, repair_task_id)
      VALUES (?, ?, ?, ?, ?, (SELECT COALESCE(MAX(seq), 0) + 1 FROM architecture_violations), ?, NULL, NULL)
      ON CONFLICT (goal, line) DO UPDATE SET
        manager = excluded.manager,
        candidate = excluded.candidate,
        paths = excluded.paths,
        seq = excluded.seq,
        recorded_at = excluded.recorded_at,
        repair_task_id = CASE WHEN architecture_violations.resolved_at IS NULL THEN architecture_violations.repair_task_id ELSE NULL END,
        resolved_at = NULL`);
    for (const violation of violations)
      upsert.run(
        violation.goal,
        violation.line,
        violation.manager,
        candidate,
        JSON.stringify([...new Set(violation.paths)].sort()),
        at,
      );
  })();
}

/**
 * Stores the complete audit of a candidate. Rows recorded before this call have `seq <= through_seq`; rows recorded
 * after it are not judged by it. Call it before recording the same check's own violations.
 */
export function storeArchitectureObservation(
  db: Database,
  candidate: string,
  presentLines: readonly string[],
  at = new Date().toISOString(),
): void {
  ensureArchitectureRepairs(db);
  db.query(
    `INSERT INTO architecture_observations (candidate, through_seq, present, observed_at)
     VALUES (?, (SELECT COALESCE(MAX(seq), 0) FROM architecture_violations), ?, ?)`,
  ).run(candidate, JSON.stringify([...new Set(presentLines)].sort()), at);
}

/**
 * Applies each observation whose candidate is on dev: an open line it no longer reports is resolved. Observations of
 * candidates that never published are discarded only when `discardUnpublished` is set, which the train does because
 * its landings are serialized; the controller never discards an in-flight candidate's observation.
 */
export function settleArchitectureObservations(
  db: Database,
  published: (commit: string) => boolean,
  discardUnpublished: boolean,
  at = new Date().toISOString(),
): void {
  ensureArchitectureRepairs(db);
  const observations = db
    .query('SELECT seq, candidate, through_seq, present FROM architecture_observations ORDER BY seq')
    .all() as ObservationRow[];
  for (const observation of observations) {
    if (!published(observation.candidate)) {
      if (discardUnpublished) db.query('DELETE FROM architecture_observations WHERE seq = ?').run(observation.seq);
      continue;
    }
    const present = new Set(JSON.parse(observation.present) as string[]);
    const open = db
      .query('SELECT goal, line FROM architecture_violations WHERE resolved_at IS NULL AND seq <= ?')
      .all(observation.through_seq) as { goal: string; line: string }[];
    db.transaction(() => {
      for (const row of open)
        if (!present.has(row.line))
          db.query('UPDATE architecture_violations SET resolved_at = ? WHERE goal = ? AND line = ?').run(
            at,
            row.goal,
            row.line,
          );
      db.query('DELETE FROM architecture_observations WHERE seq = ?').run(observation.seq);
    })();
  }
  // A repair is resolved once none of the lines it was dispatched for remain open.
  db.query(
    `UPDATE architecture_repair_runs SET resolved_at = ?
     WHERE resolved_at IS NULL AND task_id != ''
       AND NOT EXISTS (
         SELECT 1 FROM architecture_violations v
         WHERE v.goal = architecture_repair_runs.goal
           AND v.repair_task_id = architecture_repair_runs.task_id
           AND v.resolved_at IS NULL)`,
  ).run(at);
}

/** The brief for one Goal's repair. Its paths are the violating files; urgent briefs are exempt from the size floor. */
export function architectureRepairBrief(input: {
  goal: string;
  manager: string;
  day: string;
  violations: readonly { line: string; paths: readonly string[] }[];
}): string {
  const paths = [...new Set(input.violations.flatMap((violation) => violation.paths))].sort();
  if (!paths.length) throw new Error(`architecture repair for ${input.goal} has no declared paths`);
  const front = {
    goal: input.goal,
    manager: input.manager,
    kind: 'implementation',
    paths,
    riskAreas: [],
    urgent: true,
    acceptance: { failing: true },
    // Planning estimate: five lines per recorded edge (an import change or a move through a public entry) and ten per
    // file for its surrounding review, with a floor of ten.
    estimate: {
      lines: Math.max(10, 5 * input.violations.length + 10 * paths.length),
      files: paths.length,
    },
    criticalPath: false,
    waiting: [],
    after: [],
  };
  const lines = input.violations.map((violation) => `- ${violation.line}`).join('\n');
  return `---\n${JSON.stringify(front, null, 2)}\n---\n\n# Repair boundary violations recorded for ${input.goal} on ${input.day}\n\nDev candidates landed the boundary violations listed below. Repair each edge in place: import the module through its declared public entry, or move the code into the module that owns it, and keep the module's allowed dependencies. \`bun scripts/architecture.ts --map\` prints the module map.\n\nDone when \`bun scripts/architecture.ts\` no longer reports any listed line. The boundary baseline may only shrink; do not add entries to it.\n\nRecorded violations (${input.violations.length}):\n\n${lines}\n`;
}

export type ArchitectureRepairDispatch = {
  db: Database;
  /** Tasks not yet settled; a repair whose task is among them is open. */
  unsettled: readonly Pick<Task, 'id'>[];
  published: (commit: string) => boolean;
  dispatch: (briefFile: string) => Task;
  notify: (managerId: string, taskId: string, summary: string) => void;
  reportFailure: (summary: string) => void;
  stateDirectory: string;
  now?: Date;
};

/** The open repair task of a Goal: an unsettled task that still owns at least one open line. */
function openRepairTaskId(db: Database, goal: string, isOpenTask: (id: string) => boolean): string | undefined {
  const runs = db
    .query("SELECT task_id FROM architecture_repair_runs WHERE goal = ? AND task_id != '' AND resolved_at IS NULL")
    .all(goal) as { task_id: string }[];
  return runs
    .map((run) => run.task_id)
    .find(
      (id) =>
        isOpenTask(id) &&
        db
          .query(
            'SELECT 1 FROM architecture_violations WHERE goal = ? AND repair_task_id = ? AND resolved_at IS NULL LIMIT 1',
          )
          .get(goal, id) !== null,
    );
}

/**
 * Controller tick: settles observations, then dispatches at most one urgent repair per Goal per UTC day, and only
 * while that Goal has no open repair. Lines whose candidate is not on dev are never dispatched. A failed day is
 * reported once and not retried, like the daily step audit.
 */
export function dispatchArchitectureRepairs(input: ArchitectureRepairDispatch): Task[] {
  const { db } = input;
  ensureArchitectureRepairs(db);
  const now = input.now ?? new Date();
  const day = now.toISOString().slice(0, 10);
  settleArchitectureObservations(db, input.published, false, now.toISOString());
  const unsettled = new Set(input.unsettled.map((task) => task.id));
  const isOpenTask = (id: string) => unsettled.has(id);
  const goals = db
    .query('SELECT DISTINCT goal FROM architecture_violations WHERE resolved_at IS NULL ORDER BY goal')
    .all() as { goal: string }[];
  const dispatched: Task[] = [];
  for (const { goal } of goals) {
    if (db.query('SELECT 1 FROM architecture_repair_runs WHERE goal = ? AND day = ?').get(goal, day)) continue;
    if (openRepairTaskId(db, goal, isOpenTask)) continue;
    const open = (
      db
        .query(
          'SELECT goal, line, manager, paths, candidate FROM architecture_violations WHERE goal = ? AND resolved_at IS NULL ORDER BY seq',
        )
        .all(goal) as ViolationRow[]
    ).filter((row) => input.published(row.candidate));
    if (!open.length) continue;
    // Claim before writing the brief, so a crash or a second host tick never dispatches the day twice.
    if (
      !db
        .query("INSERT OR IGNORE INTO architecture_repair_runs (goal, day, task_id, failure) VALUES (?, ?, '', NULL)")
        .run(goal, day).changes
    )
      continue;
    try {
      const manager = open[0]!.manager;
      const briefFile = join(input.stateDirectory, 'architecture-repairs', `${randomUUID()}.md`);
      mkdirSync(dirname(briefFile), { recursive: true });
      writeFileSync(
        briefFile,
        architectureRepairBrief({
          goal,
          manager,
          day,
          violations: open.map((row) => ({ line: row.line, paths: JSON.parse(row.paths) as string[] })),
        }),
        { flag: 'wx', mode: 0o600 },
      );
      const task = input.dispatch(briefFile);
      db.transaction(() => {
        db.query('UPDATE architecture_repair_runs SET task_id = ? WHERE goal = ? AND day = ?').run(task.id, goal, day);
        for (const row of open)
          db.query('UPDATE architecture_violations SET repair_task_id = ? WHERE goal = ? AND line = ?').run(
            task.id,
            goal,
            row.line,
          );
      })();
      input.notify(
        manager,
        task.id,
        `Urgent architecture repair for ${goal}: ${open.length} recorded boundary violation line${open.length === 1 ? '' : 's'}.`,
      );
      dispatched.push(task);
    } catch (error) {
      const cause = error instanceof Error ? (error.stack ?? error.message) : String(error);
      db.query('UPDATE architecture_repair_runs SET failure = ? WHERE goal = ? AND day = ?').run(cause, goal, day);
      input.reportFailure(`Architecture repair failed (${goal}, ${day}): ${cause.split('\n')[0]}`);
    }
  }
  return dispatched;
}

export type ArchitectureGoalStatus = {
  goal: string;
  manager: string;
  openViolations: number;
  violations: string[];
  repair: { taskId: string; day: string; state: string } | null;
};

/** Per Goal: the open recorded lines and the open repair task, if any. `stateOf` returns undefined for unknown tasks. */
export function architectureRepairStatus(
  db: Database,
  stateOf: (taskId: string) => string | undefined,
): ArchitectureGoalStatus[] {
  // Status is read-only: without recorded violations the tables do not exist, so there is nothing to report.
  if (!Boolean(db.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'architecture_violations'").get()))
    return [];
  const rows = db
    .query('SELECT goal, manager, line FROM architecture_violations WHERE resolved_at IS NULL ORDER BY goal, seq')
    .all() as { goal: string; manager: string; line: string }[];
  const goals = new Map<string, { manager: string; violations: string[] }>();
  for (const row of rows) {
    const group = goals.get(row.goal) ?? { manager: row.manager, violations: [] };
    group.violations.push(row.line);
    goals.set(row.goal, group);
  }
  return [...goals].map(([goal, group]) => {
    const taskId = openRepairTaskId(db, goal, (id) => {
      const state = stateOf(id);
      return state !== undefined && !SETTLED_STATES.has(state);
    });
    const run = taskId
      ? (db.query('SELECT day FROM architecture_repair_runs WHERE goal = ? AND task_id = ?').get(goal, taskId) as {
          day: string;
        } | null)
      : null;
    return {
      goal,
      manager: group.manager,
      openViolations: group.violations.length,
      violations: group.violations,
      repair: taskId && run ? { taskId, day: run.day, state: stateOf(taskId) ?? 'unknown' } : null,
    };
  });
}
