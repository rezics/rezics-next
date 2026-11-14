import type { Database } from 'bun:sqlite';
import type { ManagerEvent, ManagerInbox } from './contracts.ts';
import { agentReportingEvidence } from './agents.ts';
import { migrate } from './db.ts';
import { sameProcess, type ProcessIdentity } from './process.ts';
import { resolveGoalManager } from './manager-ownership.ts';
import { defaultPolicy, type ControlPolicy } from './policy.ts';
import {
  stoppedActionHint,
  stoppedActionProjection,
  type StoppedActionHint,
  type StoppedRecoveryReceivingAction,
} from './stopped-action.ts';

// Compatibility exports for synthetic callers; production reads its own loaded policy.
export const WIDTH_WORKER_THRESHOLD = defaultPolicy.width.workerThreshold;
export const WIDTH_BUCKET_MS = defaultPolicy.width.bucketMs;

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
  {
    module: 'width-governor',
    version: 2,
    sql: `CREATE TABLE width_governor_receiver_deliveries (
      goal TEXT NOT NULL,
      bucket INTEGER NOT NULL,
      manager TEXT NOT NULL,
      delivered_at TEXT NOT NULL,
      PRIMARY KEY(goal, bucket, manager)
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
  actionableReady: number;
  pendingStarts: number;
  /** Registered ready tasks whose brief declares writable product source. */
  sourceReady: number;
  /** Durable start requests among registered source tasks. */
  sourcePendingStarts: number;
  /** Source tasks held by dependencies or a waiting attempt. */
  sourceHolds: number;
  /** Source tasks held on an `after` dependency. */
  sourceDependencyHolds: number;
  /** Source attempts waiting for checks or physical ownership. */
  sourceWaiting: number;
  /** Source writers with a current process identity confirmed live. */
  sourceWriters: number;
  held: number;
  actionableHeld: number;
  stopped: number;
  actionableStopped: number;
  evidenceReceivingStopped: number;
  actionableEvidenceReceivingStopped: number;
  waiting: number;
};

export type EvidenceReceiverAction = {
  taskId: string;
  attempt: number;
  owner: string | null;
  missingPredicate: string;
  actionable: boolean;
  receivingActions: StoppedRecoveryReceivingAction[];
};

export type WidthGoalSnapshot = WidthCounts & {
  goal: string;
  managerId: string | null;
  managerConflict: boolean;
  evidenceReceiverActions: EvidenceReceiverAction[];
};

export type WidthSnapshot = {
  asOf: string;
  system: WidthCounts;
  goals: WidthGoalSnapshot[];
};

export type WidthSnapshotOptions = {
  policy?: ControlPolicy | undefined;
  /** Backlog refill only needs current starts, holds and writers; omit stop-history classification there. */
  includeStopped?: boolean;
  /** Yield between indexed pages when called from the manager-host sweep. */
  yieldBetweenPages?: boolean;
  /** Test seam; production uses the existing process identity helper. */
  processIsLive?: (identity: ProcessIdentity) => boolean;
};

type SyncWidthSnapshotOptions = Omit<WidthSnapshotOptions, 'yieldBetweenPages'> & { yieldBetweenPages?: false };
type AsyncWidthSnapshotOptions = Omit<WidthSnapshotOptions, 'yieldBetweenPages'> & { yieldBetweenPages: true };

type WidthRow = {
  sequence: number;
  task_id: string;
  stopped_action: StoppedActionHint | null;
  current_attempt: number;
  task_state: string;
  goal: string | null;
  manager: string | null;
  attempt_state: string | null;
  pid: number | null;
  process_start: string | number | null;
  process_boot: string | null;
  process_group: number | null;
  cli: string | null;
  brief_kind: string | null;
  brief_paths: string | null;
  pending_start: number;
  progressing_dependencies: number;
};

type MutableCounts = WidthCounts;
type MutableGoal = MutableCounts & {
  goal: string;
  managers: Set<string>;
  managerMissing: boolean;
  evidenceReceiverActions: EvidenceReceiverAction[];
};

function emptyCounts(): MutableCounts {
  return {
    running: 0,
    codexRunning: 0,
    unknownRunning: 0,
    unknownCodexRunning: 0,
    unknownCodexClassification: 0,
    ready: 0,
    actionableReady: 0,
    pendingStarts: 0,
    sourceReady: 0,
    sourcePendingStarts: 0,
    sourceHolds: 0,
    sourceDependencyHolds: 0,
    sourceWaiting: 0,
    sourceWriters: 0,
    held: 0,
    actionableHeld: 0,
    stopped: 0,
    actionableStopped: 0,
    evidenceReceivingStopped: 0,
    actionableEvidenceReceivingStopped: 0,
    waiting: 0,
  };
}

function isProcessIdentity(value: WidthRow): ProcessIdentity | undefined {
  // Older non-STRICT ANY projections coerce decimal start strings to integers. Never round an unsafe value.
  const start =
    typeof value.process_start === 'number' && Number.isSafeInteger(value.process_start) && value.process_start >= 0
      ? String(value.process_start)
      : value.process_start;
  if (
    typeof value.pid !== 'number' ||
    !Number.isSafeInteger(value.pid) ||
    value.pid <= 0 ||
    typeof start !== 'string' ||
    !/^\d+$/.test(start) ||
    typeof value.process_boot !== 'string' ||
    !value.process_boot ||
    typeof value.process_group !== 'number' ||
    !Number.isSafeInteger(value.process_group) ||
    value.process_group <= 0
  )
    return undefined;
  return { pid: value.pid, start, boot: value.process_boot, group: value.process_group };
}

function tableExists(db: Database, name: string): boolean {
  return Boolean(db.query("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name));
}

function pageQuery(
  db: Database,
  afterSequence: number,
  limit: number,
  hasRetryIntents: boolean,
  hasWorkerEvents: boolean,
  includeStopped: boolean,
): WidthRow[] {
  const pendingStart = hasRetryIntents
    ? `EXISTS (
        SELECT 1 FROM worker_retry_intents AS i
        WHERE i.task_id=c.task_id AND i.attempt=c.current_attempt
          AND json_extract(i.body, '$.status')='pending'
      )`
    : '0';
  const taskStates = includeStopped ? "'ready', 'held', 'running', 'stopped'" : "'ready', 'held', 'running'";
  return db
    .query(
      `SELECT c.sequence, c.task_id, c.current_attempt,
        CASE WHEN c.task_state='stopped' THEN ${stoppedActionHint(
          'c.task_id',
          'c.current_attempt',
          hasWorkerEvents,
        )} END AS stopped_action,
        c.task_state,
        c.goal,
        c.manager,
        c.attempt_state,
        c.pid,
        c.process_start,
        c.process_boot,
        c.process_group,
        c.cli,
        json_extract(t.body, '$.brief.kind') AS brief_kind,
        json_extract(t.body, '$.brief.paths') AS brief_paths,
        CASE WHEN ${pendingStart} THEN 1 ELSE 0 END AS pending_start,
        CASE WHEN c.task_state='held' THEN (
          SELECT count(*) FILTER (WHERE d.task_state IN ('ready','running','landing')) > 0
            AND count(*) FILTER (WHERE d.task_state IS NULL OR d.task_state NOT IN (
              'ready','running','landing','integrated','merged','stopped','cancelled'
            )) = 0
          FROM worker_tasks AS held
          JOIN json_each(held.body, '$.brief.after') AS dependency
          LEFT JOIN worker_current_attempts AS d ON d.task_id=dependency.value
          WHERE held.id=c.task_id
        ) ELSE 0 END AS progressing_dependencies
      FROM worker_current_attempts AS c
      LEFT JOIN worker_tasks AS t ON t.id=c.task_id
      WHERE c.sequence > ?
        AND c.task_state IN (${taskStates})
      ORDER BY c.sequence
      LIMIT ?`,
    )
    .all(afterSequence, limit) as WidthRow[];
}

const SOURCE_BRIEF_KINDS = new Set(['implementation', 'interface', 'bulk-text', 'claim']);

function writableSourceBrief(row: WidthRow): boolean {
  if (!row.brief_kind || !SOURCE_BRIEF_KINDS.has(row.brief_kind) || typeof row.brief_paths !== 'string') return false;
  let paths: unknown;
  try {
    paths = JSON.parse(row.brief_paths);
  } catch {
    return false;
  }
  if (!Array.isArray(paths)) return false;
  return paths.some((path) => {
    if (typeof path !== 'string') return false;
    const normalized = path.replaceAll('\\', '/').replace(/^\.\//, '');
    if (normalized === 'docs' || normalized.startsWith('docs/')) return false;
    return !/\.(?:md|mdx|rst|adoc)$/i.test(normalized);
  });
}

function addRow(
  row: WidthRow,
  system: MutableCounts,
  goals: Map<string, MutableGoal>,
  processIsLive: (identity: ProcessIdentity) => boolean,
  db: Database,
  policy: ControlPolicy,
): void {
  let goal: MutableGoal | undefined;
  if (typeof row.goal === 'string' && row.goal.length > 0) {
    goal = goals.get(row.goal);
    if (!goal) {
      goal = {
        goal: row.goal,
        ...emptyCounts(),
        managers: new Set(),
        managerMissing: false,
        evidenceReceiverActions: [],
      };
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
  const source = writableSourceBrief(row);
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
      if (source) increment('sourceWriters');
      if (evidence.codex) increment('codexRunning');
      if (evidence.unknown) increment('unknownCodexClassification');
    }
  }

  if (taskState === 'ready') {
    increment('ready');
    if (row.pending_start !== 1) increment('actionableReady');
    if (source) {
      increment('sourceReady');
      if (row.pending_start === 1) increment('sourcePendingStarts');
    }
  } else if (taskState === 'held') {
    increment('held');
    if (row.progressing_dependencies !== 1) increment('actionableHeld');
    if (source) increment('sourceDependencyHolds');
  } else if (taskState === 'stopped') {
    increment('stopped');
    const action = stoppedActionProjection(db, row.task_id, row.current_attempt, row.stopped_action, policy);
    if (action.kind === 'evidence-receiver') {
      increment('evidenceReceivingStopped');
      if (action.actionable) increment('actionableEvidenceReceivingStopped');
      if (goal && goal.evidenceReceiverActions.length < 3)
        goal.evidenceReceiverActions.push({
          taskId: row.task_id,
          attempt: row.current_attempt,
          owner: action.owner,
          missingPredicate: action.missingPredicate,
          actionable: action.actionable,
          receivingActions: action.receivingActions,
        });
    }
    if (action.actionable) increment('actionableStopped');
  }
  if (source && (taskState === 'held' || row.attempt_state === 'waiting')) increment('sourceHolds');
  if (source && row.attempt_state === 'waiting') increment('sourceWaiting');
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
  hasWorkerEvents: boolean,
): WidthSnapshot {
  const system = emptyCounts();
  const goals = new Map<string, MutableGoal>();
  const processIsLive = options.processIsLive ?? sameProcess;
  const policy = options.policy ?? defaultPolicy;
  const pageSize = policy.width.pageSize;
  const includeStopped = options.includeStopped ?? true;
  // The cursor precedes every persisted sequence; it is not a page-size policy.
  let cursor = -1;
  for (;;) {
    const rows = pageQuery(db, cursor, pageSize, hasRetryIntents, hasWorkerEvents, includeStopped);
    for (const row of rows) addRow(row, system, goals, processIsLive, db, policy);
    if (rows.length < pageSize) break;
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
  hasWorkerEvents: boolean,
): Promise<WidthSnapshot> {
  const system = emptyCounts();
  const goals = new Map<string, MutableGoal>();
  const processIsLive = options.processIsLive ?? sameProcess;
  const policy = options.policy ?? defaultPolicy;
  const pageSize = policy.width.pageSize;
  const includeStopped = options.includeStopped ?? true;
  // The cursor precedes every persisted sequence; it is not a page-size policy.
  let cursor = -1;
  for (;;) {
    const rows = pageQuery(db, cursor, pageSize, hasRetryIntents, hasWorkerEvents, includeStopped);
    for (const row of rows) addRow(row, system, goals, processIsLive, db, policy);
    if (rows.length < pageSize) break;
    cursor = rows[rows.length - 1]!.sequence;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  const date = at instanceof Date ? at : new Date(at);
  return finishSnapshot(date.toISOString(), system, goals);
}

/** Read bounded indexed pages from the shared current-attempt projection. */
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
  const hasWorkerEvents = tableExists(db, 'worker_events');
  return options.yieldBetweenPages
    ? readSnapshotAsync(db, at, options as AsyncWidthSnapshotOptions, hasRetryIntents, hasWorkerEvents)
    : readSnapshotSync(db, at, options as SyncWidthSnapshotOptions, hasRetryIntents, hasWorkerEvents);
}

function noLongerActiveManager(db: Database, managerId: string): boolean {
  if (!tableExists(db, 'manager_sessions')) return false;
  const state = db
    .query(
      `SELECT json_extract(state, '$.status') AS status,
        json_extract(state, '$.goalState.status') AS goal_status,
        json_extract(state, '$.waitingForInbox') AS waiting_for_inbox,
        json_extract(state, '$.goalPauseOrigin') AS goal_pause_origin
      FROM manager_sessions WHERE id=?`,
    )
    .get(managerId) as {
    status?: string | null;
    goal_status?: string | null;
    waiting_for_inbox?: number | null;
    goal_pause_origin?: string | null;
  } | null;
  if (!state) return false;
  const controllerParked =
    state.goal_status === 'paused' && state.waiting_for_inbox === 1 && state.goal_pause_origin === 'automatic';
  return (
    state.status === 'paused' ||
    state.status === 'complete' ||
    state.status === 'renewal-failed' ||
    (state.goal_status === 'paused' && !controllerParked) ||
    state.goal_status === 'budgetLimited' ||
    state.goal_status === 'usageLimited' ||
    state.goal_status === 'complete'
  );
}

function hasUndispatchedWork(goal: WidthGoalSnapshot): boolean {
  return goal.actionableReady > 0 || goal.actionableHeld > 0 || goal.actionableStopped > 0;
}

function receivingActionText(
  action: EvidenceReceiverAction,
  receiving: StoppedRecoveryReceivingAction,
  controlPlaneOwner: string | null,
): string {
  const receiver =
    receiving.receiver === 'control-plane-owner'
      ? `control-plane owner ${controlPlaneOwner ?? 'unresolved'}`
      : `task owner ${action.owner ?? 'unknown'}`;
  const checkIds = receiving.checkIds.length ? ` check ${receiving.checkIds.join(', ')}` : '';
  const compiler = receiving.authorizedCommand ? ` for exact command ${JSON.stringify(receiving.authorizedCommand)}` : '';
  const recoverCommand = `bun tools/goal/src/cli.ts typing-recover ${action.taskId} --expected-attempt ${action.attempt}`;
  if (receiving.kind === 'physical-custody')
    return receiving.actionable
      ? `${receiver}: resolve terminal physical custody for${checkIds || ' the named attempt checks'}; no compiler command is requested.`
      : `${receiver}: await terminal physical custody for${checkIds || ' the active exact check'}.`;
  if (receiving.kind === 'input')
    return `${receiver}: review retained compiler inputs; pending command coverage is ${receiving.commandCoverage ?? 'unknown'} (pending ${JSON.stringify(receiving.pendingCommand ?? [])}; authorized ${JSON.stringify(receiving.authorizedCommand ?? [])}), and input identity is ${receiving.inputMatch ?? 'unknown'}. Use authenticated \`${recoverCommand}\` to request authority for the exact pending command.`;
  if (receiving.kind === 'result')
    return `${receiver}: reconcile the exact compiler result${compiler}; native result state is ${receiving.resultState ?? 'unknown'}. Run authenticated \`${recoverCommand}\` to reconcile it.`;
  return receiving.authorizedCommand
    ? `${receiver}: use authenticated \`${recoverCommand}\` to retrieve the retained exact wrapper${compiler}.`
    : `${receiver}: provide or renew authenticated compiler recovery authorization with \`${recoverCommand}\`.`;
}

function widthEventSummary(goal: WidthGoalSnapshot, policy: ControlPolicy, controlPlaneOwner: string | null): string {
  const codexUnknown = goal.unknownCodexRunning + goal.unknownCodexClassification;
  // One hour is a display unit here; the stopped-task deadline comes from policy.
  const stoppedAge =
    policy.backlog.stoppedTaskLimitMs === 60 * 60_000
      ? 'an hour'
      : `${policy.backlog.stoppedTaskLimitMs / 60_000} minutes`;
  const receiverDetails = goal.evidenceReceiverActions
    .flatMap((action) =>
      action.receivingActions.map(
        (receiving) =>
          `${action.taskId} attempt ${action.attempt}, owner ${action.owner ?? 'unknown'}: ${receivingActionText(action, receiving, controlPlaneOwner)}`,
      ),
    )
    .join(' ');
  const unlistedReceivers = Math.max(0, goal.evidenceReceivingStopped - goal.evidenceReceiverActions.length);
  const otherActionableStops = goal.actionableStopped - goal.actionableEvidenceReceivingStopped;
  return (
    `Width governor: this Goal has ${goal.running} confirmed live workers (${goal.unknownRunning} current running attempts have unknown process identity); ` +
    `Codex subset ${goal.codexRunning} confirmed live (${codexUnknown} Codex evidence unknown); ` +
    `current work counts: ready ${goal.ready}, durable pending starts ${goal.pendingStarts}, held ${goal.held}, stopped ${goal.stopped}, waiting ${goal.waiting}; actionable stops ${goal.actionableStopped}; completed-source evidence receiving ${goal.evidenceReceivingStopped} (${goal.actionableEvidenceReceivingStopped} awaiting an owner action). ` +
    `Source status: registered starts ${goal.sourceReady} (${goal.sourcePendingStarts} durable pending); held ${goal.sourceHolds} (${goal.sourceDependencyHolds} dependencies, ${goal.sourceWaiting} check or custody waits); live source writers ${goal.sourceWriters}. ` +
    'Recover, reshape, or dispatch real work. ' +
    (goal.evidenceReceivingStopped
      ? `Completed source remains owed to its evidence receiver and is not a source-writing retry. ${receiverDetails}${unlistedReceivers ? ` ${unlistedReceivers} more receiver obligation(s) are not listed here.` : ''} `
      : '') +
    (otherActionableStops
      ? `Act within ${stoppedAge} on other actionable source or proof stops through the existing repair, reshape, or cancel path. `
      : '') +
    'Use the backlog refill notice for runnable source supply and eligible width; low-water is an alert, not a target or quota. ' +
    'Unsubmitted work is not observable from runtime metadata.'
  );
}

export type WidthGovernorSweep = { snapshot: WidthSnapshot; deliveredGoals: string[] };

/** Send at most one durable wakeable width event to each eligible Goal in the current UTC bucket. */
export async function sweepWidthGovernor(
  db: Database,
  inbox: ManagerInbox,
  at: Date | number = new Date(),
  options: WidthSnapshotOptions = {},
): Promise<WidthGovernorSweep> {
  const policy = options.policy ?? defaultPolicy;
  migrate(db, widthGovernorMigrations);
  const snapshot = await readWidthSnapshot(db, at, {
    yieldBetweenPages: true,
    policy,
    ...(options.processIsLive ? { processIsLive: options.processIsLive } : {}),
  });
  const date = at instanceof Date ? at : new Date(at);
  const bucket = Math.floor(date.getTime() / policy.width.bucketMs);
  const resolvedControlPlaneOwner = resolveGoalManager(db, 'control-plane', '') || null;
  const deliveredGoals: string[] = [];
  for (let index = 0; index < snapshot.goals.length; index++) {
    if (index > 0 && index % policy.width.sweepYieldItems === 0)
      await new Promise<void>((resolve) => setImmediate(resolve));
    const goal = snapshot.goals[index]!;
    if (
      // The host schedules a single daily audit; it has no manager backlog to refill.
      goal.goal === 'daily-step-audit' ||
      goal.running >= policy.width.workerThreshold ||
      !hasUndispatchedWork(goal)
    )
      continue;

    let delivered = false;
    if (goal.managerId && !goal.managerConflict) {
      const event: ManagerEvent = {
        managerId: goal.managerId,
        goalId: goal.goal,
        kind: 'width',
        summary: widthEventSummary(goal, policy, resolvedControlPlaneOwner),
      };
      delivered = db
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
    }
    let receiverDelivered = false;
    if (resolvedControlPlaneOwner && resolvedControlPlaneOwner !== goal.managerId) {
      const physicalActions = goal.evidenceReceiverActions.flatMap((action) =>
        action.receivingActions
          .filter((receiving) => receiving.receiver === 'control-plane-owner' && receiving.actionable)
          .map((receiving) =>
            `${action.taskId} attempt ${action.attempt}, task owner ${action.owner ?? 'unknown'}: ${receivingActionText(action, receiving, resolvedControlPlaneOwner)}`,
          ),
      );
      if (physicalActions.length) {
        const custodyEvent: ManagerEvent = {
          managerId: resolvedControlPlaneOwner,
          goalId: goal.goal,
          kind: 'width',
          summary: `Width governor custody handoff for ${goal.goal}: ${physicalActions.join(' ')}`,
        };
        receiverDelivered = db
          .transaction(() => {
            if (noLongerActiveManager(db, resolvedControlPlaneOwner)) return false;
            const inserted = db
              .query(
                'INSERT OR IGNORE INTO width_governor_receiver_deliveries(goal, bucket, manager, delivered_at) VALUES (?, ?, ?, ?)',
              )
              .run(goal.goal, bucket, resolvedControlPlaneOwner, snapshot.asOf);
            if (!inserted.changes) return false;
            inbox.deliver(custodyEvent);
            return true;
          })
          .immediate();
      }
    }
    if (delivered || receiverDelivered) deliveredGoals.push(goal.goal);
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
