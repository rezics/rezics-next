import type { StatementOccurrence } from './growth-report.ts';

export type AttemptLedgerEntry = Readonly<{
  backend: number;
  outcome: string;
  occurrences: readonly number[];
}>;

export type RetryRunAttribution =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: 'missing' | 'duplicate' };

export type RetryRunIndex = Readonly<{
  readonly byIndex: ReadonlyMap<number, StatementOccurrence>;
  readonly attemptByIndex: ReadonlyMap<number, AttemptLedgerEntry>;
  readonly byStatement: ReadonlyMap<string, readonly StatementOccurrence[]>;
  readonly attribution: RetryRunAttribution;
}>;

/** Indexes one measured run's native occurrences, attempt ownership and statement shapes. */
export function indexRetryRun(
  occurrences: readonly StatementOccurrence[],
  ledger: readonly AttemptLedgerEntry[] = [],
): RetryRunIndex {
  const byIndex = new Map<number, StatementOccurrence>();
  const byStatement = new Map<string, StatementOccurrence[]>();
  for (const occurrence of occurrences) {
    if (!byIndex.has(occurrence.index)) byIndex.set(occurrence.index, occurrence);
    const group = byStatement.get(occurrence.statement);
    if (group) group.push(occurrence);
    else byStatement.set(occurrence.statement, [occurrence]);
  }

  const attemptByIndex = new Map<number, AttemptLedgerEntry>();
  let attribution: RetryRunAttribution = { ok: true };
  for (const attempt of ledger)
    for (const index of attempt.occurrences) {
      const occurrence = byIndex.get(index);
      if (!occurrence || occurrence.backend !== attempt.backend) {
        if (attribution.ok) attribution = { ok: false, reason: 'missing' };
        continue;
      }
      if (attemptByIndex.has(index)) {
        if (attribution.ok) attribution = { ok: false, reason: 'duplicate' };
        continue;
      }
      attemptByIndex.set(index, attempt);
    }

  return { byIndex, attemptByIndex, byStatement, attribution };
}

export function isSuccessfulIndexed(
  occurrence: Pick<StatementOccurrence, 'index' | 'backend' | 'error'>,
  index: RetryRunIndex,
): boolean {
  if (occurrence.error !== null) return false;
  const attempt = ownedAttempt(occurrence, index);
  return attempt === undefined || attempt.outcome === 'committed';
}

export function retryAffectsIndexed(
  occurrence: Pick<StatementOccurrence, 'index' | 'backend' | 'error'>,
  index: RetryRunIndex,
): boolean {
  if (occurrence.error?.code === '40001' || occurrence.error?.code === '40P01') return true;
  const attempt = ownedAttempt(occurrence, index);
  return attempt?.outcome === 'aborted:40001' || attempt?.outcome === 'aborted:40P01';
}

function ownedAttempt(
  occurrence: Pick<StatementOccurrence, 'index' | 'backend'>,
  index: RetryRunIndex,
): AttemptLedgerEntry | undefined {
  const attempt = index.attemptByIndex.get(occurrence.index);
  return attempt?.backend === occurrence.backend ? attempt : undefined;
}
