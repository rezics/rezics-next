import type { DurationCohort } from '../session/duration-contract.ts';

/** Proposed POST /v1/activity-duration-estimates, public exposure/read family.
 * Exactly 1–16 distinct cohorts, in request order; no wildcard or catalogue scan.
 * Each source selection is explicit, 0–16 retained Source aggregate IRIs. */
export interface ActivityDurationEstimatesRequest {
  profile: 'activity-duration-estimates-v1';
  actingSubject?: string;
  cohorts: DurationCohort[];
  sources: string[];
}

export interface NativeDurationEstimate {
  population: 'public-opt-in-session-runs';
  countingRule: 'latest-observation-per-session';
  eligibleCount: number;
  sampleCount: number;
  incompleteCount: number;
  /** Finished runs without a known duration; disjoint from incompleteCount. */
  unknownDurationCount: number;
  sumSeconds: string;
  estimate:
    | { status: 'no-data'; value: null }
    | { status: 'available'; value: { numerator: string; denominator: string } };
  estimator: 'arithmetic-mean-finished-known-v1';
  unit: 'http://qudt.org/vocab/unit/SEC';
  /** Cohort-local evidence; unrelated writes leave this response unchanged.
   * The witness is opaque and contains no session, principal or observation ID. */
  evidence: { generation: string; revision: string };
}

export interface SourceDurationEstimate {
  source: string;
  sourceRevision: string;
  retrievedAt: string;
  procedure: string | null;
  unit: string | null;
  sampleCount: number | null;
  estimate: string | null;
  missing: ('procedure' | 'unit' | 'sample-count' | 'estimate')[];
  /** Source statistics never become native samples or share their denominator. */
  population: 'source-reported';
}

export interface ActivityDurationEstimatesResponse {
  profile: 'activity-duration-estimates-v1';
  cohorts: {
    cohort: DurationCohort;
    native: NativeDurationEstimate;
    sources: SourceDurationEstimate[];
  }[];
}
