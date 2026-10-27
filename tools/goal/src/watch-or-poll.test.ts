import { expect, test } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { watchOrPoll } from './watch-or-poll.ts';

test('a path that cannot be watched is polled instead', async () => {
  let calls = 0;
  const watching = watchOrPoll(join(mkdtempSync(join(tmpdir(), 'watch-or-poll-')), 'missing'), () => calls++, 20);
  await new Promise((resolve) => setTimeout(resolve, 120));
  watching.close();
  expect(calls).toBeGreaterThan(2);
  const after = calls;
  await new Promise((resolve) => setTimeout(resolve, 60));
  expect(calls).toBe(after);
});
