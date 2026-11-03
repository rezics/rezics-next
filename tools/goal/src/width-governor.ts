import type { Database } from 'bun:sqlite';
import type { ManagerEvent, ManagerInbox } from './contracts.ts';
import { agentReportingEvidence } from './agents.ts';
import { migrate } from './db.ts';
import { sameProcess, type ProcessIdentity } from './process.ts';

export const WIDTH_WORKER_THRESHOLD = 10;
export const WIDTH_BUCKET_MS = 15 * 60_000;
const WIDTH_PAGE_SIZE = 64;

export const widthGovernorMigrations = [
  {
    module: 'width-governor',
    version: 1,
    sql: `CREATE TABLE width_governor_deliveries (
      goal TEXT NOT NULL,
      bucket INTEGER NOT NULL,
      manager TEXT NOT NULL,
      delivered_at TEXT NOT NULL,
      PRIMARY KEY(goal, bucket)
    );`,
  },
] as const;

export type WidthCounts = {
  /** Workers with a current running attempt and a process identity that is live now. */
  running: number;
  /** The Codex subset with live process identity and explicit Codex attempt profile evidence. */
  codexRunning: number;
  /** Running attempt records whose process identity is absent or malformed. */
  unknownRunning: number;
  /** Unknown process identity among attempts explicitly routed to Codex. */
  unknownCodexRunning: number;
  /** Current running attempts whose profile does not identify a recognized CLI. */
  unknownCodexClassification: number;
  ready: number;
  pendingStarts: number;
  held: number;
  stopped: number;
  waiting: number;
};

export type WidthGoalSnapshot = WidthCounts & {
  goal: string;
  managerId: string | null;
  managerConflict: boolean;
};

export type WidthSnapshot = {
  asOf: string;
  system: WidthCounts;
  goals: WidthGoalSnapshot[];
};

export type WidthSnapshotOptions = {
  /** Yield between indexed pages when called from the manager-host sweep. */
  yieldBetweenPages?: boolean;
  /** Test seam; production uses the existing process identity helper. */
  processIsLive?: (identity: ProcessIdentity) => boolean;
};

type SyncWidthSnapshotOptions = Omit<WidthSnapshotOptions, 'yieldBetweenPages'> & { yieldBetweenPages?: false };
type AsyncWidthSnapshotOptions = Omit<WidthSnapshotOptions, 'yieldBetweenPages'> & { yieldBetweenPages: true };

type WidthRow = {
  sequence: number;
  current_attempt: number;
  task_state: string;
  goal: string | null;
  manager: string | null;
  attempt_state: string | null;
  pid: number | null;
  process_start: string | null;
  process_boot: string | null;
  process_group: number | null;
  cli: string | null;
  pending_start: number;
};

type MutableCounts = WidthCounts;
type MutableGoal = MutableCounts & { goal: string; managers: Set<string>; managerMissing: boolean };

function emptyCounts(): MutableCounts {
  return {
    running: 0,
    codexRunning: 0,
    unknownRunning: 0,
    unknownCodexRunning: 0,
    unknownCodexClassification: 0,
    ready: 0,
    pendingStarts: 0,
    held: 0,
    stopped: 0,
    waiting: 0,
  };
}

function isProcessIdentity(value: WidthRow): ProcessIdentity | undefined {
  if (
    typeof value.pid !== 'number' ||
    !Number.isSafeInteger(value.pid) ||
    value.pid <= 0 ||
    typeof value.process_start !== 'string' ||
    !value.process_start ||
    typeof value.process_boot !== 'string' ||
    !value.process_boot ||
    typeof value.process_group !== 'number' ||
    !Number.isSafeInteger(value.process_group) ||
    value.process_group <= 0
  )
    return undefined;
  return { pid: value.pid, start: value.process_start, boot: value.process_boot, group: value.process_group };
}

function tableExists(db: Database, name: string): boolean {
  return Boolean(db.query("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name));
}

function pageQuery(db: Database, afterSequence: number, limit: number, hasRetryIntents: boolean): WidthRow[] {
  const pendingStart = hasRetryIntents
    ? `EXISTS (
        SELECT 1 FROM worker_retry_intents AS i
        WHERE i.task_id=t.id AND i.attempt=t.current_attempt
          AND json_extract(i.body, '$.status')='pending'
      )`
    : '0';
  return db
    .query(
      `SELECT t.sequence, t.current_attempt,
        json_extract(t.body, '$.state') AS task_state,
        json_extract(t.body, '$.brief.goal') AS goal,
        json_extract(t.body, '$.brief.manager') AS manager,
        json_extract(a.body, '$.state') AS attempt_state,
        json_extract(a.body, '$.process.pid') AS pid,
        json_extract(a.body, '$.process.start') AS process_start,
        json_extract(a.body, '$.process.boot') AS process_boot,
        json_extract(a.body, '$.process.group') AS process_group,
        json_extract(a.body, '$.profile.cli') AS cli,
        CASE WHEN ${pendingStart} THEN 1 ELSE 0 END AS pending_start
      FROM worker_tasks AS t
      LEFT JOIN worker_attempts AS a ON a.task_id=t.id AND a.attempt=t.current_attempt
      WHERE t.sequence > ?
        AND json_extract(t.body, '$.state') IN ('ready', 'held', 'running', 'stopped')
      ORDER BY t.sequence
      LIMIT ?`,
    )
    .all(afterSequence, limit) as WidthRow[];
}

function addRow(
  row: WidthRow,
  system: MutableCounts,
  goals: Map<string, MutableGoal>,
  processIsLive: (identity: ProcessIdentity) => boolean,
): void {
  let goal: MutableGoal | undefined;
  if (typeof row.goal === 'string' && row.goal.length > 0) {
    goal = goals.get(row.goal);
    if (!goal) {
      goal = { goal: row.goal, ...emptyCounts(), managers: new Set(), managerMissing: false };
      goals.set(row.goal, goal);
    }
    if (typeof row.manager === 'string' && row.manager.length > 0) goal.managers.add(row.manager);
    else goal.managerMissing = true;
  }

  const increment = (key: keyof WidthCounts) => {
    system[key]++;
    if (goal) goal[key]++;
  };

  const taskState = row.task_state;
  const attemptRunning = taskState === 'running' && row.attempt_state === 'running';
  if (attemptRunning) {
    const identity = isProcessIdentity(row);
    const evidence = agentReportingEvidence(row.cli);
    if (!identity) {
      increment('unknownRunning');
      if (evidence.codex) increment('unknownCodexRunning');
      if (evidence.unknown) increment('unknownCodexClassification');
    } else if (processIsLive(identity)) {
      increment('running');
      if (evidence.codex) increment('codexRunning');
      if (evidence.unknown) increment('unknownCodexClassification');
    }
  }

  if (taskState === 'ready') increment('ready');
  else if (taskState === 'held') increment('held');
  else if (taskState === 'stopped') increment('stopped');
  if (row.pending_start === 1) increment('pendingStarts');
  if (row.attempt_state === 'waiting') increment('waiting');
}

function finishSnapshot(asOf: string, system: MutableCounts, goals: Map<string, MutableGoal>): WidthSnapshot {
  return {
    asOf,
    system,
    goals: [...goals.values()]
      .map(({ managers, managerMissing, ...goal }) => ({
        ...goal,
        managerId: !managerMissing && managers.size === 1 ? [...managers][0]! : null,
        managerConflict: managerMissing || managers.size > 1,
      }))
      .sort((a, b) => a.goal.localeCompare(b.goal)),
  };
}

function readSnapshotSync(
  db: Database,
  at: Date | number,
  options: SyncWidthSnapshotOptions,
  hasRetryIntents: boolean,
): WidthSnapshot {
  const system = emptyCounts();
  const goals = new Map<string, MutableGoal>();
  const processIsLive = options.processIsLive ?? sameProcess;
  let cursor = -1;
  for (;;) {
    const rows = pageQuery(db, cursor, WIDTH_PAGE_SIZE, hasRetryIntents);
    for (const row of rows) addRow(row, system, goals, processIsLive);
    if (rows.length < WIDTH_PAGE_SIZE) break;
    cursor = rows[rows.length - 1]!.sequence;
  }
  const date = at instanceof Date ? at : new Date(at);
  return finishSnapshot(date.toISOString(), system, goals);
}

async function readSnapshotAsync(
  db: Database,
  at: Date | number,
  options: AsyncWidthSnapshotOptions,
  hasRetryIntents: boolean,
): Promise<WidthSnapshot> {
  const system = emptyCounts();
  const goals = new Map<string, MutableGoal>();
  const processIsLive = options.processIsLive ?? sameProcess;
  let cursor = -1;
  for (;;) {
    const rows = pageQuery(db, cursor, WIDTH_PAGE_SIZE, hasRetryIntents);
    for (const row of rows) addRow(row, system, goals, processIsLive);
    if (rows.length < WIDTH_PAGE_SIZE) break;
    cursor = rows[rows.length - 1]!.sequence;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  const date = at instanceof Date ? at : new Date(at);
  return finishSnapshot(date.toISOString(), system, goals);
}

/** Read bounded pages of active task rows and only the scalar fields from each current attempt. */
export function readWidthSnapshot(db: Database, at?: Date | number, options?: SyncWidthSnapshotOptions): WidthSnapshot;
export function readWidthSnapshot(
  db: Database,
  at: Date | number,
  options: AsyncWidthSnapshotOptions,
): Promise<WidthSnapshot>;
export function readWidthSnapshot(
  db: Database,
  at: Date | number = new Date(),
  options: WidthSnapshotOptions = {},
): WidthSnapshot | Promise<WidthSnapshot> {
  const hasRetryIntents = tableExists(db, 'worker_retry_intents');
  return options.yieldBetweenPages
    ? readSnapshotAsync(db, at, options as AsyncWidthSnapshotOptions, hasRetryIntents)
    : readSnapshotSync(db, at, options as SyncWidthSnapshotOptions, hasRetryIntents);
}

function noLongerActiveManager(db: Database, managerId: string): boolean {
  if (!tableExists(db, 'manager_sessions')) return false;
  const state = db
    .query(
      `SELECT json_extract(state, '$.status') AS status,
        json_extract(state, '$.goalState.status') AS goal_status
      FROM manager_sessions WHERE id=?`,
    )
    .get(managerId) as { status?: string | null; goal_status?: string | null } | null;
  if (!state) return false;
  return (
    state.status === 'paused' ||
    state.status === 'complete' ||
    state.goal_status === 'paused' ||
    state.goal_status === 'budgetLimited' ||
    state.goal_status === 'complete'
  );
}

function hasUndispatchedWork(goal: WidthGoalSnapshot): boolean {
  return goal.ready > 0 || goal.pendingStarts > 0 || goal.held > 0 || goal.stopped > 0;
}

function widthEventSummary(goal: WidthGoalSnapshot): string {
  const codexUnknown = goal.unknownCodexRunning + goal.unknownCodexClassification;
  return (
    `Width governor: this Goal has ${goal.running} confirmed live workers (${goal.unknownRunning} current running attempts have unknown process identity); ` +
    `Codex subset ${goal.codexRunning} confirmed live (${codexUnknown} Codex evidence unknown); ` +
    `current work counts: ready ${goal.ready}, durable pending starts ${goal.pendingStarts}, held ${goal.held}, stopped ${goal.stopped}, waiting ${goal.waiting}. ` +
    'Recover, reshape, or dispatch real work. Act on each stopped task within an hour: retry with a rewritten brief, split it, or cancel it. Keep at least eight ready briefs in your backlog. ' +
    'Unsubmitted work is not observable from runtime metadata.'
  );
}

export type WidthGovernorSweep = { snapshot: WidthSnapshot; deliveredGoals: string[] };

/** Send at most one durable wakeable width event to each eligible Goal in the current UTC bucket. */
export async function sweepWidthGovernor(
  db: Database,
  inbox: ManagerInbox,
  at: Date | number = new Date(),
  options: { processIsLive?: (identity: ProcessIdentity) => boolean } = {},
): Promise<WidthGovernorSweep> {
  migrate(db, widthGovernorMigrations);
  const snapshot = await readWidthSnapshot(db, at, {
    yieldBetweenPages: true,
    ...(options.processIsLive ? { processIsLive: options.processIsLive } : {}),
  });
  const date = at instanceof Date ? at : new Date(at);
  const bucket = Math.floor(date.getTime() / WIDTH_BUCKET_MS);
  const deliveredGoals: string[] = [];
  for (let index = 0; index < snapshot.goals.length; index++) {
    if (index > 0 && index % 8 === 0) await new Promise<void>((resolve) => setImmediate(resolve));
    const goal = snapshot.goals[index]!;
    if (!goal.managerId || goal.managerConflict || goal.running >= WIDTH_WORKER_THRESHOLD || !hasUndispatchedWork(goal))
      continue;

    const event: ManagerEvent = {
      managerId: goal.managerId,
      goalId: goal.goal,
      kind: 'width',
      summary: widthEventSummary(goal),
    };
    const delivered = db
      .transaction(() => {
        if (noLongerActiveManager(db, goal.managerId!)) return false;
        const inserted = db
          .query(
            'INSERT OR IGNORE INTO width_governor_deliveries(goal, bucket, manager, delivered_at) VALUES (?, ?, ?, ?)',
          )
          .run(goal.goal, bucket, goal.managerId, snapshot.asOf);
        if (!inserted.changes) return false;
        inbox.deliver(event);
        return true;
      })
      .immediate();
    if (delivered) deliveredGoals.push(goal.goal);
  }
  return { snapshot, deliveredGoals };
}

/** Lines shared by the hourly lifecycle report and its human-readable flow output. */
export function formatWidthSnapshot(snapshot: WidthSnapshot | null | undefined): string[] {
  if (!snapshot)
    return [
      'Actual system-wide running workers: unknown; this snapshot did not record width evidence.',
      'Actual Codex running workers: unknown; this snapshot did not record width evidence.',
    ];
  const { system } = snapshot;
  return [
    `Actual system-wide running workers: ${system.running} confirmed live; ${system.unknownRunning} current running attempts have unknown process identity.`,
    `Actual Codex running workers: ${system.codexRunning} confirmed live; ${system.unknownCodexRunning} have unknown process identity; ${system.unknownCodexClassification} have unknown CLI evidence.`,
  ];
}
