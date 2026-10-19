import type { Pool, PoolClient } from 'pg';
import { notificationReadStep } from './request-budget.ts';

export interface NotificationRecipient {
  principal: string;
  actor?: string | null;
  realm?: string | null;
  resource?: string | null;
}

/** The same current policy for one page, preserving every recipient/target pair.
 * Call again at disclosure; no block or mute evidence survives the read. */
export async function notificationRecipientsAllowed(pool: Pool | PoolClient,
  recipients: readonly NotificationRecipient[]): Promise<boolean[]> {
  if (recipients.length > 256) throw new Error('Notification recipient batch exceeds its bound');
  if (!recipients.length) return [];
  const result = await notificationReadStep(() => pool.query<{ ordinal: string; allowed: boolean }>(`
    SELECT c.ordinal::text, (
      NOT EXISTS(SELECT 1 FROM access.person_block WHERE principal_id=c.principal AND target_agent=c.actor)
      AND NOT EXISTS(SELECT 1 FROM access.interaction_mute_preference m WHERE m.principal_id=c.principal AND m.muted
        AND (m.target_kind='agent' AND m.match='author' AND m.target=c.actor
          OR m.target_kind='realm' AND m.match IN ('publishing-realm','publication-context') AND m.target=c.realm
          OR m.target_kind='realm' AND m.match='author-membership' AND EXISTS(
            SELECT 1 FROM access.membership member WHERE member.kind='realm' AND member.state='joined'
              AND member.owner_subject=m.target AND member.member_subject=c.actor)))
      AND NOT EXISTS(SELECT 1 FROM access.home_exclusion e WHERE e.principal_id=c.principal AND e.strength='mute'
        AND (e.kind='person' AND e.target=c.actor OR e.kind='realm' AND e.target=c.realm
          OR e.kind='work' AND e.target=c.resource))
    ) AS allowed FROM unnest($1::uuid[],$2::text[],$3::text[],$4::text[]) WITH ORDINALITY
      AS c(principal,actor,realm,resource,ordinal)`, [recipients.map(input => input.principal),
    recipients.map(input => input.actor ?? null), recipients.map(input => input.realm ?? null),
    recipients.map(input => input.resource ?? null)]));
  const allowed = recipients.map(() => false);
  for (const row of result.rows) {
    const index = Number(row.ordinal) - 1;
    if (Number.isInteger(index) && index >= 0 && index < allowed.length) allowed[index] = row.allowed === true;
  }
  return allowed;
}

/** User-wide Block and explicit Mute recheck, shared by inbox, push and digest.
 * Hide/Fewer are feed choices and never become notification preferences. */
export async function notificationRecipientAllowed(
  pool: Pool | PoolClient,
  principal: string,
  actor: string | null = null,
  realm: string | null = null,
  resource: string | null = null,
): Promise<boolean> {
  return (await notificationRecipientsAllowed(pool, [{ principal, actor, realm, resource }]))[0]!;
}
