import type { Database } from 'bun:sqlite';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ManagerEvent, ManagerInbox } from './contracts.ts';
import { agentReportingEvidence } from './agents.ts';
import { migrate } from './db.ts';
import { sameProcess, type ProcessIdentity } from './process.ts';
import { readManagerOwnership, resolveGoalManager } from './manager-ownership.ts';
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
    );
    CREATE TABLE width_governor_receiver_deliveries (
      goal TEXT NOT NULL,
      bucket INTEGER NOT NULL,
      manager TEXT NOT NULL,
      delivered_at TEXT NOT NULL,
      PRIMARY KEY(goal, bucket, manager)
    );
    CREATE TABLE width_resident_episodes (
      manager TEXT PRIMARY KEY,
      episode INTEGER NOT NULL,
      low INTEGER NOT NULL,
      observed_at TEXT NOT NULL
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
  /** Managed source attempts with a current process identity confirmed live; retained as the native-only axis. */
  sourceWriters: number;
  /** Distinct live code-only source writers not already counted as managed source processes. */
  codeOnlySourceWriters: number;
  /** Writing-phase registry rows missing an exact process identity. */
  unknownCodeOnlySourceWriters: number;
  /** Unique live managed plus code-only source processes; null if registry evidence is incomplete. */
  totalSourceWriters: number | null;
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
  /** Persisted task/launch manager provenance; managerId is resolved independently from current ownership. */
  sourceManagerIds: string[];
  sourceManagerConflict: boolean;
  evidenceReceiverActions: EvidenceReceiverAction[];
};

export type WidthSnapshot = {
  asOf: string;
  system: WidthCounts;
  goals: WidthGoalSnapshot[];
  evidence: WidthEvidence;
  codeOnlyWriters: CodeOnlyWriterEvidence[];
};

export type WidthEvidence = {
  codeOnlyRegistry: {
    status: 'available' | 'partial' | 'unavailable';
    reason?: 'state-directory-not-configured' | 'missing' | 'unreadable' | 'malformed' | 'malformed-rows';
    rows: number;
    writingRows: number;
    malformedRows: number;
    notConfirmedLiveRows: number;
    deduplicatedRows: number;
  };
  managerOwnership: { status: 'available' | 'unavailable'; reason?: 'missing' | 'read-failed' };
};

/** One exact, currently live registry identity. Its launch manager remains provenance, not current ownership. */
export type CodeOnlyWriterEvidence = {
  id: string | null;
  goal: string | null;
  identity: ProcessIdentity;
  worktree: string | null;
  sourceManager: string | null;
  sourceCheckpoint?: unknown;
  counted: boolean;
  deduplicatedBy?: 'managed' | 'code-only';
};

export type WidthSnapshotOptions = {
  policy?: ControlPolicy | undefined;
  /** Configured shared state directory containing code-only-writers.json. Omission marks external evidence unavailable. */
  stateDirectory?: string;
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

type MutableCounts = Omit<WidthCounts, 'totalSourceWriters'> & {
  totalSourceWriters: number;
};
type MutableGoal = MutableCounts & {
  goal: string;
  sourceManagers: Set<string>;
  sourceManagerMissing: boolean;
  evidenceReceiverActions: EvidenceReceiverAction[];
};

type IncrementableCount = Exclude<keyof WidthCounts, 'totalSourceWriters'>;
type IdentitySets = Map<string | null, Set<string>>;
type CodeOnlyRegistry = {
  evidence: WidthEvidence['codeOnlyRegistry'];
  writers: Record<string, unknown>[];
};
type GoalOwnership = {
  evidence: WidthEvidence['managerOwnership'];
  owners: Map<string, string[]>;
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
    codeOnlySourceWriters: 0,
    unknownCodeOnlySourceWriters: 0,
    totalSourceWriters: 0,
    held: 0,
    actionableHeld: 0,
    stopped: 0,
    actionableStopped: 0,
    evidenceReceivingStopped: 0,
    actionableEvidenceReceivingStopped: 0,
    waiting: 0,
  };
}

function emptyGoal(goal: string): MutableGoal {
  return {
    goal,
    ...emptyCounts(),
    sourceManagers: new Set(),
    sourceManagerMissing: false,
    evidenceReceiverActions: [],
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function exactProcessIdentity(value: unknown): ProcessIdentity | undefined {
  if (!isRecord(value)) return undefined;
  const { pid, start, boot, group } = value;
  if (
    typeof pid !== 'number' ||
    !Number.isSafeInteger(pid) ||
    pid <= 0 ||
    typeof start !== 'string' ||
    !/^\d+$/.test(start) ||
    typeof boot !== 'string' ||
    !boot ||
    typeof group !== 'number' ||
    !Number.isSafeInteger(group) ||
    group <= 0
  )
    return undefined;
  return { pid, start, boot, group };
}

function identityKey(identity: ProcessIdentity): string {
  return `${identity.pid}\0${identity.start}\0${identity.boot}\0${identity.group}`;
}

function cachedProcessIsLive(
  identity: ProcessIdentity,
  processIsLive: (identity: ProcessIdentity) => boolean,
  cache: Map<string, boolean>,
): boolean {
  const key = identityKey(identity);
  const known = cache.get(key);
  if (known !== undefined) return known;
  const live = processIsLive(identity);
  cache.set(key, live);
  return live;
}

function addIdentity(sets: IdentitySets, goal: string | null, identity: ProcessIdentity): void {
  const key = identityKey(identity);
  let system = sets.get(null);
  if (!system) sets.set(null, (system = new Set()));
  system.add(key);
  if (goal === null) return;
  let perGoal = sets.get(goal);
  if (!perGoal) sets.set(goal, (perGoal = new Set()));
  perGoal.add(key);
}

function identitySet(sets: IdentitySets, goal: string | null): Set<string> {
  return sets.get(goal) ?? new Set();
}

function isProcessIdentity(
  value: Pick<WidthRow, 'pid' | 'process_start' | 'process_boot' | 'process_group'>,
): ProcessIdentity | undefined {
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

function readCodeOnlyWriterRegistry(stateDirectory: string | undefined): CodeOnlyRegistry {
  const unavailable = (reason: NonNullable<WidthEvidence['codeOnlyRegistry']['reason']>): CodeOnlyRegistry => ({
    evidence: {
      status: 'unavailable',
      reason,
      rows: 0,
      writingRows: 0,
      malformedRows: 0,
      notConfirmedLiveRows: 0,
      deduplicatedRows: 0,
    },
    writers: [],
  });
  if (!stateDirectory) return unavailable('state-directory-not-configured');

  let source: string;
  try {
    source = readFileSync(join(stateDirectory, 'code-only-writers.json'), 'utf8');
  } catch (error) {
    return unavailable((error as NodeJS.ErrnoException).code === 'ENOENT' ? 'missing' : 'unreadable');
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(source);
  } catch {
    return unavailable('malformed');
  }
  if (!isRecord(parsed) || !Array.isArray(parsed.writers)) return unavailable('malformed');

  const rows = parsed.writers as unknown[];
  const writers = rows.filter(isRecord);
  let writingRows = 0;
  let malformedRows = rows.length - writers.length;
  for (const row of writers) {
    if (row.phase !== 'writing') continue;
    writingRows++;
    const hasCheckpoint =
      Object.prototype.hasOwnProperty.call(row, 'sourceCheckpoint') ||
      Object.prototype.hasOwnProperty.call(row, 'source');
    if (
      !exactProcessIdentity(row.identity) ||
      typeof row.goal !== 'string' ||
      !row.goal ||
      typeof row.worktree !== 'string' ||
      !row.worktree ||
      !hasCheckpoint
    )
      malformedRows++;
  }
  return {
    evidence: {
      status: malformedRows ? 'partial' : 'available',
      ...(malformedRows ? { reason: 'malformed-rows' as const } : {}),
      rows: rows.length,
      writingRows,
      malformedRows,
      notConfirmedLiveRows: 0,
      deduplicatedRows: 0,
    },
    writers,
  };
}

function readCurrentGoalOwnership(db: Database): GoalOwnership {
  try {
    if (!tableExists(db, 'manager_sessions'))
      return { evidence: { status: 'unavailable', reason: 'missing' }, owners: new Map() };
    const owners = new Map<string, string[]>();
    for (const manager of readManagerOwnership(db)) {
      if (manager.status !== 'running' || manager.kind === 'resident-supermanager') continue;
      for (const goal of manager.goals) {
        const list = owners.get(goal) ?? [];
        list.push(manager.id);
        owners.set(goal, list);
      }
    }
    for (const list of owners.values()) list.sort((left, right) => left.localeCompare(right));
    return { evidence: { status: 'available' }, owners };
  } catch {
    return { evidence: { status: 'unavailable', reason: 'read-failed' }, owners: new Map() };
  }
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
  processLiveCache: Map<string, boolean>,
  sourceIdentities: IdentitySets,
  db: Database,
  policy: ControlPolicy,
): void {
  let goal: MutableGoal | undefined;
  if (typeof row.goal === 'string' && row.goal.length > 0) {
    goal = goals.get(row.goal) ?? emptyGoal(row.goal);
    goals.set(row.goal, goal);
    if (typeof row.manager === 'string' && row.manager.length > 0) goal.sourceManagers.add(row.manager);
    else goal.sourceManagerMissing = true;
  }

  const increment = (key: IncrementableCount) => {
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
    } else if (cachedProcessIsLive(identity, processIsLive, processLiveCache)) {
      increment('running');
      if (source) {
        increment('sourceWriters');
        addIdentity(sourceIdentities, goal?.goal ?? null, identity);
      }
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

function addCodeOnlyWriters(
  registry: CodeOnlyRegistry,
  system: MutableCounts,
  goals: Map<string, MutableGoal>,
  processIsLive: (identity: ProcessIdentity) => boolean,
  processLiveCache: Map<string, boolean>,
  sourceIdentities: IdentitySets,
): CodeOnlyWriterEvidence[] {
  const evidence: CodeOnlyWriterEvidence[] = [];
  const seenExternal = new Set<string>();
  let notConfirmedLiveRows = 0;
  let deduplicatedRows = 0;

  for (const row of registry.writers) {
    if (row.phase !== 'writing') continue;
    const goalName = typeof row.goal === 'string' && row.goal.length > 0 ? row.goal : null;
    const identity = exactProcessIdentity(row.identity);
    if (!identity) {
      system.unknownCodeOnlySourceWriters++;
      if (goalName) {
        const goal = goals.get(goalName) ?? emptyGoal(goalName);
        goal.unknownCodeOnlySourceWriters++;
        goals.set(goalName, goal);
      }
      continue;
    }
    if (!cachedProcessIsLive(identity, processIsLive, processLiveCache)) {
      notConfirmedLiveRows++;
      continue;
    }

    const goal = goalName ? (goals.get(goalName) ?? emptyGoal(goalName)) : undefined;
    if (goalName && goal) goals.set(goalName, goal);
    const key = identityKey(identity);
    const duplicateManagedSource = identitySet(sourceIdentities, null).has(key);
    const duplicateCodeOnly = seenExternal.has(key);
    const counted = !duplicateManagedSource && !duplicateCodeOnly;
    const deduplicatedBy = duplicateManagedSource ? 'managed' : duplicateCodeOnly ? 'code-only' : undefined;
    if (counted) {
      system.codeOnlySourceWriters++;
      if (goal) goal.codeOnlySourceWriters++;
    } else {
      deduplicatedRows++;
    }
    seenExternal.add(key);
    addIdentity(sourceIdentities, goalName, identity);

    const sourceManager = typeof row.manager === 'string' && row.manager.length > 0 ? row.manager : null;
    if (goal) {
      if (sourceManager) goal.sourceManagers.add(sourceManager);
      else goal.sourceManagerMissing = true;
    }
    const writer: CodeOnlyWriterEvidence = {
      id: typeof row.id === 'string' && row.id.length > 0 ? row.id : null,
      goal: goalName,
      identity,
      worktree: typeof row.worktree === 'string' && row.worktree.length > 0 ? row.worktree : null,
      sourceManager,
      ...(Object.prototype.hasOwnProperty.call(row, 'sourceCheckpoint')
        ? { sourceCheckpoint: row.sourceCheckpoint }
        : Object.prototype.hasOwnProperty.call(row, 'source')
          ? { sourceCheckpoint: row.source }
          : {}),
      counted,
      ...(deduplicatedBy ? { deduplicatedBy } : {}),
    };
    evidence.push(writer);
  }

  registry.evidence.notConfirmedLiveRows = notConfirmedLiveRows;
  registry.evidence.deduplicatedRows = deduplicatedRows;
  return evidence;
}

function finishSnapshot(
  asOf: string,
  system: MutableCounts,
  goals: Map<string, MutableGoal>,
  sourceIdentities: IdentitySets,
  registry: CodeOnlyRegistry,
  ownership: GoalOwnership,
  codeOnlyWriters: CodeOnlyWriterEvidence[],
): WidthSnapshot {
  const completeRegistry = registry.evidence.status === 'available';
  const counts = (value: MutableCounts, goal: string | null): WidthCounts => ({
    ...value,
    totalSourceWriters: completeRegistry ? identitySet(sourceIdentities, goal).size : null,
  });
  return {
    asOf,
    system: counts(system, null),
    goals: [...goals.values()]
      .map(({ sourceManagers, sourceManagerMissing, ...goal }) => {
        const owners = ownership.owners.get(goal.goal) ?? [];
        return {
          ...counts(goal, goal.goal),
          goal: goal.goal,
          evidenceReceiverActions: goal.evidenceReceiverActions,
          sourceManagerIds: [...sourceManagers].sort((left, right) => left.localeCompare(right)),
          sourceManagerConflict: sourceManagerMissing || sourceManagers.size > 1,
          managerId: ownership.evidence.status === 'available' && owners.length === 1 ? owners[0]! : null,
          managerConflict: ownership.evidence.status !== 'available' || owners.length !== 1,
        };
      })
      .sort((a, b) => a.goal.localeCompare(b.goal)),
    evidence: { codeOnlyRegistry: registry.evidence, managerOwnership: ownership.evidence },
    codeOnlyWriters,
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
  const processLiveCache = new Map<string, boolean>();
  const sourceIdentities: IdentitySets = new Map();
  const policy = options.policy ?? defaultPolicy;
  const pageSize = policy.width.pageSize;
  const includeStopped = options.includeStopped ?? true;
  // The cursor precedes every persisted sequence; it is not a page-size policy.
  let cursor = -1;
  for (;;) {
    const rows = pageQuery(db, cursor, pageSize, hasRetryIntents, hasWorkerEvents, includeStopped);
    for (const row of rows) addRow(row, system, goals, processIsLive, processLiveCache, sourceIdentities, db, policy);
    if (rows.length < pageSize) break;
    cursor = rows[rows.length - 1]!.sequence;
  }
  const registry = readCodeOnlyWriterRegistry(options.stateDirectory);
  const codeOnlyWriters = addCodeOnlyWriters(
    registry,
    system,
    goals,
    processIsLive,
    processLiveCache,
    sourceIdentities,
  );
  const ownership = readCurrentGoalOwnership(db);
  const date = at instanceof Date ? at : new Date(at);
  return finishSnapshot(date.toISOString(), system, goals, sourceIdentities, registry, ownership, codeOnlyWriters);
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
  const processLiveCache = new Map<string, boolean>();
  const sourceIdentities: IdentitySets = new Map();
  const policy = options.policy ?? defaultPolicy;
  const pageSize = policy.width.pageSize;
  const includeStopped = options.includeStopped ?? true;
  // The cursor precedes every persisted sequence; it is not a page-size policy.
  let cursor = -1;
  for (;;) {
    const rows = pageQuery(db, cursor, pageSize, hasRetryIntents, hasWorkerEvents, includeStopped);
    for (const row of rows) addRow(row, system, goals, processIsLive, processLiveCache, sourceIdentities, db, policy);
    if (rows.length < pageSize) break;
    cursor = rows[rows.length - 1]!.sequence;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  const registry = readCodeOnlyWriterRegistry(options.stateDirectory);
  const codeOnlyWriters = addCodeOnlyWriters(
    registry,
    system,
    goals,
    processIsLive,
    processLiveCache,
    sourceIdentities,
  );
  const ownership = readCurrentGoalOwnership(db);
  const date = at instanceof Date ? at : new Date(at);
  return finishSnapshot(date.toISOString(), system, goals, sourceIdentities, registry, ownership, codeOnlyWriters);
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
  const compiler = receiving.authorizedCommand
    ? ` for exact command ${JSON.stringify(receiving.authorizedCommand)}`
    : '';
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

function registryEvidenceText(evidence: WidthEvidence['codeOnlyRegistry']): string {
  if (evidence.status === 'available') return 'available';
  if (evidence.status === 'partial') return `partial (${evidence.malformedRows} malformed writing or registry row(s))`;
  switch (evidence.reason) {
    case 'state-directory-not-configured':
      return 'unavailable (state directory not configured)';
    case 'missing':
      return 'unavailable (registry missing)';
    case 'unreadable':
      return 'unavailable (registry unreadable)';
    default:
      return 'unavailable (registry malformed)';
  }
}

function widthEventSummary(
  goal: WidthGoalSnapshot,
  policy: ControlPolicy,
  controlPlaneOwner: string | null,
  registryEvidence: WidthEvidence['codeOnlyRegistry'],
): string {
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
  const liveSourceWriters = goal.totalSourceWriters === null ? 'unknown' : String(goal.totalSourceWriters);
  return (
    `Width governor: this Goal has ${goal.running} confirmed live managed workers (${goal.unknownRunning} current running attempts have unknown process identity); ` +
    `Codex subset ${goal.codexRunning} confirmed live (${codexUnknown} Codex evidence unknown); ` +
    `current work counts: ready ${goal.ready}, durable pending starts ${goal.pendingStarts}, held ${goal.held}, stopped ${goal.stopped}, waiting ${goal.waiting}; actionable stops ${goal.actionableStopped}; completed-source evidence receiving ${goal.evidenceReceivingStopped} (${goal.actionableEvidenceReceivingStopped} awaiting an owner action). ` +
    `Source status: registered starts ${goal.sourceReady} (${goal.sourcePendingStarts} durable pending); held ${goal.sourceHolds} (${goal.sourceDependencyHolds} dependencies, ${goal.sourceWaiting} check or custody waits); live source writers ${liveSourceWriters} combined (${goal.sourceWriters} managed, ${goal.codeOnlySourceWriters} code-only confirmed; registry ${registryEvidenceText(registryEvidence)}). ` +
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

export type WidthGovernorOptions = WidthSnapshotOptions & {
  residentManagerId?: string;
  stateDirectory?: string;
};

type SourceOwnerCounts = { live: number; ready: number };
type CodeOnlySourceWriters = { live: number; owners: Map<string, number>; unavailable?: string };

/** The code-only launcher publishes writing identities atomically; other lifecycle phases never count. */
function readCodeOnlySourceWriters(
  db: Database,
  directory: string | undefined,
  processIsLive: (identity: ProcessIdentity) => boolean,
): CodeOnlySourceWriters {
  const result: CodeOnlySourceWriters = { live: 0, owners: new Map() };
  if (!directory) return result;
  let registry: { version?: unknown; writers?: unknown };
  try {
    registry = JSON.parse(readFileSync(join(directory, 'code-only-writers.json'), 'utf8'));
    if (!registry || registry.version !== 1 || !Array.isArray(registry.writers))
      throw new Error('invalid code-only writer registry');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
      result.unavailable = error instanceof Error ? error.message : String(error);
    return result;
  }
  const seen = new Set<string>();
  if (tableExists(db, 'worker_current_attempts')) {
    const rows = db
      .query(`SELECT pid, process_start, process_boot, process_group FROM worker_current_attempts
        WHERE task_state='running' AND attempt_state='running'`)
      .all() as Pick<WidthRow, 'pid' | 'process_start' | 'process_boot' | 'process_group'>[];
    for (const row of rows) {
      const identity = isProcessIdentity(row);
      if (identity) seen.add(identityKey(identity));
    }
  }
  for (const entry of registry.writers as unknown[]) {
    if (!entry || typeof entry !== 'object') continue;
    const writer = entry as { phase?: unknown; manager?: unknown; identity?: Partial<ProcessIdentity> };
    if (writer.phase !== 'writing' || !writer.identity || typeof writer.identity !== 'object') continue;
    const identity = isProcessIdentity({
      pid: writer.identity.pid ?? null,
      process_start: writer.identity.start ?? null,
      process_boot: writer.identity.boot ?? null,
      process_group: writer.identity.group ?? null,
    });
    if (!identity || seen.has(identityKey(identity)) || !processIsLive(identity)) continue;
    seen.add(identityKey(identity));
    result.live++;
    const owner = typeof writer.manager === 'string' && writer.manager ? writer.manager : 'unknown';
    result.owners.set(owner, (result.owners.get(owner) ?? 0) + 1);
  }
  return result;
}

function residentOwnerCounts(db: Database, snapshot: WidthSnapshot): Map<string, SourceOwnerCounts> {
  const owners = new Map<string, SourceOwnerCounts>();
  if (tableExists(db, 'manager_sessions')) {
    const rows = db
      .query(`SELECT id FROM manager_sessions WHERE json_extract(state, '$.status')='running'
        AND coalesce(json_extract(state, '$.kind'), 'managed')='managed'`)
      .all() as { id: string }[];
    for (const row of rows) owners.set(row.id, { live: 0, ready: 0 });
  }
  for (const goal of snapshot.goals) {
    const owner = goal.managerId ?? 'unknown';
    const counts = owners.get(owner) ?? { live: 0, ready: 0 };
    counts.live += goal.sourceWriters;
    counts.ready += goal.sourceReady;
    owners.set(owner, counts);
  }
  return owners;
}

/** One native resident notification per low-source episode, including an empty ready queue. */
function notifyResidentLowWidth(
  db: Database,
  inbox: ManagerInbox,
  snapshot: WidthSnapshot,
  options: WidthGovernorOptions,
  policy: ControlPolicy,
): void {
  const manager = options.residentManagerId;
  if (!manager) return;
  const external = readCodeOnlySourceWriters(db, options.stateDirectory, options.processIsLive ?? sameProcess);
  const live = snapshot.system.sourceWriters + external.live;
  const minimum = policy.width.residentSourceMinimum;
  db.transaction(() => {
    const previous = db.query('SELECT episode, low FROM width_resident_episodes WHERE manager=?').get(manager) as {
      episode: number;
      low: number;
    } | null;
    if (live >= minimum) {
      if (previous?.low)
        db.query('UPDATE width_resident_episodes SET low=0, observed_at=? WHERE manager=?').run(snapshot.asOf, manager);
      return;
    }
    if (previous?.low) return;
    const episode = (previous?.episode ?? 0) + 1;
    const owners = residentOwnerCounts(db, snapshot);
    for (const [owner, count] of external.owners) {
      const counts = owners.get(owner) ?? { live: 0, ready: 0 };
      counts.live += count;
      owners.set(owner, counts);
    }
    const perOwner = [...owners]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([owner, counts]) => `${owner} ${counts.live}/${counts.ready}`)
      .join('; ');
    db.query(`INSERT INTO width_resident_episodes(manager, episode, low, observed_at) VALUES (?, ?, 1, ?)
      ON CONFLICT(manager) DO UPDATE SET episode=excluded.episode, low=1, observed_at=excluded.observed_at`).run(
      manager,
      episode,
      snapshot.asOf,
    );
    inbox.deliver({
      managerId: manager,
      kind: 'width',
      from: 'system:resident-width',
      summary:
        `Source concurrency below ${minimum}: ${live} confirmed live; episode ${episode}; observed ${snapshot.asOf}. ` +
        `Managed source writers ${snapshot.system.sourceWriters}; code-only source writers ${external.live}; ` +
        `managed ready ${snapshot.system.sourceReady}; check/custody waits ${snapshot.system.sourceWaiting}; ` +
        `unknown managed process identities ${snapshot.system.unknownRunning}. ` +
        `Owners live source/managed ready: ${perOwner || 'none'}. ` +
        (external.unavailable ? `Code-only writer evidence unavailable: ${external.unavailable}. ` : '') +
        'Direct the responsible managers to refill independent writable outcomes and repair start failures now. ' +
        'Waiting checks, unknown identities and dead processes do not count as coding concurrency.',
    });
  }).immediate();
}

/** Send at most one durable wakeable width event to each eligible Goal in the current UTC bucket. */
export async function sweepWidthGovernor(
  db: Database,
  inbox: ManagerInbox,
  at: Date | number = new Date(),
  options: WidthGovernorOptions = {},
): Promise<WidthGovernorSweep> {
  const policy = options.policy ?? defaultPolicy;
  migrate(db, widthGovernorMigrations);
  const snapshot = await readWidthSnapshot(db, at, {
    yieldBetweenPages: true,
    policy,
    ...(options.stateDirectory === undefined ? {} : { stateDirectory: options.stateDirectory }),
    ...(options.processIsLive ? { processIsLive: options.processIsLive } : {}),
  });
  const date = at instanceof Date ? at : new Date(at);
  const bucket = Math.floor(date.getTime() / policy.width.bucketMs);
  const resolvedControlPlaneOwner = resolveGoalManager(db, 'control-plane', '') || null;
  notifyResidentLowWidth(db, inbox, snapshot, options, policy);
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
        summary: widthEventSummary(goal, policy, resolvedControlPlaneOwner, snapshot.evidence.codeOnlyRegistry),
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
          .map(
            (receiving) =>
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
      'Actual live source writers: unknown; this snapshot did not record width evidence.',
    ];
  const { system } = snapshot;
  const ownershipLine =
    snapshot.evidence.managerOwnership.status === 'available'
      ? `Current Goal ownership evidence: available; ${snapshot.goals.filter((goal) => goal.managerConflict).length} Goal(s) have no unique running owner.`
      : `Current Goal ownership evidence: unavailable (${snapshot.evidence.managerOwnership.reason}).`;
  const totalSourceWriters =
    system.totalSourceWriters === null
      ? `unknown (${registryEvidenceText(snapshot.evidence.codeOnlyRegistry)})`
      : system.totalSourceWriters;
  return [
    `Actual system-wide running workers: ${system.running} confirmed live managed attempts; ${system.unknownRunning} current running attempts have unknown process identity.`,
    `Actual Codex running workers: ${system.codexRunning} confirmed live; ${system.unknownCodexRunning} have unknown process identity; ${system.unknownCodexClassification} have unknown CLI evidence.`,
    `Actual live source writers: ${totalSourceWriters} combined; ${system.sourceWriters} managed; ${system.codeOnlySourceWriters} distinct code-only confirmed; ${system.unknownCodeOnlySourceWriters} writing row(s) have unknown process identity. Registry ${registryEvidenceText(snapshot.evidence.codeOnlyRegistry)}.`,
    ownershipLine,
  ];
}
