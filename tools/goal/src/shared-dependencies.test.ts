import { chmodSync, existsSync, lstatSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, readlinkSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { expect, test } from 'bun:test';
import { dependencyKey, installShared, pruneStores } from './shared-dependencies.ts';

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'goal-deps-'));
  const tree = (name: string) => {
    const path = join(root, name); mkdirSync(join(path, 'packages', 'sample'), { recursive: true });
    writeFileSync(join(path, 'package.json'), JSON.stringify({ name: 'fixture', workspaces: ['packages/*'] }));
    writeFileSync(join(path, 'packages/sample/package.json'), JSON.stringify({ name: '@test/sample', version: '1.0.0' }));
    const lock = Bun.spawnSync(['bun', 'install', '--lockfile-only'], { cwd: path });
    if (lock.exitCode !== 0) throw new Error(new TextDecoder().decode(lock.stderr));
    return path;
  };
  return { root, tree, close: () => {
    const writable = (dir: string) => { for (const name of readdirSync(dir)) { const path = join(dir, name); if (lstatSync(path).isDirectory()) writable(path); else if (!lstatSync(path).isSymbolicLink()) chmodSync(path, 0o644); } chmodSync(dir, 0o755); };
    writable(root); rmSync(root, { recursive: true, force: true });
  } };
}

test('worktrees with one key share a read-only store and retain local workspace links', () => {
  const h = fixture();
  try {
    const a = h.tree('a'), b = h.tree('b'), c = h.tree('c'), stores = join(h.root, 'stores');
    installShared(a, stores); installShared(b, stores); installShared(c, stores);
    const count = (dir: string): number => requireCount(dir);
    expect(count(join(a, 'node_modules'))).toBeLessThan(1000);
    expect(count(join(b, 'node_modules'))).toBeLessThan(1000);
    const aBun = resolve(a, 'node_modules/.bun'), bBun = resolve(b, 'node_modules/.bun');
    expect(bunTarget(a)).toBe(bunTarget(b));
    expect(aBun).not.toBe(bunTarget(a)); expect(bBun).not.toBe(bunTarget(a));
    expect(realpathSync(join(a, 'node_modules/@test/sample'))).toBe(resolve(a, 'packages/sample'));
    expect(realpathSync(join(b, 'node_modules/@test/sample'))).toBe(resolve(b, 'packages/sample'));
    expect(readlinkSync(join(a, 'node_modules/.bun'))).toContain('stores');
    expect(() => writeFileSync(join(b, 'node_modules/.bun/canary'), 'changed')).toThrow();
  } finally { h.close(); }
});

function bunTarget(worktree: string): string { return resolve(worktree, 'node_modules', readlinkSync(join(worktree, 'node_modules/.bun'))); }
function requireCount(dir: string): number {
  return readdirSync(dir).reduce((n: number, name: string) => { const path = join(dir, name); return n + 1 + (lstatSync(path).isDirectory() ? requireCount(path) : 0); }, 0);
}

test('manifest drift and the private command keep installs private', async () => {
  const h = fixture();
  try {
    const a = h.tree('a'), b = h.tree('b'), c = h.tree('c'), stores = join(h.root, 'stores');
    installShared(a, stores); installShared(b, stores); installShared(c, stores);
    writeFileSync(join(a, 'packages/sample/package.json'), '{"name":"@test/sample","version":"2"}');
    const updated = Bun.spawnSync(['bun', 'install', '--lockfile-only'], { cwd: a });
    if (updated.exitCode !== 0) throw new Error(new TextDecoder().decode(updated.stderr));
    installShared(a, stores);
    expect(lstatSync(join(a, 'node_modules/.bun')).isSymbolicLink()).toBe(false);
    expect(lstatSync(join(b, 'node_modules/.bun')).isSymbolicLink()).toBe(true);
    writeFileSync(join(b, 'bun.lock'), `${readFileSync(join(b, 'bun.lock'), 'utf8')}\n`);
    installShared(b, stores);
    expect(lstatSync(join(b, 'node_modules/.bun')).isSymbolicLink()).toBe(false);
    const cli = new URL('./cli.ts', import.meta.url).pathname;
    const command = Bun.spawn([process.execPath, cli, 'deps', 'private'], { cwd: c, stdout: 'pipe', stderr: 'pipe' });
    expect(await command.exited).toBe(0);
    expect(lstatSync(join(c, 'node_modules/.bun')).isSymbolicLink()).toBe(false);
    installShared(c, stores);
    expect(lstatSync(join(c, 'node_modules/.bun')).isSymbolicLink()).toBe(false);
  } finally { h.close(); }
});

test('an interrupted store build is discarded and the next use builds it cleanly', () => {
  const h = fixture();
  try {
    const a = h.tree('a'), stores = join(h.root, 'stores');
    // A malformed lockfile forces the build to fail before it can publish a store.
    writeFileSync(join(a, 'bun.lock'), '{}');
    expect(() => installShared(a, stores)).toThrow();
    expect(existsSync(join(stores, dependencyKey(a), 'node_modules/.bun'))).toBe(false);
    const lock = Bun.spawnSync(['bun', 'install', '--lockfile-only'], { cwd: a });
    if (lock.exitCode !== 0) throw new Error(new TextDecoder().decode(lock.stderr));
    installShared(a, stores);
    expect(existsSync(join(stores, dependencyKey(a), 'node_modules/.bun'))).toBe(true);
  } finally { h.close(); }
});

test('an install without node_modules/.bun stays private and publishes no store', () => {
  const h = fixture();
  try {
    const a = h.tree('a'), stores = join(h.root, 'stores');
    installShared(a, stores);
    expect(existsSync(join(a, '.goal-private-dependencies'))).toBe(true);
    expect(existsSync(join(stores, dependencyKey(a)))).toBe(false);
    expect(lstatSyncSafe(join(a, 'node_modules', '.bun'))).toBe(false);
  } finally { h.close(); }
});

test('concurrent first uses of the same key build one shared store', async () => {
  const h = fixture();
  try {
    const a = h.tree('a'), b = h.tree('b'), stores = join(h.root, 'stores'), bin = join(h.root, 'bin'), counter = join(h.root, 'builds');
    mkdirSync(bin);
    writeFileSync(join(bin, 'bun'), `#!/bin/sh\nif [ "$1" = "--version" ]; then echo fixture-bun; exit 0; fi\necho build >> ${counter}\nsleep 0.2\nmkdir -p node_modules/.bun/pkg/node_modules/pkg node_modules/@test\necho package > node_modules/.bun/pkg/node_modules/pkg/data\nln -s "$(pwd)/packages/sample" node_modules/@test/sample\n`);
    chmodSync(join(bin, 'bun'), 0o755);
    const module = new URL('./shared-dependencies.ts', import.meta.url).href;
    const source = `import { installShared } from ${JSON.stringify(module)}; installShared(process.cwd(), ${JSON.stringify(stores)});`;
    const childEnv = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith('GOAL_')));
    const options = { env: { ...childEnv, PATH: `${bin}:${process.env.PATH ?? ''}` }, stdout: 'pipe' as const, stderr: 'pipe' as const };
    const children = [a,b].map((cwd) => Bun.spawn([process.execPath,'-e',source], { ...options, cwd }));
    const results = await Promise.all(children.map(async (child) => ({ code: await child.exited, stderr: await new Response(child.stderr).text() })));
    expect(results).toEqual([{ code: 0, stderr: '' }, { code: 0, stderr: '' }]);
    expect(readFileSync(counter, 'utf8').trim().split('\n')).toHaveLength(1);
    expect(readlinkSync(join(a, 'node_modules/.bun'))).toBe(readlinkSync(join(b, 'node_modules/.bun')));
  } finally { h.close(); }
});

test('dependency keys include all workspace manifests and the lockfile', () => {
  const h = fixture();
  try {
    const a = h.tree('a'); const initial = dependencyKey(a);
    expect(dependencyKey(a)).toBe(initial);
    writeFileSync(join(a, 'packages/sample/package.json'), JSON.stringify({ name: '@test/a', version: '2.0.0' }));
    expect(dependencyKey(a)).not.toBe(initial);
    writeFileSync(join(a, 'bun.lock'), `${readFileSync(join(a, 'bun.lock'), 'utf8')}\n`);
    expect(dependencyKey(a)).not.toBe(initial);
    const b = h.tree('b'); expect(dependencyKey(b)).toBe(initial);
  } finally { h.close(); }
});

test('pruning removes only unused stores older than 24 hours and keeps the newest three', () => {
  const h = fixture();
  try {
    const root = join(h.root, 'stores'); const worktrees = join(h.root, 'trees'); mkdirSync(root); mkdirSync(worktrees);
    const stores = ['1'.repeat(64), '2'.repeat(64), '3'.repeat(64), '4'.repeat(64), '5'.repeat(64)];
    stores.forEach((key) => mkdirSync(join(root, key, 'node_modules', '.bun'), { recursive: true }));
    const tree = join(worktrees, 'a'); mkdirSync(join(tree, 'node_modules'), { recursive: true });
    symlinkSync(join(root, stores[0]!, 'node_modules', '.bun'), join(tree, 'node_modules', '.bun'), 'dir');
    const old = Date.now() - 25 * 60 * 60 * 1000;
    for (let i = 0; i < stores.length; i++) { const date = new Date(old + i * 1000); const path = join(root, stores[i]!); Bun.spawnSync(['touch', '-d', date.toISOString(), path]); }
    pruneStores(root, worktrees);
    expect(existsSync(join(root, stores[0]!))).toBe(true);
    expect(existsSync(join(root, stores[1]!))).toBe(false);
    expect(stores.filter((key) => existsSync(join(root, key)))).toHaveLength(4);
  } finally { h.close(); }
});
