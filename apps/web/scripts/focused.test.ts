import { afterAll, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runFocusedCommand } from './focused.ts';

const leftoverRoot = mkdtempSync(join(tmpdir(), 'rezics-web-check-leftover-'));

afterAll(() => rmSync(leftoverRoot, { recursive: true, force: true }));

test('an earlier occupied or unknown invocation does not stop a new focused check from starting', async () => {
  mkdirSync(join(leftoverRoot, 'earlier'), { recursive: true });
  writeFileSync(
    join(leftoverRoot, 'earlier', 'web-custody.json'),
    `${JSON.stringify({
      custody: 'occupied',
      nativeExitCode: null,
      failure: 'invocation custody occupied; source/returns/finalCustody/cancellation unknown',
    })}\n`,
    { mode: 0o600 },
  );
  writeFileSync(join(leftoverRoot, 'earlier', 'prepared-descriptor.json'), '{"stale":true}\n', { mode: 0o600 });

  const commands: string[][] = [];
  const first = await runFocusedCommand(['bun', 'test', 'tests/earlier.test.ts'], {
    place: async (run) => {
      commands.push(run.command);
      return 75;
    },
  });
  expect(first).toBe(75);

  const second = await runFocusedCommand(['bun', 'test', 'tests/retry.test.ts'], {
    place: async (run) => {
      commands.push(run.command);
      return 0;
    },
  });
  expect(second).toBe(0);
  expect(commands).toHaveLength(2);
  expect(commands[0]).toContain('tests/earlier.test.ts');
  expect(commands[1]).toContain('tests/retry.test.ts');
  expect(commands[0]).not.toContain('reconcile');
  expect(commands[1]).not.toContain('reconcile');
});

test('a stale leftover journal is ignored rather than treated as a focused-check refusal', async () => {
  writeFileSync(
    join(leftoverRoot, 'stale-journal.json'),
    `${JSON.stringify({ custody: 'occupied', descriptorFile: join(leftoverRoot, 'earlier', 'prepared-descriptor.json') })}\n`,
  );
  const result = await runFocusedCommand(['bun', 'test', 'tests/fresh.test.ts'], {
    place: async (run) => {
      expect(run.command).toContain('tests/fresh.test.ts');
      expect(run.command).not.toContain(join(leftoverRoot, 'earlier', 'prepared-descriptor.json'));
      return 0;
    },
  });
  expect(result).toBe(0);
});
