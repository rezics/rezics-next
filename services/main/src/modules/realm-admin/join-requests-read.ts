import { createHash } from 'node:crypto';
import { t } from 'elysia';
import { Value } from 'typebox/value';
import { readUuid } from '../work/read-contract.ts';
import { RealmAdminInvalid, RealmAdminStale } from './contract.ts';

export const JOIN_REQUEST_READ_COST = { page: 50, search: 80, cursor: 512, searchBranches: 3 } as const;
export const joinRequestCursor = t.String({ minLength: 1, maxLength: JOIN_REQUEST_READ_COST.cursor });
const cursorPayload = t.Object({ after: readUuid, binding: t.String({ pattern: '^[0-9a-f]{64}$' }) },
  { additionalProperties: false });

export function requestSearch(q = ''): string {
  if (q.length > JOIN_REQUEST_READ_COST.search || /[\u0000-\u001f\u007f]/u.test(q)) {
    throw new RealmAdminInvalid('Invalid request search');
  }
  const search = q.trim().normalize('NFKC').replace(/^@/, '');
  if (search.length > JOIN_REQUEST_READ_COST.search) throw new RealmAdminInvalid('Invalid request search');
  return search;
}

export function requestCursorBinding(context: readonly unknown[]): string {
  return createHash('sha256').update(JSON.stringify(context)).digest('hex');
}

export function encodeRequestCursor(after: string, binding: string): string {
  return Buffer.from(JSON.stringify({ after, binding })).toString('base64url');
}

export function decodeRequestCursor(cursor: string, binding: string): string {
  if (!Value.Check(joinRequestCursor, cursor) || !/^[A-Za-z0-9_-]+$/.test(cursor)) {
    throw new RealmAdminInvalid('Invalid request cursor');
  }
  let payload: unknown;
  try { payload = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')); }
  catch { throw new RealmAdminInvalid('Invalid request cursor'); }
  if (!Value.Check(cursorPayload, payload)) throw new RealmAdminInvalid('Invalid request cursor');
  if (payload.binding !== binding) throw new RealmAdminStale('Request page context changed; restart from the first page');
  return payload.after;
}

/** Reuse the member roster's Unicode normalization and GIN candidate indexes.
 * Each source intersects the exact pending inbox before its page + 1 bound;
 * the union sorts at most 3 * (page + 1) identities, then hydrates one page.
 * GIN candidate rechecks cost O(matches), bounded by the transaction's SQL
 * deadline. strpos treats %, _ and backslash literally (no pattern language).
 * https://www.postgresql.org/docs/18/functions-matching.html (2026-10-02).
 * Native handles use the immutable Agent identity, with no Account name/link.
 */
export const JOIN_REQUEST_SEARCH_SQL = `WITH query AS MATERIALIZED (
  SELECT access.realm_member_search_key($3) AS text
), terms AS MATERIALIZED (
  SELECT text, access.realm_member_search_terms(text) AS tokens FROM query
), candidates AS (
  (SELECT pending.request_id AS id FROM access.agent_provision p
    JOIN access.authority_subject s ON s.id = p.agent_id AND s.active
    JOIN access.realm_join_request_pending pending ON pending.realm = $1 AND pending.member = p.agent_id
    CROSS JOIN terms q
    WHERE ($2::uuid IS NULL OR pending.request_id > $2) AND p.state = 'active'
      AND access.realm_member_search_terms(access.realm_member_search_key(p.display_name)) @> q.tokens
      AND strpos(access.realm_member_search_key(p.display_name), q.text) > 0
    ORDER BY pending.request_id LIMIT $4)
  UNION
  (SELECT pending.request_id AS id FROM access.agent_handle h
    JOIN access.authority_subject s ON s.id = h.agent_id AND s.active
    JOIN access.realm_join_request_pending pending ON pending.realm = $1 AND pending.member = h.agent_id
    CROSS JOIN terms q
    WHERE ($2::uuid IS NULL OR pending.request_id > $2) AND h.state = 'current'
      AND access.realm_member_search_terms(access.realm_member_search_key(h.handle)) @> q.tokens
      AND strpos(access.realm_member_search_key(h.handle), q.text) > 0
    ORDER BY pending.request_id LIMIT $4)
  UNION
  (SELECT pending.request_id AS id FROM access.realm_join_request_pending pending
    JOIN access.authority_subject s ON s.id = pending.member AND s.active
    WHERE pending.realm = $1 AND ($2::uuid IS NULL OR pending.request_id > $2)
      AND pending.member LIKE $5 || '%'
    ORDER BY pending.request_id LIMIT $4)
)
SELECT id FROM candidates ORDER BY id LIMIT $4`;
