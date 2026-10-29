import { expect, test } from 'bun:test';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { SqliteManagerInbox } from './inbox.ts';
import { git } from './merge.ts';
import { integrationHarness, markdown } from './test-support.ts';
import type { GateRunner } from './merge.ts';

function dispatchStabilize(
  h: ReturnType<typeof integrationHarness>,
  file: string,
  manager: string,
) {
  const briefFile = join(h.settings.stateDirectory, `stabilize-${crypto.randomUUID()}.md`);
  const brief = markdown
    .replace('paths: [result.txt]', `paths: [${file}]`)
    .replace('goal: fixture', `goal: fixture\nmanager: ${manager}`)
    .replace('waiting: []', 'waiting: []\ntarget: stabilize');
  writeFileSync(briefFile, brief);
  const task = h.tasks.dispatch(briefFile);
  mkdirSync(join(task.worktree, '.temp'), { recursive: true });
  writeFileSync(join(task.worktree, '.temp/worker-plan.json'), JSON.stringify({ file, content: file }));
  return task;
}

const passingRunner: GateRunner = async () => ({ passed: true, output: '', timedOut: false });

test('stabilize-to-dev runs every newly integrated stabilize task acceptance against each merged candidate before advancing dev', async () => {
  const h = integrationHarness();
  try {
    h.ensureDev();
    git(h.root, 'branch', 'stabilize', h.head());
    const first = dispatchStabilize(h, 'first.txt', 'kernel');
    const second = dispatchStabilize(h, 'second.txt', 'semantic');
    await h.start(first);
    await h.start(second);

    const checked: { command: string[]; cwd: string }[] = [];
    const runner: GateRunner = async (command, cwd) => {
      if (command[1] === 'test')
        checked.push({ command: [...command], cwd });
      return passingRunner(command, cwd, join(h.settings.stateDirectory, 'acceptance.log'));
    };
    await h.train(runner);

    expect(h.outcomes.map(({ passed, stage }) => ({ passed, stage }))).toEqual([
      { passed: true, stage: 'merge' },
      { passed: true, stage: 'merge' },
    ]);
    expect(checked.map(({ command }) => command)).toEqual([
      ['bun', 'test'],
      ['bun', 'test'],
    ]);
    expect(existsSync(join(checked[0]!.cwd, 'first.txt'))).toBe(true);
    expect(existsSync(join(checked[1]!.cwd, 'second.txt'))).toBe(true);
    expect(git(h.root, 'merge-base', '--is-ancestor', h.head('stabilize'), 'dev')).toBe('');
  } finally {
    h.dispose();
  }
});

test('a failing stabilize acceptance keeps dev unchanged, leaves stabilize integrated, and notifies the task manager and supermanager', async () => {
  const h = integrationHarness();
  try {
    h.ensureDev();
    git(h.root, 'branch', 'stabilize', h.head());
    const task = dispatchStabilize(h, 'policy.txt', 'semantic');
    await h.start(task);
    const dev = h.head('dev');
    const runner: GateRunner = async (command) =>
      command[1] === 'test'
        ? { passed: false, output: 'AssertionError: pattern admission rejected\nExpected policy to pass', timedOut: false }
        : { passed: true, output: '', timedOut: false };
    await h.train(runner);

    const stabilized = h.store.task(task.id);
    expect(stabilized.state).toBe('integrated');
    expect(stabilized.integratedCommit).toBe(h.head('stabilize'));
    expect(h.head('dev')).toBe(dev);
    expect(() => git(h.root, 'merge-base', '--is-ancestor', h.head('stabilize'), 'dev')).toThrow();

    const inbox = new SqliteManagerInbox(h.store.db, h.settings.integration.inboxDirectory);
    for (const manager of ['semantic', h.settings.integration.supermanager]) {
      const notices = inbox.read(manager).map((entry) => entry.event.summary);
      expect(notices).toHaveLength(1);
      expect(notices[0]).toContain('bun test');
      expect(notices[0]).toContain('pattern admission rejected');
      expect(notices[0]).toContain('merged dev candidate');
      expect(notices[0]).toContain(task.id);
    }
  } finally {
    h.dispose();
  }
});
