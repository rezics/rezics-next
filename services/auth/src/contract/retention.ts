export const AUTH_WORKFLOW_APPLICATION = 'rezics-auth-accounts';

export class WorkflowRetentionConfigurationError extends Error {
  override readonly name = 'WorkflowRetentionConfigurationError';
  constructor() {
    super('Invalid Auth host configuration: AUTH_WORKFLOW_RETENTION_DAYS');
  }
}

export const WORKFLOW_RETENTION_WORKFLOW = 'auth.workflowRetention';
export const WORKFLOW_RETENTION_SCHEDULE = 'auth.workflowRetention.every-10-minutes';
export const WORKFLOW_RETENTION_SCHEDULE_EXPRESSION = '*/10 * * * *';
export const DEFAULT_WORKFLOW_RETENTION_DAYS = 30;
export const MIN_WORKFLOW_RETENTION_DAYS = 7;
export const MAX_WORKFLOW_RETENTION_DAYS = 365;
/** Raw keys admitted by the SDK scan, including live copies and pending consumers. */
export const WORKFLOW_RETENTION_BATCH_SIZE = 1000;
export const WORKFLOW_RETENTION_MAX_BATCHES = 60;
export const DAY_MS = 24 * 60 * 60 * 1000;

export const TERMINAL_WORKFLOW_STATUSES = ['SUCCESS', 'ERROR', 'CANCELLED', 'MAX_RECOVERY_ATTEMPTS_EXCEEDED'] as const;

/** Retention sees only identity and classification; the SDK retains raw scan custody. */
export type RetainedWorkflowCopy = Readonly<{ workflowID: string; workflowName: string }>;
export type WorkflowRetentionCandidate = Readonly<{ id: string; eligible: boolean; technical: boolean }>;
export type WorkflowRetentionConfig = Readonly<{ retentionDays: number }>;
export type WorkflowCopyRetirement = (id: string) => Promise<boolean>;
export type WorkflowRetentionCounts = Readonly<{ eligible: number; retired: number; pending: number }>;
/** Counts only: native keys, source custody and SDK payloads never enter step output. */
export type WorkflowRetentionPage = WorkflowRetentionCounts &
  Readonly<{
    cutoff: number;
    examined: number;
    done: boolean;
  }>;

/** Cursor is the producer's opaque continuation, persisted without reinterpretation. */
export interface WorkflowRetentionCheckpoint<Cursor> {
  lock(): Promise<Cursor | null>;
  save(continuation: Cursor | null): Promise<void>;
}
export interface WorkflowRetentionSession<Cursor> {
  transaction<T>(run: (checkpoint: WorkflowRetentionCheckpoint<Cursor>) => Promise<T>): Promise<T>;
}
export interface WorkflowRetentionStore<Cursor> {
  withSession<T>(run: (session: WorkflowRetentionSession<Cursor>) => Promise<T>): Promise<T>;
}
export interface WorkflowRetentionScan<Cursor> {
  /** Refuse an unavailable producer before checking out the control-row connection. */
  admit(): void;
  /** Null means an empty captured horizon, never unavailable evidence. */
  open(createdBefore: number): Promise<Cursor | null>;
  read(
    continuation: Cursor,
    rawLimit: number,
  ): Promise<
    Readonly<{
      cutoff: number;
      examined: number;
      copies: readonly RetainedWorkflowCopy[];
      continuation: Cursor | null;
      exhausted: boolean;
    }>
  >;
}
export interface WorkflowRetentionPorts<Cursor> {
  store: WorkflowRetentionStore<Cursor>;
  scan: WorkflowRetentionScan<Cursor>;
  retireCopy: WorkflowCopyRetirement;
  deleteTechnical(ids: string[]): Promise<void>;
  now(): number;
}

/** Native request store is supplied in the caller's existing copy transaction. */
export interface NativeRequestRetentionPorts {
  lock(workflowId: string): Promise<
    | Readonly<{
        request_party_version: number;
        request_context_version: number;
      }>
    | undefined
  >;
  terminal(workflowId: string): Promise<boolean>;
  remove(workflowId: string): Promise<void>;
}
