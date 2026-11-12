import {
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  realpathSync,
  rmSync,
} from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';

/** Git invoked with the caller's existing checkout/policy helper. */
export type TrainWorkspaceGit = (cwd: string, ...args: string[]) => string;

export type TrainWorkspaceAbort = 'rebase' | 'merge';

export type TrainWorkspaceCleanup =
  | { readonly onError: 'throw' }
  | { readonly onError: 'ignore' }
  | { readonly onError: 'rm' }
  | { readonly onError: 'report'; readonly report: (error: unknown) => void };

export type TrainWorkspaceProfile = {
  readonly abort?: readonly TrainWorkspaceAbort[];
  readonly capture?: 'create' | 'release';
  readonly cleanup: TrainWorkspaceCleanup;
};

export type OpenTrainWorkspaceOptions = {
  readonly checkout: string;
  readonly worktreeRoot: string;
  readonly tree: string;
  readonly revision: string;
  readonly git: TrainWorkspaceGit;
  readonly profile: TrainWorkspaceProfile;
};

export type TrainWorkspace = {
  readonly tree: string;
  readonly prepareRemoval?: () => void;
  release(): void;
};

function isDisappearedEntry(error: unknown): boolean {
  return error !== null && typeof error === 'object' && 'code' in error && error.code === 'ENOENT';
}

/** Capture only a newly added disposable train tree, before any check can leave immutable fixture directories. */
export function captureTrainWorktreeRemoval(tree: string): () => void {
  const path = resolve(tree);
  const parentPath = dirname(path);
  const parent = realpathSync(parentPath);
  const rootIdentity = lstatSync(path);
  const parentIdentity = lstatSync(parent);
  const sameInode = (left: ReturnType<typeof fstatSync>, right: ReturnType<typeof fstatSync>) =>
    left.dev === right.dev && left.ino === right.ino;
  const refuse = () => new Error(`Refusing cleanup of replaced train worktree: ${path}`);
  if (!rootIdentity.isDirectory() || !parentIdentity.isDirectory()) throw refuse();
  const flags = constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW;
  const descriptorPath = (fd: number) => `/proc/self/fd/${fd}`;
  const prepare = (fd: number) => {
    const stat = fstatSync(fd);
    if (stat.dev !== rootIdentity.dev) throw new Error(`Refusing cleanup across train filesystem boundary: ${path}`);
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
      // Directory permissions govern deletion. Never chmod package files (which can be hardlinks), or follow links
      // to shared dependency stores, another worktree, or any other outside directory.
      if (!before.isDirectory()) continue;
      let childFd: number;
      try {
        childFd = openSync(child, flags);
      } catch (error) {
        if (isDisappearedEntry(error)) continue;
        throw error;
      }
      try {
        if (!sameInode(before, fstatSync(childFd))) throw refuse();
        prepare(childFd);
        try {
          if (!sameInode(before, lstatSync(child))) throw refuse();
        } catch (error) {
          if (!isDisappearedEntry(error)) throw error;
        }
      } finally {
        closeSync(childFd);
      }
    }
  };
  return () => {
    if (realpathSync(parentPath) !== parent) throw refuse();
    const parentFd = openSync(parent, flags);
    try {
      if (!sameInode(parentIdentity, fstatSync(parentFd))) throw refuse();
      const rootFd = openSync(join(descriptorPath(parentFd), basename(path)), flags);
      try {
        if (!sameInode(rootIdentity, fstatSync(rootFd))) throw refuse();
        prepare(rootFd);
        if (!sameInode(rootIdentity, lstatSync(path))) throw refuse();
      } finally {
        closeSync(rootFd);
      }
    } finally {
      closeSync(parentFd);
    }
  };
}

/** Add a detached train-owned temporary worktree and return its release operations. */
export function openTrainWorkspace(options: OpenTrainWorkspaceOptions): TrainWorkspace {
  const { checkout, tree, revision, git, profile } = options;
  mkdirSync(resolve(options.worktreeRoot), { recursive: true });
  git(checkout, 'worktree', 'add', '--detach', tree, revision);
  const prepareRemoval = profile.capture === 'create' ? captureTrainWorktreeRemoval(tree) : undefined;
  return {
    tree,
    ...(prepareRemoval ? { prepareRemoval } : {}),
    release() {
      for (const operation of profile.abort ?? []) {
        try {
          git(tree, operation, '--abort');
        } catch {}
      }
      const remove = () => {
        if (profile.capture === 'release') captureTrainWorktreeRemoval(tree)();
        else prepareRemoval?.();
        git(checkout, 'worktree', 'remove', '--force', tree);
      };
      if (profile.cleanup.onError === 'throw') {
        remove();
        return;
      }
      try {
        remove();
      } catch (error) {
        if (profile.cleanup.onError === 'report') profile.cleanup.report(error);
        else if (profile.cleanup.onError === 'rm') rmSync(tree, { recursive: true, force: true });
      }
    },
  };
}
