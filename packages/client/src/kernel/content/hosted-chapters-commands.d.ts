import type { Actor } from '../request/access.ts';
import { type ContentCommandDependencies } from './commands.ts';
import { type HostedCommandContext, type HostedCreateInput, type HostedDependencies, type HostedReviseInput, type HostedPublishInput } from './hosted-chapters-model.ts';
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
