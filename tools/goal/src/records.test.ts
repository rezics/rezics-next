import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { CLASSIFIER_VERSION, classifyStep, measureLog } from './records.ts';
import { harness } from './worker-test-support.ts';
import { importAttempt } from './import-attempt.ts';

const fixture = join(import.meta.dir, 'fixtures/resumed.jsonl');
test('resumed rollout records increments within the attempt window, ignoring repeated cumulative snapshots', () => {
  const measured = measureLog(readFileSync(fixture, 'utf8'), { startedAt: '2026-10-25T00:01:00Z', endedAt: '2026-10-25T00:02:00Z' });
  expect(measured.tokens).toEqual({ input: 800, cached: 500, output: 80 });
  expect(measured.steps).toEqual({ decision: 0, read: 1, edit: 1, wait: 0, check: 1, commit: 1 });
  expect(measured.session).toBe('fixture-session');
  const exec = [1000, 1300, 1300].map(input_tokens => JSON.stringify({ type: 'turn.completed', usage: { input_tokens } })).join('\n');
  expect(measureLog(exec, { baseline: { input: 1000, cached: 0, output: 0 } }).tokens.input).toBe(300);
  expect(classifyStep('wait', '')).toBe('wait'); expect(classifyStep('reasoning', '')).toBe('decision');
});
test('import creates a complete measurement record without launching a worker', () => {
  const h = harness();
  try {
    const task = h.tasks.dispatch(h.briefFile);
    const record = importAttempt(h.tasks, fixture, { taskId: task.id, startedAt: '2026-10-25T00:01:00Z', endedAt: '2026-10-25T00:02:00Z',
      profile: { cli: 'codex', model: 'gpt-6-luna', effort: 'max', poolClass: 'codex' }, pool: 'fixture' });
    expect(record.tokens.input).toBe(800); expect(record.classifierVersion).toBe(CLASSIFIER_VERSION);
    expect(record.steps).toBe(4); expect(record.tableVersion).toBe('imported-before-1');
    expect(h.store.records()).toEqual([record]);
  } finally { h.dispose(); }
});

test('out-of-order cumulative observations cannot make resumed token totals grow twice', () => {
  const log = [1000, 1300, 1000, 1300, 1500].map(input_tokens => JSON.stringify({ type: 'turn.completed', usage: { input_tokens } })).join('\n');
  expect(measureLog(log, { baseline: { input: 1000, cached: 0, output: 0 } }).tokens.input).toBe(500);
});

test('CLI imports a preexisting log from a brief without starting a model or landing it', async () => {
  const { runWorkerCommand } = await import('./worker-commands.ts');
  const h = harness(), output: string[] = [];
  try {
    await runWorkerCommand('import-attempt', [fixture, '--brief', h.briefFile, '--start', '2026-10-25T00:01:00Z', '--end', '2026-10-25T00:02:00Z',
      '--pool', 'fixture', '--model', 'gpt-6-luna', '--effort', 'max'], { tasks: h.tasks, print: s => output.push(s), env: {} });
    const record = JSON.parse(output[0]!);
    expect(record.tokens.input).toBe(800); expect(record.diffLines).toBeNull(); expect(record.hostMs).toBeNull();
    expect(h.store.attempts()[0]!.process).toBeNull(); expect(h.store.tasks()[0]!.state).toBe('stopped');
    expect(h.store.events().filter(e => e.kind === 'landing-requested')).toEqual([]);
  } finally { h.dispose(); }
});
