/** Closed Work retry, retention, selected-cost and writer-fence bounds. These allocate no ledger. */
export declare const WORK_EXECUTION_ATTEMPT_BOUND = 3;
export declare const WORK_STEP_RETRY_INTERVAL_SECONDS = 1;
export declare const WORK_STEP_RETRY_BACKOFF_RATE = 2;
export declare const WORK_STEP_RETRY_MAX_ATTEMPTS = 8;
export declare const DEFAULT_WORKFLOW_RETENTION_DAYS = 30;
export declare const MIN_WORKFLOW_RETENTION_DAYS = 7;
export declare const MAX_WORKFLOW_RETENTION_DAYS = 365;
export declare const WORKFLOW_RETENTION_BATCH_SIZE = 1000;
export declare const WORKFLOW_RETENTION_MAX_BATCHES = 60;
export declare const WORKFLOW_RETENTION_WORKFLOW = "kernel.workflowRetention";
export declare const WORKFLOW_RETENTION_SCHEDULE = "kernel.workflowRetention.every-10-minutes";
export declare const WORKFLOW_RETENTION_SCHEDULE_EXPRESSION = "*/10 * * * *";
export declare const TERMINAL_WORKFLOW_STATUSES: readonly ['SUCCESS', 'ERROR', 'CANCELLED', 'MAX_RECOVERY_ATTEMPTS_EXCEEDED'];
export declare const WORKFLOW_RETENTION_SELECTOR_INDEX = "workflow_retention_selector";
export declare const SELECTED_ISSUE_DEADLINE_MS = 5000;
export declare const SELECTED_NATIVE_STATEMENT_LIMIT = 64;
export declare const SELECTED_CONTINUATION_PAYLOAD_MAX_BYTES = 4096;
export declare const SDK_TRANSACTION_FENCE_COST: Readonly<{
    rows: 4;
    points: 2;
    statements: 4;
    bytes: 8192;
    engineWork: 0;
}>;
export declare const SDK_MAINTENANCE_DISPATCH: Readonly<{
    rollback: {
        rows: number;
        points: number;
        statements: number;
        bytes: number;
        engineRequests: number;
    };
    begin: {
        rows: number;
        points: number;
        statements: number;
        bytes: number;
        engineRequests: number;
    };
    settings: {
        rows: number;
        points: number;
        statements: number;
        bytes: number;
        engineRequests: number;
    };
    lock: {
        rows: number;
        points: number;
        statements: number;
        bytes: number;
        engineRequests: number;
    };
    retire: {
        rows: number;
        points: number;
        statements: number;
        bytes: number;
        engineRequests: number;
    };
    commit: {
        rows: number;
        points: number;
        statements: number;
        bytes: number;
        engineRequests: number;
    };
    'delete-workflow_input': {
        rows: number;
        points: number;
        statements: number;
        bytes: number;
        engineRequests: number;
    };
    'delete-workflow_output': {
        rows: number;
        points: number;
        statements: number;
        bytes: number;
        engineRequests: number;
    };
    'delete-operation_outputs': {
        rows: number;
        points: number;
        statements: number;
        bytes: number;
        engineRequests: number;
    };
    'delete-workflow_status': {
        rows: number;
        points: number;
        statements: number;
        bytes: number;
        engineRequests: number;
    };
}>;
export type SdkMaintenanceDispatch = keyof typeof SDK_MAINTENANCE_DISPATCH;
