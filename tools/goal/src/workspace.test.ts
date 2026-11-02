import { expect, test } from 'bun:test';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { delimiter, dirname, join } from 'node:path';
import { loadSettings } from './config.ts';
import { SqliteLandingQueue } from './land.ts';
import { workerPrompt } from './launch.ts';
import { MergeTrain } from './merge-train.ts';
import type { GateOutcome } from './contracts.ts';
import { makeRecord, readMeasurement } from './records.ts';
import { settle } from './settle.ts';
import { sameProcess } from './process.ts';
import { git, WorkerTasks } from './tasks.ts';
import { harness, markdown } from './test-support.ts';
import type { Task } from './types.ts';
import {
  isAncestor,
  readWebModules,
  taskCommits,
  taskChangedPaths,
  webModule,
  WorkspaceController,
} from './workspace.ts';

const library = 'apps/web/src/library/';
function fixture(script?: string) {
  const h = harness(script);
  h.settings.formatCommand = ['true'];
  h.settings.sharedWebModules = {
    library: [`${library}**`, 'apps/web/src/stories/library-*.stories.tsx', 'apps/web/tests/library*.test.ts'],
  };
  const controller = new WorkspaceController(h.settings, h.store);
  const prompts = new Map<string, string>();
  const tasks = new WorkerTasks(h.settings, h.store, undefined, async (store, task, attempt, _pool, prompt) => {
    prompts.set(task.id, prompt);
    mkdirSync(dirname(attempt.logPath), { recursive: true });
    writeFileSync(
      attempt.logPath,
      JSON.stringify({ type: 'thread.started', thread_id: task.id }) +
        '\n' +
        JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'RESULT: success' } }) +
        '\n',
    );
    store.updateAttempt(attempt, (current) => {
      current.state = 'running';
    });
    store.updateTask(attempt, (current) => {
      current.state = 'running';
    });
    return { attempt: store.attempt(attempt), exited: new Promise(() => {}) };
  });
  function dispatch(paths: string[], name = crypto.randomUUID() as string, extra = '', frozen = '') {
    const brief = join(h.settings.stateDirectory, `${name}.md`);
    writeFileSync(
      brief,
      markdown
        .replace('goal: fixture', 'goal: web')
        .replace('paths: [result.txt]', `paths: ${JSON.stringify(paths)}`)
        .replace('command: [bun, test]', `command: ${JSON.stringify(['true', name])}`)
        .replace('waiting: []', `waiting: []\n${extra}`) + frozen,
    );
    return tasks.dispatch(brief);
  }
  function commit(task: Task, path: string, content = path, message = 'Complete work') {
    mkdirSync(dirname(join(task.worktree, path)), { recursive: true });
    writeFileSync(join(task.worktree, path), content);
    git(task.worktree, ['add', '--', path]);
    git(task.worktree, [
      'commit',
      '--only',
      '-m',
      `${task.workspace!.taskName}: ${message}`,
      '-m',
      `Goal-Task: ${task.id}`,
      '--',
      path,
    ]);
    return git(task.worktree, ['rev-parse', 'HEAD']);
  }
  function finish(task: Task) {
    task = h.store.task(task.id);
    const ref = { taskId: task.id, attempt: task.currentAttempt };
    h.store.updateAttempt(ref, (attempt) => {
      attempt.state = 'exited';
      attempt.endedAt = new Date().toISOString();
    });
    h.store.putRecord(makeRecord(task, h.store.attempt(ref), readMeasurement(h.store.attempt(ref))));
    return h.store.updateTask(ref, (current) => {
      current.state = 'landing';
    });
  }
  const queue = new SqliteLandingQueue(h.store.db, h.store);
  function enqueue(task: Task) {
    task = h.store.task(task.id);
    queue.enqueue({
      taskId: task.id,
      attempt: task.currentAttempt,
      branch: task.branch,
      worktree: task.worktree,
      declaredPaths: task.brief.paths,
      protectedPaths: tasks.protectedPaths(task.brief),
      gate: task.brief.acceptance.command,
    });
  }
  function advanceDev(path = 'external.txt') {
    const tree = join(h.settings.stateDirectory, `external-${crypto.randomUUID()}`);
    git(h.root, ['worktree', 'add', '--detach', tree, 'dev']);
    try {
      writeFileSync(join(tree, path), 'external dev work');
      git(tree, ['add', '--', path]);
      git(tree, ['commit', '-m', 'External dev work']);
      git(h.root, ['update-ref', 'refs/heads/dev', git(tree, ['rev-parse', 'HEAD'])]);
    } finally {
      git(h.root, ['worktree', 'remove', '--force', tree]);
    }
  }
  return { ...h, tasks, controller, dispatch, commit, finish, enqueue, queue, prompts, advanceDev };
}

test("tasks whose declared paths all fall inside one configured module run at the same time in that module's single shared worktree, with no reservation or hold between them, and tasks outside every module keep isolated worktrees", async () => {
  const h = fixture();
  try {
    const tasks = Array.from({ length: 4 }, (_, i) => h.dispatch([`${library}same.ts`], `peer-${i}`));
    const first = tasks[0]!;
    expect(new Set(tasks.map((task) => task.worktree)).size).toBe(1);
    expect(first.branch).toBe('ws/library');
    expect(tasks.every((task) => task.state === 'ready' && task.brief.after.length === 0)).toBe(true);
    await Promise.all(tasks.map((task) => h.tasks.retry(task.id)));
    expect(tasks.every((task) => h.store.task(task.id).state === 'running')).toBe(true);
    expect(h.store.runningAttemptsCount()).toBe(4);
    expect(
      h.store.db
        .query(
          "SELECT name FROM sqlite_master WHERE name IN ('workspace_owners', 'workspace_operations', 'workspace_prepared')",
        )
        .all(),
    ).toEqual([]);
    const isolated = h.dispatch(['other.txt']);
    const secondIsolated = h.dispatch(['elsewhere.txt']);
    expect(isolated.workspace).toBeUndefined();
    expect(isolated.worktree).not.toBe(first.worktree);
    expect(isolated.worktree).not.toBe(secondIsolated.worktree);
    expect(h.dispatch([`${library}a.ts`, 'other.txt']).workspace).toBeUndefined();
    git(h.root, ['branch', 'stabilize', 'dev']);
    expect(h.dispatch([`${library}a.ts`], 'stabilize', 'target: stabilize').workspace).toBeUndefined();
    const story = h.dispatch(['apps/web/src/stories/library-page.stories.tsx']);
    const testTask = h.dispatch(['apps/web/tests/library-page.test.ts']);
    expect(story.worktree).toBe(first.worktree);
    expect(testTask.worktree).toBe(first.worktree);
    expect(git(first.worktree, ['rev-parse', 'ws/library'])).toBe(first.base);
    expect(git(h.root, ['branch', '--show-current'])).toBe('main');
  } finally {
    h.dispose();
  }
});

test("each worker commits its own work in the shared worktree with the subject '<task name>: <message>' and a 'Goal-Task: <task id>' trailer, and the controller attributes commits to tasks by that trailer", async () => {
  const h = fixture();
  try {
    const first = h.dispatch([`${library}a.ts`], 'library-page');
    const peer = h.dispatch([`${library}b.ts`], 'library-controls');
    await h.tasks.retry(first.id);
    const prompt = h.prompts.get(first.id)!;
    expect(prompt).toContain('Peers edit this tree at the same time');
    expect(prompt).toContain('git add <your paths> (never -A or .)');
    expect(prompt).toContain('library-page: <message>');
    expect(prompt).toContain(`Goal-Task: ${first.id}`);
    expect(prompt).toContain('Never reset, checkout, stash, clean or rebase');
    expect(prompt).toContain("peer's work in progress");
    expect(workerPrompt(h.dispatch(['isolated.txt']), undefined, undefined, [], h.root)).not.toContain('Peers edit');
    mkdirSync(join(peer.worktree, library), { recursive: true });
    writeFileSync(join(peer.worktree, library, 'b.ts'), 'unfinished peer');
    git(peer.worktree, ['add', '--', `${library}b.ts`]);
    const firstCommit = h.commit(first, `${library}a.ts`);
    expect(git(first.worktree, ['show', '-s', '--format=%s', firstCommit])).toBe('library-page: Complete work');
    expect(git(first.worktree, ['diff-tree', '--no-commit-id', '--name-only', '-r', firstCommit])).toBe(
      `${library}a.ts`,
    );
    expect(git(peer.worktree, ['diff', '--cached', '--name-only'])).toBe(`${library}b.ts`);
    expect(h.tasks.commitFinishedWork(first, 1)).toBe(false);
    const peerCommit = h.commit(peer, `${library}b.ts`, 'finished peer');
    // A matching subject or a line in the body is not a Git trailer.
    git(first.worktree, [
      'commit',
      '--allow-empty',
      '-m',
      `Goal-Task: ${first.id}`,
      '-m',
      `Goal-Task: ${peer.id}\nThis is ordinary prose.`,
    ]);
    expect(taskCommits(first)).toEqual([firstCommit]);
    expect(taskCommits(peer)).toEqual([peerCommit]);
    expect(taskChangedPaths(first)).toEqual([`${library}a.ts`]);
  } finally {
    h.dispose();
  }
});

test('the train lands the workspace branch on dev with the usual checks and marks integrated every task whose commits are all on dev; dev is merged into the workspace only while no worker runs in it', async () => {
  const h = fixture();
  try {
    const first = h.dispatch([`${library}a.ts`], 'page');
    const peer = h.dispatch([`${library}b.ts`], 'controls');
    await Promise.all([h.tasks.retry(first.id), h.tasks.retry(peer.id)]);
    const a = h.commit(first, `${library}a.ts`),
      b = h.commit(peer, `${library}b.ts`);
    h.advanceDev();
    h.finish(first);
    h.enqueue(first);
    const gates: string[][] = [];
    const outcomes: GateOutcome[] = [];
    await new MergeTrain({
      ...h.settings,
      queue: h.queue,
      fence: h.store,
      sink: {
        onGateOutcome: (outcome) => {
          outcomes.push(outcome);
        },
      },
      integration: { batchSize: 4 },
      integrationChecks: [{ paths: [`${library}**`], command: ['true'] }],
      runGate: async (command, cwd) => {
        expect(cwd).not.toBe(first.worktree);
        expect(readFileSync(join(cwd, 'external.txt'), 'utf8')).toBe('external dev work');
        expect(existsSync(join(cwd, library, 'a.ts'))).toBe(true);
        expect(existsSync(join(cwd, library, 'b.ts'))).toBe(true);
        gates.push([...command]);
        return { passed: true, output: '', timedOut: false };
      },
    }).run();
    expect(gates).toEqual([first.brief.acceptance.command, peer.brief.acceptance.command]);
    expect(outcomes[0]?.passed).toBe(true);
    expect(readFileSync(outcomes[0]!.logPath, 'utf8')).toContain('Integration check on');
    expect(isAncestor(h.root, a, 'dev')).toBe(true);
    expect(isAncestor(h.root, b, 'dev')).toBe(true);
    expect(h.store.task(first.id).state).toBe('integrated');
    expect(h.store.task(peer.id).state).toBe('integrated');
    expect(h.store.task(first.id).integratedCommits).toEqual([a]);
    expect(h.store.task(peer.id).integratedCommits).toEqual([b]);
    expect(existsSync(join(first.worktree, 'external.txt'))).toBe(false);
    expect(await h.controller.withLaunch('library', () => h.controller.syncIdle('library'))).toBe(false);
    h.finish(peer);
    expect(await h.controller.withLaunch('library', () => h.controller.syncIdle('library'))).toBe(true);
    expect(existsSync(join(first.worktree, 'external.txt'))).toBe(true);
    expect(isAncestor(first.worktree, 'dev', 'HEAD')).toBe(true);
    expect(git(h.root, ['branch', '--show-current'])).toBe('main');
  } finally {
    h.dispose();
  }
});

test('a peer commit made during landing stays pending until its own source commits are on dev', async () => {
  const h = fixture();
  try {
    const first = h.dispatch([`${library}a.ts`], 'page'),
      peer = h.dispatch([`${library}b.ts`], 'controls');
    await Promise.all([h.tasks.retry(first.id), h.tasks.retry(peer.id)]);
    h.commit(first, `${library}a.ts`);
    h.commit(peer, `${library}b.ts`, 'first version');
    h.finish(first);
    h.enqueue(first);
    let later = '';
    await new MergeTrain({
      ...h.settings,
      queue: h.queue,
      fence: h.store,
      sink: { onGateOutcome() {} },
      runGate: async () => {
        if (!later) later = h.commit(peer, `${library}b.ts`, 'second version');
        return { passed: true, output: '', timedOut: false };
      },
    }).run();
    expect(h.store.task(first.id).state).toBe('integrated');
    expect(h.store.task(peer.id).state).toBe('running');
    expect(isAncestor(h.root, later, 'dev')).toBe(false);
    h.finish(peer);
    h.enqueue(peer);
    await new MergeTrain({
      ...h.settings,
      queue: h.queue,
      fence: h.store,
      sink: { onGateOutcome() {} },
      runGate: async () => ({ passed: true, output: '', timedOut: false }),
    }).run();
    expect(h.store.task(peer.id).state).toBe('integrated');
    expect(isAncestor(h.root, later, 'dev')).toBe(true);
  } finally {
    h.dispose();
  }
});

test('a failing peer acceptance returns to that task and leaves the unrelated landing queued', async () => {
  const h = fixture();
  try {
    const first = h.dispatch([`${library}a.ts`], 'page'),
      peer = h.dispatch([`${library}b.ts`], 'controls');
    await Promise.all([h.tasks.retry(first.id), h.tasks.retry(peer.id)]);
    h.commit(first, `${library}a.ts`);
    h.commit(peer, `${library}b.ts`);
    h.finish(first);
    h.finish(peer);
    h.enqueue(first);
    const before = git(h.root, ['rev-parse', 'dev']);
    const outcomes: GateOutcome[] = [];
    await new MergeTrain({
      ...h.settings,
      queue: h.queue,
      fence: h.store,
      sink: {
        onGateOutcome: (outcome) => {
          outcomes.push(outcome);
        },
      },
      runGate: async (command) => ({
        passed: command[1] !== 'controls',
        output: 'peer assertion failed',
        timedOut: false,
      }),
    }).run();
    expect(outcomes.map((outcome) => outcome.taskId)).toEqual([peer.id]);
    expect(outcomes[0]?.passed).toBe(false);
    expect(h.queue.next()?.request.taskId).toBe(first.id);
    expect(git(h.root, ['rev-parse', 'dev'])).toBe(before);
    expect(h.store.task(first.id).state).toBe('landing');
  } finally {
    h.dispose();
  }
});

test('shared retries and settlement preserve staged and unstaged peer work and never claim a peer commit', async () => {
  const h = fixture();
  try {
    const first = h.dispatch([`${library}a.ts`], 'page'),
      peer = h.dispatch([`${library}b.ts`], 'controls');
    const initial = await h.tasks.retry(first.id);
    await h.tasks.retry(peer.id);
    h.commit(peer, `${library}b.ts`);
    writeFileSync(join(peer.worktree, library, 'dirty.ts'), 'peer staged');
    git(peer.worktree, ['add', '--', `${library}dirty.ts`]);
    writeFileSync(join(peer.worktree, library, 'unfinished.ts'), 'peer unstaged');
    h.advanceDev();
    await h.tasks.stop(first.id);
    const retry = await h.tasks.retry(first.id);
    expect(retry.attempt.attempt).toBe(initial.attempt.attempt + 1);
    expect(git(peer.worktree, ['diff', '--cached', '--name-only'])).toBe(`${library}dirty.ts`);
    expect(readFileSync(join(peer.worktree, library, 'unfinished.ts'), 'utf8')).toBe('peer unstaged');
    expect(taskCommits(first)).toEqual([]);
    expect(existsSync(join(peer.worktree, 'external.txt'))).toBe(false);
    await settle(h.tasks, { attempt: retry.attempt, exited: Promise.resolve({ code: 0, signal: null }) }, h.queue);
    expect(taskCommits(first)).toEqual([]);
    expect(h.store.attempt({ taskId: peer.id, attempt: 1 }).state).toBe('running');
    expect(git(peer.worktree, ['diff', '--cached', '--name-only'])).toBe(`${library}dirty.ts`);
    expect(h.queue.next()?.request.taskId).toBe(first.id);
    const outcomes: GateOutcome[] = [];
    await new MergeTrain({
      ...h.settings,
      queue: h.queue,
      fence: h.store,
      sink: {
        onGateOutcome: (outcome) => {
          outcomes.push(outcome);
        },
      },
    }).run();
    expect(outcomes[0]?.passed).toBe(false);
    expect(outcomes[0]?.firstFailure?.excerpt).toContain('No Goal-Task trailer commits');
  } finally {
    h.dispose();
  }
});

test('idle merges preserve dirty files, pending launches prevent merges, and module configuration is local and conservative', async () => {
  const h = fixture();
  try {
    const task = h.dispatch([`${library}nested/file.ts`]);
    expect(task.workspace?.module).toBe('library');
    h.advanceDev();
    writeFileSync(join(task.worktree, 'dirty.txt'), 'preserve me');
    expect(await h.controller.withLaunch('library', () => h.controller.syncIdle('library'))).toBe(false);
    expect(readFileSync(join(task.worktree, 'dirty.txt'), 'utf8')).toBe('preserve me');
    const worker = await h.tasks.retry(task.id);
    h.store.updateAttempt(worker.attempt, (attempt) => {
      attempt.state = 'pending';
    });
    rmSync(join(task.worktree, 'dirty.txt'));
    expect(await h.controller.withLaunch('library', () => h.controller.syncIdle('library'))).toBe(false);
    h.store.updateAttempt(worker.attempt, (attempt) => {
      attempt.state = 'exited';
    });
    expect(await h.controller.withLaunch('library', () => h.controller.syncIdle('library'))).toBe(true);

    expect(webModule({ ...task.brief, paths: ['apps/web/src/**'] }, h.settings)).toBeUndefined();
    expect(readWebModules({ library: ['apps/web/tests/library*.test.ts'] })).toEqual({
      library: ['apps/web/tests/library*.test.ts'],
    });
    expect(() => readWebModules({ one: [`${library}**`], two: [`${library}a.ts`] })).toThrow('overlap');
    expect(() => readWebModules({ bad: ['../outside'] })).toThrow();
    const local = JSON.parse(readFileSync(h.settings.localFile, 'utf8'));
    local.sharedWebModules = h.settings.sharedWebModules;
    writeFileSync(h.settings.localFile, JSON.stringify(local));
    expect(loadSettings({ cwd: h.root, env: {} }).sharedWebModules).toEqual(h.settings.sharedWebModules);
    const { sharedWebModules: _modules, ...isolatedSettings } = h.settings;
    expect(webModule(task.brief, isolatedSettings)).toBeUndefined();
  } finally {
    h.dispose();
  }
});

test('workspace sync reports ancestry failures and preserves merge errors when abort also fails', async () => {
  const h = fixture();
  h.dispatch([`${library}nested/file.ts`]);
  const bin = join(h.root, '.temp', 'bin');
  mkdirSync(bin, { recursive: true });
  const originalPath = process.env.PATH;
  const realGit = (originalPath ?? '').split(delimiter).map((path) => join(path, 'git')).find(existsSync)!;
  const marker = join(bin, 'seen-ancestry');
  const merges = join(bin, 'merges');
  const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
  writeFileSync(
    join(bin, 'git'),
    `#!/bin/sh
if [ "$1" = merge-base ]; then
    if [ ! -e ${quote(marker)} ]; then touch ${quote(marker)}; echo 'injected ancestry failure' >&2; exit 128; fi
    exit 1
fi
case "$1:$2" in
  merge:--no-edit) echo "$*" >> ${quote(merges)}; echo 'original merge failure' >&2; exit 2 ;;
  merge:--abort) echo "$*" >> ${quote(merges)}; echo 'abort cleanup failure' >&2; exit 3 ;;
esac
exec ${quote(realGit)} "$@"
`,
    { mode: 0o755 },
  );
  process.env.PATH = [bin, originalPath].filter(Boolean).join(delimiter);
  const sync = () => h.controller.withLaunch('library', () => h.controller.syncIdle('library'));
  try {
    await expect(sync()).rejects.toThrow(
      'git merge-base --is-ancestor refs/heads/dev HEAD failed: injected ancestry failure',
    );
    expect(existsSync(merges)).toBe(false);
    const failure = await sync().catch((error: unknown) => error as AggregateError);
    expect(failure).toBeInstanceOf(AggregateError);
    expect((failure as AggregateError).errors.map(String)).toEqual([
      'Error: original merge failure',
      'Error: abort cleanup failure',
    ]);
    expect((failure as AggregateError).cause).toBe((failure as AggregateError).errors[0]);
    expect(readFileSync(merges, 'utf8')).toBe('merge --no-edit refs/heads/dev\nmerge --abort\n');
  } finally {
    if (originalPath === undefined) delete process.env.PATH;
    else process.env.PATH = originalPath;
    h.dispose();
  }
});

test('controller frozen inputs use explicit paths without absorbing a peer index', async () => {
  const h = fixture();
  try {
    const first = h.dispatch([`${library}a.ts`]);
    mkdirSync(join(first.worktree, library), { recursive: true });
    writeFileSync(join(first.worktree, library, 'a.ts'), 'peer changes');
    git(first.worktree, ['add', '--', `${library}a.ts`]);
    const path = `${library}acceptance.test.ts`;
    const task = h.dispatch([path], 'frozen', '', `\n\x60\x60\x60ts path=${path}\nfrozen acceptance\n\x60\x60\x60\n`);
    expect(readFileSync(join(task.worktree, path), 'utf8')).toBe('frozen acceptance\n');
    expect(git(task.worktree, ['show', '--format=', '--name-only', 'HEAD'])).toBe(path);
    expect(git(task.worktree, ['diff', '--cached', '--name-only'])).toBe(`${library}a.ts`);
    expect(taskCommits(task)).toEqual([]);
  } finally {
    h.dispose();
  }
});

test('settling a real shared worker leaves a live peer process running', async () => {
  const h = fixture(`#!/usr/bin/env bun
import { mkdirSync, writeFileSync } from 'node:fs';
mkdirSync('.temp', { recursive: true });
console.log(JSON.stringify({type:'thread.started',thread_id:process.env.GOAL_TASK_ID}));
console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:'RESULT: success'}}));
writeFileSync('.temp/ready-' + process.env.GOAL_TASK_ID, 'ready');
setInterval(() => {}, 1000);
`);
  const real = new WorkerTasks(h.settings, h.store);
  let peer: Task | undefined;
  let first: Task | undefined;
  try {
    first = h.dispatch([`${library}a.ts`]);
    peer = h.dispatch([`${library}b.ts`]);
    const a = await real.retry(first.id),
      b = await real.retry(peer.id);
    const deadline = Date.now() + 20_000;
    while (
      (!existsSync(join(first.worktree, '.temp/ready-' + first.id)) ||
        !existsSync(join(peer.worktree, '.temp/ready-' + peer.id))) &&
      Date.now() < deadline
    )
      await new Promise((resolve) => setTimeout(resolve, 10));
    expect(existsSync(join(first.worktree, '.temp/ready-' + first.id))).toBe(true);
    expect(existsSync(join(peer.worktree, '.temp/ready-' + peer.id))).toBe(true);
    await settle(real, { attempt: a.attempt, exited: Promise.resolve({ code: 0, signal: null }) }, h.queue);
    expect(sameProcess(h.store.attempt(b.attempt).process!)).toBe(true);
    expect(h.store.attempt(b.attempt).state).toBe('running');
  } finally {
    if (first && h.store.task(first.id).currentAttempt) await real.stop(first.id);
    if (peer && h.store.task(peer.id).currentAttempt) await real.stop(peer.id);
    h.dispose();
  }
}, 30_000);

test('shared tasks retain explicit cross-target dependencies until their commits reach dev', async () => {
  const h = fixture();
  try {
    const seed = h.dispatch(['seed.txt']);
    git(h.root, ['branch', 'stabilize', seed.base]);
    const dependency = h.dispatch(['fix.txt'], 'stabilize-fix', 'target: stabilize');
    writeFileSync(join(dependency.worktree, 'fix.txt'), 'required fix');
    git(dependency.worktree, ['add', '--', 'fix.txt']);
    git(dependency.worktree, ['commit', '-m', 'Required fix']);
    const commit = git(dependency.worktree, ['rev-parse', 'HEAD']);
    git(h.root, ['update-ref', 'refs/heads/stabilize', commit]);
    h.store.updateTask({ taskId: dependency.id, attempt: 0 }, (task) => {
      task.state = 'integrated';
      task.integratedCommit = commit;
    });
    const dependent = h.dispatch([`${library}dependent.ts`], 'dependent', `after: [${dependency.id}]`);
    expect(dependent.workspace?.module).toBe('library');
    expect(dependent.state).toBe('held');
    expect(h.tasks.dependenciesMet(dependent)).toBe(false);
    git(h.root, ['update-ref', 'refs/heads/dev', commit]);
    expect(h.tasks.dependenciesMet(dependent)).toBe(true);
    await h.tasks.retry(dependent.id);
    expect(h.store.task(dependent.id).state).toBe('running');
    expect(readFileSync(join(dependent.worktree, 'fix.txt'), 'utf8')).toBe('required fix');
  } finally {
    h.dispose();
  }
});

test('later workspace landings preserve an already integrated stopped peer and its recorded integration', async () => {
  const h = fixture();
  try {
    const stopped = h.dispatch([`${library}stopped.ts`], 'stopped-peer');
    const first = h.dispatch([`${library}first.ts`], 'first');
    await Promise.all([h.tasks.retry(stopped.id), h.tasks.retry(first.id)]);
    const stoppedCommit = h.commit(stopped, `${library}stopped.ts`);
    h.commit(first, `${library}first.ts`);
    await h.tasks.stop(stopped.id);
    const outcomes: GateOutcome[] = [];
    const train = new MergeTrain({
      ...h.settings,
      queue: h.queue,
      fence: h.store,
      sink: {
        onGateOutcome: (outcome) => {
          outcomes.push(outcome);
        },
      },
      runGate: async () => ({ passed: true, output: '', timedOut: false }),
    });
    h.finish(first);
    h.enqueue(first);
    await train.run();
    expect(h.store.task(stopped.id).state).toBe('integrated');
    expect(h.store.task(stopped.id).integratedCommits).toEqual([stoppedCommit]);
    const integration = h.store.task(stopped.id).integratedCommit;

    const later = h.dispatch([`${library}later.ts`], 'later');
    await h.tasks.retry(later.id);
    h.commit(later, `${library}later.ts`);
    h.finish(later);
    h.enqueue(later);
    await train.run();
    expect(outcomes).toHaveLength(2);
    expect(outcomes.every((outcome) => outcome.passed)).toBe(true);
    expect(h.store.task(later.id).state).toBe('integrated');
    expect(h.store.task(stopped.id).integratedCommit).toBe(integration);
    expect(h.store.task(stopped.id).integratedCommits).toEqual([stoppedCommit]);
  } finally {
    h.dispose();
  }
});
