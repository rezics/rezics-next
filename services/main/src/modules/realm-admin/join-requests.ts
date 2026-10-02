import { createHash, randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { t } from 'elysia';
import type { Static } from 'typebox';
import type { VerifiedPrincipal } from '../access/admission.ts';
import { realmActor, realmManager, realmTransaction, membershipRoot, realmKeyPattern } from '../access/realm-management-authority.ts';
import { AccessMembershipConsents } from '../access/membership-consents.ts';
import { MembershipConflict, MembershipDenied, MembershipStale } from '../access/memberships.ts';
import { readId, readUuid } from '../work/read-contract.ts';
import { readRealmPolicy } from '../space/policy.ts';
import type { WorkActivationEnvironment } from '../work/activate.ts';
import { generation, reason, RealmAdminConflict, RealmAdminDenied, RealmAdminInvalid, RealmAdminStale } from './contract.ts';

export const JOIN_REQUEST_COST = { page: 50, transactions: 1, graphReads: 1, statementTimeoutMs: 5000 } as const;
export const joinRequestCommand = t.Object({ actingSubject: readId, expectedMembershipGeneration: generation,
  expectedPolicyRevision: generation, termsRevision: t.String({ minLength: 1, maxLength: 128 }), reason }, { additionalProperties: false });
export type JoinRequestCommand = Static<typeof joinRequestCommand>;
export const joinRequestReceipt = t.Object({ requestId: readUuid, replayed: t.Boolean(), state: t.Literal('pending'), expiresAt: t.String() });
export const joinRequestBasis = t.Object({ policyRevision: generation, termsRevision: t.String(),
  membershipGeneration: generation, state: t.Union([t.Literal('absent'),t.Literal('joined'),t.Literal('left')]) });
export const joinRequestPage = t.Object({ items: t.Array(t.Object({ id: readUuid, member: readId,
  consent: readUuid, membershipGeneration: generation, policyRevision: generation, reason: t.String(), createdAt: t.String() }),
{ maxItems: JOIN_REQUEST_COST.page }), nextCursor: t.Nullable(readUuid) });

/** The existing consent/add path makes acceptance atomic with membership. This
 * inbox excludes requests whose episode or policy changed or whose consent
 * expired/revoked/was used; an old request can never grant a newer episode. */
export class RealmJoinRequests {
  constructor(private readonly pool: Pool, private readonly env: WorkActivationEnvironment) {}
  basis(principal: VerifiedPrincipal, realm: string, actingSubject: string) {
    return realmTransaction(this.pool,realm,false,async client => {
      await realmActor(client,principal,actingSubject,'access.membership.consent');
      const graph = await readRealmPolicy(this.env,realm);
      const row = (await client.query<{ policyRevision: string; termsRevision: string; membershipGeneration: string;
        state: 'absent' | 'joined' | 'left' }>(`SELECT p.revision::text AS "policyRevision",p.terms_revision AS "termsRevision",
        COALESCE(m.generation,0)::text AS "membershipGeneration",COALESCE(m.state,'absent') AS state
        FROM access.membership_policy p JOIN access.realm_admin_settings s ON s.realm = p.owner_subject
        LEFT JOIN access.membership m ON m.kind = 'realm' AND m.owner_subject = p.owner_subject AND m.member_subject = $2
        WHERE p.kind = 'realm' AND p.owner_subject = $1 AND p.open AND p.admission = 'request' AND NOT s.self_join
          AND NOT EXISTS (SELECT 1 FROM access.realm_policy_delivery d WHERE d.realm = p.owner_subject AND NOT d.delivered)`,
      [realm,actingSubject])).rows[0];
      if (!row || graph?.admission !== 'request') throw new RealmAdminDenied('Join requests are unavailable');
      return row;
    });
  }
  request(principal: VerifiedPrincipal, realm: string, input: JoinRequestCommand, key: string) {
    if (!realmKeyPattern.test(key) || !input.reason.trim()) throw new RealmAdminInvalid('Invalid join request');
    return realmTransaction(this.pool,realm,true,async client => {
      const actor = await realmActor(client,principal,input.actingSubject,'access.membership.consent');
      await membershipRoot(client);
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`join-request:${actor.id}:${key}`]);
      const digest = createHash('sha256').update(JSON.stringify([realm,input])).digest('hex');
      const prior = (await client.query<{ request_digest: string; request_id: string; expires_at: Date }>(`
        SELECT r.request_digest,r.request_id,c.expires_at FROM access.realm_join_request_receipt r
        JOIN access.realm_join_request q ON q.id = r.request_id JOIN access.membership_consent c ON c.id = q.consent
        WHERE r.principal_id = $1 AND r.idempotency_key = $2`,[actor.id,key])).rows[0];
      if (prior) {
        if (prior.request_digest !== digest) throw new RealmAdminConflict('Key binds another join request');
        return { requestId: prior.request_id,state: 'pending' as const,expiresAt: prior.expires_at.toISOString(),replayed: true };
      }
      const graph = await readRealmPolicy(this.env,realm);
      const policy = (await client.query<{ open: boolean; admission: string; self_join: boolean; delivered: boolean | null }>(`
        SELECT p.open,p.admission,COALESCE(s.self_join,false) AS self_join,d.delivered
        FROM access.membership_policy p LEFT JOIN access.realm_admin_settings s ON s.realm = p.owner_subject
        LEFT JOIN access.realm_policy_delivery d ON d.realm = p.owner_subject
        WHERE p.kind = 'realm' AND p.owner_subject = $1 FOR SHARE OF p`,[realm])).rows[0];
      if (!graph || graph.admission !== 'request' || !policy?.open || policy.admission !== 'request'
        || policy.self_join || policy.delivered === false) throw new RealmAdminDenied('Join requests are unavailable');
      let consent;
      try { consent = await new AccessMembershipConsents(this.pool).issue({ principal,kind: 'realm',ownerSubject: realm,
        memberSubject: input.actingSubject,expectedGeneration: input.expectedMembershipGeneration,
        expectedPolicyRevision: input.expectedPolicyRevision,termsRevision: input.termsRevision,
        idempotencyKey: `join-request:${createHash('sha256').update(JSON.stringify([actor.id,realm,key])).digest('hex')}`,requestDigest: digest },client); }
      catch (error) {
        if (error instanceof MembershipDenied) throw new RealmAdminDenied(error.message);
        if (error instanceof MembershipStale) throw new RealmAdminStale(error.message);
        if (error instanceof MembershipConflict) throw new RealmAdminConflict(error.message);
        throw error;
      }
      const id = randomUUID();
      await client.query(`INSERT INTO access.realm_join_request
        (id,realm,member,consent,membership_generation,policy_revision,reason) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [id,realm,input.actingSubject,consent.consentReference,input.expectedMembershipGeneration,input.expectedPolicyRevision,input.reason]);
      await client.query(`INSERT INTO access.realm_join_request_receipt (principal_id,idempotency_key,request_digest,request_id)
        VALUES ($1,$2,$3,$4)`,[actor.id,key,digest,id]);
      return { requestId: id,state: 'pending' as const,expiresAt: consent.expiresAt,replayed: false };
    });
  }
  list(principal: VerifiedPrincipal, realm: string, actor: string, after?: string, limit: number = JOIN_REQUEST_COST.page) {
    if (!Number.isInteger(limit) || limit < 1 || limit > JOIN_REQUEST_COST.page
      || after && !/^[0-9a-f-]{36}$/.test(after)) throw new RealmAdminInvalid('Invalid request page');
    return realmTransaction(this.pool,realm,false,async client => {
      await realmManager(client,principal,realm,actor);
      const rows = (await client.query<{ id: string; member: string; consent: string; membership_generation: string;
        policy_revision: string; reason: string; created_at: Date }>(`SELECT q.id,q.member,q.consent,
        q.membership_generation::text,q.policy_revision::text,q.reason,q.created_at FROM access.realm_join_request q
        JOIN access.membership_policy p ON p.kind = 'realm' AND p.owner_subject = q.realm
          AND p.revision = q.policy_revision AND p.open AND p.admission = 'request'
        JOIN access.realm_admin_settings s ON s.realm = q.realm AND NOT s.self_join
        JOIN access.membership_consent c ON c.id = q.consent AND c.expires_at > clock_timestamp()
        LEFT JOIN access.membership m ON m.kind = 'realm' AND m.owner_subject = q.realm AND m.member_subject = q.member
        WHERE q.realm = $1 AND ($2::uuid IS NULL OR q.id > $2)
          AND COALESCE(m.generation,0) = q.membership_generation AND COALESCE(m.state,'left') = 'left'
          AND NOT EXISTS (SELECT 1 FROM access.membership_consent_use u WHERE u.consent_id = q.consent)
          AND NOT EXISTS (SELECT 1 FROM access.membership_consent_revocation r WHERE r.consent_id = q.consent)
        ORDER BY q.id LIMIT $3`,[realm,after ?? null,limit + 1])).rows;
      return { items: rows.slice(0,limit).map(row => ({ id: row.id,member: row.member,consent: row.consent,
        membershipGeneration: row.membership_generation,policyRevision: row.policy_revision,
        reason: row.reason,createdAt: row.created_at.toISOString() })),nextCursor: rows.length > limit ? rows[limit - 1]!.id : null };
    });
  }
}
