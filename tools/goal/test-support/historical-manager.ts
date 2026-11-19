import type { Database } from 'bun:sqlite';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import type { ManagedManagerState } from '../src/managers.ts';

/** A persisted pre-retirement session, for commands that still operate on existing records. */
export function historicalManager(
  db: Database,
  cwd: string,
  overrides: Partial<ManagedManagerState> = {},
): ManagedManagerState {
  const state: ManagedManagerState = {
    id: 'accounts',
    goal: 'accounts',
    objective: 'Maintain accounts',
    brief: 'Maintain accounts',
    cwd,
    engine: 'claude',
    pool: { id: 'fake', codexHome: join(cwd, 'codex') },
    budget: 1000,
    effort: 'low',
    supermanager: 'supermanager',
    limits: { turns: 100, turnsWithoutDecision: 100, wallMs: 3_600_000 },
    status: 'paused',
    threadId: randomUUID(),
    activeTurnId: null,
    startedAt: Date.now(),
    turns: 1,
    turnsWithoutDecision: 0,
    decision: false,
    countedTurn: null,
    goalState: null,
    usage: null,
    ...overrides,
  };
  db.query('INSERT INTO manager_sessions(id, state) VALUES (?, ?)').run(state.id, JSON.stringify(state));
  return state;
}
