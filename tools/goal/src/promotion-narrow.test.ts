import { expect, test } from 'bun:test';
import { appendFileSync, existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { git } from './merge.ts';
import { integrationHarness } from './test-support.ts';

test('a root gate failure blocks the stabilize candidate without narrowing or bisecting it', async () => {
  const h = integrationHarness();
  try {
    const first = await h.seed('alpha');
    const culprit = await h.seed('bad');
    const last = await h.seed('omega');
    const dev = h.head(),
      main = h.head('main');
    h.settings.gate = ['root-gate'];
    h.settings.promotionParallelism = 2;
    const commands: string[] = [];
    await h.promote(async (command, cwd, log) => {
      commands.push(command.join(' '));
      const broken = existsSync(join(cwd, 'bad'));
      const failure = 'AssertionError: incompatible feature\n';
      const output = !broken
        ? ''
        : command[0] === 'root-gate'
          ? `Workspace @fixture/x finished in 1.00s\n$ bun run check  (services/x)\n${failure}\nFailed workspaces: services/x\n`
          : failure;
      appendFileSync(log, output);
      return { passed: !broken, output, timedOut: false };
    });
    expect(commands.filter((command) => command === 'root-gate')).toHaveLength(1);
    expect(commands).not.toContain('bun run --cwd services/x check');
    expect(git(h.root, 'diff', '--name-only', dev, 'dev')).toBe('');
    expect(h.head('main')).toBe(main);
    expect(h.store.promotion()?.phase).toBe('stabilize-blocked');
    for (const task of [first, culprit, last]) {
      expect(h.store.task(task.id).state).toBe('integrated');
      expect(h.store.task(task.id).currentAttempt).toBe(1);
    }
  } finally {
    h.dispose();
  }
});

test('pausing during a failing stabilize gate leaves main and dev where they are', async () => {
  const h = integrationHarness();
  try {
    for (const name of ['a', 'b', 'c', 'd', 'e', 'f']) await h.seed(name);
    await h.seed('bad');
    const dev = h.head(),
      main = h.head('main');
    h.settings.gate = ['root-gate'];
    h.settings.promotionParallelism = 1;
    let calls = 0;
    await h.promote(async (_command, cwd) => {
      const broken = existsSync(join(cwd, 'bad'));
      if (++calls === 1) writeFileSync(join(h.settings.stateDirectory, 'promotion.paused'), '');
      return { passed: !broken, output: broken ? 'AssertionError: incompatible feature\n' : '', timedOut: false };
    });
    expect(h.head()).toBe(dev);
    expect(h.head('main')).toBe(main);
    expect(calls).toBe(1);
    expect(h.store.promotion()?.phase).toBe('stabilize-blocked');
  } finally {
    h.dispose();
  }
});

test('a workspace failure is left on the stabilize candidate for a fix', async () => {
  const h = integrationHarness();
  try {
    await h.seed('alpha');
    const culprit = await h.seed('bad');
    await h.seed('omega');
    h.settings.gate = ['root-gate'];
    h.settings.promotionParallelism = 2;
    const commands: string[] = [];
    await h.promote(async (command, cwd, log) => {
      commands.push(command.join(' '));
      const broken = existsSync(join(cwd, 'bad'));
      const failure = 'AssertionError: incompatible feature\n';
      const output = !broken
        ? ''
        : command[0] === 'root-gate'
          ? `Workspace @fixture/kernel finished in 1.00s\n$ bun run check  (services/kernel)\n${failure}error: Kernel tests failed for 2 file(s):\ntest/a.test.ts\ntest/b.test.ts\n\nFailed workspaces: services/kernel\n`
          : failure;
      appendFileSync(log, output);
      return { passed: !broken, output, timedOut: false };
    });
    expect(commands).toEqual(['root-gate']);
    expect(h.store.task(culprit.id).currentAttempt).toBe(1);
    expect(h.store.promotion()?.phase).toBe('stabilize-blocked');
  } finally {
    h.dispose();
  }
});
