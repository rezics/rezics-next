import { createHash, randomUUID } from 'node:crypto';
import { createEmailVerificationToken } from 'better-auth/api';
import type { Pool, PoolClient } from 'pg';
import { AccountProblem, accountSession, type AccountAuth } from './http.ts';
import { operatorRole, requireOperator, rolePermits, writeAudit, type OperatorPermission, type OperatorRole } from './operators.ts';
import { accountLocale, enqueueAccountEmail, type AccountLocale } from './email.ts';

export const adminActions = ['suspend', 'unsuspend', 'revoke-sessions', 'require-password-reset',
  'resend-verification', 'add-note'] as const;
export type AdminAction = typeof adminActions[number];
/** Actions an operator may apply to up to `bulkLimit` selected users at once. */
export const bulkActions = ['suspend', 'unsuspend', 'revoke-sessions', 'require-password-reset',
  'resend-verification'] as const satisfies readonly AdminAction[];
export type BulkAction = typeof bulkActions[number];
export const bulkLimit = 100;
/** The longest undo window a bulk job may ask for: its items wait that long
 * before the first runs, and its actor can cancel it meanwhile. */
export const bulkUndoLimit = 30;
export const reasonCodes = ['spam', 'abuse', 'fraud', 'impersonation', 'legal', 'compromised',
  'user-request', 'support', 'appeal', 'error-correction', 'other'] as const;
export type ReasonCode = typeof reasonCodes[number];
/** The reason codes each action accepts. A sanction (below) requires one. */
export const actionReasonCodes = {
  suspend: ['spam', 'abuse', 'fraud', 'impersonation', 'legal', 'compromised', 'other'],
  unsuspend: ['appeal', 'error-correction', 'other'],
  'revoke-sessions': ['compromised', 'user-request', 'support', 'other'],
  'require-password-reset': ['compromised', 'user-request', 'support', 'other'],
  'resend-verification': ['user-request', 'support', 'other'],
  'add-note': ['support', 'other'],
} as const satisfies Record<AdminAction, readonly ReasonCode[]>;
/** Sanctions change what the user can do; they need a reason code and may
 * carry a message that is emailed to the user. */
export const sanctionActions: readonly AdminAction[] = ['suspend', 'unsuspend', 'revoke-sessions', 'require-password-reset'];
export const actionPermissions: Record<AdminAction, OperatorPermission> = {
  suspend: 'users:suspend', unsuspend: 'users:suspend', 'revoke-sessions': 'sessions:revoke',
  'require-password-reset': 'password:require-reset', 'resend-verification': 'verification:send', 'add-note': 'notes:write',
};

export interface ActionInput { action: AdminAction; reason: string; reasonCode?: ReasonCode;
  userMessage?: string; expiresAt?: string; note?: string }
type Actor = { userId: string; sessionId: string };

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

/** The audit record's before/after summary of an account. */
export async function profile(db: Pool | PoolClient, userId: string) {
  const result = await db.query<AccountProfile>(`SELECT ${profileFields} FROM "user" u
    JOIN rezics_account_security s ON s.user_id = u.id WHERE u.id = $1`, [userId]);
  if (!result.rows[0]) throw new AccountProblem('not_found', 404);
  return profileView(result.rows[0]);
}

export function validateAction(body: ActionInput) {
  const sanction = sanctionActions.includes(body.action);
  const codes: readonly string[] = actionReasonCodes[body.action];
  if (!body.reason.trim() || (body.action === 'add-note' && !body.note?.trim())) throw new AccountProblem('invalid_request', 400);
  if (body.expiresAt && (body.action !== 'suspend' || new Date(body.expiresAt).getTime() <= Date.now())) throw new AccountProblem('invalid_request', 400);
  if (sanction ? !body.reasonCode || !codes.includes(body.reasonCode) : body.reasonCode && !codes.includes(body.reasonCode)) {
    throw new AccountProblem('invalid_request', 400);
  }
  if (body.userMessage !== undefined && (!sanction || !body.userMessage.trim())) throw new AccountProblem('invalid_request', 400);
}

export async function checkActor(db: PoolClient, actor: Actor, permission: OperatorPermission) {
  const current = await db.query<{ role: OperatorRole }>(`SELECT o.role FROM rezics_account_operator o
    JOIN "session" s ON s."userId" = o.user_id AND s.id = $2 AND s."expiresAt" > now()
    WHERE o.user_id = $1 FOR SHARE OF o, s`, [actor.userId, actor.sessionId]);
  if (!current.rows[0] || !rolePermits(current.rows[0].role, permission)) throw new AccountProblem('forbidden', 403);
  return current.rows[0].role;
}

/** One action on one user inside the caller's transaction, after the caller
 * took the operator-roles lock and checked the actor's current role. `skipNoop`
 * (bulk) leaves an already-satisfied user untouched and unaudited. */
async function performUserAction(db: PoolClient, auth: AccountAuth, actorId: string, role: OperatorRole,
  userId: string, body: ActionInput, locale: AccountLocale, skipNoop = false): Promise<{ requestId: string | null }> {
  const targetRole = await db.query<{ role: OperatorRole }>('SELECT role FROM rezics_account_operator WHERE user_id = $1 FOR SHARE', [userId]);
  if (targetRole.rows[0] && role !== 'owner') throw new AccountProblem('forbidden', 403);
  if (targetRole.rows[0]?.role === 'owner' && ['suspend', 'require-password-reset'].includes(body.action)) {
    const otherOwner = await db.query(`SELECT 1 FROM rezics_account_operator o JOIN rezics_account_security s ON s.user_id = o.user_id
      WHERE o.role = 'owner' AND o.user_id <> $1 AND NOT s.password_reset_required
        AND s.deletion_started_at IS NULL
        AND (s.suspended_at IS NULL OR s.suspended_until <= now()) LIMIT 1`, [userId]);
    if (!otherOwner.rowCount) throw new AccountProblem('conflict', 409);
  }
  await db.query('SELECT 1 FROM rezics_account_security WHERE user_id = $1 FOR UPDATE', [userId]);
  const before = await profile(db, userId);
  if (skipNoop && ((body.action === 'unsuspend' && before.status !== 'suspended')
    || (body.action === 'resend-verification' && before.emailVerified))) return { requestId: null };
  if (body.action === 'suspend') {
    await db.query(`UPDATE rezics_account_security SET generation = generation + 1, suspended_at = now(),
      suspended_until = $2, suspension_reason = $3, suspension_code = $4 WHERE user_id = $1`,
    [userId, body.expiresAt ?? null, body.reason, body.reasonCode]);
  } else if (body.action === 'unsuspend') {
    await db.query(`UPDATE rezics_account_security SET suspended_at = NULL, suspended_until = NULL,
      suspension_reason = NULL, suspension_code = NULL WHERE user_id = $1`, [userId]);
  } else if (body.action === 'require-password-reset') {
    await db.query(`UPDATE rezics_account_security SET generation = generation + 1, password_reset_required = true WHERE user_id = $1`, [userId]);
  } else if (body.action === 'add-note') {
    await db.query('INSERT INTO rezics_account_operator_note (user_id, author_id, body) VALUES ($1, $2, $3)', [userId, actorId, body.note!.trim()]);
  } else if (body.action === 'resend-verification' && !before.emailVerified) {
    const token = await createEmailVerificationToken(String(auth.options.secret), before.email, undefined, 1800);
    const url = new URL('/api/auth/verify-email', String(auth.options.baseURL));
    url.searchParams.set('token', token); url.searchParams.set('callbackURL', '/');
    await enqueueAccountEmail(db, String(auth.options.secret), { userId, to: before.email,
      purpose: 'verify', locale, url: url.toString() });
  }
  if (['suspend', 'require-password-reset', 'revoke-sessions'].includes(body.action)) {
    if (body.action === 'revoke-sessions') await db.query('UPDATE rezics_account_security SET generation = generation + 1 WHERE user_id = $1', [userId]);
    await db.query('DELETE FROM "session" WHERE "userId" = $1', [userId]);
    await db.query('UPDATE "oauthRefreshToken" SET revoked = now() WHERE "userId" = $1 AND revoked IS NULL', [userId]);
    await db.query('DELETE FROM verification WHERE value = $1', [userId]);
  }
  const userMessage = body.userMessage?.trim() || null;
  if (userMessage) {
    // Queued with the change: the user hears about a sanction only if it commits.
    await enqueueAccountEmail(db, String(auth.options.secret), { userId, to: before.email, purpose: 'notice',
      locale, url: new URL('/', String(auth.options.baseURL)).toString(), message: userMessage });
  }
  const after = await profile(db, userId);
  const requestId = randomUUID();
  await writeAudit(db, { actorId, action: body.action, targetId: userId, reason: body.reason,
    reasonCode: body.reasonCode ?? null, userMessage, before, after, requestId });
  await db.query(`INSERT INTO rezics_account_security_event (user_id, action, detail)
    VALUES ($1, 'admin_action', $2)`, [userId, JSON.stringify({ action: body.action, requestId })]);
  return { requestId };
}

const digestOf = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

export async function administerUser(auth: AccountAuth, pool: Pool, request: Request, userId: string,
  body: ActionInput & { commandId: string }) {
  validateAction(body);
  const permission = actionPermissions[body.action];
  const actor = await requireOperator(auth, pool, request, permission);
  const digest = digestOf([userId, body.action, body.reason, body.expiresAt, body.note, body.reasonCode, body.userMessage]);
  const db = await pool.connect();
  try {
    await db.query('BEGIN');
    await db.query("SET LOCAL lock_timeout = '3s'");
    // Owner availability and role changes share a lock. Two owners cannot
    // concurrently suspend/reset each other and strand the installation.
    await db.query("SELECT pg_advisory_xact_lock(hashtextextended('account-operator-roles', 0))");
    await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`admin:${actor.userId}:${body.commandId}`]);
    const role = await checkActor(db, actor, permission);
    const existing = await db.query<{ digest: string; response: { status: boolean; requestId: string } }>(
      'SELECT digest, response FROM rezics_account_operator_command WHERE actor_id = $1 AND command_id = $2', [actor.userId, body.commandId]);
    if (existing.rows[0]) {
      if (existing.rows[0].digest !== digest) throw new AccountProblem('conflict', 409);
      await db.query('COMMIT'); return existing.rows[0].response;
    }
    const { requestId } = await performUserAction(db, auth, actor.userId, role, userId, body, accountLocale(request));
    const response = { status: true, requestId: requestId! };
    await db.query(`INSERT INTO rezics_account_operator_command (actor_id, command_id, digest, response)
      VALUES ($1, $2, $3, $4)`, [actor.userId, body.commandId, digest, JSON.stringify(response)]);
    await db.query('COMMIT'); return response;
  } catch (error) { await db.query('ROLLBACK'); throw error; }
  finally { db.release(); }
}

/** Admits a bulk action under the operator's current step-up and returns its
 * job. Replaying the same command returns the same job; items then run in the
 * background (`runBulkItem`). */
export async function createBulkJob(auth: AccountAuth, pool: Pool, request: Request, body: ActionInput & {
  action: BulkAction; reasonCode: ReasonCode; userIds: string[]; commandId: string; undoSeconds?: number }) {
  validateAction(body);
  const userIds = [...new Set(body.userIds)];
  if (userIds.length !== body.userIds.length || !userIds.length || userIds.length > bulkLimit) throw new AccountProblem('invalid_request', 400);
  const undoSeconds = body.undoSeconds ?? 0;
  if (!Number.isInteger(undoSeconds) || undoSeconds < 0 || undoSeconds > bulkUndoLimit) throw new AccountProblem('invalid_request', 400);
  const actor = await requireOperator(auth, pool, request, actionPermissions[body.action]);
  const digest = digestOf([body.action, userIds, body.reasonCode, body.reason, body.expiresAt, body.userMessage,
    ...(undoSeconds ? [undoSeconds] : [])]);
  const db = await pool.connect();
  try {
    await db.query('BEGIN');
    await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`admin-job:${actor.userId}:${body.commandId}`]);
    const existing = await db.query<{ id: string; digest: string }>(
      'SELECT id, digest FROM rezics_account_operator_job WHERE actor_id = $1 AND command_id = $2', [actor.userId, body.commandId]);
    if (existing.rows[0]) {
      if (existing.rows[0].digest !== digest) throw new AccountProblem('conflict', 409);
      await db.query('COMMIT'); return { jobId: existing.rows[0].id };
    }
    const job = await db.query<{ id: string }>(`INSERT INTO rezics_account_operator_job (actor_id, session_id, command_id,
      digest, action, reason_code, reason, user_message, expires_at, locale, starts_at)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, clock_timestamp() + make_interval(secs => $11)) RETURNING id`,
    [actor.userId, actor.sessionId, body.commandId, digest, body.action, body.reasonCode, body.reason.trim(),
      body.userMessage?.trim() || null, body.expiresAt ?? null, accountLocale(request), undoSeconds]);
    const jobId = job.rows[0]!.id;
    await db.query(`INSERT INTO rezics_account_operator_job_item (job_id, position, user_id)
      SELECT $1, ordinality - 1, user_id FROM unnest($2::text[]) WITH ORDINALITY AS item(user_id, ordinality)`, [jobId, userIds]);
    await writeAudit(db, { actorId: actor.userId, action: 'bulk_action_started', targetId: jobId, reason: body.reason.trim(),
      reasonCode: body.reasonCode, userMessage: body.userMessage?.trim() || null, before: null,
      after: { action: body.action, users: userIds.length, expiresAt: body.expiresAt ?? null, undoSeconds }, requestId: randomUUID() });
    await db.query('COMMIT');
    return { jobId };
  } catch (error) { await db.query('ROLLBACK'); throw error; }
  finally { db.release(); }
}

/** Runs the job's next pending item: its effect, audit record and result
 * commit together. Returns true when it ran one, the job's start time while
 * its undo window lasts, and false when nothing is left or another runner
 * holds the job. An actor who lost the permission or session fails the rest. */
export async function runBulkItem(auth: AccountAuth, pool: Pool, jobId: string): Promise<boolean | Date> {
  const db = await pool.connect();
  try {
    await db.query('BEGIN');
    await db.query("SET LOCAL lock_timeout = '3s'");
    await db.query("SELECT pg_advisory_xact_lock(hashtextextended('account-operator-roles', 0))");
    const job = await db.query<{ actor_id: string; session_id: string; action: BulkAction; reason_code: ReasonCode;
      reason: string; user_message: string | null; expires_at: Date | null; locale: AccountLocale; waiting: Date | null }>(`SELECT actor_id,
      session_id, action, reason_code, reason, user_message, expires_at, locale,
      CASE WHEN starts_at > clock_timestamp() THEN starts_at END AS waiting FROM rezics_account_operator_job
      WHERE id = $1 AND finished_at IS NULL FOR UPDATE SKIP LOCKED`, [jobId]);
    const current = job.rows[0];
    if (!current) { await db.query('COMMIT'); return false; }
    if (current.waiting) { await db.query('COMMIT'); return current.waiting; }
    const item = await db.query<{ position: number; user_id: string }>(`SELECT position, user_id FROM rezics_account_operator_job_item
      WHERE job_id = $1 AND state = 'pending' ORDER BY position LIMIT 1 FOR UPDATE`, [jobId]);
    const next = item.rows[0];
    let role: OperatorRole | null = null;
    if (next) {
      try { role = await checkActor(db, { userId: current.actor_id, sessionId: current.session_id }, actionPermissions[current.action]); }
      catch (error) { if (!(error instanceof AccountProblem)) throw error; }
    }
    if (!next || !role) {
      if (next) await db.query(`UPDATE rezics_account_operator_job_item SET state = 'failed', error = 'forbidden', finished_at = now()
        WHERE job_id = $1 AND state = 'pending'`, [jobId]);
      await db.query('UPDATE rezics_account_operator_job SET finished_at = now() WHERE id = $1', [jobId]);
      await db.query('COMMIT'); return false;
    }
    await db.query('SAVEPOINT item');
    let result: { state: 'succeeded' | 'skipped' | 'failed'; error: string | null; requestId: string | null };
    try {
      const { requestId } = await performUserAction(db, auth, current.actor_id, role, next.user_id, {
        action: current.action, reason: current.reason, reasonCode: current.reason_code,
        userMessage: current.user_message ?? undefined, expiresAt: current.expires_at?.toISOString() }, current.locale, true);
      await db.query('RELEASE SAVEPOINT item');
      result = { state: requestId ? 'succeeded' : 'skipped', error: null, requestId };
    } catch (error) {
      await db.query('ROLLBACK TO SAVEPOINT item');
      result = { state: 'failed', error: error instanceof AccountProblem ? error.code : 'temporarily_unavailable', requestId: null };
    }
    await db.query(`UPDATE rezics_account_operator_job_item SET state = $3, error = $4, request_id = $5, finished_at = now()
      WHERE job_id = $1 AND position = $2`, [jobId, next.position, result.state, result.error, result.requestId]);
    await db.query('COMMIT'); return true;
  } catch (error) { await db.query('ROLLBACK'); throw error; }
  finally { db.release(); }
}

/** Cancels what a job has not done yet: inside its undo window that is every
 * item, later the rest of the list (items already done stay done). Its actor
 * or an owner may stop it; stopping never needs a fresh sign-in, since it
 * only withholds changes. Waits for the item in flight to commit. */
export async function cancelBulkJob(auth: AccountAuth, pool: Pool, request: Request, jobId: string) {
  const session = await accountSession(auth, request, true);
  const role = await operatorRole(pool, session.user.id);
  if (!role) throw new AccountProblem('forbidden', 403);
  const db = await pool.connect();
  try {
    await db.query('BEGIN');
    await db.query("SET LOCAL lock_timeout = '5s'");
    const job = await db.query<{ actorId: string; finishedAt: Date | null }>(`SELECT actor_id AS "actorId", finished_at AS "finishedAt"
      FROM rezics_account_operator_job WHERE id = $1 FOR UPDATE`, [jobId]);
    const row = job.rows[0];
    if (!row || (row.actorId !== session.user.id && !rolePermits(role, 'operators:manage'))) throw new AccountProblem('not_found', 404);
    if (row.finishedAt) { await db.query('COMMIT'); return { cancelled: 0 }; }
    const cancelled = await db.query(`UPDATE rezics_account_operator_job_item SET state = 'cancelled', finished_at = clock_timestamp()
      WHERE job_id = $1 AND state = 'pending'`, [jobId]);
    await db.query('UPDATE rezics_account_operator_job SET finished_at = clock_timestamp(), cancelled_at = clock_timestamp() WHERE id = $1', [jobId]);
    await writeAudit(db, { actorId: session.user.id, action: 'bulk_action_cancelled', targetId: jobId, reason: 'Bulk action stopped',
      before: null, after: { cancelled: cancelled.rowCount ?? 0 }, requestId: randomUUID() });
    await db.query('COMMIT');
    return { cancelled: cancelled.rowCount ?? 0 };
  } catch (error) { await db.query('ROLLBACK'); throw error; }
  finally { db.release(); }
}

/** Disabling an App refuses its authorizations, token grants and
 * introspection until an operator enables it again. */
export async function setClientDisabled(auth: AccountAuth, pool: Pool, request: Request, clientId: string,
  body: { action: 'disable' | 'enable'; reason: string; commandId: string }) {
  if (!body.reason.trim()) throw new AccountProblem('invalid_request', 400);
  const actor = await requireOperator(auth, pool, request, 'clients:manage');
  const digest = digestOf([clientId, body.action, body.reason]);
  const db = await pool.connect();
  try {
    await db.query('BEGIN');
    await db.query("SET LOCAL lock_timeout = '3s'");
    await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`admin:${actor.userId}:${body.commandId}`]);
    await checkActor(db, actor, 'clients:manage');
    const existing = await db.query<{ digest: string; response: { status: boolean; requestId: string } }>(
      'SELECT digest, response FROM rezics_account_operator_command WHERE actor_id = $1 AND command_id = $2', [actor.userId, body.commandId]);
    if (existing.rows[0]) {
      if (existing.rows[0].digest !== digest) throw new AccountProblem('conflict', 409);
      await db.query('COMMIT'); return existing.rows[0].response;
    }
    const summary = `SELECT "clientId", name, disabled, scopes, "grantTypes", "skipConsent" FROM "oauthClient" WHERE "clientId" = $1`;
    const before = await db.query(`${summary} FOR UPDATE`, [clientId]);
    if (!before.rows[0]) throw new AccountProblem('not_found', 404);
    await db.query('UPDATE "oauthClient" SET disabled = $2, "updatedAt" = now() WHERE "clientId" = $1', [clientId, body.action === 'disable']);
    const requestId = randomUUID();
    await writeAudit(db, { actorId: actor.userId, action: body.action === 'disable' ? 'client_disabled' : 'client_enabled',
      targetId: clientId, reason: body.reason.trim(), before: before.rows[0], after: (await db.query(summary, [clientId])).rows[0], requestId });
    const response = { status: true, requestId };
    await db.query(`INSERT INTO rezics_account_operator_command (actor_id, command_id, digest, response)
      VALUES ($1, $2, $3, $4)`, [actor.userId, body.commandId, digest, JSON.stringify(response)]);
    await db.query('COMMIT'); return response;
  } catch (error) { await db.query('ROLLBACK'); throw error; }
  finally { db.release(); }
}
