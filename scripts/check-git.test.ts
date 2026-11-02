import { afterEach, expect, test } from 'bun:test';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { stageCheckGit, restoreCheckGit } from './check-git.ts';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function sandbox() {
  const root = mkdtempSync(join(tmpdir(), 'rezics-check-git-'));
  roots.push(root);
  return root;
}
function git(cwd: string, ...args: string[]) {
  const run = Bun.spawnSync(['git', ...args], {
    cwd,
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' },
    stdout: 'pipe',
    stderr: 'pipe',
    timeout: 10000,
  });
  expect(run.exitCode, run.stderr.toString()).toBe(0);
  return run.stdout.toString().trim();
}
function repository(root: string) {
  const source = join(root, 'source');
  mkdirSync(source);
  git(source, 'init', '-q');
  git(source, 'config', 'user.email', 'fixture@example.test');
  git(source, 'config', 'user.name', 'Fixture');
  writeFileSync(join(source, 'tracked.txt'), 'historical\n');
  writeFileSync(join(source, 'staged.txt'), 'old\n');
  git(source, 'add', 'tracked.txt', 'staged.txt');
  git(source, 'commit', '-qm', 'first native commit');
  const historical = git(source, 'rev-parse', 'HEAD');
  writeFileSync(join(source, 'tracked.txt'), 'base\n');
  git(source, 'commit', '-qam', 'second native commit');
  const base = git(source, 'rev-parse', 'HEAD');
  git(source, 'branch', 'dev', base);
  writeFileSync(join(source, 'tracked.txt'), 'committed\n');
  git(source, 'commit', '-qam', 'third native commit');
  const head = git(source, 'rev-parse', 'HEAD');
  return { source, historical, base, head };
}
function copyWorkingFiles(source: string, target: string) {
  mkdirSync(target);
  for (const file of ['tracked.txt', 'staged.txt', 'untracked.txt']) {
    if (existsSync(join(source, file))) cpSync(join(source, file), join(target, file));
  }
}

test('native check Git custody retains the candidate and base as shallow history with independent worktree creation', async () => {
  const root = sandbox();
  const { source, historical, base, head } = repository(root);
  const linked = join(root, 'linked-source');
  git(source, 'worktree', 'add', '--detach', linked, head);
  writeFileSync(join(linked, 'staged.txt'), 'staged\n');
  git(linked, 'add', 'staged.txt');
  writeFileSync(join(linked, 'tracked.txt'), 'unstaged\n');
  writeFileSync(join(linked, 'untracked.txt'), 'new\n');
  git(source, 'config', 'remote.private.url', 'https://secret.invalid/credential-must-not-travel');
  const original = git(linked, 'status', '--porcelain=v1');
  const artifacts = join(root, 'artifacts');
  mkdirSync(artifacts);
  const manifest = await stageCheckGit(linked, artifacts);
  const transferred = join(root, 'transferred');
  cpSync(artifacts, transferred, { recursive: true });
  const copiedManifest = join(transferred, manifest.slice(artifacts.length + 1));
  expect(dirname(manifest).startsWith(artifacts)).toBe(true);
  expect(git(linked, 'status', '--porcelain=v1')).toBe(original);
  const checkout = join(root, 'remote');
  copyWorkingFiles(linked, checkout);
  rmSync(linked, { recursive: true, force: true });
  rmSync(source, { recursive: true, force: true });
  rmSync(artifacts, { recursive: true, force: true });
  await restoreCheckGit(copiedManifest, checkout);
  expect(git(checkout, 'rev-parse', 'HEAD')).toBe(head);
  expect(git(checkout, 'rev-parse', '--is-shallow-repository')).toBe('true');
  expect(git(checkout, 'merge-base', 'dev', 'HEAD')).toBe(base);
  expect(git(checkout, 'diff', '--name-only', 'dev...HEAD')).toBe('tracked.txt');
  expect(git(checkout, 'rev-list', '--all')).not.toContain(historical);
  expect(git(checkout, 'status', '--porcelain=v1')).toBe(original);
  expect(readFileSync(join(checkout, 'tracked.txt'), 'utf8')).toBe('unstaged\n');
  expect(git(checkout, 'config', '--local', '--list')).not.toContain('credential-must-not-travel');
  const child = join(root, 'native-child');
  git(checkout, 'worktree', 'add', '--detach', child, 'HEAD');
  expect(readFileSync(join(child, 'tracked.txt'), 'utf8')).toBe('committed\n');
  git(checkout, 'worktree', 'remove', child);
}, 30000);

test('native check Git custody gives concurrent physical runs independent mutable indexes', async () => {
  const root = sandbox();
  const { source, head } = repository(root);
  git(source, 'branch', '-D', 'dev');
  writeFileSync(join(source, 'untracked.txt'), 'separate\n');
  const inputs = [join(root, 'input-one'), join(root, 'input-two')];
  for (const input of inputs) mkdirSync(input);
  const manifests = await Promise.all(inputs.map((input) => stageCheckGit(source, input)));
  const snapshot = JSON.parse(readFileSync(manifests[0]!, 'utf8')) as { dev: string | null; shallow: string };
  expect(snapshot.dev).toBeNull();
  expect(snapshot.shallow).toBe(head);
  const targets = [join(root, 'run-one'), join(root, 'run-two')];
  for (const target of targets) copyWorkingFiles(source, target);
  await Promise.all(targets.map((target, index) => restoreCheckGit(manifests[index]!, target)));
  expect(git(targets[0]!, 'rev-parse', '--is-shallow-repository')).toBe('true');
  writeFileSync(join(targets[0]!, 'tracked.txt'), 'only run one\n');
  git(targets[0]!, 'add', 'tracked.txt');
  expect(git(targets[0]!, 'diff', '--cached', '--name-only')).toBe('tracked.txt');
  expect(git(targets[1]!, 'diff', '--cached', '--name-only')).toBe('');
  expect(git(source, 'rev-parse', 'HEAD')).toBe(head);
  expect(git(source, 'diff', '--cached', '--name-only')).toBe('');
  expect(readFileSync(join(targets[1]!, 'tracked.txt'), 'utf8')).toBe('committed\n');
}, 30000);

test('native check Git custody rejects a corrupt manifest before publishing a usable repository', async () => {
  const root = sandbox();
  const { source } = repository(root);
  const artifacts = join(root, 'artifacts');
  mkdirSync(artifacts);
  const manifest = await stageCheckGit(source, artifacts);
  writeFileSync(manifest, 'corrupt incomplete snapshot\n');
  const checkout = join(root, 'remote');
  copyWorkingFiles(source, checkout);
  await expect(restoreCheckGit(manifest, checkout)).rejects.toThrow();
  expect(readFileSync(join(checkout, 'tracked.txt'), 'utf8')).toBe('committed\n');
  expect(existsSync(join(checkout, '.git'))).toBe(false);
}, 30000);
