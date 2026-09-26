import type { Pool, PoolClient } from 'pg';
import type { VerifiedPrincipal } from './admission.ts';
import { ControlDenied, ControlInvalid, ControlStale, type ControlReceipt,
  WORK_SCOPE, agentPattern, bumpEpoch, controlTransaction, generationPattern, idPattern,
  lockGate, receipted, requireAgent, requireCeiling, requireMandate, requirePrincipal,
  requireReceipt } from './topology-control.ts';

const MANAGE = 'access.representation.manage';
const ASSIGN = 'access.representation.assign.work.create';
const actionPattern = /^[a-z][a-z0-9.-]{0,127}$/;

export interface PolicyCeiling {
  actions: string[]; maxRepresentatives: number; maxMandateDays: number;
}
export interface PolicyView extends Record<string, unknown> {
  policyId: string; institutionSubject: string; approvalSubject: string;
  activeRevision: string; generation: string; ceiling: PolicyCeiling; rosterSize: number;
}

export function validCeiling(ceiling: PolicyCeiling): boolean {
  return Array.isArray(ceiling.actions) && ceiling.actions.length >= 1
    && ceiling.actions.length <= 32 && new Set(ceiling.actions).size === ceiling.actions.length
    && ceiling.actions.every(action => actionPattern.test(action))
    && Number.isInteger(ceiling.maxRepresentatives) && ceiling.maxRepresentatives >= 1
    && ceiling.maxRepresentatives <= 256 && Number.isInteger(ceiling.maxMandateDays)
    && ceiling.maxMandateDays >= 1 && ceiling.maxMandateDays <= 366;
}

/** Same comparison as the owner guard: any wider action, roster or lifetime. */
export function widens(next: PolicyCeiling, base: PolicyCeiling): boolean {
  return next.actions.some(action => !base.actions.includes(action))
    || next.maxRepresentatives > base.maxRepresentatives
    || next.maxMandateDays > base.maxMandateDays;
}

export async function activePolicy(client: PoolClient, policyId: string, institution: string,
  lock: boolean): Promise<PolicyView> {
  const row = await client.query<{ approval_subject: string; active_revision: string;
    generation: string; actions: string[]; max_representatives: number;
    max_mandate_days: number }>(`SELECT p.approval_subject, p.active_revision, p.generation,
    v.actions, v.max_representatives, v.max_mandate_days FROM access.representative_policy p
    JOIN access.representative_policy_revision v
      ON v.policy_id = p.id AND v.revision = p.active_revision
    WHERE p.id = $1 AND p.institution_subject = $2 ${lock ? 'FOR UPDATE OF p' : ''}`,
  [policyId, institution]);
  const policy = row.rows[0];
  if (!policy) throw new ControlDenied('policy is unavailable to this institution');
  const roster = await client.query<{ count: string }>(`SELECT count(*) FROM (SELECT 1
    FROM access.representation WHERE representative_policy_id = $1 AND active
      AND valid_until > clock_timestamp() LIMIT 257) live`, [policyId]);
  return { policyId, institutionSubject: institution, approvalSubject: policy.approval_subject,
    activeRevision: policy.active_revision, generation: policy.generation,
    ceiling: { actions: policy.actions, maxRepresentatives: policy.max_representatives,
      maxMandateDays: policy.max_mandate_days }, rosterSize: Number(roster.rows[0]!.count) };
}

/** Appends the next revision and moves the active pointer in one transaction. */
export async function appendPolicyRevision(client: PoolClient, policy: PolicyView,
  ceiling: PolicyCeiling, principalId: string, protectedChangeId: string | null): Promise<string> {
  const revision = (BigInt(policy.activeRevision) + 1n).toString();
  await client.query(`INSERT INTO access.representative_policy_revision (policy_id, revision,
    base_revision, actions, max_representatives, max_mandate_days, widening, protected_change_id,
    created_by_principal) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
  [policy.policyId, revision, policy.activeRevision, ceiling.actions, ceiling.maxRepresentatives,
    ceiling.maxMandateDays, widens(ceiling, policy.ceiling), protectedChangeId, principalId]);
  await client.query(`UPDATE access.representative_policy SET active_revision = $2 WHERE id = $1`,
    [policy.policyId, revision]);
  return revision;
}

/** Institutional representative policy (IAM32): the institution manages its
 * roster inside the approved ceiling; widening goes through a protected change
 * approved by the declared grantor. */
export class AccessRepresentativePolicies {
  constructor(private readonly pool: Pool) {}

  async create(principal: VerifiedPrincipal, receipt: ControlReceipt, input: {
    policyId: string; institutionSubject: string; approvalSubject: string;
    ceiling: PolicyCeiling }): Promise<PolicyView & { replayed: boolean }> {
    requireReceipt(receipt);
    if (!idPattern.test(input.policyId) || !agentPattern.test(input.institutionSubject)
      || !agentPattern.test(input.approvalSubject)
      || input.approvalSubject === input.institutionSubject || !validCeiling(input.ceiling)) {
      throw new ControlInvalid('invalid representative policy');
    }
    return controlTransaction(this.pool, async client => {
      await lockGate(client, WORK_SCOPE, true);
      const actor = await requirePrincipal(client, principal);
      await requireMandate(client, actor.id, input.institutionSubject, MANAGE);
      return receipted<PolicyView>(client, actor.id, receipt, 'representative-policy',
        'create', input.institutionSubject, input.policyId, async () => {
          await requireAgent(client, input.approvalSubject);
          await client.query(`INSERT INTO access.representative_policy (id, institution_subject,
            approval_subject, active_revision, created_by_principal) VALUES ($1,$2,$3,1,$4)`,
          [input.policyId, input.institutionSubject, input.approvalSubject, actor.id]);
          await client.query(`INSERT INTO access.representative_policy_revision (policy_id,
            revision, actions, max_representatives, max_mandate_days, widening,
            created_by_principal) VALUES ($1,1,$2,$3,$4,false,$5)`,
          [input.policyId, input.ceiling.actions, input.ceiling.maxRepresentatives,
            input.ceiling.maxMandateDays, actor.id]);
          const epoch = await bumpEpoch(client, WORK_SCOPE);
          return { epoch, result: await activePolicy(client, input.policyId,
            input.institutionSubject, false) };
        });
    });
  }

  /** A revision inside the active ceiling needs no grantor approval. */
  async revise(principal: VerifiedPrincipal, receipt: ControlReceipt, input: {
    policyId: string; institutionSubject: string; expectedGeneration: string;
    ceiling: PolicyCeiling }): Promise<PolicyView & { replayed: boolean }> {
    requireReceipt(receipt);
    if (!idPattern.test(input.policyId) || !agentPattern.test(input.institutionSubject)
      || !generationPattern.test(input.expectedGeneration) || !validCeiling(input.ceiling)) {
      throw new ControlInvalid('invalid representative policy revision');
    }
    return controlTransaction(this.pool, async client => {
      await lockGate(client, WORK_SCOPE, true);
      const actor = await requirePrincipal(client, principal);
      await requireMandate(client, actor.id, input.institutionSubject, MANAGE);
      return receipted<PolicyView>(client, actor.id, receipt, 'representative-policy',
        'revise', input.institutionSubject, input.policyId, async () => {
          const policy = await activePolicy(client, input.policyId, input.institutionSubject, true);
          if (policy.generation !== input.expectedGeneration) {
            throw new ControlStale('representative policy generation changed');
          }
          if (widens(input.ceiling, policy.ceiling)) {
            throw new ControlDenied('widening requires the approval subject');
          }
          await appendPolicyRevision(client, policy, input.ceiling, actor.id, null);
          const epoch = await bumpEpoch(client, WORK_SCOPE);
          return { epoch, result: await activePolicy(client, input.policyId,
            input.institutionSubject, false) };
        });
    });
  }

  async read(principal: VerifiedPrincipal, policyId: string,
    institutionSubject: string): Promise<PolicyView> {
    if (!idPattern.test(policyId) || !agentPattern.test(institutionSubject)) {
      throw new ControlInvalid('invalid representative policy read');
    }
    return controlTransaction(this.pool, async client => {
      await lockGate(client, WORK_SCOPE, false);
      const actor = await requirePrincipal(client, principal);
      await requireMandate(client, actor.id, institutionSubject, MANAGE);
      return activePolicy(client, policyId, institutionSubject, false);
    });
  }

  /** Accepts a recipient's representation request as one roster mandate under
   * the active revision; the owner guard enforces actions, lifetime and size. */
  async acceptRoster(principal: VerifiedPrincipal, receipt: ControlReceipt, input: {
    policyId: string; institutionSubject: string; requestId: string;
    representationId: string }): Promise<{ representationId: string; policyRevision: string;
      authorityEpoch: string; replayed: boolean }> {
    requireReceipt(receipt);
    if (![input.policyId, input.requestId, input.representationId].every(id => idPattern.test(id))
      || !agentPattern.test(input.institutionSubject)) {
      throw new ControlInvalid('invalid roster acceptance');
    }
    return controlTransaction(this.pool, async client => {
      await lockGate(client, WORK_SCOPE, true);
      const actor = await requirePrincipal(client, principal);
      await requireMandate(client, actor.id, input.institutionSubject, MANAGE);
      return receipted(client, actor.id, receipt, 'representative-policy', 'accept-roster',
        input.institutionSubject, input.representationId, async () => {
          const request = await client.query<{ recipient_principal: string; valid_until: Date;
            expires_at: Date; action: string }>(`SELECT q.recipient_principal, q.valid_until,
            q.expires_at, q.action FROM access.representation_request q
            JOIN access.principal p ON p.id = q.recipient_principal AND p.active
            WHERE q.id = $1 AND q.subject_id = $2 AND NOT EXISTS (SELECT 1
              FROM access.representation r WHERE r.request_id = q.id)`,
          [input.requestId, input.institutionSubject]);
          const row = request.rows[0];
          if (!row) throw new ControlDenied('request is unavailable to this institution');
          if (row.expires_at.getTime() <= Date.now()) throw new ControlStale('request expired');
          const policy = await activePolicy(client, input.policyId, input.institutionSubject, true);
          if (!policy.ceiling.actions.includes(row.action)
            || policy.rosterSize >= policy.ceiling.maxRepresentatives
            || row.valid_until.getTime() > Date.now() + policy.ceiling.maxMandateDays * 86_400_000) {
            throw new ControlDenied('mandate exceeds the approved representative policy');
          }
          await requireCeiling(client, input.institutionSubject, ASSIGN, row.valid_until);
          await client.query(`INSERT INTO access.representation (id, principal_id, subject_id,
            action, valid_until, assigned_by_principal, request_id, representative_policy_id,
            representative_policy_revision) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
          [input.representationId, row.recipient_principal, input.institutionSubject, row.action,
            row.valid_until, actor.id, input.requestId, input.policyId, policy.activeRevision]);
          const epoch = await bumpEpoch(client, WORK_SCOPE);
          return { epoch, result: { representationId: input.representationId,
            policyRevision: policy.activeRevision, authorityEpoch: epoch } };
        });
    });
  }
}
