import type { YearlyGoalSnapshot } from '../src/library/yearly-goal-page';
import type { ReportedYearSummary } from '../src/library/private-diary/native';

function bucket(completedOccurrences: string, repeatOccurrences: string) {
  const zero = completedOccurrences === '0';
  return {
    completedOccurrences,
    distinctCompletedSubjects: zero ? '0' : '1',
    repeatOccurrences,
    completedOccurrencesWithUnknownProfile: '0',
    finishPrecision: {
      year: '0',
      month: zero ? '0' : '1',
      day: zero ? '0' : (BigInt(completedOccurrences) - 1n).toString(),
    },
  };
}

/** Captured native summary shape: repeated finishes, all twelve months and explicit coverage. */
export function nativeYearlyGoalSnapshot(
  year: number,
  target: YearlyGoalSnapshot['target'] = { state: 'none', revision: null },
  progress: 'available' | 'unavailable' = 'available',
  completedOccurrences = '2',
): YearlyGoalSnapshot {
  const repeats = completedOccurrences === '0' ? '0' : (BigInt(completedOccurrences) - 1n).toString();
  const summary: ReportedYearSummary = {
    ...bucket(completedOccurrences, repeats),
    scope: 'retained_native_sessions',
    year,
    calendar: 'gregorian',
    dateSource: 'explicitly_reported_journal_finish',
    months: Array.from({ length: 12 }, (_, index) => ({
      ...bucket(index === 1 ? completedOccurrences : '0', index === 1 ? repeats : '0'),
      month: index + 1,
    })),
    monthUnallocated: bucket('0', '0'),
    coverage: {
      nativeSessions: 'complete',
      initializedSessions: '3',
      retainedSessions: '3',
      completedOccurrencesWithMissingFinish: '0',
      completedOccurrencesWithUnsupportedFinish: '0',
      otherHistory: 'unavailable',
      unitMeaning: 'not_evaluated',
    },
    currentness: { state: 'snapshot', revision: 'summary-generation' },
  };
  return {
    year,
    viewer: {
      state: 'owner',
      actions: {
        editTarget: { allowed: true },
        clearTarget: target.state === 'set' ? { allowed: true } : { allowed: false, reason: 'no_target' },
        navigateYear: { allowed: true },
      },
    },
    target,
    progress:
      progress === 'available'
        ? { state: 'available', summary }
        : { state: 'unavailable', reason: 'summary_unavailable' },
  };
}
