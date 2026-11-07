import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, renameSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { watchOrPoll } from './watch-or-poll.ts';
import { installTestClock, waitUntil } from './test-support.ts';

test('a path that cannot be watched is polled instead', () => {
  const clock = installTestClock();
  try {
    let calls = 0;
    const watching = watchOrPoll(
      join(mkdtempSync(join(tmpdir(), 'watch-or-poll-')), 'missing', 'child'),
      () => calls++,
      20,
    );
    clock.advance(120);
    watching.close();
    expect(calls).toBeGreaterThan(2);
    const after = calls;
    clock.advance(60);
    expect(calls).toBe(after);
  } finally {
    clock.restore();
  }
});

test('a consumer continues receiving changes after replacement of the watched path, and close ends all wakeups', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'watch-or-poll-'));
  let calls = 0;
  const watching = watchOrPoll(dir, () => calls++, 10_000);
  writeFileSync(join(dir, 'before'), '1');
  await waitUntil(() => calls > 0, 2000, 'initial watch event');
  const prior = calls;
  renameSync(dir, `${dir}.old`);
  mkdirSync(dir);
  writeFileSync(join(dir, 'after'), '2');
  await waitUntil(() => calls > prior, 2000, 'watch event after replacement');
  watching.close();
  const stopped = calls;
  writeFileSync(join(dir, 'late'), '3');
  await Bun.sleep(20);
  expect(calls).toBe(stopped);
});
