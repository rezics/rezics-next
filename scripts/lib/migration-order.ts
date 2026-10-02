import { basename, dirname } from 'node:path';

/** Keep owner directories and equal-version names deterministic, but order versions numerically. */
export function compareMigrationPaths(left: string, right: string): number {
  const leftDirectory = dirname(left),
    rightDirectory = dirname(right);
  if (leftDirectory !== rightDirectory) return lexical(left, right);
  const leftNumber = /^(\d+)_/.exec(basename(left))?.[1];
  const rightNumber = /^(\d+)_/.exec(basename(right))?.[1];
  if (leftNumber !== undefined && rightNumber !== undefined) {
    const difference = Number(leftNumber) - Number(rightNumber);
    if (difference) return difference;
  }
  return lexical(left, right);
}

const lexical = (left: string, right: string) => (left < right ? -1 : left > right ? 1 : 0);

/** SQL owners share the same filename contract; existing three-digit names stay valid. */
export function migrationVersion(path: string): number {
  const match = /^(\d{3,})_[a-z0-9_]+\.sql$/.exec(basename(path));
  const version = match ? Number(match[1]) : NaN;
  if (!Number.isSafeInteger(version) || version < 1) throw new Error(`Invalid migration: ${path}`);
  return version;
}
