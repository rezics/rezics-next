import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { AccountProblem } from './http.ts';
import { decodeCursor, encodeCursor } from './pagination.ts';
import { writeAudit } from './operators.ts';
import { sanctionActions } from './admin-actions.ts';
import { readSignals } from './admin-signals.ts';

export const auditOutcomes = ['attempted', 'succeeded', 'failed'] as const;
export const auditExportFormats = ['csv', 'jsonl'] as const;
/** `actorId` and `targetId` also take an account's email; `q` is text in the
 * reason or the message to the user; `requestId` finds one change. */
export interface AuditQuery { actorId?: string; targetId?: string; action?: string;
  outcome?: typeof auditOutcomes[number]; from?: string; to?: string; reasonCode?: string; requestId?: string; q?: string;
  limit?: number; cursor?: string }
interface AuditRow { id: string; actorId: string; targetId: string; action: string; reason: string;
  reasonCode: string | null; userMessage: string | null; before: unknown; after: unknown; requestId: string;
  outcome: string; occurredAt: Date; cursorKey: string; actorName: string | null; actorEmail: string | null;
  targetKind: 'user' | 'client' | 'other'; targetName: string | null; targetEmail: string | null }

// Actor and target are named from their current rows. A creation intent precedes
// the client ID: one bounded request-index probe resolves its completed target
// without rewriting the append-only history. Deleted clients keep their recorded name.
const auditSelect = `SELECT a.id, a.actor_id AS "actorId", coalesce(created.target_id, a.target_id) AS "targetId", a.action, a.reason,
  a.reason_code AS "reasonCode", a.user_message AS "userMessage", a.before_summary AS before, a.after_summary AS after,
  a.request_id AS "requestId", a.outcome, a.occurred_at AS "occurredAt", a.occurred_at::text AS "cursorKey",
  actor.name AS "actorName", actor.email AS "actorEmail",
  CASE WHEN target.id IS NOT NULL THEN 'user' WHEN client."clientId" IS NOT NULL OR created.target_id IS NOT NULL
    OR a.action IN ('/oauth2/create-client', '/admin/oauth2/create-client') THEN 'client' ELSE 'other' END AS "targetKind",
  coalesce(target.name, client.name, created.after_summary->>'name', a.after_summary->>'name') AS "targetName", target.email AS "targetEmail"
  FROM rezics_account_operator_audit a LEFT JOIN "user" actor ON actor.id = a.actor_id
  LEFT JOIN LATERAL (SELECT completed.target_id, completed.after_summary FROM rezics_account_operator_audit completed
    WHERE a.target_id = 'new-client' AND a.action IN ('/oauth2/create-client', '/admin/oauth2/create-client')
      AND completed.request_id = a.request_id AND completed.actor_id = a.actor_id AND completed.action = a.action
      AND completed.outcome = 'succeeded' AND completed.target_id <> 'new-client'
    ORDER BY completed.occurred_at DESC, completed.id DESC LIMIT 1) created ON true
  LEFT JOIN "user" target ON target.id = a.target_id
  LEFT JOIN "oauthClient" client ON client."clientId" = coalesce(created.target_id, a.target_id)`;
const entryView = ({ cursorKey: _key, ...row }: AuditRow) => ({ ...row, occurredAt: row.occurredAt.toISOString() });

// An email names the account it belongs to (one probe of the email index);
// anything else is an ID as recorded.
const byIdOrEmail = (column: string, parameter: string) => `(${parameter}::text IS NULL OR ${column} = ANY(ARRAY[${parameter},
  (SELECT u.id FROM "user" u WHERE strpos(${parameter}, '@') > 0 AND lower(u.email) = lower(${parameter}))]))`;

function auditFilter(query: AuditQuery, first = 1) {
  const text = query.q?.trim().toLowerCase() || null;
  const values = [query.actorId?.trim() || null, query.targetId?.trim() || null, query.action ?? null, query.outcome ?? null,
    query.from ?? null, query.to ?? null, query.reasonCode ?? null, query.requestId ?? null, text];
  const [actor, target, action, outcome, from, to, code, request, q] = values.map((_, index) => `$${first + index}`) as [string, ...string[]];
  return { values, text, where: `${byIdOrEmail('a.actor_id', actor)} AND ${byIdOrEmail('a.target_id', target!)}
    AND (${action}::text IS NULL OR a.action = ${action}) AND (${outcome}::text IS NULL OR a.outcome = ${outcome})
    AND (${from}::timestamptz IS NULL OR a.occurred_at >= ${from}) AND (${to}::timestamptz IS NULL OR a.occurred_at < ${to})
    AND (${code}::text IS NULL OR a.reason_code = ${code}) AND (${request}::uuid IS NULL OR a.request_id = ${request}::uuid)
    AND (${q}::text IS NULL OR strpos(lower(a.reason || ' ' || coalesce(a.user_message, '')), ${q}) > 0)` };
}

/** Free text has no index: it filters the period's rows under a statement
 * budget, like the directory's name search. */
async function auditRead<T extends object>(pool: Pool, budget: string, sql: string, values: unknown[]) {
  const db = await pool.connect();
  try {
    await db.query('BEGIN READ ONLY');
    await db.query(`SET LOCAL statement_timeout = '${budget}'`);
    return await db.query<T & AuditRow>(sql, values);
  } finally { try { await db.query('ROLLBACK'); } finally { db.release(); } }
}

/** Newest first by the audit page index (or the actor, target, action,
 * reason code, request or unsuccessful-outcome index when that filter is
 * set); seek-paginated; two seconds at most. */
export async function readAudit(pool: Pool, secret: string, actorId: string, query: AuditQuery) {
  if (query.from && query.to && query.from > query.to) throw new AccountProblem('invalid_request', 400);
  const scope = `audit:${actorId}:${JSON.stringify([query.actorId, query.targetId, query.action, query.from, query.to,
    ...(query.outcome ? [query.outcome] : []), ...(query.reasonCode || query.requestId || query.q
      ? [query.reasonCode, query.requestId, query.q] : [])])}`;
  const cursor = decodeCursor(secret, scope, query.cursor);
  const limit = query.limit ?? 25;
  const filter = auditFilter(query);
  const result = await auditRead<object>(pool, '2s', `${auditSelect} WHERE ${filter.where}
    AND ($10::timestamptz IS NULL OR (a.occurred_at, a.id) < ($10, $11::uuid))
    ORDER BY a.occurred_at DESC, a.id DESC LIMIT $12`, [...filter.values, cursor?.key ?? null, cursor?.id ?? null, limit + 1]);
  const rows = result.rows.slice(0, limit); const last = rows.at(-1);
  return { items: rows.map(entryView),
    nextCursor: result.rows.length > limit && last ? encodeCursor(secret, scope, last.cursorKey, last.id) : null };
}

/** A user's sanction history: succeeded suspensions, lifts, resets and
 * sign-outs, readable by every operator who can read the user. */
export async function readSanctions(pool: Pool, secret: string, userId: string, query: { limit?: number; cursor?: string }) {
  const scope = `sanctions:${userId}`;
  const cursor = decodeCursor(secret, scope, query.cursor);
  const limit = query.limit ?? 25;
  const result = await pool.query<AuditRow>(`${auditSelect} WHERE a.target_id = $1 AND a.action = ANY($2::text[])
    AND a.outcome = 'succeeded' AND ($3::timestamptz IS NULL OR (a.occurred_at, a.id) < ($3, $4::uuid))
    ORDER BY a.occurred_at DESC, a.id DESC LIMIT $5`, [userId, sanctionActions, cursor?.key ?? null, cursor?.id ?? null, limit + 1]);
  const rows = result.rows.slice(0, limit); const last = rows.at(-1);
  return { items: rows.map(entryView),
    nextCursor: result.rows.length > limit && last ? encodeCursor(secret, scope, last.cursorKey, last.id) : null };
}

export const auditExportLimit = 10_000;
const csvColumns = ['occurred_at', 'action', 'outcome', 'actor_id', 'actor_email', 'target_kind', 'target_id',
  'target_name', 'target_email', 'reason_code', 'reason', 'user_message', 'request_id'] as const;
/** RFC 4180 quoting; a leading formula character is neutralized so a
 * spreadsheet never evaluates operator- or user-supplied text. */
export function csvCell(value: string | null): string {
  const text = value ?? '';
  const safe = /^[=+\-@\t\r]/.test(text) ? `'${text}` : text;
  return `"${safe.replaceAll('"', '""')}"`;
}

/** The filtered log, newest first, at most `auditExportLimit` rows: CSV for
 * spreadsheets, or JSON Lines with each record's before and after for
 * machines. Exporting is itself recorded, with its filters and row count. */
export async function exportAudit(pool: Pool, actorId: string, query: AuditQuery,
  format: typeof auditExportFormats[number] = 'csv') {
  if (query.from && query.to && query.from > query.to) throw new AccountProblem('invalid_request', 400);
  const filter = auditFilter(query);
  const result = await auditRead<object>(pool, '10s', `${auditSelect} WHERE ${filter.where}
    ORDER BY a.occurred_at DESC, a.id DESC LIMIT $10`, [...filter.values, auditExportLimit + 1]);
  const rows = result.rows.slice(0, auditExportLimit);
  const truncated = result.rows.length > auditExportLimit;
  await writeAudit(pool, { actorId, action: 'audit_exported', targetId: 'audit', reason: 'Audit log export',
    before: null, after: { format, filters: { actorId: query.actorId ?? null, targetId: query.targetId ?? null, action: query.action ?? null,
      outcome: query.outcome ?? null, from: query.from ?? null, to: query.to ?? null, reasonCode: query.reasonCode ?? null,
      requestId: query.requestId ?? null, q: filter.text }, rows: rows.length, truncated },
    requestId: randomUUID() });
  if (format === 'jsonl') {
    const body = rows.map(row => JSON.stringify(entryView(row))).join('\n');
    return { body: rows.length ? `${body}\n` : '', rows: rows.length, truncated };
  }
  const lines = [csvColumns.join(','), ...rows.map(row => [row.occurredAt.toISOString(), row.action, row.outcome, row.actorId,
    row.actorEmail, row.targetKind, row.targetId, row.targetName, row.targetEmail, row.reasonCode, row.reason, row.userMessage,
    row.requestId].map(csvCell).join(','))];
  // The byte-order mark lets spreadsheet software read CJK names as UTF-8.
  return { body: `\ufeff${lines.join('\r\n')}\r\n`, rows: rows.length, truncated };
}



const queueCap = 1000;
interface QueueRow { id: string; name: string; email: string; since: Date; until: Date | null; reasonCode: string | null }
const queueView = (row: QueueRow) => ({ ...row, since: row.since.toISOString(), until: row.until?.toISOString() ?? null });
const capped = (count: number) => ({ count: Math.min(count, queueCap), capped: count > queueCap });
const active = `s.suspended_at IS NOT NULL AND (s.suspended_until IS NULL OR s.suspended_until > now())`;

/** What needs an operator now (risk signals, see `readSignals`), then work
 * queues, not charts: each a count capped at 1000 by a partial index plus the
 * five users to look at first. */
export async function readOverview(pool: Pool, actorId: string, access: { canReadAudit: boolean; canManageClients: boolean }) {
  const count = async (sql: string) => (await pool.query<{ count: number }>(
    `SELECT count(*)::int AS count FROM (${sql} LIMIT ${queueCap + 1}) queue`)).rows[0]!.count;
  const users = async (sql: string, values: unknown[] = []) => (await pool.query<QueueRow>(sql, values)).rows.map(queueView);
  const { canReadAudit } = access;
  const [signals, suspended, suspendedUsers, resets, resetUsers, unverified, unverifiedUsers, recent, jobs] = await Promise.all([
    readSignals(pool, { canManageClients: access.canManageClients }),
    count(`SELECT 1 FROM rezics_account_security s WHERE ${active}`),
    // Expiring suspensions first: they are the ones about to change on their own.
    users(`SELECT u.id, u.name, u.email, s.suspended_at AS since, s.suspended_until AS until, s.suspension_code AS "reasonCode"
      FROM rezics_account_security s JOIN "user" u ON u.id = s.user_id WHERE ${active}
      ORDER BY s.suspended_until NULLS LAST, s.user_id LIMIT 5`),
    count('SELECT 1 FROM rezics_account_security s WHERE s.password_reset_required'),
    users(`SELECT u.id, u.name, u.email, coalesce(required.occurred_at, u."updatedAt") AS since, NULL::timestamptz AS until,
        required.reason_code AS "reasonCode"
      FROM rezics_account_security s JOIN "user" u ON u.id = s.user_id
      LEFT JOIN LATERAL (SELECT a.occurred_at, a.reason_code FROM rezics_account_operator_audit a WHERE a.target_id = s.user_id
        AND a.action = 'require-password-reset' AND a.outcome = 'succeeded' ORDER BY a.occurred_at DESC LIMIT 1) required ON true
      WHERE s.password_reset_required ORDER BY s.user_id LIMIT 5`),
    count('SELECT 1 FROM "user" u WHERE NOT u."emailVerified"'),
    users(`SELECT u.id, u.name, u.email, u."createdAt" AS since, NULL::timestamptz AS until, NULL AS "reasonCode"
      FROM "user" u WHERE NOT u."emailVerified" ORDER BY u."createdAt" DESC, u.id LIMIT 5`),
    canReadAudit ? pool.query<AuditRow>(`${auditSelect} ORDER BY a.occurred_at DESC, a.id DESC LIMIT 8`) : null,
    readJobs(pool, actorId, 5),
  ]);
  return {
    signals,
    suspended: { ...capped(suspended), users: suspendedUsers },
    passwordResetRequired: { ...capped(resets), users: resetUsers },
    unverified: { ...capped(unverified), users: unverifiedUsers },
    recentActions: recent ? recent.rows.map(entryView) : null, jobs,
  };
}

interface JobRow { id: string; action: string; reasonCode: string; reason: string; actorId: string; total: number;
  pending: number; succeeded: number; skipped: number; failed: number; cancelled: number; createdAt: Date;
  startsAt: Date | null; finishedAt: Date | null; cancelledAt: Date | null }
const jobFields = `j.id, j.action, j.reason_code AS "reasonCode", j.reason, j.actor_id AS "actorId",
  j.created_at AS "createdAt", j.starts_at AS "startsAt", j.finished_at AS "finishedAt", j.cancelled_at AS "cancelledAt", counts.*`;
const jobCounts = `LEFT JOIN LATERAL (SELECT count(*)::int AS total, count(*) FILTER (WHERE i.state = 'pending')::int AS pending,
  count(*) FILTER (WHERE i.state = 'succeeded')::int AS succeeded, count(*) FILTER (WHERE i.state = 'skipped')::int AS skipped,
  count(*) FILTER (WHERE i.state = 'failed')::int AS failed, count(*) FILTER (WHERE i.state = 'cancelled')::int AS cancelled
  FROM rezics_account_operator_job_item i WHERE i.job_id = j.id) counts ON true`;
const jobSummary = ({ reason: _reason, actorId: _actor, ...row }: JobRow) => ({ ...row,
  createdAt: row.createdAt.toISOString(), startsAt: (row.startsAt ?? row.createdAt).toISOString(),
  finishedAt: row.finishedAt?.toISOString() ?? null, cancelledAt: row.cancelledAt?.toISOString() ?? null });

/** The operator's own most recent bulk actions (each at most 100 items). */
export async function readJobs(pool: Pool, actorId: string, limit: number) {
  const result = await pool.query<JobRow>(`SELECT ${jobFields} FROM rezics_account_operator_job j ${jobCounts}
    WHERE j.actor_id = $1 ORDER BY j.created_at DESC, j.id DESC LIMIT $2`, [actorId, limit]);
  return result.rows.map(jobSummary);
}

/** A job and each user's result. Only its actor, or an operator who reads the
 * audit log, can see it; anyone else is told it does not exist. */
export async function readJob(pool: Pool, jobId: string, reader: { userId: string; canReadAudit: boolean }) {
  const job = await pool.query<JobRow>(`SELECT ${jobFields} FROM rezics_account_operator_job j ${jobCounts} WHERE j.id = $1`, [jobId]);
  const row = job.rows[0];
  if (!row || (row.actorId !== reader.userId && !reader.canReadAudit)) throw new AccountProblem('not_found', 404);
  const items = await pool.query<{ userId: string; name: string | null; email: string | null;
    state: 'pending' | 'succeeded' | 'skipped' | 'failed' | 'cancelled';
    error: string | null; requestId: string | null }>(`SELECT i.user_id AS "userId", u.name, u.email, i.state, i.error,
    i.request_id AS "requestId" FROM rezics_account_operator_job_item i LEFT JOIN "user" u ON u.id = i.user_id
    WHERE i.job_id = $1 ORDER BY i.position`, [jobId]);
  return { ...jobSummary(row), reason: row.reason, actorId: row.actorId, items: items.rows };
}
