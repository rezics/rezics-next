// Row declarations for migration 040. The SQL migration remains the DDL owner;
// these mirror its columns and closed registries for the policy operations.

/** v1 limits pinned by `policy_revision.profile`; lowering them needs a new profile. */
export const POLICY_PROFILE = 'access-policy-v1';
export const POLICY_LIMITS = {
  mandatoryRules: 16, orderedRules: 64, setReferences: 16, actionsPerRule: 16,
  conditionBytes: 4096, maxStates: 2048, maxInputRows: 4096, deadlineMs: 5000,
} as const;
export const POLICY_CONDITION_OPS = ['all', 'any', 'not', 'authenticated', 'subject-is',
  'member-of', 'has-grant', 'represents', 'time-window'] as const;
export const MEMBERSHIP_BASES = ['authenticated_principal', 'acting_subject'] as const;
export const SET_ADMISSION_PURPOSES = ['resource-exclusion', 'resource-eligibility'] as const;

export type PolicyConditionOp = typeof POLICY_CONDITION_OPS[number];
export type MembershipBasis = typeof MEMBERSHIP_BASES[number];
export type SetAdmissionPurpose = typeof SET_ADMISSION_PURPOSES[number];
export type PolicyRuleTier = 'mandatory' | 'ordered';
export type PolicyRuleEffect = 'require' | 'allow' | 'deny';

export type PolicyRow = {
  id: string; scope_id: string; owner_subject: string; head_revision: string; created_at: Date;
};

export type PolicyRevisionRow = {
  policy_id: string; revision: string; scope_id: string; profile: typeof POLICY_PROFILE;
  combining_algorithm: 'first-applicable'; default_effect: 'deny';
  mandatory_count: number; ordered_count: number; reference_count: number;
  max_states: number; max_input_rows: number; deadline_ms: number; digest: string;
  published_by_principal: string; publisher_subject: string;
  publisher_representation_id: string; publisher_representation_generation: string;
  publisher_grant_id: string; publisher_grant_generation: string;
  result_authority_epoch: string; created_at: Date;
};

export type PolicyRuleRow = {
  policy_id: string; revision: string; tier: PolicyRuleTier; position: number;
  rule_id: string; effect: PolicyRuleEffect; actions: string[];
  condition: { op: PolicyConditionOp } & Record<string, unknown>;
};

export type PolicySetAdmissionRow = {
  id: string; set_kind: 'org' | 'realm'; set_owner_subject: string; basis: MembershipBasis;
  referencing_scope_id: string; purpose: SetAdmissionPurpose; admitted_by_principal: string;
  admitting_representation_id: string; admitting_representation_generation: string;
  active: boolean; generation: string; valid_until: Date; created_at: Date;
};

export type PolicyRuleSetReferenceRow = {
  policy_id: string; revision: string; rule_id: string; set_admission_id: string;
  polarity: 'exclude' | 'include';
};

export type PolicyChangeReceiptRow = {
  principal_id: string; idempotency_key: string; request_digest: string;
  action: 'publish-revision' | 'admit-set' | 'revoke-set';
  policy_id: string | null; policy_revision: string | null; set_admission_id: string | null;
  result_authority_epoch: string; created_at: Date;
};
