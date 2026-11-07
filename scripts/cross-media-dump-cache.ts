/**
 * Seeded walks restore the launcher's pinned Bangumi/VNDB archives onto the check host, then extract
 * under the dump-cache lock before the run slice. Provider rotation 404s must not substitute a different archive.
 */
import { existsSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';
import {
  BANGUMI_ARCHIVE_SHA256,
  BANGUMI_ARCHIVE_URL,
  CROSS_MEDIA_DUMP_CACHE_ENV,
  VNDB_ARCHIVE_SHA256,
  VNDB_ARCHIVE_URL,
  crossMediaDumpCacheRoot,
} from './datasets/fetch-dumps.ts';

export { CROSS_MEDIA_DUMP_CACHE_ENV, crossMediaDumpCacheRoot };

export const CHECK_HOST_DUMP_CACHE = '/srv/rezics-check/datasets/dumps';
export const CHECK_HOST_DUMP_CACHE_LOCK_DIR = '/srv/rezics-check/datasets';
export const DUMP_PIN_MARKER = '.cross-media-dump-sha256';

const DUMP_CACHE_SCRIPTS = new Set([
  'vndb-seeded-journey.ts',
  'seeded-content-goal-walk.ts',
  'seeded-content-ratings-reviews-walk.ts',
  'first-public-scope-walk.ts',
  'semantic-first-public-walk.ts',
  'home-seeded-walk.ts',
  'vn-realm-seeded-walk.ts',
  'managed-accounts-seeded-walk.ts',
  'thread-board-reading.walk.ts',
  'commerce-library-journeys.walk.ts',
  'cross-media-seed.ts',
  'fetch-dumps.ts',
]);

/** Walk/seed argv that will read the development dump cache on the host. */
export function commandNeedsCrossMediaDumpCache(command: readonly string[]): boolean {
  return command.some((part) => DUMP_CACHE_SCRIPTS.has(basename(part)));
}

function dumpArchiveName(url: string): string {
  const name = new URL(url).pathname.split('/').pop();
  if (!name) throw new TypeError('Dump URL is missing a file name');
  return name;
}

function shellQuote(word: string): string {
  return /^[\w@%+=:,./-]+$/.test(word) ? word : `'${word.replaceAll("'", `'\\''`)}'`;
}

export function pinnedDumpArchivePaths(cacheRoot: string): { bangumi: string; vndb: string } {
  return {
    bangumi: join(cacheRoot, 'downloads', dumpArchiveName(BANGUMI_ARCHIVE_URL)),
    vndb: join(cacheRoot, 'downloads', dumpArchiveName(VNDB_ARCHIVE_URL)),
  };
}

export function pinnedDumpExtractTargets(cacheRoot: string): { bangumi: string; vndb: string } {
  const archives = pinnedDumpArchivePaths(cacheRoot);
  return {
    bangumi: join(cacheRoot, 'bangumi', basename(archives.bangumi).replace(/\.zip$/i, '')),
    vndb: join(cacheRoot, 'vndb', basename(archives.vndb).replace(/\.tar\.zst$/i, '')),
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

/** Copy only the pinned archives. Extracted tables stay on the host and are rebuilt before the 6 GiB slice. */
export function dumpCacheRsyncArgs(source: string, hostAddress: string, sshCommand: string): string[] {
  const from = source.endsWith('/') ? source.slice(0, -1) : source;
  return [
    'rsync',
    '-a',
    '--partial',
    '--stats',
    '--info=progress2',
    `--rsync-path=mkdir -p ${CHECK_HOST_DUMP_CACHE}/downloads ${CHECK_HOST_DUMP_CACHE_LOCK_DIR} && flock -x ${CHECK_HOST_DUMP_CACHE_LOCK_DIR}/.lock rsync`,
    '--mkpath',
    '-e',
    sshCommand,
    `${from}/downloads/`,
    `${hostAddress}:${CHECK_HOST_DUMP_CACHE}/downloads/`,
  ];
}

/** Extract pinned archives on the host under the dump-cache lock when the pin marker is missing or stale. */
export function hostDumpExtractScript(cacheRoot = CHECK_HOST_DUMP_CACHE): string {
  const archives = pinnedDumpArchivePaths(cacheRoot);
  const targets = pinnedDumpExtractTargets(cacheRoot);
  const lock = `${CHECK_HOST_DUMP_CACHE_LOCK_DIR}/.lock`;
  return `set -eu
exec 9>${shellQuote(lock)}
flock -x 9
heartbeat() {
  kind=$1
  while :; do
    sleep 15
    printf 'remote-check: dump extract %s running\\n' "$kind"
  done
}
drop_tree_cache() {
  python3 - "$1" <<'PY' || true
import os, sys
root = sys.argv[1]
for dirpath, _, filenames in os.walk(root):
    for name in filenames:
        path = os.path.join(dirpath, name)
        try:
            fd = os.open(path, os.O_RDONLY)
        except OSError:
            continue
        try:
            os.posix_fadvise(fd, 0, 0, os.POSIX_FADV_DONTNEED)
        except (OSError, AttributeError):
            pass
        finally:
            os.close(fd)
PY
}
extract_archive() {
  kind=$1
  archive=$2
  target=$3
  digest=$4
  marker=$target/${DUMP_PIN_MARKER}
  if [ -f "$marker" ]; then
    marked=$(cat "$marker")
    marked=\${marked%%$'\\n'}
    if [ "$marked" = "$digest" ]; then
      printf 'remote-check: dump extract reused %s\\n' "$kind"
      return 0
    fi
  fi
  printf 'remote-check: dump extract %s\\n' "$kind"
  heartbeat "$kind" &
  hb=$!
  stage=$target.partial-$$
  rm -rf "$stage"
  mkdir -p "$stage" "$(dirname "$target")"
  set +e
  case "$kind" in
    bangumi) unzip -qq "$archive" -d "$stage" ;;
    vndb) tar --zstd -xf "$archive" -C "$stage" --checkpoint=1000 --checkpoint-action=echo=dump-extract-%u ;;
    *) kill "$hb" 2>/dev/null; wait "$hb" 2>/dev/null; return 1 ;;
  esac
  status=$?
  set -e
  kill "$hb" 2>/dev/null || true
  wait "$hb" 2>/dev/null || true
  if [ "$status" -ne 0 ]; then
    rm -rf "$stage"
    printf 'remote-check: dump extract %s failed\\n' "$kind"
    return "$status"
  fi
  printf '%s\\n' "$digest" > "$stage/${DUMP_PIN_MARKER}"
  rm -rf "$target"
  mv "$stage" "$target"
  drop_tree_cache "$target"
  printf 'remote-check: dump extract finished %s\\n' "$kind"
}
extract_archive bangumi ${shellQuote(archives.bangumi)} ${shellQuote(targets.bangumi)} ${BANGUMI_ARCHIVE_SHA256}
extract_archive vndb ${shellQuote(archives.vndb)} ${shellQuote(targets.vndb)} ${VNDB_ARCHIVE_SHA256}
`;
}
