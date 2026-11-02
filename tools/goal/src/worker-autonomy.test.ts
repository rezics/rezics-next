import { expect, test } from 'bun:test';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';
import { workerTestCommands } from './affected-tests.ts';
import { completeContinuation, continuesItself } from './continuation.ts';
import { parseBrief, readRiskOwnership } from './briefs.ts';
import { attemptProgress, noProgressTwice } from './attempt-progress.ts';
import { openDb } from './db.ts';
import { WorkerJob } from './job.ts';
import { renderLaunchContext, type LaunchContext } from './launch-context.ts';
import { workerPrompt } from './launch.ts';
import { WorkerStore } from './store.ts';
import { git } from './tasks.ts';
import type { Task } from './types.ts';
import { brief, harness, markdown, temporaryDirectory } from './test-support.ts';

function promptTask(goal: string, extra: Partial<Task> = {}): Task {
  return {
    id: 'task-1',
    worktree: '/work/trees/t1',
    branch: 'worker/t1',
    brief: {
      markdown: 'Do the thing.',
      kind: 'implementation',
      goal,
      manager: goal,
      paths: goal === 'control-plane' ? ['tools/goal/src/a.ts'] : ['src/a.ts'],
      acceptance: { command: ['bun', 'test'], tests: ['x'] },
    },
    ...extra,
  } as unknown as Task;
}

test('a dev product worker verifies premises, decides and informs its manager, and continues a larger outcome', () => {
  const prompt = workerPrompt(promptTask('web'), undefined, undefined, [], '/repo/main');
  expect(prompt).toContain("Check the contract's premises against your base first.");
  expect(prompt).toContain('Write missing acceptance tests the contract names or implies');
  expect(prompt).toContain('take the reversible option most consistent with the owner documents');
  expect(prompt).toContain(
    'record it in one line in your summary and the owning document, send it with `bun tools/goal/src/cli.ts inbox send web info "<decision>"`, and continue.',
  );
  expect(prompt).toContain('Code another Goal has not delivered is not a blocker');
  expect(prompt).toContain('A blocker is only two requirements in existing specs or tests that cannot both hold');
  expect(prompt).not.toContain('receipt');
  expect(prompt).not.toContain('when the work needs a product decision the contract does not make');
  expect(prompt).toContain('research the rest yourself');
  expect(prompt).toContain('A question needing a large survey of products or sources is a `spec-conflict` blocker');
  expect(prompt).toContain('continuation brief at `.temp/continuation/<short-name>.md`');
  expect(prompt).toContain('goal web, manager web');
  expect(prompt).toContain(
    'open the workflow skill, docs/development, architecture or scope only for a section it links',
  );
  expect(prompt).toContain('Summary at most 120 words');
  expect(prompt).toContain('Blocker detail at most 80 words');
  expect(prompt).not.toContain('goal status');
  // A control-plane release keeps manager preflight and no continuation, but shares the conduct rules.
  const release = promptTask('control-plane');
  const controlPlane = workerPrompt(
    { ...release, brief: { ...release.brief, target: 'main' } },
    undefined,
    undefined,
    [],
    '/repo/main',
  );
  expect(controlPlane).not.toContain("Check the contract's premises");
  expect(controlPlane).not.toContain('.temp/continuation');
  expect(controlPlane).not.toContain('inbox send');
  expect(controlPlane).toContain('Unfinished work is not a blocker');
  expect(controlPlane).toContain('Summary at most 120 words');
  expect(continuesItself(promptTask('web', { workspace: { module: 'apps/web', taskName: 'shared' } }))).toBe(false);
  expect(continuesItself(promptTask('web', { brief: { ...promptTask('web').brief, target: 'stabilize' } }))).toBe(
    false,
  );
});

test("the prompt names the landing's exact test commands for the files the branch already changes", () => {
  const directory = temporaryDirectory();
  try {
    const root = directory.path;
    git(root, ['init', '-q', '-b', 'main']);
    git(root, ['config', 'user.email', 'fixture@example.invalid']);
    git(root, ['config', 'user.name', 'Fixture']);
    const write = (path: string, text = 'export {};\n') => {
      mkdirSync(dirname(join(root, path)), { recursive: true });
      writeFileSync(join(root, path), text);
    };
    write('apps/web/scripts/focused.ts');
    write('packages/filter/src/match.ts');
    write('packages/filter/src/match.test.ts');
    git(root, ['add', '.']);
    git(root, ['commit', '-qm', 'Base']);
    const base = git(root, ['rev-parse', 'HEAD']);
    write('packages/filter/src/match.ts', 'export const changed = true;\n');
    write('services/kernel/test/library/shelf.test.ts');
    write('apps/web/tests/shelf-page.test.tsx');
    write('apps/web/tests/shelf.host.test.ts');
    write('specs/library.test.ts');
    git(root, ['add', '.']);
    git(root, ['commit', '-qm', 'Worker progress']);
    write('tools/goal/src/new.test.ts');
    expect(
      workerTestCommands(['packages/filter/src/match.ts', 'tools/goal/src/new.test.ts', 'gone.test.ts'], root),
    ).toEqual([['bun', 'test', 'packages/filter/src/match.test.ts', 'tools/goal/src/new.test.ts']]);

    const prompt = workerPrompt(
      promptTask('web', { worktree: root, base } as Partial<Task>),
      undefined,
      undefined,
      [],
      '/repo/main',
    );
    expect(prompt).toContain(
      "For the files this branch already changes, the landing's test commands are: " +
        "`'bun' 'run' '--cwd' 'services/kernel' 'check' 'test/library/shelf.test.ts'`; " +
        "`'bun' 'apps/web/scripts/focused.ts' '--private-network' '--' 'bun' 'test' 'tests/shelf-page.test.tsx'`; " +
        "`'bun' 'test' 'packages/filter/src/match.test.ts' 'tools/goal/src/new.test.ts'`.",
    );
    expect(prompt).not.toContain('shelf.host.test.ts');
    expect(prompt).not.toContain('specs/library.test.ts');
    // A fresh attempt with nothing changed yet has only the general rule.
    git(root, ['add', '.']);
    git(root, ['commit', '-qm', 'Integrated']);
    const fresh = workerPrompt(
      promptTask('web', { worktree: root, base: git(root, ['rev-parse', 'HEAD']) } as Partial<Task>),
      undefined,
      undefined,
      [],
      '/repo/main',
    );
    expect(fresh).not.toContain("the landing's test commands are");
  } finally {
    directory.close();
  }
});

test('dependencies render as one factual line each, without receipt rules', () => {
  const receipt = (id: string, present: boolean) => ({
    id,
    state: 'integrated',
    completion: 'integrated' as const,
    commit: present ? 'a'.repeat(40) : null,
    sourcePresence: present ? ('present' as const) : ('unknown' as const),
    precondition: present ? ('satisfied' as const) : ('unknown' as const),
  });
  const context: LaunchContext = {
    version: 1,
    boundary: 'retry',
    origin: 'managed',
    task: {
      id: 'task-1',
      attempt: 2,
      state: 'running',
      branch: 'worker/t1',
      worktree: '/work/trees/t1',
      contractPath: null,
      contractSha256: null,
      contractProof: 'unknown',
      base: null,
      sourceHead: null,
      sourceBranch: null,
      sourceProof: 'unknown',
    },
    dependencies: {
      required: 2,
      included: 2,
      omitted: 0,
      completeness: 'complete',
      receipts: [receipt('schema', true), receipt('client', false)],
    },
  };
  const rendered = renderLaunchContext(context);
  expect(rendered).toContain(`- \`schema\`: integrated in your base at \`${'a'.repeat(40)}\`.`);
  expect(rendered).toContain('- `client`: not in your base; build against its contract.');
  expect(rendered).not.toContain('sourcePresence');
  expect(rendered).not.toContain('Treat code as installed');
  expect(rendered).toContain('"boundary":"retry"');
});

const continuingWorker = (rest: string, other: string) => `#!/usr/bin/env bun
import { mkdirSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
mkdirSync('.temp/continuation', { recursive: true });
writeFileSync('.temp/continuation/rest of shelf.md', ${JSON.stringify(rest)});
writeFileSync('.temp/continuation/other-goal.md', ${JSON.stringify(other)});
writeFileSync('.temp/continuation/notes.txt', 'not a brief');
writeFileSync('result.txt', 'first part');
spawnSync('git', ['add', 'result.txt']);
spawnSync('git', ['commit', '-qm', 'Land the first part']);
console.log(JSON.stringify({type:'thread.started',thread_id:'continuing'}));
console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:'RESULT: success'}}));
console.log(JSON.stringify({type:'turn.completed',usage:{input_tokens:10,output_tokens:2}}));
`;

test("a dev product attempt's continuation briefs move to its Goal backlog when the attempt ends", async () => {
  const rest = markdown.replace('Write the requested result and commit it.', 'Finish the shelf page.');
  const other = markdown.replace('goal: fixture', 'goal: web');
  const h = harness(continuingWorker(rest, other));
  try {
    const task = h.tasks.dispatch(h.briefFile);
    const job = new WorkerJob(h.tasks, { enqueue() {} }, { deliver() {} });
    await job.start(task.id);
    await job.drain();
    const backlog = join(h.settings.stateDirectory, 'backlog', 'fixture');
    const queued = readdirSync(backlog);
    expect(queued).toEqual([`continuation-${task.id.slice(0, 8)}-1-rest-of-shelf.md`]);
    expect(readFileSync(join(backlog, queued[0]!), 'utf8')).toBe(rest);
    expect(existsSync(join(h.settings.stateDirectory, 'backlog', 'web'))).toBe(false);
    expect(readdirSync(join(task.worktree, '.temp/continuation'))).toEqual([]);
    const dropped = h.store
      .events(task.id, 1)
      .filter((event) => event.kind === 'continuation-dropped')
      .map((event) => JSON.parse(event.body) as { file: string; reason: string });
    expect(dropped).toEqual([
      { file: 'notes.txt', reason: 'a continuation must be a regular Markdown file' },
      { file: 'other-goal.md', reason: "goal web is not the task's goal fixture" },
    ]);
  } finally {
    h.dispose();
  }
});

test('a continuation missing front matter inherits it from the brief it continues', () => {
  const ownership = readRiskOwnership(join(import.meta.dir, '../risk-areas.json'));
  const parent = { brief: brief() };
  const partial =
    '---\ngoal: fixture\nkind: feature\npaths: apps/web/src/rights/notice.tsx\nacceptance:\n  command: [bun, test]\n  tests: [notice]\ncriticalPath: "true"\n---\nShow the notice.\n';
  const completed = completeContinuation(partial, parent, ownership);
  expect(parseBrief(completed, ownership)).toMatchObject({
    goal: 'fixture',
    kind: 'implementation',
    paths: ['apps/web/src/rights/notice.tsx'],
    riskAreas: ['rights'],
    criticalPath: true,
    waiting: [],
    estimate: { lines: 100, files: 4 },
  });
  expect(completed.endsWith('\n---\nShow the notice.\n')).toBe(true);
  expect(completeContinuation(markdown, parent, ownership)).toBe(markdown);
});

const toolBlockedWorker = `#!/usr/bin/env bun
import { appendFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
const errors = ['EMFILE: too many open files, watch', 'ENOSPC: no space left on device', 'ECONNRESET: socket hang up'];
const attempt = Number(process.env.GOAL_ATTEMPT);
appendFileSync('result.txt', 'attempt ' + attempt + '\\n');
spawnSync('git', ['add', 'result.txt']);
spawnSync('git', ['commit', '-qm', 'Progress ' + attempt]);
console.log(JSON.stringify({type:'thread.started',thread_id:'tool-session'}));
console.log(JSON.stringify({type:'item.completed',item:{type:'command_execution',id:'acceptance',command:'bun test'}}));
const exit = attempt <= errors.length
  ? {status:'blocked',summary:'tool failed',blocker:{kind:'tool',detail:errors[attempt - 1]},checks:[],approaches:[]}
  : {status:'success',summary:'done',blocker:null,checks:[],approaches:[]};
console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:JSON.stringify(exit)}}));
console.log(JSON.stringify({type:'turn.completed',usage:{input_tokens:10,output_tokens:2}}));
`;

test('environment retries of dev product work keep the same model and session, while other work switches model', async () => {
  for (const goal of ['fixture', 'control-plane']) {
    const h = harness(toolBlockedWorker);
    try {
      writeFileSync(
        h.briefFile,
        goal === 'fixture'
          ? markdown
          : markdown
              .replace('goal: fixture', 'goal: control-plane\ntarget: main')
              .replace('paths: [result.txt]', 'paths: [tools/goal/src/a.ts]'),
      );
      const routing = JSON.parse(readFileSync(h.settings.routingFile, 'utf8'));
      const profile = (model: string) => ({
        cli: 'codex',
        model,
        effort: 'high',
        poolClass: h.settings.pools[0]!.classes[0],
      });
      for (const route of Object.values(routing.classes) as { first: unknown; fallbacks?: unknown[] }[]) {
        route.first = profile('model-a');
        route.fallbacks = [profile('model-b')];
      }
      routing.experiments = [];
      h.settings.routingFile = join(h.settings.stateDirectory, 'routing-environment.json');
      writeFileSync(h.settings.routingFile, JSON.stringify(routing));
      const task = h.tasks.dispatch(h.briefFile);
      const job = new WorkerJob(h.tasks, { enqueue() {} }, { deliver() {} });
      await job.start(task.id);
      await job.drain();
      const models = h.store.attempts(task.id).map((attempt) => attempt.profile.model);
      if (goal === 'fixture') {
        expect(models).toEqual(['model-a', 'model-a', 'model-a', 'model-a']);
        expect(
          h.store
            .attempts(task.id)
            .slice(1)
            .every((attempt) => attempt.session === 'tool-session'),
        ).toBe(true);
      } else expect(models).toEqual(['model-a', 'model-a', 'model-a', 'model-b']);
    } finally {
      h.dispose();
    }
  }
}, 60_000);

function progressStore(attempt = 1) {
  const directory = temporaryDirectory();
  const worktree = join(directory.path, 'tree');
  mkdirSync(worktree);
  git(worktree, ['init', '-q', '-b', 'worker/t']);
  git(worktree, ['config', 'user.email', 'f@x.invalid']);
  git(worktree, ['config', 'user.name', 'F']);
  writeFileSync(join(worktree, 'f.txt'), '1\n');
  git(worktree, ['add', '.']);
  git(worktree, ['commit', '-qm', 'b']);
  const store = new WorkerStore(openDb(join(directory.path, 'g.sqlite')));
  const id = 't';
  store.db.query('INSERT INTO worker_tasks(id, sequence, current_attempt, body) VALUES (?,?,?,?)').run(
    id,
    1,
    attempt,
    JSON.stringify({ id, currentAttempt: attempt, state: 'running', worktree, branch: 'worker/t' }),
  );
  for (let n = 1; n <= attempt; n++)
    store.db
      .query('INSERT INTO worker_attempts(task_id, attempt, body) VALUES (?,?,?)')
      .run(id, n, JSON.stringify({ taskId: id, attempt: n, state: 'exited' }));
  const task = { id, worktree, branch: 'worker/t' } as Task;
  const ref = { taskId: id, attempt };
  store.event(ref, 'worker-run-started', { branchHead: git(worktree, ['rev-parse', 'HEAD']) });
  return { directory, store, task, ref, worktree, close: () => (store.db.close(), directory.close()) };
}

function hideGitStatus(worktree: string) {
  const index = git(worktree, ['rev-parse', '--git-path', 'index']);
  const path = isAbsolute(index) ? index : join(worktree, index);
  rmSync(path, { force: true });
  mkdirSync(path);
}

test('Keep an unreadable Git status from stopping wanted work.', () => {
  const clean = progressStore();
  try {
    expect(attemptProgress(clean.store, clean.task, clean.ref)).toBe(false);
    const head = git(clean.worktree, ['rev-parse', 'HEAD']);
    writeFileSync(join(clean.worktree, 'f.txt'), '2\n');
    git(clean.worktree, ['add', '.']);
    git(clean.worktree, ['commit', '-qm', 'rebase']);
    expect(git(clean.worktree, ['rev-parse', 'HEAD'])).not.toBe(head);
    expect(attemptProgress(clean.store, clean.task, clean.ref)).toBe(false);
  } finally {
    clean.close();
  }
  const unknown = progressStore(2);
  try {
    unknown.store.db
      .query('INSERT INTO worker_events(task_id,attempt,kind,at,body) VALUES (?,?,?,?,?)')
      .run('t', 1, 'attempt-progress', new Date().toISOString(), JSON.stringify({ progress: null }));
    hideGitStatus(unknown.worktree);
    expect(attemptProgress(unknown.store, unknown.task, unknown.ref)).toBe(null);
    expect(noProgressTwice(unknown.store, unknown.task, unknown.ref)).toBe(false);
  } finally {
    unknown.close();
  }
  const moved = progressStore();
  try {
    writeFileSync(join(moved.worktree, 'f.txt'), '3\n');
    git(moved.worktree, ['add', '.']);
    git(moved.worktree, ['commit', '-qm', 'progress']);
    hideGitStatus(moved.worktree);
    expect(attemptProgress(moved.store, moved.task, moved.ref)).toBe(true);
  } finally {
    moved.close();
  }
});
