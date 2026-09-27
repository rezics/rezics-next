import { createHash, randomUUID } from 'node:crypto';
import { createEmailVerificationToken } from 'better-auth/api';
import { Elysia, t } from 'elysia';
import type { Pool, PoolClient } from 'pg';
import { accountFailure, accountJson, AccountProblem, accountSession, type AccountAuth } from './http.ts';
import { decodeCursor, encodeCursor, pageQuery } from './pagination.ts';
import { operatorPermissions, operatorRole, requireOperator, rolePermits, writeAudit,
  type OperatorPermission, type OperatorRole } from './operators.ts';
import { readMethods } from './methods.ts';
import { readSecurityActivity, readSessions } from './security-activity.ts';
import { readConnectedApps } from './connected-apps.ts';
import { accountLocale, enqueueAccountEmail } from './email.ts';

export const adminActions = ['suspend', 'unsuspend', 'revoke-sessions', 'require-password-reset',
  'resend-verification', 'add-note'] as const;
export type AdminAction = typeof adminActions[number];
const permissions: Record<AdminAction, OperatorPermission> = {
  suspend: 'users:suspend', unsuspend: 'users:suspend', 'revoke-sessions': 'sessions:revoke',
  'require-password-reset': 'password:require-reset', 'resend-verification': 'verification:send', 'add-note': 'notes:write',
};
type DirectoryQuery = { q?: string; status?: 'active' | 'suspended' | 'password-reset-required';
  verified?: boolean; hasTwoFactor?: boolean; createdFrom?: string; createdTo?: string;
  sort?: 'createdAt' | 'email' | 'name'; direction?: 'asc' | 'desc'; limit?: number; cursor?: string };
const profileFields = `u.id, u.name, u.email, u.image, u."emailVerified", coalesce(u."twoFactorEnabled", false) AS "twoFactorEnabled",
  u."createdAt", u."updatedAt", s.password_reset_required AS "passwordResetRequired",
  s.suspended_until AS "suspendedUntil", s.suspension_reason AS "suspensionReason",
  CASE WHEN s.suspended_at IS NOT NULL AND (s.suspended_until IS NULL OR s.suspended_until > now())
    THEN 'suspended' WHEN s.password_reset_required THEN 'password-reset-required' ELSE 'active' END AS status`;
export interface AccountProfile {
  id: string; name: string; email: string; image: string | null; emailVerified: boolean; twoFactorEnabled: boolean;
  createdAt: Date; updatedAt: Date; passwordResetRequired: boolean; suspendedUntil: Date | null;
  suspensionReason: string | null; status: 'active' | 'suspended' | 'password-reset-required';
}
const profileView = (row: AccountProfile) => ({ ...row, createdAt: row.createdAt.toISOString(),
  updatedAt: row.updatedAt.toISOString(), suspendedUntil: row.suspendedUntil?.toISOString() ?? null });

async function profile(db: Pool | PoolClient, userId: string) {
  const result = await db.query<AccountProfile>(`SELECT ${profileFields} FROM "user" u
    JOIN rezics_account_security s ON s.user_id = u.id WHERE u.id = $1`, [userId]);
  if (!result.rows[0]) throw new AccountProblem('not_found', 404);
  return profileView(result.rows[0]);
}

/** Prefix search uses name/email pattern indexes and ID prefix. No unbounded
 * count; seek ordering is stable by ID. Filter combinations may sort matches;
 * a two-second statement budget bounds operator queries on large directories. */
export async function readDirectory(pool: Pool, secret: string, actorId: string, query: DirectoryQuery) {
  if (query.createdFrom && query.createdTo && query.createdFrom > query.createdTo) throw new AccountProblem('invalid_request', 400);
  const sort = query.sort ?? 'createdAt';
  const direction = query.direction ?? 'desc';
  const search = (query.q ?? '').trim().toLowerCase();
  const scope = `directory:${actorId}:${JSON.stringify([search, query.status, query.verified, query.hasTwoFactor,
    query.createdFrom, query.createdTo, sort, direction])}`;
  const cursor = decodeCursor(secret, scope, query.cursor);
  const column = { createdAt: 'u."createdAt"', email: 'lower(u.email)', name: 'lower(u.name)' }[sort];
  const op = direction === 'asc' ? '>' : '<';
  const limit = query.limit ?? 25;
  const db = await pool.connect();
  try {
    await db.query('BEGIN');
    await db.query("SET LOCAL statement_timeout = '2s'");
    const result = await db.query<AccountProfile & { sortKey: string }>(`SELECT ${profileFields}, ${column}::text AS "sortKey"
      FROM "user" u JOIN rezics_account_security s ON s.user_id = u.id
      WHERE ($1::text = '' OR lower(u.email) LIKE $1 || '%' ESCAPE '\\'
        OR lower(u.name) LIKE $1 || '%' ESCAPE '\\' OR u.id LIKE $1 || '%' ESCAPE '\\')
        AND ($2::text IS NULL OR ($2 = 'suspended' AND s.suspended_at IS NOT NULL AND (s.suspended_until IS NULL OR s.suspended_until > now()))
          OR ($2 = 'password-reset-required' AND s.password_reset_required)
          OR ($2 = 'active' AND NOT s.password_reset_required AND (s.suspended_at IS NULL OR s.suspended_until <= now())))
        AND ($3::boolean IS NULL OR u."emailVerified" = $3)
        AND ($4::boolean IS NULL OR coalesce(u."twoFactorEnabled", false) = $4)
        AND ($5::timestamptz IS NULL OR u."createdAt" >= $5)
        AND ($6::timestamptz IS NULL OR u."createdAt" < $6)
        AND ($7::${sort === 'createdAt' ? 'timestamptz' : 'text'} IS NULL OR (${column}, u.id) ${op} ($7, $8))
      ORDER BY ${column} ${direction}, u.id ${direction} LIMIT $9`,
    [search.replace(/[\\%_]/g, '\\$&'), query.status ?? null, query.verified ?? null, query.hasTwoFactor ?? null,
      query.createdFrom ?? null, query.createdTo ?? null, cursor?.key ?? null, cursor?.id ?? null, limit + 1]);
    const rows = result.rows.slice(0, limit);
    const last = rows.at(-1);
    return { items: rows.map(({ sortKey: _key, ...row }) => profileView(row)),
      nextCursor: result.rows.length > limit && last ? encodeCursor(secret, scope, last.sortKey, last.id) : null };
  } finally { try { await db.query('ROLLBACK'); } finally { db.release(); } }
}

async function checkActor(db: PoolClient, actor: { userId: string; sessionId: string }, permission: OperatorPermission) {
  const current = await db.query<{ role: OperatorRole }>(`SELECT o.role FROM rezics_account_operator o
    JOIN "session" s ON s."userId" = o.user_id AND s.id = $2 AND s."expiresAt" > now()
    WHERE o.user_id = $1 FOR SHARE OF o, s`, [actor.userId, actor.sessionId]);
  if (!current.rows[0] || !rolePermits(current.rows[0].role, permission)) throw new AccountProblem('forbidden', 403);
  return current.rows[0].role;
}

export async function administerUser(auth: AccountAuth, pool: Pool, request: Request, userId: string,
  body: { action: AdminAction; reason: string; commandId: string; expiresAt?: string; note?: string }) {
  if (!body.reason.trim() || (body.action === 'add-note' && !body.note?.trim())) throw new AccountProblem('invalid_request', 400);
  if (body.expiresAt && (body.action !== 'suspend' || new Date(body.expiresAt).getTime() <= Date.now())) throw new AccountProblem('invalid_request', 400);
  const actor = await requireOperator(auth, pool, request, permissions[body.action]);
  const digest = createHash('sha256').update(JSON.stringify([userId, body.action, body.reason, body.expiresAt, body.note])).digest('hex');
  const db = await pool.connect();
  try {
    await db.query('BEGIN');
    await db.query("SET LOCAL lock_timeout = '3s'");
    // Owner availability and role changes share a lock. Two owners cannot
    // concurrently suspend/reset each other and strand the installation.
    await db.query("SELECT pg_advisory_xact_lock(hashtextextended('account-operator-roles', 0))");
    await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`admin:${actor.userId}:${body.commandId}`]);
    const role = await checkActor(db, actor, permissions[body.action]);
    const existing = await db.query<{ digest: string; response: { status: boolean; requestId: string } }>(
      'SELECT digest, response FROM rezics_account_operator_command WHERE actor_id = $1 AND command_id = $2', [actor.userId, body.commandId]);
    if (existing.rows[0]) {
      if (existing.rows[0].digest !== digest) throw new AccountProblem('conflict', 409);
      await db.query('COMMIT'); return existing.rows[0].response;
    }
    const targetRole = await db.query<{ role: OperatorRole }>('SELECT role FROM rezics_account_operator WHERE user_id = $1 FOR SHARE', [userId]);
    if (targetRole.rows[0] && role !== 'owner') throw new AccountProblem('forbidden', 403);
    if (targetRole.rows[0]?.role === 'owner' && ['suspend', 'require-password-reset'].includes(body.action)) {
      const otherOwner = await db.query(`SELECT 1 FROM rezics_account_operator o JOIN rezics_account_security s ON s.user_id = o.user_id
        WHERE o.role = 'owner' AND o.user_id <> $1 AND NOT s.password_reset_required
          AND (s.suspended_at IS NULL OR s.suspended_until <= now()) LIMIT 1`, [userId]);
      if (!otherOwner.rowCount) throw new AccountProblem('conflict', 409);
    }
    await db.query('SELECT 1 FROM rezics_account_security WHERE user_id = $1 FOR UPDATE', [userId]);
    const before = await profile(db, userId);
    if (body.action === 'suspend') {
      await db.query(`UPDATE rezics_account_security SET generation = generation + 1,
        suspended_at = now(), suspended_until = $2, suspension_reason = $3 WHERE user_id = $1`, [userId, body.expiresAt ?? null, body.reason]);
    } else if (body.action === 'unsuspend') {
      await db.query(`UPDATE rezics_account_security SET suspended_at = NULL, suspended_until = NULL,
        suspension_reason = NULL WHERE user_id = $1`, [userId]);
    } else if (body.action === 'require-password-reset') {
      await db.query(`UPDATE rezics_account_security SET generation = generation + 1, password_reset_required = true WHERE user_id = $1`, [userId]);
    } else if (body.action === 'add-note') {
      await db.query('INSERT INTO rezics_account_operator_note (user_id, author_id, body) VALUES ($1, $2, $3)', [userId, actor.userId, body.note!.trim()]);
    } else if (body.action === 'resend-verification' && !before.emailVerified) {
      const token = await createEmailVerificationToken(String(auth.options.secret), before.email, undefined, 1800);
      const url = new URL('/api/auth/verify-email', String(auth.options.baseURL));
      url.searchParams.set('token', token); url.searchParams.set('callbackURL', '/');
      await enqueueAccountEmail(db, String(auth.options.secret), { userId, to: before.email,
        purpose: 'verify', locale: accountLocale(request), url: url.toString() });
    }
    if (['suspend', 'require-password-reset', 'revoke-sessions'].includes(body.action)) {
      if (body.action === 'revoke-sessions') await db.query('UPDATE rezics_account_security SET generation = generation + 1 WHERE user_id = $1', [userId]);
      await db.query('DELETE FROM "session" WHERE "userId" = $1', [userId]);
      await db.query('UPDATE "oauthRefreshToken" SET revoked = now() WHERE "userId" = $1 AND revoked IS NULL', [userId]);
      await db.query('DELETE FROM verification WHERE value = $1', [userId]);
    }
    const after = await profile(db, userId);
    const requestId = randomUUID();
    await writeAudit(db, { actorId: actor.userId, action: body.action, targetId: userId,
      reason: body.reason, before, after, requestId });
    await db.query(`INSERT INTO rezics_account_security_event (user_id, action, detail)
      VALUES ($1, 'admin_action', $2)`, [userId, JSON.stringify({ action: body.action, requestId })]);
    const response = { status: true, requestId };
    await db.query(`INSERT INTO rezics_account_operator_command (actor_id, command_id, digest, response)
      VALUES ($1, $2, $3, $4)`, [actor.userId, body.commandId, digest, JSON.stringify(response)]);
    await db.query('COMMIT'); return response;
  } catch (error) { await db.query('ROLLBACK'); throw error; }
  finally { db.release(); }
}

export function adminApi(auth: AccountAuth, pool: Pool) {
  const secret = String(auth.options.secret);
  const userParams = t.Object({ userId: t.String({ minLength: 1, maxLength: 128 }) });
  return new Elysia()
    .get('/api/account/admin/me', async ({ request }) => {
      try {
        const session = await accountSession(auth, request);
        const role = await operatorRole(pool, session.user.id);
        return accountJson({ role, permissions: role ? operatorPermissions[role] : [] });
      } catch (error) { return accountFailure(error); }
    })
    .get('/api/account/admin/clients', { query: t.Object(pageQuery) }, async ({ request, query }) => {
      try {
        const actor = await requireOperator(auth, pool, request, 'clients:manage');
        const scope = `clients:${actor.userId}`;
        const cursor = decodeCursor(secret, scope, query.cursor);
        const limit = query.limit ?? 25;
        const result = await pool.query<{ clientId: string; name: string; disabled: boolean | null;
          scopes: string[]; grantTypes: string[]; redirectUris: string[]; userId: string | null; skipConsent: boolean | null }>(`
          SELECT "clientId", name, disabled, scopes, "grantTypes", "redirectUris", "userId", "skipConsent"
          FROM "oauthClient" WHERE ($1::text IS NULL OR "clientId" > $1) ORDER BY "clientId" LIMIT $2`, [cursor?.id ?? null, limit + 1]);
        const rows = result.rows.slice(0, limit); const last = rows.at(-1);
        return accountJson({ items: rows, nextCursor: result.rows.length > limit && last
          ? encodeCursor(secret, scope, last.clientId, last.clientId) : null });
      } catch (error) { return accountFailure(error); }
    })
    .get('/api/account/admin/users', { query: t.Object({ ...pageQuery,
      q: t.Optional(t.String({ maxLength: 200 })),
      status: t.Optional(t.Union([t.Literal('active'), t.Literal('suspended'), t.Literal('password-reset-required')])),
      verified: t.Optional(t.Boolean()), hasTwoFactor: t.Optional(t.Boolean()),
      createdFrom: t.Optional(t.String({ format: 'date-time' })), createdTo: t.Optional(t.String({ format: 'date-time' })),
      sort: t.Optional(t.Union([t.Literal('createdAt'), t.Literal('email'), t.Literal('name')])),
      direction: t.Optional(t.Union([t.Literal('asc'), t.Literal('desc')])),
    }) }, async ({ request, query }) => {
      try { return accountJson(await readDirectory(pool, secret, (await requireOperator(auth, pool, request, 'users:read')).userId, query)); }
      catch (error) { return accountFailure(error); }
    })
    .get('/api/account/admin/users/:userId', { params: userParams }, async ({ request, params }) => {
      try {
        await requireOperator(auth, pool, request, 'users:read');
        const user = await profile(pool, params.userId);
        const [methods, sessions, apps, activity, notes] = await Promise.all([
          readMethods(pool, params.userId), readSessions(pool, secret, params.userId, '', { limit: 10 }),
          readConnectedApps(pool, secret, params.userId, { limit: 10 }), readSecurityActivity(pool, secret, params.userId, { limit: 10 }),
          pool.query<{ id: string; authorId: string; body: string; createdAt: Date }>(`SELECT id, author_id AS "authorId", body, created_at AS "createdAt"
            FROM rezics_account_operator_note WHERE user_id = $1 ORDER BY created_at DESC, id DESC LIMIT 25`, [params.userId]),
        ]);
        return accountJson({ profile: user, methods, sessions, apps, activity,
          notes: notes.rows.map(row => ({ ...row, createdAt: row.createdAt.toISOString() })) });
      } catch (error) { return accountFailure(error); }
    })
    .get('/api/account/admin/users/:userId/sessions', { params: userParams, query: t.Object(pageQuery) }, async ({ request, params, query }) => {
      try {
        await requireOperator(auth, pool, request, 'users:read');
        return accountJson(await readSessions(pool, secret, params.userId, '', query));
      } catch (error) { return accountFailure(error); }
    })
    .get('/api/account/admin/users/:userId/apps', { params: userParams, query: t.Object(pageQuery) }, async ({ request, params, query }) => {
      try {
        await requireOperator(auth, pool, request, 'users:read');
        return accountJson(await readConnectedApps(pool, secret, params.userId, query));
      } catch (error) { return accountFailure(error); }
    })
    .get('/api/account/admin/users/:userId/security-activity', { params: userParams, query: t.Object(pageQuery) }, async ({ request, params, query }) => {
      try {
        await requireOperator(auth, pool, request, 'users:read');
        return accountJson(await readSecurityActivity(pool, secret, params.userId, query));
      } catch (error) { return accountFailure(error); }
    })
    .post('/api/account/admin/users/:userId/actions', { params: userParams,
      body: t.Object({ action: t.Union(adminActions.map(action => t.Literal(action))),
        reason: t.String({ minLength: 3, maxLength: 1000 }), commandId: t.String({ format: 'uuid' }),
        expiresAt: t.Optional(t.String({ format: 'date-time' })), note: t.Optional(t.String({ minLength: 1, maxLength: 4000 })),
      }, { additionalProperties: false }) }, async ({ request, params, body }) => {
      try { return accountJson(await administerUser(auth, pool, request, params.userId, body)); }
      catch (error) { return accountFailure(error); }
    })
    .post('/api/account/admin/operators/:userId', { params: userParams,
      body: t.Object({ role: t.Union([t.Literal('owner'), t.Literal('admin'), t.Literal('support'), t.Null()]),
        reason: t.String({ minLength: 3, maxLength: 1000 }) }) }, async ({ request, params, body }) => {
      let db: PoolClient | undefined;
      try {
        const actor = await requireOperator(auth, pool, request, 'operators:manage');
        if (!body.reason.trim()) throw new AccountProblem('invalid_request', 400);
        db = await pool.connect();
        await db.query('BEGIN');
        await db.query("SELECT pg_advisory_xact_lock(hashtextextended('account-operator-roles', 0))");
        await checkActor(db, actor, 'operators:manage');
        await profile(db, params.userId);
        const before = await operatorRole(db, params.userId);
        if (body.role) await db.query(`INSERT INTO rezics_account_operator (user_id, role) VALUES ($1, $2)
          ON CONFLICT (user_id) DO UPDATE SET role = $2, assigned_at = now()`, [params.userId, body.role]);
        else await db.query('DELETE FROM rezics_account_operator WHERE user_id = $1', [params.userId]);
        const requestId = randomUUID();
        await writeAudit(db, { actorId: actor.userId, action: 'operator_role_changed', targetId: params.userId,
          reason: body.reason, before: { role: before }, after: { role: body.role }, requestId });
        await db.query(`INSERT INTO rezics_account_security_event (user_id, action, detail)
          VALUES ($1, 'admin_action', $2)`, [params.userId, JSON.stringify({ action: 'operator_role_changed', requestId })]);
        await db.query('COMMIT'); return accountJson({ status: true, requestId });
      } catch (error) {
        await db?.query('ROLLBACK');
        return accountFailure(error instanceof Error && error.message === 'last_owner' ? new AccountProblem('conflict', 409) : error);
      } finally { db?.release(); }
    })
    .get('/api/account/admin/audit', { query: t.Object({ ...pageQuery,
      actorId: t.Optional(t.String({ maxLength: 128 })), targetId: t.Optional(t.String({ maxLength: 256 })),
      action: t.Optional(t.String({ maxLength: 128 })), from: t.Optional(t.String({ format: 'date-time' })),
      to: t.Optional(t.String({ format: 'date-time' })),
    }) }, async ({ request, query }) => {
      try {
        const actor = await requireOperator(auth, pool, request, 'audit:read');
        const scope = `audit:${actor.userId}:${JSON.stringify([query.actorId, query.targetId, query.action, query.from, query.to])}`;
        const cursor = decodeCursor(secret, scope, query.cursor);
        const limit = query.limit ?? 25;
        const result = await pool.query<{ id: string; actorId: string; targetId: string; action: string; reason: string;
          before: unknown; after: unknown; requestId: string; outcome: string; occurredAt: Date; cursorKey: string }>(`SELECT id,
          actor_id AS "actorId", target_id AS "targetId", action, reason, before_summary AS before,
          after_summary AS after, request_id AS "requestId", outcome, occurred_at AS "occurredAt", occurred_at::text AS "cursorKey"
          FROM rezics_account_operator_audit WHERE ($1::text IS NULL OR actor_id = $1)
            AND ($2::text IS NULL OR target_id = $2) AND ($3::text IS NULL OR action = $3)
            AND ($4::timestamptz IS NULL OR occurred_at >= $4) AND ($5::timestamptz IS NULL OR occurred_at < $5)
            AND ($6::timestamptz IS NULL OR (occurred_at, id) < ($6, $7::uuid))
          ORDER BY occurred_at DESC, id DESC LIMIT $8`, [query.actorId ?? null, query.targetId ?? null,
          query.action ?? null, query.from ?? null, query.to ?? null, cursor?.key ?? null, cursor?.id ?? null, limit + 1]);
        const rows = result.rows.slice(0, limit); const last = rows.at(-1);
        return accountJson({ items: rows.map(({ cursorKey: _key, ...row }) => ({ ...row, occurredAt: row.occurredAt.toISOString() })),
          nextCursor: result.rows.length > limit && last ? encodeCursor(secret, scope, last.cursorKey, last.id) : null });
      } catch (error) { return accountFailure(error); }
    });
}
