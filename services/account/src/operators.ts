import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { accountSession, AccountProblem, type AccountAuth } from './http.ts';
import { requireStepUp } from './methods.ts';

export type OperatorRole = 'owner' | 'admin' | 'support';
export const operatorPermissions = {
  owner: ['users:read', 'users:suspend', 'sessions:revoke', 'password:require-reset',
    'verification:send', 'notes:write', 'clients:manage', 'audit:read', 'operators:manage'],
  admin: ['users:read', 'users:suspend', 'sessions:revoke', 'password:require-reset',
    'verification:send', 'notes:write', 'clients:manage', 'audit:read'],
  support: ['users:read', 'sessions:revoke', 'verification:send', 'notes:write'],
} as const satisfies Record<OperatorRole, readonly string[]>;
export type OperatorPermission = typeof operatorPermissions.owner[number];
export function rolePermits(role: OperatorRole, permission: OperatorPermission) {
  return (operatorPermissions[role] as readonly string[]).includes(permission);
}

/** Env IDs are a one-time bootstrap source, never an ongoing authority list.
 * A durable marker prevents a removed bootstrap role being silently restored. */
export async function bootstrapOperators(pool: Pool, ids: ReadonlySet<string>) {
  if (!ids.size) return;
  const db = await pool.connect();
  try {
    await db.query('BEGIN');
    await db.query("SELECT pg_advisory_xact_lock(hashtextextended('account-operator-roles', 0))");
    if ((await db.query('SELECT 1 FROM rezics_account_operator_bootstrap')).rowCount) { await db.query('COMMIT'); return; }
    const first = await db.query<{ id: string }>('SELECT id FROM "user" WHERE id = ANY($1::text[]) ORDER BY id LIMIT 1', [[...ids]]);
    if (!first.rows[0]) { await db.query('COMMIT'); return; }
    await db.query(`INSERT INTO rezics_account_operator (user_id, role) VALUES ($1, 'owner') ON CONFLICT DO NOTHING`, [first.rows[0].id]);
    await db.query('INSERT INTO rezics_account_operator_bootstrap DEFAULT VALUES');
    await writeAudit(db, { actorId: first.rows[0].id, action: 'operator_bootstrapped', targetId: first.rows[0].id,
      reason: 'Initial operator configured by deployment', before: null, after: { role: 'owner' }, requestId: randomUUID() });
    await db.query('COMMIT');
  } catch (error) { await db.query('ROLLBACK'); throw error; }
  finally { db.release(); }
}

export async function operatorRole(db: Pool | PoolClient, userId: string): Promise<OperatorRole | null> {
  const result = await db.query<{ role: OperatorRole }>(`SELECT o.role FROM rezics_account_operator o
    JOIN rezics_account_security s ON s.user_id = o.user_id
    WHERE o.user_id = $1 AND s.deletion_started_at IS NULL AND NOT s.password_reset_required
      AND (s.suspended_at IS NULL OR s.suspended_until <= now())`, [userId]);
  return result.rows[0]?.role ?? null;
}

export async function requireOperator(auth: AccountAuth, pool: Pool, request: Request,
  permission: OperatorPermission, write = request.method !== 'GET') {
  const session = await accountSession(auth, request, write);
  const role = await operatorRole(pool, session.user.id);
  if (!role || !rolePermits(role, permission)) {
    if (role && write) await writeAudit(pool, { actorId: session.user.id, action: 'permission_denied',
      targetId: new URL(request.url).pathname, reason: `Required permission: ${permission}`,
      before: null, after: null, requestId: randomUUID(), outcome: 'failed' });
    throw new AccountProblem('forbidden', 403);
  }
  if (write) await requireStepUp(pool, session);
  return { userId: session.user.id, sessionId: session.session.id, role };
}

export async function writeAudit(db: Pool | PoolClient, input: { actorId: string; action: string;
  targetId: string; reason: string; before: unknown; after: unknown; requestId: string;
  outcome?: 'attempted' | 'succeeded' | 'failed' }) {
  await db.query(`INSERT INTO rezics_account_operator_audit
    (actor_id, action, target_id, reason, before_summary, after_summary, request_id, outcome)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`, [input.actorId, input.action, input.targetId,
    input.reason, JSON.stringify(input.before), JSON.stringify(input.after), input.requestId, input.outcome ?? 'succeeded']);
}
