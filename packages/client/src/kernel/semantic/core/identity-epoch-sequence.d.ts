import type { IdentityJobRef, IdentityStepName, IdentityStepProgress } from '../contract/identity-values.ts';
import type { IdentityStepReceiptLocator } from '../contract/identity-epoch-ports.ts';
/** Pages per durable workflow segment. A segment yields and resumes from its saved job locator. */
export declare const IDENTITY_EPOCH_SEGMENT_PAGES = 100;
/** Pause between segments, taken outside any durable step. */
export declare const IDENTITY_EPOCH_WAIT_INTERVAL_MS = 100;
/** Producer frontier bounds: at most eight scalar keys and 2048 JSON bytes; at most 100 rows per page. */
export declare const IDENTITY_EPOCH_FRONTIER_KEYS = 8;
export declare const IDENTITY_EPOCH_FRONTIER_BYTES = 2048;
export declare const IDENTITY_EPOCH_STEP_ROWS = 100;
export type IdentityEpochNext = 'preparing' | 'cancelling' | 'cancelled' | 'published' | 'mapping' | 'search-canonical-index' | 'library-private-follow-counts' | 'publish';
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
export declare function identityEpochNext(view: IdentityEpochObservation): IdentityEpochNext | IdentityEpochConflict;
/** Durable workflow ID. Segment 0 is the original job; later segments add one bounded suffix. */
export declare function identityEpochWorkflowId(job: Readonly<{
    jobId: string;
    epoch: string;
}>, segment?: number): string;
export type IdentityEpochReceiptCheck = Readonly<{
    ok: true;
    locator: IdentityStepReceiptLocator;
}> | Readonly<{
    ok: false;
    reason: 'invalid-progress' | 'no-progress';
}>;
/** Validate one producer result against its job, step and bounds, then return its scoped locator. */
export declare function identityEpochReceiptLocator(ref: IdentityJobRef, step: IdentityStepName, progress: IdentityStepProgress): IdentityEpochReceiptCheck;
