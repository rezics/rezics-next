// Row declarations for migration 042. The row ID is the opaque decision identity;
// every recorded epoch and generation must come from one authority snapshot.
import type { PolicyRuleTier } from './policy-schema.ts';

export const DECISION_LIMITS = { inputs: 64, traceEntries: 80, validityMs: 5 * 60_000 } as const;

export type DecisionOutcome = 'allow' | 'deny' | 'not-applicable' | 'indeterminate';
export type DecisionPublicResult = 'allow' | 'deny' | 'unavailable';
export type DecisionReason = 'rule-allow' | 'interaction-permitted' | 'rule-deny'
  | 'mandatory-guard-failed' | 'scope-closed' | 'interaction-blocked' | 'no-applicable-rule'
  | 'evidence-unavailable' | 'set-admission-unavailable' | 'budget-exhausted';

/** Internal outcomes keep their distinction; only this mapping reaches callers. */
export function publicDecisionResult(outcome: DecisionOutcome): DecisionPublicResult {
  if (outcome === 'allow') return 'allow';
  return outcome === 'indeterminate' ? 'unavailable' : 'deny';
}

export type DecisionTraceEntry =
  | { tier: 'mandatory'; position: number; outcome: 'pass' | 'fail' | 'unknown' }
  | { tier: 'ordered'; position: number; outcome: 'match' | 'no-match' | 'unknown' };

export type DecisionSnapshotRow = {
  id: string; kind: 'policy' | 'interaction'; audience: string;
  principal_id: string; principal_epoch: string;
  acting_subject: string | null; acting_subject_generation: string | null;
  action: string; scope_id: string; authority_epoch: string; group_generation: string;
  recovery_generation: string; policy_id: string | null; policy_revision: string | null;
  recipient_subject: string | null; input_snapshot: string; outcome: DecisionOutcome;
  public_result: DecisionPublicResult; reason: DecisionReason;
  deciding_tier: PolicyRuleTier | null; deciding_position: number | null;
  deciding_rule_id: string | null; rule_trace: DecisionTraceEntry[];
  evaluated_states: number; evaluated_rows: number; reusable: boolean;
  decided_at: Date; expires_at: Date;
};

export type DecisionInputKind = 'representation' | 'permission_grant'
  | 'principal_permission_grant' | 'group_member' | 'group_permission_grant' | 'role_binding'
  | 'private_group_member' | 'private_role_binding' | 'membership' | 'private_membership'
  | 'policy_set_admission' | 'interaction_block';

export type DecisionSnapshotInputRow = {
  decision_id: string; ordinal: number; role: 'guard' | 'condition' | 'proof';
  kind: DecisionInputKind; observed: 'present' | 'absent' | 'unavailable';
  object_generation: string | null; representation_id: string | null;
  permission_grant_id: string | null; principal_permission_grant_id: string | null;
  group_member_id: string | null; group_permission_grant_id: string | null;
  role_binding_id: string | null; private_group_member_id: string | null;
  private_role_binding_id: string | null; membership_id: string | null;
  private_membership_id: string | null; set_admission_id: string | null;
  interaction_block_id: string | null; set_kind: 'org' | 'realm' | null;
  set_owner_subject: string | null;
};
