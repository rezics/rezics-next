import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { CheckResults, checkResultKey, reusableCommand } from './check-results.ts';
import { gateRunner } from './merge.ts';
import { openDb } from './db.ts';

let root: string;
let db: ReturnType<typeof openDb>;
let results: CheckResults;
function command(...args: string[]) {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(result.stderr);
  return result.stdout.trim();
}
function commit() {
  command('add', '-A');
  command('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-m', 'fixture');
}
function write(path: string, text: string) {
  mkdirSync(join(root, path, '..'), { recursive: true });
  writeFileSync(join(root, path), text);
}
function key(cwd = root, env: NodeJS.ProcessEnv = process.env, cmd = ['bun', 'test']) {
  return checkResultKey({ root, cwd, command: cmd, env }).key;
}

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'goal-check-results-'));
  command('init', '-q');
  write('package.json', JSON.stringify({ name: 'fixture', dependencies: { '@fixture/a': 'workspace:*' } }));
  write('bun.lock', 'lock one');
  write(
    'apps/app/package.json',
    JSON.stringify({ name: '@fixture/app', dependencies: { '@fixture/a': 'workspace:*' } }),
  );
  write('packages/a/package.json', JSON.stringify({ name: '@fixture/a' }));
  write('packages/a/src.ts', 'export const a = 1;');
  write('apps/app/src.ts', 'export const app = 1;');
  commit();
  db = openDb(':memory:');
  const { WorkerStore } = await import('./store.ts');
  results = new WorkerStore(db).checkResults;
});
afterEach(() => {
  db.close();
  rmSync(root, { recursive: true, force: true });
});

describe('check result reuse keys', () => {
  test('a passing check records its result under command, allowlisted environment, workspace closure, global inputs, and toolchain', () => {
    const k = checkResultKey({
      root,
      cwd: join(root, 'apps/app'),
      command: ['bun', 'test'],
      env: { PATH: '/bin', SECRET: 'ignored' },
    });
    results.record({
      key: k.key,
      unit: k.unit,
      passed: true,
      producer: 'test',
      host: 'host',
      duration: 3,
      logPath: 'pass.log',
      time: Date.now(),
      schemaVersion: 1,
    });
    expect(results.lookup(k.key)?.unit).toContain('packages/a');
    expect(results.lookup(k.key)?.passed).toBe(true);
  });

  test('an unchanged command key hits, while closure, lockfile, global input, and toolchain changes miss', () => {
    const first = key(join(root, 'apps/app'));
    expect(key(join(root, 'apps/app'))).toBe(first);
    expect(key(join(root, 'apps/app'), process.env, ['bun', 'run', 'typecheck'])).not.toBe(first);
    write('packages/a/src.ts', 'export const a = 2;');
    commit();
    const closureChanged = key(join(root, 'apps/app'));
    expect(closureChanged).not.toBe(first);
    write('bun.lock', 'lock two');
    commit();
    const lockChanged = key(join(root, 'apps/app'));
    expect(lockChanged).not.toBe(closureChanged);
    write('tsconfig.json', '{}');
    commit();
    expect(key(join(root, 'apps/app'))).not.toBe(lockChanged);
    expect(
      checkResultKey({
        root,
        cwd: join(root, 'apps/app'),
        command: ['bun', 'test'],
        env: { ...process.env, PATH: '/different' },
      }).key,
    ).not.toBe(key(join(root, 'apps/app')));
    expect(
      checkResultKey({
        root,
        cwd: join(root, 'apps/app'),
        command: ['bun', 'test'],
        toolchain: { bunRevision: 'other' },
      }).key,
    ).not.toBe(key(join(root, 'apps/app')));
  });

  test('failed, timed-out, infrastructure-failed, dirty-tree, mutating, and external-state checks never write reusable results', async () => {
    const log = join(root, 'run.log');
    const runner = gateRunner(30, undefined, { root, results });
    const before = key();
    expect((await runner(['sh', '-c', 'exit 1'], root, log)).passed).toBe(false);
    expect(results.lookup(before)).toBeUndefined();
    await expect(runner(['missing-check-command'], root, log)).rejects.toThrow();
    expect(results.lookup(before)).toBeUndefined();
    write('dirty', 'x');
    await runner(['sh', '-c', 'exit 0'], root, log);
    expect(results.lookup(before)).toBeUndefined();
    rmSync(join(root, 'dirty'));
    await runner(['sh', '-c', 'sleep 1'], root, log);
    expect(results.lookup(before)).toBeUndefined();
    await runner(['sh', '-c', 'touch generated'], root, log);
    expect(results.lookup(before)).toBeUndefined();
    expect(reusableCommand(['bun', 'test', 'live-mail.test.ts'])).toBe(false);
  });

  test('Reuse a passing check only for the same complete source inputs', () => {
    write('tools/goal/package.json', JSON.stringify({ name: '@fixture/goal' }));
    write('tools/goal/src.ts', 'export const g = 1;');
    write('tools/goal/nested/fixture.ts', 'export const nested = true;');
    write('docs/note.md', 'a');
    write('tools/other/src.ts', 'b');
    commit();
    const cmd = ['bun', 'test'];
    const app = key(join(root, 'apps/app'));
    const goal = checkResultKey({ root, cwd: join(root, 'tools/goal'), command: cmd, env: process.env });
    const docs = checkResultKey({ root, cwd: join(root, 'docs'), command: cmd, env: process.env });
    const other = checkResultKey({ root, cwd: join(root, 'tools/other'), command: cmd, env: process.env });
    expect(docs.key).not.toBe(other.key);
    results.record({
      key: goal.key,
      unit: goal.unit,
      passed: true,
      producer: 'test',
      host: 'host',
      duration: 1,
      logPath: 'goal.log',
      time: Date.now(),
      schemaVersion: 1,
    });
    expect(results.lookup(goal.key)?.passed).toBe(true);
    expect(results.lookup(key(join(root, 'tools/goal/nested'), process.env, cmd))).toBeUndefined();
    write('docs/note.md', 'changed');
    commit();
    expect(checkResultKey({ root, cwd: join(root, 'docs'), command: cmd, env: process.env }).key).not.toBe(docs.key);
    write('tools/goal/src.ts', 'export const g = 2;');
    commit();
    const changed = checkResultKey({ root, cwd: join(root, 'tools/goal'), command: cmd, env: process.env });
    expect(changed.key).not.toBe(goal.key);
    expect(results.lookup(changed.key)).toBeUndefined();
    expect(key(join(root, 'apps/app'))).toBe(app);
  });

  test('shadow mode logs hits, runs fresh checks, and alerts once when a hit fails', async () => {
    const freshCommand = ['sh', '-c', 'echo fresh; exit 1'];
    const k = checkResultKey({ root, cwd: root, command: freshCommand, env: process.env });
    results.record({
      key: k.key,
      unit: k.unit,
      passed: true,
      producer: 'prior',
      host: 'host',
      duration: 2,
      logPath: 'cached.log',
      time: Date.now(),
      schemaVersion: 1,
    });
    const alerts: string[] = [];
    const log = join(root, 'shadow.log');
    let runs = 0;
    const runner = gateRunner(1000, undefined, {
      root,
      results,
      shadow: true,
      alert: (message) => alerts.push(message),
    });
    const actual = await runner(freshCommand, root, log);
    runs++;
    expect(actual.passed).toBe(false);
    expect(runs).toBe(1);
    expect(await Bun.file(log).text()).toContain(`check-results: hit ${k.key}`);
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toContain('cached.log');
    expect(alerts[0]).toContain(log);
  });
});
