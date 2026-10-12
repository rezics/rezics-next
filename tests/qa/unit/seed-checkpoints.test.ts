import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fixtureRoot, root } from '../../../scripts/fixture/stack.ts';
import { acquireSeedBuildLock, readRetainedSeed, seedDirectory, seedDirectoryForFixtureRoot, SEED_BUILD_COMMAND }
  from '../support/seed-checkpoints.ts';

test('retained seed checkpoints use the shared fixture temp directory and follow fixture-root overrides', () => {
  const common = spawnSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'],
    { cwd: root, encoding: 'utf8' });
  expect(common.status).toBe(0);
  const sharedFixtureRoot = join(dirname(common.stdout.trim()), '.temp', 'fixture');
  const activeFixtureRoot = process.env.REZICS_FIXTURE_ROOT
    ? resolve(process.env.REZICS_FIXTURE_ROOT) : sharedFixtureRoot;
  expect(seedDirectory).toBe(seedDirectoryForFixtureRoot(activeFixtureRoot));
  expect(seedDirectoryForFixtureRoot(join(root, '.temp', 'fixture-override', 'fixture')))
    .toBe(join(root, '.temp', 'fixture-override', 'work-profiles', 'seed-checkpoints'));
  expect(fixtureRoot).toBe(activeFixtureRoot);
});

test('routine seed restore rejects absent, partial and invalid preparation with the explicit build command', () => {
  mkdirSync('.temp/seed-checkpoint-read', { recursive: true });
  const directory = mkdtempSync('.temp/seed-checkpoint-read/check-');
  const path = join(directory, 'retained.json');
  try {
    expect(() => readRetainedSeed(path)).toThrow(`absent. Build them explicitly: ${SEED_BUILD_COMMAND}`);
    writeFileSync(path, JSON.stringify({ format: 'seed-checkpoints-v2', cuts: [] }));
    expect(() => readRetainedSeed(path)).toThrow(`incomplete. Build them explicitly: ${SEED_BUILD_COMMAND}`);
    writeFileSync(path, '{');
    expect(() => readRetainedSeed(path)).toThrow(`invalid. Build them explicitly: ${SEED_BUILD_COMMAND}`);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('a second retained seed build reports its holder and exact stale-lock removal command', () => {
  mkdirSync('.temp', { recursive: true });
  const directory = mkdtempSync('.temp/seed-checkpoint-lock-');
  const lockPath = join(directory, '.build.lock');
  const release = acquireSeedBuildLock('holder-run', directory);
  try {
    expect(() => acquireSeedBuildLock('waiting-run', directory)).toThrow(
      `Seed checkpoint build lock exists for pid ${process.pid} and run ID "holder-run". If the holder has stopped, remove it with: rm -f -- '${lockPath}'`);
  } finally {
    release();
    rmSync(directory, { recursive: true, force: true });
  }

  const staleDirectory = mkdtempSync('.temp/seed-checkpoint-stale-');
  const stalePath = join(staleDirectory, '.build.lock');
  const stalePid = 2_147_483_647;
  writeFileSync(stalePath, JSON.stringify({ pid: stalePid, runId: 'stale-run', token: 'stale-token' }));
  try {
    expect(() => acquireSeedBuildLock('waiting-run', staleDirectory)).toThrow(
      `Seed checkpoint build lock exists for pid ${stalePid} and run ID "stale-run" (stale: process is not running). If the holder has stopped, remove it with: rm -f -- '${stalePath}'`);
    expect(existsSync(stalePath)).toBe(true);
  } finally { rmSync(staleDirectory, { recursive: true, force: true }); }
});
