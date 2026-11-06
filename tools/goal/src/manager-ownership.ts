import type { Database } from 'bun:sqlite';

type SessionFields = {
  kind?: unknown;
  status?: unknown;
  goal?: unknown;
  goals?: unknown;
};

type ListedSession = { id: string; status: string } & SessionFields;

/** Goals a managed session owns. Persisted sessions without `goals` own their original `goal`. */
export function ownedGoals(state: { goal?: unknown; goals?: unknown } | null | undefined): string[] {
  if (Array.isArray(state?.goals))
    return [...new Set(state.goals.filter((goal): goal is string => typeof goal === 'string' && goal.length > 0))];
  return typeof state?.goal === 'string' && state.goal.length > 0 ? [state.goal] : [];
}

function sessionState(row: { id: string; state: string }): ({ id: string } & SessionFields) | null {
  try {
    const state = JSON.parse(row.state) as SessionFields;
    if (!state || typeof state !== 'object' || Array.isArray(state)) return null;
    return { ...state, id: row.id };
  } catch {
    return null;
  }
}

function runningManagedSessions(db: Database): ({ id: string } & SessionFields)[] {
  if (!db.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'manager_sessions'").get()) return [];
  const rows = db.query('SELECT id, state FROM manager_sessions').all() as { id: string; state: string }[];
  return rows
    .map(sessionState)
    .filter((state): state is NonNullable<typeof state> => Boolean(state))
    .filter((state) => state.kind !== 'resident-supermanager' && state.status === 'running');
}

/** The running managed manager that owns `goal`, or `fallback` when none or several claim it. */
export function resolveGoalManager(db: Database, goal: string, fallback: string): string {
  const owners = runningManagedSessions(db)
    .filter((state) => ownedGoals(state).includes(goal))
    .map((state) => state.id);
  return owners.length === 1 ? owners[0]! : fallback;
}

export type ManagerOwnership = {
  id: string;
  status: string;
  kind?: string;
  goals: string[];
};

/** Status listing: each manager and the Goals it owns. */
export function managerOwnership(states: ListedSession[]): ManagerOwnership[] {
  return states
    .map((state) => ({
      id: state.id,
      status: state.status,
      ...(typeof state.kind === 'string' ? { kind: state.kind } : {}),
      goals: state.kind === 'resident-supermanager' ? [] : ownedGoals(state),
    }))
    .sort((left, right) => left.id.localeCompare(right.id));
}

export function readManagerOwnership(db: Database): ManagerOwnership[] {
  if (!db.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'manager_sessions'").get()) return [];
  const rows = db.query('SELECT id, state FROM manager_sessions').all() as { id: string; state: string }[];
  return managerOwnership(
    rows.flatMap((row) => {
      const state = sessionState(row);
      return state && typeof state.status === 'string' ? [{ ...state, status: state.status }] : [];
    }),
  );
}
