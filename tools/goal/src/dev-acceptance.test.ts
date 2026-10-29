import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { integrationHarness } from './test-support.ts';

const fails = ['bun', '-e', "console.error('AssertionError: required behavior failed'); process.exit(1)"];

test("a dev landing runs the task's acceptance on the merged candidate and refuses a failure with its evidence", async () => {
  const h = integrationHarness();
  try {
    h.ensureDev();
    const task = h.dispatch('feature', [], fails);
    await h.start(task);
    const base = h.head();
    await h.train();

    expect(h.head()).toBe(base);
    expect(h.store.task(task.id).state).not.toBe('integrated');
    expect(h.outcomes).toHaveLength(1);
    expect(h.outcomes[0]).toMatchObject({
      passed: false,
      stage: 'gate',
      failedCommand: fails,
      firstFailure: { assertion: expect.stringContaining('required behavior failed') },
    });
    const log = readFileSync(h.outcomes[0]!.logPath, 'utf8');
    expect(log).toContain(`Acceptance on`);
    expect(log).toContain(fails.join(' '));
    expect(log).toContain('AssertionError: required behavior failed');
  } finally {
    h.dispose();
  }
});

test('a dev acceptance failure with the same fingerprint on its base is marked pre-existing', async () => {
  const h = integrationHarness();
  try {
    h.ensureDev();
    h.advanceDev('base-change');
    const task = h.dispatch('feature', [], fails);
    await h.start(task);
    await h.train();

    expect(h.outcomes[0]).toMatchObject({ passed: false, failsOnMain: true, stage: 'gate' });
    expect(readFileSync(h.outcomes[0]!.logPath, 'utf8')).toContain('Acceptance failure is pre-existing on dev');
  } finally {
    h.dispose();
  }
});

test("a passing dev landing advances dev and a batch runs every entry's acceptance", async () => {
  const h = integrationHarness();
  try {
    h.ensureDev();
    h.settings.integration.batchSize = 2;
    const first = h.dispatch('first', [], ['accept-first']);
    const second = h.dispatch('second', [], ['accept-second']);
    await h.start(first);
    await h.start(second);
    const checked: { command: string; files: string[] }[] = [];
    await h.train(async (command, cwd) => {
      checked.push({
        command: command.join(' '),
        files: ['first', 'second'].filter((file) => {
          try {
            readFileSync(join(cwd, file));
            return true;
          } catch {
            return false;
          }
        }),
      });
      return { passed: true, output: '', timedOut: false };
    });

    expect(h.head()).not.toBe(h.head('main'));
    expect(h.store.task(first.id).state).toBe('integrated');
    expect(h.store.task(second.id).state).toBe('integrated');
    expect(checked.map(({ command }) => command)).toEqual(['accept-first', 'accept-second']);
    expect(checked.map(({ files }) => files)).toEqual([
      ['first', 'second'],
      ['first', 'second'],
    ]);
  } finally {
    h.dispose();
  }
});
