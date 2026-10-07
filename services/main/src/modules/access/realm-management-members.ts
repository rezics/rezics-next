import { currentMembershipConsent } from './memberships.ts';
import { lockAccessKey } from './scope-gates.ts';
import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { RealmAdminDenied, RealmAdminInvalid, RealmAdminLimit, RealmAdminStale,
  type MemberCommand } from '../realm-admin/contract.ts';
import { recordRealmHistoryAdmission, RealmHistoryAdmissionStale, type RealmHistoryAdmission } from '../realm-admin/history.ts';
import type { WorkActivationEnvironment } from '../work/activate.ts';

/** Changes the existing Agent membership episode; consent stays recipient-owned.
 * Bans do not silently restore revoked roles when they expire or are lifted. */
export async function changeRealmMember(client: PoolClient, realm: string, input: MemberCommand,
  principalId: string, receiptId: string, env?: WorkActivationEnvironment, historyAdmission?: RealmHistoryAdmission) {
  if ((input.action === 'add') !== (input.consent !== null)
    || input.action !== 'ban' && input.durationSeconds !== null) throw new RealmAdminInvalid('Invalid member change');
  // Scope closure fences all owners. The membership identity lock also covers
  // an absent episode and is shared with the generic join/leave owner.
  const root = await client.query(`SELECT 1 FROM access.scope_gate WHERE id = 'work:create:root'
    AND open AND dispatch_open FOR SHARE`);
  if (!root.rowCount) throw new RealmAdminDenied('Membership authority is unavailable');
  // Cleanup can revoke group grants, whose generation trigger writes inventory.
  // Take that fence before membership identity and dependent source-row locks.
  if (input.action === 'remove' || input.action === 'ban') await client.query(
    "SELECT 1 FROM access.scope_gate WHERE id = 'access:group-inventory' FOR UPDATE");
  await lockAccessKey(client, `membership:realm:${realm}:${input.member}`);
  const subject = await client.query(`SELECT 1 FROM access.authority_subject
    WHERE id = $1 AND kind = 'agent' AND active FOR SHARE`, [input.member]);
  if (!subject.rowCount) throw new RealmAdminDenied('Member is unavailable');
  const policy = (await client.query<{ revision: string; terms_revision: string; open: boolean }>(`
    SELECT revision::text, terms_revision, open FROM access.membership_policy
    WHERE kind = 'realm' AND owner_subject = $1 FOR SHARE`, [realm])).rows[0];
  if (!policy) throw new RealmAdminDenied('Realm membership policy is unavailable');
  const member = (await client.query<{ id: string; generation: string; state: string }>(`
    SELECT id, generation::text, state FROM access.membership WHERE kind = 'realm'
      AND owner_subject = $1 AND member_subject = $2 FOR UPDATE`, [realm, input.member])).rows[0];
  if ((member?.generation ?? '0') !== input.expectedMembershipGeneration) throw new RealmAdminStale('Membership changed');
  const banned = (await client.query<{ expires_at: Date | null }>(`SELECT expires_at FROM access.membership_ban
    WHERE kind = 'realm' AND owner_subject = $1 AND member_subject = $2 AND active
      AND (expires_at IS NULL OR expires_at > clock_timestamp()) FOR UPDATE`, [realm, input.member])).rows[0];
  if (input.action === 'add' && (member?.state === 'joined' || banned || !policy.open)
    || input.action === 'remove' && member?.state !== 'joined'
    || input.action === 'unban' && !banned) throw new RealmAdminDenied('Member transition is unavailable');
  const membershipId = member?.id ?? randomUUID();
  let membershipGeneration = member?.generation ?? '0';
  if (input.action === 'add') {
    const consent = await currentMembershipConsent(client, { kind: 'realm', ownerSubject: realm,
      memberSubject: input.member, expectedPolicyRevision: policy.revision,
      termsRevision: policy.terms_revision, consentReference: input.consent! },
    (BigInt(membershipGeneration) + 1n).toString());
    if (!consent) throw new RealmAdminDenied('Recipient consent is unavailable');
  }
  if (input.action === 'add' || input.action === 'remove') {
    membershipGeneration = (BigInt(membershipGeneration) + 1n).toString();
    const state = input.action === 'add' ? 'joined' : 'left';
    const terms = input.action === 'add' ? policy.terms_revision : null;
    await client.query(`INSERT INTO access.membership
      (id,kind,owner_subject,member_subject,state,generation,policy_revision,terms_revision,consent_reference)
      VALUES ($1,'realm',$2,$3,$4,$5,$6,$7,$8) ON CONFLICT (kind,owner_subject,member_subject)
      DO UPDATE SET state = EXCLUDED.state,generation = EXCLUDED.generation,
        policy_revision = EXCLUDED.policy_revision,terms_revision = EXCLUDED.terms_revision,
        consent_reference = EXCLUDED.consent_reference,changed_at = clock_timestamp()`,
    [membershipId, realm, input.member, state, membershipGeneration, policy.revision, terms, input.consent]);
    await client.query(`INSERT INTO access.membership_history
      (membership_id,generation,state,policy_revision,terms_revision,consent_reference,changed_by_principal)
      VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [membershipId, membershipGeneration, state, policy.revision, terms, input.consent, principalId]);
    if (input.action === 'add') await client.query(`INSERT INTO access.membership_consent_use
      (consent_id,membership_id,generation) VALUES ($1,$2,$3)`, [input.consent, membershipId, membershipGeneration]);
    if (input.action === 'add') {
      try { await recordRealmHistoryAdmission(client, env, realm, 'agent', membershipId, membershipGeneration, historyAdmission); }
      catch (error) {
        if (error instanceof RealmHistoryAdmissionStale) throw new RealmAdminStale(error.message);
        throw error;
      }
    }
  }
  if ((input.action === 'remove' || input.action === 'ban') && member) {
    let remaining = 256;
    for (const table of ['permission_grant', 'group_permission_grant', 'role_binding'] as const) {
      const ids = (await client.query<{ id: string }>(`SELECT id FROM access.${table}
        WHERE membership_id = $1 AND active ORDER BY id LIMIT $2 FOR UPDATE`, [member.id, remaining + 1])).rows;
      if (ids.length > remaining) throw new RealmAdminLimit('Dependent authority cleanup budget exceeded');
      remaining -= ids.length;
      if (ids.length) await client.query(`UPDATE access.${table} SET active = false WHERE id = ANY($1::uuid[])`,
        [ids.map(row => row.id)]);
    }
  }
  if (input.action === 'remove' || input.action === 'ban') {
    const grants = (await client.query<{ grant_id: string }>(`SELECT grant_id FROM access.realm_admin_role_grant
      WHERE realm = $1 AND member = $2 ORDER BY grant_id LIMIT 225`, [realm, input.member])).rows;
    if (grants.length > 224) throw new RealmAdminLimit('Member role cleanup budget exceeded');
    await client.query(`UPDATE access.permission_grant SET active = false WHERE id = ANY($1::uuid[]) AND active`,
      [grants.map(row => row.grant_id)]);
    await client.query(`DELETE FROM access.realm_admin_role_grant WHERE realm = $1 AND member = $2`, [realm, input.member]);
    await client.query(`UPDATE access.realm_admin_assignment SET valid_until = clock_timestamp()
      WHERE realm = $1 AND member = $2 AND valid_until > clock_timestamp()`, [realm, input.member]);
  }
  let bannedUntil = banned?.expires_at?.toISOString() ?? null;
  if (input.action === 'ban' || input.action === 'unban') {
    const row = (await client.query<{ expires_at: Date | null }>(`INSERT INTO access.membership_ban
      (kind,owner_subject,member_subject,active,reason_ref,expires_at)
      VALUES ('realm',$1,$2,$3,$4,CASE WHEN $5::int IS NULL THEN NULL ELSE clock_timestamp() + $5 * interval '1 second' END)
      ON CONFLICT (kind,owner_subject,member_subject) DO UPDATE SET active = EXCLUDED.active,
        reason_ref = EXCLUDED.reason_ref,expires_at = EXCLUDED.expires_at RETURNING expires_at`,
    [realm, input.member, input.action === 'ban', receiptId, input.durationSeconds])).rows[0]!;
    bannedUntil = row.expires_at?.toISOString() ?? null;
  }
  return { member: input.member, membershipGeneration, bannedUntil,
    banned: input.action === 'ban' || input.action !== 'unban' && !!banned };
}
