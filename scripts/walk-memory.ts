/**
 * Walk-slice file-cache release. Sequential dump reads otherwise stay in the 6 GiB cgroup until reclaim.
 */
import { closeSync, lstatSync, openSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { dlopen, FFIType, suffix } from 'bun:ffi';

/** Cap one reclaim so a huge inactive_file write cannot stall the walk. */
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

/** Prefer the run slice so Docker volume pages are included; otherwise this process's cgroup. */
export function walkCgroupPath(procCgroup: string, checkSlice?: string): string | undefined {
  const current = /^0::(.*)$/m.exec(procCgroup)?.[1];
  if (!current) return undefined;
  if (checkSlice) {
    const at = current.indexOf(checkSlice);
    if (at >= 0) return current.slice(0, at + checkSlice.length);
  }
  return current;
}

/** Reclaim only currently inactive file pages. A 4 GiB write against a smaller slice OOMs anonymous memory. */
export function reclaimBytesFromStat(stat: string, limit = WALK_RECLAIM_BYTES): number {
  const match = /^inactive_file (\d+)$/m.exec(stat);
  if (!match) return 0;
  const inactive = Number(match[1]);
  if (!Number.isSafeInteger(inactive) || inactive < 1) return 0;
  return Math.min(inactive, limit);
}

function cgroupRoot(): string | undefined {
  try {
    return walkCgroupPath(readFileSync('/proc/self/cgroup', 'utf8'), process.env.REZICS_CHECK_SLICE);
  } catch {
    return undefined;
  }
}

/** Asks this run's cgroup to drop inactive file pages; missing or unwritable memory.reclaim is ignored. */
export function reclaimInactiveFileCache(bytes?: number): void {
  try {
    const path = cgroupRoot();
    if (!path) return;
    const amount = bytes ?? reclaimBytesFromStat(readFileSync(`/sys/fs/cgroup${path}/memory.stat`, 'utf8'));
    if (amount < 1) return;
    writeFileSync(`/sys/fs/cgroup${path}/memory.reclaim`, `${amount}\n`);
  } catch {
    /* The walk continues when the slice cannot reclaim file cache. */
  }
}

/** Drop-behind one sequential dump table or extracted dump tree so its pages leave the 6 GiB slice. */
export function dropFileCache(path: string): void {
  let fd = -1;
  try {
    const info = lstatSync(path);
    if (info.isDirectory()) {
      for (const entry of readdirSync(path)) dropFileCache(join(path, entry));
      return;
    }
    if (!info.isFile()) return;
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
