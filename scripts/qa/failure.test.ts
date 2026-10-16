import { expect, test } from 'bun:test';
import { qaFailure, recordedFailure, recordQaFailure, type FailureClass } from './failure.ts';
import { command } from './core.ts';

const cases: [string, Parameters<typeof qaFailure>[0], Parameters<typeof qaFailure>[1], boolean, FailureClass][] = [
  ['a test assertion', {}, 'test', true, 'assertion'],
  ['a spent test budget', { timedOut: true }, 'test', true, 'timeout'],
  ['a spent setup budget', { timedOut: true }, 'environment', false, 'timeout'],
  ['a refused preflight or missing corpus', {}, 'environment', false, 'environment'],
  ['a dependency connection', { output: 'connect ECONNREFUSED 127.0.0.1' }, 'test', true, 'environment'],
  ['tooling without test evidence', {}, 'test', false, 'harness'],
  ['a broken harness', {}, 'harness', false, 'harness'],
];
for (const [name, result, phase, failed, expected] of cases) test('records ' + name + ' as ' + expected, () => {
  const lines: string[] = [];
  const kind = qaFailure(result, phase, failed);
  const message = recordQaFailure(kind, name, line => lines.push(line));
  expect(message).toBe(expected + ': ' + name);
  expect(recordedFailure(lines.join('\n'))).toBe(expected);
});
test('the first recorded failure wins over a later cleanup failure', () => {
  expect(recordedFailure('QA failure class: assertion\nQA failure class: harness')).toBe('assertion');
  expect(recordedFailure('failed or exceeded')).toBeUndefined();
});
test('synchronous commands preserve timeout separately from nonzero exits', () => {
  const timed = command(process.cwd(), process.execPath, ['-e', 'await Bun.sleep(10000)'], 50);
  expect(timed.ok).toBe(false);
  expect(timed.timedOut).toBe(true);
  const failed = command(process.cwd(), process.execPath, ['-e', 'process.exit(1)'], 5000);
  expect(failed.ok).toBe(false);
  expect(failed.timedOut).toBe(false);
});

test('tier and integration-file artifacts carry each recorded class', async () => {
  const { mkdirSync, mkdtempSync, readFileSync, rmSync } = await import('node:fs');
  const { join } = await import('node:path');
  const { writeSummary } = await import('./core.ts');
  const parent = join(import.meta.dir, '../../.temp/failure-tests');
  mkdirSync(parent, { recursive: true });
  const directory = mkdtempSync(join(parent, 'record-'));
  const source = { head: 'test', fingerprint: 'stable', clean: true };
  try {
    for (const failureClass of ['assertion', 'timeout', 'environment', 'harness'] as const) {
      writeSummary(directory, { runId: 'test', sourceBefore: source, sourceAfter: source,
        failureClass, partial: true, errors: [failureClass + ': refused'], cases: [],
        tiers: [{ name: 'integration', status: 'failed', failureClass,
          shards: [{ project: 'one', files: ['one.test.ts'], stage: 'test', status: 'failed', failureClass }] }],
        tests: [{ tier: 'integration', file: 'one.test.ts', name: 'example', failed: true, skipped: false }] });
      const report = JSON.parse(readFileSync(join(directory, 'acceptance.json'), 'utf8'));
      expect(report.failureClass).toBe(failureClass);
      expect(report.tiers[0].failureClass).toBe(failureClass);
      expect(report.tiers[0].shards[0].failureClass).toBe(failureClass);
      expect(report.tests[0].failureClass).toBe(failureClass);
    }
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
