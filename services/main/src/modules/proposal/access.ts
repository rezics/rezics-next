import { createHash, randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { lockAdmissionKey } from '../access/scope-gates.ts';
import { AdmissionConflict, AdmissionDenied, AdmissionUnavailable,
  type GraphTerminalProof, type RegisteredAdmission, type VerifiedPrincipal } from '../access/admission.ts';
import { governanceBodyScopeId, proposalExecutionAction } from './schema.ts';

export interface ProposalExecutionBasis {
  proposal: string; proposalRevision: string; resolution: string; body: string;
  effectDigest: string; effectTarget: string; expectedTargetState: string;
  capability: 'access.org.roster.policy'; capabilityScope: string;
  capabilityGrantId: string; representationId: string;
}
export interface ProposalExecutionAdmission extends RegisteredAdmission {
  basis: ProposalExecutionBasis;
}

type Row = { id: string; principal_id: string; acting_subject: string; scope_id: string;
  action: string; idempotency_key: string; request_digest: string; authority_epoch: string;
  registered_at: Date; expires_at: Date; state: RegisteredAdmission['state'];
  graph_receipt: string | null; graph_outcome: string | null; graph_data_epoch: string | null;
  graph_sequence: string | null };

export const proposalReceiptIri = (admissionId: string) => {
  const hash = createHash('sha256').update(`${admissionId}\0proposal-execution`).digest('hex');
  return `urn:rezics:receipt:${hash}`;
};

const native = /^https:\/\/rezics\.com\/id\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const digest = /^[0-9a-f]{64}$/;
const keyPattern = /^[A-Za-z0-9:_./-]{1,128}$/;

function scopeFor(target: string): string { return `access:org-roster:${target.slice(-36)}`; }
function valid(basis: ProposalExecutionBasis, key: string, requestDigest: string): boolean {
  return native.test(basis.proposal) && native.test(basis.proposalRevision) && native.test(basis.resolution)
    && native.test(basis.body) && native.test(basis.effectTarget)
    && basis.capability === 'access.org.roster.policy'
    && basis.capabilityScope === scopeFor(basis.effectTarget)
    && uuid.test(basis.capabilityGrantId) && uuid.test(basis.representationId)
    && digest.test(basis.effectDigest) && digest.test(basis.expectedTargetState)
    && keyPattern.test(key) && digest.test(requestDigest);
}
async function begin(client: PoolClient): Promise<void> {
  await client.query('BEGIN');
  await client.query("SET LOCAL lock_timeout = '2s'");
  await client.query("SET LOCAL statement_timeout = '5s'");
  const fence = (await client.query<{ open: boolean }>(
    'SELECT open FROM access.recovery_fence WHERE id = true FOR SHARE')).rows[0];
  if (!fence?.open) throw new AdmissionUnavailable('Access is held for recovery');
}
async function rollback(client: PoolClient): Promise<void> {
  try { await client.query('ROLLBACK'); } catch { /* preserve cause */ }
}
function admitted(row: Row, basis: ProposalExecutionBasis, replayed: boolean,
  dispatchEligible: boolean): ProposalExecutionAdmission {
  return { id: row.id, principalId: row.principal_id, actingSubject: row.acting_subject,
    scope: row.scope_id, action: row.action, idempotencyKey: row.idempotency_key,
    requestDigest: row.request_digest, authorityEpoch: row.authority_epoch,
    registeredAt: row.registered_at.toISOString(), expiresAt: row.expires_at.toISOString(),
    state: row.state, dispatchEligible, replayed, basis };
}

/** Access proof and one reservation; O(1) indexed body/grant/mandate reads. */
export class AccessProposalExecutions {
  constructor(private readonly pool: Pool) {}

  private async prior(client: PoolClient, principal: VerifiedPrincipal, key: string,
    requestDigest: string, basis: ProposalExecutionBasis): Promise<ProposalExecutionAdmission | null> {
    const row = (await client.query<Row>(`SELECT a.* FROM access.admission a JOIN access.principal p
      ON p.id = a.principal_id AND p.active
      WHERE p.account_issuer = $1 AND p.account_subject = $2 AND a.action = $3
        AND a.idempotency_key = $4 FOR UPDATE`,
    [principal.issuer, principal.subject, proposalExecutionAction, key])).rows[0];
    if (!row) return null;
    const proof = (await client.query<{ proposal: string; proposal_revision: string; resolution: string;
      body_subject: string; effect_digest: string; effect_target: string; expected_target_state: string;
      capability: string; capability_scope: string; capability_grant_id: string; representation_id: string }>(
      `SELECT proposal, proposal_revision, resolution, body_subject, effect_digest, effect_target,
        expected_target_state, capability, capability_scope, capability_grant_id, representation_id
        FROM access.proposal_execution_admission WHERE admission_id = $1`, [row.id])).rows[0];
    if (row.request_digest !== requestDigest || row.scope_id !== governanceBodyScopeId(basis.body)
      || !proof || proof.proposal !== basis.proposal || proof.proposal_revision !== basis.proposalRevision
      || proof.resolution !== basis.resolution || proof.body_subject !== basis.body
      || proof.effect_digest !== basis.effectDigest || proof.effect_target !== basis.effectTarget
      || proof.expected_target_state !== basis.expectedTargetState
      || proof.capability !== basis.capability || proof.capability_scope !== basis.capabilityScope
      || proof.capability_grant_id !== basis.capabilityGrantId || proof.representation_id !== basis.representationId) {
      throw new AdmissionConflict('proposal operation ID binds another effect');
    }
    return admitted(row, basis, true, row.state === 'claimed' && row.expires_at > new Date());
  }

  async replay(principal: VerifiedPrincipal, basis: ProposalExecutionBasis, key: string,
    requestDigest: string): Promise<ProposalExecutionAdmission | null> {
    if (!valid(basis, key, requestDigest)) throw new AdmissionDenied('invalid proposal execution');
    const client = await this.pool.connect();
    try {
      await begin(client);
      const prior = await this.prior(client, principal, key, requestDigest, basis);
      await client.query('COMMIT');
      return prior;
    } catch (error) { await rollback(client); throw error; } finally { client.release(); }
  }

  async readTargetState(organization: string): Promise<{ policyRevision: string; admissionsOpen: boolean }> {
    const row = (await this.pool.query<{ revision: string; open: boolean }>(`SELECT revision::text, open
      FROM access.membership_policy WHERE kind = 'org' AND owner_subject = $1`, [organization])).rows[0];
    if (!row) throw new AdmissionDenied('organization roster policy is unavailable');
    return { policyRevision: row.revision, admissionsOpen: row.open };
  }

  async admit(principal: VerifiedPrincipal, basis: ProposalExecutionBasis, key: string,
    requestDigest: string): Promise<ProposalExecutionAdmission> {
    if (!valid(basis, key, requestDigest)) throw new AdmissionDenied('invalid proposal execution');
    const client = await this.pool.connect();
    try {
      await begin(client);
      const scope = governanceBodyScopeId(basis.body);
      await client.query('INSERT INTO access.scope_gate (id) VALUES ($1) ON CONFLICT DO NOTHING', [scope]);
      const gate = (await client.query<{ authority_epoch: string; open: boolean; dispatch_open: boolean }>(
        'SELECT authority_epoch, open, dispatch_open FROM access.scope_gate WHERE id = $1 FOR SHARE',
      [scope])).rows[0];
      if (!gate?.open || !gate.dispatch_open) throw new AdmissionDenied('body execution gate is closed');
      const identity = (await client.query<{ id: string; enforcement_epoch: string }>(`SELECT id,
        enforcement_epoch FROM access.principal WHERE account_issuer = $1 AND account_subject = $2
        AND active FOR SHARE`, [principal.issuer, principal.subject])).rows[0];
      if (!identity) throw new AdmissionDenied('principal is inactive');
      await lockAdmissionKey(client, identity.id, proposalExecutionAction, key);
      const prior = await this.prior(client, principal, key, requestDigest, basis);
      if (prior) { await client.query('COMMIT'); return prior; }
      const mandate = (await client.query<{ id: string; generation: string; valid_until: Date;
        body_generation: string }>(`SELECT r.id, r.generation::text, r.valid_until,
        s.generation::text AS body_generation FROM access.representation r
        JOIN access.authority_subject s ON s.id = r.subject_id AND s.active
        WHERE r.id = $1 AND r.principal_id = $2 AND r.subject_id = $3
          AND r.action = $4 AND r.active AND r.valid_until > clock_timestamp()
        FOR SHARE OF r, s`,
      [basis.representationId, identity.id, basis.body, proposalExecutionAction])).rows[0];
      const grant = (await client.query<{ id: string; generation: string; valid_until: Date }>(`
        SELECT id, generation::text, valid_until FROM access.permission_grant
        WHERE id = $1 AND issuer_subject = $2 AND recipient_subject = $2
          AND scope_id = $3 AND action = $4 AND active AND membership_id IS NULL
          AND valid_until > clock_timestamp() FOR SHARE`,
      [basis.capabilityGrantId, basis.body, basis.capabilityScope, basis.capability])).rows[0];
      if (!mandate || !grant) throw new AdmissionDenied('current body mandate and capability grant required');
      const row = (await client.query<Row>(`INSERT INTO access.admission (id, principal_id,
        acting_subject, scope_id, action, idempotency_key, request_digest, authority_epoch,
        registered_at, expires_at, state, claimed_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,clock_timestamp(),
          LEAST(clock_timestamp() + interval '30 seconds',$9::timestamptz,$10::timestamptz),
          'claimed',clock_timestamp()) RETURNING *`,
      [randomUUID(), identity.id, basis.body, scope, proposalExecutionAction, key,
        requestDigest, gate.authority_epoch, mandate.valid_until, grant.valid_until])).rows[0]!;
      await client.query(`INSERT INTO access.proposal_execution_admission (admission_id, proposal,
        proposal_revision, resolution, body_subject, effect_digest, effect_target,
        expected_target_state, capability, capability_scope, capability_grant_id,
        capability_grant_generation, representation_id, representation_generation,
        principal_epoch, body_generation)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)`,
      [row.id, basis.proposal, basis.proposalRevision, basis.resolution, basis.body,
        basis.effectDigest, basis.effectTarget, basis.expectedTargetState,
        basis.capability, basis.capabilityScope, grant.id, grant.generation,
        mandate.id, mandate.generation, identity.enforcement_epoch, mandate.body_generation]);
      await client.query(`INSERT INTO access.admission_receipt
        (admission_id, principal_id, action, idempotency_key, request_digest, outcome)
        VALUES ($1,$2,$3,$4,$5,'registered')`, [row.id, identity.id, proposalExecutionAction, key, requestDigest]);
      await client.query(`INSERT INTO access.outbox (id, kind, admission_id, scope_id, authority_epoch)
        VALUES ($1,'admission.registered',$3,$4,$5),($2,'admission.claimed',$3,$4,$5)`,
      [randomUUID(), randomUUID(), row.id, scope, gate.authority_epoch]);
      await client.query('COMMIT');
      return admitted(row, basis, false, true);
    } catch (error) {
      await rollback(client);
      if (error instanceof AdmissionDenied || error instanceof AdmissionConflict || error instanceof AdmissionUnavailable) throw error;
      if ((error as { code?: string }).code === '23505') throw new AdmissionConflict('proposal already has an execution');
      throw new AdmissionUnavailable('proposal execution owner is unavailable');
    } finally { client.release(); }
  }

  async assertCurrent(client: PoolClient, admission: ProposalExecutionAdmission): Promise<void> {
    const row = (await client.query<{ authority_epoch: string }>(`SELECT g.authority_epoch::text
      FROM access.proposal_execution_admission x JOIN access.admission a ON a.id = x.admission_id
      JOIN access.scope_gate g ON g.id = a.scope_id AND g.open AND g.dispatch_open
      JOIN access.principal p ON p.id = a.principal_id AND p.active
        AND p.enforcement_epoch = x.principal_epoch
      JOIN access.authority_subject s ON s.id = x.body_subject AND s.active
        AND s.generation = x.body_generation
      JOIN access.representation r ON r.id = x.representation_id AND r.active
        AND r.principal_id = a.principal_id AND r.subject_id = x.body_subject
        AND r.action = a.action AND r.generation = x.representation_generation
        AND r.valid_until > clock_timestamp()
      JOIN access.permission_grant c ON c.id = x.capability_grant_id AND c.active
        AND c.issuer_subject = x.body_subject AND c.recipient_subject = x.body_subject
        AND c.scope_id = x.capability_scope AND c.action = x.capability
        AND c.generation = x.capability_grant_generation AND c.valid_until > clock_timestamp()
      WHERE a.id = $1 AND a.state = 'claimed' AND a.expires_at > clock_timestamp()
        AND a.authority_epoch = g.authority_epoch
      FOR SHARE OF a, g, p, s, r, c`, [admission.id])).rows[0];
    if (!row) throw new AdmissionDenied('execution mandate or capability changed');
  }

  async seal(admission: ProposalExecutionAdmission, proof: GraphTerminalProof): Promise<void> {
    const client = await this.pool.connect();
    try {
      await begin(client);
      const row = (await client.query<Row>('SELECT * FROM access.admission WHERE id = $1 FOR UPDATE',
        [admission.id])).rows[0];
      if (!row || proof.admissionId !== row.id || proof.receipt !== proposalReceiptIri(row.id)
        || proof.requestDigest !== row.request_digest || proof.scope !== row.scope_id
        || proof.authorityEpoch !== row.authority_epoch || proof.outcome !== 'succeeded') {
        throw new AdmissionConflict('proposal graph receipt differs');
      }
      if (row.state === 'sealed') {
        if (row.graph_receipt !== proof.receipt || row.graph_outcome !== proof.outcome
          || row.graph_data_epoch !== proof.dataEpoch || row.graph_sequence !== proof.sequence) {
          throw new AdmissionConflict('proposal execution already sealed differently');
        }
      } else {
        await client.query(`UPDATE access.admission SET state = 'sealed', graph_receipt = $2,
          graph_outcome = $3, graph_data_epoch = $4, graph_sequence = $5,
          sealed_at = clock_timestamp() WHERE id = $1`,
        [row.id, proof.receipt, proof.outcome, proof.dataEpoch, proof.sequence]);
        await client.query(`INSERT INTO access.outbox (id, kind, admission_id, scope_id, authority_epoch)
          VALUES ($1,'admission.sealed',$2,$3,$4)`,
        [randomUUID(), row.id, row.scope_id, row.authority_epoch]);
      }
      await client.query('COMMIT');
    } catch (error) { await rollback(client); throw error; } finally { client.release(); }
  }
}
