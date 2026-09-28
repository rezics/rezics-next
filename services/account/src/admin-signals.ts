import { createHash, randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { AccountProblem, type AccountAuth } from './http.ts';
import { requireOperator, writeAudit, type OperatorPermission } from './operators.ts';
import { checkActor } from './admin-actions.ts';

// Risk signals: patterns in the security log that an operator should look at
// now. Each kind reads a bounded, indexed slice of recent events; a review is
// an append-only audit record on the signal's subject that names its key.
// Event signals (one event, one signal) close when reviewed; counting signals
// (failures, grants) count again from the review, so a new burst reopens them.

export const signalKinds = ['email-after-password', 'failed-sign-ins', 'mass-consent', 'new-passkey'] as const;
export type SignalKind = typeof signalKinds[number];
/** Who may review a kind: user signals are annotations like notes; an App's are the App managers'. */
export const signalPermissions: Record<SignalKind, OperatorPermission> = {
  'email-after-password': 'notes:write', 'failed-sign-ins': 'notes:write', 'new-passkey': 'notes:write',
  'mass-consent': 'clients:manage',
};
/** `<kind>:<subject or event ID>`; the second part is a user or App ID for
 * counting kinds and the security event's UUID for event kinds. */
export const signalKeyPattern = `^(${signalKinds.join('|')}):[A-Za-z0-9._~-]{1,200}$`;

export const signalThresholds = {
  /** Failed sign-ins on one account within a day. */
  failures: 5,
  /** Failures that make a burst severe even without a later success. */
  severeFailures: 20,
  /** An email change this close to a password change, either way round. */
  emailAfterPasswordHours: 24,
  /** How old an account must be for a new passkey to stand out. */
  passkeyAccountAgeDays: 30,
  /** Distinct accounts newly allowing one App within a day. */
  consents: 10,
  /** …and this many times its daily average over the week before. */
  consentSurge: 3,
} as const;
const candidateLimit = 200;
const eventWindow = '7 days';
const shownLimit = 25;

type Subject = { kind: 'user'; id: string; name: string; email: string } | { kind: 'client'; id: string; name: string; email: null };
export type Signal = { key: string; severity: 'high' | 'medium'; occurredAt: string; subject: Subject } & (
  | { kind: 'failed-sign-ins'; evidence: { failures: number; firstAt: string; lastAt: string; signedInAfter: boolean } }
  | { kind: 'email-after-password'; evidence: { emailChangedAt: string; passwordChangedAt: string } }
  | { kind: 'new-passkey'; evidence: { addedAt: string; accountCreatedAt: string } }
  | { kind: 'mass-consent'; evidence: { accounts: number; dailyAverage: number; firstAt: string; lastAt: string } });

const iso = (value: Date) => value.toISOString();
const user = (row: { userId: string; name: string; email: string }): Subject =>
  ({ kind: 'user', id: row.userId, name: row.name, email: row.email });

// Reviews of the candidates' subjects: the latest review time per signal key.
const reviewedSql = `SELECT r.after_summary->>'key' AS key, max(r.occurred_at) AS at FROM rezics_account_operator_audit r
  WHERE r.action = 'signal_reviewed' AND r.target_id = ANY($1::text[]) GROUP BY 1`;

async function reviews(db: Pool | PoolClient, subjects: string[]) {
  if (!subjects.length) return new Map<string, Date>();
  const result = await db.query<{ key: string; at: Date }>(reviewedSql, [[...new Set(subjects)]]);
  return new Map(result.rows.map(row => [row.key, row.at]));
}

/** At most 5000 failures of the last day (the failed sign-in partial index,
 * or one account's action index), recounted from each account's last review;
 * one index probe per flagged account for a later successful sign-in. */
async function failedSignIns(db: Pool | PoolClient, userId: string | null) {
  const result = await db.query<{ userId: string; name: string; email: string; failures: number; firstAt: Date; lastAt: Date;
    signedInAfter: boolean }>(`WITH recent AS (
      SELECT user_id, occurred_at FROM rezics_account_security_event
      WHERE action = 'sign_in_failed' AND occurred_at > now() - interval '24 hours' AND ($1::text IS NULL OR user_id = $1)
      ORDER BY occurred_at DESC LIMIT 5000
    ), reviewed AS (
      SELECT r.target_id AS user_id, max(r.occurred_at) AS at FROM rezics_account_operator_audit r
      WHERE r.action = 'signal_reviewed' AND r.target_id IN (SELECT DISTINCT user_id FROM recent)
        AND r.after_summary->>'key' = 'failed-sign-ins:' || r.target_id GROUP BY r.target_id
    ), counted AS (
      SELECT f.user_id, count(*)::int AS failures, min(f.occurred_at) AS first_at, max(f.occurred_at) AS last_at
      FROM recent f LEFT JOIN reviewed v ON v.user_id = f.user_id WHERE v.at IS NULL OR f.occurred_at > v.at
      GROUP BY f.user_id HAVING count(*) >= $2 ORDER BY count(*) DESC, max(f.occurred_at) DESC LIMIT $3
    )
    SELECT c.user_id AS "userId", u.name, u.email, c.failures, c.first_at AS "firstAt", c.last_at AS "lastAt",
      EXISTS (SELECT 1 FROM rezics_account_security_event s WHERE s.user_id = c.user_id AND s.action = 'sign_in'
        AND s.occurred_at > c.first_at) AS "signedInAfter"
    FROM counted c JOIN "user" u ON u.id = c.user_id`, [userId, signalThresholds.failures, candidateLimit + 1]);
  return result.rows.map((row): Signal => ({ key: `failed-sign-ins:${row.userId}`, kind: 'failed-sign-ins',
    severity: row.signedInAfter || row.failures >= signalThresholds.severeFailures ? 'high' : 'medium',
    occurredAt: iso(row.lastAt), subject: user(row),
    evidence: { failures: row.failures, firstAt: iso(row.firstAt), lastAt: iso(row.lastAt), signedInAfter: row.signedInAfter } }));
}

/** The 200 newest email changes of the week (signal index, or one account's
 * action index), each with one probe for the nearest password change. */
async function emailAfterPassword(db: Pool | PoolClient, userId: string | null) {
  const result = await db.query<{ id: string; userId: string; name: string; email: string; emailChangedAt: Date;
    passwordChangedAt: Date }>(`SELECT e.id, e.user_id AS "userId", u.name, u.email, e.occurred_at AS "emailChangedAt",
      p.occurred_at AS "passwordChangedAt"
    FROM (SELECT id, user_id, occurred_at FROM rezics_account_security_event
      WHERE action = 'email_changed' AND occurred_at > now() - interval '${eventWindow}' AND ($1::text IS NULL OR user_id = $1)
      ORDER BY occurred_at DESC LIMIT $3) e
    JOIN LATERAL (SELECT p.occurred_at FROM rezics_account_security_event p WHERE p.user_id = e.user_id
      AND p.action = 'password_changed' AND p.occurred_at > e.occurred_at - make_interval(hours => $2)
      AND p.occurred_at < e.occurred_at + make_interval(hours => $2)
      ORDER BY abs(extract(epoch FROM p.occurred_at - e.occurred_at)) LIMIT 1) p ON true
    JOIN "user" u ON u.id = e.user_id ORDER BY e.occurred_at DESC`,
  [userId, signalThresholds.emailAfterPasswordHours, candidateLimit + 1]);
  const reviewed = await reviews(db, result.rows.map(row => row.userId));
  return result.rows.filter(row => !reviewed.has(`email-after-password:${row.id}`)).map((row): Signal => ({
    key: `email-after-password:${row.id}`, kind: 'email-after-password', severity: 'high',
    occurredAt: iso(row.emailChangedAt > row.passwordChangedAt ? row.emailChangedAt : row.passwordChangedAt), subject: user(row),
    evidence: { emailChangedAt: iso(row.emailChangedAt), passwordChangedAt: iso(row.passwordChangedAt) } }));
}

/** The 200 newest passkeys added this week (signal index, or one account's
 * action index) on accounts at least 30 days old at the time. */
async function newPasskeys(db: Pool | PoolClient, userId: string | null) {
  const result = await db.query<{ id: string; userId: string; name: string; email: string; addedAt: Date; createdAt: Date }>(`
    SELECT e.id, e.user_id AS "userId", u.name, u.email, e.occurred_at AS "addedAt", u."createdAt"
    FROM (SELECT id, user_id, occurred_at FROM rezics_account_security_event
      WHERE action = 'passkey_added' AND occurred_at > now() - interval '${eventWindow}' AND ($1::text IS NULL OR user_id = $1)
      ORDER BY occurred_at DESC LIMIT $3) e
    JOIN "user" u ON u.id = e.user_id WHERE u."createdAt" < e.occurred_at - make_interval(days => $2)
    ORDER BY e.occurred_at DESC`, [userId, signalThresholds.passkeyAccountAgeDays, candidateLimit + 1]);
  const reviewed = await reviews(db, result.rows.map(row => row.userId));
  return result.rows.filter(row => !reviewed.has(`new-passkey:${row.id}`)).map((row): Signal => ({
    key: `new-passkey:${row.id}`, kind: 'new-passkey', severity: 'medium', occurredAt: iso(row.addedAt), subject: user(row),
    evidence: { addedAt: iso(row.addedAt), accountCreatedAt: iso(row.createdAt) } }));
}

/** At most 5000 grants of the last eight days (signal index), per App:
 * accounts newly allowing it in the last day (since its last review) against
 * its daily average over the week before. First-party and consent-skipping
 * Apps are never flagged. */
async function massConsent(db: Pool | PoolClient) {
  const result = await db.query<{ clientId: string; name: string | null; accounts: number; before: number; firstAt: Date;
    lastAt: Date }>(`WITH grants AS (
      SELECT detail->>'clientId' AS client_id, user_id, occurred_at FROM rezics_account_security_event
      WHERE action = 'consent_granted' AND occurred_at > now() - interval '8 days' ORDER BY occurred_at DESC LIMIT 5000
    ), reviewed AS (
      SELECT r.target_id AS client_id, max(r.occurred_at) AS at FROM rezics_account_operator_audit r
      WHERE r.action = 'signal_reviewed' AND r.target_id IN (SELECT DISTINCT client_id FROM grants)
        AND r.after_summary->>'key' = 'mass-consent:' || r.target_id GROUP BY r.target_id
    ), counted AS (
      SELECT g.client_id,
        count(DISTINCT g.user_id) FILTER (WHERE g.occurred_at > now() - interval '24 hours' AND (v.at IS NULL OR g.occurred_at > v.at))::int AS accounts,
        count(DISTINCT g.user_id) FILTER (WHERE g.occurred_at <= now() - interval '24 hours')::int AS before,
        min(g.occurred_at) FILTER (WHERE g.occurred_at > now() - interval '24 hours') AS first_at,
        max(g.occurred_at) AS last_at
      FROM grants g LEFT JOIN reviewed v ON v.client_id = g.client_id WHERE g.client_id IS NOT NULL GROUP BY g.client_id
    )
    SELECT c.client_id AS "clientId", o.name, c.accounts, c.before, c.first_at AS "firstAt", c.last_at AS "lastAt"
    FROM counted c JOIN "oauthClient" o ON o."clientId" = c.client_id
    WHERE c.accounts >= $1 AND c.accounts > $2 * c.before / 7.0 AND NOT coalesce(o."skipConsent", false)
      AND NOT EXISTS (SELECT 1 FROM rezics_oauth_first_party_client f WHERE f.client_id = c.client_id)
    ORDER BY c.accounts DESC LIMIT $3`, [signalThresholds.consents, signalThresholds.consentSurge, candidateLimit + 1]);
  return result.rows.map((row): Signal => ({ key: `mass-consent:${row.clientId}`, kind: 'mass-consent', severity: 'high',
    occurredAt: iso(row.lastAt), subject: { kind: 'client', id: row.clientId, name: row.name ?? row.clientId, email: null },
    evidence: { accounts: row.accounts, dailyAverage: Math.round(row.before / 7 * 10) / 10, firstAt: iso(row.firstAt),
      lastAt: iso(row.lastAt) } }));
}

const bySeverity = (left: Signal, right: Signal) => (left.severity === right.severity ? 0 : left.severity === 'high' ? -1 : 1)
  || right.occurredAt.localeCompare(left.occurredAt);

/** Open signals, severe and recent first: at most 25 shown, with a count per
 * kind capped at 200. `userId` narrows to one account (no App signals). */
export async function readSignals(db: Pool | PoolClient, options: { userId?: string; canManageClients: boolean }) {
  const userId = options.userId ?? null;
  const [failures, emails, passkeys, consents] = await Promise.all([failedSignIns(db, userId), emailAfterPassword(db, userId),
    newPasskeys(db, userId), options.canManageClients && !userId ? massConsent(db) : Promise.resolve([])]);
  const byKind = { 'failed-sign-ins': failures, 'email-after-password': emails, 'new-passkey': passkeys, 'mass-consent': consents };
  const counts = Object.fromEntries(signalKinds.map(kind => [kind, { count: Math.min(byKind[kind].length, candidateLimit),
    capped: byKind[kind].length > candidateLimit }])) as Record<SignalKind, { count: number; capped: boolean }>;
  const reviewed = await db.query<{ count: number }>(`SELECT count(*)::int AS count FROM (SELECT 1 FROM rezics_account_operator_audit
    WHERE action = 'signal_reviewed' AND occurred_at > now() - interval '24 hours' AND ($1::text IS NULL OR target_id = $1)
    LIMIT 1000) recent`, [userId]);
  return { items: [...failures, ...emails, ...passkeys, ...consents].sort(bySeverity).slice(0, shownLimit), counts,
    reviewedLastDay: reviewed.rows[0]!.count };
}

const digestOf = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

/** The subject a signal key names, checked against current data: a user or
 * App that exists, or a security event of the kind's action. */
async function signalSubject(db: PoolClient, kind: SignalKind, id: string): Promise<string> {
  if (kind === 'mass-consent') {
    if (!(await db.query('SELECT 1 FROM "oauthClient" WHERE "clientId" = $1', [id])).rowCount) throw new AccountProblem('not_found', 404);
    return id;
  }
  if (kind === 'failed-sign-ins') {
    if (!(await db.query('SELECT 1 FROM "user" WHERE id = $1', [id])).rowCount) throw new AccountProblem('not_found', 404);
    return id;
  }
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(id)) throw new AccountProblem('not_found', 404);
  const event = await db.query<{ userId: string }>(`SELECT user_id AS "userId" FROM rezics_account_security_event
    WHERE id = $1 AND action = $2`, [id, kind === 'new-passkey' ? 'passkey_added' : 'email_changed']);
  if (!event.rows[0]) throw new AccountProblem('not_found', 404);
  return event.rows[0].userId;
}

/** Marks a signal reviewed: one audit record on its subject, with the
 * operator's note as the reason. Replaying the command returns its answer. */
export async function reviewSignal(auth: AccountAuth, pool: Pool, request: Request,
  body: { key: string; note?: string; commandId: string }) {
  const [kind, ...rest] = body.key.split(':') as [SignalKind, ...string[]];
  const permission = signalPermissions[kind];
  if (!permission) throw new AccountProblem('invalid_request', 400);
  const actor = await requireOperator(auth, pool, request, permission);
  const note = body.note?.trim() || null;
  const digest = digestOf(['signal', body.key, note]);
  const db = await pool.connect();
  try {
    await db.query('BEGIN');
    await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`admin:${actor.userId}:${body.commandId}`]);
    await checkActor(db, actor, permission);
    const existing = await db.query<{ digest: string; response: { status: boolean; requestId: string } }>(
      'SELECT digest, response FROM rezics_account_operator_command WHERE actor_id = $1 AND command_id = $2', [actor.userId, body.commandId]);
    if (existing.rows[0]) {
      if (existing.rows[0].digest !== digest) throw new AccountProblem('conflict', 409);
      await db.query('COMMIT'); return existing.rows[0].response;
    }
    const subject = await signalSubject(db, kind, rest.join(':'));
    const requestId = randomUUID();
    await writeAudit(db, { actorId: actor.userId, action: 'signal_reviewed', targetId: subject, reason: note ?? 'Reviewed',
      before: null, after: { key: body.key, kind, noted: note !== null }, requestId });
    const response = { status: true, requestId };
    await db.query(`INSERT INTO rezics_account_operator_command (actor_id, command_id, digest, response)
      VALUES ($1, $2, $3, $4)`, [actor.userId, body.commandId, digest, JSON.stringify(response)]);
    await db.query('COMMIT'); return response;
  } catch (error) { await db.query('ROLLBACK'); throw error; }
  finally { db.release(); }
}
