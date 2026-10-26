import { expect, test } from 'bun:test';
import { appendFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { git } from './merge.ts';
import { integrationHarness } from './test-support.ts';

const failure = { passed: false, output: 'AssertionError: incompatible fixture', timedOut: false };
const success = { passed: true, output: '', timedOut: false };

function createStabilize(h: ReturnType<typeof integrationHarness>, commit = h.head()): void {
  git(h.root, 'branch', 'stabilize', commit);
}

test('stabilize gates its head instead of the integration head and advances to dev after publishing', async () => {
  const h = integrationHarness();
  try {
    const stable = await h.seed('stable');
    const candidate = h.head();
    createStabilize(h, candidate);
    const later = await h.seed('later');
    const dev = h.head();
    const gated: string[] = [];

    await h.promote(async (_command, cwd) => {
      gated.push(git(cwd, 'rev-parse', 'HEAD'));
      return success;
    });

    expect(gated).toContain(candidate);
    expect(gated).not.toContain(dev);
    expect(h.head('main')).toBe(candidate);
    expect(h.head('stabilize')).toBe(dev);
    expect(h.store.task(stable.id).state).toBe('merged');
    expect(h.store.task(later.id).state).toBe('integrated');
  } finally { h.dispose(); }
});

test('a failing stabilize gate blocks that candidate without bisecting or reverting and notifies once', async () => {
  const h = integrationHarness();
  try {
    await h.seed('stable');
    await h.seed('bad');
    const candidate = h.head();
    createStabilize(h, candidate);
    await h.seed('later');
    let gates = 0;

    const runGate = async (_command: string[], _cwd: string, log: string) => {
      gates++;
      const output = 'Workspace @fixture/kernel finished in 1.00s\n'
        + '$ bun run check  (services/kernel)\n'
        + 'AssertionError: incompatible fixture\n'
        + 'error: Kernel tests failed for 1 file(s):\n'
        + 'test/bad.test.ts\n\nFailed workspaces: services/kernel\n';
      appendFileSync(log, output);
      return { ...failure, output };
    };
    await h.promote(runGate);
    const run = h.store.promotion()!;
    expect(run.phase).toBe('stabilize-blocked');
    expect(gates).toBe(1);
    expect(h.inbox).toHaveLength(1);
    expect(h.inbox[0]?.managerId).toBe(h.settings.integration.supermanager);
    expect(h.inbox[0]?.summary).toContain('services/kernel');
    expect(h.inbox[0]?.summary).toContain('test/bad.test.ts');
    expect(h.inbox[0]?.summary).toContain(`${h.settings.stateDirectory}/promotion-${run.id}-head-0.log`);
    expect(h.head('main')).not.toBe(candidate);
    expect(h.head('stabilize')).toBe(candidate);
  } finally { h.dispose(); }
});

test('a blocked stabilize candidate is gated again only after its head moves', async () => {
  const h = integrationHarness();
  try {
    await h.seed('stable');
    const candidate = h.head();
    createStabilize(h, candidate);
    let gates = 0;
    const runGate = async () => {
      gates++;
      return gates === 1 ? failure : success;
    };

    await h.promote(runGate);
    await h.promote(runGate);
    expect(gates).toBe(1);

    const moved = h.advanceDev('later');
    git(h.root, 'update-ref', 'refs/heads/stabilize', moved, candidate);
    await h.promote(runGate);
    expect(gates).toBe(2);
  } finally { h.dispose(); }
});

test('a stabilize publish leaves the branch and notifies when dev does not contain main', async () => {
  const h = integrationHarness();
  try {
    await h.seed('stable');
    const candidate = h.head();
    createStabilize(h, candidate);
    git(h.root, 'update-ref', 'refs/heads/dev', h.head('main'), candidate);

    await h.promote(async () => success);

    expect(h.head('main')).toBe(candidate);
    expect(h.head('stabilize')).toBe(candidate);
    expect(h.inbox).toHaveLength(1);
    expect(h.inbox[0]?.managerId).toBe(h.settings.integration.supermanager);
    expect(h.inbox[0]?.summary).toContain('dev');
    expect(h.inbox[0]?.summary).toContain('main');
  } finally { h.dispose(); }
});

test('promotion without a stabilize branch keeps its existing failure behavior', async () => {
  const h = integrationHarness();
  try {
    const first = await h.seed('first');
    const bad = await h.seed('bad');
    const dev = h.head();
    await h.seed('last');

    await h.promote(async (_command, cwd) => existsSync(join(cwd, 'bad')) ? failure : success);

    expect(h.store.task(first.id).state).toBe('merged');
    expect(h.store.task(bad.id).currentAttempt).toBe(2);
    expect(h.head('main')).not.toBe(dev);
  } finally { h.dispose(); }
});
