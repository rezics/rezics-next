import { createHash } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { AdmissionConflict, AdmissionDenied, AdmissionUnavailable, type GraphTerminalProof,
  type RegisteredAdmission, type VerifiedPrincipal } from '../access/admission.ts';
import { pollScopeId, voteOperationAction, type VoteOperation } from './schema.ts';

/**
 * Access side of governance votes: one transaction decides current authority and
 * creates a claimed, finite admission plus its immutable `access.vote_admission`
 * proof (migrations 071/073). The admission seal is the only cross-store receipt.
 */

export type SeatClass = 'person' | 'organization' | 'collective';
export type PolicyRole = 'designated' | 'backup' | 'approver';

export class VoteIneligible extends Error {}
export class VotePolicyStale extends Error {}

export interface VoteAuthority {
  operation: VoteOperation;
  poll: string;
  body: string;
  actingSubject: string;
  representationId: string;
  holder?: string;
  seat?: string;
  sourceEntitlement?: string;
  grantId?: string;
  /** Roles of the holder's current policy head that may use this mandate. */
  policyRoles?: readonly PolicyRole[];
  candidateDigest: string;
  expectedHead: string | null;
}

export interface VoteAdmission extends RegisteredAdmission {
  operation: VoteOperation;
  policy: { id: string; revision: string } | null;
}

export interface VotePolicyHead {
  id: string;
  revision: string;
  holderCharterRevision: string;
  holderCharterDigest: string;
  members: { role: PolicyRole; representationId: string; principalId: string }[];
}

export interface VotePolicyChange {
  holder: string;
  body: string;
  representationId: string;
  expectedRevision: string | null;
  holderCharterRevision: string;
  holderCharterDigest: string;
  members: { role: PolicyRole; representationId: string }[];
}

interface AdmissionRow {
  id: string; principal_id: string; acting_subject: string; scope_id: string; action: string;
  idempotency_key: string; request_digest: string; authority_epoch: string; registered_at: Date;
  expires_at: Date; state: RegisteredAdmission['state']; eligible: boolean;
}

const nativeId = /^https:\/\/rezics\.com\/id\/[0-9a-f-]{36}$/;
const receiptFamilies: Record<VoteOperation, string> = {
  'poll.prepare': 'vote-poll-prepare', 'poll.open': 'vote-poll-open', 'poll.close': 'vote-poll-close',
  'holder-charter.set': 'vote-holder-charter', 'allocation.activate': 'vote-allocation',
  'ballot.cast': 'vote-ballot', 'ballot.withdraw': 'vote-ballot', 'ballot.approve': 'vote-mandate-approval',
  'proxy.designate': 'vote-proxy', 'proxy.revoke': 'vote-proxy', 'ballot.invalidate': 'vote-invalidation',
  'resolution.finalize': 'vote-resolution',
};

/** The graph receipt identity the Access seal accepts for one admission. */
export function voteReceiptIri(admissionId: string, operation: VoteOperation): string {
  return `urn:rezics:receipt:${createHash('sha256')
    .update(`${admissionId}\0${receiptFamilies[operation]}`).digest('hex')}`;
}

const digestOf = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

/** Private counting identity for one poll; RDF sees only this opaque slot. */
export function countingSlotIri(poll: string, seatClass: SeatClass, identity: string): string {
  return `urn:rezics:vote-counting-slot:${digestOf({ poll, seatClass, identity })}`;
}

/** Independence is by private principal: every persona and mandate of one principal shares it. */
export function approverSlotIri(poll: string, holder: string, principalId: string): string {
  return `urn:rezics:vote-approver-slot:${digestOf({ poll, holder, principalId })}`;
}

async function rollback(client: PoolClient): Promise<void> {
  try { await client.query('ROLLBACK'); } catch { /* preserve the cause */ }
}

async function begin(client: PoolClient): Promise<void> {
  await client.query('BEGIN');
  await client.query("SET LOCAL lock_timeout = '2s'");
  await client.query("SET LOCAL statement_timeout = '5s'");
  const fence = await client.query<{ open: boolean }>(
    'SELECT open FROM access.recovery_fence WHERE id = true FOR SHARE');
  if (fence.rows[0]?.open !== true) throw new AdmissionUnavailable('Access is held for recovery');
}

function registered(row: AdmissionRow, operation: VoteOperation, policy: VoteAdmission['policy'],
  eligible: boolean, replayed: boolean): VoteAdmission {
  return { id: row.id, principalId: row.principal_id, actingSubject: row.acting_subject,
    scope: row.scope_id, action: row.action, idempotencyKey: row.idempotency_key,
    requestDigest: row.request_digest, authorityEpoch: row.authority_epoch,
    registeredAt: row.registered_at.toISOString(), expiresAt: row.expires_at.toISOString(),
    state: row.state, dispatchEligible: eligible, replayed, operation, policy };
}

export class AccessVotes {
  constructor(private readonly pool: Pool) {}

  private async connect(): Promise<PoolClient> {
    return this.pool.connect().catch(() => { throw new AdmissionUnavailable('vote authority owner is unavailable'); });
  }

  /** Current principal id, or null when inactive or unknown. */
  async principalId(principal: VerifiedPrincipal): Promise<string | null> {
    const row = (await this.pool.query<{ id: string }>(`SELECT id FROM access.principal
      WHERE account_issuer = $1 AND account_subject = $2 AND active`, [principal.issuer, principal.subject])).rows[0];
    return row?.id ?? null;
  }

  /**
   * Counting identity: a person seat is counted by the one live controlling principal
   * of its Agent (never by persona or Agent); organization and collective seats by
   * their own Agent. Ambiguous or missing identity is ineligible, not guessed.
   */
  async countingSlots(poll: string, holders: readonly { holder: string; seatClass: SeatClass }[]): Promise<string[]> {
    if (holders.length > 1024) throw new VoteIneligible('too many holders in one request');
    const rows = (await this.pool.query<{ subject: string; active: boolean | null;
      controllers: string[] | null }>(`
      SELECT h.subject, s.active, (SELECT array_agg(DISTINCT r.principal_id::text) FROM access.representation r
        JOIN access.principal p ON p.id = r.principal_id AND p.active
        WHERE r.subject_id = h.subject AND r.action = 'agent.control' AND r.active
          AND r.valid_until > clock_timestamp()) AS controllers
      FROM unnest($1::text[]) AS h(subject) LEFT JOIN access.authority_subject s ON s.id = h.subject`,
    [holders.map(item => item.holder)])).rows;
    const bySubject = new Map(rows.map(row => [row.subject, row]));
    return holders.map(({ holder, seatClass }) => {
      const row = bySubject.get(holder);
      if (!nativeId.test(holder) || !row?.active) throw new VoteIneligible('seat holder is not an active Agent');
      if (seatClass !== 'person') return countingSlotIri(poll, seatClass, holder);
      if (row.controllers?.length !== 1) {
        throw new VoteIneligible('person seat needs exactly one controlling principal');
      }
      return countingSlotIri(poll, 'person', row.controllers[0]!);
    });
  }

  async policyHead(holder: string, body: string): Promise<VotePolicyHead | null> {
    const client = await this.connect();
    try { return await this.readPolicy(client, holder, body, false); }
    finally { client.release(); }
  }

  private async readPolicy(client: PoolClient, holder: string, body: string,
    lock: boolean): Promise<VotePolicyHead | null> {
    const head = (await client.query<{ id: string; revision: string; charter: string; digest: string }>(`
      SELECT p.id, p.head_revision AS revision, r.holder_charter_revision AS charter,
        r.holder_charter_digest AS digest FROM access.vote_representative_policy p
      JOIN access.vote_representative_policy_revision r ON r.policy_id = p.id AND r.revision = p.head_revision
      WHERE p.holder_subject = $1 AND p.body_subject = $2 ${lock ? 'FOR UPDATE OF p' : ''}`,
    [holder, body])).rows[0];
    if (!head) return null;
    const members = (await client.query<{ role: PolicyRole; representation_id: string; principal_id: string }>(`
      SELECT role, representation_id, principal_id FROM access.vote_representative_policy_member
      WHERE policy_id = $1 AND revision = $2 ORDER BY role, representation_id LIMIT 257`,
    [head.id, head.revision])).rows;
    return { id: head.id, revision: head.revision, holderCharterRevision: head.charter,
      holderCharterDigest: head.digest, members: members.map(member => ({ role: member.role,
        representationId: member.representation_id, principalId: member.principal_id })) };
  }

  /** Decide current authority and create one claimed admission with its exact proof. */
  async admit(principal: VerifiedPrincipal, authority: VoteAuthority, key: string,
    requestDigest: string): Promise<VoteAdmission> {
    if (!/^[A-Za-z0-9:_./-]{1,128}$/.test(key) || !/^[0-9a-f]{64}$/.test(requestDigest)
      || !/^[0-9a-f]{64}$/.test(authority.candidateDigest)) {
      throw new AdmissionDenied('invalid vote intent');
    }
    const action = voteOperationAction[authority.operation];
    const scope = pollScopeId(authority.poll);
    const bodyPath = action === 'governance.poll.administer' || action === 'governance.ballot.invalidate';
    if (!bodyPath && authority.actingSubject !== authority.holder) {
      throw new AdmissionDenied('a holder operation acts as the seat holder');
    }
    const client = await this.connect();
    try {
      await begin(client);
      if (authority.operation === 'poll.prepare') {
        await client.query('INSERT INTO access.scope_gate (id) VALUES ($1) ON CONFLICT (id) DO NOTHING', [scope]);
      }
      const gate = (await client.query<{ authority_epoch: string; open: boolean; dispatch_open: boolean }>(
        'SELECT authority_epoch, open, dispatch_open FROM access.scope_gate WHERE id = $1 FOR UPDATE', [scope])).rows[0];
      if (!gate?.open || !gate.dispatch_open) throw new AdmissionDenied('poll authority gate is closed');
      const identity = (await client.query<{ id: string; enforcement_epoch: string }>(`
        SELECT id, enforcement_epoch FROM access.principal
        WHERE account_issuer = $1 AND account_subject = $2 AND active FOR SHARE`,
      [principal.issuer, principal.subject])).rows[0];
      if (!identity) throw new AdmissionDenied('principal is inactive');
      const existing = (await client.query<AdmissionRow>(`SELECT *, expires_at > clock_timestamp() AS eligible
        FROM access.admission WHERE principal_id = $1 AND action = $2 AND idempotency_key = $3 FOR UPDATE`,
      [identity.id, action, key])).rows[0];
      if (existing) {
        const saved = (await client.query<{ operation: VoteOperation; policy_id: string | null;
          policy_revision: string | null; candidate_digest: string }>(`SELECT operation, policy_id,
          policy_revision, candidate_digest FROM access.vote_admission WHERE admission_id = $1`,
        [existing.id])).rows[0];
        if (!saved || existing.request_digest !== requestDigest || existing.scope_id !== scope
          || existing.acting_subject !== authority.actingSubject || saved.operation !== authority.operation) {
          throw new AdmissionConflict('vote idempotency key binds another intent');
        }
        const live = existing.state === 'claimed' && existing.eligible
          && existing.authority_epoch === gate.authority_epoch
          && !!await this.mandate(client, identity.id, authority, action);
        await client.query('COMMIT');
        return registered(existing, authority.operation, saved.policy_id
          ? { id: saved.policy_id, revision: saved.policy_revision! } : null, live, true);
      }
      const mandate = await this.mandate(client, identity.id, authority, action);
      if (!mandate) throw new AdmissionDenied('exact current mandate required');
      let validUntil = mandate.valid_until;
      let grant: { id: string; generation: string } | null = null;
      if (bodyPath) {
        const row = (await client.query<{ id: string; generation: string; valid_until: Date }>(`
          SELECT id, generation, valid_until FROM access.permission_grant WHERE id = $1
            AND issuer_subject = $2 AND recipient_subject = $3 AND action = $4 AND active
            AND membership_id IS NULL AND valid_until > clock_timestamp() FOR SHARE`,
        [authority.grantId ?? null, authority.body, authority.actingSubject, action])).rows[0];
        if (!row) throw new AdmissionDenied('the body has not granted this poll operation');
        grant = { id: row.id, generation: row.generation };
        if (row.valid_until < validUntil) validUntil = row.valid_until;
      }
      let policy: VoteAdmission['policy'] = null;
      if (authority.policyRoles?.length) {
        const head = await this.readPolicy(client, authority.holder!, authority.body, false);
        const member = head?.members.find(item => item.representationId === authority.representationId
          && item.principalId === identity.id && authority.policyRoles!.includes(item.role));
        const pinned = member && (await client.query(`SELECT 1 FROM access.vote_representative_policy_member
          WHERE policy_id = $1 AND revision = $2 AND representation_id = $3 AND representation_generation = $4`,
        [head!.id, head!.revision, mandate.id, mandate.generation])).rowCount === 1;
        if (!head || !member || !pinned) throw new AdmissionDenied('the holder policy does not select this mandate');
        policy = { id: head.id, revision: head.revision };
      }
      const inserted = (await client.query<AdmissionRow>(`INSERT INTO access.admission
        (id, principal_id, acting_subject, scope_id, action, idempotency_key, request_digest,
          authority_epoch, registered_at, expires_at, state, claimed_at)
        SELECT $1,$2,$3,$4,$5,$6,$7,$8,clock_timestamp(),
          LEAST(clock_timestamp() + interval '30 seconds', $9::timestamptz), 'claimed', clock_timestamp()
        WHERE $9::timestamptz > clock_timestamp()
        RETURNING *, true AS eligible`, [Bun.randomUUIDv7(), identity.id, authority.actingSubject, scope,
        action, key, requestDigest, gate.authority_epoch, validUntil])).rows[0];
      if (!inserted) throw new AdmissionDenied('authority expired during admission');
      await client.query(`INSERT INTO access.vote_admission (admission_id, operation, poll, body_subject,
          holder_subject, seat, source_entitlement, authority_path, representation_id,
          representation_generation, grant_id, grant_generation, policy_id, policy_revision,
          principal_epoch, acting_subject_generation, candidate_digest, expected_head)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)`,
      [inserted.id, authority.operation, authority.poll, authority.body, bodyPath ? null : authority.holder,
        authority.seat ?? null, authority.sourceEntitlement ?? null, bodyPath ? 'body-grant' : 'holder-mandate',
        mandate.id, mandate.generation, grant?.id ?? null, grant?.generation ?? null,
        policy?.id ?? null, policy?.revision ?? null, identity.enforcement_epoch, mandate.subject_generation,
        authority.candidateDigest, authority.expectedHead]);
      await client.query(`INSERT INTO access.admission_receipt
        (admission_id, principal_id, action, idempotency_key, request_digest, outcome)
        VALUES ($1,$2,$3,$4,$5,'registered')`, [inserted.id, identity.id, action, key, requestDigest]);
      await client.query(`INSERT INTO access.outbox (id, kind, admission_id, scope_id, authority_epoch)
        VALUES ($1,'admission.registered',$3,$4,$5),($2,'admission.claimed',$3,$4,$5)`,
      [Bun.randomUUIDv7(), Bun.randomUUIDv7(), inserted.id, scope, gate.authority_epoch]);
      await client.query('COMMIT');
      return registered(inserted, authority.operation, policy, true, false);
    } catch (error) {
      await rollback(client);
      if (error instanceof AdmissionDenied || error instanceof AdmissionConflict
        || error instanceof AdmissionUnavailable) throw error;
      const code = (error as { code?: string }).code;
      if (code === '23514' || code === '23503') throw new AdmissionDenied('vote proof was rejected');
      throw new AdmissionUnavailable('vote authority owner is unavailable');
    } finally { client.release(); }
  }

  private async mandate(client: PoolClient, principalId: string, authority: VoteAuthority, action: string) {
    return (await client.query<{ id: string; generation: string; valid_until: Date; subject_generation: string }>(`
      SELECT r.id, r.generation, r.valid_until, s.generation AS subject_generation
      FROM access.representation r JOIN access.authority_subject s ON s.id = r.subject_id AND s.active
      WHERE r.id = $1 AND r.principal_id = $2 AND r.subject_id = $3 AND r.action = $4 AND r.active
        AND r.valid_until > clock_timestamp()
        AND (r.action <> 'governance.ballot.operate' OR r.resource_subject = $5)
      FOR SHARE OF r, s`, [authority.representationId, principalId, authority.actingSubject, action,
      authority.body])).rows[0];
  }

  /** Seal one admission with its exact graph receipt; a different outcome conflicts. */
  async seal(admission: VoteAdmission, proof: GraphTerminalProof): Promise<void> {
    const client = await this.connect();
    try {
      await begin(client);
      const gate = await client.query('SELECT 1 FROM access.scope_gate WHERE id = $1 FOR UPDATE', [admission.scope]);
      if (gate.rowCount !== 1) throw new AdmissionUnavailable('poll gate is unavailable');
      const row = (await client.query<AdmissionRow & { graph_receipt: string | null; graph_outcome: string | null;
        graph_data_epoch: string | null; graph_sequence: string | null }>(`SELECT *, true AS eligible
        FROM access.admission WHERE id = $1 FOR UPDATE`, [admission.id])).rows[0];
      if (!row || row.scope_id !== admission.scope || proof.admissionId !== admission.id
        || proof.scope !== row.scope_id || proof.requestDigest !== row.request_digest
        || proof.authorityEpoch !== row.authority_epoch
        || proof.receipt !== voteReceiptIri(admission.id, admission.operation)
        || !/^[0-9]+$/.test(proof.sequence) || !proof.dataEpoch) {
        throw new AdmissionConflict('graph outcome does not match vote admission');
      }
      if (row.state === 'sealed') {
        if (row.graph_receipt !== proof.receipt || row.graph_outcome !== proof.outcome
          || row.graph_data_epoch !== proof.dataEpoch || row.graph_sequence !== proof.sequence) {
          throw new AdmissionConflict('vote admission has a different terminal outcome');
        }
        await client.query('COMMIT');
        return;
      }
      await client.query(`UPDATE access.admission SET state = 'sealed', graph_receipt = $2, graph_outcome = $3,
          graph_data_epoch = $4, graph_sequence = $5, sealed_at = clock_timestamp() WHERE id = $1`,
      [admission.id, proof.receipt, proof.outcome, proof.dataEpoch, proof.sequence]);
      await client.query(`INSERT INTO access.outbox (id, kind, admission_id, scope_id, authority_epoch)
        VALUES ($1, 'admission.sealed', $2, $3, $4)`, [Bun.randomUUIDv7(), admission.id, row.scope_id,
        row.authority_epoch]);
      await client.query('COMMIT');
    } catch (error) {
      await rollback(client);
      throw error;
    } finally { client.release(); }
  }

  /** Replace the holder's representative policy under its expected head revision. */
  async setPolicy(principal: VerifiedPrincipal, change: VotePolicyChange, key: string,
    requestDigest: string): Promise<{ policy: VotePolicyHead; replayed: boolean }> {
    if (!/^[A-Za-z0-9:_./-]{1,128}$/.test(key) || !/^[0-9a-f]{64}$/.test(requestDigest)
      || !nativeId.test(change.holderCharterRevision) || !/^[0-9a-f]{64}$/.test(change.holderCharterDigest)
      || change.members.length > 256) {
      throw new AdmissionDenied('invalid representative policy intent');
    }
    const client = await this.connect();
    try {
      await begin(client);
      const identity = (await client.query<{ id: string }>(`SELECT id FROM access.principal
        WHERE account_issuer = $1 AND account_subject = $2 AND active FOR SHARE`,
      [principal.issuer, principal.subject])).rows[0];
      if (!identity) throw new AdmissionDenied('principal is inactive');
      const prior = (await client.query<{ request_digest: string; policy_id: string; revision: string }>(`
        SELECT request_digest, policy_id, revision FROM access.vote_representative_policy_receipt
        WHERE principal_id = $1 AND idempotency_key = $2`, [identity.id, key])).rows[0];
      if (prior) {
        if (prior.request_digest !== requestDigest) throw new AdmissionConflict('policy key binds another intent');
        const members = (await client.query<{ role: PolicyRole; representation_id: string; principal_id: string }>(`
          SELECT role, representation_id, principal_id FROM access.vote_representative_policy_member
          WHERE policy_id = $1 AND revision = $2 ORDER BY role, representation_id`, [prior.policy_id, prior.revision])).rows;
        const revision = (await client.query<{ charter: string; digest: string }>(`SELECT
          holder_charter_revision AS charter, holder_charter_digest AS digest
          FROM access.vote_representative_policy_revision WHERE policy_id = $1 AND revision = $2`,
        [prior.policy_id, prior.revision])).rows[0]!;
        await client.query('COMMIT');
        return { replayed: true, policy: { id: prior.policy_id, revision: prior.revision,
          holderCharterRevision: revision.charter, holderCharterDigest: revision.digest,
          members: members.map(item => ({ role: item.role, representationId: item.representation_id,
            principalId: item.principal_id })) } };
      }
      const manager = (await client.query<{ id: string; generation: string; subject_generation: string }>(`
        SELECT r.id, r.generation, s.generation AS subject_generation FROM access.representation r
        JOIN access.authority_subject s ON s.id = r.subject_id AND s.active
        WHERE r.id = $1 AND r.principal_id = $2 AND r.subject_id = $3 AND r.action = 'governance.seat.manage'
          AND r.active AND r.valid_until > clock_timestamp() FOR SHARE OF r, s`,
      [change.representationId, identity.id, change.holder])).rows[0];
      if (!manager) throw new AdmissionDenied('holder seat-management mandate required');
      const head = await this.readPolicy(client, change.holder, change.body, true);
      if ((head?.revision ?? null) !== change.expectedRevision) throw new VotePolicyStale('policy revision is stale');
      const policyId = head?.id ?? Bun.randomUUIDv7();
      const revision = String(Number(head?.revision ?? '0') + 1);
      if (!head) {
        await client.query(`INSERT INTO access.vote_representative_policy (id, holder_subject, body_subject,
          head_revision) VALUES ($1, $2, $3, 1)`, [policyId, change.holder, change.body]);
      }
      await client.query(`INSERT INTO access.vote_representative_policy_revision
        (policy_id, revision, holder_charter_revision, holder_charter_digest, authority_epoch)
        VALUES ($1, $2, $3, $4, $5)`, [policyId, revision, change.holderCharterRevision,
        change.holderCharterDigest, manager.subject_generation]);
      for (const member of change.members) {
        const mandate = (await client.query<{ generation: string; principal_id: string }>(`
          SELECT generation, principal_id FROM access.representation WHERE id = $1 FOR SHARE`,
        [member.representationId])).rows[0];
        if (!mandate) throw new VoteIneligible('policy member mandate is unavailable');
        await client.query(`INSERT INTO access.vote_representative_policy_member (policy_id, revision, role,
          representation_id, representation_generation, principal_id) VALUES ($1,$2,$3,$4,$5,$6)`,
        [policyId, revision, member.role, member.representationId, mandate.generation, mandate.principal_id]);
      }
      if (head) {
        await client.query('UPDATE access.vote_representative_policy SET head_revision = $2 WHERE id = $1',
          [policyId, revision]);
      }
      await client.query(`INSERT INTO access.vote_representative_policy_receipt (principal_id, idempotency_key,
          request_digest, policy_id, revision, authority_proof, result_authority_epoch)
        VALUES ($1,$2,$3,$4,$5,$6,$7)`, [identity.id, key, requestDigest, policyId, revision,
        { representationId: manager.id, representationGeneration: manager.generation,
          holderGeneration: manager.subject_generation }, manager.subject_generation]);
      const policy = await this.readPolicy(client, change.holder, change.body, false);
      await client.query('COMMIT');
      return { replayed: false, policy: policy! };
    } catch (error) {
      await rollback(client);
      if (error instanceof AdmissionDenied || error instanceof AdmissionConflict
        || error instanceof VotePolicyStale || error instanceof VoteIneligible) throw error;
      const code = (error as { code?: string }).code;
      if (code === '23514' || code === '23505') throw new VoteIneligible('policy members are not independent current mandates');
      throw new AdmissionUnavailable('vote policy owner is unavailable');
    } finally { client.release(); }
  }
}
