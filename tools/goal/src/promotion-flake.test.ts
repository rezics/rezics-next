import { expect, test } from 'bun:test';
import { existsSync, writeFileSync } from 'node:fs';
import { git } from './merge.ts';
import { integrationHarness } from './test-support.ts';

const failure = { passed: false, output: 'AssertionError: flaky fixture', timedOut: false };
const success = { passed: true, output: '', timedOut: false };

test('a failing stabilize candidate is held for a fix without prefix confirmation', async () => {
  const h = integrationHarness();
  try {
    const first = await h.seed('alpha');
    const culprit = await h.seed('bad', [], ['fixture-failing-gate']);
    const failingPrefix = h.head();
    const last = await h.seed('omega');
    const dev = h.head(), main = h.head('main');
    let culpritFailures = 0;
    let headFailures = 0;

    await h.promote(async (command, cwd) => {
      const commit = git(cwd, 'rev-parse', 'HEAD');
      if (command[0] === 'fixture-failing-gate' && commit === dev && headFailures++ === 0) return failure;
      if (commit === failingPrefix && command[0] === 'fixture-failing-gate') {
        culpritFailures++;
        return culpritFailures === 1 ? failure : success;
      }
      return success;
    });

    expect(culpritFailures).toBe(0);
    expect(h.head()).toBe(dev);
    expect(h.head('main')).toBe(main);
    expect(git(h.root, 'diff', '--name-only', dev, 'dev')).toBe('');
    expect(existsSync(`${h.root}/bad`)).toBe(true);
    expect(h.store.promotion()?.phase).toBe('stabilize-blocked');
    for (const task of [first, culprit, last]) {
      expect(h.store.task(task.id).state).toBe('integrated');
      expect(h.store.task(task.id).currentAttempt).toBe(1);
    }
  } finally { h.dispose(); }
});

test('a paused promotion gates nothing and leaves main where it is', async () => {
  const h = integrationHarness();
  try {
    await h.seed('alpha');
    const main = h.head('main');
    writeFileSync(`${h.settings.stateDirectory}/promotion.paused`, '');
    let gates = 0;
    await h.promote(async () => { gates++; return success; });

    expect(gates).toBe(0);
    expect(h.head('main')).toBe(main);
    expect(h.store.promotion()).toBeFalsy();
  } finally { h.dispose(); }
});

test('a failing stabilize candidate is not bisected or reverted', async () => {
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

    expect(culpritFailures).toBe(0);
    expect(h.head()).toBe(dev);
    expect(h.head('main')).not.toBe(dev);
    expect(h.store.promotion()?.phase).toBe('stabilize-blocked');
    for (const task of [first, culprit, last]) {
      expect(h.store.task(task.id).state).toBe('integrated');
      expect(h.store.task(task.id).currentAttempt).toBe(1);
    }
  } finally { h.dispose(); }
});

test('a failing stabilize candidate is gated once regardless of batch size', async () => {
  const probesFor = async (size: number) => {
    const h = integrationHarness();
    try {
      for (let index = 0; index < size; index++) await h.seed(index === Math.floor(size * 0.7) ? 'bad' : `task-${index}`);
      const dev = h.head(), main = h.head('main');
      let candidateGates = 0;
      await h.promote(async (command, cwd) => {
        const commit = git(cwd, 'rev-parse', 'HEAD');
        const broken = existsSync(`${cwd}/bad`);
        if (command.join(' ') === h.settings.gate.join(' ') && commit === dev) candidateGates++;
        return broken && command[0] !== 'true' ? failure : broken && command.join(' ') === h.settings.gate.join(' ') ? failure : success;
      });
      expect(h.store.promotion()?.phase).toBe('stabilize-blocked');
      expect(h.head('main')).toBe(main);
      return candidateGates;
    } finally { h.dispose(); }
  };
  const small = await probesFor(8), large = await probesFor(64);
  expect(small).toBe(1);
  expect(large).toBe(1);
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

test('a failing root gate at the head stops the head gate before the acceptance commands', async () => {
  const h = integrationHarness();
  try {
    await h.seed('alpha', [], ['fixture-acceptance-a']);
    await h.seed('beta', [], ['fixture-acceptance-b']);
    const dev = h.head();
    const atHead: string[] = [];
    await h.promote(async (command, cwd) => {
      if (git(cwd, 'rev-parse', 'HEAD') === dev) atHead.push(command[0]!);
      return command.join(' ') === h.settings.gate.join(' ') && git(cwd, 'rev-parse', 'HEAD') === dev ? failure : success;
    });
    expect(atHead.filter(command => command.startsWith('fixture-acceptance'))).toEqual([]);
  } finally { h.dispose(); }
});

test('a failing stabilize candidate publishes no passing prefix to main', async () => {
  const h = integrationHarness();
  try {
    const alpha = await h.seed('alpha');
    const beta = await h.seed('beta');
    const bad = await h.seed('bad');
    await h.seed('gamma');
    const dev = h.head(), main = h.head('main');
    await h.promote(async (command, cwd) => {
      const commit = git(cwd, 'rev-parse', 'HEAD');
      return existsSync(`${cwd}/bad`) ? failure : success;
    });
    expect(h.head('main')).toBe(main);
    expect(h.head()).toBe(dev);
    for (const task of [alpha, beta, bad]) {
      expect(h.store.task(task.id).state).toBe('integrated');
      expect(h.store.task(task.id).currentAttempt).toBe(1);
    }
    expect(existsSync(`${h.root}/bad`)).toBe(true);
    expect(h.store.promotion()?.phase).toBe('stabilize-blocked');
  } finally { h.dispose(); }
});

test('a failing candidate with a main hotfix stays blocked without publishing a prefix', async () => {
  const h = integrationHarness();
  try {
    const alpha = await h.seed('alpha');
    // A hotfix committed on main directly reaches dev only through a later merge, so no earlier boundary contains it.
    writeFileSync(`${h.root}/hotfix`, 'hotfix\n');
    git(h.root, 'add', 'hotfix'); git(h.root, 'commit', '-qm', 'Hotfix on main');
    const tree = `${h.root}-merge`;
    git(h.root, 'worktree', 'add', '--detach', tree, 'dev');
    git(tree, '-c', 'core.hooksPath=/dev/null', 'merge', '--no-ff', '-qm', 'Merge main into dev', 'main');
    git(h.root, 'update-ref', 'refs/heads/dev', git(tree, 'rev-parse', 'HEAD'));
    git(h.root, 'worktree', 'remove', '--force', tree);
    const bad = await h.seed('bad');
    await h.seed('omega');
    await h.promote(async (_command, cwd) => existsSync(`${cwd}/bad`) ? failure : success);
    expect(h.store.task(alpha.id).state).toBe('integrated');
    expect(h.store.task(bad.id).currentAttempt).toBe(1);
    expect(h.store.promotion()?.phase).toBe('stabilize-blocked');
    expect(git(h.root, 'merge-base', '--is-ancestor', git(h.root, 'rev-parse', 'main'), 'dev') === '').toBe(true);
  } finally { h.dispose(); }
});

test('a failing stabilize candidate with dependent later work remains blocked for a fix', async () => {
  const h = integrationHarness();
  try {
    await h.seed('alpha');
    const bad = await h.seed('bad');
    // Later work builds on the culprit's file, so reverting the culprit alone conflicts.
    const tree = `${h.root}-later`;
    git(h.root, 'worktree', 'add', '--detach', tree, 'dev');
    writeFileSync(`${tree}/bad`, 'bad, extended by later work\n');
    git(tree, 'add', 'bad'); git(tree, '-c', 'core.hooksPath=/dev/null', 'commit', '-qm', 'Build on bad');
    git(h.root, 'update-ref', 'refs/heads/dev', git(tree, 'rev-parse', 'HEAD'));
    git(h.root, 'worktree', 'remove', '--force', tree);
    await h.seed('omega');
    const devBefore = h.head();
    await h.promote(async (_command, cwd) => existsSync(`${cwd}/bad`) ? failure : success);
    const run = h.store.promotion();
    expect(run?.phase).toBe('stabilize-blocked');
    expect(run?.blockedOn).toBeUndefined();
    expect(h.store.task(bad.id).currentAttempt).toBe(1);
    expect(h.head()).toBe(devBefore);
  } finally { h.dispose(); }
});

test('a specification routed as a claim, or any verifier run of a specification suite, does not fail promotion', async () => {
  const h = integrationHarness();
  try {
    const spec = await h.seed('outcomes', [], ['fixture-red-suite']);
    h.store.updateTask({ taskId: spec.id, attempt: 1 }, current => {
      current.taskClass = 'claim';
      current.brief = { ...current.brief, kind: 'specification' };
    });
    const verifier = await h.seed('verified', [], ['bun', 'specs/support/verify-outcome-suite.ts', 'specs/x.test.ts']);
    const dev = h.head();
    await h.promote(async command => command[0] === 'fixture-red-suite' || command.includes('specs/support/verify-outcome-suite.ts') ? failure : success);
    expect(h.head('main')).toBe(dev);
    for (const task of [spec, verifier]) expect(h.store.task(task.id).state).toBe('merged');
  } finally { h.dispose(); }
});
