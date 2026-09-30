/** Typed declarations for the Access representation-topology owner schema
 * (migrations 050 and 052). SQL migrations remain the DDL owner; each table map
 * is checked against the PostgreSQL catalog by the owner migration test. */

type SqlType = 'uuid' | 'text' | 'int8' | 'int2' | 'bool' | 'timestamptz' | '_text'
  | 'jsonb' | 'interval';
interface SqlValue {
  uuid: string; text: string; int8: string; int2: number; bool: boolean;
  timestamptz: Date; _text: string[]; jsonb: Record<string, unknown>;
  interval: Partial<Record<'years' | 'months' | 'days' | 'hours' | 'minutes'
    | 'seconds' | 'milliseconds', number>>;
}
export type ColumnMap = Record<string, readonly [SqlType, 'null' | 'not null']>;
export interface TableDeclaration { table: string; columns: ColumnMap }
/** Row shape returned by node-postgres for a declared table. */
export type RowOf<T extends TableDeclaration> = {
  -readonly [K in keyof T['columns']]: T['columns'][K][1] extends 'null'
    ? SqlValue[T['columns'][K][0]] | null : SqlValue[T['columns'][K][0]];
};
export function declareTable<const C extends ColumnMap>(table: string, columns: C) {
  return { table, columns };
}

/** Scope gate row whose authority epoch is the representation topology CAS
 * token. Every edge insert locks it; every edge write advances it. */
export const TOPOLOGY_SCOPE = 'access:representation-topology';
export const MAX_PATH_EDGES = 8;
export const MAX_EDGE_DEGREE = 16;
export const MAX_TOPOLOGY_WALK = 256;
/** SQLSTATEs raised by the owner guards: invariant violation and bound exceeded. */
export const GUARD_VIOLATION = '23514';
export const GUARD_LIMIT = '54000';

export const representationEdgeTable = declareTable('representation_edge', {
  id: ['uuid', 'not null'],
  representative_subject: ['text', 'not null'],
  represented_subject: ['text', 'not null'],
  action: ['text', 'not null'],
  resource_subject: ['text', 'null'],
  max_path_edges: ['int2', 'not null'],
  valid_until: ['timestamptz', 'not null'],
  active: ['bool', 'not null'],
  generation: ['int8', 'not null'],
  assigned_by_principal: ['uuid', 'not null'],
  issuer_representation_id: ['uuid', 'not null'],
  issuer_representation_generation: ['int8', 'not null'],
  issuer_representation_action: ['text', 'not null'],
  ceiling_grant_id: ['uuid', 'not null'],
  ceiling_grant_generation: ['int8', 'not null'],
  ceiling_scope_id: ['text', 'not null'],
  ceiling_action: ['text', 'not null'],
  created_at: ['timestamptz', 'not null'],
  protected_change_id: ['uuid', 'null'],
  invitation_id: ['uuid', 'null'],
});
export type RepresentationEdgeRow = RowOf<typeof representationEdgeTable>;

export const representationPathProofTable = declareTable('representation_path_proof', {
  id: ['uuid', 'not null'],
  principal_id: ['uuid', 'not null'],
  principal_epoch: ['int8', 'not null'],
  representation_id: ['uuid', 'not null'],
  representation_generation: ['int8', 'not null'],
  mandate_action: ['text', 'not null'],
  origin_subject: ['text', 'not null'],
  acting_subject: ['text', 'not null'],
  action: ['text', 'not null'],
  edge_count: ['int2', 'not null'],
  topology_epoch: ['int8', 'not null'],
  valid_until: ['timestamptz', 'not null'],
  created_at: ['timestamptz', 'not null'],
});
export type RepresentationPathProofRow = RowOf<typeof representationPathProofTable>;

export const representationPathStepTable = declareTable('representation_path_step', {
  path_id: ['uuid', 'not null'],
  position: ['int2', 'not null'],
  edge_id: ['uuid', 'not null'],
  edge_generation: ['int8', 'not null'],
  representative_subject: ['text', 'not null'],
  represented_subject: ['text', 'not null'],
  action: ['text', 'not null'],
});
export type RepresentationPathStepRow = RowOf<typeof representationPathStepTable>;

export const admissionObligationTable = declareTable('admission_obligation', {
  admission_id: ['uuid', 'not null'],
  obligation: ['text', 'not null'],
  principal_id: ['uuid', 'not null'],
  acting_subject: ['text', 'not null'],
  scope_id: ['text', 'not null'],
  path_id: ['uuid', 'not null'],
  source_kind: ['text', 'not null'],
  grant_id: ['uuid', 'null'],
  grant_generation: ['int8', 'null'],
  group_member_id: ['uuid', 'null'],
  group_grant_id: ['uuid', 'null'],
  group_generation: ['int8', 'null'],
  role_binding_id: ['uuid', 'null'],
  role_binding_generation: ['int8', 'null'],
  role_family_id: ['uuid', 'null'],
  role_revision: ['int8', 'null'],
});
export type AdmissionObligationRow = RowOf<typeof admissionObligationTable>;
export type ObligationSource = 'grant' | 'group' | 'role-binding';

export type AuthorityControlFamily = 'representation-edge' | 'representation-path'
  | 'protected-change' | 'representative-policy' | 'automation' | 'agent-control'
  | 'agent-recovery' | 'agent-invitation';
export const authorityControlReceiptTable = declareTable('authority_control_receipt', {
  principal_id: ['uuid', 'not null'],
  idempotency_key: ['text', 'not null'],
  request_digest: ['text', 'not null'],
  family: ['text', 'not null'],
  operation: ['text', 'not null'],
  subject: ['text', 'null'],
  object_id: ['uuid', 'not null'],
  result_authority_epoch: ['int8', 'not null'],
  result: ['jsonb', 'not null'],
  created_at: ['timestamptz', 'not null'],
});
export type AuthorityControlReceiptRow = RowOf<typeof authorityControlReceiptTable>;

/** Institutional representative policy (IAM32). Widening is computed by the
 * database from the base revision and needs the approval subject's change. */
export const representativePolicyTable = declareTable('representative_policy', {
  id: ['uuid', 'not null'],
  institution_subject: ['text', 'not null'],
  approval_subject: ['text', 'not null'],
  active_revision: ['int8', 'not null'],
  generation: ['int8', 'not null'],
  created_by_principal: ['uuid', 'not null'],
  created_at: ['timestamptz', 'not null'],
});
export type RepresentativePolicyRow = RowOf<typeof representativePolicyTable>;

export const representativePolicyRevisionTable = declareTable('representative_policy_revision', {
  policy_id: ['uuid', 'not null'],
  revision: ['int8', 'not null'],
  base_revision: ['int8', 'null'],
  actions: ['_text', 'not null'],
  max_representatives: ['int2', 'not null'],
  max_mandate_days: ['int2', 'not null'],
  widening: ['bool', 'not null'],
  protected_change_id: ['uuid', 'null'],
  created_by_principal: ['uuid', 'not null'],
  created_at: ['timestamptz', 'not null'],
});
export type RepresentativePolicyRevisionRow = RowOf<typeof representativePolicyRevisionTable>;

/** Columns added to the existing mandate table by migrations 050-054. */
export const representationAddedColumns = declareTable('representation', {
  max_path_edges: ['int2', 'not null'],
  automation_installation_id: ['uuid', 'null'],
  representative_policy_id: ['uuid', 'null'],
  representative_policy_revision: ['int8', 'null'],
  protected_change_id: ['uuid', 'null'],
});
