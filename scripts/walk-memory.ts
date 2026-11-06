/**
 * Walk-slice file-cache release. Sequential dump reads otherwise stay in the 6 GiB cgroup until reclaim.
 */
import { closeSync, openSync, readFileSync, writeFileSync } from 'node:fs';
import { dlopen, FFIType, suffix } from 'bun:ffi';

/** Four GiB is enough to drop bun-install and dump-archive pages without waiting on admission reclaim. */
export const WALK_RECLAIM_BYTES = 4 * 1024 * 1024 * 1024;
const POSIX_FADV_DONTNEED = 4;

type Advise = (fd: number, offset: bigint, length: bigint, advice: number) => number;

let advise: Advise | undefined;

function libcAdvise(): Advise | undefined {
  if (advise) return advise;
  const names = [`/lib64/libc.so.6`, `/usr/lib64/libc.so.6`, `libc.${suffix}.6`, `libc.${suffix}`];
  for (const name of names) {
    try {
      const lib = dlopen(name, {
        posix_fadvise: {
          args: [FFIType.i32, FFIType.i64, FFIType.i64, FFIType.i32],
          returns: FFIType.i32,
        },
      });
      advise = (fd, offset, length, advice) => lib.symbols.posix_fadvise(fd, offset, length, advice);
      return advise;
    } catch {
      /* Try the next libc soname. */
    }
  }
  return undefined;
}

/** Asks this run's cgroup to drop inactive file pages; missing or unwritable memory.reclaim is ignored. */
export function reclaimInactiveFileCache(bytes = WALK_RECLAIM_BYTES): void {
  try {
    const path = /^0::(.*)$/m.exec(readFileSync('/proc/self/cgroup', 'utf8'))?.[1];
    if (!path) return;
    writeFileSync(`/sys/fs/cgroup${path}/memory.reclaim`, `${bytes}\n`);
  } catch {
    /* The walk continues when the slice cannot reclaim file cache. */
  }
}

/** Drop-behind one sequential dump table so its pages leave the 6 GiB slice. */
export function dropFileCache(path: string): void {
  let fd = -1;
  try {
    fd = openSync(path, 'r');
    libcAdvise()?.(fd, 0n, 0n, POSIX_FADV_DONTNEED);
  } catch {
    /* Missing files and hosts without posix_fadvise still reclaim below. */
  } finally {
    if (fd >= 0) closeSync(fd);
  }
}

/** Release one dump file's pages, then ask the slice to drop inactive file cache. */
export function releaseWalkFileCache(path?: string): void {
  if (path) dropFileCache(path);
  reclaimInactiveFileCache();
}
