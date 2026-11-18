import type { ConsumptionSummary, ReportedYearSummary } from './native';

import { formatJournalDate, type ProgressSessionJournalDate } from '@rezics/progress';
import { m } from '../../paraglide/messages.js';
import { getLocale, type Locale } from '../../paraglide/runtime.js';

export function reportedDate(value: ProgressSessionJournalDate | null, unknownLabel = 'unknown'): string {
  return value === null ? unknownLabel : formatJournalDate(value);
}

export function privateCount(value: string, locale: string = getLocale()): string {
  try {
    return new Intl.NumberFormat(locale).format(BigInt(value));
  } catch {
    return value;
  }
}

type ReportSummary =
  | Pick<ConsumptionSummary, 'coverage' | 'currentness'>
  | Pick<ReportedYearSummary, 'coverage' | 'currentness'>;
type ReportCounts = Pick<
  ConsumptionSummary,
  'completedOccurrences' | 'distinctCompletedSubjects' | 'repeatOccurrences' | 'completedOccurrencesWithUnknownProfile'
> &
  Partial<Pick<ReportedYearSummary['monthUnallocated'], 'finishPrecision'>>;

/** Shared localized meaning and exact display values for native diary summaries. */
export function reportPresentation(summary: ReportSummary, counts: ReportCounts, locale: Locale) {
  const ownerCoverage =
    'initializedSessions' in summary.coverage
      ? m.library_diary_year_coverage(
          {
            initialized: privateCount(summary.coverage.initializedSessions, locale),
            retained: privateCount(summary.coverage.retainedSessions, locale),
            missing: privateCount(summary.coverage.completedOccurrencesWithMissingFinish, locale),
            unsupported: privateCount(summary.coverage.completedOccurrencesWithUnsupportedFinish, locale),
          },
          { locale },
        )
      : null;

  return {
    counts: {
      completed: {
        label: m.library_diary_completed({}, { locale }),
        value: privateCount(counts.completedOccurrences, locale),
      },
      distinct: {
        label: m.library_diary_distinct_subjects({}, { locale }),
        value: privateCount(counts.distinctCompletedSubjects, locale),
      },
      repeats: {
        label: m.library_diary_repeats({}, { locale }),
        value: privateCount(counts.repeatOccurrences, locale),
      },
    },
    coverageMeaning: m.library_insights_native_only({}, { locale }),
    unknownProfile: {
      label: m.library_insights_unknown_profile({}, { locale }),
      value: privateCount(counts.completedOccurrencesWithUnknownProfile, locale),
    },
    snapshot: {
      label: m.library_insights_snapshot({}, { locale }),
      revision: summary.currentness.revision,
    },
    coverageScope: m.library_diary_period_coverage_scope({}, { locale }),
    ownerScope: m.library_diary_period_owner_scope({}, { locale }),
    unknownHistory: m.library_diary_period_unknown_history({}, { locale }),
    yearHelp: m.library_diary_year_help({}, { locale }),
    precisionUnavailable: m.library_diary_period_precision_unavailable({}, { locale }),
    finishPrecision: counts.finishPrecision
      ? {
          label: m.library_diary_year_precision({}, { locale }),
          value: m.library_diary_year_precision_counts(
            {
              year: privateCount(counts.finishPrecision.year, locale),
              month: privateCount(counts.finishPrecision.month, locale),
              day: privateCount(counts.finishPrecision.day, locale),
            },
            { locale },
          ),
        }
      : null,
    ownerCoverage,
  };
}

export type ReportPresentation = ReturnType<typeof reportPresentation>;

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
