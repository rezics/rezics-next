import type { PoolClient } from 'pg';
import { REALM_ADMIN_COST, RealmAdminInvalid } from '../realm-admin/contract.ts';

/** Each branch seeks an indexed name/handle candidate relation, intersects the
 * exact Realm's public Agent roster, then retains at most page + 1 identities.
 * The final union sorts at most 4 * (page + 1) rows. GIN rechecks cost O(matches),
 * capped by the surrounding management transaction's five-second SQL deadline.
 * No private principal membership or Account name is a search source.
 * Provision display names are immutable; handles are read from their live owner,
 * so handle retirement and failed/compensated provisioning need no index repair. */
export const REALM_MEMBER_SEARCH_SQL = `WITH query AS MATERIALIZED (
  SELECT access.realm_member_search_key($3) AS text
), terms AS MATERIALIZED (
  SELECT text, access.realm_member_search_terms(text) AS tokens FROM query
), candidates AS (
  (SELECT p.agent_id AS member
    FROM access.agent_provision p
    JOIN access.authority_subject s ON s.id = p.agent_id AND s.active
    CROSS JOIN terms q
    WHERE p.agent_id > $2 AND (EXISTS (SELECT 1 FROM access.membership m
      WHERE m.kind = 'realm' AND m.owner_subject = $1 AND m.member_subject = p.agent_id)
      OR EXISTS (SELECT 1 FROM access.realm_admin_assignment a
        WHERE a.realm = $1 AND a.member = p.agent_id AND a.valid_until > clock_timestamp()))
      AND p.state = 'active'
      AND access.realm_member_search_terms(access.realm_member_search_key(p.display_name)) @> q.tokens
      AND strpos(access.realm_member_search_key(p.display_name), q.text) > 0
    ORDER BY p.agent_id LIMIT $4)
  UNION
  (SELECT h.agent_id AS member
    FROM access.agent_handle h
    JOIN access.authority_subject s ON s.id = h.agent_id AND s.active
    CROSS JOIN terms q
    WHERE h.agent_id > $2 AND (EXISTS (SELECT 1 FROM access.membership m
      WHERE m.kind = 'realm' AND m.owner_subject = $1 AND m.member_subject = h.agent_id)
      OR EXISTS (SELECT 1 FROM access.realm_admin_assignment a
        WHERE a.realm = $1 AND a.member = h.agent_id AND a.valid_until > clock_timestamp()))
      AND h.state = 'current'
      AND access.realm_member_search_terms(access.realm_member_search_key(h.handle)) @> q.tokens
      AND strpos(access.realm_member_search_key(h.handle), q.text) > 0
    ORDER BY h.agent_id LIMIT $4)
  UNION
  (SELECT m.member_subject AS member FROM access.membership m
    WHERE m.kind = 'realm' AND m.owner_subject = $1 AND m.member_subject > $2
      AND m.member_subject LIKE $5 || '%'
    ORDER BY m.member_subject LIMIT $4)
  UNION
  (SELECT DISTINCT a.member FROM access.realm_admin_assignment a
    WHERE a.realm = $1 AND a.valid_until > clock_timestamp() AND a.member > $2
      AND a.member LIKE $5 || '%'
    ORDER BY a.member LIMIT $4)
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
