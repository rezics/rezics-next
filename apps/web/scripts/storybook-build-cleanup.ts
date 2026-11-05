import {
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  lstatSync,
  openSync,
  readdirSync,
  rmSync,
  type Stats,
} from 'node:fs';
import { join, resolve } from 'node:path';

export interface StorybookCleanupFileSystem {
  lstatSync(path: string): Stats;
  readdirSync(path: string): string[];
  openSync(path: string, flags: number): number;
  fstatSync(fd: number): Stats;
  fchmodSync(fd: number, mode: number): void;
  closeSync(fd: number): void;
  rmSync(path: string, options: { recursive: boolean; force: boolean }): void;
}

const systemFileSystem: StorybookCleanupFileSystem = {
  lstatSync: (path) => lstatSync(path),
  readdirSync: (path) => readdirSync(path, { encoding: 'utf8' }),
  openSync: (path, flags) => openSync(path, flags),
  fstatSync: (fd) => fstatSync(fd),
  fchmodSync: (fd, mode) => fchmodSync(fd, mode),
  closeSync: (fd) => closeSync(fd),
  rmSync: (path, options) => rmSync(path, options),
};

function sameDirectory(left: Stats, right: Stats) {
  return left.isDirectory() && right.isDirectory() && left.dev === right.dev && left.ino === right.ino;
}

function requireDirectory(path: string, label: string, fileSystem: StorybookCleanupFileSystem) {
  const stats = fileSystem.lstatSync(path);
  if (stats.isSymbolicLink() || !stats.isDirectory()) {
    throw new Error(`Refusing to clean Storybook output: ${label} is not a real directory (${path}).`);
  }
  return stats;
}

function lstatIfPresent(path: string, fileSystem: StorybookCleanupFileSystem) {
  try {
    return fileSystem.lstatSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

export function cleanupStorybookUiOutput(worktreeRoot: string, overrides: Partial<StorybookCleanupFileSystem> = {}) {
  const fileSystem = { ...systemFileSystem, ...overrides };
  const ownerUid = process.getuid?.();
  if (ownerUid === undefined) {
    throw new Error('Cannot verify ownership of generated Storybook output on this platform.');
  }
  const worktree = resolve(worktreeRoot);
  requireDirectory(worktree, 'worktree root', fileSystem);

  const temporaryRoot = join(worktree, '.temp');
  const temporaryStats = lstatIfPresent(temporaryRoot, fileSystem);
  if (!temporaryStats) return;
  if (temporaryStats.isSymbolicLink() || !temporaryStats.isDirectory()) {
    throw new Error(`Refusing to clean Storybook output: .temp is not a real directory (${temporaryRoot}).`);
  }

  const outputRoot = join(temporaryRoot, `storybook-ui-${process.pid}`);
  const outputStats = lstatIfPresent(outputRoot, fileSystem);
  if (!outputStats) return;
  if (outputStats.isSymbolicLink() || !outputStats.isDirectory()) {
    throw new Error(`Refusing to clean Storybook output: generated root is not a real directory (${outputRoot}).`);
  }
  if (outputStats.uid !== ownerUid) {
    throw new Error(`Refusing to clean unowned Storybook output directory: ${outputRoot}.`);
  }

  const directories: { path: string; stats: Stats }[] = [];
  const inspect = (path: string, stats: Stats) => {
    if (stats.isSymbolicLink() || !stats.isDirectory()) return;
    if (stats.uid !== ownerUid) {
      throw new Error(`Refusing to clean unowned Storybook output directory: ${path}.`);
    }
    directories.push({ path, stats });
    for (const name of fileSystem.readdirSync(path)) {
      const child = join(path, name);
      const childStats = fileSystem.lstatSync(child);
      if (!childStats.isSymbolicLink() && childStats.isDirectory()) inspect(child, childStats);
    }
  };
  inspect(outputRoot, outputStats);

  for (const directory of directories) {
    const fd = fileSystem.openSync(directory.path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    try {
      const opened = fileSystem.fstatSync(fd);
      if (!sameDirectory(directory.stats, opened) || opened.uid !== ownerUid) {
        throw new Error(`Refusing to change an unexpected Storybook output directory: ${directory.path}.`);
      }
      const permissions = opened.mode & 0o7777;
      const writableAndSearchable = permissions | 0o300;
      if (permissions !== writableAndSearchable) fileSystem.fchmodSync(fd, writableAndSearchable);
    } finally {
      fileSystem.closeSync(fd);
    }
  }

  const currentRoot = fileSystem.lstatSync(outputRoot);
  if (currentRoot.isSymbolicLink() || currentRoot.uid !== ownerUid || !sameDirectory(outputStats, currentRoot)) {
    throw new Error(`Refusing to remove an unexpected Storybook output directory: ${outputRoot}.`);
  }
  fileSystem.rmSync(outputRoot, { recursive: true, force: true });
}
