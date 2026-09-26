/**
 * Row types for Content migration 110 (`semantic` schema in Main's PostgreSQL).
 * The SQL migration is the DDL owner; these rows are private staging, never native
 * semantic state. Activation reuses the graph command receipt and records it here.
 */
export const STAGE_PROFILE = 'semantic-change-bulk-v1';
export const STAGE_LIMITS = { pages: 4096, itemsPerPage: 10_000, pageBytes: 8_388_608 } as const;

export type StageValidationOutcome = 'conforming' | 'nonconforming' | 'unsupported' | 'budget-exhausted';
export type StageOutcome = 'activated' | 'rejected' | 'abandoned';
export type StageRejection = 'nonconforming' | 'unsupported' | 'budget-exhausted'
  | 'generation-changed' | 'stale-head' | 'denied' | 'abandoned';

/** `semantic.change_stage`: immutable; the posture column admits only `reject`. */
export interface ChangeStageRow {
  id: string;
  admission_id: string;
  principal_id: string;
  acting_subject: string;
  idempotency_key: string;
  request_digest: string;
  profile: typeof STAGE_PROFILE;
  model_generation: string;
  validation_posture: 'reject';
  manifest_digest: string;
  page_count: number;
  item_count: string;
  byte_count: string;
  created_at: Date;
}

/** `semantic.change_stage_pending`: open stages in creation order. */
export interface ChangeStagePendingRow { stage_id: string; created_at: Date }

/** `semantic.change_stage_page`: stored and read-back verified immutable page. */
export interface ChangeStagePageRow {
  stage_id: string;
  ordinal: number;
  page_digest: string;
  item_count: number;
  byte_size: number;
  created_at: Date;
}

/** `semantic.change_stage_validation`: one result per page and model generation. */
export interface ChangeStageValidationRow {
  stage_id: string;
  ordinal: number;
  model_generation: string;
  outcome: StageValidationOutcome;
  report_digest: string | null;
  validated_at: Date;
}

/** `semantic.change_stage_outcome`: terminal certificate naming the graph receipt. */
export interface ChangeStageOutcomeRow {
  stage_id: string;
  outcome: StageOutcome;
  reason: StageRejection | null;
  model_generation: string;
  graph_receipt: string | null;
  data_epoch: string | null;
  /** numeric(38,0), exposed as a decimal string. */
  sequence: string | null;
  created_at: Date;
}
