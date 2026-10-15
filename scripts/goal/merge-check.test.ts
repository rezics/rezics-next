import { afterEach, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { type Ledger, type Task } from './types.ts';
import { fastForwardMain, type MainSync, type PreparedMerge } from './merge.ts';

const fixtures: string[] = [];
afterEach(() => {
  for (const directory of fixtures.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function fixture(file: string) {
  const scratch = resolve(import.meta.dir, '../../.temp/merge-check');
  mkdirSync(scratch, { recursive: true });
  const directory = mkdtempSync(join(scratch, 'case-'));
  fixtures.push(directory);
  const git = (...args: string[]) => {
    const result = spawnSync('git', args, { cwd: directory, encoding: 'utf8' });
    if (result.status !== 0) throw new Error(result.stderr);
    return result.stdout.trim();
  };
  const put = (root: string, path: string, source: string) => {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), source);
  };
  git('init', '-qb', 'main');
  git('config', 'user.name', 'Merge check fixture');
  git('config', 'user.email', 'merge-check@example.invalid');
  put(directory, '.gitignore', '.temp/\nnode_modules/\n');
  for (const name of ['dedupe-imports.ts', 'composition-roots.ts']) {
    mkdirSync(join(directory, 'scripts/goal'), { recursive: true });
    copyFileSync(join(import.meta.dir, name), join(directory, 'scripts/goal', name));
  }
  // Exercise the real check selection and execution against small command fixtures.
  const currentCheck = readFileSync(join(import.meta.dir, 'check.ts'), 'utf8')
    .replace(/from (['"])(\.[^'"]+)\1/g, (_match, _quote, path: string) => `from ${JSON.stringify(resolve(import.meta.dir, path))}`);
  const olderCheck = currentCheck.replace(/^\s*if \(needsInferenceGate\(changed\)\) await check\('inference'.*\n/m, '\n');
  expect(olderCheck).not.toBe(currentCheck);
  put(directory, 'scripts/goal/check.ts', olderCheck);
  put(directory, file, 'export const expensive = false;\n');
  put(directory, 'scripts/qa/host-admission.ts', "await import('../api/inference-cost.ts');\n");
  const inferenceLog = join(directory, '.temp/inference-runs');
  put(directory, 'scripts/api/inference-cost.ts', `
    import { appendFileSync, readFileSync } from 'node:fs';
    appendFileSync(${JSON.stringify(inferenceLog)}, 'run\\n');
    if (readFileSync(${JSON.stringify(file)}, 'utf8').includes('expensive = true')) {
      console.error('error: Inference cost regression: eden.instantiations exceeds budget');
      process.exit(1);
    }
  `);
  git('add', '.'); git('commit', '-qm', 'Harness before inference selection');
  const base = git('rev-parse', 'HEAD');
  const worktree = join(directory, '.temp/tree');
  git('worktree', 'add', '-qb', 'goal/fixture', worktree);
  put(worktree, file, 'export const expensive = true;\n');
  git('-C', worktree, 'add', '.'); git('-C', worktree, 'commit', '-qm', 'Deliver branch change');
  const task: Task = { id: 'G-001', title: 'Deliver branch change', kind: 'tooling', effort: 'high',
    cases: [], paths: [file], migrations: [], shared: [], depends: [], branch: 'goal/fixture',
    brief: join(directory, '.temp/brief.md'), base, worktree, state: 'exited', goal: 'program', attempts: [] };
  const state = join(directory, '.temp/goal-orchestration');
  mkdirSync(state, { recursive: true });
  const ledgerPath = join(state, 'ledger.json');
  writeFileSync(ledgerPath, JSON.stringify({ tasks: { [task.id]: task },
    goals: { program: { manager: 'fixture-manager', startedAt: new Date().toISOString() } } } satisfies Ledger));
  writeFileSync(task.brief, `---\nid: ${task.id}\nkind: tooling\npaths: [${file}]\n---\n`);
  put(worktree, '.temp/goal/brief.md', readFileSync(task.brief, 'utf8'));
  const bin = join(directory, '.temp/bin');
  put(directory, '.temp/bin/task', '#!/bin/sh\nif [ "$1" = test ]; then echo "Affected since HEAD: fixture"; fi\nexit 0\n');
  put(directory, '.temp/bin/docker', '#!/bin/sh\nexit 0\n');
  put(worktree, 'node_modules/.bin/oxlint', '#!/bin/sh\nexit 0\n');
  for (const path of [join(bin, 'task'), join(bin, 'docker'), join(worktree, 'node_modules/.bin/oxlint')]) chmodSync(path, 0o755);
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, GOAL_ID: 'program', GOAL_MANAGER: 'fixture-manager',
    GOAL_MEMORY_FLOOR_GIB: '0', GOAL_GATE_LANES: '25' };
  const run = (args: string[], cwd = directory) => spawnSync(process.execPath, args, { cwd, env, encoding: 'utf8', timeout: 30_000 });
  const gate = (command = 'gate') => run([join(import.meta.dir, 'goalctl.ts'), command, task.id]);
  const advance = () => {
    put(directory, 'scripts/goal/check.ts', currentCheck);
    git('add', '.'); git('commit', '-qm', 'Select inference checks for API changes');
    return git('rev-parse', 'main');
  };
  return { directory, worktree, file, git, run, gate, advance, inferenceLog, ledgerPath, put };
}

test('a branch predating a selected check passes its old harness but fails that check at merge', () => {
  const f = fixture('services/main/src/app.ts');
  const old = f.run(['-e', `const { workerCheck } = await import('./scripts/goal/check.ts');
    process.exitCode = (await workerCheck({ treePrepared: true, changed: [${JSON.stringify(f.file)}] })).code;`], f.worktree);
  expect({ status: old.status, output: old.stdout + old.stderr }).toEqual({ status: 0, output: expect.any(String) });
  expect(existsSync(f.inferenceLog)).toBe(false);
  const main = f.advance();
  const failed = f.gate('merge');
  expect(failed.status).toBe(1);
  expect(failed.stdout + failed.stderr).toContain('Inference cost regression');
  expect(failed.stderr).toContain('worker check failed on the rebased tree');
  expect(f.git('rev-parse', 'main')).toBe(main);
  expect(f.git('-C', f.worktree, 'merge-base', 'HEAD', 'main')).toBe(main);
  const task = (JSON.parse(readFileSync(f.ledgerPath, 'utf8')) as Ledger).tasks['G-001']!;
  expect(task.mergeStop?.kind).toBe('task');

  f.put(f.worktree, f.file, 'export const expensive = false;\nexport const delivered = true;\n');
  f.git('-C', f.worktree, 'add', '.'); f.git('-C', f.worktree, 'commit', '-qm', 'Keep inference within budget');
  const passed = f.gate();
  expect({ status: passed.status, output: passed.stdout + passed.stderr }).toEqual({ status: 0, output: expect.any(String) });
  const repeat = f.gate('merge');
  expect({ status: repeat.status, output: repeat.stdout + repeat.stderr }).toEqual({ status: 0, output: expect.any(String) });
  expect(repeat.stdout).toContain('inference: ok');
  expect(repeat.stdout).toContain('reused successful check for tree');
  expect(readFileSync(f.inferenceLog, 'utf8').trim().split('\n')).toHaveLength(2);
  expect(f.git('rev-parse', 'main')).toBe(f.git('-C', f.worktree, 'rev-parse', 'HEAD'));
}, 60_000);

test('a rebased change that does not select inference never runs it', () => {
  const f = fixture('scripts/delivered.ts');
  f.advance();
  const result = f.gate('merge');
  expect({ status: result.status, output: result.stdout + result.stderr }).toEqual({ status: 0, output: expect.any(String) });
  expect(existsSync(f.inferenceLog)).toBe(false);
}, 60_000);

test('main advancing outside the selected files still invalidates the worker check tree, with bounded retries', () => {
  const prepared: PreparedMerge = { before: 'old-main', baseline: 'old-main', after: 'old-branch',
    worktree: '/fixture', branch: 'goal/fixture', sharers: ['fixture'], committed: ['services/main/src/app.ts'] };
  const refreshed = { ...prepared, before: 'new-main', after: 'new-branch' };
  let forwarded = false;
  let rebases = 0;
  const sync: MainSync = {
    head: () => 'new-main',
    isAncestor: (ancestor, descendant) => ancestor === descendant || ancestor === 'old-main',
    mergeBase: () => 'old-main',
    touched: () => ['scripts/qa/new-check.ts'],
    changed: () => prepared.committed,
    refresh: () => { rebases++; return refreshed; },
    fastForward: () => { forwarded = true; return { status: 0, stderr: '' }; },
  };
  const gates = { gatedFiles: new Set<string>(), regated: false, retyped: false, typechecked: [], workerChecks: true };
  expect(fastForwardMain(sync, prepared, gates, () => {})).toEqual({ kind: 'regate', prepared: refreshed });
  expect(forwarded).toBe(false);
  expect(rebases).toBe(1);
  expect(fastForwardMain(sync, prepared, { ...gates, retyped: true }, () => {}))
    .toMatchObject({ kind: 'stopped', conflict: true, message: 'main kept changing the worker check tree; retry merge' });
  expect(rebases).toBe(1);
});
