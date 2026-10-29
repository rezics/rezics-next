import { expect, test } from 'bun:test';
import { continueProgress } from '../src/library/continue-read.ts';
import continueSessionsRecording from '../src/kernel/recorded/library-continue-progress-sessions.json';

test("the Continue response's active sessions supply each card's formatted progress", () => {
  const progress = continueSessionsRecording.progressSessions.map((session) => continueProgress(session));
  expect(progress).toHaveLength(5);
  expect(new Set(progress.map((item) => item?.sessionId)).size).toBe(progress.length);

  const total = (item: NonNullable<(typeof progress)[number]>) => (item.total === null ? 0 : Number(item.total));
  expect(
    progress.some(
      (item) => item?.mode === 'scalar_amount' && item.unit === 'episode' && item.amount !== null && total(item) > 0,
    ),
    'episodes with a total',
  ).toBe(true);
  expect(
    progress.some(
      (item) => item?.mode === 'scalar_amount' && item.unit === 'page' && item.amount !== null && item.total === null,
    ),
    'pages without a total',
  ).toBe(true);
  expect(
    progress.some((item) => item?.mode === 'scalar_amount' && item.unit === 'percent' && item.amount !== null),
    'a percent',
  ).toBe(true);
  expect(
    progress.some((item) => item?.mode === 'cursor_position' && item.amount === null),
    'a session without an amount',
  ).toBe(true);
  expect(progress.find((item) => item?.mode === 'cursor_position')?.locator).toBe('Part 2, chapter 14');
});
