import { expect, test } from 'bun:test';
import type { StatusState } from '../src/modules/library/status.ts';
import { workProgress } from '../src/modules/progress-summary/policy.ts';
import { progressRankingMetrics } from '../src/modules/rankings/projection.ts';
import { decodeWorkStanding, encodeWorkStanding, type WorkStanding } from '../src/modules/progress/work-standing.ts';
import type { SessionState } from '../src/modules/session/contract.ts';

const id = (n: number) => `https://rezics.com/id/00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const work = id(1);
const status = (value: StatusState['status']): StatusState => ({ work, status: value,
  startedOn: null, finishedOn: null, version: 1, changedAt: '2026-10-01' });
function attempt(state: SessionState['state']): SessionState {
  const target = { base: 'work' as const, resource: work, work, revision: id(4), types: [], disclosure: 'public' as const };
  return { id: id(5), target, state, version: 1, startedOn: null, finishedOn: null,
    selections: [{ target, language: 'ja', format: null, progress: 'locator' }],
    locators: [{ target: target.resource, unit: 'percentage', current: 100, furthest: 100 }],
    completedAt: null, createdAt: '2026-10-01', changedAt: '2026-10-01' };
}
const summary = (standing: WorkStanding | null, sessions: SessionState[] = [], library: StatusState[] = []) =>
  workProgress(work, sessions, [], false, library, standing);

test('a whole-Work mark is four states on one progress row', () => {
  for (const standing of ['not-started', 'started', 'completed', 'dropped'] as const) {
    expect(decodeWorkStanding(encodeWorkStanding(standing))).toBe(standing);
  }
  expect(decodeWorkStanding({ completed: true, position: 'started' })).toBeNull();
  expect(decodeWorkStanding({ completed: false, position: 'chapter:1' })).toBeNull();
});

test('a partless completion counts as a read and not as a finished chapter', () => {
  const work = id(1);
  expect(progressRankingMetrics({ structure: work, occurrence: work, read: true, finished: true })).toEqual(['reads']);
  expect(progressRankingMetrics({ structure: work, occurrence: work, read: false, finished: true })).toEqual([]);
  expect(progressRankingMetrics({ structure: id(2), occurrence: id(3), read: true, finished: true }))
    .toEqual(['reads', 'finished-chapters']);
});

test('a partless Work is finished, being read, dropped or not started from that one mark', () => {
  expect(summary(null)).toMatchObject({ status: 'not-started', counts: { completed: 0, required: 1 } });
  expect(summary('not-started').status).toBe('not-started');
  expect(summary('started')).toMatchObject({ status: 'reading', counts: { completed: 0 } });
  expect(summary('completed')).toMatchObject({ status: 'finished', counts: { completed: 1, completedRequired: 1 } });
  expect(summary('dropped').status).toBe('dropped');
  // A finish already recorded on the shelf or an attempt still finishes the Work.
  expect(summary('dropped', [], [status('read')]).status).toBe('finished');
  expect(summary('started', [attempt('finished')]).status).toBe('finished');
  expect(summary('dropped', [attempt('active')]).status).toBe('reading');
  expect(summary('dropped', [], [status('reading')]).status).toBe('reading');
  // An unfinished page of attempts does not become dropped or not started.
  expect(workProgress(work, [], [], true, [], 'dropped').status).toBeNull();
  expect(workProgress(work, [], [], true, [], 'completed').status).toBe('finished');
});
