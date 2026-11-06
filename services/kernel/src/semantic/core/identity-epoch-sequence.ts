import type { IdentityJobRef, IdentityStepName, IdentityStepProgress } from '../contract/identity-values.ts';
import type { IdentityStepReceiptLocator } from '../contract/identity-epoch-ports.ts';

/** Pages per durable workflow segment. A segment yields and resumes from its saved job locator. */
export const IDENTITY_EPOCH_SEGMENT_PAGES = 100;
/** Pause between segments, taken outside any durable step. */
export const IDENTITY_EPOCH_WAIT_INTERVAL_MS = 100;
/** Producer frontier bounds: at most eight scalar keys and 2048 JSON bytes; at most 100 rows per page. */
export const IDENTITY_EPOCH_FRONTIER_KEYS = 8;
export const IDENTITY_EPOCH_FRONTIER_BYTES = 2048;
export const IDENTITY_EPOCH_STEP_ROWS = 100;

export type IdentityEpochNext =
  | 'preparing'
  | 'cancelling'
  | 'cancelled'
  | 'published'
  | 'mapping'
  | 'search-canonical-index'
  | 'library-private-follow-counts'
  | 'publish';

/** A native state that contradicts itself; the caller reports it as unavailable and never repairs it here. */
export type IdentityEpochConflict = 'publication-control-disagrees' | 'reservation-lost';

/** Facts the Store observed in one read snapshot. The derivation performs no I/O. */
export type IdentityEpochObservation = Readonly<{
  job: IdentityJobRef;
  jobState: string;
  mappingComplete: boolean;
  searchComplete: boolean;
  libraryComplete: boolean;
  control: Readonly<{
    publishedEpoch: bigint;
    pendingJob: string | null;
    pendingEpoch: bigint | null;
    prepareJob: string | null;
    prepareEpoch: bigint | null;
  }>;
}>;

/** Decide the next step of one job from its observed native state. */
export function identityEpochNext(view: IdentityEpochObservation): IdentityEpochNext | IdentityEpochConflict {
  const { job, control } = view;
  if (view.jobState === 'published')
    return control.publishedEpoch < job.epoch || control.pendingJob === job.jobId
      ? 'publication-control-disagrees'
      : 'published';
  if (view.jobState === 'cancelled' || view.jobState === 'cancelling') return view.jobState;
  // A preparing job holds the prepare reservation; acquisition mirrors the same job into pending before promotion.
  const owned =
    view.jobState === 'preparing'
      ? control.prepareJob === job.jobId && control.prepareEpoch === job.epoch
      : control.pendingJob === job.jobId && control.pendingEpoch === job.epoch;
  if (!owned) return 'reservation-lost';
  if (view.jobState === 'preparing') return 'preparing';
  if (!view.mappingComplete) return 'mapping';
  if (!view.searchComplete) return 'search-canonical-index';
  if (!view.libraryComplete) return 'library-private-follow-counts';
  return 'publish';
}

/** Durable workflow ID. Segment 0 is the original job; later segments add one bounded suffix. */
export function identityEpochWorkflowId(job: Readonly<{ jobId: string; epoch: string }>, segment = 0): string {
  const base = `semantic:identity:${job.jobId}:${job.epoch}`;
  return segment === 0 ? base : `${base}:segment:${segment}`;
}

export type IdentityEpochReceiptCheck =
  | Readonly<{ ok: true; locator: IdentityStepReceiptLocator }>
  | Readonly<{ ok: false; reason: 'invalid-progress' | 'no-progress' }>;

/** Validate one producer result against its job, step and bounds, then return its scoped locator. */
export function identityEpochReceiptLocator(
  ref: IdentityJobRef,
  step: IdentityStepName,
  progress: IdentityStepProgress,
): IdentityEpochReceiptCheck {
  const receipt = progress.receipt;
  if (
    !sameJob(progress.job, ref) ||
    !sameJob(receipt.job, ref) ||
    receipt.step !== step ||
    receipt.version !== 1 ||
    !['more', 'complete'].includes(progress.state) ||
    progress.frontier.after.length > IDENTITY_EPOCH_FRONTIER_KEYS ||
    new TextEncoder().encode(JSON.stringify(progress.frontier)).byteLength > IDENTITY_EPOCH_FRONTIER_BYTES ||
    progress.work.rows > IDENTITY_EPOCH_STEP_ROWS ||
    Object.values(progress.work).some((value) => !Number.isSafeInteger(value) || value < 0)
  )
    return { ok: false, reason: 'invalid-progress' };
  if (progress.state === 'more' && progress.work.rows + progress.work.points + progress.work.engineRequests === 0)
    return { ok: false, reason: 'no-progress' };
  return {
    ok: true,
    locator: {
      job: { jobId: ref.jobId, epoch: ref.epoch.toString() },
      step,
      version: 1,
      native: { ...receipt.native, position: receipt.native.position.toString() },
    },
  };
}

const sameJob = (a: IdentityJobRef, b: IdentityJobRef) => a.jobId === b.jobId && a.epoch === b.epoch;
