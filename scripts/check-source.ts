/** Shared candidate source catalogue and fingerprint; importing this module never starts a check CLI. */
import { createHash } from 'node:crypto';
import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readlinkSync,
  rmSync,
} from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { outputTreeInputExclusions } from './check-output-tree.ts';
import type { RemoteCheck } from './remote-check.ts';

export const REMOTE_TRANSPORT_FAILURE = 75;
/** Source and result manifests hash an empty directory as this digest so the transferred tree compares equal. */
export const EMPTY_DIRECTORY_DIGEST = createHash('sha256').update('directory\0').digest('hex');

export type CandidateSnapshot = {
  workspace: string;
  sourceHash: string;
  inputFiles: string[];
  indexTree: string;
  scratch: string;
};

export type CandidateSourceManifest = NonNullable<RemoteCheck['expectedSourceManifest']>;

export class CheckRunUnavailable extends Error {
  readonly exitCode = REMOTE_TRANSPORT_FAILURE;
}

/** Tracked and untracked files that exist, without Git's own data, installed packages and local scratch space. */
export function workspaceFiles(workspace: string): string[] {
  const listed = Bun.spawnSync(['git', 'ls-files', '-z', '--cached', '--others', '--exclude-standard'], {
    cwd: workspace,
    stdout: 'pipe',
    stderr: 'pipe',
  });
  if (listed.exitCode !== 0) throw new Error(`git ls-files failed in ${workspace}: ${listed.stderr.toString()}`);
  const files = listed.stdout.toString().split('\0').filter(Boolean);
  return [...new Set(files)].filter((file) => {
    const parts = file.split('/');
    if (
      parts[0] === '.git' ||
      parts.includes('.temp') ||
      parts.includes('node_modules') ||
      parts.some((part) =>
        ['build', 'dist', 'out', 'coverage', '.next', '.turbo', 'playwright-report', 'test-results'].includes(part),
      )
    )
      return false;
    try {
      return lstatSync(resolve(workspace, file)).isFile() || lstatSync(resolve(workspace, file)).isSymbolicLink();
    } catch {
      return false;
    }
  });
}

export function gitResult(root: string, args: string[], environment: NodeJS.ProcessEnv = {}) {
  return Bun.spawnSync(['git', '-c', 'core.hooksPath=/dev/null', '-C', root, ...args], {
    cwd: root,
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_NO_LAZY_FETCH: '1', ...environment },
    timeout: 30_000,
  });
}

export function git(root: string, args: string[], environment?: NodeJS.ProcessEnv): string {
  const result = gitResult(root, args, environment);
  if (result.exitCode !== 0)
    throw new CheckRunUnavailable(
      `check-run: Git ${args[0] ?? 'operation'} failed: ${result.stderr.toString().trim()}`,
    );
  return result.stdout.toString().trim();
}

/** Snapshot the exact staged tree without locking or refreshing another check's candidate index. */
export function candidateIndexTree(root: string, head = git(root, ['rev-parse', '--verify', 'HEAD^{commit}'])): string {
  const comparison = gitResult(root, ['diff-index', '--cached', '--quiet', '--ignore-submodules=none', head, '--'], {
    GIT_OPTIONAL_LOCKS: '0',
  });
  if (comparison.exitCode === 0) return git(root, ['rev-parse', `${head}^{tree}`]);
  if (comparison.exitCode !== 1)
    throw new CheckRunUnavailable(`check-run: Git diff-index failed: ${comparison.stderr.toString().trim()}`);

  const source = git(root, ['rev-parse', '--path-format=absolute', '--git-path', 'index']);
  const scratchParent = join(root, '.temp');
  mkdirSync(scratchParent, { recursive: true, mode: 0o700 });
  const scratch = mkdtempSync(join(scratchParent, 'check-index-'));
  try {
    const index = join(scratch, 'index');
    if (existsSync(source)) copyFileSync(source, index);
    return git(root, ['write-tree'], { GIT_INDEX_FILE: index });
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

export function gitList(root: string, args: string[]): string[] {
  const result = Bun.spawnSync(['git', '-c', 'core.hooksPath=/dev/null', '-C', root, ...args], {
    cwd: root,
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_NO_LAZY_FETCH: '1' },
    timeout: 30_000,
  });
  if (result.exitCode !== 0)
    throw new CheckRunUnavailable(
      `check-run: Git ${args[0] ?? 'operation'} failed: ${result.stderr.toString().trim()}`,
    );
  return result.stdout.toString().split('\0').filter(Boolean);
}

export function excludedTransferPath(file: string): boolean {
  const parts = file.split('/');
  return (
    parts[0] === '.git' ||
    parts.includes('.temp') ||
    parts.includes('node_modules') ||
    parts.some((part) =>
      ['build', 'dist', 'out', 'coverage', '.next', '.turbo', 'playwright-report', 'test-results'].includes(part),
    )
  );
}

export function assertContainedSymlink(root: string, absolute: string, target: string): void {
  if (isAbsolute(target))
    throw new CheckRunUnavailable(`check-run: absolute source symlink is not portable: ${relative(root, absolute)}`);
  const resolvedTarget = resolve(dirname(absolute), target);
  const inside = relative(root, resolvedTarget);
  if (inside === '..' || inside.startsWith(`..${sep}`) || isAbsolute(inside))
    throw new CheckRunUnavailable(`check-run: source symlink escapes the workspace: ${relative(root, absolute)}`);
}

export async function hashFile(file: string): Promise<string> {
  const hash = createHash('sha256');
  const reader = Bun.file(file).stream().getReader();
  while (true) {
    const chunk = await reader.read();
    if (chunk.done) break;
    hash.update(chunk.value);
  }
  return hash.digest('hex');
}

export async function inputFingerprint(
  root: string,
  files = workspaceFiles(root),
  excludedPaths: readonly string[] = [],
): Promise<string> {
  excludedPaths = outputTreeInputExclusions(excludedPaths);
  const hash = createHash('sha256');
  for (const file of [...files].sort()) {
    if (excludedPaths.some((path) => file === path || file.startsWith(`${path}/`))) continue;
    const absolute = resolve(root, file);
    const inside = relative(root, absolute);
    if (inside === '..' || inside.startsWith(`..${sep}`) || isAbsolute(inside))
      throw new CheckRunUnavailable(`check-run: Git listed an input outside the workspace: ${file}`);
    let stat;
    try {
      stat = lstatSync(absolute);
    } catch {
      continue; // A tracked deletion is part of the prepared snapshot and is recorded below.
    }
    hash.update(`${file}\0${stat.mode & 0o777}\0`);
    if (stat.isSymbolicLink()) {
      const target = readlinkSync(absolute);
      assertContainedSymlink(root, absolute, target);
      hash.update(`link\0${target}\0`);
    } else if (stat.isFile()) hash.update(`file\0${await hashFile(absolute)}\0`);
    else if (stat.isDirectory() && readdirSync(absolute).length === 0)
      hash.update(`directory\0${EMPTY_DIRECTORY_DIGEST}\0`);
    else throw new CheckRunUnavailable(`check-run: unsupported source input type: ${file}`);
  }
  for (const file of gitList(root, ['ls-files', '--deleted', '-z'])) {
    if (excludedTransferPath(file) || excludedPaths.some((path) => file === path || file.startsWith(`${path}/`)))
      continue;
    hash.update(`deleted\0${file}\0`);
  }
  const head = git(root, ['rev-parse', '--verify', 'HEAD^{commit}']);
  const indexTree = candidateIndexTree(root, head);
  hash.update(`HEAD\0${head}\0index\0${indexTree}\0`);
  return hash.digest('hex');
}

export function isDeclaredOutput(file: string, returns: readonly string[]): boolean {
  return outputTreeInputExclusions(returns).some((path) => file === path || file.startsWith(`${path}/`));
}

export async function buildCandidateSourceManifest(
  snapshot: CandidateSnapshot,
  returns: readonly string[],
): Promise<CandidateSourceManifest> {
  const entries: CandidateSourceManifest['entries'] = [];
  for (const path of [...snapshot.inputFiles].sort()) {
    if (excludedTransferPath(path) || isDeclaredOutput(path, returns)) continue;
    const absolute = resolve(snapshot.workspace, path);
    const inside = relative(snapshot.workspace, absolute);
    if (inside === '..' || inside.startsWith(`..${sep}`) || isAbsolute(inside))
      throw new CheckRunUnavailable(`check-run: source manifest path escapes the frozen workspace: ${path}`);
    let stats;
    try {
      stats = lstatSync(absolute);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw error;
    }
    const mode = stats.mode & 0o777;
    if (stats.isSymbolicLink()) {
      const target = readlinkSync(absolute);
      assertContainedSymlink(snapshot.workspace, absolute, target);
      entries.push({
        path,
        mode,
        kind: 'link',
        sha256: createHash('sha256').update(target).digest('hex'),
        target,
      });
    } else if (stats.isFile()) {
      entries.push({ path, mode, kind: 'file', sha256: await hashFile(absolute), target: null });
    } else if (stats.isDirectory() && readdirSync(absolute).length === 0) {
      entries.push({ path, mode, kind: 'directory', sha256: EMPTY_DIRECTORY_DIGEST, target: null });
    } else {
      throw new CheckRunUnavailable(`check-run: unsupported source manifest input type: ${path}`);
    }
    if (entries.length > 50_000) throw new CheckRunUnavailable('check-run: source manifest exceeds its file bound');
  }
  const deleted = gitList(snapshot.workspace, ['ls-files', '--deleted', '-z'])
    .filter((path) => !excludedTransferPath(path) && !isDeclaredOutput(path, returns))
    .sort();
  const head = git(snapshot.workspace, ['rev-parse', '--verify', 'HEAD^{commit}']);
  const indexTree = candidateIndexTree(snapshot.workspace, head);
  if (indexTree !== snapshot.indexTree)
    throw new CheckRunUnavailable('check-run: frozen candidate index changed before transfer');
  const hash = createHash('sha256');
  for (const entry of entries) {
    hash.update(`${entry.path}\0${entry.mode}\0`);
    if (entry.kind === 'file') hash.update(`file\0${entry.sha256}\0`);
    else if (entry.kind === 'directory') hash.update(`directory\0${entry.sha256}\0`);
    else hash.update(`link\0${entry.target}\0`);
  }
  for (const path of deleted) hash.update(`deleted\0${path}\0`);
  hash.update(`HEAD\0${head}\0index\0${indexTree}\0`);
  const sourceSha256 = hash.digest('hex');
  if (sourceSha256 !== snapshot.sourceHash)
    throw new CheckRunUnavailable('check-run: frozen source manifest does not match its candidate fingerprint');
  const manifest: CandidateSourceManifest = { sourceSha256, head, indexTree, entries, deleted };
  if (Buffer.byteLength(JSON.stringify(manifest)) > 8 * 1024 * 1024)
    throw new CheckRunUnavailable('check-run: source manifest exceeds its byte bound');
  return manifest;
}

/** Direct placement uses the same fingerprint/catalogue algorithm as frozen check-run admission. */
export async function currentCheckSourceManifest(
  root: string,
  returns: readonly string[] = [],
): Promise<CandidateSourceManifest> {
  const inputFiles = workspaceFiles(root);
  const sourceHash = await inputFingerprint(root, inputFiles, returns);
  return buildCandidateSourceManifest(
    { workspace: root, inputFiles, sourceHash, indexTree: candidateIndexTree(root), scratch: '' },
    returns,
  );
}
