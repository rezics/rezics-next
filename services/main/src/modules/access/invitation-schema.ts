import { declareTable, type RowOf } from './topology-schema.ts';

/** Typed declarations for Agent invitations (migration 055). The recipient is
 * a stable Agent IRI that need not be admitted; only a current ACCEPT_ACTION
 * mandate for that Agent can accept, and the grant goes to the Agent. */
export const ACCEPT_ACTION = 'access.invitation.accept';
export type InvitationIssuerLifetime = 'institutional' | 'operator-dependent';

export const agentInvitationTable = declareTable('agent_invitation', {
  id: ['uuid', 'not null'],
  issuer_subject: ['text', 'not null'],
  recipient_subject: ['text', 'not null'],
  scope_id: ['text', 'not null'],
  action: ['text', 'not null'],
  grant_valid_until: ['timestamptz', 'not null'],
  issuer_lifetime: ['text', 'not null'],
  issued_by_principal: ['uuid', 'not null'],
  issuer_representation_id: ['uuid', 'not null'],
  issuer_representation_generation: ['int8', 'not null'],
  issuer_representation_action: ['text', 'not null'],
  ceiling_grant_id: ['uuid', 'not null'],
  ceiling_grant_generation: ['int8', 'not null'],
  ceiling_scope_id: ['text', 'not null'],
  ceiling_action: ['text', 'not null'],
  expires_at: ['timestamptz', 'not null'],
  created_at: ['timestamptz', 'not null'],
});
export type AgentInvitationRow = RowOf<typeof agentInvitationTable>;

export const agentInvitationAcceptanceTable = declareTable('agent_invitation_acceptance', {
  invitation_id: ['uuid', 'not null'],
  issuer_subject: ['text', 'not null'],
  recipient_subject: ['text', 'not null'],
  scope_id: ['text', 'not null'],
  action: ['text', 'not null'],
  accepted_by_principal: ['uuid', 'not null'],
  acceptor_representation_id: ['uuid', 'not null'],
  acceptor_representation_generation: ['int8', 'not null'],
  acceptor_representation_action: ['text', 'not null'],
  recipient_generation: ['int8', 'not null'],
  grant_id: ['uuid', 'not null'],
  accepted_at: ['timestamptz', 'not null'],
});
export type AgentInvitationAcceptanceRow = RowOf<typeof agentInvitationAcceptanceTable>;

export const agentInvitationRevocationTable = declareTable('agent_invitation_revocation', {
  invitation_id: ['uuid', 'not null'],
  revoked_by_principal: ['uuid', 'not null'],
  revoked_at: ['timestamptz', 'not null'],
});
export type AgentInvitationRevocationRow = RowOf<typeof agentInvitationRevocationTable>;
