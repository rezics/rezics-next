/** Closed Work retry, retention, selected-cost and writer-fence bounds. These allocate no ledger. */

export const WORK_EXECUTION_ATTEMPT_BOUND = 3;
export const WORK_STEP_RETRY_INTERVAL_SECONDS = 1;
export const WORK_STEP_RETRY_BACKOFF_RATE = 2;
export const WORK_STEP_RETRY_MAX_ATTEMPTS = 8;

export const DEFAULT_WORKFLOW_RETENTION_DAYS = 30;
export const MIN_WORKFLOW_RETENTION_DAYS = 7;
export const MAX_WORKFLOW_RETENTION_DAYS = 365;
export const WORKFLOW_RETENTION_BATCH_SIZE = 1000;
export const WORKFLOW_RETENTION_MAX_BATCHES = 60;
export const WORKFLOW_RETENTION_WORKFLOW = 'kernel.workflowRetention';
export const WORKFLOW_RETENTION_SCHEDULE = 'kernel.workflowRetention.every-10-minutes';
export const WORKFLOW_RETENTION_SCHEDULE_EXPRESSION = '*/10 * * * *';

export const TERMINAL_WORKFLOW_STATUSES = ['SUCCESS', 'ERROR', 'CANCELLED', 'MAX_RECOVERY_ATTEMPTS_EXCEEDED'] as const;

export const WORKFLOW_RETENTION_SELECTOR_INDEX = 'workflow_retention_selector';
export const WORKFLOW_RETENTION_START_STEP = 'kernel.workflowRetention.start';
export const WORKFLOW_RETENTION_BATCH_STEP = 'kernel.workflowRetention.batch';
export const WORKFLOW_RETENTION_SELECT_TAG = 'work:workflow-retention-select';
export const WORKFLOW_RETENTION_PAYLOAD_TAG = 'work:workflow-retention-payload';
export const WORKFLOW_RETENTION_WRITER_FENCE_TABLE = 'workflow_writer_fences';
export const WORKFLOW_RETENTION_DAY_MS = 86_400_000;
export const WORKFLOW_RETENTION_SELECT_STATEMENTS = 1;
export const WORKFLOW_RETENTION_DELETE_CONTROL_STATEMENTS = 2;
export const WORKFLOW_RETENTION_DELETE_DATA_STATEMENTS = 4;
export const WORKFLOW_RETENTION_DELETE_STATEMENTS = 6;
export const WORKFLOW_RETENTION_NONEMPTY_APPLICATION_STATEMENTS = 5;
export const WORKFLOW_RETENTION_NONEMPTY_BATCH_STATEMENTS = 7;
export const WORKFLOW_RETENTION_EMPTY_BATCH_STATEMENTS = 1;
export const WORKFLOW_RETENTION_BATCH_ATTEMPTS = 3;
export const WORKFLOW_RETENTION_ROLLBACK_STATEMENTS = 1;
export const WORKFLOW_RETENTION_NESTED_FK_STATEMENTS = 4;
export const WORKFLOW_RETENTION_STATUS_DELETE_POINTS = 5;
export const WORKFLOW_RETENTION_STATUS_DELETE_STATEMENTS = 5;
export const WORKFLOW_RETENTION_PAYLOAD_BYTES = 65_536;
export const WORKFLOW_RETENTION_METADATA_BYTES = 4_096;
export const WORKFLOW_RETENTION_EXECUTION_ROWS = 139;
export const WORKFLOW_RETENTION_EXECUTION_BYTES = 10 * 1024 * 1024;
export const WORKFLOW_RETENTION_PLANNER_FLOOR = 32_768;
export const WORKFLOW_RETENTION_BYTE_SCALES = [1_024, 8_192, 65_536] as const;
export const WORKFLOW_RETENTION_COUNT_SCALES = [1, 8, 64] as const;

export const WORKFLOW_RETENTION_EXPLICIT_DELETE_TABLES = [
  'workflow_input',
  'workflow_output',
  'operation_outputs',
  'workflow_status',
] as const;

export const WORKFLOW_RETENTION_CASCADE_TABLES = [
  'workflow_events',
  'workflow_events_history',
  'notifications',
  'streams',
] as const;

export const WORKFLOW_RETENTION_PAYLOAD_FAMILIES = [
  {
    table: 'workflow_status',
    key: 'workflow_uuid',
    deletion: 'explicit',
    copies: 1,
    payload: ['inputs', 'output', 'error'],
  },
  { table: 'workflow_input', key: 'workflow_uuid', deletion: 'explicit', copies: 1, payload: ['inputs'] },
  { table: 'workflow_output', key: 'workflow_uuid', deletion: 'explicit', copies: 1, payload: ['output', 'error'] },
  { table: 'operation_outputs', key: 'workflow_uuid', deletion: 'explicit', copies: 64, payload: ['output', 'error'] },
  { table: 'workflow_events', key: 'workflow_uuid', deletion: 'cascade', copies: 8, payload: ['value'] },
  { table: 'workflow_events_history', key: 'workflow_uuid', deletion: 'cascade', copies: 64, payload: ['value'] },
  { table: 'notifications', key: 'destination_uuid', deletion: 'cascade', copies: 64, payload: ['message'] },
  { table: 'streams', key: 'workflow_uuid', deletion: 'cascade', copies: 64, payload: ['value'] },
] as const;

export const WORKFLOW_RETENTION_FAMILY_LIMITS = Object.freeze({
  workflow_status: 1,
  workflow_input: 1,
  workflow_output: 1,
  operation_outputs: 64,
  workflow_events: 8,
  workflow_events_history: 64,
  notifications: 64,
  streams: 64,
});

export const WORKFLOW_RETENTION_VARIABLE_FAMILIES = [
  'operation_outputs',
  'workflow_events',
  'workflow_events_history',
  'notifications',
  'streams',
] as const;

export const WORKFLOW_RETENTION_SINGLE_COPY_FAMILIES = [
  'workflow_status',
  'workflow_input',
  'workflow_output',
] as const;

export const SELECTED_ISSUE_DEADLINE_MS = 5_000;
export const SELECTED_NATIVE_STATEMENT_LIMIT = 64;
export const SELECTED_CONTINUATION_PAYLOAD_MAX_BYTES = 4096;

export const SDK_TRANSACTION_FENCE_COST = Object.freeze({
  rows: 4,
  points: 2,
  statements: 4,
  bytes: 8192,
  engineWork: 0,
});

export const SDK_MAINTENANCE_DISPATCH = Object.freeze({
  rollback: { rows: 0, points: 0, statements: 1, bytes: 0, engineRequests: 0 },
  begin: { rows: 0, points: 0, statements: 1, bytes: 0, engineRequests: 0 },
  settings: { rows: 1, points: 0, statements: 1, bytes: 128, engineRequests: 0 },
  lock: { rows: 4, points: 2, statements: 4, bytes: 8192, engineRequests: 0 },
  retire: { rows: 8, points: 5, statements: 9, bytes: 32768, engineRequests: 0 },
  commit: { rows: 0, points: 0, statements: 1, bytes: 0, engineRequests: 0 },
  'delete-workflow_input': { rows: 1, points: 1, statements: 1, bytes: 0, engineRequests: 0 },
  'delete-workflow_output': { rows: 1, points: 1, statements: 1, bytes: 0, engineRequests: 0 },
  'delete-operation_outputs': { rows: 64, points: 1, statements: 1, bytes: 0, engineRequests: 0 },
  'delete-workflow_status': { rows: 73, points: 5, statements: 5, bytes: 0, engineRequests: 0 },
});

export type SdkMaintenanceDispatch = keyof typeof SDK_MAINTENANCE_DISPATCH;
