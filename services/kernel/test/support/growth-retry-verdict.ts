import { isControlStatement, type Cost } from './growth-cost.ts';
import type { ByteMetric, GrowthMetric } from './growth-bound.ts';
import type { StatementOccurrence, StatementOccurrences } from './growth-report.ts';

type AttemptLedgerEntry = Readonly<{
  backend: number;
  outcome: string;
  occurrences: readonly number[];
}>;

type RetryRun = Readonly<{ ledger: readonly AttemptLedgerEntry[] }>;

export type RetryEvidenceSample = Readonly<{
  scale: number;
  cost: Pick<Cost, 'statements' | 'rows' | 'blocks' | 'catalogStatements' | 'failedStatements'>;
  repetitions: readonly Pick<Cost, 'statements' | 'rows' | 'blocks' | 'catalogStatements' | 'failedStatements'>[];
  occurrenceRepetitions: readonly StatementOccurrences[];
  attempts?: Readonly<{ repetitions: readonly RetryRun[] }>;
}>;

export type SuccessfulMetricEvidence = Readonly<{
  values?: readonly (readonly number[])[];
  explanation?: string;
}>;

export function isSuccessfulForegroundOccurrence(
  occurrence: Pick<StatementOccurrence, 'index' | 'backend' | 'error'>,
  ledger: readonly AttemptLedgerEntry[] = [],
): boolean {
  if (occurrence.error !== null) return false;
  const attempt = ledger.find(
    ({ backend, occurrences }) => backend === occurrence.backend && occurrences.includes(occurrence.index),
  );
  return attempt === undefined || attempt.outcome === 'committed';
}

export function retryAffectsOccurrence(
  occurrence: Pick<StatementOccurrence, 'index' | 'backend' | 'error'>,
  ledger: readonly AttemptLedgerEntry[] = [],
): boolean {
  if (occurrence.error?.code === '40001' || occurrence.error?.code === '40P01') return true;
  return ledger.some(
    ({ backend, outcome, occurrences }) =>
      backend === occurrence.backend &&
      occurrences.includes(occurrence.index) &&
      (outcome === 'aborted:40001' || outcome === 'aborted:40P01'),
  );
}

export function successfulMetricEvidence(
  samples: readonly RetryEvidenceSample[],
  metric: GrowthMetric | ByteMetric,
): SuccessfulMetricEvidence {
  if (metric !== 'rows' && metric !== 'blocks' && metric !== 'statements')
    return { explanation: `per-occurrence ${metric} evidence is not retained in growth captures` };

  const values: number[][] = [];
  for (const sample of samples) {
    if (sample.occurrenceRepetitions.length !== sample.repetitions.length)
      return { explanation: `scale ${sample.scale} has no occurrence record for every measured repetition` };
    if (sample.attempts && sample.attempts.repetitions.length !== sample.repetitions.length)
      return { explanation: `scale ${sample.scale} has no attempt ledger for every measured repetition` };
    const scaleValues: number[] = [];
    for (const [repetition, cost] of sample.repetitions.entries()) {
      const occurrences = sample.occurrenceRepetitions[repetition]!.statements;
      const ledger = sample.attempts?.repetitions[repetition]?.ledger ?? [];
      if (metric === 'statements' && cost.catalogStatements > 0)
        return {
          explanation: `scale ${sample.scale}, repetition ${repetition} has catalog statements that cannot be separated per occurrence`,
        };
      const ledgerOccurrences = new Map<number, AttemptLedgerEntry>();
      for (const attempt of ledger)
        for (const index of attempt.occurrences) {
          const occurrence = occurrences.find((item) => item.index === index);
          if (!occurrence || occurrence.backend !== attempt.backend)
            return {
              explanation: `scale ${sample.scale}, repetition ${repetition} has an attempt occurrence without matching foreground attribution`,
            };
          if (ledgerOccurrences.has(index))
            return {
              explanation: `scale ${sample.scale}, repetition ${repetition} assigns an occurrence to multiple attempts`,
            };
          ledgerOccurrences.set(index, attempt);
        }

      if (
        !sample.attempts &&
        occurrences.some(({ statement }) => /^\s*(?:BEGIN|START\s+TRANSACTION)\b/i.test(statement))
      )
        return {
          explanation: `scale ${sample.scale}, repetition ${repetition} contains a transaction without an attempt ledger`,
        };

      const observedFailures: Record<string, number> = {};
      for (const occurrence of occurrences)
        if (occurrence.error !== null)
          observedFailures[occurrence.error.code] = (observedFailures[occurrence.error.code] ?? 0) + 1;
      const recordedFailures = cost.failedStatements ?? {};
      if (
        [...new Set([...Object.keys(observedFailures), ...Object.keys(recordedFailures)])].some(
          (sqlstate) => observedFailures[sqlstate] !== (recordedFailures[sqlstate] ?? 0),
        )
      )
        return {
          explanation: `scale ${sample.scale}, repetition ${repetition} retry failures cannot be matched to foreground occurrences`,
        };

      const successful = (occurrence: StatementOccurrence): boolean =>
        isSuccessfulForegroundOccurrence(occurrence, ledger);
      if (metric === 'statements') {
        const nonControl = occurrences.filter(({ statement }) => !isControlStatement(statement));
        const observedCount = nonControl.length;
        if (observedCount !== cost.statements + cost.catalogStatements)
          return {
            explanation: `scale ${sample.scale}, repetition ${repetition} statement occurrences do not reconcile with the inclusive count`,
          };
        scaleValues.push(nonControl.filter(successful).length);
      } else {
        const observedTotal = occurrences.reduce((sum, occurrence) => sum + occurrence[metric], 0);
        const inclusive = Math.round(observedTotal);
        if (inclusive !== cost[metric])
          return {
            explanation: `scale ${sample.scale}, repetition ${repetition} ${metric} occurrences do not reconcile with the inclusive total`,
          };
        scaleValues.push(
          Math.round(
            occurrences.reduce((sum, occurrence) => sum + (successful(occurrence) ? occurrence[metric] : 0), 0),
          ),
        );
      }
    }
    values.push(scaleValues);
  }
  return { values };
}

export function retainIndependentRetryViolation(
  successfulOutcome: 'compatible' | 'violation' | 'inconclusive' | undefined,
  explanation: string,
): Readonly<{ outcome: 'violation' }> | Readonly<{ outcome: 'inconclusive'; reason: 'retries'; explanation: string }> {
  return successfulOutcome === 'violation'
    ? { outcome: 'violation' }
    : { outcome: 'inconclusive', reason: 'retries', explanation };
}
