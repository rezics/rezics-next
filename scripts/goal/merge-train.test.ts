import { afterEach, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { type Ledger, type Task } from './types.ts';
import { runMergeTrain, trainMetrics, type TrainEvent } from './merge-train.ts';
import { queueManagerCommit } from './manager-commit.ts';

const fixtures: { repo: string; release(tag: string, n?: number): void; children: ReturnType<typeof Bun.spawn>[] }[] = [];
function fixture() {
  const scratch = join(import.meta.dir, '../../.temp/merge-train-tests');
  mkdirSync(scratch, { recursive: true });
  const repo = mkdtempSync(join(scratch, 'case-'));
  const state = join(repo, '.temp/goal-orchestration');
  mkdirSync(state, { recursive: true });
  const git = (...args: string[]) => {
    const result = spawnSync('git', args, { cwd: repo, encoding: 'utf8' });
    if (result.status !== 0) throw new Error(result.stderr);
    return result.stdout.trim();
  };
  git('init', '-qb', 'main');
  git('config', 'user.name', 'Train fixture'); git('config', 'user.email', 'train@example.invalid');
  mkdirSync(join(repo, 'scripts/goal'), { recursive: true });
  for (const file of ['dedupe-imports.ts', 'composition-roots.ts']) copyFileSync(join(import.meta.dir, file), join(repo, 'scripts/goal', file));
  const original = Array.from({ length: 60 }, (_, i) => `export const value${i} = 0;`).join('\n') + '\n';
  writeFileSync(join(repo, 'scripts/shared.ts'), original);
  writeFileSync(join(repo, '.gitignore'), '.temp/\nnode_modules/\n');
  git('add', '.'); git('commit', '-qm', 'Base');
  const base = git('rev-parse', 'HEAD');
  const ledger: Ledger = { tasks: {}, goals: { program: { manager: 'fixture', startedAt: new Date().toISOString() } } };
  const save = () => writeFileSync(join(state, 'ledger.json'), JSON.stringify(ledger));
  save();
  const bin = join(repo, '.temp/bin'); mkdirSync(bin);
  const plan = join(repo, '.temp/plan'); writeFileSync(plan, '');
  writeFileSync(join(bin, 'task'), `#!/usr/bin/env bun
    import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
    import { join } from 'node:path';
    if (process.argv[2] === 'scripts:typecheck') {
      const state = ${JSON.stringify(state)};
      const tag = process.env.TRAIN_TAG;
      const log = join(state, tag + '.jsonl');
      const n = existsSync(log) ? readFileSync(log, 'utf8').trim().split('\\n').length + 1 : 1;
      appendFileSync(log, JSON.stringify({ tree: readFileSync('scripts/shared.ts', 'utf8') }) + '\\n');
      writeFileSync(join(state, 'ready-' + tag + '-' + n), '');
      while (!existsSync(join(state, 'release-' + tag + '-' + n))) await Bun.sleep(10);
      if (process.env.TRAIN_FAIL === '1') { console.error('fixture type checker failed'); process.exit(1); }
    }
    if (process.argv.includes('--list')) console.log('Affected since HEAD: fixture');
  `);
  chmodSync(join(bin, 'task'), 0o755);
  writeFileSync(join(bin, 'docker'), '#!/bin/sh\nexit 0\n'); chmodSync(join(bin, 'docker'), 0o755);
  const children: ReturnType<typeof Bun.spawn>[] = [];
  const start = (args: string[], tag: string, fail = false) => {
    const child = Bun.spawn([process.execPath, join(import.meta.dir, 'goalctl.ts'), ...args], { cwd: repo,
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, GOAL_ID: 'program', GOAL_MANAGER: 'fixture',
        GOAL_MEMORY_FLOOR_GIB: '0', GOAL_GATE_LANES: '25', GOAL_TEST_PLAN: plan, TRAIN_TAG: tag, TRAIN_FAIL: fail ? '1' : '' },
      stdout: 'pipe', stderr: 'pipe' });
    children.push(child);
    return Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()])
      .then(([code, stdout, stderr]) => ({ code, stdout, stderr }));
  };
  const task = (tag: string, line: number, fail = false) => {
    const id = `G-00${Object.keys(ledger.tasks).length + 1}`;
    const branch = `goal/${tag}`;
    const worktree = join(repo, '.temp', tag);
    git('worktree', 'add', '-qb', branch, worktree, base);
    writeFileSync(join(worktree, 'scripts/shared.ts'), original.replace(`value${line} = 0`, `value${line} = 1`));
    git('-C', worktree, 'add', '.'); git('-C', worktree, 'commit', '-qm', tag);
    const brief = join(repo, '.temp', `${tag}.md`);
    writeFileSync(brief, `---\nid: ${id}\nkind: tooling\npaths: [scripts/shared.ts]\n---\n`);
    ledger.tasks[id] = { id, title: tag, kind: 'tooling', effort: 'high', cases: [], paths: ['scripts/shared.ts'],
      migrations: [], shared: [], depends: [], worktree, branch, base, brief, state: 'exited', goal: 'program',
      attempts: [{ n: 1, engine: 'codex', effort: 'high', pid: 2147483647, session: '', output: '',
        startedAt: new Date().toISOString(), endedAt: new Date().toISOString() }] } as Task;
    save();
    return () => start(['merge', id], tag, fail);
  };
  const events = () => existsSync(join(state, 'train-events.jsonl'))
    ? readFileSync(join(state, 'train-events.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line) as TrainEvent) : [];
  const ready = (tag: string, n = 1) => until(() => existsSync(join(state, `ready-${tag}-${n}`)));
  const release = (tag: string, n = 1) => writeFileSync(join(state, `release-${tag}-${n}`), '');
  const trees = (tag: string) => readFileSync(join(state, `${tag}.jsonl`), 'utf8').trim().split('\n').map(line => (JSON.parse(line) as { tree: string }).tree);
  const f = { repo, state, git, start, task, children, ready, release, trees, events };
  fixtures.push(f);
  return f;
}

async function until(check: () => boolean): Promise<void> {
  const deadline = Date.now() + 20_000;
  while (!check()) {
    if (Date.now() > deadline) throw new Error('Train fixture timed out');
    await Bun.sleep(10);
  }
}

afterEach(async () => {
  for (const f of fixtures.splice(0)) {
    for (const tag of ['a', 'b', 'c', 'manager']) for (let n = 1; n < 5; n++) f.release(tag, n);
    for (const child of f.children) if (child.exitCode === null) child.kill();
    await Promise.all(f.children.map(child => child.exited));
    rmSync(f.repo, { recursive: true, force: true });
  }
});

test('three overlapping-file landings gate cumulative trees concurrently and land in order without discarded green work', async () => {
  const f = fixture();
  const starts = [f.task('a', 5), f.task('b', 25), f.task('c', 45)];
  const a = starts[0]!(); await f.ready('a');
  const b = starts[1]!(); await f.ready('b');
  const c = starts[2]!(); await f.ready('c');
  expect(f.trees('b')[0]).toContain('value5 = 1');
  expect(f.trees('c')[0]).toContain('value25 = 1');
  f.release('c'); f.release('b');
  await until(() => f.events().filter(event => event.event === 'gate-end').length === 2);
  expect(f.git('log', '--format=%s', '-1', 'main')).toBe('Base');
  f.release('a');
  for (const result of await Promise.all([a, b, c])) expect(result.code, result.stdout + result.stderr).toBe(0);
  expect(f.events().filter(event => event.event === 'landed').map(event => event.id)).toEqual(['G-001', 'G-002', 'G-003']);
  expect(f.events().filter(event => event.event === 'gate-start')).toHaveLength(3);
  expect(f.events().filter(event => event.event === 'discarded')).toHaveLength(0);
  expect(trainMetrics(f.state)).toMatchObject({ landings: 3, discardedGateSeconds: 0 });
  expect(trainMetrics(f.state).p95HandoffToMainSeconds).toBeGreaterThan(0);
}, 60_000);

test('a failed middle entry leaves the train; only its successors rebuild and regate without its changes', async () => {
  const f = fixture();
  const starts = [f.task('a', 5), f.task('b', 25, true), f.task('c', 45)];
  const a = starts[0]!(); await f.ready('a');
  const b = starts[1]!(); await f.ready('b');
  const c = starts[2]!(); await f.ready('c');
  f.release('c');
  await until(() => f.events().some(event => event.id === 'G-003' && event.event === 'gate-end'));
  f.release('b'); expect((await b).code).toBe(1);
  await f.ready('c', 2);
  expect(f.trees('c')[1]).toContain('value5 = 1');
  expect(f.trees('c')[1]).toContain('value25 = 0');
  f.release('c', 2); f.release('a');
  for (const result of await Promise.all([a, c])) expect(result.code, result.stdout + result.stderr).toBe(0);
  expect(f.trees('a')).toHaveLength(1); expect(f.trees('b')).toHaveLength(1); expect(f.trees('c')).toHaveLength(2);
  expect(f.events().filter(event => event.event === 'landed').map(event => event.id)).toEqual(['G-001', 'G-003']);
  expect(f.git('show', 'main:scripts/shared.ts')).toContain('value25 = 0');
  expect(trainMetrics(f.state).discardedGateSeconds).toBeGreaterThan(0);
}, 60_000);

test('a manager commit joins the train behind a worker, gates their combined tree and preserves peer staging', async () => {
  const f = fixture();
  const start = f.task('a', 5);
  const a = start(); await f.ready('a');
  writeFileSync(join(f.repo, 'scripts/shared.ts'), readFileSync(join(f.repo, 'scripts/shared.ts'), 'utf8').replace('value25 = 0', 'value25 = 1'));
  writeFileSync(join(f.repo, 'peer.txt'), 'peer staging\n'); f.git('add', 'peer.txt');
  const manager = f.start(['commit', '-m', 'Manager change', '--', 'scripts/shared.ts'], 'manager');
  await f.ready('manager');
  expect(f.trees('manager')[0]).toContain('value5 = 1');
  expect(f.trees('manager')[0]).toContain('value25 = 1');
  expect(f.git('diff', '--cached', '--name-only')).toBe('peer.txt');
  f.release('manager'); f.release('a');
  for (const result of await Promise.all([a, manager])) expect(result.code, result.stdout + result.stderr).toBe(0);
  expect(f.git('log', '-2', '--format=%s', 'main')).toBe('Manager change\na');
  expect(f.events().filter(event => event.event === 'landed').map(event => event.id)).toEqual(['G-001', expect.stringContaining('manager-')]);
  expect(f.events().filter(event => event.event === 'discarded')).toHaveLength(0);
  expect(f.git('diff', '--cached', '--name-only')).toBe('peer.txt');
}, 60_000);

test('a queued manager snapshot reserves its position before settlement starts its executor', async () => {
  const f = fixture();
  const starts = [f.task('a', 5), f.task('b', 45)];
  const a = starts[0]!(); await f.ready('a');
  writeFileSync(join(f.repo, 'scripts/shared.ts'), readFileSync(join(f.repo, 'scripts/shared.ts'), 'utf8').replace('value25 = 0', 'value25 = 1'));
  const id = queueManagerCommit(f.repo, f.state, ['scripts/shared.ts'], 'Deferred manager', 'program')!;
  const b = starts[1]!();
  await until(() => f.events().some(event => event.event === 'queued' && event.id === 'G-002'));
  expect(existsSync(join(f.state, 'ready-b-1'))).toBe(false);
  const manager = f.start(['commit', '--retry', id], 'manager');
  await f.ready('manager'); await f.ready('b');
  expect(f.trees('b')[0]).toContain('value25 = 1');
  f.release('b'); f.release('manager'); f.release('a');
  for (const result of await Promise.all([a, manager, b])) expect(result.code, result.stdout + result.stderr).toBe(0);
  expect(f.events().filter(event => event.event === 'landed').map(event => event.id)).toEqual(['G-001', id, 'G-002']);
  expect(trainMetrics(f.state).discardedGateSeconds).toBe(0);
}, 60_000);

test('an exited train owner is removed and its successor rebuilds from its original submission', async () => {
  const f = fixture();
  const starts = [f.task('a', 5), f.task('b', 25)];
  const a = starts[0]!(); await f.ready('a');
  const b = starts[1]!(); await f.ready('b');
  f.release('b');
  await until(() => f.events().some(event => event.id === 'G-002' && event.event === 'gate-end'));
  f.children[0]!.kill('SIGKILL'); await f.children[0]!.exited;
  f.release('a'); await a;
  await f.ready('b', 2);
  expect(f.trees('b')[1]).toContain('value5 = 0');
  expect(f.trees('b')[1]).toContain('value25 = 1');
  f.release('b', 2);
  const result = await b;
  expect(result.code, result.stdout + result.stderr).toBe(0);
  expect(f.git('show', 'main:scripts/shared.ts')).toContain('value5 = 0');
  expect(f.events().filter(event => event.event === 'landed').map(event => event.id)).toEqual(['G-002']);
}, 60_000);

test('a failed manager snapshot is retained for explicit retry and concurrent callers wait for its landing', async () => {
  const f = fixture();
  writeFileSync(join(f.repo, 'scripts/shared.ts'), readFileSync(join(f.repo, 'scripts/shared.ts'), 'utf8').replace('value25 = 0', 'value25 = 1'));
  const first = f.start(['commit', '-m', 'Retry manager', '--', 'scripts/shared.ts'], 'manager', true);
  await f.ready('manager'); f.release('manager'); expect((await first).code).toBe(1);
  const id = f.events().find(event => event.event === 'queued')!.id;
  expect(f.git('log', '-1', '--format=%s', 'main')).toBe('Base');
  expect(f.git('show', `refs/goal-manager/${id}:scripts/shared.ts`)).toContain('value25 = 1');
  const retry = f.start(['commit', '--retry', id], 'manager'); await f.ready('manager', 2);
  const waiter = f.start(['commit', '--retry', id], 'manager');
  await until(() => f.events().some(event => event.event === 'lock-wait-start' && event.lock === 'manager snapshot'));
  expect(f.git('log', '-1', '--format=%s', 'main')).toBe('Base');
  f.release('manager', 2);
  for (const result of await Promise.all([retry, waiter])) expect(result.code, result.stdout + result.stderr).toBe(0);
  expect(f.trees('manager')).toHaveLength(2);
  expect(f.git('log', '-1', '--format=%s', 'main')).toBe('Retry manager');
}, 60_000);

test('post-merge bookkeeping failure preserves the green successor of the tree already on main', async () => {
  const f = fixture();
  let head = 'base';
  let release!: () => void;
  let firstPrepared = false;
  let secondGreen = false;
  let secondGates = 0;
  const a = runMergeTrain({ directory: f.state, id: 'first', head: () => head,
    prepare: async () => { firstPrepared = true; return { after: 'first-tree' }; },
    gate: async () => { await new Promise<void>(resolve => { release = resolve; }); return undefined; },
    finish: async () => { head = 'first-tree'; throw new Error('bookkeeping interrupted'); },
  }).catch(error => error as Error);
  await until(() => firstPrepared && !!release);
  const b = runMergeTrain({ directory: f.state, id: 'second', head: () => head,
    prepare: async base => { expect(base).toBe('first-tree'); return { after: 'second-tree' }; },
    gate: async () => { secondGates++; secondGreen = true; return undefined; },
    finish: async () => { head = 'second-tree'; },
  });
  await until(() => secondGreen);
  release();
  expect(await a).toMatchObject({ message: 'bookkeeping interrupted' });
  await b;
  expect(head).toBe('second-tree');
  expect(secondGates).toBe(1);
  expect(trainMetrics(f.state)).toMatchObject({ landings: 2, discardedGateSeconds: 0 });
});
