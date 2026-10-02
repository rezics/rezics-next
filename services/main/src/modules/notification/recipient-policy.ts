import type { Pool, PoolClient } from 'pg';

/** User-wide Block and explicit Mute recheck, shared by inbox, push and digest.
 * Hide/Fewer are feed choices and never become notification preferences. */
export async function notificationRecipientAllowed(
  pool: Pool | PoolClient,
  principal: string,
  actor: string | null = null,
  realm: string | null = null,
  resource: string | null = null,
): Promise<boolean> {
  return !!(
    await pool.query(
      `SELECT 1 WHERE
    NOT EXISTS(SELECT 1 FROM access.person_block WHERE principal_id=$1 AND target_agent=$2)
    AND NOT EXISTS(SELECT 1 FROM access.interaction_mute_preference m WHERE m.principal_id=$1 AND m.muted
      AND (m.target_kind='agent' AND m.match='author' AND m.target=$2
        OR m.target_kind='realm' AND m.match IN ('publishing-realm','publication-context') AND m.target=$3
        OR m.target_kind='realm' AND m.match='author-membership' AND EXISTS(
          SELECT 1 FROM access.membership member WHERE member.kind='realm' AND member.state='joined'
            AND member.owner_subject=m.target AND member.member_subject=$2)))
    AND NOT EXISTS(SELECT 1 FROM access.home_exclusion e WHERE e.principal_id=$1 AND e.strength='mute'
      AND (e.kind='person' AND e.target=$2 OR e.kind='realm' AND e.target=$3 OR e.kind='work' AND e.target=$4))`,
      [principal, actor, realm, resource],
    )
  ).rowCount;
}
