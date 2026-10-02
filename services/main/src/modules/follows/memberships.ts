import type { Pool } from 'pg';
import type { VerifiedPrincipal } from '../access/admission.ts';
import { controlRead, ControlInvalid } from '../access/topology-control.ts';
import { followPrincipal } from './authority.ts';
import type { FollowLevel, FollowSource } from './contract.ts';

export interface JoinedSpace {
  membership_id: string;
  generation: string;
  realm: string;
  member: string;
  space: string | null;
  following: boolean;
  level: FollowLevel | null;
  source: FollowSource | null;
  pin_position: number | null;
  order_key: string;
}
/** One current person inventory, a SQL membership-generation fence (O(N)),
 * and P+1 output rows. No roster identities or private Realm names are stored. */
export async function joinedSpaces(
  pool: Pool,
  principal: VerifiedPrincipal,
  agent: string,
  after: string | null,
  order: 'recent' | 'pinned',
  limit: number,
) {
  let seek: { key: string; realm: string } | null = null;
  if (after) {
    try {
      seek = JSON.parse(after) as { key: string; realm: string };
    } catch {
      throw new ControlInvalid('Invalid membership cursor');
    }
    if (!seek || typeof seek.key !== 'string' || typeof seek.realm !== 'string')
      throw new ControlInvalid('Invalid membership cursor');
  }
  return controlRead(pool, async (client) => {
    const owner = await followPrincipal(client, principal, agent);
    const inventory = `WITH episodes AS (
      SELECT id AS membership_id,generation,owner_subject AS realm,member_subject AS member,changed_at
        FROM access.membership WHERE kind='realm' AND member_subject=$2 AND state='joined'
      UNION ALL SELECT id,generation,owner_subject,$2,changed_at FROM access.private_membership
        WHERE kind='realm' AND principal_id=$1 AND state='joined'
    ), joined AS (SELECT DISTINCT ON(realm) * FROM episodes ORDER BY realm,changed_at DESC,membership_id)`;
    const revision = (
      await client.query<{ revision: string }>(
        `${inventory} SELECT md5(COALESCE(string_agg(
      membership_id::text || ':' || generation::text,',' ORDER BY realm),'')) || ':' || COALESCE(
        (SELECT revision::text FROM access.follow_inventory WHERE principal_id=$1),'none') || ':' ||
        (SELECT revision::text FROM access.follow_activity_head WHERE id) AS revision FROM joined`,
        [owner, agent],
      )
    ).rows[0]!.revision;
    const expression =
      order === 'pinned'
        ? 'COALESCE(f.pin_position,10000)'
        : '-extract(epoch FROM COALESCE(activity.activity_at,m.changed_at))';
    const rows = (
      await client.query<JoinedSpace>(
        `${inventory} SELECT m.membership_id,m.generation::text,m.realm,m.member,
      s.space,COALESCE(f.following,false) AS following,f.level,f.source,f.pin_position,(${expression})::text AS order_key
      FROM joined m LEFT JOIN access.follow_space_alias s ON s.alias=m.realm
      LEFT JOIN access.follow f ON f.principal_id=$1 AND f.target=s.space
      LEFT JOIN LATERAL (SELECT max(activity_at) AS activity_at FROM access.follow_activity
        WHERE target=s.space OR target IN (SELECT alias FROM access.follow_space_alias WHERE space=s.space)) activity ON true
      WHERE ($3::numeric IS NULL OR (${expression},m.realm)>($3::numeric,$4::text))
      ORDER BY ${expression},m.realm LIMIT $5`,
        [owner, agent, seek?.key ?? null, seek?.realm ?? null, limit + 1],
      )
    ).rows;
    return { owner, revision, rows };
  });
}
