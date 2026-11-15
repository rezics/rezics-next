import type { Actor } from '../request/access.ts';
import { type CommandOutcome } from '../command/command.ts';
import { type ContentCommandDependencies } from './commands.ts';
import type { HostedCommandContext, HostedDependencies } from './hosted-chapters-model.ts';
import type { HostedPublicationStagingBatchResult, HostedPublicationStagingCheckpoint } from './hosted-publication-staging-model.ts';
export type HostedPublicationPreparationDependencies = HostedDependencies & ContentCommandDependencies;
export type HostedPublicationPreparationCandidate = Readonly<{
    candidateId: string;
    generationId: string;
    afterSourceOrder: string | null;
    placementCount: string;
    rootCount: string;
    chapterCount: string;
    coverageComplete: boolean;
    sealed: boolean;
}>;
export type HostedPublicationPreparationProgress = Readonly<{
    catalogueId: string;
    stageId: string;
    stage: HostedPublicationStagingCheckpoint;
    batch?: HostedPublicationStagingBatchResult;
    candidate: HostedPublicationPreparationCandidate | null;
    candidateReady: boolean;
}>;
/** Start a whole or explicit selection stage from the expected live Book source.
 * The expected IDs are stale-intent preconditions; the stage captures the exact
 * descriptor and current publication pointer inside this transaction. */
export declare function startHostedPublicationPreparation(deps: HostedPublicationPreparationDependencies, actor: Actor, catalogueId: string, input: Readonly<{
    stageId: string;
    expectedRevisionId: string;
    expectedPublicationId: string | null;
    mode: 'whole' | 'selection';
}>, context: HostedCommandContext): Promise<CommandOutcome<Readonly<{
    catalogueId: string;
    stageId: string;
    stage: HostedPublicationStagingCheckpoint;
    batch?: HostedPublicationStagingBatchResult;
    candidate: HostedPublicationPreparationCandidate | null;
    candidateReady: boolean;
}>>>;
export declare function appendHostedPublicationPreparationBatch(deps: HostedPublicationPreparationDependencies, actor: Actor, catalogueId: string, stageId: string, input: Readonly<{
    batchId: string;
    occurrenceIds: readonly string[];
}>, context: HostedCommandContext): Promise<CommandOutcome<Readonly<{
    catalogueId: string;
    stageId: string;
    stage: HostedPublicationStagingCheckpoint;
    batch?: HostedPublicationStagingBatchResult;
    candidate: HostedPublicationPreparationCandidate | null;
    candidateReady: boolean;
}>>>;
export declare function freezeHostedPublicationPreparationSelection(deps: HostedPublicationPreparationDependencies, actor: Actor, catalogueId: string, stageId: string, context: HostedCommandContext): Promise<CommandOutcome<Readonly<{
    catalogueId: string;
    stageId: string;
    stage: HostedPublicationStagingCheckpoint;
    batch?: HostedPublicationStagingBatchResult;
    candidate: HostedPublicationPreparationCandidate | null;
    candidateReady: boolean;
}>>>;
/** Advance exactly one retained staging or candidate page. The choice of source
 * phase and frontier comes only from native progress and candidate checkpoints. */
export declare function advanceHostedPublicationPreparation(deps: HostedPublicationPreparationDependencies, actor: Actor, catalogueId: string, stageId: string, stepId: string, context: HostedCommandContext): Promise<CommandOutcome<Readonly<{
    catalogueId: string;
    stageId: string;
    stage: HostedPublicationStagingCheckpoint;
    batch?: HostedPublicationStagingBatchResult;
    candidate: HostedPublicationPreparationCandidate | null;
    candidateReady: boolean;
}>>>;
export declare function readHostedPublicationPreparationProgress(deps: HostedPublicationPreparationDependencies, actor: Actor, catalogueId: string, stageId: string, context: HostedCommandContext): Promise<CommandOutcome<Readonly<{
    catalogueId: string;
    stageId: string;
    stage: HostedPublicationStagingCheckpoint;
    batch?: HostedPublicationStagingBatchResult;
    candidate: HostedPublicationPreparationCandidate | null;
    candidateReady: boolean;
}>>>;
export declare function cancelHostedPublicationPreparation(deps: HostedPublicationPreparationDependencies, actor: Actor, catalogueId: string, stageId: string, context: HostedCommandContext): Promise<CommandOutcome<Readonly<{
    catalogueId: string;
    stageId: string;
    stage: HostedPublicationStagingCheckpoint;
    batch?: HostedPublicationStagingBatchResult;
    candidate: HostedPublicationPreparationCandidate | null;
    candidateReady: boolean;
}>>>;
/** Seal coverage when complete, then seal the exact private candidate only after
 * its retained page frontier proves full source coverage. */
export declare function sealHostedPublicationPreparation(deps: HostedPublicationPreparationDependencies, actor: Actor, catalogueId: string, stageId: string, context: HostedCommandContext): Promise<CommandOutcome<Readonly<{
    catalogueId: string;
    stageId: string;
    stage: HostedPublicationStagingCheckpoint;
    batch?: HostedPublicationStagingBatchResult;
    candidate: HostedPublicationPreparationCandidate | null;
    candidateReady: boolean;
}>>>;
