/**
 * Host-wide FIFO memory admission for worker checks. Capacity is REZICS_CHECK_MEMORY_GIB, else three quarters
 * of finite rezics-workers.slice MemoryHigh, else 35 percent of total memory. Commands are classified by their
 * worktree-relative command with test files reduced to their workspace; their weight is the rounded-up 90th
 * percentile of the last 20 cgroup peaks, clamped to 1..capacity, and defaults to 4 until three peaks exist.
 * A memory lease holds whole-GiB weighted slots in its own directory. REZICS_CHECK_MEMORY=off disables it and
 * REZICS_CHECK_MEMORY_LEASE marks inherited admission. Peaks are atomically kept for at most 200 classes.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { totalmem } from 'node:os';
import { join, resolve, relative, isAbsolute } from 'node:path';

export function checkMemoryCapacity(
  env: Record<string, string | undefined> = process.env,
  sliceHigh?: string | null,
  totalMemoryBytes = totalmem(),
): number {
  const configured = env.REZICS_CHECK_MEMORY_GIB;
  if (configured !== undefined) {
    if (!/^\d+$/.test(configured) || !Number.isSafeInteger(Number(configured)) || Number(configured) < 1)
      throw new Error(`REZICS_CHECK_MEMORY_GIB must be a positive integer, received ${JSON.stringify(configured)}`);
    return Number(configured);
  }
  let high = sliceHigh;
  if (high === undefined) {
    const result = Bun.spawnSync(
      ['systemctl', '--user', 'show', 'rezics-workers.slice', '-p', 'MemoryHigh', '--value'],
      { stdout: 'pipe', stderr: 'ignore' },
    );
    high = result.exitCode === 0 ? result.stdout.toString().trim() : '';
  }
  if (high && high !== 'infinity' && /^\d+$/.test(high) && Number(high) > 0)
    return Math.max(1, Math.floor((Number(high) * 0.75) / 2 ** 30));
  return Math.max(1, Math.floor((totalMemoryBytes * 0.35) / 2 ** 30));
}

export function checkClass(argv: readonly string[], cwd = process.cwd()): string {
  const root = resolve(cwd);
  const seenWorkspaces = new Set<string>();
  const args = argv
    .map((arg) => {
      const value = arg.startsWith('--cwd=') ? arg.slice(6) : arg;
      if (!value || value.startsWith('-') || (!isAbsolute(value) && !value.includes('/'))) return arg;
      const absolute = resolve(root, value);
      if (!absolute.startsWith(`${root}/`) && absolute !== root) return arg;
      const rel = relative(root, absolute);
      if (/\.(?:test|spec)\.[cm]?[jt]sx?$/.test(rel)) {
        const workspace = rel.split('/')[0] === 'services' ? rel.split('/').slice(0, 2).join('/') : rel.split('/')[0]!;
        if (seenWorkspaces.has(workspace)) return '';
        seenWorkspaces.add(workspace);
        return workspace;
      }
      return arg.startsWith('--cwd=') ? `--cwd=${rel || '.'}` : arg;
    })
    .filter(Boolean);
  return args.join(' ');
}

export function checkMemoryWeight(peaks: number[], capacity: number): number {
  const p90 = checkMemoryP90(peaks);
  if (p90 === undefined) return Math.min(4, capacity);
  if (p90 < 256 * 2 ** 20) return 0;
  return Math.max(1, Math.min(capacity, Math.ceil(p90 / 2 ** 30)));
}

/** 90th percentile over the same three-run warmup and last-20 window used for lease weight. */
export function checkMemoryP90(peaks: number[]): number | undefined {
  if (peaks.length < 3) return undefined;
  const recent = peaks.slice(-20).sort((a, b) => a - b);
  return recent[Math.ceil(recent.length * 0.9) - 1]!;
}

export function readPeaks(directory: string): Record<string, number[]> {
  try {
    const parsed = JSON.parse(readFileSync(join(directory, 'peaks.json'), 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

export function recordPeak(directory: string, commandClass: string, bytes: number): void {
  if (!(bytes > 0) || !Number.isFinite(bytes)) return;
  mkdirSync(directory, { recursive: true });
  const peaks = readPeaks(directory);
  peaks[commandClass] = [...(peaks[commandClass] ?? []), bytes].slice(-20);
  const keys = Object.keys(peaks);
  for (const key of keys.slice(0, Math.max(0, keys.length - 200))) delete peaks[key];
  const temp = join(directory, `peaks.${process.pid}.${crypto.randomUUID()}.tmp`);
  writeFileSync(temp, JSON.stringify(peaks));
  renameSync(temp, join(directory, 'peaks.json'));
}

/** Reads the peak emitted by the scope wrapper, records it, and returns bytes when valid. */
export function recordScopedPeak(directory: string, commandClass: string, peakFile: string): number | undefined {
  try {
    const bytes = Number(readFileSync(peakFile, 'utf8').trim());
    if (!(bytes > 0) || !Number.isFinite(bytes)) return undefined;
    recordPeak(directory, commandClass, bytes);
    return bytes;
  } catch {
    return undefined;
  }
}

export function memoryLeaseDirectory(env: Record<string, string | undefined> = process.env): string {
  return env.REZICS_CHECK_MEMORY_DIR ?? '/tmp/rezics-check-memory';
}
