import type { Database } from 'bun:sqlite';
import { randomUUID } from 'node:crypto';
import { classifyTask } from './routing.ts';
import type { Brief, PriorityGrant, Task, TaskClass } from './types.ts';

export type AuthenticatedManager = { id: string; sessionId: string };
type ManagerSession = { id?: unknown; status?: unknown; threadId?: unknown; supermanager?: unknown };

function hasManagerSessions(db: Database): boolean {
  return Boolean(db.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'manager_sessions'").get());
}

function managerSession(db: Database, id: string): ManagerSession | undefined {
  if (!hasManagerSessions(db)) return undefined;
  const row = db.query('SELECT state FROM manager_sessions WHERE id = ?').get(id) as { state: string } | null;
  if (!row) return undefined;
  try {
    const state = JSON.parse(row.state) as ManagerSession;
    return state && typeof state === 'object' && !Array.isArray(state) ? state : undefined;
  } catch {
    return undefined;
  }
}

/** Resolve the live manager from its persisted provider session; GOAL_MANAGER alone is only a consistency hint. */
export function authenticatedManager(
  db: Database,
  env: NodeJS.ProcessEnv = process.env,
): AuthenticatedManager | undefined {
  const sessionIds = [env.CODEX_THREAD_ID, env.CLAUDE_CODE_SESSION_ID].filter(
    (value): value is string => typeof value === 'string' && value.length > 0,
  );
  if (!sessionIds.length || !hasManagerSessions(db)) return undefined;
  const matches: AuthenticatedManager[] = [];
  const rows = db.query('SELECT id, state FROM manager_sessions').all() as { id: string; state: string }[];
  for (const row of rows) {
    let state: ManagerSession;
    try {
      state = JSON.parse(row.state) as ManagerSession;
    } catch {
      continue;
    }
    if (!state || typeof state !== 'object' || Array.isArray(state)) continue;
    if (
      state.status !== 'running' ||
      typeof state.threadId !== 'string' ||
      !sessionIds.includes(state.threadId)
    )
      continue;
    matches.push({ id: row.id, sessionId: state.threadId });
  }
  if (matches.length !== 1) return undefined;
  const manager = matches[0]!;
  if (env.GOAL_MANAGER && env.GOAL_MANAGER !== manager.id) return undefined;
  return manager;
}

export function criticalPriority(brief: Pick<Brief, 'criticalPath'>, taskClass?: TaskClass): boolean {
  return brief.criticalPath || taskClass === 'critical-path';
}

export function requireNormalDispatch(brief: Brief, taskClass: TaskClass): void {
  if (criticalPriority(brief, taskClass))
    throw new Error(
      'critical priority cannot be set by dispatch; dispatch the task as normal, then have its supermanager grant and its manager consume priority',
    );
}

function taskManagerParent(db: Database, managerId: string): string | undefined {
  const state = managerSession(db, managerId);
  return typeof state?.supermanager === 'string' && state.supermanager.length ? state.supermanager : undefined;
}

function requireOwner(task: Task, actor: AuthenticatedManager): void {
  if (task.brief.manager !== actor.id)
    throw new Error(`only task manager ${task.brief.manager} may change its priority`);
}

function validGrant(value: unknown): value is PriorityGrant {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const grant = value as Partial<PriorityGrant>;
  return (
    typeof grant.id === 'string' &&
    typeof grant.taskId === 'string' &&
    typeof grant.grantor === 'string' &&
    typeof grant.grantee === 'string' &&
    grant.scope === 'critical-path' &&
    typeof grant.grantedAt === 'string' &&
    Boolean(grant.provenance && grant.provenance.kind === 'manager-session' && grant.provenance.sessionId)
  );
}

function grantForTask(task: Task, actor: AuthenticatedManager): PriorityGrant | undefined {
  return (task.priorityGrants ?? [])
    .filter(
      (candidate): candidate is PriorityGrant =>
        validGrant(candidate) &&
        candidate.taskId === task.id &&
        candidate.grantee === actor.id &&
        candidate.scope === 'critical-path' &&
        !candidate.consumedAt &&
        !candidate.revokedAt,
    )
    .sort((left, right) => left.grantedAt.localeCompare(right.grantedAt) || left.id.localeCompare(right.id))[0];
}

function consumeGrant(db: Database, task: Task, actor: AuthenticatedManager, at: string): PriorityGrant {
  const grant = grantForTask(task, actor);
  const parent = taskManagerParent(db, task.brief.manager);
  if (!grant || !parent || grant.grantor !== parent)
    throw new Error('critical priority requires an active task-bound grant from the task manager\'s configured supermanager');
  grant.consumedAt = at;
  grant.consumedBy = actor.id;
  return grant;
}

/** Append an audit entry only when effective priority changes. Call inside the task's SQLite transaction. */
export function applyPriorityTransition(
  db: Database,
  task: Task,
  previousCritical: boolean,
  nextCritical: boolean,
  actor: AuthenticatedManager | null | undefined,
  at = new Date().toISOString(),
): void {
  if (actor === null) throw new Error('priority changes require an authenticated manager session');
  if (actor) requireOwner(task, actor);
  task.brief.criticalPath = nextCritical;
  task.taskClass = classifyTask(task.brief);
  if (previousCritical === nextCritical) return;
  const grant = nextCritical && actor ? consumeGrant(db, task, actor, at) : undefined;
  task.priorityHistory ??= [];
  task.priorityHistory.push({
    value: nextCritical ? 'critical' : 'normal',
    setter: actor?.id ?? null,
    grantor: grant?.grantor ?? null,
    at,
    ...(grant ? { grantId: grant.id } : {}),
    provenance: actor
      ? { kind: 'manager-session', sessionId: actor.sessionId }
      : { kind: 'programmatic' },
  });
}

export function grantCriticalPriority(
  db: Database,
  task: Task,
  actor: AuthenticatedManager,
  at = new Date().toISOString(),
): PriorityGrant {
  const parent = taskManagerParent(db, task.brief.manager);
  if (!parent || parent !== actor.id)
    throw new Error(`only configured supermanager ${parent ?? '(unknown)'} may grant critical priority to this task`);
  const grant: PriorityGrant = {
    id: randomUUID(),
    taskId: task.id,
    grantor: actor.id,
    grantee: task.brief.manager,
    scope: 'critical-path',
    grantedAt: at,
    provenance: { kind: 'manager-session', sessionId: actor.sessionId },
  };
  task.priorityGrants ??= [];
  task.priorityGrants.push(grant);
  return grant;
}

export function revokeCriticalPriority(
  task: Task,
  grantId: string,
  actor: AuthenticatedManager,
  at = new Date().toISOString(),
): PriorityGrant {
  const grant = (task.priorityGrants ?? []).find((candidate) => validGrant(candidate) && candidate.id === grantId);
  if (!grant || grant.taskId !== task.id || grant.scope !== 'critical-path')
    throw new Error('unknown task-bound critical priority grant');
  if (grant.grantor !== actor.id) throw new Error('only the grantor may revoke this critical priority grant');
  if (grant.consumedAt) throw new Error('a consumed critical priority grant cannot be revoked');
  if (grant.revokedAt) throw new Error('critical priority grant is already revoked');
  grant.revokedAt = at;
  grant.revokedBy = actor.id;
  return grant;
}
