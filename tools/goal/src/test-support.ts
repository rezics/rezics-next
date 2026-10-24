import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { git } from './merge.ts';

export function temporaryDirectory(): { path: string; close(): void } {
  const root = resolve(import.meta.dir, '../../../.temp/goal-tests');
  mkdirSync(root, { recursive: true });
  const path = mkdtempSync(join(root, 'case-'));
  return { path, close: () => rmSync(path, { recursive: true, force: true }) };
}
export function repository() {
  const temporary = temporaryDirectory();
  const main = join(temporary.path, 'main'); mkdirSync(main);
  git(main, 'init', '-b', 'main');
  git(main, 'config', 'user.email', 'test@example.invalid'); git(main, 'config', 'user.name', 'Test');
  writeFileSync(join(main, 'base'), 'base\n'); git(main, 'add', '.'); git(main, 'commit', '-m', 'Initial');
  return { ...temporary, main, commit(file: string, content = file) {
    writeFileSync(join(main, file), content); git(main, 'add', '--', file); git(main, 'commit', '-m', `Change ${file}`);
  }, branch(name: string, file: string, content = file) {
    const worker = join(temporary.path, name);
    git(main, 'worktree', 'add', '-b', name, worker, 'main');
    writeFileSync(join(worker, file), content); git(worker, 'add', '.'); git(worker, 'commit', '-m', `Change ${file}`);
    return { taskId: name, attempt: 1, branch: name, worktree: worker, declaredPaths: [file], gate: ['true'] };
  } };
}
