import { expect, test } from 'bun:test';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { SqliteManagerInbox } from './inbox.ts';
import { git } from './merge.ts';
import { integrationHarness, markdown } from './test-support.ts';
import type { GateRunner } from './merge.ts';

function dispatchStabilize(h: ReturnType<typeof integrationHarness>, file: string, manager: string) {
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

const passed = { passed: true, output: '', timedOut: false };

test('stabilize checks each task acceptance before checking the merged dev candidate with the enabled typecheck', async () => {
  const h = integrationHarness();
  try {
    h.ensureDev();
    git(h.root, 'branch', 'stabilize', h.head());
    h.advanceDev('dev-only.txt');
    h.settings.integration.devPrelandingTypecheck = true;
    const first = dispatchStabilize(h, 'first.txt', 'kernel');
    const second = dispatchStabilize(h, 'second.txt', 'semantic');
    await h.start(first);
    await h.start(second);

    const checked: { check: string; files: string[] }[] = [];
    const runner: GateRunner = async (command, cwd) => {
      const check = command.includes('scripts/typecheck.ts') ? 'typecheck' : command.join(' ');
      if (check === 'bun test' || check === 'typecheck')
        checked.push({
          check,
          files: ['dev-only.txt', 'first.txt', 'second.txt'].filter((file) => existsSync(join(cwd, file))),
        });
      return passed;
    };
    await h.train(runner);

    expect(h.outcomes.map(({ passed, stage }) => ({ passed, stage }))).toEqual([
      { passed: true, stage: 'merge' },
      { passed: true, stage: 'merge' },
    ]);
    expect(checked).toEqual([
      { check: 'bun test', files: ['first.txt'] },
      { check: 'typecheck', files: ['dev-only.txt', 'first.txt'] },
      { check: 'bun test', files: ['first.txt', 'second.txt'] },
      { check: 'typecheck', files: ['dev-only.txt', 'first.txt', 'second.txt'] },
    ]);
    expect(git(h.root, 'merge-base', '--is-ancestor', h.head('stabilize'), 'dev')).toBe('');
  } finally {
    h.dispose();
  }
}, 30_000);

test('a failing merged dev typecheck leaves stabilize integrated and notifies the task manager and supermanager', async () => {
  const h = integrationHarness();
  try {
    h.ensureDev();
    git(h.root, 'branch', 'stabilize', h.head());
    h.advanceDev('dev-only.txt');
    h.settings.integration.devPrelandingTypecheck = true;
    const task = dispatchStabilize(h, 'policy.txt', 'semantic');
    await h.start(task);
    const dev = h.head('dev');
    let rejectedCandidate: string | undefined;
    const runner: GateRunner = async (command, cwd) => {
      if (
        !command.includes('scripts/typecheck.ts') ||
        !existsSync(join(cwd, 'policy.txt')) ||
        !existsSync(join(cwd, 'dev-only.txt'))
      )
        return passed;
      rejectedCandidate = git(cwd, 'rev-parse', 'HEAD');
      return { passed: false, output: 'policy.ts(1,1): error TS2322: fixture policy type mismatch', timedOut: false };
    };
    await h.train(runner);

    const stabilized = h.store.task(task.id);
    expect(stabilized.state).toBe('integrated');
    expect(stabilized.integratedCommit).toBe(h.head('stabilize'));
    expect(rejectedCandidate).toBeDefined();
    expect(h.head('dev')).toBe(dev);
    expect(() => git(h.root, 'merge-base', '--is-ancestor', h.head('stabilize'), 'dev')).toThrow();

    const inbox = new SqliteManagerInbox(h.store.db, h.settings.integration.inboxDirectory);
    for (const manager of ['semantic', h.settings.integration.supermanager]) {
      const notices = inbox.read(manager).map((entry) => entry.event.summary);
      expect(notices).toHaveLength(1);
      expect(notices[0]).toContain('bun scripts/typecheck.ts');
      expect(notices[0]).toContain('TS2322: fixture policy type mismatch');
      expect(notices[0]).toContain(`dev candidate ${rejectedCandidate}`);
      expect(notices[0]).toContain(task.id);
    }
  } finally {
    h.dispose();
  }
}, 30_000);
