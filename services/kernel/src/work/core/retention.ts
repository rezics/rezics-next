import {
  DEFAULT_WORKFLOW_RETENTION_DAYS,
  MAX_WORKFLOW_RETENTION_DAYS,
  MIN_WORKFLOW_RETENTION_DAYS,
  TERMINAL_WORKFLOW_STATUSES,
  WORKFLOW_RETENTION_BATCH_SIZE,
  WORKFLOW_RETENTION_CASCADE_TABLES,
  WORKFLOW_RETENTION_DAY_MS,
  WORKFLOW_RETENTION_DELETE_CONTROL_STATEMENTS,
  WORKFLOW_RETENTION_DELETE_STATEMENTS,
  WORKFLOW_RETENTION_EMPTY_BATCH_STATEMENTS,
  WORKFLOW_RETENTION_EXECUTION_BYTES,
  WORKFLOW_RETENTION_EXPLICIT_DELETE_TABLES,
  WORKFLOW_RETENTION_FAMILY_LIMITS,
  WORKFLOW_RETENTION_METADATA_BYTES,
  WORKFLOW_RETENTION_NESTED_FK_STATEMENTS,
  WORKFLOW_RETENTION_NONEMPTY_APPLICATION_STATEMENTS,
  WORKFLOW_RETENTION_NONEMPTY_BATCH_STATEMENTS,
  WORKFLOW_RETENTION_PAYLOAD_BYTES,
  WORKFLOW_RETENTION_PAYLOAD_FAMILIES,
  WORKFLOW_RETENTION_ROLLBACK_STATEMENTS,
  WORKFLOW_RETENTION_SELECT_STATEMENTS,
  WORKFLOW_RETENTION_SELECT_TAG,
  WORKFLOW_RETENTION_STATUS_DELETE_POINTS,
  WORKFLOW_RETENTION_STATUS_DELETE_STATEMENTS,
  WORKFLOW_RETENTION_VARIABLE_FAMILIES,
} from '../contract/bounds.ts';

export type WorkflowRetentionConfig = Readonly<{ retentionDays: number }>;
export type WorkflowRetentionStart = Readonly<{
  retentionDays: number;
  now: number;
  applicationName: string;
}>;
export type WorkflowRetentionSelection = Readonly<{
  applicationName: string;
  statuses: typeof TERMINAL_WORKFLOW_STATUSES;
  completedBefore: number;
  limit: number;
}>;
export type WorkflowRetentionPayloadFamily = (typeof WORKFLOW_RETENTION_PAYLOAD_FAMILIES)[number]['table'];
export type WorkflowRetentionPayloadInventory = Readonly<Record<WorkflowRetentionPayloadFamily, number>>;
export type WorkflowRetentionByteInventory = WorkflowRetentionPayloadInventory;
export type WorkflowRetentionFanout = Readonly<{
  operations?: number;
  events?: number;
  history?: number;
  notifications?: number;
  streams?: number;
  input?: number;
  output?: number;
}>;
export type WorkflowRetentionStatementKind =
  | 'select'
  | 'begin'
  | 'commit'
  | 'rollback'
  | 'delete-workflow_input'
  | 'delete-workflow_output'
  | 'delete-operation_outputs'
  | 'delete-workflow_status'
  | 'cascade-workflow_events'
  | 'cascade-workflow_events_history'
  | 'cascade-notifications'
  | 'cascade-streams'
  | 'other';
export type WorkflowRetentionBatchWork = Readonly<{
  selected: number;
  statements: number;
  applicationStatements: number;
  controlStatements: number;
  selectStatements: number;
  deleteStatements: number;
  payloadRows: number;
  cascadeRows: number;
  deletionRows: number;
  examinedRows: number;
}>;
export type WorkflowRetentionCompleteWork = WorkflowRetentionBatchWork &
  Readonly<{
    nestedFkStatements: number;
    nestedFkPoints: number;
    statusDeleteStatements: number;
    indexProbes: number;
    payloadBytes: number;
    fenceRows: number;
    rollbackStatements: number;
    replayApplicationStatements: number;
    replayControlStatements: number;
    familyRows: WorkflowRetentionPayloadInventory;
    familyBytes: WorkflowRetentionByteInventory;
  }>;
export type WorkflowRetentionSweepWork = Readonly<{
  batches: number;
  lastBatchSize: number;
  selected: number;
  statements: number;
  applicationStatements: number;
  controlStatements: number;
  payloadRows: number;
  cascadeRows: number;
  deletionRows: number;
  examinedRows: number;
}>;
export type WorkflowRetentionCompleteSweepWork = WorkflowRetentionSweepWork &
  Readonly<{
    nestedFkStatements: number;
    indexProbes: number;
    payloadBytes: number;
    fenceRows: number;
    rollbackStatements: number;
    replayApplicationStatements: number;
    replayControlStatements: number;
  }>;

const emptyInventory: WorkflowRetentionPayloadInventory = {
  workflow_status: 0,
  workflow_input: 0,
  workflow_output: 0,
  operation_outputs: 0,
  workflow_events: 0,
  workflow_events_history: 0,
  notifications: 0,
  streams: 0,
};

export function parseWorkflowRetentionDays(raw: string | undefined): number {
  if (raw === undefined) return DEFAULT_WORKFLOW_RETENTION_DAYS;
  if (!/^\d+$/.test(raw)) throw new RangeError('KERNEL_WORKFLOW_RETENTION_DAYS');
  const retentionDays = Number(raw);
  if (
    !Number.isSafeInteger(retentionDays) ||
    retentionDays < MIN_WORKFLOW_RETENTION_DAYS ||
    retentionDays > MAX_WORKFLOW_RETENTION_DAYS
  )
    throw new RangeError('KERNEL_WORKFLOW_RETENTION_DAYS');
  return retentionDays;
}

export function readWorkflowRetentionConfig(
  env: Readonly<Record<string, string | undefined>>,
): WorkflowRetentionConfig {
  return { retentionDays: parseWorkflowRetentionDays(env.KERNEL_WORKFLOW_RETENTION_DAYS) };
}

export function assertRetentionDays(retentionDays: number): void {
  if (
    !Number.isSafeInteger(retentionDays) ||
    retentionDays < MIN_WORKFLOW_RETENTION_DAYS ||
    retentionDays > MAX_WORKFLOW_RETENTION_DAYS
  )
    throw new RangeError('Invalid workflow retention period');
}

export function retentionCutoff(now: Date, retentionDays: number): number {
  return now.getTime() - retentionDays * WORKFLOW_RETENTION_DAY_MS;
}

export function clampRetentionBatch(ids: readonly string[]): string[] {
  return [...ids].slice(0, WORKFLOW_RETENTION_BATCH_SIZE);
}

export function emptyWorkflowRetentionInventory(): WorkflowRetentionPayloadInventory {
  return emptyInventory;
}

export function emptyWorkflowRetentionBytes(): WorkflowRetentionByteInventory {
  return emptyInventory;
}

export function workflowRetentionInventory(
  rows: Partial<WorkflowRetentionPayloadInventory>,
): WorkflowRetentionPayloadInventory {
  return {
    workflow_status: rows.workflow_status ?? 0,
    workflow_input: rows.workflow_input ?? 0,
    workflow_output: rows.workflow_output ?? 0,
    operation_outputs: rows.operation_outputs ?? 0,
    workflow_events: rows.workflow_events ?? 0,
    workflow_events_history: rows.workflow_events_history ?? 0,
    notifications: rows.notifications ?? 0,
    streams: rows.streams ?? 0,
  };
}

export function workflowRetentionBytes(
  rows: Partial<WorkflowRetentionByteInventory>,
): WorkflowRetentionByteInventory {
  return workflowRetentionInventory(rows);
}

export function retentionFamilyLimit(table: WorkflowRetentionPayloadFamily): number {
  return WORKFLOW_RETENTION_FAMILY_LIMITS[table];
}

export function admitRetentionFamilyCopies(table: WorkflowRetentionPayloadFamily, copies: number): number {
  if (!Number.isSafeInteger(copies) || copies < 0) throw new RangeError(table);
  return Math.min(copies, retentionFamilyLimit(table));
}

export function admitRetentionPayloadBytes(bytes: number): number {
  if (!Number.isSafeInteger(bytes) || bytes < 0) throw new RangeError('payloadBytes');
  return Math.min(bytes, WORKFLOW_RETENTION_PAYLOAD_BYTES);
}

export function admitRetentionMetadataBytes(bytes: number): number {
  if (!Number.isSafeInteger(bytes) || bytes < 0) throw new RangeError('metadataBytes');
  return Math.min(bytes, WORKFLOW_RETENTION_METADATA_BYTES);
}

export function retentionPayloadRows(inventory: WorkflowRetentionPayloadInventory): number {
  return (
    inventory.workflow_input +
    inventory.workflow_output +
    inventory.operation_outputs +
    inventory.workflow_events +
    inventory.workflow_events_history +
    inventory.notifications +
    inventory.streams
  );
}

export function retentionCascadeRows(inventory: WorkflowRetentionPayloadInventory): number {
  return inventory.workflow_events + inventory.workflow_events_history + inventory.notifications + inventory.streams;
}

export function retentionExplicitDeleteRows(inventory: WorkflowRetentionPayloadInventory): number {
  return inventory.workflow_input + inventory.workflow_output + inventory.operation_outputs + inventory.workflow_status;
}

export function retentionDeletionRows(inventory: WorkflowRetentionPayloadInventory): number {
  return retentionExplicitDeleteRows(inventory) + retentionCascadeRows(inventory);
}

export function retentionOwnedRows(inventory: WorkflowRetentionPayloadInventory): number {
  return retentionDeletionRows(inventory);
}

export function retentionPayloadBytes(inventory: WorkflowRetentionByteInventory): number {
  return (
    inventory.workflow_status +
    inventory.workflow_input +
    inventory.workflow_output +
    inventory.operation_outputs +
    inventory.workflow_events +
    inventory.workflow_events_history +
    inventory.notifications +
    inventory.streams
  );
}

export function retentionBatchStatementCount(selected: number): number {
  return selected === 0 ? WORKFLOW_RETENTION_EMPTY_BATCH_STATEMENTS : WORKFLOW_RETENTION_NONEMPTY_BATCH_STATEMENTS;
}

export function retentionApplicationStatementCount(selected: number): number {
  return selected === 0
    ? WORKFLOW_RETENTION_EMPTY_BATCH_STATEMENTS
    : WORKFLOW_RETENTION_NONEMPTY_APPLICATION_STATEMENTS;
}

export function retentionControlStatementCount(selected: number): number {
  return selected === 0 ? 0 : WORKFLOW_RETENTION_DELETE_CONTROL_STATEMENTS;
}

export function retentionSweepStatementCount(fullBatches: number, lastBatchSize: number): number {
  return fullBatches * WORKFLOW_RETENTION_NONEMPTY_BATCH_STATEMENTS + retentionBatchStatementCount(lastBatchSize);
}

export function retentionNestedFkStatements(selected: number, inventory: WorkflowRetentionPayloadInventory): number {
  if (selected === 0) return 0;
  let nested = 0;
  for (const table of WORKFLOW_RETENTION_CASCADE_TABLES) if (inventory[table] > 0) nested += 1;
  return nested === 0 ? WORKFLOW_RETENTION_NESTED_FK_STATEMENTS : nested;
}

export function retentionStatusDeleteStatements(
  selected: number,
  inventory: WorkflowRetentionPayloadInventory,
): number {
  return selected === 0 ? 0 : 1 + retentionNestedFkStatements(selected, inventory);
}

export function retentionDeleteIndexProbes(selected: number): number {
  return selected === 0 ? 0 : selected * WORKFLOW_RETENTION_PAYLOAD_FAMILIES.length;
}

export function retentionSelectorIndexProbes(selected: number): number {
  return selected === 0 ? 1 : 1;
}

export function retentionIndexProbes(selected: number): number {
  return retentionSelectorIndexProbes(selected) + retentionDeleteIndexProbes(selected);
}

export function retentionBatchWork(
  selected: number,
  inventory: WorkflowRetentionPayloadInventory,
): WorkflowRetentionBatchWork {
  const payloadRows = retentionPayloadRows(inventory);
  const cascadeRows = retentionCascadeRows(inventory);
  const deletionRows = selected === 0 ? 0 : retentionDeletionRows(inventory);
  const applicationStatements = retentionApplicationStatementCount(selected);
  const controlStatements = retentionControlStatementCount(selected);
  return {
    selected,
    statements: applicationStatements + controlStatements,
    applicationStatements,
    controlStatements,
    selectStatements: WORKFLOW_RETENTION_SELECT_STATEMENTS,
    deleteStatements: selected === 0 ? 0 : WORKFLOW_RETENTION_DELETE_STATEMENTS,
    payloadRows,
    cascadeRows,
    deletionRows,
    examinedRows: selected + deletionRows,
  };
}

export function retentionCompleteBatchWork(
  selected: number,
  inventory: WorkflowRetentionPayloadInventory,
  bytes: WorkflowRetentionByteInventory = emptyInventory,
  fenceRows = selected,
): WorkflowRetentionCompleteWork {
  const batch = retentionBatchWork(selected, inventory);
  const nestedFkStatements = selected === 0 ? 0 : retentionNestedFkStatements(selected, inventory);
  const payloadByteTotal = selected === 0 ? 0 : retentionPayloadBytes(bytes);
  const rollbackStatements = selected === 0 ? 0 : WORKFLOW_RETENTION_ROLLBACK_STATEMENTS;
  return {
    ...batch,
    nestedFkStatements,
    nestedFkPoints: selected === 0 ? 0 : WORKFLOW_RETENTION_STATUS_DELETE_POINTS,
    statusDeleteStatements: selected === 0 ? 0 : WORKFLOW_RETENTION_STATUS_DELETE_STATEMENTS,
    indexProbes: retentionIndexProbes(selected),
    payloadBytes: payloadByteTotal,
    fenceRows: selected === 0 ? 0 : fenceRows,
    rollbackStatements,
    replayApplicationStatements: batch.applicationStatements,
    replayControlStatements: batch.controlStatements,
    familyRows: inventory,
    familyBytes: bytes,
  };
}

export function retentionInterruptedBatchWork(
  selected: number,
  inventory: WorkflowRetentionPayloadInventory,
  bytes: WorkflowRetentionByteInventory = emptyInventory,
  acknowledged: boolean,
): WorkflowRetentionCompleteWork {
  const work = retentionCompleteBatchWork(selected, inventory, bytes);
  if (acknowledged) return work;
  return {
    ...work,
    controlStatements: work.controlStatements,
    rollbackStatements: work.rollbackStatements,
    replayApplicationStatements: work.applicationStatements,
    replayControlStatements: work.controlStatements,
  };
}

export function retentionReplayBatchWork(
  first: WorkflowRetentionCompleteWork,
  retry: WorkflowRetentionCompleteWork,
): WorkflowRetentionCompleteSweepWork {
  return {
    batches: 2,
    lastBatchSize: retry.selected,
    selected: first.selected + retry.selected,
    statements: first.statements + retry.statements,
    applicationStatements: first.applicationStatements + retry.applicationStatements,
    controlStatements: first.controlStatements + retry.controlStatements,
    payloadRows: first.payloadRows + retry.payloadRows,
    cascadeRows: first.cascadeRows + retry.cascadeRows,
    deletionRows: first.deletionRows + retry.deletionRows,
    examinedRows: first.examinedRows + retry.examinedRows,
    nestedFkStatements: first.nestedFkStatements + retry.nestedFkStatements,
    indexProbes: first.indexProbes + retry.indexProbes,
    payloadBytes: first.payloadBytes + retry.payloadBytes,
    fenceRows: Math.max(first.fenceRows, retry.fenceRows),
    rollbackStatements: first.rollbackStatements + retry.rollbackStatements,
    replayApplicationStatements: retry.applicationStatements,
    replayControlStatements: retry.controlStatements,
  };
}

export function retentionSweepWork(
  batchSizes: readonly number[],
  inventories: readonly WorkflowRetentionPayloadInventory[],
): WorkflowRetentionSweepWork {
  const batches = batchSizes.length;
  const lastBatchSize = batchSizes.at(-1) ?? 0;
  let selected = 0;
  let payloadRows = 0;
  let cascadeRows = 0;
  let deletionRows = 0;
  let examinedRows = 0;
  let statements = 0;
  let applicationStatements = 0;
  let controlStatements = 0;
  for (const [index, size] of batchSizes.entries()) {
    const work = retentionBatchWork(size, inventories[index] ?? emptyInventory);
    selected += work.selected;
    payloadRows += work.payloadRows;
    cascadeRows += work.cascadeRows;
    deletionRows += work.deletionRows;
    examinedRows += work.examinedRows;
    statements += work.statements;
    applicationStatements += work.applicationStatements;
    controlStatements += work.controlStatements;
  }
  return {
    batches,
    lastBatchSize,
    selected,
    statements,
    applicationStatements,
    controlStatements,
    payloadRows,
    cascadeRows,
    deletionRows,
    examinedRows,
  };
}

export function retentionCompleteSweepWork(
  batchSizes: readonly number[],
  inventories: readonly WorkflowRetentionPayloadInventory[],
  bytes: readonly WorkflowRetentionByteInventory[] = [],
  fenceRows: readonly number[] = [],
): WorkflowRetentionCompleteSweepWork {
  const sweep = retentionSweepWork(batchSizes, inventories);
  let nestedFkStatements = 0;
  let indexProbes = 0;
  let payloadBytes = 0;
  let fences = 0;
  let rollbackStatements = 0;
  let replayApplicationStatements = 0;
  let replayControlStatements = 0;
  for (const [index, size] of batchSizes.entries()) {
    const work = retentionCompleteBatchWork(
      size,
      inventories[index] ?? emptyInventory,
      bytes[index] ?? emptyInventory,
      fenceRows[index] ?? size,
    );
    nestedFkStatements += work.nestedFkStatements;
    indexProbes += work.indexProbes;
    payloadBytes += work.payloadBytes;
    fences += work.fenceRows;
    rollbackStatements += work.rollbackStatements;
    replayApplicationStatements += work.replayApplicationStatements;
    replayControlStatements += work.replayControlStatements;
  }
  return {
    ...sweep,
    nestedFkStatements,
    indexProbes,
    payloadBytes,
    fenceRows: fences,
    rollbackStatements,
    replayApplicationStatements,
    replayControlStatements,
  };
}

export function retentionSelectionBinds(
  now: Date,
  retentionDays: number,
  applicationName: string,
  limit = WORKFLOW_RETENTION_BATCH_SIZE,
): WorkflowRetentionSelection {
  return {
    applicationName,
    statuses: TERMINAL_WORKFLOW_STATUSES,
    completedBefore: retentionCutoff(now, retentionDays),
    limit,
  };
}

export function freezeWorkflowRetentionStart(
  retentionDays: number,
  now: number,
  applicationName: string,
): WorkflowRetentionStart {
  assertRetentionDays(retentionDays);
  return { retentionDays, now, applicationName };
}

export function classifyRetentionStatement(sql: string): WorkflowRetentionStatementKind {
  const text = sql.trim();
  if (text.includes(WORKFLOW_RETENTION_SELECT_TAG) || /ORDER BY completed_at,\s*workflow_uuid/i.test(text))
    return 'select';
  if (/^BEGIN\b/i.test(text)) return 'begin';
  if (/^COMMIT\b/i.test(text)) return 'commit';
  if (/^ROLLBACK\b/i.test(text)) return 'rollback';
  const deleted = /DELETE\s+FROM\s+(?:ONLY\s+)?(?:"?dbos"?\.)?"?([a-z_]+)"?/i.exec(text)?.[1];
  if (deleted === 'workflow_input') return 'delete-workflow_input';
  if (deleted === 'workflow_output') return 'delete-workflow_output';
  if (deleted === 'operation_outputs') return 'delete-operation_outputs';
  if (deleted === 'workflow_status') return 'delete-workflow_status';
  if (deleted === 'workflow_events') return 'cascade-workflow_events';
  if (deleted === 'workflow_events_history') return 'cascade-workflow_events_history';
  if (deleted === 'notifications') return 'cascade-notifications';
  if (deleted === 'streams') return 'cascade-streams';
  return 'other';
}

export function retentionDeleteTableFor(kind: WorkflowRetentionStatementKind): string | undefined {
  switch (kind) {
    case 'delete-workflow_input':
      return 'workflow_input';
    case 'delete-workflow_output':
      return 'workflow_output';
    case 'delete-operation_outputs':
      return 'operation_outputs';
    case 'delete-workflow_status':
      return 'workflow_status';
    case 'cascade-workflow_events':
      return 'workflow_events';
    case 'cascade-workflow_events_history':
      return 'workflow_events_history';
    case 'cascade-notifications':
      return 'notifications';
    case 'cascade-streams':
      return 'streams';
    default:
      return undefined;
  }
}

export function isRetentionForegroundDelete(kind: WorkflowRetentionStatementKind): boolean {
  return kind.startsWith('delete-');
}

export function isRetentionCascadeDelete(kind: WorkflowRetentionStatementKind): boolean {
  return kind.startsWith('cascade-');
}

export function retentionFamilyDeletion(table: WorkflowRetentionPayloadFamily): 'explicit' | 'cascade' {
  return WORKFLOW_RETENTION_EXPLICIT_DELETE_TABLES.includes(
    table as (typeof WORKFLOW_RETENTION_EXPLICIT_DELETE_TABLES)[number],
  )
    ? 'explicit'
    : 'cascade';
}

export function retentionAdmittedFanout(fanout: WorkflowRetentionFanout): WorkflowRetentionFanout {
  return {
    operations: admitRetentionFamilyCopies('operation_outputs', fanout.operations ?? 1),
    events: admitRetentionFamilyCopies('workflow_events', fanout.events ?? 1),
    history: admitRetentionFamilyCopies('workflow_events_history', fanout.history ?? 1),
    notifications: admitRetentionFamilyCopies('notifications', fanout.notifications ?? 1),
    streams: admitRetentionFamilyCopies('streams', fanout.streams ?? 1),
    input: admitRetentionFamilyCopies('workflow_input', fanout.input ?? 1),
    output: admitRetentionFamilyCopies('workflow_output', fanout.output ?? 1),
  };
}

export function retentionPayloadFanoutInventory(
  selected: number,
  fanout: WorkflowRetentionFanout,
): WorkflowRetentionPayloadInventory {
  const admitted = retentionAdmittedFanout(fanout);
  return workflowRetentionInventory({
    workflow_status: selected,
    workflow_input: selected * (admitted.input ?? 1),
    workflow_output: selected * (admitted.output ?? 1),
    operation_outputs: selected * (admitted.operations ?? 1),
    workflow_events: selected * (admitted.events ?? 1),
    workflow_events_history: selected * (admitted.history ?? 1),
    notifications: selected * (admitted.notifications ?? 1),
    streams: selected * (admitted.streams ?? 1),
  });
}

export function retentionPayloadByteInventory(
  selected: number,
  fanout: WorkflowRetentionFanout,
  bytesPerCopy: number,
  metadataBytes = 0,
): WorkflowRetentionByteInventory {
  const rows = retentionPayloadFanoutInventory(selected, fanout);
  const payload = admitRetentionPayloadBytes(bytesPerCopy);
  const metadata = admitRetentionMetadataBytes(metadataBytes);
  return workflowRetentionBytes({
    workflow_status: rows.workflow_status * metadata,
    workflow_input: rows.workflow_input * payload,
    workflow_output: rows.workflow_output * payload,
    operation_outputs: rows.operation_outputs * payload,
    workflow_events: rows.workflow_events * payload,
    workflow_events_history: rows.workflow_events_history * payload,
    notifications: rows.notifications * payload,
    streams: rows.streams * payload,
  });
}

export function retentionUnitFanout(): WorkflowRetentionFanout {
  return {
    operations: 1,
    events: 1,
    history: 1,
    notifications: 1,
    streams: 1,
    input: 1,
    output: 1,
  };
}

export function retentionFamilyFanout(
  family: (typeof WORKFLOW_RETENTION_VARIABLE_FAMILIES)[number],
  copies: number,
): WorkflowRetentionFanout {
  const unit = retentionUnitFanout();
  switch (family) {
    case 'operation_outputs':
      return { ...unit, operations: copies };
    case 'workflow_events':
      return { ...unit, events: copies };
    case 'workflow_events_history':
      return { ...unit, history: copies };
    case 'notifications':
      return { ...unit, notifications: copies };
    case 'streams':
      return { ...unit, streams: copies };
  }
}

export function retentionMixedNeighbourhoodFanout(): WorkflowRetentionFanout {
  return {
    operations: WORKFLOW_RETENTION_FAMILY_LIMITS.operation_outputs,
    events: WORKFLOW_RETENTION_FAMILY_LIMITS.workflow_events,
    history: WORKFLOW_RETENTION_FAMILY_LIMITS.workflow_events_history,
    notifications: WORKFLOW_RETENTION_FAMILY_LIMITS.notifications,
    streams: WORKFLOW_RETENTION_FAMILY_LIMITS.streams,
    input: 1,
    output: 1,
  };
}

export function retentionExecutionRowBudget(inventory: WorkflowRetentionPayloadInventory): number {
  return (
    inventory.workflow_status +
    inventory.workflow_input +
    inventory.workflow_output +
    inventory.operation_outputs +
    inventory.workflow_events +
    inventory.workflow_events_history
  );
}

export function retentionExecutionWithinBudget(
  inventory: WorkflowRetentionPayloadInventory,
  bytes: WorkflowRetentionByteInventory,
): boolean {
  return (
    retentionExecutionRowBudget(inventory) <=
      WORKFLOW_RETENTION_FAMILY_LIMITS.workflow_status +
        WORKFLOW_RETENTION_FAMILY_LIMITS.workflow_input +
        WORKFLOW_RETENTION_FAMILY_LIMITS.workflow_output +
        WORKFLOW_RETENTION_FAMILY_LIMITS.operation_outputs +
        WORKFLOW_RETENTION_FAMILY_LIMITS.workflow_events +
        WORKFLOW_RETENTION_FAMILY_LIMITS.workflow_events_history &&
    retentionPayloadBytes(bytes) <= WORKFLOW_RETENTION_EXECUTION_BYTES
  );
}

export function inventoriesMatch(
  actual: WorkflowRetentionPayloadInventory,
  expected: WorkflowRetentionPayloadInventory,
): boolean {
  for (const family of WORKFLOW_RETENTION_PAYLOAD_FAMILIES) {
    if (actual[family.table] !== expected[family.table]) return false;
  }
  return true;
}

export {
  WORKFLOW_RETENTION_BATCH_ATTEMPTS,
  WORKFLOW_RETENTION_BATCH_SIZE,
  WORKFLOW_RETENTION_CASCADE_TABLES,
  WORKFLOW_RETENTION_EXPLICIT_DELETE_TABLES,
  WORKFLOW_RETENTION_FAMILY_LIMITS,
  WORKFLOW_RETENTION_MAX_BATCHES,
  WORKFLOW_RETENTION_NESTED_FK_STATEMENTS,
  WORKFLOW_RETENTION_PAYLOAD_BYTES,
  WORKFLOW_RETENTION_PAYLOAD_FAMILIES,
  WORKFLOW_RETENTION_PLANNER_FLOOR,
  WORKFLOW_RETENTION_ROLLBACK_STATEMENTS,
  WORKFLOW_RETENTION_SINGLE_COPY_FAMILIES,
  WORKFLOW_RETENTION_STATUS_DELETE_POINTS,
  WORKFLOW_RETENTION_STATUS_DELETE_STATEMENTS,
  WORKFLOW_RETENTION_VARIABLE_FAMILIES,
} from '../contract/bounds.ts';
