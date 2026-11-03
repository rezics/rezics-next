import type { ConsumptionSummary } from './native';

export function reportedDate(
  value: { year: number; month?: number; day?: number } | null,
  unknownLabel = 'unknown',
): string {
  if (!value) return unknownLabel;
  const year = String(value.year).padStart(4, '0');
  if (value.month === undefined) return year;
  const month = String(value.month).padStart(2, '0');
  if (value.day === undefined) return year + '-' + month;
  return year + '-' + month + '-' + String(value.day).padStart(2, '0');
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
