import type { PoolClient } from 'pg';

/** Two membership point probes plus two ban probes. A stable identity and
 * generation pin prevents leave/rejoin from reviving an old admission. */
export async function realmMemberProof(client: PoolClient, realm: string,
  principal: string, actor: string): Promise<string | null> {
  const bans = await client.query(`SELECT 1 FROM access.private_membership_ban
    WHERE kind = 'realm' AND owner_subject = $1 AND principal_id = $2 AND active
    UNION ALL SELECT 1 FROM access.membership_ban
    WHERE kind = 'realm' AND owner_subject = $1 AND member_subject = $3 AND active
      AND (expires_at IS NULL OR expires_at > clock_timestamp()) LIMIT 1`,
  [realm, principal, actor]);
  if (bans.rowCount) return null;
  const privateMember = (await client.query<{ id: string; generation: string }>(`
    SELECT id, generation FROM access.private_membership
    WHERE kind = 'realm' AND owner_subject = $1 AND principal_id = $2 AND state = 'joined' FOR SHARE`,
  [realm, principal])).rows[0];
  if (privateMember) return `private:${privateMember.id}:${privateMember.generation}`;
  const member = (await client.query<{ id: string; generation: string }>(`
    SELECT id, generation FROM access.membership
    WHERE kind = 'realm' AND owner_subject = $1 AND member_subject = $2 AND state = 'joined' FOR SHARE`,
  [realm, actor])).rows[0];
  return member ? `agent:${member.id}:${member.generation}` : null;
}

/** The Realm creator's live owner mandate is an approved participation episode.
 * Public Agent and private account memberships remain distinct below it. */
export async function realmApprovedProof(client: PoolClient, realm: string,
  principal: string, actor: string): Promise<string | null> {
  const member = await realmMemberProof(client, realm, principal, actor);
  if (member) return member;
  const banned = await client.query(`SELECT 1 FROM access.membership_ban WHERE kind = 'realm'
    AND owner_subject = $1 AND member_subject = $2 AND active
      AND (expires_at IS NULL OR expires_at > clock_timestamp())
    UNION ALL SELECT 1 FROM access.private_membership_ban WHERE kind = 'realm'
      AND owner_subject = $1 AND principal_id = $3 AND active LIMIT 1`, [realm, actor, principal]);
  if (banned.rowCount) return null;
  const owner = (await client.query(`SELECT id,generation::text FROM access.permission_grant
    WHERE scope_id = $1 AND recipient_subject = $2 AND action = 'realm.owner'
      AND active AND valid_until > clock_timestamp() AND membership_id IS NULL
    ORDER BY id LIMIT 1 FOR SHARE`, [`governance:realm:${realm}`, actor])).rows[0];
  return owner ? `owner:${owner.id}:${owner.generation}` : null;
}
