/**
 * Seeded walks restore the launcher's pinned Bangumi/VNDB dump cache onto the check host before the run
 * slice. Provider rotation 404s must not substitute a different archive.
 */
import { existsSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';
import {
  BANGUMI_ARCHIVE_URL,
  CROSS_MEDIA_DUMP_CACHE_ENV,
  VNDB_ARCHIVE_URL,
  crossMediaDumpCacheRoot,
} from './datasets/fetch-dumps.ts';

export { CROSS_MEDIA_DUMP_CACHE_ENV, crossMediaDumpCacheRoot };

export const CHECK_HOST_DUMP_CACHE = '/srv/rezics-check/datasets/dumps';
export const CHECK_HOST_DUMP_CACHE_LOCK_DIR = '/srv/rezics-check/datasets';

const DUMP_CACHE_SCRIPTS = new Set(['vndb-seeded-journey.ts', 'cross-media-seed.ts', 'fetch-dumps.ts']);

/** Walk/seed argv that will read the development dump cache on the host. */
export function commandNeedsCrossMediaDumpCache(command: readonly string[]): boolean {
  return command.some((part) => DUMP_CACHE_SCRIPTS.has(basename(part)));
}

function dumpArchiveName(url: string): string {
  const name = new URL(url).pathname.split('/').pop();
  if (!name) throw new TypeError('Dump URL is missing a file name');
  return name;
}

export function pinnedDumpArchivePaths(cacheRoot: string): { bangumi: string; vndb: string } {
  return {
    bangumi: join(cacheRoot, 'downloads', dumpArchiveName(BANGUMI_ARCHIVE_URL)),
    vndb: join(cacheRoot, 'downloads', dumpArchiveName(VNDB_ARCHIVE_URL)),
  };
}

/** Refuse a seed that would download a rotated pin; the launcher cache must already hold the exact bytes. */
export function assertPinnedCrossMediaDumpCache(cacheRoot: string): void {
  const archives = pinnedDumpArchivePaths(cacheRoot);
  for (const [source, path] of Object.entries(archives)) {
    if (!existsSync(path) || !statSync(path).isFile()) {
      throw new Error(
        `Pinned ${source} dump is missing from ${cacheRoot}; restore the exact archive in the dump cache`,
      );
    }
  }
}

export function dumpCacheRsyncArgs(
  source: string,
  hostAddress: string,
  sshCommand: string,
  useZstd: boolean,
  compressLevel = 3,
): string[] {
  const compression = useZstd
    ? ['--compress', '--compress-choice=zstd', `--compress-level=${compressLevel}`]
    : ['--compress'];
  const from = source.endsWith('/') ? source : `${source}/`;
  return [
    'rsync',
    '-a',
    ...compression,
    '--stats',
    '--info=progress2',
    `--rsync-path=mkdir -p ${CHECK_HOST_DUMP_CACHE_LOCK_DIR} && flock -x ${CHECK_HOST_DUMP_CACHE_LOCK_DIR}/.lock rsync`,
    '--mkpath',
    '-e',
    sshCommand,
    from,
    `${hostAddress}:${CHECK_HOST_DUMP_CACHE}/`,
  ];
}
