import type { MainClient } from '../discover/types.ts';

// Main's projection and target-rating reads, taken from the typed Eden client so a contract change breaks this
// build (`services/main/src/modules/projection`, `.../rating/target-*.ts`, `.../rating/rollup-api.ts`).
type Main = MainClient['v1'];
type Resource = ReturnType<Main['resources']>;
type Ok<Call> = Call extends (...args: never[]) => Promise<{ data: infer Data }> ? NonNullable<Data> : never;

/** Main answers a first use that is still settling with a pending operation instead of the projection. */
export type ProjectionAnswer = Ok<Main['projections']['post']>;
export type ProjectionWrite = Extract<ProjectionAnswer, { projection: unknown }>;
export type ProjectionView = ProjectionWrite['projection'];
export type SummaryBatch = Ok<Main['resources']['summaries']['post']>;
export type ResourceSummary = SummaryBatch['summaries'][number];
export type AvailableSummary = Extract<ResourceSummary, { status: 'available' }>;
export type QuestionPage = Ok<Resource['rating-contexts']['get']>;
export type Question = QuestionPage['items'][number];
type RatingRead = Ok<Resource['ratings']['get']>;
/** A target's figures for one question: count and histogram always, the mean only from the display threshold. */
export type TargetRating = Extract<RatingRead, { profile: 'target-rating-read-v1' }>;
export type Rollup = Ok<Main['rating-rollups']['post']>;
export type RollupMember = Rollup['members'][number];
export type RollupFormula = Rollup['formula'];

/** Every figure of a target and question comes from here, so a stale answer can never be shown as the latest. */
export type Outcome<T> = { ok: true; data: T } | { ok: false; failure: Failure };

/** Why a read or write has no data; each region says its own and the rest of the sheet stays. */
export type Failure = 'missing' | 'sign-in' | 'denied' | 'moved' | 'conflict' | 'invalid' | 'work-mismatch' | 'unavailable';

/** `value` is the problem body Main answered with; its `code` tells a frame set from two Works from any other refusal. */
export function failureOf(status: number, value?: unknown): Failure {
  if (status === 422 && value && typeof value === 'object' && 'code' in value && value.code === 'projection_frame_work_mismatch') return 'work-mismatch';
  if (status === 404) return 'missing';
  if (status === 401) return 'sign-in';
  if (status === 403) return 'denied';
  if (status === 409) return 'conflict';
  if (status === 400 || status === 422) return 'invalid';
  return 'unavailable';
}

/** The place a subject is rated within: where it lives and what it is called. */
export interface Subject {
  iri: string;
  /** The subject's display name, in its own language and direction. */
  name: { value: string; language: string; direction: 'ltr' | 'rtl' };
}
