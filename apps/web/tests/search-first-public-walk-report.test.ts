import { expect, test } from 'bun:test';
import {
  censusSummary,
  finishJourney,
  journeySteps,
  redactWalkLog,
  type JourneyProgress,
} from '../scripts/search-first-public-walk-report';

test('persona evidence retains the native identity while removing its generated password', () => {
  expect(
    redactWalkLog('Local persona: developer@rezics.test\nPassword: generated-private-value\nAccount: native-id\n'),
  ).toBe('Local persona: developer@rezics.test\nPassword: [redacted]\nAccount: native-id\n');
});

function record(completedSteps: string[] = []): JourneyProgress {
  return {
    name: 'Mixed Search',
    startedAt: '2026-11-07T09:00:00.000Z',
    elapsedSeconds: 0,
    result: 'FAIL',
    completedSteps,
    unreachedSteps: [],
  };
}

test('partial native and mounted success cannot pass a complete journey', () => {
  const partial = record(['submit', 'open-result', 'return-query']);
  finishJourney(partial, new Date('2026-11-07T09:00:01.125Z'));
  expect(partial.result).toBe('FAIL');
  expect(partial.unreachedSteps).toEqual(['phone-results', 'continue', 'current-visibility']);
  expect(partial.firstFailure).toContain('phone-results, continue, current-visibility');
  expect(partial.endedAt).toBe('2026-11-07T09:00:01.125Z');
  expect(partial.elapsedSeconds).toBe(1.125);
});

test('the actual first failure survives while downstream steps remain explicit', () => {
  const failed = { ...record(), firstFailure: 'POST /v1/subjects:search HTTP 503 index_not_ready' };
  finishJourney(failed, new Date('2026-11-07T09:00:03.000Z'));
  expect(failed.firstFailure).toBe('POST /v1/subjects:search HTTP 503 index_not_ready');
  expect(failed.unreachedSteps).toEqual([...journeySteps['Mixed Search']]);
  expect(failed.result).toBe('FAIL');
});

test('only a fully observed path passes; summary measures failing journeys independently', () => {
  const passed = record([...journeySteps['Mixed Search']]);
  finishJourney(passed, new Date('2026-11-07T09:01:00.000Z'));
  const failed = record(['submit']);
  finishJourney(failed, new Date('2026-11-07T09:00:02.000Z'));
  expect(passed.result).toBe('PASS');
  expect(passed.unreachedSteps).toEqual([]);
  expect(censusSummary([passed, failed])).toEqual({
    passing: 1,
    total: 6,
    slowestFailure: { name: 'Mixed Search', elapsedSeconds: 2 },
  });
});
