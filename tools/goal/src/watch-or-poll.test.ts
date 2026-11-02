import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, renameSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { watchOrPoll } from './watch-or-poll.ts';

test('a path that cannot be watched is polled instead', async () => {
  let calls = 0;
  const watching = watchOrPoll(
    join(mkdtempSync(join(tmpdir(), 'watch-or-poll-')), 'missing', 'child'),
    () => calls++,
    20,
  );
  await new Promise((resolve) => setTimeout(resolve, 120));
  watching.close();
  expect(calls).toBeGreaterThan(2);
  const after = calls;
  await new Promise((resolve) => setTimeout(resolve, 60));
  expect(calls).toBe(after);
});

test('a consumer continues receiving changes after replacement of the watched path, and close ends all wakeups', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'watch-or-poll-'));
  let calls = 0;
  const watching = watchOrPoll(dir, () => calls++, 10_000);
  await new Promise((resolve) => setTimeout(resolve, 40));
  writeFileSync(join(dir, 'before'), '1');
  await new Promise((resolve) => setTimeout(resolve, 120));
  expect(calls).toBeGreaterThan(0);
  const prior = calls;
  renameSync(dir, `${dir}.old`);
  mkdirSync(dir);
  await new Promise((resolve) => setTimeout(resolve, 80));
  writeFileSync(join(dir, 'after'), '2');
  await new Promise((resolve) => setTimeout(resolve, 200));
  expect(calls).toBeGreaterThan(prior);
  watching.close();
  const stopped = calls;
  writeFileSync(join(dir, 'late'), '3');
  await new Promise((resolve) => setTimeout(resolve, 120));
  expect(calls).toBe(stopped);
});
