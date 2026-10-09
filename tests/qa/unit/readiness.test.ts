import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { qaMigrationFiles } from '../../../scripts/qa/bootstrap.ts';
import { pollUntilDeadline } from '../../../scripts/qa/readiness.ts';

const root = resolve(import.meta.dir, '../../..');

function trackedResponse(status: number, open: { count: number }): Response {
  return new Response(new ReadableStream({
    start(controller) {
      open.count++;
      controller.enqueue(new Uint8Array([1]));
    },
    cancel() { open.count--; },
  }), { status });
}

test('the readiness poll stops at its deadline and releases a late response body', async () => {
  const open = { count: 0 };
  let calls = 0;
  const started = Date.now();
  const deadline = started + 40;
  const ready = await pollUntilDeadline(async () => {
    calls++;
    await Bun.sleep(120);
    return trackedResponse(200, open);
  }, deadline, 5);
  expect(ready).toBe(false);
  expect(calls).toBe(1);
  expect(Date.now() - started).toBeLessThan(100);
  const until = Date.now() + 500;
  while (open.count !== 0 && Date.now() < until) await Bun.sleep(10);
  expect(open.count).toBe(0);
});

test('a successful probe still releases its response body', async () => {
  const open = { count: 0 };
  const ready = await pollUntilDeadline(async () => trackedResponse(200, open), Date.now() + 1_000, 10);
  expect(ready).toBe(true);
  expect(open.count).toBe(0);
});

test('an unsuccessful probe body is released before the next attempt', async () => {
  const open = { count: 0 };
  let calls = 0;
  const ready = await pollUntilDeadline(async () => {
    calls++;
    return trackedResponse(calls === 1 ? 503 : 200, open);
  }, Date.now() + 1_000, 1);
  expect(ready).toBe(true);
  expect(calls).toBe(2);
  expect(open.count).toBe(0);
});

test('the readiness poll does not probe once its deadline has passed', async () => {
  let calls = 0;
  const ready = await pollUntilDeadline(async () => { calls++; return true; }, Date.now() - 1, 10);
  expect(ready).toBe(false);
  expect(calls).toBe(0);
});

test('a probe failure stops the poll instead of waiting out the deadline', async () => {
  await expect(pollUntilDeadline(async () => {
    throw new Error('exited before readiness');
  }, Date.now() + 1_000, 10)).rejects.toThrow('exited before readiness');
});

test('a migration subset stays the files the caller named', () => {
  mkdirSync(join(root, '.temp'), { recursive: true });
  const directory = mkdtempSync(join(root, '.temp', 'qa-migration-subset-'));
  try {
    writeFileSync(join(directory, '002_b.sql'), 'select 2;\n');
    writeFileSync(join(directory, '001_a.sql'), 'select 1;\n');
    writeFileSync(join(directory, '003_c.sql'), 'select 3;\n');
    writeFileSync(join(directory, 'notes.txt'), 'not a migration\n');
    expect(qaMigrationFiles(directory)).toEqual(['001_a.sql', '002_b.sql', '003_c.sql']);
    expect(qaMigrationFiles(directory, ['003_c.sql', '001_a.sql'])).toEqual(['001_a.sql', '003_c.sql']);
    expect(qaMigrationFiles(directory, ['002_b.sql'])).toEqual(['002_b.sql']);
    expect(qaMigrationFiles(directory, [])).toEqual([]);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
