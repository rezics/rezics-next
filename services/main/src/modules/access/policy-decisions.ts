// Authority-decision template: one policy decision over one REPEATABLE READ
// snapshot, stored as a private frame whose ID is the reusable proof handle.
import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import type { VerifiedPrincipal } from './admission.ts';
import { publicDecisionResult } from './decision-snapshot-schema.ts';
import {
  FrameInputs, insertFrame, requireSameInputs, DECISION_AUDIENCE,
} from './decision-snapshot-store.ts';
import { loadHeadRules } from './policy-changes.ts';
import {
  agentPattern, PolicyDenied, PolicyInvalid, PolicyNotFound, ProofHandleMismatch, ProofHandleStale,
  uuidPattern,
} from './policy-errors.ts';
import { decidePolicy, EvaluationBudget, type PolicyFacts, type Truth } from './policy-evaluator.ts';
import type { MembershipBasis } from './policy-schema.ts';
import { findPrincipal, inAccessTransaction, requireRecoveryOpen } from './policy-transaction.ts';

/** Decision actions and the Account scope each one needs before evaluation. */
export const POLICY_DECISION_ACTIONS = {
  'work.read': 'work:read', 'work.edit': 'work:edit', 'work.create': 'work:create',
} as const;
export type PolicyDecisionAction = keyof typeof POLICY_DECISION_ACTIONS;
const MAX_GRANT_PROOFS = 8;

export interface PolicyDecisionRequest {
  principal: VerifiedPrincipal; scopeId: string; action: PolicyDecisionAction;
  actingSubject: string | null; reusable: boolean; validitySeconds: number;
}
export interface PolicyDecision {
  decisionId: string | null; result: 'allow' | 'deny' | 'unavailable';
  policyId: string; policyRevision: string; authorityEpoch: string;
  expiresAt: string | null; reusable: boolean;
  /** Independent sources that completed an allow, in stable order. */
  sources: { kind: 'permission_grant' | 'role_binding'; id: string; generation: string }[];
}

type GateRow = { authority_epoch: string; group_generation: string; open: boolean };

class SnapshotFacts implements PolicyFacts {
  readonly inputs = new FrameInputs();
  readonly sources: PolicyDecision['sources'] = [];
  unavailableSets = 0;
  constructor(private readonly client: PoolClient, private readonly budget: EvaluationBudget,
    private readonly principal: { id: string; active: boolean }, readonly actingSubject: string | null,
    private readonly actorActive: boolean, private readonly scopeId: string,
    private readonly action: string, readonly now: Date) {}

  private async rows<T extends object>(sql: string, params: unknown[]): Promise<T[]> {
    const result = await this.client.query<T>(sql, params);
    this.budget.spendRows(result.rows.length);
    return result.rows;
  }

  async authenticated(): Promise<boolean> { return this.principal.active; }

  async represents(): Promise<boolean> {
    if (!this.actingSubject || !this.actorActive || !this.principal.active) return false;
    const [mandate] = await this.rows<{ id: string; generation: string }>(`SELECT id, generation
      FROM access.representation WHERE principal_id = $1 AND subject_id = $2 AND action = $3
        AND active AND valid_until > $4 ORDER BY id LIMIT 1`,
    [this.principal.id, this.actingSubject, this.action, this.now]);
    if (!mandate) return false;
    this.inputs.add({ role: 'guard', kind: 'representation', observed: 'present',
      id: mandate.id, generation: mandate.generation });
    return true;
  }

  /** Direct Agent grants and pinned role bindings are separate complete sources;
   * a membership-dependent source also needs its exact current episode. */
  async hasGrant(action: string): Promise<boolean> {
    if (!this.actingSubject || !this.actorActive) return false;
    const found = await this.rows<{ kind: 'permission_grant' | 'role_binding'; id: string;
      generation: string; membership_id: string | null; membership_generation: string | null;
      membership_kind: 'org' | 'realm' | null; membership_owner: string | null }>(`
      SELECT 'permission_grant' AS kind, g.id, g.generation, g.membership_id,
        m.generation AS membership_generation, m.kind AS membership_kind, m.owner_subject AS membership_owner
      FROM access.permission_grant g LEFT JOIN access.membership m ON m.id = g.membership_id
      WHERE g.recipient_subject = $1 AND g.scope_id = $2 AND g.action = $3 AND g.active
        AND g.valid_until > $4 AND (g.membership_id IS NULL
          OR (m.state = 'joined' AND m.generation = g.membership_generation))
      UNION ALL
      SELECT 'role_binding', b.id, b.generation, b.membership_id, m.generation, m.kind, m.owner_subject
      FROM access.role_binding b JOIN access.role_family f ON f.id = b.family_id
      JOIN access.role_revision r ON r.family_id = b.family_id AND r.revision = b.role_revision
      LEFT JOIN access.membership m ON m.id = b.membership_id
      WHERE b.recipient_subject = $1 AND f.scope_id = $2 AND $3 = ANY(r.permissions) AND b.active
        AND b.valid_until > $4 AND (b.membership_id IS NULL
          OR (m.state = 'joined' AND m.generation = b.membership_generation))
      ORDER BY 1, 2 LIMIT ${MAX_GRANT_PROOFS}`, [this.actingSubject, this.scopeId, action, this.now]);
    for (const source of found) {
      this.inputs.add({ role: 'proof', kind: source.kind, observed: 'present',
        id: source.id, generation: source.generation });
      if (source.membership_id) {
        this.inputs.add({ role: 'proof', kind: 'membership', observed: 'present',
          id: source.membership_id, generation: source.membership_generation,
          setKind: source.membership_kind!, setOwner: source.membership_owner! });
      }
      this.sources.push({ kind: source.kind, id: source.id, generation: source.generation });
    }
    return found.length > 0;
  }

  async memberOf(admissionId: string, basis: MembershipBasis): Promise<Truth> {
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
      const now = (await client.query<{ now: Date }>('SELECT clock_timestamp() AS now')).rows[0]!.now;
      const gate = (await client.query<GateRow>(`SELECT authority_epoch, group_generation, open
        FROM access.scope_gate WHERE id = $1`, [request.scopeId])).rows[0];
      const policy = gate && (await client.query<{ id: string; head_revision: string; max_states: number;
        max_input_rows: number; deadline_ms: number }>(`SELECT p.id, p.head_revision, r.max_states,
          r.max_input_rows, r.deadline_ms FROM access.policy p JOIN access.policy_revision r
          ON r.policy_id = p.id AND r.revision = p.head_revision WHERE p.scope_id = $1 AND p.ended_at IS NULL`,
      [request.scopeId])).rows[0];
      if (!gate || !policy) throw new PolicyNotFound('scope has no policy');
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
      const budget = new EvaluationBudget({ maxStates: policy.max_states,
        maxInputRows: policy.max_input_rows, deadlineMs: policy.deadline_ms });
      const facts = new SnapshotFacts(client, budget, principal, request.actingSubject,
        actor?.active ?? false, request.scopeId, request.action, now);
      const decided = gate.open
        ? await decidePolicy(await loadHeadRules(client, policy.id, policy.head_revision),
          request.action, facts, budget, () => facts.unavailableSets)
        : { outcome: 'deny' as const, reason: 'scope-closed' as const, deciding: null, trace: [] };
      const reusable = request.reusable && decided.outcome === 'allow';
      const decisionId = randomUUID();
      const expiresAt = new Date(now.getTime() + request.validitySeconds * 1000);
      await insertFrame(client, { id: decisionId, kind: 'policy', principalId: principal.id,
        principalEpoch: principal.enforcement_epoch, actingSubject: request.actingSubject,
        actingSubjectGeneration: actor?.generation ?? null, action: request.action,
        scopeId: request.scopeId, authorityEpoch: gate.authority_epoch,
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
          g.open AND g.authority_epoch = $2 AND g.group_generation = $3
          AND p.ended_at IS NULL AND p.head_revision = $4 AND pr.active AND pr.enforcement_epoch = $5
          AND ($6::text IS NULL OR EXISTS (SELECT 1 FROM access.authority_subject s
            WHERE s.id = $6 AND s.active AND s.generation = $7)) AS fresh
        FROM access.scope_gate g JOIN access.policy p ON p.scope_id = g.id
        JOIN access.principal pr ON pr.id = $8 WHERE g.id = $1`, [scopeId, frame.authority_epoch,
        frame.group_generation, frame.policy_revision, frame.principal_epoch, actingSubject,
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
