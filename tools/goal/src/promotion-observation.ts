import { defaultPolicy } from './policy.ts';
import { randomUUID, createHash } from 'node:crypto';
import type { Database } from 'bun:sqlite';
import { migrate } from './db.ts';

export const PROMOTION_PHYSICAL_CUSTODY_UNAVAILABLE =
  'scripts/remote-check.ts exposes no structured current run, generation, cgroup identity, or terminal custody event';
export const PROMOTION_LAUNCH_SOURCE_UNAVAILABLE =
  'scripts/remote-check.ts exposes no authenticated launch revision, script hash, producer revision, or client cohort receipt';
export const MAX_PROMOTION_COMMAND_RECORD_BYTES = defaultPolicy.promotion.commandRecordBytes;
export const MAX_PROMOTION_REASON_BYTES = defaultPolicy.promotion.reasonBytes;

export type PromotionWindowPhase =
  | 'wait-ended'
  | 'admitted'
  | 'preparation-started'
  | 'preparation-ended'
  | 'execution-started'
  | 'execution-ended';
export type PromotionGroupOutcome = 'passed' | 'failed' | 'interrupted';
export type PromotionParentWindow = {
  id: string;
  promotionId: string | null;
  startedAt: string;
  terminalAt: string | null;
  outcome: string;
};
export type PromotionGroupWindow = {
  id: string;
  parentWindowId: string | null;
  promotionId: string;
  group: string;
  attempt: number;
  commit: string;
  commands: string[][] | { omitted: true; bytes: number; sha256: string };
  enqueuedAt: string;
  waitStartedAt: string;
  waitEndedAt: string | null;
  admittedAt: string | null;
  preparationStartedAt: string | null;
  preparationEndedAt: string | null;
  executionStartedAt: string | null;
  executionEndedAt: string | null;
  terminalAt: string | null;
  outcome: 'running' | PromotionGroupOutcome;
  timedOut: boolean | null;
  physicalStatus: 'unavailable';
  physicalReason: string;
  sourceStatus: 'unavailable' | 'known';
  sourceReason: string;
  launchSourceRevision: string | null;
  launchRemoteCheckSha256: string | null;
  integratedProducerRevision: string | null;
  integratedProducerSha256: string | null;
  clientCohort: string | null;
  physicalHost: string | null;
  physicalRunId: string | null;
  physicalGeneration: string | null;
  physicalIncarnation: string | null;
  physicalCgroup: string | null;
  sampleStartedAt: string | null;
  sampleEndedAt: string | null;
  /** Null means no physical sample/summary was available; it is never a measured zero. */
  resourceSampleCount: number | null;
  cpuPeakCores: number | null;
  cpuIntervalMs: number | null;
  cpuCoverageMs: number | null;
  memoryPeakBytes: number | null;
  memoryPeakScope: string | null;
};

const migrations = [
  {
    module: 'promotion_observation',
    version: 1,
    sql: `
CREATE TABLE promotion_parent_windows (
  id TEXT PRIMARY KEY,
  promotion_id TEXT,
  started_at TEXT NOT NULL,
  terminal_at TEXT,
  outcome TEXT NOT NULL
);
CREATE INDEX promotion_parent_windows_run ON promotion_parent_windows(promotion_id, started_at);
CREATE TABLE promotion_group_windows (
  id TEXT PRIMARY KEY,
  parent_window_id TEXT,
  promotion_id TEXT NOT NULL,
  group_key TEXT NOT NULL,
  attempt INTEGER NOT NULL,
  commit_hash TEXT NOT NULL,
  commands_json TEXT NOT NULL,
  enqueued_at TEXT NOT NULL,
  wait_started_at TEXT NOT NULL,
  wait_ended_at TEXT,
  admitted_at TEXT,
  preparation_started_at TEXT,
  preparation_ended_at TEXT,
  execution_started_at TEXT,
  execution_ended_at TEXT,
  terminal_at TEXT,
  outcome TEXT NOT NULL,
  timed_out INTEGER,
  physical_status TEXT NOT NULL,
  physical_reason TEXT NOT NULL,
  resource_sample_count INTEGER,
  cpu_peak_cores REAL,
  cpu_interval_ms REAL,
  cpu_coverage_ms REAL,
  memory_peak_bytes INTEGER,
  memory_peak_scope TEXT,
  physical_host TEXT,
  physical_run_id TEXT,
  physical_generation TEXT,
  physical_incarnation TEXT,
  physical_cgroup TEXT,
  sample_started_at TEXT,
  sample_ended_at TEXT
);
CREATE INDEX promotion_group_windows_run ON promotion_group_windows(promotion_id, enqueued_at);
CREATE INDEX promotion_group_windows_parent ON promotion_group_windows(parent_window_id, enqueued_at);
CREATE UNIQUE INDEX promotion_group_windows_key ON promotion_group_windows(promotion_id, group_key, attempt);
`,
  },
  {
    module: 'promotion_observation',
    version: 2,
    sql: `
ALTER TABLE promotion_group_windows ADD COLUMN source_status TEXT;
ALTER TABLE promotion_group_windows ADD COLUMN source_reason TEXT;
ALTER TABLE promotion_group_windows ADD COLUMN launch_source_revision TEXT;
ALTER TABLE promotion_group_windows ADD COLUMN launch_remote_check_sha256 TEXT;
ALTER TABLE promotion_group_windows ADD COLUMN integrated_producer_revision TEXT;
ALTER TABLE promotion_group_windows ADD COLUMN integrated_producer_sha256 TEXT;
ALTER TABLE promotion_group_windows ADD COLUMN client_cohort TEXT;
`,
  },
];

export function ensurePromotionObservationSchema(db: Database): void {
  migrate(db, migrations);
}

function timestamp(value = new Date().toISOString()): string {
  if (!Number.isFinite(Date.parse(value))) throw new Error(`invalid promotion observation timestamp ${value}`);
  return new Date(Date.parse(value)).toISOString();
}

function commandRecord(commands: readonly (readonly string[])[], limit: number): string {
  const value = JSON.stringify(commands);
  const bytes = Buffer.byteLength(value);
  if (bytes <= limit) return value;
  return JSON.stringify({
    omitted: true,
    bytes,
    sha256: createHash('sha256').update(value).digest('hex'),
  });
}

function boundedReason(reason: string, limit: number): string {
  const bytes = Buffer.byteLength(reason);
  if (bytes <= limit) return reason;
  return `reason omitted (${bytes} bytes; sha256 ${createHash('sha256').update(reason).digest('hex')})`;
}

export function beginPromotionParentWindow(
  db: Database,
  promotionId: string | null,
  at = new Date().toISOString(),
): string {
  ensurePromotionObservationSchema(db);
  const id = randomUUID();
  db.query(
    'INSERT INTO promotion_parent_windows(id,promotion_id,started_at,terminal_at,outcome) VALUES (?,?,?,NULL,?)',
  ).run(id, promotionId, timestamp(at), 'running');
  return id;
}

export function linkPromotionParentWindow(db: Database, parentWindowId: string | undefined, promotionId: string): void {
  if (!parentWindowId) return;
  ensurePromotionObservationSchema(db);
  db.query('UPDATE promotion_parent_windows SET promotion_id=? WHERE id=? AND promotion_id IS NULL').run(
    promotionId,
    parentWindowId,
  );
}

export function finishPromotionParentWindow(
  db: Database,
  parentWindowId: string | undefined,
  outcome = 'returned',
  at = new Date().toISOString(),
): void {
  if (!parentWindowId) return;
  ensurePromotionObservationSchema(db);
  db.query('UPDATE promotion_parent_windows SET terminal_at=?, outcome=? WHERE id=? AND terminal_at IS NULL').run(
    timestamp(at),
    outcome,
    parentWindowId,
  );
}

export function beginPromotionGroupWindow(
  db: Database,
  input: {
    parentWindowId?: string;
    promotionId: string;
    group: string;
    commit: string;
    commands: readonly (readonly string[])[];
    at?: string;
  },
  policy = defaultPolicy.promotion,
): string {
  ensurePromotionObservationSchema(db);
  const id = randomUUID();
  const at = timestamp(input.at);
  db.transaction(() => {
    const attempt =
      (
        db
          .query('SELECT MAX(attempt) AS attempt FROM promotion_group_windows WHERE promotion_id=? AND group_key=?')
          .get(input.promotionId, input.group) as { attempt: number | null }
      ).attempt ?? 0;
    db.query(
      `INSERT INTO promotion_group_windows(
        id,parent_window_id,promotion_id,group_key,attempt,commit_hash,commands_json,
        enqueued_at,wait_started_at,wait_ended_at,admitted_at,
        preparation_started_at,preparation_ended_at,execution_started_at,execution_ended_at,
        terminal_at,outcome,timed_out,physical_status,physical_reason,
        resource_sample_count,cpu_peak_cores,cpu_interval_ms,cpu_coverage_ms,memory_peak_bytes,memory_peak_scope,
        physical_host,physical_run_id,physical_generation,physical_incarnation,physical_cgroup,sample_started_at,sample_ended_at
      ) VALUES (?,?,?,?,?,?,?,?,?,NULL,NULL,NULL,NULL,NULL,NULL,NULL,'running',NULL,'unavailable',?,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL)`,
    ).run(
      id,
      input.parentWindowId ?? null,
      input.promotionId,
      input.group,
      attempt + 1,
      input.commit,
      commandRecord(input.commands, policy.commandRecordBytes),
      at,
      at,
      PROMOTION_PHYSICAL_CUSTODY_UNAVAILABLE,
    );
    db.query(`UPDATE promotion_group_windows SET source_status='unavailable', source_reason=? WHERE id=?`).run(
      PROMOTION_LAUNCH_SOURCE_UNAVAILABLE,
      id,
    );
  }).immediate();
  return id;
}

export function markPromotionGroupPhase(
  db: Database,
  windowId: string | undefined,
  phase: PromotionWindowPhase,
  at = new Date().toISOString(),
): void {
  if (!windowId) return;
  ensurePromotionObservationSchema(db);
  const column: Record<PromotionWindowPhase, string> = {
    'wait-ended': 'wait_ended_at',
    admitted: 'admitted_at',
    'preparation-started': 'preparation_started_at',
    'preparation-ended': 'preparation_ended_at',
    'execution-started': 'execution_started_at',
    'execution-ended': 'execution_ended_at',
  };
  const field = column[phase];
  const value = timestamp(at);
  if (phase === 'admitted') {
    db.query(
      `UPDATE promotion_group_windows SET wait_ended_at=COALESCE(wait_ended_at,?), admitted_at=COALESCE(admitted_at,?) WHERE id=? AND terminal_at IS NULL`,
    ).run(value, value, windowId);
  } else if (phase === 'execution-ended') {
    db.query(`UPDATE promotion_group_windows SET ${field}=? WHERE id=? AND terminal_at IS NULL`).run(value, windowId);
  } else {
    db.query(`UPDATE promotion_group_windows SET ${field}=COALESCE(${field},?) WHERE id=? AND terminal_at IS NULL`).run(
      value,
      windowId,
    );
  }
}

export function finishPromotionGroupWindow(
  db: Database,
  windowId: string | undefined,
  outcome: PromotionGroupOutcome,
  timedOut: boolean | null,
  at = new Date().toISOString(),
): void {
  if (!windowId) return;
  ensurePromotionObservationSchema(db);
  db.query(
    'UPDATE promotion_group_windows SET terminal_at=?, outcome=?, timed_out=? WHERE id=? AND terminal_at IS NULL',
  ).run(timestamp(at), outcome, timedOut === null ? null : Number(timedOut), windowId);
}

/** A custody miss stays explicit; no absent start, counter, or cgroup descriptor is represented as zero. */
export function recordPromotionCustodyUnavailable(
  db: Database,
  windowId: string | undefined,
  reason = PROMOTION_PHYSICAL_CUSTODY_UNAVAILABLE,
  policy = defaultPolicy.promotion,
): void {
  if (!windowId) return;
  ensurePromotionObservationSchema(db);
  db.query(
    `UPDATE promotion_group_windows SET physical_status=?, physical_reason=?, resource_sample_count=NULL,
      cpu_peak_cores=NULL, cpu_interval_ms=NULL, cpu_coverage_ms=NULL, memory_peak_bytes=NULL, memory_peak_scope=NULL,
      physical_host=NULL, physical_run_id=NULL, physical_generation=NULL, physical_incarnation=NULL, physical_cgroup=NULL,
      sample_started_at=NULL, sample_ended_at=NULL WHERE id=?`,
  ).run('unavailable', boundedReason(reason, policy.reasonBytes), windowId);
}

/** Called only after acquiring promotion.lease, so open windows belong to a process that has lost custody. */
export function recoverIncompletePromotionWindows(db: Database, at = new Date().toISOString()): void {
  ensurePromotionObservationSchema(db);
  const value = timestamp(at);
  db.transaction(() => {
    db.query(
      "UPDATE promotion_group_windows SET terminal_at=?, outcome='interrupted' WHERE terminal_at IS NULL AND outcome='running'",
    ).run(value);
    db.query(
      "UPDATE promotion_parent_windows SET terminal_at=?, outcome='interrupted' WHERE terminal_at IS NULL AND outcome='running'",
    ).run(value);
  }).immediate();
}

export function readPromotionParentWindows(db: Database): PromotionParentWindow[] {
  ensurePromotionObservationSchema(db);
  return (
    db
      .query(
        'SELECT id,promotion_id,started_at,terminal_at,outcome FROM promotion_parent_windows ORDER BY started_at,id',
      )
      .all() as any[]
  ).map((row) => ({
    id: row.id,
    promotionId: row.promotion_id,
    startedAt: row.started_at,
    terminalAt: row.terminal_at,
    outcome: row.outcome,
  }));
}

export function readPromotionGroupWindows(db: Database): PromotionGroupWindow[] {
  ensurePromotionObservationSchema(db);
  return (
    db
      .query(
        `SELECT id,parent_window_id,promotion_id,group_key,attempt,commit_hash,commands_json,
        enqueued_at,wait_started_at,wait_ended_at,admitted_at,preparation_started_at,preparation_ended_at,
        execution_started_at,execution_ended_at,terminal_at,outcome,timed_out,physical_status,physical_reason,
        source_status,source_reason,launch_source_revision,launch_remote_check_sha256,
        integrated_producer_revision,integrated_producer_sha256,client_cohort,
        resource_sample_count,cpu_peak_cores,cpu_interval_ms,cpu_coverage_ms,memory_peak_bytes,memory_peak_scope,
        physical_host,physical_run_id,physical_generation,physical_incarnation,physical_cgroup,sample_started_at,sample_ended_at
       FROM promotion_group_windows ORDER BY enqueued_at,id`,
      )
      .all() as any[]
  ).map((row) => ({
    id: row.id,
    parentWindowId: row.parent_window_id,
    promotionId: row.promotion_id,
    group: row.group_key,
    attempt: row.attempt,
    commit: row.commit_hash,
    commands: JSON.parse(row.commands_json),
    enqueuedAt: row.enqueued_at,
    waitStartedAt: row.wait_started_at,
    waitEndedAt: row.wait_ended_at,
    admittedAt: row.admitted_at,
    preparationStartedAt: row.preparation_started_at,
    preparationEndedAt: row.preparation_ended_at,
    executionStartedAt: row.execution_started_at,
    executionEndedAt: row.execution_ended_at,
    terminalAt: row.terminal_at,
    outcome: row.outcome,
    timedOut: row.timed_out === null ? null : row.timed_out === 1,
    physicalStatus: row.physical_status,
    physicalReason: row.physical_reason,
    sourceStatus: row.source_status ?? 'unavailable',
    sourceReason: row.source_reason ?? PROMOTION_LAUNCH_SOURCE_UNAVAILABLE,
    launchSourceRevision: row.launch_source_revision,
    launchRemoteCheckSha256: row.launch_remote_check_sha256,
    integratedProducerRevision: row.integrated_producer_revision,
    integratedProducerSha256: row.integrated_producer_sha256,
    clientCohort: row.client_cohort,
    physicalHost: row.physical_host,
    physicalRunId: row.physical_run_id,
    physicalGeneration: row.physical_generation,
    physicalIncarnation: row.physical_incarnation,
    physicalCgroup: row.physical_cgroup,
    sampleStartedAt: row.sample_started_at,
    sampleEndedAt: row.sample_ended_at,
    resourceSampleCount: row.resource_sample_count,
    cpuPeakCores: row.cpu_peak_cores,
    cpuIntervalMs: row.cpu_interval_ms,
    cpuCoverageMs: row.cpu_coverage_ms,
    memoryPeakBytes: row.memory_peak_bytes,
    memoryPeakScope: row.memory_peak_scope,
  }));
}
