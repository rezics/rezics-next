import { declareTable, type RowOf } from './topology-schema.ts';

/** Typed declaration for grant lineage (migration 053). An institutional grant
 * survives its operator's departure; a dependent grant redelegates exactly one
 * upstream grant and is revoked with it in the same transaction. */
export type GrantLifetime = 'institutional' | 'dependent';
export const MAX_GRANT_DEPTH = 8;
export const MAX_ROOT_DESCENDANTS = 256;

export const grantLineageTable = declareTable('grant_lineage', {
  grant_id: ['uuid', 'not null'],
  issuer_subject: ['text', 'not null'],
  recipient_subject: ['text', 'not null'],
  scope_id: ['text', 'not null'],
  action: ['text', 'not null'],
  lifetime: ['text', 'not null'],
  assigned_by_principal: ['uuid', 'not null'],
  issuer_representation_id: ['uuid', 'not null'],
  issuer_representation_generation: ['int8', 'not null'],
  issuer_representation_action: ['text', 'not null'],
  ceiling_grant_id: ['uuid', 'not null'],
  ceiling_grant_generation: ['int8', 'not null'],
  ceiling_scope_id: ['text', 'not null'],
  ceiling_action: ['text', 'not null'],
  upstream_grant_id: ['uuid', 'null'],
  upstream_generation: ['int8', 'null'],
  root_grant_id: ['uuid', 'not null'],
  depth: ['int2', 'not null'],
  redelegation_depth: ['int2', 'not null'],
  representative_policy_id: ['uuid', 'null'],
  invitation_id: ['uuid', 'null'],
  created_at: ['timestamptz', 'not null'],
});
export type GrantLineageRow = RowOf<typeof grantLineageTable>;
