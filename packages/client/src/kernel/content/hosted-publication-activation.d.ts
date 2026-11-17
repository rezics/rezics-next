import type { Actor } from '../request/access.ts';
import { type CommandOutcome } from '../command/command.ts';
import { type ContentCommandDependencies } from './commands.ts';
import { type ContentReadDependencies } from './reads.ts';
import type { HostedCommandContext } from './hosted-chapters-model.ts';
export type HostedPublicationActivationState = 'checking' | 'ready' | 'restart' | 'activated';
export type HostedPublicationActivationProgress = Readonly<{
    catalogueId: string;
    stageId: string;
    state: HostedPublicationActivationState;
    passId: string;
    checkedTargetCount: string;
    totalTargetCount: string;
    candidateGenerationId: string;
    publicationId: string | null;
    restartRequired: boolean;
}>;
export type HostedPublicationActivationDependencies = ContentReadDependencies & ContentCommandDependencies;
export declare class HostedPublicationActivationNotFoundError extends Error {
    constructor();
}
export declare class HostedPublicationActivationConflictError extends Error {
    constructor(message?: string);
}
export declare class HostedPublicationActivationIneligibleError extends Error {
    readonly reason: 'catalogue_not_public' | 'chapter_not_eligible';
    constructor(reason: 'catalogue_not_public' | 'chapter_not_eligible');
}
/** Begin currentness checks for one immutable, sealed candidate. The full
 * installed vector is captured before any fresh target or container read. */
export declare function startHostedPublicationActivation(deps: HostedPublicationActivationDependencies, actor: Actor, catalogueId: string, stageId: string, context: HostedCommandContext): Promise<CommandOutcome<HostedPublicationActivationProgress>>;
/** Advance at most 20 distinct exact targets. A restart captures a fresh fixed
 * vector first and reuses the same immutable candidate generation. */
export declare function advanceHostedPublicationActivationAuthority(deps: HostedPublicationActivationDependencies, actorInput: Actor, catalogueId: string, stageId: string, context: HostedCommandContext): Promise<CommandOutcome<HostedPublicationActivationProgress>>;
/** Compare only recorded dependency homes and keep their row locks through the
 * descriptor/root/publication CAS, receipt, event and COMMIT. A stale vector
 * schedules a new authority pass without rebuilding the candidate. */
export declare function activateHostedPublicationCandidate(deps: HostedPublicationActivationDependencies, actorInput: Actor, catalogueId: string, stageId: string, context: HostedCommandContext): Promise<CommandOutcome<HostedPublicationActivationProgress>>;
