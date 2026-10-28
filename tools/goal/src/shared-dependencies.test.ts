import { existsSync, mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'bun:test';
import { dependencyKey, pruneStores } from './shared-dependencies.ts';

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'goal-deps-'));
  const tree = (name: string) => {
    const path = join(root, name); mkdirSync(join(path, 'packages', 'sample'), { recursive: true });
    writeFileSync(join(path, 'package.json'), JSON.stringify({ name, workspaces: ['packages/*'] }));
    writeFileSync(join(path, 'packages/sample/package.json'), JSON.stringify({ name: `@test/${name}`, version: '1.0.0' }));
    writeFileSync(join(path, 'bun.lock'), '{}'); return path;
  };
  return { root, tree, close: () => rmSync(root, { recursive: true, force: true }) };
}

test('dependency keys include all workspace manifests and the lockfile', () => {
  const h = fixture();
  try {
    const a = h.tree('a'); const initial = dependencyKey(a);
    expect(dependencyKey(a)).toBe(initial);
    writeFileSync(join(a, 'packages/sample/package.json'), JSON.stringify({ name: '@test/a', version: '2.0.0' }));
    expect(dependencyKey(a)).not.toBe(initial);
    const b = h.tree('b'); expect(dependencyKey(b)).not.toBe(initial);
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
