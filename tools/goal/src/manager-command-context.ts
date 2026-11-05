import type { Database } from 'bun:sqlite';
import { recordManagerDecision } from './managers.ts';
import { authenticatedManager, type AuthenticatedManager } from './priority-authority.ts';

/** Shared manager identity and turn attribution; does not import the command dispatcher. */

type ManagerCommandStore = { db: Database };

/** Public control-plane command modules use this to attribute a manager's command to its turn. */
export async function recordManagerCommand(runtime: ManagerCommandStore): Promise<void> {
  const manager = callingManager(runtime);
  if (!manager) return;
  const hasSessions = runtime.db
    .query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'manager_sessions'")
    .get();
  if (!hasSessions || !runtime.db.query('SELECT 1 FROM manager_sessions WHERE id = ?').get(manager)) return;
  recordManagerDecision(runtime.db, manager);
}

export function callingManager(runtime: ManagerCommandStore): string | undefined {
  if (process.env.GOAL_MANAGER) return process.env.GOAL_MANAGER;
  if (
    !process.env.CODEX_THREAD_ID ||
    !runtime.db.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'manager_sessions'").get()
  )
    return undefined;
  const rows = runtime.db.query('SELECT state FROM manager_sessions').all() as { state: string }[];
  return rows.map((row) => JSON.parse(row.state)).find((state) => state.threadId === process.env.CODEX_THREAD_ID)?.id;
}

export function isResidentSupermanagerRecord(runtime: ManagerCommandStore, id: string): boolean {
  if (!runtime.db.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'manager_sessions'").get())
    return false;
  const row = runtime.db.query('SELECT state FROM manager_sessions WHERE id = ?').get(id) as { state: string } | null;
  if (!row) return false;
  try {
    return (JSON.parse(row.state) as { kind?: unknown }).kind === 'resident-supermanager';
  } catch {
    return false;
  }
}

/** Priority authorization uses the same persisted manager-session identity, never GOAL_MANAGER by itself. */
export function authenticatedCallingManager(
  runtime: ManagerCommandStore,
  env: NodeJS.ProcessEnv = process.env,
): AuthenticatedManager | undefined {
  return authenticatedManager(runtime.db, env);
}
