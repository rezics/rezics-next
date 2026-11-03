import {
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
  statSync,
} from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';

/** Unlink symlinks without traversing them, including links in read-only fixture trees. */
export function removeTemporaryDirectory(path: string): void {
  const stat = lstatSync(path, { throwIfNoEntry: false });
  if (!stat) return;
  if (stat.isDirectory() && !stat.isSymbolicLink()) {
    chmodSync(path, stat.mode | 0o700);
    for (const name of readdirSync(path)) removeTemporaryDirectory(join(path, name));
  }
  rmSync(path, { force: true, recursive: true });
}

export function temporaryEnvironment(path: string): NodeJS.ProcessEnv {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  return { TMPDIR: path, TMP: path, TEMP: path, NODE_DISABLE_COMPILE_CACHE: '1', NODE_COMPILE_CACHE: '' };
}

export function ownedTemporaryDirectory(parent: string, prefix: string) {
  mkdirSync(parent, { recursive: true, mode: 0o700 });
  const path = mkdtempSync(join(parent, prefix));
  return { path, env: temporaryEnvironment(path), close: () => removeTemporaryDirectory(path) };
}

const HOUR = 60 * 60 * 1000;
export const temporaryEntryRules = [
  { pattern: /^\.[a-f0-9]+-\d+\.hm$/, maxAgeMs: HOUR },
  { pattern: /^node-compile-cache$/, maxAgeMs: 24 * HOUR },
  {
    pattern: /^(?:goal-(?:rollout|gate-env|ws|mcp|db|capacity-critical|claude-usage|idle-probe)-|capacity-queue-|watch-or-poll-|claude-config-|rezics-(?:producer-lifecycle|web-check|web-worker|auth-worker)-)/,
    maxAgeMs: 24 * HOUR,
  },
  {
    pattern: /^(?:\.tmp[A-Za-z0-9]{6,}|(?:\.org\.chromium\.Chromium\.|org\.chromium\.Chromium\.|playwright_chromiumdev_profile-|puppeteer_dev_chrome_profile-)[A-Za-z0-9_-]+)$/,
    maxAgeMs: 24 * HOUR,
  },
] as const;

function gone(error: unknown): boolean {
  return ['ENOENT', 'ESRCH'].includes((error as NodeJS.ErrnoException).code ?? '');
}

type Use = { paths: Set<string>; inodes: Set<string> };
function inode(stat: { dev: number; ino: number }): string {
  return `${stat.dev}:${stat.ino}`;
}

/** Snapshot references once per pass, rather than scan every PID for each of hundreds of thousands of markers. */
function processUse(uid: number): Use {
  const used: Use = { paths: new Set(), inodes: new Set() };
  const reference = (path: string) => {
    for (let current = path; ; current = dirname(current)) {
      used.paths.add(current);
      if (dirname(current) === current) break;
    }
  };
  for (const pid of readdirSync('/proc')) {
    if (!/^\d+$/.test(pid)) continue;
    const directory = join('/proc', pid);
    let own = false;
    try {
      own = statSync(directory).uid === uid;
      const link = (file: string) => {
        try {
          const target = readlinkSync(file).replace(/ \(deleted\)$/, '');
          if (isAbsolute(target)) reference(target);
          used.inodes.add(inode(statSync(file)));
        } catch (error) {
          if (!gone(error) && own) throw error;
        }
      };
      link(join(directory, 'cwd'));
      link(join(directory, 'exe'));
      for (const fd of readdirSync(join(directory, 'fd'))) link(join(directory, 'fd', fd));
      // An mmap survives close(fd); a working directory or an open descriptor alone misses it.
      const maps = readFileSync(join(directory, 'maps'), 'utf8');
      for (const line of maps.split('\n')) {
        const path = /^\S+\s+\S+\s+\S+\s+\S+\s+\S+\s+(\/.*)$/.exec(line)?.[1];
        if (path) {
          const target = path.replace(/\\040/g, ' ').replace(/ \(deleted\)$/, '');
          reference(target);
          try { used.inodes.add(inode(statSync(target))); } catch (error) { if (!gone(error)) throw error; }
        }
      }
      // Reserve the whole scratch directory while its owner lives, even between file opens.
      for (const item of readFileSync(join(directory, 'environ'), 'utf8').split('\0')) {
        const match = /^(?:TMPDIR|TMP|TEMP|NODE_COMPILE_CACHE)=(\/.*)$/.exec(item);
        if (match) reference(match[1]!);
      }
    } catch (error) {
      if (!gone(error) && own) throw new Error(`tmp-janitor: cannot inspect live process ${pid}`, { cause: error });
    }
  }
  return used;
}

/** A descendant may be referenced through a hard link, whose pathname is outside the candidate tree. */
function treeUsed(path: string, used: Use, uid: number, cutoff: number): boolean {
  const stat = lstatSync(path);
  if (stat.uid !== uid || used.inodes.has(inode(stat))) return true;
  if (Math.max(stat.mtimeMs, stat.ctimeMs) > cutoff) return true;
  if (stat.isDirectory() && !stat.isSymbolicLink()) {
    for (const name of readdirSync(path)) if (treeUsed(join(path, name), used, uid, cutoff)) return true;
  }
  return false;
}

export type JanitorResult = { removed: string[]; skipped: string[]; errors: string[] };

/** Only current-UID, recognized, inactive entries qualify. /tmp itself and symlink targets never qualify. */
export function cleanTemporaryEntries(options: { root?: string; now?: number; dryRun?: boolean } = {}): JanitorResult {
  const root = resolve(options.root ?? '/tmp');
  const rootStat = lstatSync(root);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw new Error('tmp-janitor: root must be a real directory');
  const uid = process.getuid!();
  const now = options.now ?? Date.now();
  const used = processUse(uid); // Failure refuses the entire pass before any deletion.
  const result: JanitorResult = { removed: [], skipped: [], errors: [] };
  for (const name of readdirSync(root)) {
    const rule = temporaryEntryRules.find((rule) => rule.pattern.test(name));
    if (!rule) continue;
    const path = join(root, name);
    try {
      const stat = lstatSync(path);
      const cutoff = now - rule.maxAgeMs;
      if (
        stat.uid !== uid || stat.isSymbolicLink() ||
        Math.max(stat.mtimeMs, stat.ctimeMs) > cutoff ||
        used.paths.has(path) ||
        treeUsed(path, used, uid, cutoff)
      ) {
        result.skipped.push(path);
        continue;
      }
      // Revalidate the entry before removal; a replacement is never the inspected tree.
      const current = lstatSync(path);
      if (inode(current) !== inode(stat) || current.ctimeMs !== stat.ctimeMs) {
        result.skipped.push(path);
        continue;
      }
      if (!options.dryRun) removeTemporaryDirectory(path);
      result.removed.push(path);
    } catch (error) {
      if (!gone(error)) result.errors.push(`${path}: ${error instanceof Error ? error.message : error}`);
    }
  }
  return result;
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  if (args.some((arg) => arg !== '--dry-run')) throw new Error('Usage: bun scripts/tmp-janitor.ts [--dry-run]');
  const result = cleanTemporaryEntries({ dryRun: args.includes('--dry-run') });
  console.log(JSON.stringify(result));
  if (result.errors.length) process.exitCode = 1;
}
