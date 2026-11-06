import {
  DEFAULT_WORKFLOW_RETENTION_DAYS,
  MAX_WORKFLOW_RETENTION_DAYS,
  MIN_WORKFLOW_RETENTION_DAYS,
  TERMINAL_WORKFLOW_STATUSES,
  WORKFLOW_RETENTION_BATCH_SIZE,
  WORKFLOW_RETENTION_CASCADE_TABLES,
  WORKFLOW_RETENTION_DAY_MS,
  WORKFLOW_RETENTION_DELETE_STATEMENTS,
  WORKFLOW_RETENTION_EMPTY_BATCH_STATEMENTS,
  WORKFLOW_RETENTION_EXPLICIT_DELETE_TABLES,
  WORKFLOW_RETENTION_MAX_BATCHES,
  WORKFLOW_RETENTION_NONEMPTY_BATCH_STATEMENTS,
  WORKFLOW_RETENTION_PAYLOAD_FAMILIES,
  WORKFLOW_RETENTION_SELECT_STATEMENTS,
  WORKFLOW_RETENTION_SELECT_TAG,
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
export type WorkflowRetentionStatementKind =
  | 'select'
  | 'begin'
  | 'commit'
  | 'rollback'
  | 'delete-workflow_input'
  | 'delete-workflow_output'
  | 'delete-operation_outputs'
  | 'delete-workflow_status'
  | 'other';
export type WorkflowRetentionBatchWork = Readonly<{
  selected: number;
  statements: number;
  selectStatements: number;
  deleteStatements: number;
  payloadRows: number;
  cascadeRows: number;
  deletionRows: number;
  examinedRows: number;
}>;
export type WorkflowRetentionSweepWork = Readonly<{
  batches: number;
  lastBatchSize: number;
  selected: number;
  statements: number;
  payloadRows: number;
  cascadeRows: number;
  deletionRows: number;
  examinedRows: number;
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
  return (
    inventory.workflow_events +
    inventory.workflow_events_history +
    inventory.notifications +
    inventory.streams
  );
}

export function retentionExplicitDeleteRows(inventory: WorkflowRetentionPayloadInventory): number {
  return (
    inventory.workflow_input + inventory.workflow_output + inventory.operation_outputs + inventory.workflow_status
  );
}

export function retentionDeletionRows(inventory: WorkflowRetentionPayloadInventory): number {
  return retentionExplicitDeleteRows(inventory) + retentionCascadeRows(inventory);
}

export function retentionOwnedRows(inventory: WorkflowRetentionPayloadInventory): number {
  return retentionDeletionRows(inventory);
}

export function retentionBatchStatementCount(selected: number): number {
  return selected === 0 ? WORKFLOW_RETENTION_EMPTY_BATCH_STATEMENTS : WORKFLOW_RETENTION_NONEMPTY_BATCH_STATEMENTS;
}

export function retentionSweepStatementCount(fullBatches: number, lastBatchSize: number): number {
  return fullBatches * WORKFLOW_RETENTION_NONEMPTY_BATCH_STATEMENTS + retentionBatchStatementCount(lastBatchSize);
}

export function retentionBatchWork(
  selected: number,
  inventory: WorkflowRetentionPayloadInventory,
): WorkflowRetentionBatchWork {
  const payloadRows = retentionPayloadRows(inventory);
  const cascadeRows = retentionCascadeRows(inventory);
  const deletionRows = selected === 0 ? 0 : retentionDeletionRows(inventory);
  return {
    selected,
    statements: retentionBatchStatementCount(selected),
    selectStatements: WORKFLOW_RETENTION_SELECT_STATEMENTS,
    deleteStatements: selected === 0 ? 0 : WORKFLOW_RETENTION_DELETE_STATEMENTS,
    payloadRows,
    cascadeRows,
    deletionRows,
    examinedRows: selected + deletionRows,
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
  for (const [index, size] of batchSizes.entries()) {
    const work = retentionBatchWork(size, inventories[index] ?? emptyInventory);
    selected += work.selected;
    payloadRows += work.payloadRows;
    cascadeRows += work.cascadeRows;
    deletionRows += work.deletionRows;
    examinedRows += work.examinedRows;
    statements += work.statements;
  }
  return {
    batches,
    lastBatchSize,
    selected,
    statements,
    payloadRows,
    cascadeRows,
    deletionRows,
    examinedRows,
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
  const deleted = /DELETE\s+FROM\s+"?dbos"?\."?([a-z_]+)"?/i.exec(text)?.[1];
  if (deleted === 'workflow_input') return 'delete-workflow_input';
  if (deleted === 'workflow_output') return 'delete-workflow_output';
  if (deleted === 'operation_outputs') return 'delete-operation_outputs';
  if (deleted === 'workflow_status') return 'delete-workflow_status';
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
    default:
      return undefined;
  }
}

export function isRetentionForegroundDelete(kind: WorkflowRetentionStatementKind): boolean {
  return kind.startsWith('delete-');
}

export function retentionFamilyDeletion(table: WorkflowRetentionPayloadFamily): 'explicit' | 'cascade' {
  return WORKFLOW_RETENTION_EXPLICIT_DELETE_TABLES.includes(
    table as (typeof WORKFLOW_RETENTION_EXPLICIT_DELETE_TABLES)[number],
  )
    ? 'explicit'
    : 'cascade';
}

export function retentionPayloadFanoutInventory(
  selected: number,
  fanout: Readonly<{
    operations?: number;
    events?: number;
    history?: number;
    notifications?: number;
    streams?: number;
    input?: number;
    output?: number;
  }>,
): WorkflowRetentionPayloadInventory {
  return workflowRetentionInventory({
    workflow_status: selected,
    workflow_input: selected * (fanout.input ?? 1),
    workflow_output: selected * (fanout.output ?? 1),
    operation_outputs: selected * (fanout.operations ?? 1),
    workflow_events: selected * (fanout.events ?? 1),
    workflow_events_history: selected * (fanout.history ?? 1),
    notifications: selected * (fanout.notifications ?? 1),
    streams: selected * (fanout.streams ?? 1),
  });
}

export {
  WORKFLOW_RETENTION_BATCH_SIZE,
  WORKFLOW_RETENTION_CASCADE_TABLES,
  WORKFLOW_RETENTION_EXPLICIT_DELETE_TABLES,
  WORKFLOW_RETENTION_MAX_BATCHES,
  WORKFLOW_RETENTION_PAYLOAD_FAMILIES,
};
