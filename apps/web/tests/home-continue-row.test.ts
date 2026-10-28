import { expect, test } from 'bun:test';
import { readProgress } from '../src/library/continue-read.ts';
import libraryContinueEntriesRecording from '../src/kernel/recorded/library-continue-entries.json';
import continueSessionsRecording from '../src/kernel/recorded/library-continue-progress-sessions.json';

test("the home story's Continue entries cover a total of episodes, pages without a total, a percent and a session without an amount", async () => {
  const recorded = continueSessionsRecording.progressSessions;
  expect(recorded).toHaveLength(5);
  expect(recorded).toContainEqual(
    expect.objectContaining({
      mode: 'cursor_position',
      amount: null,
      locator: 'Part 2, chapter 14',
    }),
  );
  // The kernel answers a read for one subject with that subject's sessions; the recorded fake answers every read with
  // the whole recording, so the card must take the active session of its own subject.
  const client = {
    progressSessions: { get: async () => ({ data: { progressSessions: recorded, next: null } }) },
  } as never;
  const progress = [];
  for (const item of libraryContinueEntriesRecording.libraryEntries) {
    if (item.state !== 'in_progress') continue;
    const read = await readProgress(client, item.subjectId, 'Bearer story');
    if (read) progress.push(read);
  }
  // Every case has its own entry, and no two entries show the same session.
  expect(new Set(progress.map((item) => item.sessionId)).size).toBe(progress.length);
  expect(progress.length).toBe(recorded.length);
  const total = (item: (typeof progress)[number]) => (item.total === null ? 0 : Number(item.total));
  expect(
    progress.some(
      (item) => item.mode === 'scalar_amount' && item.unit === 'episode' && item.amount !== null && total(item) > 0,
    ),
    'episodes with a total',
  ).toBe(true);
  expect(
    progress.some(
      (item) => item.mode === 'scalar_amount' && item.unit === 'page' && item.amount !== null && item.total === null,
    ),
    'pages without a total',
  ).toBe(true);
  expect(
    progress.some((item) => item.mode === 'scalar_amount' && item.unit === 'percent' && item.amount !== null),
    'a percent',
  ).toBe(true);
  expect(
    progress.some((item) => item.mode === 'cursor_position' && item.amount === null),
    'a session without an amount',
  ).toBe(true);
  expect(progress.find((item) => item.mode === 'cursor_position')?.locator).toBe('Part 2, chapter 14');
});
