import { spawnSync } from 'node:child_process';
import {
  closeSync,
  constants,
  existsSync,
  fchmodSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import {
  lstat as lstatAsync,
  open as openAsync,
  readdir as readdirAsync,
  rm as rmAsync,
  type FileHandle,
} from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { controlPlaneReleaseBrief } from './briefs.ts';
import { frozenFile, parseFrozenFiles, type FrozenFile } from './frozen.ts';
import { acquireDirectoryLeaseWaiting } from './lease.ts';
import { gitOutputError } from './merge.ts';
import { defaultPolicy } from './policy.ts';
import { installShared } from './shared-dependencies.ts';
import type { WorkerStore } from './store.ts';
import type { Attempt, Settings, Task } from './types.ts';

export type FrozenTask = Task & { frozenFiles?: Pick<FrozenFile, 'path' | 'hash'>[] };
type FrozenCommit = { files: FrozenFile[]; formatterError?: string };

export function frozenFiles(task: Task): Pick<FrozenFile, 'path' | 'hash'>[] {
  return (task as FrozenTask).frozenFiles ?? [];
}

function frozenFileAtBase(worktree: string, base: string, path: string): Buffer | undefined {
  const entry = spawnSync('git', ['--literal-pathspecs', 'ls-tree', '-z', base, '--', path], {
    cwd: worktree,
    encoding: 'buffer',
  });
  if (entry.status !== 0) {
    const detail = entry.stderr?.toString('utf8').trim() || entry.error?.message || `git exited ${entry.status}`;
    throw new Error(`git ls-tree: ${detail}`);
  }
  const record = entry.stdout
    .toString('utf8')
    .split('\0')
    .find((candidate) => candidate.endsWith(`\t${path}`));
  if (!record) return undefined;
  const metadata = record.slice(0, record.indexOf('\t')).split(' ');
  const mode = metadata[0];
  const type = metadata[1];
  if (mode === '120000') throw new Error(`frozen file path crosses a symbolic link: ${path}`);
  if (type !== 'blob') throw new Error(`frozen file path is not a file on the task base: ${path}`);

  const content = spawnSync('git', ['show', `${base}:${path}`], { cwd: worktree, encoding: 'buffer' });
  if (content.status !== 0) {
    const detail = content.stderr?.toString('utf8').trim() || content.error?.message || `git exited ${content.status}`;
    throw new Error(`git show: ${detail}`);
  }
  return content.stdout;
}

export function commitFrozenFiles(
  worktree: string,
  files: readonly FrozenFile[],
  formatCommand: readonly string[],
  base?: string,
  previous: readonly Pick<FrozenFile, 'path' | 'hash'>[] = [],
  shared = false,
): FrozenCommit {
  const current = new Map(files.map((file) => [file.path, file]));
  const touched = new Set([...previous.map((file) => file.path), ...current.keys()]);
  for (const path of touched) {
    const target = resolve(worktree, path);
    const fromRoot = relative(resolve(worktree), target);
    if (!fromRoot || fromRoot.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) || isAbsolute(fromRoot))
      throw new Error(`invalid frozen file path: ${path}`);
    let component = resolve(worktree);
    for (const part of path.split('/')) {
      component = join(component, part);
      try {
        if (lstatSync(component).isSymbolicLink()) throw new Error(`frozen file path crosses a symbolic link: ${path}`);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        break;
      }
    }
    const file = current.get(path);
    if (file) {
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, file.content, 'utf8');
    } else {
      if (!base) throw new Error(`cannot unfreeze file without a task base: ${path}`);
      const original = frozenFileAtBase(worktree, base, path);
      if (original) {
        mkdirSync(dirname(target), { recursive: true });
        writeFileSync(target, original);
      } else if (existsSync(target)) rmSync(target, { force: true });
    }
  }
  if (!touched.size) return { files: [] };
  let formatterError: string | undefined;
  const formatterAvailable = !formatCommand[0]!.endsWith('/node_modules/.bin/oxfmt') || existsSync(formatCommand[0]!);
  if (current.size && formatterAvailable) {
    const formatted = spawnSync(formatCommand[0]!, [...formatCommand.slice(1), ...current.keys()], {
      cwd: worktree,
      encoding: 'utf8',
    });
    if (formatted.status !== 0) {
      formatterError =
        `${formatted.stdout ?? ''}${formatted.stderr ?? ''}`.trim() ||
        formatted.error?.message ||
        `formatter exited with status ${formatted.status}`;
      // Some formatters write earlier files before failing on a later one. A rejected brief must remain byte-for-byte
      // intact so its hashes and the manager's repair target still describe the source the worker received.
      for (const file of files) writeFileSync(join(worktree, file.path), file.content, 'utf8');
    }
  }
  const committedFiles = formatterError
    ? [...files]
    : files.map((file) => frozenFile(file.path, readFileSync(join(worktree, file.path))));
  const existing = [...current.keys()];
  if (existing.length) git(worktree, ['add', '-A', '--', ...existing]);
  const removed = previous.map((file) => file.path).filter((path) => !current.has(path));
  if (removed.length) git(worktree, ['add', '-u', '--', ...removed]);
  const status = spawnSync('git', ['diff', '--cached', '--quiet', ...(shared ? ['--', ...touched] : [])], {
    cwd: worktree,
  });
  if (status.status !== 0)
    git(worktree, ['commit', '-m', 'test: frozen acceptance files', ...(shared ? ['--only', '--', ...touched] : [])]);
  return { files: committedFiles, ...(formatterError ? { formatterError } : {}) };
}

export function reportFrozenFormatError(error: string | undefined): void {
  if (error) console.error(`Frozen acceptance formatter failed:\n${error}`);
}

export function git(cwd: string, args: string[], policy = defaultPolicy.merge): string {
  const result = spawnSync('git', args, {
    cwd,
    encoding: 'utf8',
    maxBuffer: policy.gitBufferBytes,
    timeout: policy.commandTimeoutMs,
  });
  const overflow = gitOutputError(result, policy.gitBufferBytes);
  if (overflow) throw overflow;
  if (result.status !== 0) {
    const detail = result.stderr?.trim() || result.error?.message || `git exited ${result.status}`;
    throw new Error(`git ${args[0]}: ${detail}`);
  }
  return result.stdout.trimEnd();
}

export function installWorktreeDependencies(worktree: string, settings: Settings): void {
  installShared(worktree, undefined, undefined, settings.policy);
}

export function branchHead(settings: Settings, branch: string, createFromMain: boolean): string {
  const reference = `refs/heads/${branch}`;
  try {
    return git(settings.mainCheckout, ['rev-parse', '--verify', reference], settings.policy?.merge);
  } catch {
    if (!createFromMain) throw new Error(`stabilize branch ${branch} does not exist`);
    const main = git(
      settings.mainCheckout,
      ['rev-parse', '--verify', `refs/heads/${settings.mainBranch}`],
      settings.policy?.merge,
    );
    try {
      git(settings.mainCheckout, ['branch', '--', branch, main], settings.policy?.merge);
    } catch (error) {
      try {
        return git(settings.mainCheckout, ['rev-parse', '--verify', reference], settings.policy?.merge);
      } catch {
        throw error;
      }
    }
    return main;
  }
}

export function taskBaseBranch(
  settings: Settings,
  brief: { goal?: string; target?: 'main' | 'stabilize'; after?: readonly string[] },
): string {
  // Dev tasks start from the integration head, as trunk-based work does. The verifier tracks progress and known
  // findings; promotion freezes the integration head and applies its independent full candidate gate. Control-plane
  // work for dev starts there too, since dev's tools/goal is ahead of main's until cp-sync publishes it.
  return controlPlaneReleaseBrief(brief)
    ? settings.mainBranch
    : brief.target === 'stabilize'
      ? settings.stabilizeBranch
      : settings.integrationBranch;
}

/** Control-plane briefs integrate into main; stabilize briefs use stabilize and other briefs use dev. */
export function taskBaseHead(settings: Settings, brief: { goal?: string; target?: 'main' | 'stabilize' }): string {
  return branchHead(
    settings,
    taskBaseBranch(settings, brief),
    controlPlaneReleaseBrief(brief) || brief.target !== 'stabilize',
  );
}

export function commitRetryLeftovers(settings: Settings, task: Task, attempt: number): void {
  // An attempt that stopped inside a conflicted rebase or merge leaves HEAD detached or half merged. The retry
  // rebases from the branch tip again and hands the worker the conflicted files, so the old operation is dropped.
  if (task.workspace) return;
  const gitPath = (name: string) =>
    resolve(task.worktree, git(task.worktree, ['rev-parse', '--git-path', name], settings.policy?.merge));
  // A git process killed under load leaves its index lock behind. The attempt has ended and this retry holds the
  // task's lease, so a lock a minute old belongs to nobody.
  const lock = gitPath('index.lock');
  if (
    existsSync(lock) &&
    Date.now() - statSync(lock).mtimeMs > (settings.policy ?? defaultPolicy).worker.worktreeLockAgeMs
  )
    rmSync(lock, { force: true });
  for (const [state, operation] of [
    ['rebase-merge', 'rebase'],
    ['rebase-apply', 'rebase'],
    ['MERGE_HEAD', 'merge'],
  ] as const) {
    if (!existsSync(gitPath(state))) continue;
    try {
      git(task.worktree, [operation, '--abort'], settings.policy?.merge);
    } catch (error) {
      if (operation !== 'rebase') throw error;
    }
    // A rebase interrupted while starting cannot always abort (no head-name yet); it never moved the branch.
    if (operation === 'rebase') rmSync(gitPath(state), { recursive: true, force: true });
  }
  // A setup that failed mid-rebase leaves HEAD detached at the commit it rebased onto. With no commit there that a
  // branch lacks, the branch checkout is the attempt's state.
  if (
    !git(task.worktree, ['branch', '--show-current'], settings.policy?.merge) &&
    !git(task.worktree, ['rev-list', 'HEAD', '--not', '--branches'], settings.policy?.merge)
  )
    git(task.worktree, ['checkout', '-f', task.branch], settings.policy?.merge);
  const branch = git(task.worktree, ['branch', '--show-current'], settings.policy?.merge);
  if (branch !== task.branch)
    throw new Error(`retry setup branch check failed: found ${branch || 'detached HEAD'}, expected ${task.branch}`);
  if (!git(task.worktree, ['status', '--porcelain', '--untracked-files=all'], settings.policy?.merge)) return;
  git(task.worktree, ['add', '-A'], settings.policy?.merge);
  git(task.worktree, ['commit', '-m', `wip: leftovers from attempt ${attempt}`], settings.policy?.merge);
}

/** A worker's acceptance runs on its worktree, so what lands is that worktree: commit what the worker left out. */
export function commitFinishedWork(settings: Settings, task: Task, attempt: number): boolean {
  if (task.brief.kind === 'verification') return false;
  if (task.workspace) return false;
  for (const state of ['rebase-merge', 'rebase-apply', 'MERGE_HEAD'])
    if (
      existsSync(resolve(task.worktree, git(task.worktree, ['rev-parse', '--git-path', state], settings.policy?.merge)))
    )
      return false;
  if (!git(task.worktree, ['status', '--porcelain', '--untracked-files=all'], settings.policy?.merge)) return false;
  git(task.worktree, ['add', '-A'], settings.policy?.merge);
  git(
    task.worktree,
    ['commit', '-m', `chore: commit work left uncommitted by attempt ${attempt}`],
    settings.policy?.merge,
  );
  return true;
}

export function prepareSharedFrozen(settings: Settings, store: WorkerStore, task: Task): void {
  const files = parseFrozenFiles(task.brief.markdown, task.brief.paths, settings.policy?.brief);
  const prior = frozenFiles(task);
  if (
    files.length === prior.length &&
    files.every((file) => prior.some((p) => p.path === file.path && p.hash === file.hash))
  )
    return;
  const frozen = commitFrozenFiles(task.worktree, files, settings.formatCommand, task.base, prior, true);
  store.updateTask({ taskId: task.id, attempt: task.currentAttempt }, (current) => {
    (current as FrozenTask).frozenFiles = frozen.files.map(({ path, hash }) => ({ path, hash }));
  });
  reportFrozenFormatError(frozen.formatterError);
}

/** Recreate a finished task's removed checkout while holding its task lease. */
export function ensureWorktree(settings: Settings, task: Task): void {
  if (existsSync(task.worktree)) return;
  const lease = acquireDirectoryLeaseWaiting(
    join(settings.stateDirectory, 'leases', 'dispatch'),
    (settings.policy ?? defaultPolicy).leases.dispatchWaitMs,
    settings.policy?.leases,
  );
  try {
    mkdirSync(dirname(task.worktree), { recursive: true });
    try {
      git(settings.mainCheckout, ['worktree', 'add', task.worktree, task.branch], settings.policy?.merge);
    } catch {
      git(settings.mainCheckout, ['worktree', 'prune'], settings.policy?.merge);
      git(settings.mainCheckout, ['worktree', 'add', task.worktree, task.branch], settings.policy?.merge);
    }
    if (task.brief.kind !== 'verification') installWorktreeDependencies(task.worktree, settings);
  } finally {
    lease.release();
  }
}

/** Prepare an authorized unreserved capture without rewriting retained empty-report branches. */
export function prepareProofWorktree(settings: Settings, store: WorkerStore, task: Task, ref: Attempt): Task {
  const captured = task.brief.proof!.sourceCommit;
  const tip = git(task.worktree, ['rev-parse', 'HEAD'], settings.policy?.merge);
  if (git(task.worktree, ['status', '--porcelain', '--untracked-files=all'], settings.policy?.merge))
    throw new Error('Proof source is read-only; worktree differs from captured commit');
  if (tip !== captured) {
    store.assertProofPreparation(ref);
    if (
      git(task.worktree, ['merge-base', task.base, tip], settings.policy?.merge) !== task.base ||
      git(task.worktree, ['diff', '--name-only', task.base, tip], settings.policy?.merge)
    )
      throw new Error(
        'Proof source is read-only; only an unreserved clean retained empty-report branch can prepare a fresh capture',
      );
    const worktree = join(settings.worktreeRoot, `${task.id}-proof-${captured}`);
    if (!existsSync(worktree))
      git(settings.mainCheckout, ['worktree', 'add', '--detach', worktree, captured], settings.policy?.merge);
    if (
      git(worktree, ['rev-parse', 'HEAD'], settings.policy?.merge) !== captured ||
      git(worktree, ['status', '--porcelain', '--untracked-files=all'], settings.policy?.merge)
    )
      throw new Error('Proof captured source preparation differs from its registered commit');
    store.event(ref, 'proof-source-prepared', {
      retainedWorktree: task.worktree,
      retainedBranch: task.branch,
      retainedHead: tip,
      worktree,
      sourceCommit: captured,
    });
    task = store.updateTask(ref, (current) => {
      current.worktree = worktree;
      current.base = captured;
    });
  }
  return task;
}

const directoryFlags = constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW;
const OWNED_TREE_ASYNC_YIELD_ENTRIES = 128;

function descriptorPath(fd: number): string {
  return `/proc/self/fd/${fd}`;
}

function sameInode(
  left: { dev: number | bigint; ino: number | bigint },
  right: { dev: number | bigint; ino: number | bigint },
): boolean {
  return BigInt(left.dev) === BigInt(right.dev) && BigInt(left.ino) === BigInt(right.ino);
}

function isDisappearedEntry(error: unknown): boolean {
  return error !== null && typeof error === 'object' && 'code' in error && error.code === 'ENOENT';
}

/**
 * Add owner-write on directories so a tree can be deleted. Files stay untouched (they may be hardlinks); symlinks
 * are not followed. `scripts/check-git.ts` publishes remote-check caches at 0555/0444, which plain `rm -rf` cannot
 * unlink until the directories are writable.
 */
export function makeOwnedTreeWritable(path: string): number {
  const root = resolve(path);
  const rootIdentity = lstatSync(root);
  if (rootIdentity.isSymbolicLink() || !rootIdentity.isDirectory())
    throw new Error(`refusing to rewrite a non-directory worktree path: ${path}`);
  let bytes = 0;
  const walk = (fd: number) => {
    const stat = fstatSync(fd);
    if ((stat.mode & 0o700) !== 0o700) fchmodSync(fd, (stat.mode & 0o7777) | 0o700);
    for (const name of readdirSync(descriptorPath(fd))) {
      const child = join(descriptorPath(fd), name);
      let before: ReturnType<typeof lstatSync>;
      try {
        before = lstatSync(child);
      } catch (error) {
        if (isDisappearedEntry(error)) continue;
        throw error;
      }
      if (!before.isDirectory() || before.isSymbolicLink()) {
        bytes += Number(before.size);
        continue;
      }
      let childFd: number;
      try {
        childFd = openSync(child, directoryFlags);
      } catch (error) {
        if (isDisappearedEntry(error)) continue;
        throw error;
      }
      try {
        if (!sameInode(before, fstatSync(childFd)))
          throw new Error(`refusing cleanup of replaced worktree directory: ${path}`);
        walk(childFd);
      } finally {
        closeSync(childFd);
      }
    }
  };
  const fd = openSync(root, directoryFlags);
  try {
    walk(fd);
  } finally {
    closeSync(fd);
  }
  return bytes;
}

/** Async cleanup walk for the manager host; keeps descriptor and inode checks while yielding between entries. */
export async function makeOwnedTreeWritableAsync(path: string): Promise<number> {
  const root = resolve(path);
  const rootIdentity = await lstatAsync(root);
  if (rootIdentity.isSymbolicLink() || !rootIdentity.isDirectory())
    throw new Error(`refusing to rewrite a non-directory worktree path: ${path}`);
  let bytes = 0;
  let visited = 0;
  const walk = async (fd: FileHandle): Promise<void> => {
    const stat = await fd.stat();
    if ((stat.mode & 0o700) !== 0o700) await fd.chmod((stat.mode & 0o7777) | 0o700);
    for (const name of await readdirAsync(descriptorPath(fd.fd))) {
      if (++visited % OWNED_TREE_ASYNC_YIELD_ENTRIES === 0)
        await new Promise<void>((resolveYield) => setImmediate(resolveYield));
      const child = join(descriptorPath(fd.fd), name);
      let before: Awaited<ReturnType<typeof lstatAsync>>;
      try {
        before = await lstatAsync(child);
      } catch (error) {
        if (isDisappearedEntry(error)) continue;
        throw error;
      }
      if (!before.isDirectory() || before.isSymbolicLink()) {
        bytes += Number(before.size);
        continue;
      }
      let childFd: FileHandle;
      try {
        childFd = await openAsync(child, directoryFlags);
      } catch (error) {
        if (isDisappearedEntry(error)) continue;
        throw error;
      }
      try {
        if (!sameInode(before, await childFd.stat()))
          throw new Error(`refusing cleanup of replaced worktree directory: ${path}`);
        await walk(childFd);
      } finally {
        await childFd.close();
      }
    }
  };
  const fd = await openAsync(root, directoryFlags);
  try {
    if (!sameInode(rootIdentity, await fd.stat()))
      throw new Error(`refusing cleanup of replaced worktree directory: ${path}`);
    await walk(fd);
  } finally {
    await fd.close();
  }
  return bytes;
}

/** Make owned directories writable, then remove the tree. Returns the file/symlink bytes counted on the walk. */
export function removeOwnedTree(path: string): number {
  const bytes = makeOwnedTreeWritable(path);
  rmSync(path, { recursive: true, force: true });
  if (existsSync(path)) throw new Error(`worktree path remains after writable cleanup: ${path}`);
  return bytes;
}

/** Async counterpart used by host cleanup so a large worktree cannot block manager RPC or heartbeat turns. */
export async function removeOwnedTreeAsync(path: string): Promise<number> {
  const bytes = await makeOwnedTreeWritableAsync(path);
  await rmAsync(path, { recursive: true, force: true });
  try {
    await lstatAsync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return bytes;
    throw error;
  }
  throw new Error(`worktree path remains after writable cleanup: ${path}`);
}

export function gitListsWorktree(mainCheckout: string, worktree: string, policy = defaultPolicy.merge): boolean {
  const target = resolve(worktree);
  return git(mainCheckout, ['worktree', 'list', '--porcelain'], policy)
    .split('\n')
    .some((line) => {
      if (!line.startsWith('worktree ')) return false;
      return resolve(line.slice('worktree '.length)) === target;
    });
}
