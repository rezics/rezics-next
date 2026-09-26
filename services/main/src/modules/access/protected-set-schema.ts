import { declareTable, type RowOf } from './topology-schema.ts';

/** Typed declarations for protected authority changes, protected sets and
 * automation installations (migration 051). A protected change is staged,
 * approved by distinct principals of its approval subject, then activated once
 * in the transaction that writes the effect row naming it. */
export type ProtectedChangeKind = 'role-revision' | 'role-binding' | 'group-member'
  | 'group-parent' | 'group-grant' | 'automation-install' | 'representative-policy'
  | 'agent-controller' | 'agent-control-policy' | 'agent-recovery';
export const MAX_PROTECTED_APPROVALS = 8;
export const MAX_STAGED_CHANGE_BYTES = 16_384;

export const protectedChangeProposalTable = declareTable('protected_change_proposal', {
  id: ['uuid', 'not null'],
  kind: ['text', 'not null'],
  target_subject: ['text', 'not null'],
  target_object: ['uuid', 'null'],
  scope_id: ['text', 'null'],
  expected_authority_epoch: ['int8', 'null'],
  expected_object_generation: ['int8', 'not null'],
  resulting_ceiling: ['_text', 'not null'],
  staged_change: ['jsonb', 'not null'],
  change_digest: ['text', 'not null'],
  approval_subject: ['text', 'not null'],
  required_approvals: ['int2', 'not null'],
  requested_by: ['uuid', 'not null'],
  requester_subject: ['text', 'null'],
  not_before: ['timestamptz', 'not null'],
  expires_at: ['timestamptz', 'not null'],
  created_at: ['timestamptz', 'not null'],
});
export type ProtectedChangeProposalRow = RowOf<typeof protectedChangeProposalTable>;

export const protectedChangeApprovalTable = declareTable('protected_change_approval', {
  proposal_id: ['uuid', 'not null'],
  approver_principal: ['uuid', 'not null'],
  approver_subject: ['text', 'not null'],
  approver_representation_id: ['uuid', 'not null'],
  approver_representation_generation: ['int8', 'not null'],
  approver_representation_action: ['text', 'not null'],
  change_digest: ['text', 'not null'],
  created_at: ['timestamptz', 'not null'],
});
export type ProtectedChangeApprovalRow = RowOf<typeof protectedChangeApprovalTable>;

export const protectedChangeActivationTable = declareTable('protected_change_activation', {
  proposal_id: ['uuid', 'not null'],
  kind: ['text', 'not null'],
  target_subject: ['text', 'not null'],
  target_object: ['uuid', 'null'],
  activated_by: ['uuid', 'not null'],
  approval_count: ['int2', 'not null'],
  result_authority_epoch: ['int8', 'null'],
  result_object_generation: ['int8', 'not null'],
  activation_txid: ['int8', 'not null'],
  committed_at: ['timestamptz', 'not null'],
});
export type ProtectedChangeActivationRow = RowOf<typeof protectedChangeActivationTable>;

export const protectedSetTable = declareTable('protected_set', {
  object_kind: ['text', 'not null'],
  object_id: ['uuid', 'not null'],
  owner_subject: ['text', 'not null'],
  approval_subject: ['text', 'not null'],
  required_approvals: ['int2', 'not null'],
  group_id: ['uuid', 'null'],
  role_family_id: ['uuid', 'null'],
  protected_by_principal: ['uuid', 'not null'],
  protected_at: ['timestamptz', 'not null'],
});
export type ProtectedSetRow = RowOf<typeof protectedSetTable>;

/** Actions with these prefixes make an installation privileged. */
export const PRIVILEGED_ACTION_PREFIXES = ['access.', 'agent.'] as const;
export const automationInstallationTable = declareTable('automation_installation', {
  id: ['uuid', 'not null'],
  owner_subject: ['text', 'not null'],
  workload_principal: ['uuid', 'not null'],
  actions: ['_text', 'not null'],
  privileged: ['bool', 'not null'],
  protected_change_id: ['uuid', 'null'],
  installed_by_principal: ['uuid', 'not null'],
  valid_until: ['timestamptz', 'not null'],
  active: ['bool', 'not null'],
  generation: ['int8', 'not null'],
  created_at: ['timestamptz', 'not null'],
});
export type AutomationInstallationRow = RowOf<typeof automationInstallationTable>;

/** Nullable activation references added to existing effect tables. */
export const protectedEffectTables = ['group_member', 'private_group_member', 'recipient_group',
  'group_permission_grant', 'role_revision', 'role_binding', 'private_role_binding',
  'representation'] as const;
