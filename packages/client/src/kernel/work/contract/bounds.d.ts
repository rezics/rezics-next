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
export declare const WORKFLOW_RETENTION_START_STEP = "kernel.workflowRetention.start";
export declare const WORKFLOW_RETENTION_BATCH_STEP = "kernel.workflowRetention.batch";
export declare const WORKFLOW_RETENTION_SELECT_TAG = "work:workflow-retention-select";
export declare const WORKFLOW_RETENTION_PAYLOAD_TAG = "work:workflow-retention-payload";
export declare const WORKFLOW_RETENTION_WRITER_FENCE_TABLE = "workflow_writer_fences";
export declare const WORKFLOW_RETENTION_DAY_MS = 86400000;
export declare const WORKFLOW_RETENTION_SELECT_STATEMENTS = 1;
export declare const WORKFLOW_RETENTION_DELETE_CONTROL_STATEMENTS = 2;
export declare const WORKFLOW_RETENTION_DELETE_DATA_STATEMENTS = 4;
export declare const WORKFLOW_RETENTION_DELETE_STATEMENTS = 6;
export declare const WORKFLOW_RETENTION_NONEMPTY_APPLICATION_STATEMENTS = 5;
export declare const WORKFLOW_RETENTION_NONEMPTY_BATCH_STATEMENTS = 7;
export declare const WORKFLOW_RETENTION_EMPTY_BATCH_STATEMENTS = 1;
export declare const WORKFLOW_RETENTION_BATCH_ATTEMPTS = 3;
export declare const WORKFLOW_RETENTION_EXPLICIT_DELETE_TABLES: readonly ['workflow_input', 'workflow_output', 'operation_outputs', 'workflow_status'];
export declare const WORKFLOW_RETENTION_CASCADE_TABLES: readonly ['workflow_events', 'workflow_events_history', 'notifications', 'streams'];
export declare const WORKFLOW_RETENTION_PAYLOAD_FAMILIES: readonly [{
    readonly table: 'workflow_status';
    readonly key: 'workflow_uuid';
    readonly deletion: 'explicit';
}, {
    readonly table: 'workflow_input';
    readonly key: 'workflow_uuid';
    readonly deletion: 'explicit';
}, {
    readonly table: 'workflow_output';
    readonly key: 'workflow_uuid';
    readonly deletion: 'explicit';
}, {
    readonly table: 'operation_outputs';
    readonly key: 'workflow_uuid';
    readonly deletion: 'explicit';
}, {
    readonly table: 'workflow_events';
    readonly key: 'workflow_uuid';
    readonly deletion: 'cascade';
}, {
    readonly table: 'workflow_events_history';
    readonly key: 'workflow_uuid';
    readonly deletion: 'cascade';
}, {
    readonly table: 'notifications';
    readonly key: 'destination_uuid';
    readonly deletion: 'cascade';
}, {
    readonly table: 'streams';
    readonly key: 'workflow_uuid';
    readonly deletion: 'cascade';
}];
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
