import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { integrationHarness } from './test-support.ts';

function integrationChecks(h: ReturnType<typeof integrationHarness>, commands: string[][]): void {
  (h.settings as typeof h.settings & { integrationChecks?: string[][] }).integrationChecks = commands;
}

test("a branch that fails the integration check is not integrated and gets a gate failure carrying the check's first failure", async () => {
  const h = integrationHarness();
  try {
    h.ensureDev();
    integrationChecks(h, [['sh', '-c', "test ! -e broken || { echo 'AssertionError: broken integration'; exit 1; }"]]);
    const task = h.dispatch('broken');
    await h.start(task);
    const dev = h.head();

    await h.train(undefined, false);

    expect(h.head()).toBe(dev);
    expect(h.head(task.branch)).not.toBe(dev);
    expect(h.outcomes[0]?.passed).toBe(false);
    expect(h.outcomes[0]?.stage).toBe('gate');
    expect(h.outcomes[0]?.firstFailure?.assertion).toContain('AssertionError: broken integration');
    expect(readFileSync(h.outcomes[0]!.logPath, 'utf8')).toContain('AssertionError: broken integration');
  } finally {
    h.dispose();
  }
});

test('a branch integrates when dev already fails the integration check', async () => {
  const h = integrationHarness();
  try {
    h.ensureDev();
    h.advanceDev('broken');
    integrationChecks(h, [
      ['sh', '-c', "test ! -e broken || { echo 'AssertionError: dev has broken integration'; exit 1; }"],
    ]);
    const task = h.dispatch('feature');
    await h.start(task);
    const candidate = h.head(task.branch);

    await h.train(undefined, false);

    expect(h.head()).toBe(candidate);
    expect(h.outcomes[0]?.passed).toBe(true);
    expect(h.outcomes[0]?.stage).toBe('merge');
    expect(readFileSync(h.outcomes[0]!.logPath, 'utf8')).toContain('dev already fails the integration check');
  } finally {
    h.dispose();
  }
});

test('a branch that passes the integration check integrates into dev as before', async () => {
  const h = integrationHarness();
  try {
    h.ensureDev();
    integrationChecks(h, [['sh', '-c', "echo 'integration check passed'"]]);
    const task = h.dispatch('feature');
    await h.start(task);
    const candidate = h.head(task.branch);

    await h.train(undefined, false);

    expect(h.head()).toBe(candidate);
    expect(h.outcomes[0]?.passed).toBe(true);
    expect(h.outcomes[0]?.stage).toBe('merge');
    expect(readFileSync(h.outcomes[0]!.logPath, 'utf8')).toContain('integration check passed');
  } finally {
    h.dispose();
  }
});

test("the dev head's check result is computed once per dev commit", async () => {
  const h = integrationHarness();
  try {
    h.ensureDev();
    const dev = h.head();
    integrationChecks(h, [
      [
        'sh',
        '-c',
        `if [ "$(git rev-parse HEAD)" = "${dev}" ]; then echo dev-check-run; fi; test ! -e broken || { echo 'AssertionError: broken integration'; exit 1; }`,
      ],
    ]);
    const first = h.dispatch('broken');
    const second = h.dispatch('broken');
    await h.start(first);
    await h.start(second);

    await h.train(undefined, false);

    const logs = h.outcomes.map((outcome) => readFileSync(outcome.logPath, 'utf8')).join('\n');
    expect(h.head()).toBe(dev);
    expect(h.outcomes.map((outcome) => [outcome.passed, outcome.stage])).toEqual([
      [false, 'gate'],
      [false, 'gate'],
    ]);
    expect(logs.match(/^dev-check-run$/gm) ?? []).toHaveLength(1);
  } finally {
    h.dispose();
  }
});
