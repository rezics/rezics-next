import { createHash, randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { PROTECTION_RULE, CONTENT_DRAFT_PROTECTION, type ProtectionAction, type ProtectionMode } from './schema.ts';
import { retainedDocumentBody } from '../../../../content/src/document-body.ts';
import { validProtectionTransition } from './field-control.ts';

/** Content owner procedures for content-draft-protection-v1 over migrations 130/131.
 * Each command takes the operation lock, replays an existing receipt, then locks the
 * existing variant row before reading its basis. Triggers remain the backstop. */

export type ContentProtectionAction = 'protection.change' | 'correction.propose' | 'correction.decide';
export type ProtectionRejection = 'stale_content' | 'stale_protection' | 'stale_rule' | 'stale_review_basis'
  | 'unsupported_transition' | 'decision_exists' | 'reviewer_not_independent' | 'target_unavailable'
  | 'cancelled';
export interface OwnerPosition { owner: 'content'; dataEpoch: string; sequence: string }
export interface OwnerOutcome<T> {
  operationId: string; outcome: 'succeeded' | 'rejected'; code: ProtectionRejection | null;
  value: T | null; position: OwnerPosition; replayed: boolean;
}
export interface ProtectionState { id: string; epoch: string; action: ProtectionAction; mode: ProtectionMode; ruleRevision: string }
export interface EditorialState {
  resourceId: string; variantId: string; contentHead: string | null;
  /** Null is the profile's explicit absent head, whose effective mode is open. */
  protection: ProtectionState | null; effectiveMode: ProtectionMode; ruleRevision: typeof PROTECTION_RULE;
}
export interface CorrectionProposal {
  proposal: string; proposalRevision: string; revisionNumber: number; predecessor: string | null;
  resourceId: string; variantId: string; baseHead: string; baseProtection: string | null; ruleRevision: string;
  candidateRevision: string; candidateDigest: string; evidence: string[]; reason: string; agent: string | null;
}
export interface CorrectionDecision {
  decision: string; proposalRevision: string; outcome: 'approved' | 'rejected'; candidateDigest: string;
  independenceProof: string | null; evidence: string[]; reason: string; agent: string | null;
  application: { baseHead: string; successorHead: string; protectionHead: string | null } | null;
}
export interface CorrectionRecord { proposal: CorrectionProposal; decision: CorrectionDecision | null; candidateAvailable: boolean }

export class ProtectionIdempotencyConflict extends Error {}
export class ProtectionInvalid extends Error {}

interface Basis {
  operationId: string; requestDigest: string; resourceId: string; variantId: string;
  expectedContentHead: string; expectedProtectionHead: string | null; expectedRuleRevision: string;
  reason: string; evidence: string[]; agent: string | null;
}
export interface ProtectionChangeInput extends Basis { action: ProtectionAction }
export interface CorrectionProposalInput extends Basis {
  candidateJson: string;
  /** Present for a new revision of a rejected or undecided proposal. */
  predecessor: string | null;
  proposerKey: (proposal: string) => string;
}
export interface CorrectionDecisionInput extends Omit<Basis, 'resourceId' | 'variantId'> {
  proposalRevision: string; outcome: 'approved' | 'rejected'; expectedCandidateDigest: string;
  independenceProof: string; reviewerKey: (proposal: string) => string;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const MAX_CANDIDATE_BYTES = 1_048_576;
export const MAX_EDITORIAL_TARGETS = 50;
export const MAX_CORRECTION_PAGE = 50;
const sha = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const EVENTS: Record<ContentProtectionAction, [succeeded: string, rejected: string]> = {
  'protection.change': ['content.protection.changed', 'content.protection.rejected'],
  'correction.propose': ['content.correction.proposed', 'content.correction.rejected'],
  'correction.decide': ['content.correction.decided', 'content.correction.rejected'],
};

function validBasis(input: Basis | CorrectionDecisionInput): void {
  if (!/^[A-Za-z0-9:_./-]{1,200}$/.test(input.operationId) || !/^[0-9a-f]{64}$/.test(input.requestDigest)
    || !UUID.test(input.expectedContentHead)
    || (input.expectedProtectionHead !== null && !UUID.test(input.expectedProtectionHead))
    || input.reason.trim().length < 1 || input.reason.length > 2000 || input.evidence.length > 32
    || new Set(input.evidence).size !== input.evidence.length
    || input.evidence.some(item => item.length < 1 || item.length > 300)
    || (input.agent !== null && (input.agent.length < 1 || input.agent.length > 300))) {
    throw new ProtectionInvalid('exact bounded protection basis is required');
  }
}

async function transaction<T>(pool: Pool, work: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await work(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally { client.release(); }
}

async function record(client: PoolClient, args: { operationId: string; digest: string; action: ContentProtectionAction;
  code: ProtectionRejection | null; variantId: string | null; revisionId: string | null; payload: object }): Promise<OwnerPosition> {
  const position = (await client.query<{ data_epoch: string; sequence: string }>(`UPDATE content.owner_control
    SET sequence = sequence + 1 WHERE singleton RETURNING data_epoch::text, sequence::text`)).rows[0];
  if (!position) throw new Error('Content owner position is unavailable');
  const outcome = args.code === null ? 'succeeded' : args.code.startsWith('stale_') ? 'stale_head' : 'rejected';
  await client.query(`INSERT INTO content.receipt (operation_id, request_digest, action, outcome, variant_id, revision_id,
    reason, data_epoch, sequence) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`, [args.operationId, args.digest, args.action,
    outcome, args.variantId, args.revisionId, args.code, position.data_epoch, position.sequence]);
  await client.query(`INSERT INTO content.outbox (id, data_epoch, sequence, operation_id, event_type, recipe, revision_id, payload)
    VALUES ($1, $2, $3, $4, $5, 'editorial-protection-v1', $6, $7::jsonb)`, [randomUUID(), position.data_epoch, position.sequence,
    args.operationId, EVENTS[args.action][args.code === null ? 0 : 1], args.revisionId,
    JSON.stringify({ ...args.payload, code: args.code })]);
  return { owner: 'content', dataEpoch: position.data_epoch, sequence: position.sequence };
}

const asProtection = (row: Record<string, any>): ProtectionState => ({ id: row.id, epoch: String(row.epoch),
  action: row.action, mode: row.mode, ruleRevision: row.rule_revision });
const asProposal = (row: Record<string, any>): CorrectionProposal => ({ proposal: row.proposal_id,
  proposalRevision: row.id, revisionNumber: row.revision_number, predecessor: row.predecessor,
  resourceId: row.resource_id, variantId: row.variant_id, baseHead: row.base_head, baseProtection: row.base_protection,
  ruleRevision: row.rule_revision, candidateRevision: row.candidate_revision, candidateDigest: row.candidate_digest,
  evidence: row.evidence, reason: row.reason, agent: row.agent });
const asDecision = (row: Record<string, any>): CorrectionDecision => ({ decision: row.id,
  proposalRevision: row.proposal_revision, outcome: row.outcome, candidateDigest: row.candidate_digest,
  independenceProof: row.independence_proof, evidence: row.evidence, reason: row.reason, agent: row.agent,
  application: row.successor_head ? { baseHead: row.base_head, successorHead: row.successor_head,
    protectionHead: row.protection_head } : null });

const PROPOSAL = `SELECT p.*, v.resource_id FROM content.correction_proposal p
  JOIN content.variant v ON v.id = p.variant_id`;
const DECISION = `SELECT d.*, a.successor_head, a.protection_head FROM content.correction_decision d
  LEFT JOIN content.correction_application a ON a.decision_id = d.id`;

export class ContentProtectionStore {
  constructor(private readonly pool: Pool) {}

  /** Serialize one operation identity, replay its receipt or run the new effect once. */
  private command<T>(action: ContentProtectionAction, operationId: string, digest: string,
    work: (client: PoolClient, reject: (code: ProtectionRejection, variantId: string | null) => Promise<OwnerOutcome<T>>)
      => Promise<OwnerOutcome<T>>): Promise<OwnerOutcome<T>> {
    return transaction(this.pool, async client => {
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [operationId]);
      const saved = await client.query<{ request_digest: string; action: string; reason: string | null;
        data_epoch: string; sequence: string }>(`SELECT request_digest, action, reason, data_epoch::text, sequence::text
        FROM content.receipt WHERE operation_id = $1`, [operationId]);
      const row = saved.rows[0];
      if (row) {
        if (row.request_digest !== digest || row.action !== action) {
          throw new ProtectionIdempotencyConflict('operation identity belongs to a different request');
        }
        return { operationId, outcome: row.reason ? 'rejected' : 'succeeded', code: row.reason as ProtectionRejection | null,
          value: row.reason ? null : await this.recorded(client, action, operationId) as T,
          position: { owner: 'content', dataEpoch: row.data_epoch, sequence: row.sequence }, replayed: true };
      }
      return work(client, async (code, variantId) => ({ operationId, outcome: 'rejected', code, value: null,
        position: await record(client, { operationId, digest, action, code, variantId, revisionId: null,
          payload: { variantId } }), replayed: false }));
    });
  }

  private async recorded(client: PoolClient, action: ContentProtectionAction, operationId: string): Promise<unknown> {
    if (action === 'protection.change') {
      const row = (await client.query('SELECT * FROM content.protection_revision WHERE operation_id = $1', [operationId])).rows[0];
      if (!row) throw new Error('recorded protection revision is missing');
      return asProtection(row);
    }
    if (action === 'correction.propose') {
      const row = (await client.query(`${PROPOSAL} WHERE p.operation_id = $1`, [operationId])).rows[0];
      if (!row) throw new Error('recorded correction proposal is missing');
      return asProposal(row);
    }
    const row = (await client.query(`${DECISION} WHERE d.operation_id = $1`, [operationId])).rows[0];
    if (!row) throw new Error('recorded correction decision is missing');
    return asDecision(row);
  }

  private async lockTarget(client: PoolClient, variantId: string, resourceId: string | null) {
    const row = (await client.query<{ id: string; resource_id: string; draft_head: string | null; protection_head: string | null;
      mode: ProtectionMode | null; epoch: string | null; rule_revision: string | null }>(`SELECT v.id, v.resource_id, v.draft_head,
      v.protection_head, p.mode, p.epoch::text, p.rule_revision FROM content.variant v
      LEFT JOIN content.protection_revision p ON p.id = v.protection_head WHERE v.id = $1 FOR UPDATE OF v`, [variantId])).rows[0];
    return row && (resourceId === null || row.resource_id === resourceId) ? row : null;
  }

  async changeProtection(input: ProtectionChangeInput): Promise<OwnerOutcome<ProtectionState>> {
    validBasis(input);
    if (!['tighten', 'confirm', 'relax'].includes(input.action)) throw new ProtectionInvalid('unsupported protection action');
    return this.command('protection.change', input.operationId, input.requestDigest, async (client, reject) => {
      const target = await this.lockTarget(client, input.variantId, input.resourceId);
      if (!target) return reject('target_unavailable', null);
      if (target.draft_head !== input.expectedContentHead) return reject('stale_content', target.id);
      if (target.protection_head !== input.expectedProtectionHead) return reject('stale_protection', target.id);
      if (input.expectedRuleRevision !== PROTECTION_RULE) return reject('stale_rule', target.id);
      const mode = target.mode ?? 'open';
      if (!validProtectionTransition(mode, input.action)) {
        return reject('unsupported_transition', target.id);
      }
      const id = randomUUID(), epoch = BigInt(target.epoch ?? '0') + 1n;
      const position = await record(client, { operationId: input.operationId, digest: input.requestDigest,
        action: 'protection.change', code: null, variantId: target.id, revisionId: null,
        payload: { variantId: target.id, protection: id, predecessor: target.protection_head } });
      const row = (await client.query(`INSERT INTO content.protection_revision (id, variant_id, predecessor, epoch, profile,
        action, mode, rule_revision, observed_head, reason, evidence, agent, operation_id)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb, $12, $13) RETURNING *`, [id, target.id,
        target.protection_head, epoch.toString(), CONTENT_DRAFT_PROTECTION, input.action,
        input.action === 'relax' ? 'open' : 'review-required', PROTECTION_RULE, target.draft_head, input.reason,
        JSON.stringify(input.evidence), input.agent, input.operationId])).rows[0];
      return { operationId: input.operationId, outcome: 'succeeded', code: null, value: asProtection(row),
        position, replayed: false };
    });
  }

  async proposeCorrection(input: CorrectionProposalInput): Promise<OwnerOutcome<CorrectionProposal>> {
    validBasis(input);
    const bytes = Buffer.from(input.candidateJson, 'utf8');
    let body: unknown;
    try { body = JSON.parse(input.candidateJson); } catch { throw new ProtectionInvalid('candidate is not JSON'); }
    if (!body || typeof body !== 'object' || Array.isArray(body) || bytes.length > MAX_CANDIDATE_BYTES
      || (input.predecessor !== null && !UUID.test(input.predecessor))) {
      throw new ProtectionInvalid('candidate must be a bounded JSON object');
    }
    if ('document' in body) {
      try { retainedDocumentBody(body as Record<string, unknown>); }
      catch { throw new ProtectionInvalid('invalid correction document projection'); }
    }
    return this.command('correction.propose', input.operationId, input.requestDigest, async (client, reject) => {
      const target = await this.lockTarget(client, input.variantId, input.resourceId);
      if (!target) return reject('target_unavailable', null);
      if (target.draft_head !== input.expectedContentHead) return reject('stale_content', target.id);
      if (target.protection_head !== input.expectedProtectionHead) return reject('stale_protection', target.id);
      if (input.expectedRuleRevision !== PROTECTION_RULE) return reject('stale_rule', target.id);
      let proposal: string = randomUUID(), revisionNumber = 1;
      if (input.predecessor) {
        const prior = (await client.query<{ proposal_id: string; revision_number: number; variant_id: string; applied: boolean }>(
          `SELECT p.proposal_id, p.revision_number, p.variant_id, EXISTS (SELECT 1 FROM content.correction_application a
            WHERE a.proposal_revision = p.id) AS applied FROM content.correction_proposal p WHERE p.id = $1`,
          [input.predecessor])).rows[0];
        const latest = prior && (await client.query(`SELECT 1 FROM content.correction_proposal
          WHERE proposal_id = $1 AND revision_number = $2`, [prior.proposal_id, prior.revision_number + 1])).rowCount === 0;
        if (!prior || prior.variant_id !== target.id || prior.applied || !latest) return reject('stale_review_basis', target.id);
        proposal = prior.proposal_id; revisionNumber = prior.revision_number + 1;
      }
      const id = randomUUID(), candidate = randomUUID(), digest = sha(bytes);
      const position = await record(client, { operationId: input.operationId, digest: input.requestDigest,
        action: 'correction.propose', code: null, variantId: target.id, revisionId: null,
        payload: { variantId: target.id, proposal, proposalRevision: id } });
      await client.query(`INSERT INTO content.revision (id, variant_id, predecessor, operation_id, format, model, provenance,
        byte_digest, byte_length, serialized_bytes, body) VALUES ($1, $2, $3, $4, 'rezics-content-json-v1', 'content-shape-v1',
        $5::jsonb, $6, $7, $8, $9::jsonb)`, [candidate, target.id, target.draft_head, input.operationId,
        JSON.stringify({ kind: 'correction-candidate-v1', proposal, proposalRevision: id }), digest, bytes.length, bytes,
        input.candidateJson]);
      const row = (await client.query(`INSERT INTO content.correction_proposal (id, proposal_id, revision_number, predecessor,
        variant_id, profile, base_head, base_protection, rule_revision, candidate_revision, candidate_digest, evidence, reason,
        agent, operation_id, proposer_key) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12::jsonb, $13, $14, $15, $16)
        RETURNING *, $17::text AS resource_id`, [id, proposal, revisionNumber, input.predecessor, target.id,
        CONTENT_DRAFT_PROTECTION, target.draft_head, target.protection_head, PROTECTION_RULE, candidate, digest,
        JSON.stringify(input.evidence), input.reason, input.agent, input.operationId, input.proposerKey(proposal),
        target.resource_id])).rows[0];
      return { operationId: input.operationId, outcome: 'succeeded', code: null, value: asProposal(row), position, replayed: false };
    });
  }

  /** One terminal decision per proposal revision; approval applies the candidate in the same commit. */
  async decideCorrection(input: CorrectionDecisionInput): Promise<OwnerOutcome<CorrectionDecision>> {
    validBasis(input);
    if (!UUID.test(input.proposalRevision) || !/^[0-9a-f]{64}$/.test(input.expectedCandidateDigest)
      || !['approved', 'rejected'].includes(input.outcome) || !/^urn:rezics:[a-z-]+:[0-9a-f-]{36}$/.test(input.independenceProof)) {
      throw new ProtectionInvalid('exact proposal decision is required');
    }
    return this.command('correction.decide', input.operationId, input.requestDigest, async (client, reject) => {
      const proposal = (await client.query(`${PROPOSAL} WHERE p.id = $1`, [input.proposalRevision])).rows[0];
      if (!proposal) return reject('target_unavailable', null);
      const target = await this.lockTarget(client, proposal.variant_id, null);
      if (!target) return reject('target_unavailable', null);
      if ((await client.query('SELECT 1 FROM content.correction_decision WHERE proposal_revision = $1',
        [proposal.id])).rowCount) return reject('decision_exists', target.id);
      if (!proposal.proposer_key || proposal.proposer_key === input.reviewerKey(proposal.proposal_id)) {
        return reject('reviewer_not_independent', target.id);
      }
      // The decision binds the exact proposal; a changed proposal or rule needs a new review basis.
      if (proposal.candidate_digest !== input.expectedCandidateDigest || proposal.rule_revision !== input.expectedRuleRevision
        || proposal.base_head !== input.expectedContentHead || proposal.base_protection !== input.expectedProtectionHead) {
        return reject('stale_review_basis', target.id);
      }
      if (input.outcome === 'approved') {
        const candidate = (await client.query<{ availability: string }>(
          'SELECT availability FROM content.revision WHERE id = $1', [proposal.candidate_revision])).rows[0];
        if (target.draft_head !== proposal.base_head || target.protection_head !== proposal.base_protection
          || candidate?.availability !== 'available') return reject('stale_review_basis', target.id);
      }
      const id = randomUUID(), approved = input.outcome === 'approved';
      const position = await record(client, { operationId: input.operationId, digest: input.requestDigest,
        action: 'correction.decide', code: null, variantId: target.id,
        revisionId: approved ? proposal.candidate_revision : null,
        payload: { variantId: target.id, proposalRevision: proposal.id, decision: id, outcome: input.outcome } });
      await client.query(`INSERT INTO content.correction_decision (id, proposal_revision, variant_id, base_head,
        candidate_revision, candidate_digest, rule_revision, outcome, independence_proof, evidence, reason, agent, operation_id)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11, $12, $13)`, [id, proposal.id, target.id, proposal.base_head,
        proposal.candidate_revision, proposal.candidate_digest, proposal.rule_revision, input.outcome, input.independenceProof,
        JSON.stringify(input.evidence), input.reason, input.agent, input.operationId]);
      if (approved) {
        await client.query(`INSERT INTO content.correction_application (proposal_revision, decision_id, variant_id, base_head,
          successor_head, candidate_digest, rule_revision, protection_head, operation_id)
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`, [proposal.id, id, target.id, proposal.base_head,
          proposal.candidate_revision, proposal.candidate_digest, proposal.rule_revision, target.protection_head, input.operationId]);
      }
      const row = (await client.query(`${DECISION} WHERE d.id = $1`, [id])).rows[0];
      return { operationId: input.operationId, outcome: 'succeeded', code: null, value: asDecision(row), position, replayed: false };
    });
  }

  /** Terminal cancellation under the same operation identity: exactly one of it and the effect wins. */
  cancel(action: ContentProtectionAction, operationId: string, requestDigest: string): Promise<OwnerOutcome<unknown>> {
    return this.command(action, operationId, requestDigest, async (_client, reject) => reject('cancelled', null));
  }

  async readReceipt(operationId: string): Promise<{ action: string; requestDigest: string } | null> {
    const row = (await this.pool.query<{ action: string; request_digest: string }>(
      'SELECT action, request_digest FROM content.receipt WHERE operation_id = $1', [operationId])).rows[0];
    return row ? { action: row.action, requestDigest: row.request_digest } : null;
  }

  /** At most 50 targets in one indexed read; missing targets are omitted, never defaulted to open. */
  async editorialStates(variantIds: string[]): Promise<EditorialState[]> {
    if (variantIds.length > MAX_EDITORIAL_TARGETS || new Set(variantIds).size !== variantIds.length) {
      throw new ProtectionInvalid('at most 50 distinct targets');
    }
    const rows = await this.pool.query(`SELECT v.id AS variant_id, v.resource_id, v.draft_head, p.id, p.epoch, p.action,
      p.mode, p.rule_revision FROM content.variant v LEFT JOIN content.protection_revision p ON p.id = v.protection_head
      WHERE v.id = ANY($1::text[])`, [variantIds]);
    return rows.rows.map(row => ({ resourceId: row.resource_id, variantId: row.variant_id, contentHead: row.draft_head,
      protection: row.id ? asProtection(row) : null, effectiveMode: row.mode ?? 'open', ruleRevision: PROTECTION_RULE }));
  }

  async readCorrection(proposalRevision: string): Promise<CorrectionRecord | null> {
    if (!UUID.test(proposalRevision)) throw new ProtectionInvalid('invalid proposal revision');
    const proposal = (await this.pool.query(`${PROPOSAL} WHERE p.id = $1`, [proposalRevision])).rows[0];
    if (!proposal) return null;
    const decision = (await this.pool.query(`${DECISION} WHERE d.proposal_revision = $1`, [proposalRevision])).rows[0];
    const candidate = (await this.pool.query<{ availability: string }>('SELECT availability FROM content.revision WHERE id = $1',
      [proposal.candidate_revision])).rows[0];
    return { proposal: asProposal(proposal), decision: decision ? asDecision(decision) : null,
      candidateAvailable: candidate?.availability === 'available' };
  }

  /** Newest first on the (variant, created_at, id) index; the cursor is the last returned key. */
  async listCorrections(variantId: string, after: { createdAt: string; id: string } | null, limit = MAX_CORRECTION_PAGE)
    : Promise<{ items: CorrectionProposal[]; next: { createdAt: string; id: string } | null }> {
    if (!Number.isInteger(limit) || limit < 1 || limit > MAX_CORRECTION_PAGE
      || (after && (!UUID.test(after.id) || after.createdAt.length > 80
        || !Number.isFinite(Date.parse(after.createdAt))))) throw new ProtectionInvalid('invalid page');
    const rows = (await this.pool.query(`SELECT p.*, v.resource_id, p.created_at::text AS created_key
      FROM content.correction_proposal p JOIN content.variant v ON v.id = p.variant_id WHERE p.variant_id = $1
      AND ($2::timestamptz IS NULL OR (p.created_at, p.id) < ($2::timestamptz, $3::uuid))
      ORDER BY p.created_at DESC, p.id DESC LIMIT $4`, [variantId, after?.createdAt ?? null, after?.id ?? null, limit + 1])).rows;
    const page = rows.slice(0, limit), last = page.at(-1);
    return { items: page.map(asProposal),
      next: rows.length > limit && last ? { createdAt: last.created_key, id: last.id } : null };
  }
}
