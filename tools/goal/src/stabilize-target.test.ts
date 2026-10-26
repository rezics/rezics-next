import { expect, test } from 'bun:test';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseBrief, readRiskOwnership } from './briefs.ts';
import { run } from './cli.ts';
import { SqliteManagerInbox } from './inbox.ts';
import { git } from './merge.ts';
import { integrationHarness, markdown } from './test-support.ts';

const ownership = () => readRiskOwnership(join(import.meta.dir, '../risk-areas.json'));

function briefText(file: string, target = false, manager?: string): string {
  let text = markdown
    .replace('paths: [result.txt]', `paths: [${file}]`)
    .replace('command: [bun, test]', 'command: ["true"]');
  if (manager) text = text.replace('goal: fixture', `goal: fixture\nmanager: ${manager}`);
  if (target) text = text.replace('waiting: []', 'waiting: []\ntarget: stabilize');
  return text;
}

function dispatch(h: ReturnType<typeof integrationHarness>, file: string, target = false, manager?: string) {
  const briefFile = join(h.settings.stateDirectory, `brief-${crypto.randomUUID()}.md`);
  writeFileSync(briefFile, briefText(file, target, manager));
  const task = h.tasks.dispatch(briefFile);
  mkdirSync(join(task.worktree, '.temp'), { recursive: true });
  writeFileSync(join(task.worktree, '.temp/worker-plan.json'), JSON.stringify({ file, content: file }));
  return task;
}

function advance(root: string, state: string, branch: string, file: string, content: string): string {
  const tree = join(state, `advance-${crypto.randomUUID()}`);
  git(root, 'worktree', 'add', '--detach', tree, branch);
  try {
    writeFileSync(join(tree, file), content);
    git(tree, 'add', '--', file);
    git(tree, 'commit', '-qm', `Change ${file}`);
    const next = git(tree, 'rev-parse', 'HEAD');
    git(root, 'update-ref', `refs/heads/${branch}`, next, git(root, 'rev-parse', branch));
    return next;
  } finally {
    git(root, 'worktree', 'remove', '--force', tree);
  }
}

test('a brief target other than stabilize is refused and an absent target stays absent', () => {
  expect(() =>
    parseBrief(briefText('result.txt').replace('waiting: []', 'waiting: []\ntarget: dev'), ownership()),
  ).toThrow(/stabilize/);
  expect(parseBrief(briefText('result.txt', true), ownership()).target).toBe('stabilize');
  expect(parseBrief(markdown, ownership()).target).toBeUndefined();
});

test('a brief with target stabilize starts its worktree at the stabilize head and a brief without target starts at the integration branch head', async () => {
  const h = integrationHarness();
  try {
    h.ensureDev();
    const cut = h.head();
    git(h.root, 'branch', 'stabilize', cut);
    const dev = h.advanceDev('only-dev', 'only-dev');
    const stabilize = dispatch(h, 'fix', true);
    const plain = dispatch(h, 'plain');
    expect(git(stabilize.worktree, 'rev-parse', 'HEAD')).toBe(cut);
    expect(h.store.task(stabilize.id).base).toBe(cut);
    expect(existsSync(join(stabilize.worktree, 'only-dev'))).toBe(false);
    expect(git(plain.worktree, 'rev-parse', 'HEAD')).toBe(dev);
    expect(h.store.task(plain.id).base).toBe(dev);
    expect(readFileSync(join(plain.worktree, 'only-dev'), 'utf8')).toBe('only-dev');

    const moved = advance(h.root, h.settings.stateDirectory, 'stabilize', 'only-stabilize', 'only-stabilize');
    await h.job.start(stabilize.id);
    await h.job.drain();
    const retried = h.store.task(stabilize.id);
    expect(retried.base).toBe(moved);
    expect(readFileSync(join(retried.worktree, 'only-stabilize'), 'utf8')).toBe('only-stabilize');
    expect(h.head()).toBe(dev);
  } finally {
    h.dispose();
  }
});

test('dispatching a target stabilize brief is refused while the stabilize branch does not exist', () => {
  const h = integrationHarness();
  try {
    h.ensureDev();
    const briefFile = join(h.settings.stateDirectory, 'missing-stabilize.md');
    writeFileSync(briefFile, briefText('fix', true));
    expect(git(h.root, 'branch', '--list', 'stabilize')).toBe('');
    expect(() => h.tasks.dispatch(briefFile)).toThrow(/stabilize branch stabilize does not exist/);
    expect(git(h.root, 'branch', '--list', 'stabilize')).toBe('');
    expect(h.store.tasks()).toEqual([]);
    const plain = dispatch(h, 'plain');
    expect(h.store.task(plain.id).base).toBe(h.head());
  } finally {
    h.dispose();
  }
});

test('the train integrates a stabilize task into stabilize and then dev contains the new stabilize head', async () => {
  const h = integrationHarness();
  try {
    h.ensureDev();
    const main = h.head('main');
    git(h.root, 'branch', 'stabilize', h.head());
    const task = dispatch(h, 'fixed.txt', true);
    await h.start(task);
    await h.train();
    const stabilizeHead = h.head('stabilize');
    const integrated = h.store.task(task.id);
    expect(integrated.state).toBe('integrated');
    expect(integrated.integratedCommit).toBe(stabilizeHead);
    expect(h.outcomes[0]?.passed).toBe(true);
    expect(h.outcomes[0]?.mergedCommit).toBe(stabilizeHead);
    expect(git(h.root, 'merge-base', '--is-ancestor', stabilizeHead, 'dev')).toBe('');
    expect(git(h.root, 'rev-parse', 'dev^2')).toBe(stabilizeHead);
    expect(git(h.root, 'show', 'dev:fixed.txt')).toBe('fixed.txt');
    expect(h.head('main')).toBe(main);
  } finally {
    h.dispose();
  }
});

test('a stabilize commit that does not merge into dev leaves stabilize advanced and notifies the task manager and the supermanager', async () => {
  const h = integrationHarness();
  try {
    h.ensureDev();
    git(h.root, 'branch', 'stabilize', h.head());
    const dev = h.advanceDev('README.md', 'from dev\n');
    const task = dispatch(h, 'README.md', true, 'kernel');
    await h.start(task);
    await h.train();
    const stabilizeHead = h.head('stabilize');
    const integrated = h.store.task(task.id);
    expect(integrated.state).toBe('integrated');
    expect(integrated.integratedCommit).toBe(stabilizeHead);
    expect(h.head()).toBe(dev);
    expect(() => git(h.root, 'merge-base', '--is-ancestor', stabilizeHead, 'dev')).toThrow();
    const inbox = new SqliteManagerInbox(h.store.db, h.settings.integration.inboxDirectory);
    for (const manager of ['kernel', h.settings.integration.supermanager]) {
      const summaries = inbox.read(manager).map((entry) => entry.event.summary);
      expect(summaries).toHaveLength(1);
      expect(summaries[0]).toContain(task.id);
      expect(summaries[0]).toContain(stabilizeHead);
      expect(summaries[0]).toContain('README.md');
    }
  } finally {
    h.dispose();
  }
});

test('retarget moves a task that is not integrated and whose base is an ancestor of stabilize and is refused otherwise', async () => {
  const h = integrationHarness();
  try {
    h.ensureDev();
    const early = dispatch(h, 'early');
    expect(() => h.tasks.retarget(early.id, 'stabilize')).toThrow(/does not exist/);
    expect(h.store.task(early.id).brief.target).toBeUndefined();

    const cut = h.head();
    git(h.root, 'branch', 'stabilize', cut);
    const state = h.store.task(early.id).state;
    const attempt = h.store.task(early.id).currentAttempt;
    const previousTrain = process.env.GOAL_TRAIN_MODE;
    const previousTask = process.env.GOAL_TASK_ID;
    const previousAttempt = process.env.GOAL_ATTEMPT;
    delete process.env.GOAL_TASK_ID;
    delete process.env.GOAL_ATTEMPT;
    try {
      expect(
        await run(
          ['retarget', early.id, 'stabilize'],
          async () =>
            ({
              db: { close() {}, query: () => ({ get: () => undefined, all: () => [] }) },
              job: {},
              tasks: h.tasks,
              store: h.store,
              managerSocket: join(h.settings.stateDirectory, 'missing.sock'),
            }) as never,
        ),
      ).toBe(0);
    } finally {
      if (previousTrain === undefined) delete process.env.GOAL_TRAIN_MODE;
      else process.env.GOAL_TRAIN_MODE = previousTrain;
      if (previousTask === undefined) delete process.env.GOAL_TASK_ID;
      else process.env.GOAL_TASK_ID = previousTask;
      if (previousAttempt === undefined) delete process.env.GOAL_ATTEMPT;
      else process.env.GOAL_ATTEMPT = previousAttempt;
    }
    const moved = h.store.task(early.id);
    expect(moved.brief.target).toBe('stabilize');
    expect(moved.brief.markdown).toContain('target: stabilize');
    expect(readFileSync(moved.briefPath, 'utf8')).toContain('target: stabilize');
    expect(moved.state).toBe(state);
    expect(moved.currentAttempt).toBe(attempt);

    const landing = dispatch(h, 'live');
    await h.start(landing);
    expect(h.store.task(landing.id).state).toBe('landing');
    h.tasks.retarget(landing.id, 'stabilize');
    expect(h.store.task(landing.id).state).toBe('landing');
    expect(h.store.task(landing.id).currentAttempt).toBe(1);
    expect(h.store.attempt({ taskId: landing.id, attempt: 1 }).state).not.toBe('stopped');

    h.advanceDev('ahead', 'ahead');
    const ahead = dispatch(h, 'ahead');
    expect(() => h.tasks.retarget(ahead.id, 'stabilize')).toThrow(/ancestor/);
    expect(h.store.task(ahead.id).brief.target).toBeUndefined();

    const cancelled = dispatch(h, 'cancel-me');
    await h.tasks.cancel(cancelled.id);
    expect(() => h.tasks.retarget(cancelled.id, 'stabilize')).toThrow(/cancelled/);

    const integrated = await h.seed('done');
    expect(() => h.tasks.retarget(integrated.id, 'stabilize')).toThrow(/integrated/);
    h.store.updateTask({ taskId: integrated.id, attempt: integrated.currentAttempt }, (task) => {
      task.state = 'merged';
    });
    expect(() => h.tasks.retarget(integrated.id, 'stabilize')).toThrow(/merged/);
    expect(() => h.tasks.retarget(early.id, 'dev')).toThrow(/stabilize/);
  } finally {
    h.dispose();
  }
});

test('tasks without target integrate into dev exactly as before', async () => {
  const h = integrationHarness();
  try {
    h.ensureDev();
    const main = h.head('main');
    git(h.root, 'branch', 'stabilize', h.head());
    const stabilizeBefore = h.head('stabilize');
    const task = h.dispatch('plain');
    await h.start(task);
    const worker = h.head(task.branch);
    await h.train();
    expect(h.outcomes[0]?.passed).toBe(true);
    expect(h.store.task(task.id).state).toBe('integrated');
    expect(h.store.task(task.id).integratedCommit).toBe(worker);
    expect(h.head()).toBe(worker);
    expect(h.head('stabilize')).toBe(stabilizeBefore);
    expect(() => git(h.root, 'rev-parse', 'dev^2')).toThrow();
    expect(h.head('main')).toBe(main);
    expect(
      new SqliteManagerInbox(h.store.db, h.settings.integration.inboxDirectory).read(
        h.settings.integration.supermanager,
      ),
    ).toEqual([]);
  } finally {
    h.dispose();
  }
});
