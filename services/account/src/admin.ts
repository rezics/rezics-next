import { randomUUID } from 'node:crypto';
import { Elysia, t } from 'elysia';
import type { Pool, PoolClient } from 'pg';
import { accountFailure, accountJson, AccountProblem, accountSession, literalUnion, type AccountAuth } from './http.ts';
import { decodeCursor, encodeCursor, pageQuery } from './pagination.ts';
import { operatorPermissions, operatorRole, requireOperator, rolePermits, writeAudit,
  type OperatorRole } from './operators.ts';
import { readMethods } from './methods.ts';
import { readSecurityActivity, readSessions } from './security-activity.ts';
import { readConnectedApps } from './connected-apps.ts';
import { accountResponses, activityView, commandView, connectedAppView,
  operatorRoleView, pageView, sessionView } from './views.ts';
import { actionReasonCodes, adminActions, administerUser, bulkActions, bulkLimit, bulkUndoLimit, cancelBulkJob, checkActor,
  createBulkJob, profile, reasonCodes, runBulkItem, setClientDisabled } from './admin-actions.ts';
import { auditExportFormats, auditOutcomes, exportAudit, readAudit, readJob, readOverview, readSanctions } from './admin-audit.ts';
import { readSignals, reviewSignal, signalKeyPattern } from './admin-signals.ts';
import { readTimeline, timelineCategories } from './admin-timeline.ts';
import { adminClientView, adminUserDetailView, auditEntryView, directoryColumn, directoryView,
  jobView, operatorsView, overviewView, preferencesView, savedView, signalsView, timelineView } from './admin-views.ts';

export { adminActions, type AdminAction } from './admin-actions.ts';

const statuses = ['active', 'suspended', 'password-reset-required'] as const;
const roleFilters = ['owner', 'admin', 'support', 'none'] as const;
/** A comma-separated set of literals, such as `status=active,suspended`. */
const literalList = (values: readonly string[]) => t.String({ pattern: `^(${values.join('|')})(,(${values.join('|')}))*$` });
const list = (value: string | undefined) => value ? [...new Set(value.split(','))] : null;
type DirectoryQuery = { q?: string; email?: string; name?: string; status?: string; role?: string;
  verified?: boolean; hasTwoFactor?: boolean; createdFrom?: string; createdTo?: string;
  sort?: 'createdAt' | 'email' | 'name'; direction?: 'asc' | 'desc'; limit?: number; cursor?: string };

const statusSql = `CASE WHEN s.suspended_at IS NOT NULL AND (s.suspended_until IS NULL OR s.suspended_until > now())
    THEN 'suspended' WHEN s.password_reset_required THEN 'password-reset-required' ELSE 'active' END`;
const adminFields = `u.id, u.name, u.email, u.image, u."emailVerified", coalesce(u."twoFactorEnabled", false) AS "twoFactorEnabled",
  u."createdAt", u."updatedAt", s.password_reset_required AS "passwordResetRequired",
  s.suspended_until AS "suspendedUntil", s.suspension_reason AS "suspensionReason", ${statusSql} AS status,
  o.role, s.suspended_at AS "suspendedAt", s.suspension_code AS "suspensionCode"`;
const adminFrom = `"user" u JOIN rezics_account_security s ON s.user_id = u.id LEFT JOIN rezics_account_operator o ON o.user_id = u.id`;
/** Last successful sign-in, one index probe per returned row. */
const lastSignIn = (alias: string) => `(SELECT e.occurred_at FROM rezics_account_security_event e
  WHERE e.user_id = ${alias}.id AND e.action = 'sign_in' ORDER BY e.occurred_at DESC LIMIT 1) AS "lastSignInAt"`;
interface AdminProfileRow {
  id: string; name: string; email: string; image: string | null; emailVerified: boolean; twoFactorEnabled: boolean;
  createdAt: Date; updatedAt: Date; passwordResetRequired: boolean; suspendedUntil: Date | null; suspensionReason: string | null;
  status: 'active' | 'suspended' | 'password-reset-required'; role: OperatorRole | null; suspendedAt: Date | null;
  suspensionCode: string | null; lastSignInAt: Date | null;
}
const adminProfile = (row: AdminProfileRow) => ({ ...row, createdAt: row.createdAt.toISOString(),
  updatedAt: row.updatedAt.toISOString(), suspendedUntil: row.suspendedUntil?.toISOString() ?? null,
  suspendedAt: row.suspendedAt?.toISOString() ?? null, lastSignInAt: row.lastSignInAt?.toISOString() ?? null });

async function readAdminProfile(db: Pool | PoolClient, userId: string) {
  const result = await db.query<AdminProfileRow>(`SELECT ${adminFields}, ${lastSignIn('u')} FROM ${adminFrom} WHERE u.id = $1`, [userId]);
  if (!result.rows[0]) throw new AccountProblem('not_found', 404);
  return adminProfile(result.rows[0]);
}

/** Free text is an indexed prefix of email, name or ID; `email` is an email
 * prefix; `name` matches anywhere in the name (so a given name finds a Chinese
 * full name) and may scan. No unbounded count; seek ordering is stable by ID;
 * a two-second statement budget bounds operator queries on large directories.
 * `exact` is the user whose ID or email is exactly the search text. */
export async function readDirectory(pool: Pool, secret: string, actorId: string, query: DirectoryQuery) {
  if (query.createdFrom && query.createdTo && query.createdFrom > query.createdTo) throw new AccountProblem('invalid_request', 400);
  const sort = query.sort ?? 'createdAt';
  const direction = query.direction ?? 'desc';
  const search = (query.q ?? '').trim().toLowerCase();
  const email = query.email?.trim().toLowerCase() || null;
  const name = query.name?.trim().toLowerCase() || null;
  const status = list(query.status);
  const role = list(query.role);
  const scope = `directory:${actorId}:${JSON.stringify([search, query.status, query.verified, query.hasTwoFactor,
    query.createdFrom, query.createdTo, sort, direction, ...(email || name || role ? [email, name, query.role] : [])])}`;
  const cursor = decodeCursor(secret, scope, query.cursor);
  const column = { createdAt: 'u."createdAt"', email: 'lower(u.email)', name: 'lower(u.name)' }[sort];
  const op = direction === 'asc' ? '>' : '<';
  const limit = query.limit ?? 25;
  const escape = (value: string) => value.replace(/[\\%_]/g, '\\$&');
  const db = await pool.connect();
  try {
    await db.query('BEGIN');
    await db.query("SET LOCAL statement_timeout = '2s'");
    const result = await db.query<AdminProfileRow & { sortKey: string; sortValue: unknown }>(`SELECT page.*, ${lastSignIn('page')} FROM (
      SELECT ${adminFields}, ${column}::text AS "sortKey", ${column} AS "sortValue" FROM ${adminFrom}
      WHERE ($1::text = '' OR lower(u.email) LIKE $1 || '%' ESCAPE '\\'
        OR lower(u.name) LIKE $1 || '%' ESCAPE '\\' OR lower(u.id) LIKE $1 || '%' ESCAPE '\\')
        AND ($2::text[] IS NULL OR ${statusSql} = ANY($2))
        AND ($3::boolean IS NULL OR u."emailVerified" = $3)
        AND ($4::boolean IS NULL OR coalesce(u."twoFactorEnabled", false) = $4)
        AND ($5::timestamptz IS NULL OR u."createdAt" >= $5)
        AND ($6::timestamptz IS NULL OR u."createdAt" < $6)
        AND ($7::${sort === 'createdAt' ? 'timestamptz' : 'text'} IS NULL OR (${column}, u.id) ${op} ($7, $8))
        AND ($10::text IS NULL OR lower(u.email) LIKE $10 || '%' ESCAPE '\\')
        AND ($11::text IS NULL OR strpos(lower(u.name), $11) > 0)
        AND ($12::text[] IS NULL OR coalesce(o.role, 'none') = ANY($12))
      ORDER BY ${column} ${direction}, u.id ${direction} LIMIT $9) page
      ORDER BY page."sortValue" ${direction}, page.id ${direction}`,
    [escape(search), status, query.verified ?? null, query.hasTwoFactor ?? null, query.createdFrom ?? null,
      query.createdTo ?? null, cursor?.key ?? null, cursor?.id ?? null, limit + 1, email ? escape(email) : null, name, role]);
    const term = (query.q ?? '').trim() || query.email?.trim();
    const exact = term ? await db.query<AdminProfileRow>(`SELECT ${adminFields}, ${lastSignIn('u')} FROM ${adminFrom}
      WHERE u.id = $1 OR lower(u.email) = lower($1) ORDER BY u.id = $1 DESC LIMIT 1`, [term]) : null;
    const rows = result.rows.slice(0, limit);
    const last = rows.at(-1);
    return { items: rows.map(({ sortKey: _key, sortValue: _value, ...row }) => adminProfile(row)),
      nextCursor: result.rows.length > limit && last ? encodeCursor(secret, scope, last.sortKey, last.id) : null,
      exact: exact?.rows[0] ? adminProfile(exact.rows[0]) : null };
  } finally { try { await db.query('ROLLBACK'); } finally { db.release(); } }
}

/** Until when the session's recent sign-in or re-authentication admits writes. */
async function stepUpUntil(pool: Pool, sessionId: string) {
  const result = await pool.query<{ until: Date | null }>(`SELECT greatest(s."createdAt", p.verified_at) + interval '5 minutes' AS until
    FROM "session" s LEFT JOIN rezics_account_step_up p ON p.session_id = s.id WHERE s.id = $1`, [sessionId]);
  const until = result.rows[0]?.until;
  return until && until.getTime() > Date.now() ? until.toISOString() : null;
}

const noteRow = (row: { id: string; authorId: string; body: string; createdAt: Date; authorName: string | null; authorEmail: string | null }) =>
  ({ ...row, createdAt: row.createdAt.toISOString() });

export function adminApi(auth: AccountAuth, pool: Pool) {
  const secret = String(auth.options.secret);
  const userParams = t.Object({ userId: t.String({ minLength: 1, maxLength: 128 }) });
  const reasonCode = literalUnion(reasonCodes);
  const auditQuery = { actorId: t.Optional(t.String({ maxLength: 320 })), targetId: t.Optional(t.String({ maxLength: 320 })),
    action: t.Optional(t.String({ maxLength: 128 })), outcome: t.Optional(literalUnion(auditOutcomes)),
    from: t.Optional(t.String({ format: 'date-time' })), to: t.Optional(t.String({ format: 'date-time' })),
    reasonCode: t.Optional(reasonCode), requestId: t.Optional(t.String({ format: 'uuid' })),
    q: t.Optional(t.String({ maxLength: 200 })) };
  // A process runs each job at most once at a time, after its undo window; a
  // job whose runner died with its process resumes when anyone reads it.
  const running = new Map<string, Promise<void>>();
  const runJob = (jobId: string) => {
    if (running.has(jobId)) return;
    running.set(jobId, (async () => {
      try {
        for (let next = await runBulkItem(auth, pool, jobId); next; next = await runBulkItem(auth, pool, jobId)) {
          if (next instanceof Date) await Bun.sleep(Math.max(0, next.getTime() - Date.now()) + 50);
        }
      } catch { console.error('Account bulk action runner stopped; reading the job resumes it'); }
      finally { running.delete(jobId); }
    })());
  };
  // Display preferences are private to the operator and reversible: any
  // current operator may change their own without re-authenticating.
  const preferenceActor = async (request: Request) => {
    const session = await accountSession(auth, request);
    if (!await operatorRole(pool, session.user.id)) throw new AccountProblem('forbidden', 403);
    return session.user.id;
  };
  const readPreferences = async (userId: string) => {
    const result = await pool.query<{ density: 'comfortable' | 'compact'; columns: string[] | null; views: { id: string; name: string; query: string }[] }>(
      'SELECT density, columns, views FROM rezics_account_operator_preference WHERE user_id = $1', [userId]);
    return result.rows[0] ?? { density: 'comfortable' as const, columns: null, views: [] };
  };
  return new Elysia()
    .get('/api/account/admin/me', { response: accountResponses(t.Object({ role: t.Nullable(operatorRoleView),
      permissions: t.Array(t.String()), secondFactor: t.Boolean(), stepUpUntil: t.Nullable(t.String()),
      reasonCodes: t.Record(t.String(), t.Array(t.String())), bulkActions: t.Array(t.String()), bulkLimit: t.Integer(),
      bulkUndoLimit: t.Integer() })) }, async ({ request }) => {
      try {
        const session = await accountSession(auth, request);
        const role = await operatorRole(pool, session.user.id);
        return accountJson({ role, permissions: role ? operatorPermissions[role] : [],
          secondFactor: !!(session.user as { twoFactorEnabled?: boolean | null }).twoFactorEnabled,
          stepUpUntil: role ? await stepUpUntil(pool, session.session.id) : null,
          reasonCodes: actionReasonCodes, bulkActions, bulkLimit, bulkUndoLimit });
      } catch (error) { return accountFailure(error); }
    })
    .get('/api/account/admin/overview', { response: accountResponses(overviewView) }, async ({ request }) => {
      try {
        const actor = await requireOperator(auth, pool, request, 'users:read');
        return accountJson(await readOverview(pool, actor.userId, { canReadAudit: rolePermits(actor.role, 'audit:read'),
          canManageClients: rolePermits(actor.role, 'clients:manage') }));
      } catch (error) { return accountFailure(error); }
    })
    .get('/api/account/admin/signals', { response: accountResponses(signalsView) }, async ({ request }) => {
      try {
        const actor = await requireOperator(auth, pool, request, 'users:read');
        return accountJson(await readSignals(pool, { canManageClients: rolePermits(actor.role, 'clients:manage') }));
      } catch (error) { return accountFailure(error); }
    })
    .post('/api/account/admin/signals/review', { response: accountResponses(commandView),
      body: t.Object({ key: t.String({ pattern: signalKeyPattern, maxLength: 240 }), note: t.Optional(t.String({ maxLength: 1000 })),
        commandId: t.String({ format: 'uuid' }) }, { additionalProperties: false }) }, async ({ request, body }) => {
      try { return accountJson(await reviewSignal(auth, pool, request, body)); }
      catch (error) { return accountFailure(error); }
    })
    .get('/api/account/admin/clients', { response: accountResponses(pageView(adminClientView)), query: t.Object(pageQuery) }, async ({ request, query }) => {
      try {
        const actor = await requireOperator(auth, pool, request, 'clients:manage');
        const scope = `clients:${actor.userId}`;
        const cursor = decodeCursor(secret, scope, query.cursor);
        const limit = query.limit ?? 25;
        const result = await pool.query<{ clientId: string; name: string; disabled: boolean | null; scopes: string[] | null;
          grantTypes: string[] | null; redirectUris: string[]; userId: string | null; skipConsent: boolean | null;
          type: 'public' | 'confidential'; uri: string | null; createdAt: Date | null;
          installation: { id: string; state: string; scopes: string[]; installedAt: string } | null }>(`
          SELECT c."clientId", c.name, c.disabled, c.scopes, c."grantTypes", c."redirectUris", c."userId", c."skipConsent",
            CASE WHEN c."tokenEndpointAuthMethod" = 'none' THEN 'public' ELSE 'confidential' END AS type, c.uri, c."createdAt",
            (SELECT jsonb_build_object('id', i.id, 'state', i.state, 'scopes', i.scopes, 'installedAt', i.installed_at)
              FROM rezics_oauth_installation i WHERE i.client_id = c."clientId"
              ORDER BY i.installed_at DESC, i.id DESC LIMIT 1) AS installation
          FROM "oauthClient" c WHERE ($1::text IS NULL OR c."clientId" > $1) ORDER BY c."clientId" LIMIT $2`, [cursor?.id ?? null, limit + 1]);
        const rows = result.rows.slice(0, limit); const last = rows.at(-1);
        return accountJson({ items: rows.map(row => ({ ...row, createdAt: row.createdAt?.toISOString() ?? null,
          installation: row.installation && { ...row.installation, installedAt: new Date(row.installation.installedAt).toISOString() } })),
        nextCursor: result.rows.length > limit && last ? encodeCursor(secret, scope, last.clientId, last.clientId) : null });
      } catch (error) { return accountFailure(error); }
    })
    .post('/api/account/admin/clients/:clientId/actions', { response: accountResponses(commandView),
      params: t.Object({ clientId: t.String({ minLength: 1, maxLength: 256 }) }),
      body: t.Object({ action: t.Union([t.Literal('disable'), t.Literal('enable')]),
        reason: t.String({ minLength: 3, maxLength: 1000 }), commandId: t.String({ format: 'uuid' }) }, { additionalProperties: false }),
    }, async ({ request, params, body }) => {
      try { return accountJson(await setClientDisabled(auth, pool, request, params.clientId, body)); }
      catch (error) { return accountFailure(error); }
    })
    .get('/api/account/admin/users', { response: accountResponses(directoryView), query: t.Object({ ...pageQuery,
      q: t.Optional(t.String({ maxLength: 200 })), email: t.Optional(t.String({ maxLength: 320 })),
      name: t.Optional(t.String({ maxLength: 200 })), status: t.Optional(literalList(statuses)),
      role: t.Optional(literalList(roleFilters)),
      verified: t.Optional(t.Boolean()), hasTwoFactor: t.Optional(t.Boolean()),
      createdFrom: t.Optional(t.String({ format: 'date-time' })), createdTo: t.Optional(t.String({ format: 'date-time' })),
      sort: t.Optional(t.Union([t.Literal('createdAt'), t.Literal('email'), t.Literal('name')])),
      direction: t.Optional(t.Union([t.Literal('asc'), t.Literal('desc')])),
    }) }, async ({ request, query }) => {
      try { return accountJson(await readDirectory(pool, secret, (await requireOperator(auth, pool, request, 'users:read')).userId, query)); }
      catch (error) { return accountFailure(error); }
    })
    .get('/api/account/admin/users/:userId', { response: accountResponses(adminUserDetailView), params: userParams }, async ({ request, params }) => {
      try {
        const actor = await requireOperator(auth, pool, request, 'users:read');
        const user = await readAdminProfile(pool, params.userId);
        const [methods, sessions, apps, activity, notes, timeline, signals] = await Promise.all([
          readMethods(pool, params.userId), readSessions(pool, secret, params.userId, '', { limit: 50 }),
          readConnectedApps(pool, secret, params.userId, { limit: 10 }), readSecurityActivity(pool, secret, params.userId, { limit: 10 }),
          pool.query<{ id: string; authorId: string; body: string; createdAt: Date; authorName: string | null; authorEmail: string | null }>(`
            SELECT n.id, n.author_id AS "authorId", n.body, n.created_at AS "createdAt", a.name AS "authorName", a.email AS "authorEmail"
            FROM rezics_account_operator_note n LEFT JOIN "user" a ON a.id = n.author_id
            WHERE n.user_id = $1 ORDER BY n.created_at DESC, n.id DESC LIMIT 25`, [params.userId]),
          readTimeline(pool, secret, params.userId, { limit: 20 }, rolePermits(actor.role, 'audit:read')),
          readSignals(pool, { userId: params.userId, canManageClients: false }),
        ]);
        return accountJson({ profile: user, methods, sessions, apps, activity, notes: notes.rows.map(noteRow), timeline,
          signals: signals.items });
      } catch (error) { return accountFailure(error); }
    })
    .get('/api/account/admin/users/:userId/timeline', { response: accountResponses(timelineView), params: userParams,
      query: t.Object({ ...pageQuery, category: t.Optional(literalUnion(timelineCategories)) }) }, async ({ request, params, query }) => {
      try {
        const actor = await requireOperator(auth, pool, request, 'users:read');
        return accountJson(await readTimeline(pool, secret, params.userId, query, rolePermits(actor.role, 'audit:read')));
      } catch (error) { return accountFailure(error); }
    })
    .get('/api/account/admin/users/:userId/sessions', { response: accountResponses(pageView(sessionView)), params: userParams, query: t.Object(pageQuery) }, async ({ request, params, query }) => {
      try {
        await requireOperator(auth, pool, request, 'users:read');
        return accountJson(await readSessions(pool, secret, params.userId, '', query));
      } catch (error) { return accountFailure(error); }
    })
    .get('/api/account/admin/users/:userId/apps', { response: accountResponses(pageView(connectedAppView)), params: userParams, query: t.Object(pageQuery) }, async ({ request, params, query }) => {
      try {
        await requireOperator(auth, pool, request, 'users:read');
        return accountJson(await readConnectedApps(pool, secret, params.userId, query));
      } catch (error) { return accountFailure(error); }
    })
    .get('/api/account/admin/users/:userId/security-activity', { response: accountResponses(activityView), params: userParams, query: t.Object(pageQuery) }, async ({ request, params, query }) => {
      try {
        await requireOperator(auth, pool, request, 'users:read');
        return accountJson(await readSecurityActivity(pool, secret, params.userId, query));
      } catch (error) { return accountFailure(error); }
    })
    .get('/api/account/admin/users/:userId/sanctions', { response: accountResponses(pageView(auditEntryView)), params: userParams, query: t.Object(pageQuery) }, async ({ request, params, query }) => {
      try {
        await requireOperator(auth, pool, request, 'users:read');
        return accountJson(await readSanctions(pool, secret, params.userId, query));
      } catch (error) { return accountFailure(error); }
    })
    .post('/api/account/admin/users/:userId/actions', { response: accountResponses(commandView), params: userParams,
      body: t.Object({ action: literalUnion(adminActions),
        reason: t.String({ minLength: 3, maxLength: 1000 }), commandId: t.String({ format: 'uuid' }),
        reasonCode: t.Optional(reasonCode), userMessage: t.Optional(t.String({ minLength: 1, maxLength: 2000 })),
        expiresAt: t.Optional(t.String({ format: 'date-time' })), note: t.Optional(t.String({ minLength: 1, maxLength: 4000 })),
      }, { additionalProperties: false }) }, async ({ request, params, body }) => {
      try { return accountJson(await administerUser(auth, pool, request, params.userId, body)); }
      catch (error) { return accountFailure(error); }
    })
    .post('/api/account/admin/bulk-actions', { response: accountResponses(t.Object({ jobId: t.String() })),
      body: t.Object({ action: literalUnion(bulkActions),
        userIds: t.Array(t.String({ minLength: 1, maxLength: 128 }), { minItems: 1, maxItems: bulkLimit }),
        reason: t.String({ minLength: 3, maxLength: 1000 }), reasonCode, commandId: t.String({ format: 'uuid' }),
        userMessage: t.Optional(t.String({ minLength: 1, maxLength: 2000 })), expiresAt: t.Optional(t.String({ format: 'date-time' })),
        undoSeconds: t.Optional(t.Integer({ minimum: 0, maximum: bulkUndoLimit })),
      }, { additionalProperties: false }) }, async ({ request, body }) => {
      try {
        const { jobId } = await createBulkJob(auth, pool, request, body);
        runJob(jobId);
        return accountJson({ jobId });
      } catch (error) { return accountFailure(error); }
    })
    .get('/api/account/admin/bulk-actions/:jobId', { response: accountResponses(jobView),
      params: t.Object({ jobId: t.String({ format: 'uuid' }) }) }, async ({ request, params }) => {
      try {
        const actor = await requireOperator(auth, pool, request, 'users:read');
        const job = await readJob(pool, params.jobId, { userId: actor.userId, canReadAudit: rolePermits(actor.role, 'audit:read') });
        if (!job.finishedAt) runJob(job.id);
        return accountJson(job);
      } catch (error) { return accountFailure(error); }
    })
    .post('/api/account/admin/bulk-actions/:jobId/cancel', { response: accountResponses(t.Object({ cancelled: t.Integer() })),
      params: t.Object({ jobId: t.String({ format: 'uuid' }) }) }, async ({ request, params }) => {
      try { return accountJson(await cancelBulkJob(auth, pool, request, params.jobId)); }
      catch (error) { return accountFailure(error); }
    })
    .get('/api/account/admin/operators', { response: accountResponses(operatorsView) }, async ({ request }) => {
      try {
        await requireOperator(auth, pool, request, 'users:read');
        const result = await pool.query<{ userId: string; name: string; email: string; role: OperatorRole; assignedAt: Date;
          status: 'active' | 'suspended' | 'password-reset-required'; twoFactorEnabled: boolean; lastSignInAt: Date | null }>(`
          SELECT u.id AS "userId", u.name, u.email, o.role, o.assigned_at AS "assignedAt", ${statusSql} AS status,
            coalesce(u."twoFactorEnabled", false) AS "twoFactorEnabled", ${lastSignIn('u')}
          FROM rezics_account_operator o JOIN "user" u ON u.id = o.user_id JOIN rezics_account_security s ON s.user_id = o.user_id
          ORDER BY array_position(ARRAY['owner', 'admin', 'support'], o.role), lower(u.name), u.id LIMIT 500`);
        return accountJson({ items: result.rows.map(row => ({ ...row, assignedAt: row.assignedAt.toISOString(),
          lastSignInAt: row.lastSignInAt?.toISOString() ?? null })), permissions: operatorPermissions });
      } catch (error) { return accountFailure(error); }
    })
    .post('/api/account/admin/operators/:userId', { response: accountResponses(commandView), params: userParams,
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
        const before = (await db.query<{ role: OperatorRole }>('SELECT role FROM rezics_account_operator WHERE user_id = $1', [params.userId])).rows[0]?.role ?? null;
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
    .get('/api/account/admin/audit', { response: accountResponses(pageView(auditEntryView)),
      query: t.Object({ ...pageQuery, ...auditQuery }) }, async ({ request, query }) => {
      try {
        const actor = await requireOperator(auth, pool, request, 'audit:read');
        return accountJson(await readAudit(pool, secret, actor.userId, query));
      } catch (error) { return accountFailure(error); }
    })
    .get('/api/account/admin/audit/export', { query: t.Object({ ...auditQuery, format: t.Optional(literalUnion(auditExportFormats)) }),
      response: { ...accountResponses(t.Object({})), 200: t.String() } }, async ({ request, query: { format = 'csv', ...query } }) => {
      try {
        const actor = await requireOperator(auth, pool, request, 'audit:read');
        const { body, rows, truncated } = await exportAudit(pool, actor.userId, query, format);
        return new Response(body, { headers: { 'content-type': format === 'csv' ? 'text/csv; charset=utf-8' : 'application/x-ndjson; charset=utf-8',
          'cache-control': 'no-store',
          'content-disposition': `attachment; filename="rezics-account-audit-${new Date().toISOString().slice(0, 10)}.${format}"`,
          'x-rezics-rows': String(rows), 'x-rezics-truncated': String(truncated) } });
      } catch (error) { return accountFailure(error); }
    })
    .get('/api/account/admin/preferences', { response: accountResponses(preferencesView) }, async ({ request }) => {
      try { return accountJson(await readPreferences(await preferenceActor(request))); }
      catch (error) { return accountFailure(error); }
    })
    .post('/api/account/admin/preferences', { response: accountResponses(preferencesView),
      body: t.Object({ density: t.Optional(preferencesView.properties.density),
        columns: t.Optional(t.Nullable(t.Array(directoryColumn, { minItems: 1, maxItems: 8 }))),
        views: t.Optional(t.Array(savedView, { maxItems: 20 })) }, { additionalProperties: false }) }, async ({ request, body }) => {
      try {
        const userId = await preferenceActor(request);
        if ((body.columns && new Set(body.columns).size !== body.columns.length)
          || (body.views && new Set(body.views.map(view => view.id)).size !== body.views.length)) throw new AccountProblem('invalid_request', 400);
        await pool.query(`INSERT INTO rezics_account_operator_preference AS p (user_id, density, columns, views)
          VALUES ($1, coalesce($2, 'comfortable'), $3, coalesce($4, '[]'::jsonb))
          ON CONFLICT (user_id) DO UPDATE SET density = coalesce($2, p.density),
            columns = CASE WHEN $5 THEN $3 ELSE p.columns END, views = coalesce($4, p.views), updated_at = now()`,
        [userId, body.density ?? null, body.columns ? JSON.stringify(body.columns) : null,
          body.views ? JSON.stringify(body.views) : null, 'columns' in body]);
        return accountJson(await readPreferences(userId));
      } catch (error) { return accountFailure(error); }
    });
}
