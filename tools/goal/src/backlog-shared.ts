import type { Database } from 'bun:sqlite';
import { readdirSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';

export const BACKLOG_DISPATCHING_DIRECTORY = '.dispatching';
export const BACKLOG_DISPATCHED_DIRECTORY = 'dispatched';
export const BACKLOG_FAILED_DIRECTORY = 'failed';
export const BACKLOG_RETURNED_DIRECTORY = 'returned';

export type BacklogDispatchResult = string | { taskId: string; lintWarnings?: string[] };

export function backlogDirectory(stateDirectory: string, goal?: string): string {
  return goal === undefined ? join(stateDirectory, 'backlog') : join(stateDirectory, 'backlog', goal);
}

export function tableExists(db: Database, name: string): boolean {
  return Boolean(db.query("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name));
}

export function taskLintWarnings(db: Database, taskId: string): string[] {
  if (!tableExists(db, 'worker_tasks')) return [];
  const row = db.query('SELECT body FROM worker_tasks WHERE id=?').get(taskId) as { body: string } | null;
  if (!row) return [];
  try {
    const brief = (JSON.parse(row.body) as { brief?: { lintWarnings?: unknown } }).brief;
    return Array.isArray(brief?.lintWarnings)
      ? brief.lintWarnings.filter((warning): warning is string => typeof warning === 'string')
      : [];
  } catch {
    return [];
  }
}

export function dispatchResult(result: BacklogDispatchResult): { taskId: string; lintWarnings: string[] } {
  return typeof result === 'string'
    ? { taskId: result, lintWarnings: [] }
    : { taskId: result.taskId, lintWarnings: result.lintWarnings ?? [] };
}

export function briefs(path: string, settledBefore = Number.POSITIVE_INFINITY): string[] {
  let entries;
  try {
    entries = readdirSync(path, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  const files: { path: string; name: string; modified: number }[] = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.md') || entry.name.startsWith('.')) continue;
    const file = join(path, entry.name);
    try {
      const modified = statSync(file).mtimeMs;
      if (modified < settledBefore) files.push({ path: file, name: entry.name, modified });
    } catch {
      // A manager may move a brief away between listing and stat.
    }
  }
  return files.sort((a, b) => a.modified - b.modified || a.name.localeCompare(b.name)).map((file) => file.path);
}

export function errorText(error: unknown): string {
  return error instanceof Error ? error.name + ': ' + error.message : String(error);
}

export function stem(file: string): string {
  return basename(file, '.md');
}
