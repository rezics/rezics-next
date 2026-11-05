import type { ConsumptionSummary } from './native';

import { formatJournalDate, type ProgressSessionJournalDate } from '@rezics/progress';

export function reportedDate(value: ProgressSessionJournalDate | null, unknownLabel = 'unknown'): string {
  return value === null ? unknownLabel : formatJournalDate(value);
}

export function privateCount(value: string): string {
  try {
    return new Intl.NumberFormat().format(BigInt(value));
  } catch {
    return value;
  }
}

export function consumptionStatistics(summary: ConsumptionSummary) {
  return {
    scope: summary.scope,
    completedOccurrences: summary.completedOccurrences,
    distinctCompletedSubjects: summary.distinctCompletedSubjects,
    repeatOccurrences: summary.repeatOccurrences,
    completedOccurrencesWithUnknownProfile: summary.completedOccurrencesWithUnknownProfile,
    coverage: summary.coverage,
    currentness: summary.currentness,
  };
}
