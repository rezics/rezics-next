// Records one decision frame and revalidates it later. The frame is written by the
// same REPEATABLE READ transaction that read its inputs, so migration 042's guards
// see exactly the recorded epochs and generations.
import type { PoolClient } from 'pg';
import {
  DECISION_LIMITS, type DecisionInputKind, type DecisionSnapshotInputRow,
  type DecisionSnapshotRow, type DecisionTraceEntry,
} from './decision-snapshot-schema.ts';
import { BudgetExhausted } from './policy-evaluator.ts';
import { ProofHandleStale } from './policy-errors.ts';

export const DECISION_AUDIENCE = 'rezics-main-v1';

const objectColumn: Record<DecisionInputKind, keyof DecisionSnapshotInputRow> = {
  representation: 'representation_id', permission_grant: 'permission_grant_id',
  principal_permission_grant: 'principal_permission_grant_id', group_member: 'group_member_id',
  group_permission_grant: 'group_permission_grant_id', role_binding: 'role_binding_id',
  private_group_member: 'private_group_member_id', private_role_binding: 'private_role_binding_id',
  membership: 'membership_id', private_membership: 'private_membership_id',
  policy_set_admission: 'set_admission_id', interaction_block: 'interaction_block_id',
};

export interface FrameInput {
  role: 'guard' | 'condition' | 'proof'; kind: DecisionInputKind;
  observed: 'present' | 'absent' | 'unavailable'; id: string | null; generation: string | null;
  setKind?: 'org' | 'realm'; setOwner?: string;
}

/** Bounded, de-duplicated evidence list for one frame. */
export class FrameInputs {
  readonly list: FrameInput[] = [];
  private readonly seen = new Set<string>();
  add(input: FrameInput): void {
    const key = `${input.kind}\0${input.id ?? ''}\0${input.setKind ?? ''}\0${input.setOwner ?? ''}`;
    if (this.seen.has(key)) return;
    if (this.list.length >= DECISION_LIMITS.inputs) throw new BudgetExhausted('decision input budget is exhausted');
    this.seen.add(key);
    this.list.push(input);
  }
}

export interface FrameHead {
  id: string; kind: 'policy' | 'interaction'; principalId: string; principalEpoch: string;
  actingSubject: string | null; actingSubjectGeneration: string | null; action: string;
  scopeId: string; authorityEpoch: string; groupGeneration: string; recoveryGeneration: string;
  policyId: string | null; policyRevision: string | null; recipientSubject: string | null;
  outcome: DecisionSnapshotRow['outcome']; publicResult: DecisionSnapshotRow['public_result'];
  reason: DecisionSnapshotRow['reason'];
  deciding: { tier: 'mandatory' | 'ordered'; position: number; ruleId: string } | null;
  trace: DecisionTraceEntry[]; evaluatedStates: number; evaluatedRows: number; reusable: boolean;
  decidedAt: Date; expiresAt: Date;
}

export async function insertFrame(client: PoolClient, head: FrameHead, inputs: FrameInputs): Promise<void> {
  await client.query(`INSERT INTO access.decision_snapshot (id, kind, audience, principal_id,
      principal_epoch, acting_subject, acting_subject_generation, action, scope_id, authority_epoch,
      group_generation, recovery_generation, policy_id, policy_revision, recipient_subject,
      input_snapshot, outcome, public_result, reason, deciding_tier, deciding_position,
      deciding_rule_id, rule_trace, evaluated_states, evaluated_rows, reusable, decided_at, expires_at)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15,
      pg_current_snapshot()::text, $16, $17, $18, $19, $20, $21, $22, $23, $24, $25, $26, $27)`,
  [head.id, head.kind, DECISION_AUDIENCE, head.principalId, head.principalEpoch, head.actingSubject,
    head.actingSubjectGeneration, head.action, head.scopeId, head.authorityEpoch, head.groupGeneration,
    head.recoveryGeneration, head.policyId, head.policyRevision, head.recipientSubject, head.outcome,
    head.publicResult, head.reason, head.deciding?.tier ?? null, head.deciding?.position ?? null,
    head.deciding?.ruleId ?? null, JSON.stringify(head.trace), head.evaluatedStates,
    Math.min(head.evaluatedRows, 4096), head.reusable, head.decidedAt, head.expiresAt]);
  if (!inputs.list.length) return;
  const rows = inputs.list.map((input, index) => ({ ordinal: index + 1, role: input.role,
    kind: input.kind, observed: input.observed, object_generation: input.generation,
    set_kind: input.setKind ?? null, set_owner_subject: input.setOwner ?? null,
    [objectColumn[input.kind]]: input.id }));
  const columns = Object.values(objectColumn);
  await client.query(`INSERT INTO access.decision_snapshot_input (decision_id, ordinal, role, kind,
      observed, object_generation, set_kind, set_owner_subject, ${columns.join(', ')})
    SELECT $1, r.ordinal, r.role, r.kind, r.observed, r.object_generation, r.set_kind,
      r.set_owner_subject, ${columns.map(column => `r.${column}`).join(', ')}
    FROM jsonb_to_recordset($2::jsonb) AS r(ordinal smallint, role text, kind text, observed text,
      object_generation bigint, set_kind text, set_owner_subject text,
      ${columns.map(column => `${column} uuid`).join(', ')})`, [head.id, JSON.stringify(rows)]);
}

const liveObject: Partial<Record<DecisionInputKind, string>> = {
  representation: `SELECT generation FROM access.representation
    WHERE id = $1 AND active AND valid_until > clock_timestamp()`,
  permission_grant: `SELECT generation FROM access.permission_grant
    WHERE id = $1 AND active AND valid_until > clock_timestamp()`,
  role_binding: `SELECT generation FROM access.role_binding
    WHERE id = $1 AND active AND valid_until > clock_timestamp()`,
  interaction_block: 'SELECT generation FROM access.interaction_block WHERE id = $1',
  policy_set_admission: `SELECT generation FROM access.policy_set_admission
    WHERE id = $1 AND (active AND valid_until > clock_timestamp()) = $2`,
};

/** Every recorded dependency must still be the same live generation; an absent
 * membership must still be absent. Any other state is stale, never re-derived. */
export async function requireSameInputs(client: PoolClient, decisionId: string, principalId: string,
  actingSubject: string | null): Promise<void> {
  const inputs = (await client.query<DecisionSnapshotInputRow>(`SELECT * FROM
    access.decision_snapshot_input WHERE decision_id = $1 ORDER BY ordinal`, [decisionId])).rows;
  for (const input of inputs) {
    let generation: string | undefined;
    if (input.kind === 'membership' || input.kind === 'private_membership') {
      const member = input.kind === 'membership' ? actingSubject : principalId;
      generation = (await client.query<{ generation: string }>(input.kind === 'membership'
        ? `SELECT generation FROM access.membership
            WHERE kind = $1 AND owner_subject = $2 AND member_subject = $3`
        : `SELECT generation FROM access.private_membership
            WHERE kind = $1 AND owner_subject = $2 AND principal_id = $3`,
      [input.set_kind, input.set_owner_subject, member])).rows[0]?.generation;
      if (input.observed === 'unavailable' || (generation ?? null) !== input.object_generation) {
        throw new ProofHandleStale('decision membership evidence changed');
      }
      continue;
    }
    const query = liveObject[input.kind];
    const id = input[objectColumn[input.kind]] as string | null;
    if (!query || !id) throw new ProofHandleStale('decision evidence cannot be revalidated');
    generation = (await client.query<{ generation: string }>(query,
      input.kind === 'policy_set_admission' ? [id, input.observed === 'present'] : [id])).rows[0]?.generation;
    if (generation !== input.object_generation) throw new ProofHandleStale('decision evidence changed');
  }
}
