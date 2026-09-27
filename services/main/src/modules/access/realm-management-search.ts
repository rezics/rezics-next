import type { PoolClient } from 'pg';
import { REALM_ADMIN_COST, RealmAdminInvalid } from '../realm-admin/contract.ts';

/** Each branch seeks an indexed name/handle candidate relation, intersects the
 * exact Realm's public Agent roster, then retains at most page + 1 identities.
 * The final union sorts at most 3 * (page + 1) rows. GIN rechecks cost O(matches),
 * capped by the surrounding management transaction's five-second SQL deadline.
 * No private principal membership or Account name is a search source.
 * Provision display names are immutable; handles are read from their live owner,
 * so handle retirement and failed/compensated provisioning need no index repair. */
export const REALM_MEMBER_SEARCH_SQL = `WITH query AS MATERIALIZED (
  SELECT access.realm_member_search_key($3) AS text
), terms AS MATERIALIZED (
  SELECT text, access.realm_member_search_terms(text) AS tokens FROM query
), candidates AS (
  (SELECT m.member_subject AS member
    FROM access.agent_provision p JOIN access.membership m ON m.member_subject = p.agent_id
    JOIN access.authority_subject s ON s.id = m.member_subject AND s.active
    CROSS JOIN terms q
    WHERE m.kind = 'realm' AND m.owner_subject = $1 AND m.member_subject > $2
      AND p.state = 'active'
      AND access.realm_member_search_terms(access.realm_member_search_key(p.display_name)) @> q.tokens
      AND strpos(access.realm_member_search_key(p.display_name), q.text) > 0
    ORDER BY m.member_subject LIMIT $4)
  UNION
  (SELECT m.member_subject AS member
    FROM access.agent_handle h JOIN access.membership m ON m.member_subject = h.agent_id
    JOIN access.authority_subject s ON s.id = m.member_subject AND s.active
    CROSS JOIN terms q
    WHERE m.kind = 'realm' AND m.owner_subject = $1 AND m.member_subject > $2
      AND h.state = 'current'
      AND access.realm_member_search_terms(access.realm_member_search_key(h.handle)) @> q.tokens
      AND strpos(access.realm_member_search_key(h.handle), q.text) > 0
    ORDER BY m.member_subject LIMIT $4)
  UNION
  (SELECT m.member_subject AS member FROM access.membership m
    WHERE m.kind = 'realm' AND m.owner_subject = $1 AND m.member_subject > $2
      AND m.member_subject LIKE $5 || '%'
    ORDER BY m.member_subject LIMIT $4)
)
SELECT member FROM candidates ORDER BY member LIMIT $4`;

export async function searchRealmMembers(client: PoolClient, realm: string, search: string,
  after: string | undefined, limit: number): Promise<string[]> {
  const query = search.trim().normalize('NFKC').replace(/^@/, '');
  if (!query || query.length > 80 || /[\u0000-\u001f\u007f]/u.test(query)
    || !Number.isInteger(limit) || limit < 1 || limit > REALM_ADMIN_COST.page + 1) {
    throw new RealmAdminInvalid('Invalid member search');
  }
  const native = query.startsWith('agent-') ? `https://rezics.com/id/${query.slice(6)}` : query;
  const rows = await client.query<{ member: string }>(REALM_MEMBER_SEARCH_SQL,
    [realm, after ?? '', query, limit, native.replace(/[\\%_]/g, '\\$&')]);
  return rows.rows.map(row => row.member);
}
