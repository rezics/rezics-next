import {
  capture,
  costOf,
  readAttemptLedger,
  type AttemptRecord,
  type Capture,
  type Cost,
  type GrowthDatabase,
  type StatementAttribution,
} from '../../support/growth.ts';
import {
  statementAttributions,
  statementOccurrences,
  type StatementOccurrences,
} from '../../support/growth-report.ts';

export type TransactionGrowthPhase = 'settlement' | 'royalty';

export type TransactionGrowthFrame = {
  readonly attemptId: string;
  readonly phase: TransactionGrowthPhase;
  readonly scale: number;
  readonly repetition: number;
};

export type TransactionGrowthOutcome<T> =
  | { readonly kind: 'completed'; readonly value: T }
  | { readonly kind: 'failed'; readonly name: string; readonly message: string };

export type TransactionGrowthObservation<T = unknown> = {
  readonly frame: TransactionGrowthFrame;
  readonly outcome: TransactionGrowthOutcome<T>;
  readonly capture: Capture;
  readonly cost: Cost;
  readonly statementAttributions: readonly StatementAttribution[];
  readonly occurrences: StatementOccurrences;
  readonly attempts?: readonly AttemptRecord[];
  readonly attemptLedgerError?: string;
};

/** Keep each command frame intact while the shared harness captures its plans and backend attribution. */
export async function observeTransactionGrowth<T>(
  database: GrowthDatabase,
  frame: TransactionGrowthFrame,
  operation: () => Promise<T>,
): Promise<TransactionGrowthObservation<T>> {
  const measured = await capture(
    database,
    async (): Promise<TransactionGrowthOutcome<T>> => {
      try {
        return { kind: 'completed', value: await operation() };
      } catch (error) {
        return {
          kind: 'failed',
          name: error instanceof Error ? error.name : 'UnknownError',
          message: error instanceof Error ? error.message : String(error),
        };
      }
    },
    { includeBackends: true },
  );
  const captured = measured.capture;
  let attempts: readonly AttemptRecord[] | undefined;
  let attemptLedgerError: string | undefined;
  try {
    attempts = readAttemptLedger(captured);
  } catch (error) {
    attemptLedgerError = error instanceof Error ? error.message : String(error);
  }
  return {
    frame,
    outcome: measured.value,
    capture: captured,
    cost: costOf(captured),
    statementAttributions: statementAttributions(captured),
    occurrences: statementOccurrences(captured),
    ...(attempts === undefined ? {} : { attempts }),
    ...(attemptLedgerError === undefined ? {} : { attemptLedgerError }),
  };
}
