// Row types for Content migrations 040/041. SQL remains the DDL owner; captures are
// `source.observation` rows and the rate gate is `source.provider_rate_gate`.

export type RunRetention = 'retained' | 'not-retained';
export type SurfaceOutcome = 'qualified' | 'unqualified' | 'failed';
export type RunCompletionOutcome = 'completed' | 'incomplete' | 'abandoned';
export type FeedCheckpointKind = 'baseline' | 'change' | 'reconciliation';
export type FeedContinuity = 'baseline' | 'contiguous' | 'overlap' | 'gap' | 'reconciled';

/** Reason codes: `complete` only for qualified; others name the access or fetch limit. */
export const SURFACE_REASONS = {
  qualified: ['complete'],
  unqualified: ['authentication-required', 'authorization-denied', 'terms-restricted', 'surface-unavailable'],
  failed: ['network', 'http-status', 'malformed', 'oversized', 'rate-limited', 'timeout',
    'budget-exhausted', 'identity-mismatch', 'redirect-refused'],
} as const satisfies Record<SurfaceOutcome, readonly string[]>;

export const RUN_LIMITS = { surfaces: 32, capturesPerSurface: 4096, feedPageItems: 10_000, openGaps: 64 } as const;

export interface AcquisitionRunRow {
  id: string;
  principal_id: string;
  provider: string;
  profile: string;
  surface_count: number;
  idempotency_key: string;
  request_digest: string;
  created_at: Date;
}

export interface AcquisitionRunSurfaceRow {
  run_id: string;
  surface: string;
  ordinal: number;
  required: boolean;
  capture_limit: number;
  requested_retention: RunRetention;
  retention_terms: 'permitted' | 'prohibited';
  terms_reference: string;
  effective_retention: RunRetention;
  retention_limited: boolean;
}

export interface RunCaptureRow {
  id: string;
  run_id: string;
  surface: string;
  ordinal: number;
  role: 'response' | 'context' | 'manifest';
  request_key: string;
  observation_id: string;
  created_at: Date;
}

export interface RunSurfaceOutcomeRow {
  run_id: string;
  surface: string;
  outcome: SurfaceOutcome;
  reason: string;
  capture_count: number;
  capture_set_digest: string | null;
  detail: Record<string, unknown>;
  created_at: Date;
}

export interface AcquisitionRunCompletionRow {
  run_id: string;
  outcome: RunCompletionOutcome;
  qualified_count: number;
  unqualified_count: number;
  failed_count: number;
  missing_count: number;
  created_at: Date;
}

export interface FeedRow {
  id: string;
  principal_id: string;
  provider: string;
  namespace: string;
  feed_key: string;
  position_scheme: 'provider-sequence' | 'provider-time-us';
  max_page_items: number;
  created_at: Date;
}

/** Positions are numeric(38,0) and read as decimal strings. */
export interface FeedCheckpointRow {
  id: string;
  feed_id: string;
  seq: number;
  predecessor_id: string | null;
  kind: FeedCheckpointKind;
  run_id: string;
  capture_id: string | null;
  from_position: string;
  to_position: string;
  resume_token: string | null;
  item_count: number;
  continuity: FeedContinuity;
  closes_gap_id: string | null;
  created_at: Date;
}

export interface FeedHeadRow {
  feed_id: string;
  checkpoint_id: string | null;
  seq: number;
  position: string | null;
}

export interface FeedOpenGapRow {
  checkpoint_id: string;
  feed_id: string;
  gap_from: string;
  gap_to: string;
}
