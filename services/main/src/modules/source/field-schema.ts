// Row types for Content migrations 042/043. The Work English title slot and Work
// author credits keep their 009-021 rows; general slots use these tables. Native
// values and control epochs remain in the target owner.

export type FieldDisposition = 'native' | 'structured-source-only' | 'lossy' | 'excluded' | 'unsupported';
export type FieldValueKind = 'identifier' | 'text' | 'language-text' | 'time' | 'quantity' | 'reference'
  | 'term' | 'structure' | 'metadata' | 'statistic' | 'provider-account';
export type FieldSupportAction = 'apply' | 'attach' | 'return-control';
export type FieldSupportOutcome = 'applied' | 'attached' | 'returned' | 'not-applied';

/** Slots owned by the title-only and author-credit tables; general supports reject them. */
export const LEGACY_SUPPORT_SLOTS = ['work-metadata-v1#title:en', 'work-author-credit-v1#*'] as const;
/** Inventory reason for an observed field the mapping does not declare. */
export const UNDECLARED_FIELD = 'undeclared-field';

export interface FieldMappingRow {
  mapping_revision: string;
  provider: string;
  namespace: string;
  root_grain: string;
  field_count: number;
  created_at: Date;
}

export interface FieldDispositionRow {
  mapping_revision: string;
  grain: string;
  field_key: string;
  disposition: FieldDisposition;
  value_kind: FieldValueKind;
  reason: string;
  native_target: string | null;
  loss: string | null;
}

/** One `source.conversion.field_inventory` entry for a general mapping. */
export interface ConversionFieldEntry {
  grain: string;
  field: string;
  disposition: FieldDisposition;
  reason?: typeof UNDECLARED_FIELD;
}

export interface FieldSupportRow {
  id: string;
  principal_id: string;
  target: string;
  slot: string;
  occurrence: string | null;
  context: string;
  record_id: string;
  created_at: Date;
}

/** Native CAS inputs; null heads are explicit absence. */
export interface FieldControlIntent {
  contentHead: string;
  controlHead: string | null;
  controlEpoch: number;
  protectionHead: string | null;
  [key: string]: unknown;
}

export interface FieldSupportStepRow {
  id: string;
  support_id: string;
  ordinal: number;
  principal_id: string;
  action: FieldSupportAction;
  conversion_id: string;
  mapping_revision: string;
  grain: string;
  source_field: string;
  source_occurrence: string | null;
  value_digest: string;
  expected_head: string;
  control_intent: FieldControlIntent | null;
  acting_subject: string;
  authority_proof: Record<string, unknown>;
  native_idempotency_key: string | null;
  idempotency_key: string;
  request_digest: string;
  created_at: Date;
}

export interface FieldSupportOutcomeRow {
  step_id: string;
  outcome: FieldSupportOutcome;
  native_revision: string | null;
  graph_receipt: string | null;
  admission_id: string | null;
  data_epoch: string | null;
  sequence: string | null;
  head_guarantee: 'transaction-guarded' | 'verified-before-commit';
  receipt: Record<string, unknown>;
  created_at: Date;
}

export interface FieldSupportHeadRow {
  support_id: string;
  step_count: number;
  settled_step_id: string | null;
  pending_step_id: string | null;
}

export interface FieldSupportWithdrawalRow {
  id: string;
  support_id: string;
  principal_id: string;
  expected_step_id: string | null;
  idempotency_key: string;
  reason: string;
  created_at: Date;
}
