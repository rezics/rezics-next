import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { openDb } from './db.ts';
import { SqliteManagerInbox } from './inbox.ts';
import { harness, temporaryDirectory } from './test-support.ts';

const git = (cwd: string, ...args: string[]) => spawnSync('git', args, { cwd, encoding: 'utf8' });

test('a task worktree gets its own dependency install instead of resolving from the main checkout', () => {
  const h = harness();
  try {
    writeFileSync(join(h.root, 'package.json'), JSON.stringify({ name: 'fixture', private: true, workspaces: ['packages/*'] }));
    mkdirSync(join(h.root, 'packages/shared'), { recursive: true });
    writeFileSync(join(h.root, 'packages/shared/package.json'), JSON.stringify({ name: 'shared', version: '1.0.0', private: true }));
    writeFileSync(join(h.root, '.gitignore'), '.temp/\nnode_modules/\n');
    expect(spawnSync('bun', ['install'], { cwd: h.root }).status).toBe(0);
    git(h.root, 'add', '.'); git(h.root, 'commit', '-qm', 'Add a workspace');
    const task = h.tasks.dispatch(h.briefFile);
    expect(existsSync(join(task.worktree, 'node_modules'))).toBe(true);
    expect(lstatSync(join(task.worktree, 'node_modules/shared')).isSymbolicLink()).toBe(true);
  } finally { h.dispose(); }
});

test('inbox send with an unknown kind fails loudly and names the valid kinds', () => {
  const t = temporaryDirectory(); const db = openDb(join(t.path, 'state.sqlite'));
  const inbox = new SqliteManagerInbox(db, t.path);
  try {
    const result = spawnSync(process.execPath, [join(import.meta.dir, 'fixtures/cli-runtime.ts'), 'inbox', 'send', 'supermanager', 'defect', 'A defect'],
      { env: { ...process.env, FAKE_GOAL_STATE: t.path, FAKE_GOAL_MAIN: t.path, GOAL_MANAGER: 'web' }, encoding: 'utf8' });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('defect');
    expect(result.stderr).toContain('spec-conflict');
    expect(inbox.read('supermanager')).toEqual([]);
  } finally { db.close(); t.close(); }
});
