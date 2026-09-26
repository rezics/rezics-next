// Protected policy write template: publish a revision, admit or revoke a set
// reference. Each change, its scope epoch advance and its receipt commit together.
import { createHash } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import type { VerifiedPrincipal } from './admission.ts';
import {
  agentPattern, generationPattern, PolicyConflict, PolicyDenied, PolicyInvalid, PolicyNotFound,
  PolicyReferenceNotAdmitted, PolicyStale, uuidPattern,
} from './policy-errors.ts';
import {
  compilePolicyRules, DEFAULT_POLICY_LIMITS, type PolicyLimits, type PolicyRule, type RuleInput,
  type SetReference,
} from './policy-evaluator.ts';
import {
  MEMBERSHIP_BASES, POLICY_LIMITS, POLICY_PROFILE, SET_ADMISSION_PURPOSES, type MembershipBasis,
  type PolicyChangeReceiptRow, type PolicyRevisionRow, type PolicyRuleRow,
  type PolicyRuleSetReferenceRow, type PolicySetAdmissionRow, type SetAdmissionPurpose,
} from './policy-schema.ts';
import {
  advanceScopeEpoch, inAccessTransaction, lockOpenScope, requireActivePrincipal, requireGrant,
  requireMandate, requireRecoveryOpen,
} from './policy-transaction.ts';

export const POLICY_MANAGE = 'access.policy.manage';
export const POLICY_SET_ADMISSION = 'access.policy.set-admission';

export interface PolicyChangeContext {
  principal: VerifiedPrincipal; issuerSubject: string; expectedAuthorityEpoch: string;
  idempotencyKey: string; requestDigest: string;
}
export type PolicyChange =
  | { action: 'publish-revision'; policyId: string; scopeId: string; expectedHeadRevision: string;
      mandatory: RuleInput[]; ordered: RuleInput[]; limits?: Partial<PolicyLimits> }
  | { action: 'admit-set'; setAdmissionId: string; setKind: 'org' | 'realm';
      basis: MembershipBasis; referencingScopeId: string; purpose: SetAdmissionPurpose;
      validUntil: Date }
  | { action: 'revoke-set'; setAdmissionId: string; expectedGeneration: string };

export interface PolicyChangeResult {
  action: PolicyChange['action']; policyId: string | null; revision: string | null;
  setAdmissionId: string | null; authorityEpoch: string; replayed: boolean;
}

export interface PolicyRevisionView {
  policyId: string; scopeId: string; ownerSubject: string; headRevision: string;
  revision: string; combiningAlgorithm: 'first-applicable'; defaultEffect: 'deny';
  limits: PolicyLimits; digest: string; authorityEpoch: string;
  mandatory: { ruleId: string; actions: string[]; condition: unknown }[];
  ordered: { ruleId: string; actions: string[]; effect: 'allow' | 'deny'; condition: unknown }[];
  references: { ruleId: string; setAdmissionId: string; polarity: 'exclude' | 'include' }[];
}

function limitsOf(requested: Partial<PolicyLimits> | undefined): PolicyLimits {
  const limits = { ...DEFAULT_POLICY_LIMITS, ...requested };
  if (!Number.isInteger(limits.maxStates) || limits.maxStates < 1 || limits.maxStates > POLICY_LIMITS.maxStates
    || !Number.isInteger(limits.maxInputRows) || limits.maxInputRows < 1
    || limits.maxInputRows > POLICY_LIMITS.maxInputRows || !Number.isInteger(limits.deadlineMs)
    || limits.deadlineMs < 1 || limits.deadlineMs > POLICY_LIMITS.deadlineMs) {
    throw new PolicyInvalid('policy limits are outside the supported profile');
  }
  return limits;
}

function scopeOf(change: PolicyChange): string | null {
  if (change.action === 'publish-revision') return change.scopeId;
  return change.action === 'admit-set' ? change.referencingScopeId : null;
}

export class AccessPolicyChanges {
  constructor(private readonly pool: Pool) {}

  async change(context: PolicyChangeContext, change: PolicyChange): Promise<PolicyChangeResult> {
    if (!agentPattern.test(context.issuerSubject) || !generationPattern.test(context.expectedAuthorityEpoch)
      || !context.idempotencyKey || context.idempotencyKey.length > 128
      || context.idempotencyKey.includes('\0') || !/^[0-9a-f]{64}$/.test(context.requestDigest)
      || (change.action !== 'revoke-set' && !(scopeOf(change) ?? '').length)) {
      throw new PolicyInvalid('invalid policy change');
    }
    return inAccessTransaction(this.pool, 'read committed', async client => {
      await requireRecoveryOpen(client, true);
      const principal = await requireActivePrincipal(client, context.principal);
      let scope = scopeOf(change);
      let admission: PolicySetAdmissionRow | undefined;
      if (change.action === 'revoke-set') {
        admission = (await client.query<PolicySetAdmissionRow>(
          'SELECT * FROM access.policy_set_admission WHERE id = $1', [change.setAdmissionId])).rows[0];
        if (!admission || admission.set_owner_subject !== context.issuerSubject) {
          throw new PolicyDenied('set admission is unavailable to its owner');
        }
        scope = admission.referencing_scope_id;
      }
      const epoch = await lockOpenScope(client, scope!);
      const mandate = await requireMandate(client, principal.id, context.issuerSubject,
        change.action === 'publish-revision' ? POLICY_MANAGE : POLICY_SET_ADMISSION);
      const grant = change.action === 'publish-revision'
        ? await requireGrant(client, context.issuerSubject, scope!, POLICY_MANAGE) : null;
      const prior = (await client.query<PolicyChangeReceiptRow>(`SELECT * FROM access.policy_change_receipt
        WHERE principal_id = $1 AND idempotency_key = $2`, [principal.id, context.idempotencyKey])).rows[0];
      if (prior) {
        if (prior.request_digest !== context.requestDigest || prior.action !== change.action) {
          throw new PolicyConflict('policy change key binds another intent');
        }
        return { action: change.action, policyId: prior.policy_id, revision: prior.policy_revision,
          setAdmissionId: prior.set_admission_id, authorityEpoch: prior.result_authority_epoch,
          replayed: true };
      }
      if (epoch !== context.expectedAuthorityEpoch) throw new PolicyStale('scope authority epoch changed');
      let result: Omit<PolicyChangeResult, 'authorityEpoch' | 'replayed'>;
      let authorityEpoch: string;
      if (change.action === 'publish-revision') {
        authorityEpoch = await advanceScopeEpoch(client, scope!);
        result = await this.publish(client, context, { principalId: principal.id, mandate, grant: grant! },
          change, authorityEpoch);
      } else if (change.action === 'admit-set') {
        if (!uuidPattern.test(change.setAdmissionId) || !MEMBERSHIP_BASES.includes(change.basis)
          || !SET_ADMISSION_PURPOSES.includes(change.purpose) || !['org', 'realm'].includes(change.setKind)
          || Number.isNaN(change.validUntil.getTime()) || change.validUntil.getTime() <= Date.now()) {
          throw new PolicyInvalid('invalid set admission');
        }
        const owner = await client.query(`SELECT 1 FROM access.membership_policy
          WHERE kind = $1 AND owner_subject = $2 FOR SHARE`, [change.setKind, context.issuerSubject]);
        if (!owner.rows[0]) throw new PolicyDenied('issuer owns no such member set');
        await client.query(`INSERT INTO access.policy_set_admission (id, set_kind, set_owner_subject,
            basis, referencing_scope_id, purpose, admitted_by_principal, admitting_representation_id,
            admitting_representation_generation, valid_until)
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`, [change.setAdmissionId, change.setKind,
          context.issuerSubject, change.basis, scope, change.purpose, principal.id, mandate.id,
          mandate.generation, change.validUntil]);
        authorityEpoch = await advanceScopeEpoch(client, scope!);
        result = { action: change.action, policyId: null, revision: null, setAdmissionId: change.setAdmissionId };
      } else {
        const current = (await client.query<{ active: boolean; generation: string }>(`SELECT active,
          generation FROM access.policy_set_admission WHERE id = $1 FOR UPDATE`, [change.setAdmissionId])).rows[0]!;
        if (current.generation !== change.expectedGeneration) throw new PolicyStale('set admission changed');
        if (current.active) {
          await client.query('UPDATE access.policy_set_admission SET active = false WHERE id = $1',
            [change.setAdmissionId]);
        }
        authorityEpoch = await advanceScopeEpoch(client, scope!);
        result = { action: change.action, policyId: null, revision: null, setAdmissionId: change.setAdmissionId };
      }
      await client.query(`INSERT INTO access.policy_change_receipt (principal_id, idempotency_key,
          request_digest, action, policy_id, policy_revision, set_admission_id, result_authority_epoch)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`, [principal.id, context.idempotencyKey,
        context.requestDigest, change.action, result.policyId, result.revision, result.setAdmissionId,
        authorityEpoch]);
      return { ...result, authorityEpoch, replayed: false };
    });
  }

  private async publish(client: PoolClient, context: PolicyChangeContext,
    basis: { principalId: string; mandate: { id: string; generation: string };
      grant: { id: string; generation: string } },
    change: Extract<PolicyChange, { action: 'publish-revision' }>, authorityEpoch: string) {
    if (!uuidPattern.test(change.policyId) || !generationPattern.test(change.expectedHeadRevision)) {
      throw new PolicyInvalid('invalid policy revision');
    }
    const { rules, references } = compilePolicyRules(change.mandatory, change.ordered);
    const limits = limitsOf(change.limits);
    const current = (await client.query<{ id: string; owner_subject: string; head_revision: string }>(
      'SELECT id, owner_subject, head_revision FROM access.policy WHERE scope_id = $1 FOR UPDATE',
      [change.scopeId])).rows[0];
    if (current && current.owner_subject !== context.issuerSubject) {
      throw new PolicyDenied('scope is governed by another owner');
    }
    if (change.expectedHeadRevision === '0' ? current !== undefined
      : !current || current.id !== change.policyId || current.head_revision !== change.expectedHeadRevision) {
      throw new PolicyStale('policy head changed');
    }
    await this.requireAdmittedReferences(client, change.scopeId, references);
    const revision = (BigInt(change.expectedHeadRevision) + 1n).toString();
    if (!current) {
      await client.query(`INSERT INTO access.policy (id, scope_id, owner_subject, head_revision)
        VALUES ($1, $2, $3, 1)`, [change.policyId, change.scopeId, context.issuerSubject]);
    }
    const { principalId, mandate, grant } = basis;
    const count = (tier: PolicyRule['tier']) => rules.filter(rule => rule.tier === tier).length;
    await client.query(`INSERT INTO access.policy_revision (policy_id, revision, scope_id, profile,
        combining_algorithm, default_effect, mandatory_count, ordered_count, reference_count,
        max_states, max_input_rows, deadline_ms, digest, published_by_principal, publisher_subject,
        publisher_representation_id, publisher_representation_generation, publisher_grant_id,
        publisher_grant_generation, result_authority_epoch)
      VALUES ($1, $2, $3, $4, 'first-applicable', 'deny', $5, $6, $7, $8, $9, $10, $11, $12, $13,
        $14, $15, $16, $17, $18)`, [change.policyId, revision, change.scopeId, POLICY_PROFILE,
      count('mandatory'), count('ordered'), references.length, limits.maxStates, limits.maxInputRows,
      limits.deadlineMs, createHash('sha256').update(JSON.stringify({ rules, references, limits })).digest('hex'),
      principalId, context.issuerSubject, mandate.id, mandate.generation, grant.id, grant.generation,
      authorityEpoch]);
    await client.query(`INSERT INTO access.policy_rule (policy_id, revision, tier, position, rule_id,
        effect, actions, condition)
      SELECT $1, $2, r.tier, r.position, r.rule_id, r.effect, r.actions, r.condition
      FROM jsonb_to_recordset($3::jsonb) AS r(tier text, position smallint, rule_id uuid,
        effect text, actions text[], condition jsonb)`, [change.policyId, revision,
      JSON.stringify(rules.map(rule => ({ tier: rule.tier, position: rule.position,
        rule_id: rule.ruleId, effect: rule.effect, actions: rule.actions, condition: rule.condition })))]);
    if (references.length) {
      await client.query(`INSERT INTO access.policy_rule_set_reference (policy_id, revision, rule_id,
          set_admission_id, polarity)
        SELECT $1, $2, r.rule_id, r.admission, r.polarity
        FROM jsonb_to_recordset($3::jsonb) AS r(rule_id uuid, admission uuid, polarity text)`,
      [change.policyId, revision, JSON.stringify(references.map(reference => ({
        rule_id: reference.ruleId, admission: reference.admission, polarity: reference.polarity })))]);
    }
    if (current) {
      await client.query('UPDATE access.policy SET head_revision = $2 WHERE id = $1', [change.policyId, revision]);
    }
    return { action: change.action, policyId: change.policyId, revision, setAdmissionId: null };
  }

  /** A generic refusal: the caller learns neither roster nor which check failed. */
  private async requireAdmittedReferences(client: PoolClient, scope: string, references: SetReference[]) {
    if (!references.length) return;
    const rows = (await client.query<PolicySetAdmissionRow>(`SELECT * FROM access.policy_set_admission
      WHERE id = ANY($1::uuid[]) ORDER BY id FOR SHARE`,
    [[...new Set(references.map(reference => reference.admission))]])).rows;
    const byId = new Map(rows.map(row => [row.id, row]));
    for (const reference of references) {
      const admission = byId.get(reference.admission);
      if (!admission?.active || admission.valid_until.getTime() <= Date.now()
        || admission.referencing_scope_id !== scope || admission.basis !== reference.basis
        || (admission.purpose === 'resource-exclusion') !== (reference.polarity === 'exclude')) {
        throw new PolicyReferenceNotAdmitted('set reference is not admitted for this policy');
      }
    }
  }

  async readRevision(principal: VerifiedPrincipal, issuerSubject: string, policyId: string,
    revision: string): Promise<PolicyRevisionView> {
    if (!agentPattern.test(issuerSubject) || !uuidPattern.test(policyId) || !generationPattern.test(revision)) {
      throw new PolicyInvalid('invalid policy revision read');
    }
    return inAccessTransaction(this.pool, 'repeatable read', async client => {
      await requireRecoveryOpen(client, false);
      const identity = await requireActivePrincipal(client, principal);
      const policy = (await client.query<{ scope_id: string; owner_subject: string; head_revision: string;
        authority_epoch: string }>(`SELECT p.scope_id, p.owner_subject, p.head_revision, g.authority_epoch
        FROM access.policy p JOIN access.scope_gate g ON g.id = p.scope_id WHERE p.id = $1`, [policyId])).rows[0];
      if (!policy || policy.owner_subject !== issuerSubject) throw new PolicyDenied('policy is unavailable to issuer');
      await requireMandate(client, identity.id, issuerSubject, POLICY_MANAGE);
      await requireGrant(client, issuerSubject, policy.scope_id, POLICY_MANAGE);
      const row = (await client.query<PolicyRevisionRow>(`SELECT * FROM access.policy_revision
        WHERE policy_id = $1 AND revision = $2`, [policyId, revision])).rows[0];
      if (!row) throw new PolicyNotFound('policy revision is unavailable');
      const rules = (await client.query<PolicyRuleRow>(`SELECT * FROM access.policy_rule
        WHERE policy_id = $1 AND revision = $2 ORDER BY tier, position`, [policyId, revision])).rows;
      const references = (await client.query<PolicyRuleSetReferenceRow>(`SELECT * FROM
        access.policy_rule_set_reference WHERE policy_id = $1 AND revision = $2
        ORDER BY rule_id, set_admission_id`, [policyId, revision])).rows;
      return { policyId, scopeId: policy.scope_id, ownerSubject: policy.owner_subject,
        headRevision: policy.head_revision, revision: row.revision,
        combiningAlgorithm: row.combining_algorithm, defaultEffect: row.default_effect,
        limits: { maxStates: row.max_states, maxInputRows: row.max_input_rows, deadlineMs: row.deadline_ms },
        digest: row.digest, authorityEpoch: policy.authority_epoch,
        mandatory: rules.filter(rule => rule.tier === 'mandatory').map(rule => ({
          ruleId: rule.rule_id, actions: rule.actions, condition: rule.condition })),
        ordered: rules.filter(rule => rule.tier === 'ordered').map(rule => ({ ruleId: rule.rule_id,
          actions: rule.actions, effect: rule.effect as 'allow' | 'deny', condition: rule.condition })),
        references: references.map(reference => ({ ruleId: reference.rule_id,
          setAdmissionId: reference.set_admission_id, polarity: reference.polarity })) };
    });
  }
}

/** Loads the head revision's compiled rules in the reading transaction's snapshot. */
export async function loadHeadRules(client: PoolClient, policyId: string, revision: string):
  Promise<PolicyRule[]> {
  const rows = (await client.query<PolicyRuleRow>(`SELECT * FROM access.policy_rule
    WHERE policy_id = $1 AND revision = $2
    ORDER BY tier = 'ordered', position`, [policyId, revision])).rows;
  return rows.map(row => ({ tier: row.tier, position: row.position, ruleId: row.rule_id,
    effect: row.effect, actions: row.actions, condition: row.condition as unknown as PolicyRule['condition'] }));
}
