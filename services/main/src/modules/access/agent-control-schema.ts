import { declareTable, type RowOf } from './topology-schema.ts';

/** Typed declarations for Agent control and recovery (migration 054).
 * Controllers are open-ended representation mandates or Agent edges for
 * CONTROL_ACTION; this schema adds only the continuity/recovery policy. */
export const CONTROL_ACTION = 'agent.control';
export const MAX_CONTROLLERS = 16;
export type RecoveryReason = 'last-controller-lost' | 'controller-compromised';

export const agentControlTable = declareTable('agent_control', {
  subject_id: ['text', 'not null'],
  min_controllers: ['int2', 'not null'],
  max_controllers: ['int2', 'not null'],
  recovery_subject: ['text', 'not null'],
  recovery_approvals: ['int2', 'not null'],
  recovery_delay: ['interval', 'not null'],
  protected_change_id: ['uuid', 'null'],
  generation: ['int8', 'not null'],
  created_at: ['timestamptz', 'not null'],
});
export type AgentControlRow = RowOf<typeof agentControlTable>;

export const agentRecoveryTable = declareTable('agent_recovery', {
  proposal_id: ['uuid', 'not null'],
  kind: ['text', 'not null'],
  subject_id: ['text', 'not null'],
  reason: ['text', 'not null'],
  replacement_principal: ['uuid', 'not null'],
  revoke_existing: ['bool', 'not null'],
  expected_control_generation: ['int8', 'not null'],
  created_at: ['timestamptz', 'not null'],
});
export type AgentRecoveryRow = RowOf<typeof agentRecoveryTable>;
