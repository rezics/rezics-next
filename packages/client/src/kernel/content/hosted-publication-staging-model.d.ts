import type { HostedChapterTarget, HostedChapterLanguages } from './hosted-chapters-model.ts';
export declare const HOSTED_PUBLICATION_STAGING_STEP_LIMIT = 20;
export declare const HOSTED_PUBLICATION_STAGING_BATCH_LIMIT = 1024;
export type HostedPublicationStagingMode = 'whole' | 'selection';
export type HostedPublicationStagingSourceKind = 'snapshot' | 'prefix' | 'ordered';
export type HostedPublicationStagingState = 'collecting' | 'building' | 'closing' | 'ready' | 'sealed' | 'cancelled' | 'expired' | 'failed';
export type HostedPublicationStagingLocator = Readonly<{
    catalogueId: string;
    stageId: string;
}>;
export type BeginHostedPublicationStaging = HostedPublicationStagingLocator & Readonly<{
    expectedHeadRevisionId: string;
    expectedPublicationId: string | null;
    mode: HostedPublicationStagingMode;
    expiresAt: Date | string;
}>;
export type AppendHostedPublicationSelection = HostedPublicationStagingLocator & Readonly<{
    batchId: string;
    occurrenceIds: readonly string[];
}>;
export type HostedPublicationStagingCheckpoint = Readonly<{
    locator: HostedPublicationStagingLocator;
    state: HostedPublicationStagingState;
    mode: HostedPublicationStagingMode;
    /** Optional only for checkpoints persisted before the binding fields were added. */
    sourceRevisionId?: string;
    expectedHeadRevisionId?: string;
    expectedPublicationId?: string | null;
    inputVersion: string;
    inputCount: string;
    settledInputCount: string;
    candidateCount: string;
    sourceFrontier: string;
    sourceExhausted: boolean;
    closureFrontier: string;
    closureCheckedCount: string;
    closureMissingCount: string;
    failure: string | null;
}>;
export type HostedPublicationStagingStepResult = Readonly<{
    replayed: boolean;
    phase: 'whole' | 'selection' | 'closure';
    processed: number;
    progress: HostedPublicationStagingCheckpoint;
}>;
export type HostedPublicationStagingBatchResult = Readonly<{
    replayed: boolean;
    inputVersion: string;
    firstInputPosition: string;
    itemCount: number;
}>;
export type HostedPublicationStagingSeal = Readonly<{
    locator: HostedPublicationStagingLocator;
    sourceRevisionId: string;
    expectedHeadRevisionId: string;
    expectedPublicationId: string | null;
    mode: HostedPublicationStagingMode;
    inputVersion: string;
    candidateCount: string;
    sealedAt: string;
}>;
export type HostedPublicationStagedCandidate = Readonly<{
    sourceOrder: string;
    occurrenceId: string;
    parentId: string | null;
    position: string;
    sourceSegment: 'snapshot' | 'base' | 'append' | 'ordered';
    kind: 'part' | 'chapter';
    title: string | null;
    target: HostedChapterTarget | null;
    bodyLanguages?: HostedChapterLanguages;
}>;
export type HostedPublicationTargetObservation = Readonly<{
    target: HostedChapterTarget;
    authorId: string;
    licence: string;
    observedAt: string;
}>;
export type HostedPublicationActivationTarget = HostedPublicationTargetObservation & Readonly<{
    occurrenceId: string;
}>;
export type HostedPublicationTargetCursor = Readonly<{
    threadId: string;
    postId: string;
    revisionId: string;
    sha256: string;
}>;
export type HostedPublicationStagingPage<T, C = string> = Readonly<{
    items: readonly T[];
    next: C | null;
}>;
export declare class HostedPublicationStagingConflictError extends Error {
    constructor(message?: string);
}
export declare class HostedPublicationStagingNotFoundError extends Error {
    constructor();
}
export declare class HostedPublicationStagingExpiredError extends Error {
    constructor();
}
export declare class HostedPublicationStagingCheckpointUnavailableError extends Error {
    constructor();
}
export declare function requireSafeSourceOrder(value: string): number;
