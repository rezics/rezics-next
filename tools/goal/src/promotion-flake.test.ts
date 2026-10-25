import { expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { git } from './merge.ts';
import { integrationHarness } from './test-support.ts';

const failure = { passed: false, output: 'AssertionError: flaky fixture', timedOut: false };
const success = { passed: true, output: '', timedOut: false };

test('a culprit whose failing prefix passes on confirmation is not reverted and the batch is gated again', async () => {
  const h = integrationHarness();
  try {
    const first = await h.seed('alpha');
    const culprit = await h.seed('bad', [], ['fixture-failing-gate']);
    const failingPrefix = h.head();
    const last = await h.seed('omega');
    const dev = h.head(), main = h.head('main');
    let culpritFailures = 0;
    let headFailures = 0;
    let sawFlakeDecision = false;

    await h.promote(async (command, cwd) => {
      const commit = git(cwd, 'rev-parse', 'HEAD');
      const persisted = h.store.promotion() as (ReturnType<typeof h.store.promotion> & {
        flakeEvents?: { kind: string; logs: [string, string] }[];
      });
      if (persisted?.flakeEvents?.length) {
        sawFlakeDecision = persisted.flakeEvents[0]?.kind === 'promotion-flake'
          && persisted.flakeEvents[0]?.logs.every(Boolean) === true;
      }
      if (command[0] === 'fixture-failing-gate' && commit === dev && headFailures++ === 0) return failure;
      if (commit === failingPrefix && command[0] === 'fixture-failing-gate') {
        culpritFailures++;
        return culpritFailures === 1 ? failure : success;
      }
      return success;
    });

    expect(culpritFailures).toBe(2);
    expect(sawFlakeDecision).toBe(true);
    expect(h.head()).toBe(dev);
    expect(h.head('main')).toBe(dev);
    expect(git(h.root, 'diff', '--name-only', dev, 'dev')).toBe('');
    expect(existsSync(`${h.root}/bad`)).toBe(true);
    for (const task of [first, culprit, last]) expect(h.store.task(task.id).state).toBe('merged');
  } finally { h.dispose(); }
});

test('a culprit whose failing prefix fails again with the same first failure is reverted as before', async () => {
  const h = integrationHarness();
  try {
    const first = await h.seed('alpha');
    const culprit = await h.seed('bad', [], ['fixture-failing-gate']);
    const failingPrefix = h.head();
    const last = await h.seed('omega');
    const dev = h.head();
    let culpritFailures = 0;

    await h.promote(async (command, cwd) => {
      const commit = git(cwd, 'rev-parse', 'HEAD');
      if (command[0] === 'fixture-failing-gate' && commit === dev) return failure;
      if (command[0] === 'fixture-failing-gate' && commit === failingPrefix) {
        culpritFailures++;
        return failure;
      }
      return success;
    });

    expect(culpritFailures).toBe(2);
    expect(git(h.root, 'rev-list', '--count', `${dev}..dev`)).toBe('1');
    expect(git(h.root, 'diff', '--name-only', dev, 'dev')).toBe('bad');
    expect(h.store.task(first.id).state).toBe('merged');
    expect(h.store.task(last.id).state).toBe('merged');
    expect(h.store.task(culprit.id).currentAttempt).toBe(2);
  } finally { h.dispose(); }
});

test('the culprit search costs a logarithmic number of probes in the batch size', async () => {
  // Growth check: a root-gate failure introduced at a fixed relative position is found in O(log n) probes of one command.
  const probesFor = async (size: number) => {
    const h = integrationHarness();
    try {
      for (let index = 0; index < size; index++) await h.seed(index === Math.floor(size * 0.7) ? 'bad' : `task-${index}`);
      const dev = h.head(), main = h.head('main');
      let probes = 0;
      await h.promote(async (command, cwd) => {
        const commit = git(cwd, 'rev-parse', 'HEAD');
        const broken = existsSync(`${cwd}/bad`);
        if (commit !== dev && commit !== main) probes++;
        return broken && command[0] !== 'true' ? failure : broken && command.join(' ') === h.settings.gate.join(' ') ? failure : success;
      });
      return probes;
    } finally { h.dispose(); }
  };
  const small = await probesFor(8), large = await probesFor(64);
  expect(large).toBeLessThanOrEqual(small + 12);
  expect(large).toBeLessThan(32);
}, 120_000);

test('a specification task whose suite is red by design does not fail promotion', async () => {
  const h = integrationHarness();
  try {
    const spec = await h.seed('outcomes', [], ['fixture-red-suite']);
    h.store.updateTask({ taskId: spec.id, attempt: 1 }, current => { current.taskClass = 'specification'; });
    const next = await h.seed('implementation');
    const dev = h.head();
    await h.promote(async command => command[0] === 'fixture-red-suite' ? failure : success);
    expect(h.head('main')).toBe(dev);
    for (const task of [spec, next]) expect(h.store.task(task.id).state).toBe('merged');
  } finally { h.dispose(); }
});
