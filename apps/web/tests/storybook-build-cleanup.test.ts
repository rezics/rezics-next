import { expect, test } from 'bun:test';
import {
  chmodSync,
  existsSync,
  fchmodSync as chmodFileDescriptorSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
  type Stats,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { cleanupStorybookUiOutput, type StorybookCleanupFileSystem } from '../scripts/storybook-build-cleanup.ts';

const worktree = resolve(import.meta.dir, '../../..');

function fixture() {
  const sharedTemp = join(worktree, '.temp');
  mkdirSync(sharedTemp, { recursive: true });
  const fixtureRoot = mkdtempSync(join(sharedTemp, 'storybook-cleanup-fixture-'));
  const temporaryRoot = join(fixtureRoot, '.temp');
  const outputRoot = join(temporaryRoot, `storybook-ui-${process.pid}`);
  mkdirSync(outputRoot, { recursive: true });
  return { fixtureRoot, outputRoot };
}

function removeFixture(fixtureRoot: string, readOnlyDirectories: string[] = []) {
  for (const path of readOnlyDirectories) {
    try {
      chmodSync(path, 0o700);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
  rmSync(fixtureRoot, { recursive: true, force: true });
}

test('removes nested owner-read-only output without touching a symlink target outside it', () => {
  const { fixtureRoot, outputRoot } = fixture();
  const manager = join(outputRoot, 'sb-manager');
  const assets = join(manager, 'sb-common-assets');
  const chunks = join(manager, '_manager-chunks');
  const outsideRoot = mkdtempSync(join(worktree, '.temp/storybook-cleanup-shared-'));
  const outsideFile = join(outsideRoot, 'dependency-source.ts');
  const linkedSource = join(outputRoot, 'shared-source');
  mkdirSync(assets, { recursive: true });
  mkdirSync(chunks, { recursive: true });
  writeFileSync(join(chunks, 'manager.js'), 'generated');
  writeFileSync(outsideFile, 'shared source');
  chmodSync(manager, 0o555);
  chmodSync(assets, 0o555);
  chmodSync(chunks, 0o555);
  chmodSync(outsideRoot, 0o555);
  symlinkSync(outsideRoot, linkedSource, 'dir');

  try {
    cleanupStorybookUiOutput(fixtureRoot);
    expect(existsSync(outputRoot)).toBe(false);
    expect(existsSync(outsideFile)).toBe(true);
    expect(statSync(outsideRoot).mode & 0o777).toBe(0o555);
  } finally {
    chmodSync(outsideRoot, 0o700);
    rmSync(outsideRoot, { recursive: true, force: true });
    removeFixture(fixtureRoot, [manager, assets, chunks]);
  }
});

test('refuses a generated root that is a symlink to an outside directory', () => {
  const { fixtureRoot, outputRoot } = fixture();
  const outsideRoot = mkdtempSync(join(worktree, '.temp/storybook-cleanup-unexpected-'));
  const outsideFile = join(outsideRoot, 'keep.txt');
  writeFileSync(outsideFile, 'keep');
  rmSync(outputRoot, { recursive: true, force: true });
  symlinkSync(outsideRoot, outputRoot, 'dir');

  try {
    expect(() => cleanupStorybookUiOutput(fixtureRoot)).toThrow(/generated root is not a real directory/);
    expect(lstatSync(outputRoot).isSymbolicLink()).toBe(true);
    expect(existsSync(outsideFile)).toBe(true);
  } finally {
    rmSync(outputRoot);
    rmSync(outsideRoot, { recursive: true, force: true });
    removeFixture(fixtureRoot);
  }
});

test('refuses an unowned nested directory before chmod or recursive removal', () => {
  const { fixtureRoot, outputRoot } = fixture();
  const unownedDirectory = join(outputRoot, 'unexpected-owner');
  mkdirSync(unownedDirectory);
  chmodSync(unownedDirectory, 0o555);
  let chmodCalls = 0;
  const fileSystem: Partial<StorybookCleanupFileSystem> = {
    lstatSync(path) {
      const stats = lstatSync(path);
      if (resolve(path) !== unownedDirectory) return stats;
      const unowned = Object.create(stats) as Stats;
      Object.defineProperty(unowned, 'uid', { value: stats.uid + 1 });
      return unowned;
    },
    fchmodSync(fd, mode) {
      chmodCalls += 1;
      chmodFileDescriptorSync(fd, mode);
    },
  };

  try {
    expect(() => cleanupStorybookUiOutput(fixtureRoot, fileSystem)).toThrow(/unowned Storybook output directory/);
    expect(chmodCalls).toBe(0);
    expect(existsSync(outputRoot)).toBe(true);
    expect(statSync(unownedDirectory).mode & 0o777).toBe(0o555);
  } finally {
    removeFixture(fixtureRoot, [unownedDirectory]);
  }
});
