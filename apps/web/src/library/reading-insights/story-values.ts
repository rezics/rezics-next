import type { PanelValue, ReadingInsightsOverview } from './native';

type AvailableProgress = Extract<PanelValue<'currentProgress'>, { state: 'available' }>;
const profile = {
  provenance: 'profile' as const,
  releaseDigest: `sha256:${'a'.repeat(64)}`,
  profileId: 'reading-text',
  acceptingType: 'text-work',
};
const otherProfile = { ...profile, releaseDigest: `sha256:${'b'.repeat(64)}` };
const completion = (completed = '0', distinct = '0', repeats = '0', unknown = '0') => ({
  completedOccurrences: completed,
  distinctCompletedSubjects: distinct,
  repeatOccurrences: repeats,
  completedOccurrencesWithUnknownProfile: unknown,
});
const yearCounts = (
  completed = '0',
  distinct = '0',
  repeats = '0',
  unknown = '0',
  year = '0',
  month = '0',
  day = '0',
) => ({
  ...completion(completed, distinct, repeats, unknown),
  finishPrecision: { year, month, day },
});
const currentness = <S extends string>(source: S) => ({
  state: 'snapshot' as const,
  source,
  revision:
    source === 'reading_insights_v1'
      ? 'profiles-6'
      : source === 'reading_insights_current_progress_v1'
        ? 'progress-9'
        : 'assessments-3',
  retainedSourceRevision: 'retained-4',
});
const zeroRemainder = {
  groupCount: '0',
  occurrences: '0',
  currentValueCount: '0',
  missingCurrentValueCount: '0',
  totalValueCount: '0',
  missingTotalValueCount: '0',
};
const emptyScope: AvailableProgress['active'] = {
  sessionCount: '0',
  coveredSessions: '0',
  groups: [],
  remainder: zeroRemainder,
};

/** Contract-shaped illustrative responses, not a claim of recorded native acceptance. */
export function readingInsightsExample(year = 2026, zero = false): ReadingInsightsOverview {
  const counts = zero ? completion() : completion('17', '14', '3', '1');
  const progressGroup: AvailableProgress['active']['groups'][number] = {
    meaning: {
      profilePin: profile,
      unitId: 'pages',
      meaningRevision: 1,
      mode: 'scalar_amount',
      unit: 'page',
      dimension: 'count',
      precision: 6,
      minimum: '0',
      maximum: null,
      totalPolicy: 'optional',
      identityKind: 'none',
      structureKind: 'none',
      locator: null,
    },
    occurrences: '2',
    currentValue: '9007199254740993.250000',
    currentValueCount: '1',
    missingCurrentValueCount: '1',
    totalValue: '100.000000',
    totalValueCount: '1',
    missingTotalValueCount: '1',
  };
  return {
    scope: 'private_reading_insights',
    year,
    panels: {
      allTime: {
        status: 'received',
        value: {
          scope: 'retained_native_sessions',
          ...counts,
          coverage: { nativeSessions: 'complete', otherHistory: 'unavailable', unitMeaning: 'not_evaluated' },
          currentness: { state: 'snapshot', revision: 'all-time-4' },
        },
      },
      reportedYear: {
        status: 'received',
        value: {
          scope: 'retained_native_sessions',
          year,
          calendar: 'gregorian',
          dateSource: 'explicitly_reported_journal_finish',
          ...(zero ? yearCounts() : yearCounts('11', '9', '2', '1', '2', '7', '2')),
          months: Array.from({ length: 12 }, (_, index) => ({
            month: index + 1,
            ...(zero
              ? yearCounts()
              : index === 0
                ? yearCounts('2', '1', '1', '0', '0', '0', '2')
                : index === 2
                  ? yearCounts('7', '7', '0', '0', '0', '7', '0')
                  : yearCounts()),
          })),
          monthUnallocated: zero ? yearCounts() : yearCounts('2', '2', '0', '1', '2'),
          coverage: {
            nativeSessions: 'complete',
            initializedSessions: zero ? '0' : '30',
            retainedSessions: zero ? '0' : '30',
            completedOccurrencesWithMissingFinish: zero ? '0' : '4',
            completedOccurrencesWithUnsupportedFinish: zero ? '0' : '2',
            otherHistory: 'unavailable',
            unitMeaning: 'not_evaluated',
          },
          currentness: { state: 'snapshot', revision: 'year-8' },
        },
      },
      profiles: {
        status: 'received',
        value: {
          scope: 'selected_reported_year',
          year,
          state: 'available',
          dateSource: 'explicitly_reported_journal_finish',
          grouping: 'exact_retained_profile_pin',
          historicalLabels: 'unavailable',
          limit: 8,
          coverage: {
            nativeSessions: 'complete',
            otherHistory: 'unavailable',
            initializedSessions: zero ? '0' : '30',
            retainedSessions: zero ? '0' : '30',
          },
          currentness: currentness('reading_insights_v1'),
          totals: { completedOccurrences: zero ? '0' : '11', repeatOccurrencesWithinProfile: zero ? '0' : '1' },
          profiles: zero
            ? []
            : [
                { profile, completedOccurrences: '2', repeatOccurrencesWithinProfile: '1' },
                { profile: otherProfile, completedOccurrences: '1', repeatOccurrencesWithinProfile: '0' },
                ...Array.from({ length: 6 }, (_, index) => ({
                  profile: { ...profile, profileId: `reading-other-${index}` },
                  completedOccurrences: '1',
                  repeatOccurrencesWithinProfile: '0',
                })),
              ],
          unknown: { completedOccurrences: zero ? '0' : '1', repeatOccurrencesWithinProfile: '0' },
          remainder: {
            profileGroups: zero ? '0' : '1',
            completedOccurrences: zero ? '0' : '1',
            repeatOccurrencesWithinProfile: '0',
          },
        },
      },
      currentProgress: {
        status: 'received',
        value: {
          state: 'available',
          scope: 'active_and_backlog_sessions',
          limit: 8,
          coverage: {
            initializedSessions: zero ? '0' : '30',
            retainedSessions: zero ? '0' : '30',
            currentSessions: zero ? '0' : '13',
            activeSessions: zero ? '0' : '12',
            backlogSessions: zero ? '0' : '1',
            coveredSessions: zero ? '0' : '11',
            unsupportedSessions: zero ? '0' : '2',
          },
          currentness: currentness('reading_insights_current_progress_v1'),
          active: zero
            ? emptyScope
            : {
                sessionCount: '12',
                coveredSessions: '10',
                groups: [
                  progressGroup,
                  {
                    ...progressGroup,
                    meaning: {
                      ...progressGroup.meaning,
                      profilePin: otherProfile,
                      mode: 'cursor_position',
                      unitId: 'location',
                      unit: 'location',
                      locator: 'chapter-3',
                    },
                    occurrences: '1',
                    currentValue: '0.000000',
                    currentValueCount: '1',
                    missingCurrentValueCount: '0',
                    totalValue: null,
                    totalValueCount: '0',
                    missingTotalValueCount: '1',
                  },
                  ...Array.from({ length: 6 }, (_, index) => ({
                    ...progressGroup,
                    meaning: { ...progressGroup.meaning, unitId: `measure-${index}` },
                    occurrences: '1',
                    currentValue: null,
                    currentValueCount: '0',
                    missingCurrentValueCount: '1',
                    totalValue: null,
                    totalValueCount: '0',
                    missingTotalValueCount: '1',
                  })),
                ],
                remainder: {
                  groupCount: '1',
                  occurrences: '1',
                  currentValueCount: '1',
                  missingCurrentValueCount: '0',
                  totalValueCount: '0',
                  missingTotalValueCount: '1',
                },
              },
          backlog: zero
            ? emptyScope
            : {
                sessionCount: '1',
                coveredSessions: '1',
                groups: [
                  {
                    ...progressGroup,
                    meaning: {
                      ...progressGroup.meaning,
                      unitId: 'parts',
                      unit: 'part',
                      mode: 'completed_units',
                      identityKind: 'session_local',
                      precision: 0,
                    },
                    occurrences: '1',
                    currentValue: '0',
                    currentValueCount: '1',
                    missingCurrentValueCount: '0',
                    totalValue: null,
                    totalValueCount: '0',
                    missingTotalValueCount: '1',
                  },
                ],
                remainder: zeroRemainder,
              },
        },
      },
      assessments: {
        status: 'received',
        value: {
          scope: 'retained_nonretired_sessions',
          state: 'available',
          coverage: {
            initializedSessions: zero ? '0' : '30',
            retainedSessions: zero ? '0' : '30',
            includedSessions: zero ? '0' : '30',
          },
          currentness: currentness('reading_insights_assessments_v1'),
          revisions: zero
            ? []
            : [
                {
                  meaningRevision: 1,
                  counts: { absent: '2', explicitNull: '1', value: '3', historicalUnknown: '2' },
                  values: [
                    { units: 0, occurrences: '1' },
                    { units: 15, occurrences: '2' },
                  ],
                },
                {
                  meaningRevision: 2,
                  counts: { absent: '19', explicitNull: '1', value: '1', historicalUnknown: '1' },
                  values: [{ units: 20, occurrences: '1' }],
                },
              ],
        },
      },
    },
    actions: {
      diary: { operationId: 'library_diary.list', query: { year } },
      months: Array.from({ length: 12 }, (_, index) => ({
        operationId: 'library_diary.list',
        query: { year, month: index + 1 },
        month: index + 1,
      })),
      unallocatedMonth: { operationId: 'library_diary.list', query: { year, month: 'unallocated' } },
    },
  };
}
