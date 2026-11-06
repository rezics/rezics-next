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
