import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { newErrorLines } from './merge-train.ts';
import { integrationHarness } from './test-support.ts';

type IntegrationCheck = { paths: string[]; command: string[] };

function integrationChecks(h: ReturnType<typeof integrationHarness>, checks: IntegrationCheck[]): void {
  (h.settings as typeof h.settings & { integrationChecks?: IntegrationCheck[] }).integrationChecks = checks;
}

test("a branch that fails the integration check is not integrated and gets a gate failure carrying the check's first failure", async () => {
  const h = integrationHarness();
  try {
    h.ensureDev();
    integrationChecks(h, [
      {
        paths: ['**'],
        command: ['sh', '-c', "test ! -e broken || { echo 'AssertionError: broken integration'; exit 1; }"],
      },
    ]);
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
      {
        paths: ['**'],
        command: ['sh', '-c', "test ! -e broken || { echo 'AssertionError: dev has broken integration'; exit 1; }"],
      },
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

test('a branch is refused for an error that dev, already failing the check, does not have', async () => {
  const h = integrationHarness();
  try {
    h.ensureDev();
    h.advanceDev('broken');
    integrationChecks(h, [
      {
        paths: ['**'],
        command: [
          'sh',
          '-c',
          "test ! -e broken || echo 'src/a.ts(3,1): error TS2322: dev error'; test ! -e worse || echo 'src/b.ts(9,4): error TS2339: new error'; test ! -e broken",
        ],
      },
    ]);
    const task = h.dispatch('worse');
    await h.start(task);
    const dev = h.head();

    await h.train(undefined, false);

    expect(h.head()).toBe(dev);
    expect(h.outcomes[0]?.passed).toBe(false);
    expect(h.outcomes[0]?.stage).toBe('gate');
    expect(h.outcomes[0]?.firstFailure?.assertion).toContain('error TS2339: new error');
    expect(h.outcomes[0]?.firstFailure?.assertion).not.toContain('dev error');
  } finally {
    h.dispose();
  }
});

test('a branch on an integrated candidate reuses its check result as the dev baseline', async () => {
  const h = integrationHarness();
  try {
    h.ensureDev();
    h.advanceDev('broken');
    integrationChecks(h, [
      {
        paths: ['**'],
        command: ['sh', '-c', "test ! -e broken || { echo 'src/a.ts(3,1): error TS2322: dev error'; exit 1; }"],
      },
    ]);
    const first = h.dispatch('first');
    await h.start(first);
    await h.train(undefined, false);
    const second = h.dispatch('second');
    await h.start(second);
    await h.train(undefined, false);

    expect(h.outcomes.map((outcome) => [outcome.passed, outcome.stage])).toEqual([
      [true, 'merge'],
      [true, 'merge'],
    ]);
    expect(readFileSync(h.outcomes[0]!.logPath, 'utf8')).toContain('Integration check baseline on dev');
    expect(readFileSync(h.outcomes[1]!.logPath, 'utf8')).not.toContain('Integration check baseline on dev');
  } finally {
    h.dispose();
  }
});

test('newErrorLines ignores moved positions and timings and counts repeats', () => {
  const dev = 'src/a.ts(3,1): error TS2322: same\nerror: script "typecheck" exited with code 1 after 2.31s';
  expect(
    newErrorLines('src/a.ts(40,7): error TS2322: same\nerror: script "typecheck" exited with code 1 after 9.80s', dev),
  ).toEqual([]);
  expect(newErrorLines('src/a.ts(3,1): error TS2322: same\nsrc/a.ts(8,1): error TS2322: same', dev)).toEqual([
    'src/a.ts: error TS2322: same',
  ]);
});

test('a branch that passes the integration check integrates into dev as before', async () => {
  const h = integrationHarness();
  try {
    h.ensureDev();
    integrationChecks(h, [{ paths: ['**'], command: ['sh', '-c', "echo 'integration check passed'"] }]);
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
      {
        paths: ['**'],
        command: [
          'sh',
          '-c',
          `if [ "$(git rev-parse HEAD)" = "${dev}" ]; then echo dev-check-run; fi; test ! -e broken || { echo 'AssertionError: broken integration'; exit 1; }`,
        ],
      },
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

test("a branch whose changes match no check's paths integrates without running any check", async () => {
  const h = integrationHarness();
  try {
    h.ensureDev();
    integrationChecks(h, [
      { paths: ['services/kernel/**'], command: ['sh', '-c', "echo 'integration check ran'; exit 1"] },
    ]);
    const task = h.dispatch('feature');
    await h.start(task);
    const candidate = h.head(task.branch);

    await h.train(undefined, false);

    expect(h.head()).toBe(candidate);
    expect(h.outcomes[0]?.passed).toBe(true);
    expect(h.outcomes[0]?.stage).toBe('merge');
    const log = readFileSync(h.outcomes[0]!.logPath, 'utf8');
    expect(log).not.toContain('integration check ran');
    expect(log).not.toContain('Integration check on');
  } finally {
    h.dispose();
  }
});
