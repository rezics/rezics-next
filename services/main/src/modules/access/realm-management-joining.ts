import { createHash, randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import type { VerifiedPrincipal } from './admission.ts';
import { AccessMembershipConsents } from './membership-consents.ts';
import { MembershipConflict, MembershipDenied, MembershipStale } from './memberships.ts';
import { changeRealmMember } from './realm-management-members.ts';
import { membershipRoot, realmActor, realmIdPattern, realmKeyPattern, realmManager, realmTransaction } from './realm-management-authority.ts';
import { RealmAdminConflict, RealmAdminDenied, RealmAdminInvalid, RealmAdminStale } from '../realm-admin/contract.ts';
import { readRealmPolicy } from '../space/policy.ts';
import { followSpace, registerFollowSpace, type SpaceIdentity } from '../follows/targets.ts';
import { publicTargetRead } from '../target/resolve.ts';
import type { WorkActivationEnvironment } from '../work/activate.ts';
import { REALM_JOIN_COST, type InvitationCommand, type InvitationResponse, type SelfJoinCommand } from './realm-management-joining-contract.ts';

interface Invitation { id: string; realm: string; member: string; inviter: string; state: 'pending'|'accepted'|'declined'|'revoked';
  created_at: Date; expires_at: Date; expired: boolean; membership_generation: string;
  policy_revision: string; terms_revision: string }
const digest = (intent: unknown) => createHash('sha256').update(JSON.stringify(intent)).digest('hex');
const invitationView = (row: Invitation) => ({ id: row.id,realm: row.realm,member: row.member,inviter: row.inviter,
  state: row.state === 'pending' && row.expired ? 'expired' as const : row.state,
  createdAt: row.created_at.toISOString(),expiresAt: row.expires_at.toISOString(),
  membershipGeneration: row.membership_generation,policyRevision: row.policy_revision,termsRevision: row.terms_revision });

/** Invitations select an Agent, never a bearer code. Acceptance binds the exact
 * invitation terms and live inviter proof; issuing and consuming consent occurs
 * in the same transaction as membership. No grant is inferred from membership.
 * Authority is checked on retries too (OWASP Authorization Cheat Sheet,
 * https://cheatsheetseries.owasp.org/cheatsheets/Authorization_Cheat_Sheet.html, 2026-09-28). */
export class AccessRealmJoining {
  constructor(private readonly pool: Pool, private readonly env: WorkActivationEnvironment) {}

  private async receipt<T extends { replayed: boolean }>(client: PoolClient, principal: string,
    key: string, intent: unknown, run: () => Promise<T>): Promise<T> {
    if (!realmKeyPattern.test(key)) throw new RealmAdminInvalid('Invalid idempotency key');
    // Different Realms may share a principal/key. Serialize that identity before
    // checking receipts, so simultaneous retries return the same committed result.
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`realm-join:${principal}:${key}`]);
    const hash = digest(intent);
    const prior = (await client.query<{ request_digest: string; result: T }>(`SELECT request_digest,result
      FROM access.realm_join_receipt WHERE principal_id = $1 AND idempotency_key = $2`, [principal,key])).rows[0];
    if (prior) {
      if (prior.request_digest !== hash) throw new RealmAdminConflict('Key binds another joining intent');
      return { ...prior.result,replayed: true };
    }
    const result = await run();
    await client.query(`INSERT INTO access.realm_join_receipt (principal_id,idempotency_key,request_digest,result)
      VALUES ($1,$2,$3,$4)`, [principal,key,hash,result]);
    return result;
  }

  private async policy(client: PoolClient, realm: string) {
    const row = (await client.query<{ revision: string; terms_revision: string; open: boolean; self_join: boolean;
      visibility: string }>(`SELECT p.revision::text,p.terms_revision,p.open,COALESCE(s.self_join,false) AS self_join,
      COALESCE(s.visibility,'public') AS visibility FROM access.membership_policy p
      LEFT JOIN access.realm_admin_settings s ON s.realm = p.owner_subject
      WHERE p.kind = 'realm' AND p.owner_subject = $1 FOR SHARE OF p`, [realm])).rows[0];
    if (!row || (await client.query('SELECT 1 FROM access.realm_policy_delivery WHERE realm = $1 AND NOT delivered',[realm])).rowCount) {
      throw new RealmAdminDenied('Realm membership policy is unavailable');
    }
    return row;
  }

  private async member(client: PoolClient, realm: string, actor: string) {
    return (await client.query<{ id: string; generation: string; state: 'joined'|'left' }>(`SELECT id,generation::text,state
      FROM access.membership WHERE kind = 'realm' AND owner_subject = $1 AND member_subject = $2 FOR SHARE`,[realm,actor])).rows[0];
  }

  async policyFor(principal: VerifiedPrincipal, realm: string, actor: string) {
    const graph = await readRealmPolicy(this.env,realm);
    return realmTransaction(this.pool,realm,false,async client => {
      await realmActor(client,principal,actor,'access.membership.consent');
      const policy = await this.policy(client,realm);
      const member = await this.member(client,realm,actor);
      const invited = (await client.query(`SELECT 1 FROM access.realm_invitation WHERE realm = $1 AND member = $2
        AND state = 'pending' AND expires_at > clock_timestamp() LIMIT 1`,[realm,actor])).rowCount;
      if (!graph || (graph.visibility !== 'public' || policy.visibility !== 'public') && !invited && member?.state !== 'joined') {
        throw new RealmAdminDenied('Realm membership policy is unavailable');
      }
      return { realm,policyRevision: policy.revision,termsRevision: policy.terms_revision,open: policy.open,
        selfJoin: policy.self_join && graph.visibility === 'public' && policy.visibility === 'public',
        membershipGeneration: member?.generation ?? '0',state: member?.state ?? 'absent' as const };
    });
  }

  invite(principal: VerifiedPrincipal, realm: string, input: InvitationCommand, key: string) {
    if (!realmIdPattern.test(input.member) || !Number.isInteger(input.expiresInSeconds)
      || input.expiresInSeconds < 60 || input.expiresInSeconds > REALM_JOIN_COST.maxLifetimeSeconds) throw new RealmAdminInvalid('Invalid invitation');
    return realmTransaction(this.pool,realm,true,async client => {
      const manager = await realmManager(client,principal,realm,input.actingSubject);
      await membershipRoot(client);
      return this.receipt(client,manager.id,key,['invite',realm,input],async () => {
        const policy = await this.policy(client,realm);
        const member = await this.member(client,realm,input.member);
        if (!policy.open || member?.state === 'joined') throw new RealmAdminDenied('Invitation is unavailable');
        if (!(await client.query(`SELECT 1 FROM access.authority_subject WHERE id = $1 AND kind = 'agent' AND active FOR SHARE`,[input.member])).rowCount
          || (await client.query(`SELECT 1 FROM access.membership_ban WHERE kind = 'realm' AND owner_subject = $1
            AND member_subject = $2 AND active AND (expires_at IS NULL OR expires_at > clock_timestamp())`,[realm,input.member])).rowCount) {
          throw new RealmAdminDenied('Invitation recipient is unavailable');
        }
        const row = (await client.query<Invitation>(`INSERT INTO access.realm_invitation
          (id,realm,member,inviter,principal_id,principal_epoch,representation_id,representation_generation,
            grant_id,grant_generation,subject_generation,membership_generation,policy_revision,terms_revision,expires_at)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,
            LEAST(clock_timestamp() + $15 * interval '1 second',$16)) RETURNING *,false AS expired`,
        [randomUUID(),realm,input.member,input.actingSubject,manager.id,manager.epoch,manager.representation,
          manager.representationGeneration,manager.grant,manager.grantGeneration,manager.subjectGeneration,
          member?.generation ?? '0',policy.revision,policy.terms_revision,input.expiresInSeconds,manager.validUntil])).rows[0]!;
        return { invitation: invitationView(row),replayed: false };
      });
    });
  }

  inbox(principal: VerifiedPrincipal, actor: string, after?: string, limit: number = REALM_JOIN_COST.page) {
    if (!Number.isInteger(limit) || limit < 1 || limit > REALM_JOIN_COST.page
      || after && !/^[0-9a-f-]{36}$/.test(after)) throw new RealmAdminInvalid('Invalid invitation page');
    return realmTransaction(this.pool,null,false,async client => {
      await realmActor(client,principal,actor,'access.membership.consent');
      const rows = (await client.query<Invitation>(`SELECT *,expires_at <= clock_timestamp() AS expired
        FROM access.realm_invitation WHERE member = $1 AND ($2::uuid IS NULL OR id > $2)
        ORDER BY id LIMIT $3`,[actor,after ?? null,limit + 1])).rows;
      return { items: rows.slice(0,limit).map(invitationView),nextCursor: rows.length > limit ? rows[limit - 1]!.id : null };
    });
  }

  outgoing(principal: VerifiedPrincipal, realm: string, actor: string,
    after?: string, limit: number = REALM_JOIN_COST.page) {
    if (!Number.isInteger(limit) || limit < 1 || limit > REALM_JOIN_COST.page
      || after && !/^[0-9a-f-]{36}$/.test(after)) throw new RealmAdminInvalid('Invalid invitation page');
    return realmTransaction(this.pool,realm,false,async client => {
      await realmManager(client,principal,realm,actor);
      const rows = (await client.query<Invitation>(`SELECT *,expires_at <= clock_timestamp() AS expired
        FROM access.realm_invitation WHERE realm = $1 AND ($2::uuid IS NULL OR id > $2)
        ORDER BY id LIMIT $3`,[realm,after ?? null,limit + 1])).rows;
      return { items: rows.slice(0,limit).map(invitationView),
        nextCursor: rows.length > limit ? rows[limit - 1]!.id : null };
    });
  }

  private async join(client: PoolClient, principal: VerifiedPrincipal, principalId: string, realm: string,
    input: SelfJoinCommand, key: string, identity: SpaceIdentity | null) {
    if (!identity) throw new RealmAdminDenied('Realm Space is unavailable');
    await registerFollowSpace(client,identity);
    let consent;
    try { consent = await new AccessMembershipConsents(this.pool).issue({ principal,kind: 'realm',ownerSubject: realm,
      memberSubject: input.actingSubject,expectedGeneration: input.expectedMembershipGeneration,
      expectedPolicyRevision: input.expectedPolicyRevision,termsRevision: input.termsRevision,
      idempotencyKey: `realm-join:${digest([realm,key])}`,requestDigest: digest(input) },client); }
    catch (error) {
      if (error instanceof MembershipStale) throw new RealmAdminStale(error.message);
      if (error instanceof MembershipDenied) throw new RealmAdminDenied(error.message);
      if (error instanceof MembershipConflict) throw new RealmAdminConflict(error.message);
      throw error;
    }
    await changeRealmMember(client,realm,{ actingSubject: input.actingSubject,member: input.actingSubject,
      expectedGeneration: '0',expectedMembershipGeneration: input.expectedMembershipGeneration,
      reason: 'Recipient accepted Realm membership',action: 'add',consent: consent.consentReference,durationSeconds: null },principalId,randomUUID());
    const member = (await this.member(client,realm,input.actingSubject))!;
    await client.query(`INSERT INTO access.realm_roster_listing (membership_id,membership_generation,realm,member,listed)
      VALUES ($1,$2,$3,$4,$5)`,[member.id,member.generation,realm,input.actingSubject,input.listed]);
    await client.query(`UPDATE access.realm_admin_revision SET generation = generation + 1 WHERE realm = $1`,[realm]);
    return { membershipId: member.id,realm,member: input.actingSubject,membershipGeneration: member.generation,
      listed: input.listed,replayed: false };
  }

  async selfJoin(principal: VerifiedPrincipal, realm: string, input: SelfJoinCommand, key: string) {
    const graph = await readRealmPolicy(this.env,realm);
    const identity = await publicTargetRead(this.env.fuseki,session => followSpace(session,realm));
    return realmTransaction(this.pool,realm,true,async client => {
      const actor = await realmActor(client,principal,input.actingSubject,'access.membership.consent');
      await membershipRoot(client);
      return this.receipt(client,actor.id,key,['self-join',realm,input],async () => {
        const policy = await this.policy(client,realm);
          if (!policy.self_join || !policy.open || policy.visibility !== 'public' || graph?.visibility !== 'public') {
          throw new RealmAdminDenied('This Realm does not allow self-joining');
        }
        return this.join(client,principal,actor.id,realm,input,key,identity);
      });
    });
  }

  async respond(principal: VerifiedPrincipal, realm: string, id: string, input: InvitationResponse, key: string) {
    const identity = input.action === 'accept'
      ? await publicTargetRead(this.env.fuseki,session => followSpace(session,realm)) : null;
    return realmTransaction(this.pool,realm,true,async client => {
      const actor = await realmActor(client,principal,input.actingSubject,'access.membership.consent');
      await membershipRoot(client);
      return this.receipt(client,actor.id,key,['respond',realm,id,input],async () => {
        const row = (await client.query<Invitation>(`SELECT *,expires_at <= clock_timestamp() AS expired
          FROM access.realm_invitation WHERE id = $1 AND realm = $2 AND member = $3 FOR UPDATE`,[id,realm,input.actingSubject])).rows[0];
        if (!row) throw new RealmAdminDenied('Invitation is unavailable');
        if (row.state !== 'pending' || row.expired) throw new RealmAdminStale('Invitation is no longer pending');
        if (input.action === 'accept') {
          const valid = await client.query(`SELECT 1 FROM access.realm_invitation i
            JOIN access.principal p ON p.id = i.principal_id AND p.active AND p.enforcement_epoch = i.principal_epoch
            JOIN access.representation r ON r.id = i.representation_id AND r.principal_id = p.id AND r.subject_id = i.inviter
              AND r.active AND r.generation = i.representation_generation AND r.valid_until > clock_timestamp()
              AND r.action IN ('realm.members.manage','agent.control')
            JOIN access.authority_subject s ON s.id = i.inviter AND s.active AND s.generation = i.subject_generation
            JOIN access.permission_grant g ON g.id = i.grant_id AND g.active AND g.generation = i.grant_generation
              AND g.valid_until > clock_timestamp() AND g.action = 'realm.members.manage'
              AND g.recipient_subject = i.inviter AND g.scope_id = 'governance:realm:' || i.realm
              AND (g.membership_id IS NULL OR EXISTS (SELECT 1 FROM access.membership m
                WHERE m.id = g.membership_id AND m.state = 'joined' AND m.generation = g.membership_generation))
            WHERE i.id = $1 FOR SHARE OF p,r,s,g`,[id]);
          if (!valid.rowCount) throw new RealmAdminDenied('Inviter authority is no longer available');
          await this.policy(client,realm);
          await this.join(client,principal,actor.id,realm,{ actingSubject: input.actingSubject,
            expectedMembershipGeneration: row.membership_generation,expectedPolicyRevision: row.policy_revision,
            termsRevision: row.terms_revision,listed: input.listed },key,identity);
        }
        row.state = input.action === 'accept' ? 'accepted' : 'declined';
        await client.query(`UPDATE access.realm_invitation SET state = $2,responded_at = clock_timestamp() WHERE id = $1`,[id,row.state]);
        return { invitation: invitationView(row),replayed: false };
      });
    });
  }

  revoke(principal: VerifiedPrincipal, realm: string, id: string, actor: string, key: string) {
    return realmTransaction(this.pool,realm,true,async client => {
      const manager = await realmManager(client,principal,realm,actor);
      return this.receipt(client,manager.id,key,['revoke',realm,id,actor],async () => {
        const row = (await client.query<Invitation>(`UPDATE access.realm_invitation SET state = 'revoked',responded_at = clock_timestamp()
          WHERE id = $1 AND realm = $2 AND state = 'pending' RETURNING *,expires_at <= clock_timestamp() AS expired`,[id,realm])).rows[0];
        if (!row) throw new RealmAdminStale('Invitation is no longer pending');
        return { invitation: invitationView(row),replayed: false };
      });
    });
  }
}
