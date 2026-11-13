import type { Actor } from '../request/access.ts';
import { type AuthoritativeTime, type CommandAuthorization } from '../command/command.ts';
import { type ContentCommandDependencies } from './commands.ts';
import type { HostedPointSelectionReads, HostedPublicationPointInput } from './hosted-publication-point-selection.ts';
import { type HostedCommandContext, type HostedCreateInput, type HostedDependencies, type HostedReviseInput, type HostedPublishInput, type HostedRootAppendInput } from './hosted-chapters-model.ts';
export type HostedCommandDependencies = HostedDependencies & ContentCommandDependencies;
export declare function createHostedCatalogue(deps: HostedCommandDependencies, actor: Actor, input: HostedCreateInput, context: HostedCommandContext): Promise<import("../command/command.ts").CommandOutcome<Readonly<{
    catalogueId: string;
    revisionId: string;
}>>>;
export declare function reviseHostedCatalogue(deps: HostedCommandDependencies, actor: Actor, catalogueId: string, input: HostedReviseInput, context: HostedCommandContext): Promise<import("../command/command.ts").CommandOutcome<Readonly<{
    catalogueId: string;
    revisionId: string;
}>>>;
export declare function publishHostedCatalogue(deps: HostedCommandDependencies, actor: Actor, catalogueId: string, input: HostedPublishInput, context: HostedCommandContext): Promise<import("../command/command.ts").CommandOutcome<Readonly<{
    catalogueId: string;
    revisionId: string;
}>>>;
/** Appends one root chapter to an exact draft head. Shares native edit authority,
 * deadlines, receipt replay, transaction retries and final container checks. */
export declare function appendHostedRootChapter(deps: HostedCommandDependencies, actor: Actor, catalogueId: string, input: HostedRootAppendInput, context: HostedCommandContext): Promise<import("../command/command.ts").CommandOutcome<Readonly<{
    catalogueId: string;
    revisionId: string;
}>>>;
/** Build the native admission and receipt binding for a point operation. The
 * storage owner supplies reads pinned to the request's expected Book versions;
 * the returned preparation is consumed by its transaction writer. */
export declare function prepareHostedPublicationPointCommand(deps: HostedCommandDependencies, actor: Actor, catalogueId: string, operation: HostedPublicationPointInput, reads: HostedPointSelectionReads, context: HostedCommandContext): Promise<{
    catalogueId: string;
    partition: number;
    receipt: {
        kind: string;
        key: string;
        digest: Uint8Array<ArrayBufferLike>;
    };
    authorization: CommandAuthorization;
    prepared(time: AuthoritativeTime): Readonly<{
        selection: import("./hosted-publication-point-selection.ts").HostedPointSelection;
        publicEligibility: import("./hosted-publication-point-eligibility.ts").HostedPointPublicEligibility;
        final(): Promise<void>;
    }>;
}>;
