import { createHash, randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { t } from 'elysia';
import type { Static } from 'typebox';
import { Value } from 'typebox/value';
import type { VerifiedPrincipal } from '../access/admission.ts';
import { realmActor, realmManager, realmTransaction, membershipRoot, realmKeyPattern, realmIdPattern } from '../access/realm-management-authority.ts';
import { readId, readUuid } from '../work/read-contract.ts';
import { readRealmPolicy } from '../space/policy.ts';
import { assertGraphAdmissionOpen } from '../work/restore-lineage.ts';
import type { WorkActivationEnvironment } from '../work/activate.ts';
import { generation, reason, commandFields, RealmAdminConflict, RealmAdminDenied, RealmAdminInvalid, RealmAdminStale,
  RealmAdminUnavailable } from './contract.ts';
import { recordRealmHistoryAdmission } from './history.ts';
import { JOIN_REQUEST_READ_COST, JOIN_REQUEST_SEARCH_SQL, joinRequestCursor, requestSearch,
  requestCursorBinding, encodeRequestCursor, decodeRequestCursor } from './join-requests-read.ts';

const PAGE = JOIN_REQUEST_READ_COST.page;
export const joinRequestCommand = t.Object({ actingSubject: readId, expectedMembershipGeneration: generation,
  expectedPolicyRevision: generation, termsRevision: t.String({ minLength: 1, maxLength: 128 }), reason }, { additionalProperties: false });
export type JoinRequestCommand = Static<typeof joinRequestCommand>;
export const joinRequestReceipt = t.Object({ requestId: readUuid, requestGeneration: generation,
  replayed: t.Boolean(), state: t.Literal('pending') });
export const joinRequestBasis = t.Object({ policyRevision: generation, termsRevision: t.String(),
  membershipGeneration: generation, state: t.Union([t.Literal('absent'),t.Literal('joined'),t.Literal('left')]) });
const requestView = t.Object({ id: readUuid, member: readId,
  requestGeneration: generation, membershipGeneration: generation, policyRevision: generation,
  termsRevision: t.String(), reason: t.String(), createdAt: t.String() });
export const joinRequestPage = t.Object({ generation, items: t.Array(requestView, { maxItems: PAGE }),
  nextCursor: t.Nullable(joinRequestCursor), complete: t.Boolean() });
export const joinRequestQuery = t.Object({ actingSubject: readId,
  q: t.Optional(t.String({ maxLength: JOIN_REQUEST_READ_COST.search })),
  cursor: t.Optional(joinRequestCursor), after: t.Optional(joinRequestCursor),
  limit: t.Optional(t.Integer({ minimum: 1, maximum: PAGE })) }, { additionalProperties: false });
export type JoinRequestQuery = Static<typeof joinRequestQuery>;
export const ownJoinRequestQuery = t.Object({ actingSubject: readId, cursor: t.Optional(joinRequestCursor),
  limit: t.Optional(t.Integer({ minimum: 1, maximum: PAGE })) }, { additionalProperties: false });
export type OwnJoinRequestQuery = Static<typeof ownJoinRequestQuery>;
export const ownJoinRequestPage = t.Object({ items: t.Array(t.Object({ ...requestView.properties,
  state: t.Union([t.Literal('pending'), t.Literal('accepted'), t.Literal('declined'), t.Literal('withdrawn')]),
  decidedAt: t.Nullable(t.String()) }), { maxItems: PAGE }), nextCursor: t.Nullable(joinRequestCursor), complete: t.Boolean() });
export const joinRequestWithdraw = t.Object({ actingSubject: readId, expectedRequestGeneration: generation, reason }, { additionalProperties: false });
export type JoinRequestWithdraw = Static<typeof joinRequestWithdraw>;
export const joinRequestDecision = t.Object({ ...commandFields, expectedRequestGeneration: generation,
  decision: t.Union([t.Literal('accepted'),t.Literal('declined')]) }, { additionalProperties: false });
export type JoinRequestDecision = Static<typeof joinRequestDecision>;
export const joinRequestDecisionReceipt = t.Object({ receiptId: readUuid, requestId: readUuid,
  requestGeneration: generation, generation, state: t.Union([t.Literal('accepted'),t.Literal('declined'),t.Literal('withdrawn')]),
  membershipId: t.Nullable(readUuid), membershipGeneration: t.Nullable(generation), replayed: t.Boolean() });
type DecisionReceipt = Static<typeof joinRequestDecisionReceipt>;
export class RealmJoinRequestMissing extends RealmAdminDenied {}
interface RequestRow { id: string; member: string; membership_generation: string; policy_revision: string;
  terms_revision: string; principal_id: string }
interface ReadRow { id: string; member: string; membership_generation: string; policy_revision: string;
  terms_revision: string; reason: string; created_at: Date }
const requestViewOf = (row: ReadRow, requestGeneration = '0') => ({ id: row.id, member: row.member, requestGeneration,
  membershipGeneration: row.membership_generation, policyRevision: row.policy_revision, termsRevision: row.terms_revision,
  reason: row.reason, createdAt: row.created_at.toISOString() });
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value, (_key, item) =>
  item && typeof item === 'object' && !Array.isArray(item)
    ? Object.fromEntries(Object.entries(item).sort(([a],[b]) => a.localeCompare(b))) : item)).digest('hex');
const validKey = (key: string) => { if (!realmKeyPattern.test(key)) throw new RealmAdminInvalid('Invalid idempotency key'); };

/** Immutable intent, one indexed pending row per Realm/member, one append-only
 * terminal decision. Requests issue no generic consent. Acceptance checks the
 * retained requester authority and exact terms/episode, then commits membership,
 * history cut, decision and receipt atomically under the existing Realm/root
 * gates. Each operation uses point reads; the inbox seeks at most P <= 50
 * pending identities and hydrates P indexed request/basis rows. SQL statements are bounded by realmTransaction's five seconds. */
export class RealmJoinRequests {
  constructor(private readonly pool: Pool, private readonly env: WorkActivationEnvironment) {}

  private async discoverableRequest(realm: string) {
    await assertGraphAdmissionOpen(this.env.fuseki,this.env.lineage);
    const graph = await readRealmPolicy(this.env,realm);
    if (!graph || graph.admission !== 'request') throw new RealmJoinRequestMissing('Realm is unavailable');
  }
  private async policy(client: PoolClient, realm: string) {
    const row = (await client.query<{ revision: string; terms_revision: string; open: boolean; admission: string; self_join: boolean }>(`
      SELECT p.revision::text,p.terms_revision,p.open,p.admission,COALESCE(s.self_join,false) AS self_join
      FROM access.membership_policy p LEFT JOIN access.realm_admin_settings s ON s.realm = p.owner_subject
      WHERE p.kind = 'realm' AND p.owner_subject = $1 FOR SHARE OF p`,[realm])).rows[0];
    if (!row || !row.open || row.admission !== 'request' || row.self_join) throw new RealmJoinRequestMissing('Realm is unavailable');
    if ((await client.query('SELECT 1 FROM access.realm_policy_delivery WHERE realm = $1 AND NOT delivered',[realm])).rowCount) {
      throw new RealmAdminUnavailable('Realm policy publication is pending');
    }
    return row;
  }
  private async episode(client: PoolClient, realm: string, member: string) {
    return (await client.query<{ id: string; generation: string; state: string }>(`SELECT id,generation::text,state
      FROM access.membership WHERE kind = 'realm' AND owner_subject = $1 AND member_subject = $2 FOR UPDATE`,[realm,member])).rows[0];
  }
  private async notBanned(client: PoolClient, realm: string, member: string, principal: string) {
    if ((await client.query(`SELECT 1 FROM access.membership_ban WHERE kind = 'realm' AND owner_subject = $1
      AND member_subject = $2 AND active AND (expires_at IS NULL OR expires_at > clock_timestamp())
      UNION ALL SELECT 1 FROM access.private_membership_ban WHERE kind = 'realm' AND owner_subject = $1
      AND principal_id = $3 AND active LIMIT 1`,[realm,member,principal])).rowCount) throw new RealmAdminDenied('Realm member is banned');
  }
  private async revision(client: PoolClient, realm: string) {
    const row = (await client.query<{ generation: string }>('SELECT generation::text FROM access.realm_admin_revision WHERE realm = $1 FOR UPDATE',[realm])).rows[0];
    if (!row) throw new RealmAdminDenied('Realm management is unavailable');
    return row.generation;
  }
  private async inboxRevision(client: PoolClient, realm: string) {
    return (await client.query<{ generation: string }>(`SELECT COALESCE((SELECT generation
      FROM access.realm_join_request_inbox_revision WHERE realm = $1),0)::text AS generation`,[realm])).rows[0]!.generation;
  }
  private async ownRevision(client: PoolClient, realm: string, member: string) {
    return (await client.query<{ generation: string }>(`SELECT COALESCE((SELECT generation
      FROM access.realm_join_request_member_revision WHERE realm = $1 AND member = $2),0)::text AS generation`,[realm,member])).rows[0]!.generation;
  }
  basis(principal: VerifiedPrincipal, realm: string, actingSubject: string) {
    return this.discoverableRequest(realm).then(() => realmTransaction(this.pool,realm,false,async client => {
      await realmActor(client,principal,actingSubject,'access.membership.consent');
      await this.discoverableRequest(realm);
      const policy = await this.policy(client,realm);
      const member = await this.episode(client,realm,actingSubject);
      return { policyRevision: policy.revision,termsRevision: policy.terms_revision,
        membershipGeneration: member?.generation ?? '0',state: (member?.state ?? 'absent') as 'joined'|'left'|'absent' };
    }));
  }
  async request(principal: VerifiedPrincipal, realm: string, input: JoinRequestCommand, key: string) {
    validKey(key);
    if (!Value.Check(joinRequestCommand,input) || !input.reason.trim()) throw new RealmAdminInvalid('Invalid join request');
    await this.discoverableRequest(realm);
    return realmTransaction(this.pool,realm,true,async client => {
      const actor = await realmActor(client,principal,input.actingSubject,'access.membership.consent');
      await membershipRoot(client);
      await this.discoverableRequest(realm);
      const policy = await this.policy(client,realm);
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))',[`join-request:${actor.id}:${key}`]);
      const hash = digest([realm,input]);
      const prior = (await client.query<{ request_digest: string; request_id: string }>(`
        SELECT request_digest,request_id FROM access.realm_join_request_receipt WHERE principal_id = $1 AND idempotency_key = $2`,[actor.id,key])).rows[0];
      if (prior) {
        if (prior.request_digest !== hash) throw new RealmAdminConflict('Key binds another join request');
        return { requestId: prior.request_id,requestGeneration: '0',state: 'pending' as const,replayed: true };
      }
      const member = await this.episode(client,realm,input.actingSubject);
      if ((member?.generation ?? '0') !== input.expectedMembershipGeneration || policy.revision !== input.expectedPolicyRevision
        || policy.terms_revision !== input.termsRevision) throw new RealmAdminStale('Membership or admission terms changed');
      if (member?.state === 'joined') throw new RealmAdminDenied('Already a Realm member');
      await this.notBanned(client,realm,input.actingSubject,actor.id);
      if ((await client.query('SELECT 1 FROM access.realm_join_request_pending WHERE realm = $1 AND member = $2',[realm,input.actingSubject])).rowCount) {
        throw new RealmAdminConflict('A join request is already pending');
      }
      const id = randomUUID();
      await client.query(`INSERT INTO access.realm_join_request (id,realm,member,membership_generation,policy_revision,reason)
        VALUES ($1,$2,$3,$4,$5,$6)`,[id,realm,input.actingSubject,input.expectedMembershipGeneration,input.expectedPolicyRevision,input.reason]);
      await client.query(`INSERT INTO access.realm_join_request_basis
        (request_id,principal_id,principal_epoch,representation_id,representation_generation,subject_generation,terms_revision)
        VALUES ($1,$2,$3,$4,$5,$6,$7)`,[id,actor.id,actor.epoch,actor.representation,actor.representationGeneration,actor.subjectGeneration,input.termsRevision]);
      await client.query(`INSERT INTO access.realm_join_request_receipt (principal_id,idempotency_key,request_digest,request_id)
        VALUES ($1,$2,$3,$4)`,[actor.id,key,hash,id]);
      return { requestId: id,requestGeneration: '0',state: 'pending' as const,replayed: false };
    });
  }
  list(principal: VerifiedPrincipal, realm: string, options: JoinRequestQuery) {
    if (!Value.Check(joinRequestQuery, options) || options.after && options.cursor) throw new RealmAdminInvalid('Invalid request page');
    const limit = options.limit ?? PAGE, search = requestSearch(options.q);
    return realmTransaction(this.pool,realm,false,async client => {
      const manager = await realmManager(client,principal,realm,options.actingSubject);
      const generation = await this.revision(client,realm);
      const inbox = await this.inboxRevision(client,realm);
      const binding = requestCursorBinding(['inbox',realm,options.actingSubject,search,generation,inbox,manager.id,manager.epoch,
        manager.representation,manager.representationGeneration,manager.subjectGeneration,manager.grant,manager.grantGeneration]);
      // Keep the existing after alias for callers; new cursor values are bound
      // to the search, Realm generation and current manager authority.
      const cursor = options.cursor ?? options.after;
      const after = options.after && Value.Check(readUuid, options.after) ? options.after
        : cursor ? decodeRequestCursor(cursor,binding) : null;
      const native = search.startsWith('agent-') ? `https://rezics.com/id/${search.slice(6)}` : search;
      const matches = search ? (await client.query<{ id: string }>(JOIN_REQUEST_SEARCH_SQL,
        [realm,after,search,limit + 1,native.replace(/[\\%_]/g,'\\$&')])).rows.map(row => row.id) : null;
      const rows = (await client.query<ReadRow>(`SELECT q.id,q.member,q.membership_generation::text,
        q.policy_revision::text,b.terms_revision,q.reason,q.created_at FROM access.realm_join_request_pending p
        JOIN access.realm_join_request q ON q.id = p.request_id JOIN access.realm_join_request_basis b ON b.request_id = q.id
        WHERE p.realm = $1 AND ($2::uuid IS NULL OR p.request_id > $2)
          AND ($4::uuid[] IS NULL OR p.request_id = ANY($4))
        ORDER BY p.request_id LIMIT $3`,[realm,after,limit + 1,matches])).rows;
      return { generation,items: rows.slice(0,limit).map(row => requestViewOf(row)),
        nextCursor: rows.length > limit ? encodeRequestCursor(rows[limit - 1]!.id,binding) : null, complete: rows.length <= limit };
    });
  }
  /** One current actor proof plus an indexed (Realm, member, id) history seek;
   * hydrate at most page + 1 request/basis/unique decision rows. Retained consent
   * generations authorize acceptance, not historical status disclosure. Current
   * requester authority and the immutable private principal binding authorize
   * this read even after policy/terms change. No graph or other requester read. */
  own(principal: VerifiedPrincipal, realm: string, options: OwnJoinRequestQuery) {
    if (!realmIdPattern.test(realm) || !Value.Check(ownJoinRequestQuery, options)) throw new RealmAdminInvalid('Invalid request page');
    const limit = options.limit ?? PAGE;
    // Use the shared recovery transaction, but map a missing Realm gate to the
    // same 404 as an existing Realm without this requester's own intent.
    return realmTransaction(this.pool,null,false,async client => {
      if (!(await client.query(`SELECT 1 FROM access.scope_gate WHERE id = $1
        AND open AND dispatch_open FOR SHARE`,[`governance:realm:${realm}`])).rowCount) {
        throw new RealmJoinRequestMissing('Realm is unavailable');
      }
      const actor = await realmActor(client,principal,options.actingSubject,'access.membership.consent');
      const owned = await client.query(`SELECT 1 FROM access.realm_join_request q
        JOIN access.realm_join_request_basis b ON b.request_id = q.id
        WHERE q.realm = $1 AND q.member = $2 AND b.principal_id = $3 LIMIT 1`,[realm,options.actingSubject,actor.id]);
      if (!owned.rowCount) throw new RealmJoinRequestMissing('Realm is unavailable');
      const binding = requestCursorBinding(['own',realm,options.actingSubject,actor.id,actor.epoch,actor.representation,
        actor.representationGeneration,actor.subjectGeneration,await this.ownRevision(client,realm,options.actingSubject)]);
      const after = options.cursor ? decodeRequestCursor(options.cursor,binding) : null;
      const rows = (await client.query<ReadRow & { state: 'pending'|'accepted'|'declined'|'withdrawn'; decided_at: Date | null }>(`
        SELECT q.id,q.member,q.membership_generation::text,q.policy_revision::text,b.terms_revision,q.reason,q.created_at,
          COALESCE(d.kind,'pending') AS state,d.decided_at
        FROM access.realm_join_request q JOIN access.realm_join_request_basis b ON b.request_id = q.id
        LEFT JOIN access.realm_join_request_decision d ON d.request_id = q.id
        WHERE q.realm = $1 AND q.member = $2 AND b.principal_id = $3 AND ($4::uuid IS NULL OR q.id > $4)
        ORDER BY q.id LIMIT $5`,[realm,options.actingSubject,actor.id,after,limit + 1])).rows;
      return { items: rows.slice(0,limit).map(row => ({ ...requestViewOf(row,row.state === 'pending' ? '0' : '1'),
        state: row.state,decidedAt: row.decided_at?.toISOString() ?? null })),
      nextCursor: rows.length > limit ? encodeRequestCursor(rows[limit - 1]!.id,binding) : null,complete: rows.length <= limit };
    });
  }
  private async pending(client: PoolClient, realm: string, request: string, expected: string): Promise<RequestRow> {
    const row = (await client.query<RequestRow>(`SELECT q.id,q.member,q.membership_generation::text,q.policy_revision::text,
      b.terms_revision,b.principal_id FROM access.realm_join_request q JOIN access.realm_join_request_basis b ON b.request_id = q.id
      JOIN access.realm_join_request_pending p ON p.request_id = q.id WHERE q.realm = $1 AND q.id = $2 FOR UPDATE OF p`,[realm,request])).rows[0];
    if (!row || expected !== '0') throw new RealmAdminStale('Join request is no longer pending');
    return row;
  }
  private async replay(client: PoolClient, principal: string, key: string, hash: string) {
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))',[`join-request-command:${principal}:${key}`]);
    const prior = (await client.query<{ request_digest: string; result: DecisionReceipt }>(`SELECT request_digest,result
      FROM access.realm_join_request_command_receipt WHERE principal_id = $1 AND idempotency_key = $2`,[principal,key])).rows[0];
    if (!prior) return null;
    if (prior.request_digest !== hash) throw new RealmAdminConflict('Key binds another request decision');
    return { ...prior.result,replayed: true };
  }
  private async finish(client: PoolClient, realm: string, request: string, principal: string, actor: string, key: string,
    hash: string, state: 'accepted'|'declined'|'withdrawn', reason: string, generation: string,
    membershipId: string | null = null, membershipGeneration: string | null = null): Promise<DecisionReceipt> {
    const receiptId = randomUUID();
    await client.query(`INSERT INTO access.realm_join_request_decision
      (id,request_id,kind,acting_subject,principal_id,reason,membership_id,membership_generation) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [receiptId,request,state,actor,principal,reason,membershipId,membershipGeneration]);
    const result = { receiptId,requestId: request,requestGeneration: '1',generation,state,membershipId,membershipGeneration,replayed: false };
    await client.query(`INSERT INTO access.realm_join_request_command_receipt
      (principal_id,idempotency_key,request_digest,request_id,decision_id,result) VALUES ($1,$2,$3,$4,$5,$6)`,[principal,key,hash,request,receiptId,result]);
    if (state !== 'withdrawn') {
      await client.query('UPDATE access.realm_admin_revision SET generation = $2 WHERE realm = $1',[realm,generation]);
      await client.query('UPDATE access.scope_gate SET authority_epoch = authority_epoch + 1 WHERE id = $1',[`governance:realm:${realm}`]);
    }
    return result;
  }
  withdraw(principal: VerifiedPrincipal, realm: string, request: string, input: JoinRequestWithdraw, key: string) {
    validKey(key);
    if (!Value.Check(joinRequestWithdraw,input) || !input.reason.trim()) throw new RealmAdminInvalid('Invalid request withdrawal');
    return realmTransaction(this.pool,realm,true,async client => {
      const actor = await realmActor(client,principal,input.actingSubject,'access.membership.consent');
      const owned = await client.query(`SELECT 1 FROM access.realm_join_request q JOIN access.realm_join_request_basis b ON b.request_id = q.id
        WHERE q.realm = $1 AND q.id = $2 AND q.member = $3 AND b.principal_id = $4`,[realm,request,input.actingSubject,actor.id]);
      if (!owned.rowCount) throw new RealmAdminDenied('Join request is unavailable');
      const hash = digest(['withdraw',realm,request,input]);
      const replay = await this.replay(client,actor.id,key,hash);
      if (replay) return replay;
      await this.pending(client,realm,request,input.expectedRequestGeneration);
      return this.finish(client,realm,request,actor.id,input.actingSubject,key,hash,'withdrawn',input.reason,await this.revision(client,realm));
    });
  }
  decide(principal: VerifiedPrincipal, realm: string, request: string, input: JoinRequestDecision, key: string) {
    validKey(key);
    if (!Value.Check(joinRequestDecision,input) || !input.reason.trim()) throw new RealmAdminInvalid('Invalid request decision');
    return realmTransaction(this.pool,realm,true,async client => {
      const manager = await realmManager(client,principal,realm,input.actingSubject);
      await membershipRoot(client);
      const hash = digest(['decide',realm,request,input]);
      const replay = await this.replay(client,manager.id,key,hash);
      if (replay) return replay;
      const current = await this.revision(client,realm);
      if (current !== input.expectedGeneration) throw new RealmAdminStale('Realm management generation changed');
      const row = await this.pending(client,realm,request,input.expectedRequestGeneration);
      const policy = await this.policy(client,realm);
      const member = await this.episode(client,realm,row.member);
      if ((member?.generation ?? '0') !== row.membership_generation || member?.state === 'joined'
        || policy.revision !== row.policy_revision || policy.terms_revision !== row.terms_revision) throw new RealmAdminStale('Membership or admission terms changed');
      await this.notBanned(client,realm,row.member,row.principal_id);
      const next = (BigInt(current) + 1n).toString();
      if (input.decision === 'declined') return this.finish(client,realm,request,manager.id,input.actingSubject,key,hash,'declined',input.reason,next);
      const authority = await client.query(`SELECT 1 FROM access.realm_join_request_basis b
        JOIN access.principal p ON p.id = b.principal_id AND p.active AND p.enforcement_epoch = b.principal_epoch
        JOIN access.representation r ON r.id = b.representation_id AND r.principal_id = p.id AND r.subject_id = $2
          AND r.generation = b.representation_generation AND r.active AND r.valid_until > clock_timestamp()
          AND r.action IN ('access.membership.consent','agent.control')
        JOIN access.authority_subject s ON s.id = r.subject_id AND s.kind = 'agent' AND s.active AND s.generation = b.subject_generation
        WHERE b.request_id = $1 FOR SHARE OF p,r,s`,[request,row.member]);
      if (!authority.rowCount) throw new RealmAdminDenied('Requester authority is no longer available');
      const id = member?.id ?? randomUUID(), generation = (BigInt(row.membership_generation) + 1n).toString();
      const reference = `urn:rezics:realm-join-request:${request}`;
      await client.query(`INSERT INTO access.membership (id,kind,owner_subject,member_subject,state,generation,policy_revision,terms_revision,consent_reference)
        VALUES ($1,'realm',$2,$3,'joined',$4,$5,$6,$7) ON CONFLICT (kind,owner_subject,member_subject) DO UPDATE SET state = 'joined',
          generation = EXCLUDED.generation,policy_revision = EXCLUDED.policy_revision,terms_revision = EXCLUDED.terms_revision,
          consent_reference = EXCLUDED.consent_reference,changed_at = clock_timestamp()`,[id,realm,row.member,generation,row.policy_revision,row.terms_revision,reference]);
      await client.query(`INSERT INTO access.membership_history
        (membership_id,generation,state,policy_revision,terms_revision,consent_reference,changed_by_principal)
        VALUES ($1,$2,'joined',$3,$4,$5,$6)`,[id,generation,row.policy_revision,row.terms_revision,reference,manager.id]);
      await recordRealmHistoryAdmission(client,this.env,realm,'agent',id,generation);
      await client.query("UPDATE access.scope_gate SET authority_epoch = authority_epoch + 1 WHERE id = 'work:create:root'");
      return this.finish(client,realm,request,manager.id,input.actingSubject,key,hash,'accepted',input.reason,next,id,generation);
    });
  }
}
