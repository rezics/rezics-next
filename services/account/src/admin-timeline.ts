import type { Pool } from 'pg';
import { decodeCursor, encodeCursor } from './pagination.ts';
import { sanctionActions } from './admin-actions.ts';

// One account's story, newest first: its security log, staff actions on it
// and staff notes, merged by time. Staff actions come from the audit record
// (who, why, message); the matching `admin_action` log line is left out. An
// operator without the audit log sees sanctions, reviews and notes in full
// and other staff actions only as the log line the user sees too.

export const timelineCategories = ['all', 'sign-ins', 'credentials', 'apps', 'staff'] as const;
export type TimelineCategory = typeof timelineCategories[number];
const securityActions: Record<Exclude<TimelineCategory, 'all' | 'staff'>, readonly string[]> = {
  'sign-ins': ['sign_in', 'sign_in_failed', 'sign_out', 'session_revoked'],
  credentials: ['password_added', 'password_changed', 'password_removed', 'passkey_added', 'passkey_removed', 'passkey_renamed',
    'totp_added', 'totp_removed', 'totp_renamed', 'backup_codes_changed', 'email_changed'],
  apps: ['consent_granted', 'consent_revoked', 'app_revoked'],
};
/** Staff actions every operator who reads users may see with their details. */
const openStaffActions = [...sanctionActions, 'signal_reviewed'];

interface TimelineRow { id: string; source: 'security' | 'staff' | 'note'; action: string; detail: Record<string, unknown>;
  occurredAt: Date; cursorKey: string;
  staff: { actorId: string; actorName: string | null; actorEmail: string | null; reason: string; reasonCode: string | null;
    userMessage: string | null; outcome: string; requestId: string; before: unknown; after: unknown } | null;
  note: { body: string; authorId: string; authorName: string | null; authorEmail: string | null } | null }

/** Four seek branches, each an index range of at most `limit + 1` rows (the
 * account's security page index, the audit target index, the note index),
 * merged and cut to one page. A security category filters that account's
 * page index, so a rare category reads further back in its one log. */
export async function readTimeline(pool: Pool, secret: string, userId: string,
  query: { category?: TimelineCategory; limit?: number; cursor?: string }, canReadAudit: boolean) {
  const category = query.category ?? 'all';
  const scope = `timeline:${userId}:${category}:${canReadAudit}`;
  const cursor = decodeCursor(secret, scope, query.cursor);
  const limit = query.limit ?? 25;
  const security = category === 'staff' ? null : category === 'all' ? null : securityActions[category];
  const withSecurity = category !== 'staff';
  const withStaff = category === 'all' || category === 'staff';
  const page = (time: string, id: string) => `($3::timestamptz IS NULL OR (${time}, ${id}) < ($3, $4::uuid))`;
  const result = await pool.query<TimelineRow>(`SELECT * FROM (
    (SELECT e.id::text, 'security' AS source, e.action, e.detail, e.occurred_at AS "occurredAt", e.occurred_at::text AS "cursorKey",
        NULL::jsonb AS staff, NULL::jsonb AS note
      FROM rezics_account_security_event e WHERE $5 AND e.user_id = $1 AND e.action <> 'admin_action'
        AND ($6::text[] IS NULL OR e.action = ANY($6)) AND ${page('e.occurred_at', 'e.id')}
      ORDER BY e.occurred_at DESC, e.id DESC LIMIT $2)
    UNION ALL
    (SELECT e.id::text, 'security', e.action, e.detail, e.occurred_at, e.occurred_at::text, NULL, NULL
      FROM rezics_account_security_event e WHERE $7 AND NOT $9 AND e.user_id = $1 AND e.action = 'admin_action'
        AND NOT (e.detail->>'action' = ANY($8::text[]) OR e.detail->>'action' = 'add-note') AND ${page('e.occurred_at', 'e.id')}
      ORDER BY e.occurred_at DESC, e.id DESC LIMIT $2)
    UNION ALL
    (SELECT a.id::text, 'staff', a.action, '{}'::jsonb, a.occurred_at, a.occurred_at::text,
        jsonb_build_object('actorId', a.actor_id, 'actorName', actor.name, 'actorEmail', actor.email, 'reason', a.reason,
          'reasonCode', a.reason_code, 'userMessage', a.user_message, 'outcome', a.outcome, 'requestId', a.request_id,
          'before', a.before_summary, 'after', a.after_summary), NULL
      FROM rezics_account_operator_audit a LEFT JOIN "user" actor ON actor.id = a.actor_id
      WHERE $7 AND a.target_id = $1 AND a.action <> 'add-note' AND ($9 OR a.action = ANY($8::text[]))
        AND ${page('a.occurred_at', 'a.id')}
      ORDER BY a.occurred_at DESC, a.id DESC LIMIT $2)
    UNION ALL
    (SELECT n.id::text, 'note', 'note', '{}'::jsonb, n.created_at, n.created_at::text, NULL,
        jsonb_build_object('body', n.body, 'authorId', n.author_id, 'authorName', author.name, 'authorEmail', author.email)
      FROM rezics_account_operator_note n LEFT JOIN "user" author ON author.id = n.author_id
      WHERE $7 AND n.user_id = $1 AND ${page('n.created_at', 'n.id')}
      ORDER BY n.created_at DESC, n.id DESC LIMIT $2)
  ) story ORDER BY "occurredAt" DESC, id DESC LIMIT $2`,
  [userId, limit + 1, cursor?.key ?? null, cursor?.id ?? null, withSecurity, security, withStaff, openStaffActions, canReadAudit]);
  const rows = result.rows.slice(0, limit);
  const last = rows.at(-1);
  return { items: rows.map(({ cursorKey: _key, ...row }) => ({ ...row, occurredAt: row.occurredAt.toISOString() })),
    nextCursor: result.rows.length > limit && last ? encodeCursor(secret, scope, last.cursorKey, last.id) : null };
}
