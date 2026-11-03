import { expect, test } from 'bun:test';
import type { ConsumptionSummary } from '../src/library/private-diary/native';
import { consumptionStatistics, reportedDate } from '../src/library/private-diary/presentation';

const summary: ConsumptionSummary = {
  scope: 'retained_native_sessions',
  completedOccurrences: '9007199254740993',
  distinctCompletedSubjects: '2',
  repeatOccurrences: '1',
  completedOccurrencesWithUnknownProfile: '1',
  coverage: { nativeSessions: 'complete', otherHistory: 'unavailable', unitMeaning: 'not_evaluated' },
  currentness: { state: 'snapshot', revision: 'opaque-revision' },
};

test('diary statistics preserve native counts, scope, coverage and snapshot currentness', () => {
  expect(consumptionStatistics(summary)).toEqual(summary);
});

test('reported occurrence dates keep unknown month and day precision unknown', () => {
  expect(reportedDate({ year: 2001 })).toBe('2001');
  expect(reportedDate({ year: 2001, month: 2 })).toBe('2001-02');
  expect(reportedDate(null, 'Unknown')).toBe('Unknown');
});
