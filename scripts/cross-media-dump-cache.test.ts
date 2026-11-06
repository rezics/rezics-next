import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import {
  CHECK_HOST_DUMP_CACHE,
  CHECK_HOST_DUMP_CACHE_LOCK_DIR,
  CROSS_MEDIA_DUMP_CACHE_ENV,
  DUMP_PIN_MARKER,
  assertPinnedCrossMediaDumpCache,
  commandNeedsCrossMediaDumpCache,
  dumpCacheRsyncArgs,
  hostDumpExtractScript,
  pinnedDumpArchivePaths,
  pinnedDumpExtractTargets,
} from './cross-media-dump-cache.ts';
import { BANGUMI_ARCHIVE_SHA256, BANGUMI_ARCHIVE_URL, DEVELOPMENT_VNDB_PIN } from './datasets/fetch-dumps.ts';
import { repositoryBun, runScript } from './remote-check.ts';

const repository = resolve(import.meta.dir, '..');

test('seeded walk and dump-fetch commands restore the host dump cache; ordinary checks do not', () => {
  expect(
    commandNeedsCrossMediaDumpCache([
      'env',
      'GOAL_TASK_ID=24256f23-7a74-4949-881c-7dbaea6b0207',
      'bun',
      'services/auth/scripts/dev-stack.ts',
      'walk',
      '--',
      'bun',
      'apps/web/scripts/vndb-seeded-journey.ts',
    ]),
  ).toBe(true);
  expect(commandNeedsCrossMediaDumpCache(['bun', 'scripts/datasets/cross-media-seed.ts', '--dev'])).toBe(true);
  expect(commandNeedsCrossMediaDumpCache(['bun', 'scripts/datasets/fetch-dumps.ts'])).toBe(true);
  expect(commandNeedsCrossMediaDumpCache(['bun', 'test', 'scripts/remote-check.test.ts'])).toBe(false);
  expect(commandNeedsCrossMediaDumpCache(['true'])).toBe(false);
});

test('a missing pinned archive refuses the seed instead of downloading a rotated dump', () => {
  const cacheRoot = mkdtempSync(join(repository, '.temp/dump-cache-missing-'));
  try {
    expect(() => assertPinnedCrossMediaDumpCache(cacheRoot)).toThrow(
      `Pinned bangumi dump is missing from ${cacheRoot}; restore the exact archive in the dump cache`,
    );
    const archives = pinnedDumpArchivePaths(cacheRoot);
    mkdirSync(join(cacheRoot, 'downloads'), { recursive: true });
    writeFileSync(archives.bangumi, 'bangumi');
    expect(() => assertPinnedCrossMediaDumpCache(cacheRoot)).toThrow(
      `Pinned vndb dump is missing from ${cacheRoot}; restore the exact archive in the dump cache`,
    );
    writeFileSync(archives.vndb, 'vndb');
    expect(() => assertPinnedCrossMediaDumpCache(cacheRoot)).not.toThrow();
    expect(archives.vndb.endsWith(DEVELOPMENT_VNDB_PIN.url.split('/').at(-1)!)).toBe(true);
    expect(archives.bangumi.endsWith(BANGUMI_ARCHIVE_URL.split('/').at(-1)!)).toBe(true);
  } finally {
    rmSync(cacheRoot, { recursive: true, force: true });
  }
});

test('dump-cache rsync copies only pinned archives onto the persistent host cache under an exclusive lock', () => {
  const args = dumpCacheRsyncArgs('/home/edge/projects/rezics/rezics-datasets/dumps', 'ops@a.test', 'ssh -i key');
  expect(args[0]).toBe('rsync');
  expect(args).toContain('-a');
  expect(args).toContain('--partial');
  expect(args).not.toContain('--compress');
  expect(args).not.toContain('--compress-choice=zstd');
  expect(args).toContain('--mkpath');
  expect(args).toContain(
    `--rsync-path=mkdir -p ${CHECK_HOST_DUMP_CACHE}/downloads ${CHECK_HOST_DUMP_CACHE_LOCK_DIR} && flock -x ${CHECK_HOST_DUMP_CACHE_LOCK_DIR}/.lock rsync`,
  );
  expect(args.at(-2)).toBe('/home/edge/projects/rezics/rezics-datasets/dumps/downloads/');
  expect(args.at(-1)).toBe(`ops@a.test:${CHECK_HOST_DUMP_CACHE}/downloads/`);
  expect(dumpCacheRsyncArgs('/cache/', 'ops@b.test', 'ssh').at(-2)).toBe('/cache/downloads/');
});

test('host dump extract reuses a matching pin marker and otherwise extracts under the dump-cache lock', () => {
  const script = hostDumpExtractScript();
  const archives = pinnedDumpArchivePaths(CHECK_HOST_DUMP_CACHE);
  const targets = pinnedDumpExtractTargets(CHECK_HOST_DUMP_CACHE);
  expect(script).toContain(`flock -x 9`);
  expect(script).toContain(DUMP_PIN_MARKER);
  expect(script).toContain(archives.bangumi);
  expect(script).toContain(archives.vndb);
  expect(script).toContain(targets.bangumi);
  expect(script).toContain(targets.vndb);
  expect(script).toContain(BANGUMI_ARCHIVE_SHA256);
  expect(script).toContain(DEVELOPMENT_VNDB_PIN.sha256);
  expect(script).toContain('unzip -qq');
  expect(script).toContain('tar --zstd -xf');
  expect(script).toContain('dump extract reused');
  expect(script).toContain('posix_fadvise');
});

test('remote runs always point seed at the host dump cache', () => {
  const script = runScript('dump-cache', '/srv/rezics-check/runs/dump-cache', '.', ['true'], 'a', repositoryBun(repository));
  expect(script).toContain(`${CROSS_MEDIA_DUMP_CACHE_ENV}=${CHECK_HOST_DUMP_CACHE}`);
  expect(script).toContain('KERNEL_CHECK_ON_REMOTE=1');
});
