import type { Pool } from 'pg';

export interface SqlExecution {
  readonly statement: string;
  readonly parameters: readonly unknown[];
  /** PostgreSQL backend PID for the connection that executed the statement. */
  readonly connectionId: number;
  /** Timestamp recorded at the actual query boundary. */
  readonly executedAt: string;
}

export interface SqlMatch {
  /** Exact statement text observed at the driver boundary. */
  readonly statement: string;
  /** One-based matching execution to select; defaults to the next matching execution. */
  readonly occurrence?: number;
}

export type SqlBoundary = 'before' | 'after';

export interface SqlFaultHook {
  readonly match: SqlMatch;
  readonly boundary: SqlBoundary;
  readonly error: Error;
}

export interface SqlBarrier {
  readonly match: SqlMatch;
  readonly boundary: SqlBoundary;
  /** Resolves when the real query reaches the selected boundary. */
  readonly entered: Promise<SqlExecution>;
  /** Releases the query after entered resolves. */
  release(): void;
}

export interface SqlObserver {
  /** Executed statements and bound parameters in observed order. */
  readonly records: readonly SqlExecution[];
  /** Install a one-shot failure at an actual query boundary. */
  armFault(hook: SqlFaultHook): void;
  /** Pause a real query at a selected boundary for deterministic coordination. */
  hold(match: SqlMatch, boundary: SqlBoundary): SqlBarrier;
  close(): Promise<void>;
}

/** The implementation is intentionally pending; this port performs no query. */
export function observeSql(_pool: Pool): SqlObserver {
  throw new Error('observeSql is not implemented');
}
