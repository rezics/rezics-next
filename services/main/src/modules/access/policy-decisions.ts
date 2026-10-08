// Authority-decision template: one policy decision over one REPEATABLE READ
// snapshot, stored as a private frame whose ID is the reusable proof handle.
import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import type { VerifiedPrincipal } from './admission.ts';
import { captureAuthorityWitness, type AuthorityWitness } from './authority-witness.ts';
import { groupWorkCreateProof } from './groups.ts';
import { representedWorkProof } from './represented-work-proof.ts';
import { publicDecisionResult } from './decision-snapshot-schema.ts';
import {
  FrameInputs, insertFrame, requireSameInputs, DECISION_AUDIENCE,
} from './decision-snapshot-store.ts';
import { loadHeadRules } from './policy-changes.ts';
import {
  agentPattern, PolicyDenied, PolicyInvalid, PolicyNotFound, PolicyUnavailable, ProofHandleMismatch, ProofHandleStale,
  uuidPattern,
} from './policy-errors.ts';
import { BudgetExhausted, decidePolicy, EvaluationBudget, type PolicyFacts, type Truth } from './policy-evaluator.ts';
import { POLICY_LIMITS, type MembershipBasis } from './policy-schema.ts';
import { findPrincipal, inAccessTransaction, requireRecoveryOpen } from './policy-transaction.ts';

/** Decision actions and the Account scope each one needs before evaluation. */
export const POLICY_DECISION_ACTIONS = {
  'work.read': 'work:read', 'work.edit': 'work:edit', 'work.create': 'work:create',
} as const;
export type PolicyDecisionAction = keyof typeof POLICY_DECISION_ACTIONS;

/** Live direct grants one decision records. The lowest ids are the proof; further grants still allow. */
export const DIRECT_GRANT_PROOF_LIMIT = 8;

export interface PolicyDecisionRequest {
  principal: VerifiedPrincipal; scopeId: string; action: PolicyDecisionAction;
  actingSubject: string | null; reusable: boolean; validitySeconds: number;
}
export interface PolicyDecision {
  decisionId: string | null; result: 'allow' | 'deny' | 'unavailable';
  policyId: string; policyRevision: string; authorityEpoch: string;
  expiresAt: string | null; reusable: boolean;
  /** Live direct grants that support this judgement, lowest id first, or the one role binding. */
  sources: { kind: 'permission_grant' | 'role_binding'; id: string; generation: string }[];
}

type GateRow = { authority_epoch: string; group_generation: string; open: boolean };

interface PublishedPolicy {
  id: string; head_revision: string; max_states: number; max_input_rows: number;
  deadline_ms: number; now: Date;
}

/** One indexed head and its immutable revision. A broken head is unavailable,
 * never indistinguishable from a scope without a published policy. */
async function publishedPolicy(client: PoolClient, scope: string): Promise<PublishedPolicy | null> {
  try {
    const policy = (await client.query<PublishedPolicy>(`SELECT p.id, p.head_revision, r.max_states,
      r.max_input_rows, r.deadline_ms, clock_timestamp() AS now
      FROM access.policy p LEFT JOIN access.policy_revision r
        ON r.policy_id = p.id AND r.revision = p.head_revision
      WHERE p.scope_id = $1 AND p.ended_at IS NULL`, [scope])).rows[0];
    if (policy && policy.max_states == null) throw new PolicyUnavailable('published policy head is unavailable');
    return policy ?? null;
  } catch { throw new PolicyUnavailable('published policy head could not be read'); }
}

/** Capability aliases keep the owner action while using its existing mandate. */
export function admissionAuthorityAction(action: string, scope: string): string {
  return action === 'media.campaign' && scope.startsWith('zone:edit:') ? 'zone.edit'
    : action === 'package.recommendation.set'
      || ['relation.change', 'work.derive'].includes(action) && scope.startsWith('work:edit:')
      ? 'work.edit' : action;
}

interface SelectedPolicyAuthority {
  witness: readonly AuthorityWitness[];
  /** Eligibility has already been checked by the capability's owner proof. */
  eligible: boolean;
}

interface GrantFact {
  kind: 'permission_grant' | 'role_binding'; id: string; generation: string;
  valid_until?: Date;
  membership_id: string | null; membership_generation: string | null;
  membership_kind: 'org' | 'realm' | null; membership_owner: string | null;
}

interface PolicyMembershipFact {
  id: string; generation: string; live: boolean; basis: MembershipBasis;
  set_kind: 'org' | 'realm'; set_owner_subject: string;
  member_id: string | null; member_generation: string | null; member_state: string | null;
}

/** Policy cost is independent of inventory size: one head, <=80 rules and
 * <=2048 states. Admission facts use the selected path only; membership facts
 * use one admitted set ID and one unique principal/actor membership key.
 * No cache survives a transaction or an authority generation. */
export async function admissionPolicyAllowed(client: PoolClient, principalId: string,
  actingSubject: string, scope: string, action: string,
  authority: SelectedPolicyAuthority): Promise<boolean> {
  try {
    const policy = await publishedPolicy(client, scope);
    if (!policy) return true;
    const { decided } = await policyJudgement(client, policy, { id: principalId, active: true },
      actingSubject, true, scope, action, authority);
    if (decided.outcome === 'indeterminate') throw new PolicyUnavailable('published policy evidence is unavailable');
    return decided.outcome === 'allow';
  } catch { throw new PolicyUnavailable('published policy could not be judged'); }
}

async function policyJudgement(client: PoolClient, policy: PublishedPolicy,
  principal: { id: string; active: boolean }, actingSubject: string | null,
  actorActive: boolean, scope: string, action: string, selected?: SelectedPolicyAuthority, scopeClosed = false) {
  const budget = new EvaluationBudget({ maxStates: policy.max_states,
    maxInputRows: policy.max_input_rows, deadlineMs: policy.deadline_ms });
  const facts = new SnapshotFacts(client, budget, principal, actingSubject,
    actorActive, scope, action, policy.now, selected);
  if (scopeClosed) return { facts, budget,
    decided: { outcome: 'deny' as const, reason: 'scope-closed' as const, deciding: null, trace: [] } };
  const rules = await loadHeadRules(client, policy.id, policy.head_revision);
  // Admission can be nested in an owner's READ COMMITTED transaction. Read all
  // exact policy memberships in one statement so atomic set switches cannot
  // stitch individually true absences into an invalid allow.
  if (selected) await facts.prepareMemberships(policy.id, policy.head_revision);
  let decided = await decidePolicy(rules,
    action, facts, budget, () => facts.unavailableSets);
  // Published allows can restrict eligible authority, but cannot manufacture a
  // missing mandate or capability grant. Preview uses the same hard ceiling.
  if (decided.outcome === 'allow') {
    try {
      const eligible = selected ? selected.eligible && await facts.hasGrant(action)
        && (!selected.witness.some(row => row.table === 'representation') || await facts.represents())
        : await facts.authenticated() && await facts.represents() && await facts.hasGrant(action);
      if (!eligible) decided = { outcome: 'not-applicable', reason: 'no-applicable-rule',
        deciding: null, trace: decided.trace };
    } catch (error) {
      if (!(error instanceof BudgetExhausted)) throw error;
      decided = { outcome: 'indeterminate', reason: 'budget-exhausted', deciding: null, trace: decided.trace };
    }
  }
  return { decided, facts, budget };
}

class SnapshotFacts implements PolicyFacts {
  readonly inputs = new FrameInputs();
  readonly sources: PolicyDecision['sources'] = [];
  /** Earliest expiry among recorded direct grants. A lease ends no later than this. */
  authorityExpiresAt: Date | null = null;
  reusableAuthority = true;
  unavailableSets = 0;
  private readonly memberships = new Map<string, PolicyMembershipFact>();
  private readonly observations = new Map<string, { generations: string; value: boolean }>();
  constructor(private readonly client: PoolClient, private readonly budget: EvaluationBudget,
    private readonly principal: { id: string; active: boolean }, readonly actingSubject: string | null,
    private readonly actorActive: boolean, private readonly scopeId: string,
    private readonly action: string, readonly now: Date,
    private readonly selected?: SelectedPolicyAuthority) {}

  private async rows<T extends object>(sql: string, params: unknown[]): Promise<T[]> {
    const result = await this.client.query<T>(sql, params);
    this.budget.spendRows(result.rows.length);
    return result.rows;
  }

  async authenticated(): Promise<boolean> { return this.principal.active; }

  private authorityGenerations(representation: boolean): string {
    const rows = this.selected ? this.selected.witness
      : this.inputs.list.filter(row => representation ? row.kind === 'representation' : row.role === 'proof');
    return rows.filter(row => !this.selected || (('table' in row ? row.table : row.kind) === 'representation') === representation)
      .map(row => `${'table' in row ? row.table : row.kind}:${row.id}:${row.generation}`).join('|');
  }

  private async observe(name: string, representation: boolean, read: () => Promise<boolean>): Promise<boolean> {
    const saved = this.observations.get(name);
    if (saved && saved.generations === this.authorityGenerations(representation)) return saved.value;
    const value = await read();
    // Only positive facts have exact authority generations. Their memo dies
    // with this transaction and never survives a changed selected path.
    if (value) this.observations.set(name, { generations: this.authorityGenerations(representation), value });
    return value;
  }

  async prepareMemberships(policyId: string, revision: string): Promise<void> {
    const { rows } = await this.client.query<PolicyMembershipFact>(`
      SELECT DISTINCT a.id,a.generation,a.basis,a.set_kind,a.set_owner_subject,
        a.active AND a.valid_until > $3 AND a.referencing_scope_id = $4 AS live,
        coalesce(m.id,pm.id) AS member_id,coalesce(m.generation,pm.generation) AS member_generation,
        coalesce(m.state,pm.state) AS member_state
      FROM access.policy_rule_set_reference ref
      JOIN access.policy_rule rule ON rule.policy_id=ref.policy_id AND rule.revision=ref.revision
        AND rule.rule_id=ref.rule_id
      JOIN access.policy_set_admission a ON a.id=ref.set_admission_id
      LEFT JOIN access.membership m ON a.basis='acting_subject'
        AND m.kind=a.set_kind AND m.owner_subject=a.set_owner_subject AND m.member_subject=$5
      LEFT JOIN access.private_membership pm ON a.basis='authenticated_principal'
        AND pm.kind=a.set_kind AND pm.owner_subject=a.set_owner_subject AND pm.principal_id=$6
      WHERE ref.policy_id=$1 AND ref.revision=$2 AND $7=ANY(rule.actions) LIMIT 17`,
    [policyId, revision, this.now, this.scopeId, this.actingSubject, this.principal.id, this.action]);
    if (rows.length > POLICY_LIMITS.setReferences) throw new BudgetExhausted('policy set budget is exhausted');
    for (const row of rows) this.memberships.set(row.id, row);
  }

  async represents(): Promise<boolean> {
    return this.observe('represents', true, () => this.readRepresentation());
  }

  private async readRepresentation(): Promise<boolean> {
    if (!this.actingSubject || !this.actorActive || !this.principal.active) return false;
    if (this.selected) {
      const present = this.selected.eligible && this.selected.witness.some(row => row.table === 'representation');
      this.budget.spendRows(present ? 1 : 0);
      return present;
    }
    const [mandate] = await this.rows<{ id: string; generation: string }>(`SELECT id, generation
      FROM access.representation WHERE principal_id = $1 AND subject_id = $2
        AND action = ANY(CASE WHEN $3 IN ('work.create','work.edit')
          THEN ARRAY[$3,'agent.control'] ELSE ARRAY[$3] END)
        AND active AND valid_until > $4 ORDER BY action, valid_until LIMIT 1`,
    [this.principal.id, this.actingSubject, this.action, this.now]);
    if (!mandate) {
      if (this.action !== 'work.create' || this.scopeId !== 'work:create:root') return false;
      const proof = await representedWorkProof(this.client, this.principal.id, this.actingSubject);
      if (!proof?.path) return false;
      this.budget.spendRows(1);
      // The existing decision-input schema cannot persist an invitation edge.
      // It can preview the live path but must not issue a reusable handle.
      this.reusableAuthority = false;
      this.inputs.add({ role: 'guard', kind: 'representation', observed: 'present',
        id: proof.representationId, generation: proof.representationGeneration });
      return true;
    }
    this.inputs.add({ role: 'guard', kind: 'representation', observed: 'present',
      id: mandate.id, generation: mandate.generation });
    return true;
  }

  /** Direct Agent grants and pinned role bindings are separate complete sources;
   * a membership-dependent source also needs its exact current episode. */
  async hasGrant(action: string): Promise<boolean> {
    return this.observe(`has-grant:${action}`, false, () => this.readGrant(action));
  }

  private async readGrant(action: string): Promise<boolean> {
    if (!this.actingSubject || !this.actorActive) return false;
    const authorityAction = admissionAuthorityAction(this.action, this.scopeId);
    if (action !== authorityAction) {
      if (!await this.hasGrant(authorityAction)) return false;
      const role = this.selected
        ? this.selected.witness.find(row => row.table === 'role_binding' || row.table === 'private_role_binding')
        : this.sources[0]?.kind === 'role_binding' ? this.sources[0] : undefined;
      if (!role) return false;
      // A pinned role can carry several permissions. Read that exact revision,
      // rather than borrowing a second grant to complete the selected path.
      const table = 'table' in role ? role.table : 'role_binding';
      return (await this.rows(`SELECT b.id FROM access.${table} b
        JOIN access.role_revision r ON r.family_id=b.family_id AND r.revision=b.role_revision
        WHERE b.id=$1 AND b.generation=$2 AND $3=ANY(r.permissions)`, [role.id,role.generation,action])).length === 1;
    }
    if (this.selected) {
      this.budget.spendRows(this.selected.eligible ? 1 : 0);
      return this.selected.eligible;
    }
    // permission_grant_active_lookup bounds this to one recipient, scope and action.
    // The lowest ids are the proof; the limit bounds the snapshot write.
    const direct = await this.rows<GrantFact>(`
      SELECT 'permission_grant' AS kind, g.id, g.generation, g.valid_until, g.membership_id,
        m.generation AS membership_generation, m.kind AS membership_kind, m.owner_subject AS membership_owner
      FROM access.permission_grant g
      LEFT JOIN access.membership m ON m.id = g.membership_id
      WHERE g.recipient_subject = $1 AND g.scope_id = $2 AND g.action = $3 AND g.active
        AND g.valid_until > $4
        AND (g.membership_id IS NULL
          OR (m.state = 'joined' AND m.generation = g.membership_generation))
      ORDER BY g.id LIMIT $5`,
    [this.actingSubject, this.scopeId, action, this.now, DIRECT_GRANT_PROOF_LIMIT]);
    if (direct.length) {
      for (const grant of direct) this.recordGrant(grant);
      return true;
    }
    // Work creation selects direct, group, then role, exactly as admission.
    if (action === 'work.create' && this.scopeId === 'work:create:root'
      && await this.groupGrant()) return true;
    const roles = await this.rows<GrantFact>(`
      SELECT 'role_binding' AS kind, b.id, b.generation, b.membership_id,
        m.generation AS membership_generation,m.kind AS membership_kind,m.owner_subject AS membership_owner
      FROM (SELECT * FROM access.role_binding WHERE recipient_subject = $1 AND active
        AND valid_until > $4 ORDER BY valid_until,id LIMIT 17) b
      JOIN access.role_family f ON f.id = b.family_id
      JOIN access.role_revision r ON r.family_id = b.family_id AND r.revision = b.role_revision
      LEFT JOIN access.membership m ON m.id = b.membership_id
      WHERE f.scope_id = $2 AND $3 = ANY(r.permissions) AND (b.membership_id IS NULL
          OR (m.state = 'joined' AND m.generation = b.membership_generation))
      ORDER BY b.id LIMIT 1`, [this.actingSubject, this.scopeId, action, this.now]);
    if (roles.length) { this.recordGrant(roles[0]!); return true; }
    return action === 'work.create' && this.scopeId !== 'work:create:root' && await this.groupGrant();
  }

  private recordGrant(source: GrantFact): void {
    this.inputs.add({ role: 'proof', kind: source.kind, observed: 'present',
      id: source.id, generation: source.generation });
    if (source.membership_id) {
      this.inputs.add({ role: 'proof', kind: 'membership', observed: 'present',
        id: source.membership_id, generation: source.membership_generation,
        setKind: source.membership_kind!, setOwner: source.membership_owner! });
    }
    if (!this.sources.some(saved => saved.kind === source.kind && saved.id === source.id)) {
      this.sources.push({ kind: source.kind, id: source.id, generation: source.generation });
    }
    if (source.valid_until && (!this.authorityExpiresAt || source.valid_until < this.authorityExpiresAt)) {
      this.authorityExpiresAt = source.valid_until;
    }
  }

  private async groupGrant(): Promise<boolean> {
    const group = await groupWorkCreateProof(this.client, this.actingSubject!, this.scopeId);
    if (!group) return false;
    this.budget.spendRows(1);
    const witness = await captureAuthorityWitness(this.client, [
      { table: 'group_member', id: group.memberId },
      { table: 'group_permission_grant', id: group.grantId },
    ]);
    // Group ancestry is exact in the admission witness, but is absent from the
    // older decision frame. A preview cannot promise later handle reuse.
    this.reusableAuthority = false;
    for (const source of witness) {
      if (source.table === 'group_member' || source.table === 'group_permission_grant') {
        this.inputs.add({ role: 'proof', kind: source.table, observed: 'present',
          id: source.id, generation: source.generation });
      }
    }
    return true;
  }

  async memberOf(admissionId: string, basis: MembershipBasis): Promise<Truth> {
    if (this.selected) {
      const admission = this.memberships.get(admissionId);
      // Prefetch keeps the physical read bounded and atomic; charge the same
      // consumed set and member facts as the REPEATABLE READ preview.
      this.budget.spendRows(admission ? 1 : 0);
      if (!admission?.live || admission.basis !== basis) {
        this.unavailableSets++;
        return 'unknown';
      }
      // This observation belongs to the one membership statement above, keyed
      // by its exact set and membership generations, never an inventory cache.
      this.budget.spendRows(admission.member_id ? 1 : 0);
      return admission.member_state === 'joined';
    }
    const [admission] = await this.rows<{ id: string; generation: string; live: boolean;
      set_kind: 'org' | 'realm'; set_owner_subject: string }>(`SELECT id, generation,
        active AND valid_until > $2 AND referencing_scope_id = $3 AND basis = $4 AS live,
        set_kind, set_owner_subject
      FROM access.policy_set_admission WHERE id = $1`, [admissionId, this.now, this.scopeId, basis]);
    if (!admission?.live) {
      this.unavailableSets++;
      if (admission) {
        this.inputs.add({ role: 'condition', kind: 'policy_set_admission', observed: 'unavailable',
          id: admission.id, generation: admission.generation });
      }
      return 'unknown';
    }
    this.inputs.add({ role: 'condition', kind: 'policy_set_admission', observed: 'present',
      id: admission.id, generation: admission.generation });
    if (basis === 'acting_subject' && !this.actingSubject) return false;
    const [member] = await this.rows<{ id: string; generation: string; state: string }>(
      basis === 'acting_subject'
        ? `SELECT id, generation, state FROM access.membership
            WHERE kind = $1 AND owner_subject = $2 AND member_subject = $3`
        : `SELECT id, generation, state FROM access.private_membership
            WHERE kind = $1 AND owner_subject = $2 AND principal_id = $3`,
      [admission.set_kind, admission.set_owner_subject,
        basis === 'acting_subject' ? this.actingSubject : this.principal.id]);
    this.inputs.add({ role: 'condition',
      kind: basis === 'acting_subject' ? 'membership' : 'private_membership',
      observed: member ? 'present' : 'absent', id: member?.id ?? null,
      generation: member?.generation ?? null, setKind: admission.set_kind,
      setOwner: admission.set_owner_subject });
    return member?.state === 'joined';
  }
}

export class AccessPolicyDecisions {
  constructor(private readonly pool: Pool) {}

  async decide(request: PolicyDecisionRequest): Promise<PolicyDecision> {
    if (!request.scopeId || request.scopeId.length > 256 || !(request.action in POLICY_DECISION_ACTIONS)
      || (request.actingSubject !== null && !agentPattern.test(request.actingSubject))
      || !Number.isInteger(request.validitySeconds) || request.validitySeconds < 1
      || request.validitySeconds > 120) {
      throw new PolicyInvalid('invalid policy decision request');
    }
    return inAccessTransaction(this.pool, 'repeatable read', async client => {
      const recoveryGeneration = await requireRecoveryOpen(client, false);
      const gate = (await client.query<GateRow>(`SELECT authority_epoch, group_generation, open
        FROM access.scope_gate WHERE id = $1`, [request.scopeId])).rows[0];
      const policy = gate && await publishedPolicy(client, request.scopeId);
      if (!gate || !policy) throw new PolicyNotFound('scope has no policy');
      const now = policy.now;
      const base = { policyId: policy.id, policyRevision: policy.head_revision,
        authorityEpoch: gate.authority_epoch };
      const principal = await findPrincipal(client, request.principal);
      // Without an Access principal there is no private subject to bind a frame to.
      if (!principal) {
        return { ...base, decisionId: null, result: 'deny', expiresAt: null, reusable: false, sources: [] };
      }
      const actor = request.actingSubject === null ? undefined
        : (await client.query<{ generation: string; active: boolean }>(`SELECT generation, active
          FROM access.authority_subject WHERE id = $1`, [request.actingSubject])).rows[0];
      if (request.actingSubject !== null && !actor) throw new PolicyDenied('acting subject is unavailable');
      const judgement = await policyJudgement(client, policy, principal, request.actingSubject,
        actor?.active ?? false, request.scopeId, request.action, undefined, !gate.open);
      const { facts, budget } = judgement;
      const decided = judgement.decided;
      const reusable = request.reusable && decided.outcome === 'allow' && facts.reusableAuthority;
      const decisionId = randomUUID();
      const requestedEnd = new Date(now.getTime() + request.validitySeconds * 1000);
      // Direct grants end the lease at the earliest recorded expiry, and never
      // later than the requested window.
      const expiresAt = facts.authorityExpiresAt && facts.authorityExpiresAt < requestedEnd
        ? facts.authorityExpiresAt : requestedEnd;
      await insertFrame(client, { id: decisionId, kind: 'policy', principalId: principal.id,
        principalEpoch: principal.enforcement_epoch, actingSubject: request.actingSubject,
        actingSubjectGeneration: actor?.generation ?? null, action: request.action,
        scopeId: request.scopeId, authorityEpoch: gate.authority_epoch,
        // Legacy frame metadata only. Group authority must be recorded as exact
        // decision inputs, never fenced by the scope's frozen group revision.
        groupGeneration: gate.group_generation, recoveryGeneration, policyId: policy.id,
        policyRevision: policy.head_revision, recipientSubject: null, outcome: decided.outcome,
        publicResult: publicDecisionResult(decided.outcome), reason: decided.reason,
        deciding: decided.deciding, trace: decided.trace, evaluatedStates: budget.states,
        evaluatedRows: budget.rows, reusable, decidedAt: now, expiresAt }, facts.inputs);
      return { ...base, decisionId, result: publicDecisionResult(decided.outcome),
        expiresAt: expiresAt.toISOString(), reusable,
        sources: decided.outcome === 'allow' ? facts.sources : [] };
    });
  }

  /** Reuses a handle only for its bound principal, audience, actor, action and
   * scope, and only while every recorded dependency is unchanged and live. */
  async revalidate(principal: VerifiedPrincipal, decisionId: string, scopeId: string,
    action: PolicyDecisionAction, actingSubject: string | null): Promise<PolicyDecision> {
    if (!uuidPattern.test(decisionId)) throw new PolicyInvalid('invalid proof handle');
    return inAccessTransaction(this.pool, 'repeatable read', async client => {
      const recoveryGeneration = await requireRecoveryOpen(client, false);
      const identity = await findPrincipal(client, principal);
      const frame = (await client.query<{ principal_id: string; principal_epoch: string;
        acting_subject: string | null; acting_subject_generation: string | null; action: string;
        scope_id: string; authority_epoch: string; group_generation: string; recovery_generation: string;
        policy_id: string; policy_revision: string; reusable: boolean; outcome: string; audience: string;
        kind: string; expires_at: Date; expired: boolean }>(`SELECT *, expires_at <= clock_timestamp() AS expired
        FROM access.decision_snapshot WHERE id = $1`, [decisionId])).rows[0];
      if (!identity || !frame || frame.principal_id !== identity.id || frame.kind !== 'policy'
        || frame.audience !== DECISION_AUDIENCE || frame.scope_id !== scopeId || frame.action !== action
        || frame.acting_subject !== actingSubject || !frame.reusable || frame.outcome !== 'allow') {
        throw new ProofHandleMismatch('proof handle is bound to another context');
      }
      if (frame.expired) throw new ProofHandleStale('proof handle expired');
      const current = (await client.query<{ fresh: boolean }>(`SELECT
          g.open AND g.authority_epoch = $2
          AND p.ended_at IS NULL AND p.head_revision = $3 AND pr.active AND pr.enforcement_epoch = $4
          AND ($5::text IS NULL OR EXISTS (SELECT 1 FROM access.authority_subject s
            WHERE s.id = $5 AND s.active AND s.generation = $6)) AS fresh
        FROM access.scope_gate g JOIN access.policy p ON p.scope_id = g.id
        JOIN access.principal pr ON pr.id = $7 WHERE g.id = $1`, [scopeId, frame.authority_epoch,
        frame.policy_revision, frame.principal_epoch, actingSubject,
        frame.acting_subject_generation, identity.id])).rows[0];
      if (!current?.fresh || recoveryGeneration !== frame.recovery_generation) {
        throw new ProofHandleStale('proof handle authority changed');
      }
      await requireSameInputs(client, decisionId, identity.id, actingSubject);
      return { decisionId, result: 'allow', policyId: frame.policy_id,
        policyRevision: frame.policy_revision, authorityEpoch: frame.authority_epoch,
        expiresAt: frame.expires_at.toISOString(), reusable: true, sources: [] };
    });
  }
}
