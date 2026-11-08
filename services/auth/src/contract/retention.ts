import type { AuthSdkRetirementDispatch } from './sdk-retirement.ts';

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
export const WORKFLOW_RETENTION_BATCH_SIZE = 1000;
export const WORKFLOW_RETENTION_MAX_BATCHES = 60;
/** One whole page/drain lifetime, never renewed per copy. */
export const WORKFLOW_RETENTION_DEADLINE_MS = 60_000;
export const DAY_MS = 24 * 60 * 60 * 1000;
export const TERMINAL_WORKFLOW_STATUSES = ['SUCCESS', 'ERROR', 'CANCELLED', 'MAX_RECOVERY_ATTEMPTS_EXCEEDED'] as const;

export type RetainedWorkflowCopy = Readonly<{ workflowID: string; workflowName: string }>;
export type WorkflowRetentionCandidate = Readonly<{ id: string; eligible: boolean; technical: boolean }>;
export type WorkflowRetentionConfig = Readonly<{ retentionDays: number }>;

/** Local phases include the complete reached native neighbourhood, including rejected custody. */
export type AuthRetentionPhase =
  | 'preparation'
  | 'initialization'
  | 'examination'
  | 'consumer'
  | 'closure-recorder'
  | 'deletion-custody'
  | 'custody'
  | 'receipt'
  | 'fence-read'
  | 'state-read'
  | 'absence'
  | 'absent-write';
export type AuthRetentionWork = Readonly<{
  rows: number;
  points: number;
  statements: number;
  bytes: number;
  engineRequests: number;
}>;
export type AuthRetentionFailedDispatch = Readonly<{ attempt: number; dispatch: string }>;
export type AuthRetentionClosureWork = Readonly<{
  workflowID: string;
  attempts: number;
  failedWork: readonly AuthRetentionFailedDispatch[];
  failed: boolean;
}>;
export type AuthRetentionSnapshot = Readonly<{
  pages: number;
  examined: number;
  copies: number;
  technical: number;
  reserved: AuthRetentionWork;
  dispatches: Readonly<Record<string, number>>;
  closures: readonly AuthRetentionClosureWork[];
}>;

/** One caller lifetime. Reservations are irrevocable, including failed calls and
 * outer replay. This is accounting, never authority to retire a personal copy. */
export interface AuthRetentionInvocation {
  readonly deadline: number;
  readonly maxAttempts: number;
  readonly signal?: AbortSignal;
  check(): void;
  page(): void;
  examined(rawKeys: number): void;
  copy(technical: boolean): void;
  charge(phase: AuthRetentionPhase): Promise<void>;
  reserve(dispatch: AuthSdkRetirementDispatch): Promise<void>;
  reserveDelete(dispatch: string): Promise<void>;
  record(work: AuthRetentionClosureWork): void;
  snapshot(): AuthRetentionSnapshot;
}
export type WorkflowCopyRetirement = (id: string, invocation: AuthRetentionInvocation) => Promise<boolean>;
export type WorkflowRetentionCounts = Readonly<{ eligible: number; retired: number; pending: number }>;
export type WorkflowRetentionPage = WorkflowRetentionCounts &
  Readonly<{ cutoff: number; examined: number; done: boolean }>;
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
  admit(): void;
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
  deleteTechnical(ids: string[], invocation: AuthRetentionInvocation): Promise<void>;
  now(): number;
}
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
