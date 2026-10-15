import type { PoolClient } from 'pg';
import { representedGrantProof } from '../access/composition.ts';

/** One round trip retains the same indexed probes and membership row locks.
 * Report bans separately: absence of membership must not let a banned owner
 * fall through to a mandate, or require another round trip to distinguish it. */
async function realmParticipationProof(client: PoolClient, realm: string,
  principal: string, actor: string): Promise<{ banned: boolean; membership: string | null }> {
  const row = (await client.query<{ banned: boolean; membership: string | null }>(`WITH
    bans AS MATERIALIZED (SELECT EXISTS(SELECT 1 FROM access.private_membership_ban
      WHERE kind='realm' AND owner_subject=$1 AND principal_id=$2 AND active
      UNION ALL SELECT 1 FROM access.membership_ban
      WHERE kind='realm' AND owner_subject=$1 AND member_subject=$3 AND active
        AND (expires_at IS NULL OR expires_at>clock_timestamp())) AS banned),
    private_member AS MATERIALIZED (SELECT id,generation FROM access.private_membership
      WHERE kind='realm' AND owner_subject=$1 AND principal_id=$2 AND state='joined' FOR SHARE),
    agent_member AS MATERIALIZED (SELECT id,generation FROM access.membership
      WHERE kind='realm' AND owner_subject=$1 AND member_subject=$3 AND state='joined' FOR SHARE)
    SELECT banned,CASE WHEN banned THEN NULL ELSE COALESCE(
      (SELECT 'private:'||id||':'||generation FROM private_member),
      (SELECT 'agent:'||id||':'||generation FROM agent_member)) END AS membership FROM bans`,
  [realm, principal, actor])).rows[0];
  if (!row) throw new Error('Realm participation proof is unavailable');
  return row;
}

/** A stable identity and generation pin prevents leave/rejoin from reviving an old admission. */
export async function realmMemberProof(client: PoolClient, realm: string,
  principal: string, actor: string): Promise<string | null> {
  return (await realmParticipationProof(client, realm, principal, actor)).membership;
}

/** The Realm creator's live owner mandate is an approved participation episode.
 * Public Agent and private account memberships remain distinct below it. */
export async function realmApprovedProof(client: PoolClient, realm: string,
  principal: string, actor: string): Promise<string | null> {
  const participation = await realmParticipationProof(client, realm, principal, actor);
  if (participation.banned) return null;
  if (participation.membership) return participation.membership;
  const owner = await representedGrantProof(client, principal, actor,
    `governance:realm:${realm}`, 'realm.owner', { lock: true, directOnly: true });
  // Keep the source prefix used by admission witnesses and pin the full owner
  // branch so a different or changed mandate cannot revive a saved episode.
  return owner ? `owner:${owner.grantId}:${owner.grantGeneration}:${JSON.stringify(owner)}` : null;
}
