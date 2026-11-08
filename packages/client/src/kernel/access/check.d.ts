import type { Access, AccessCheck, AccessContext, AccessExplicitCheck, ActionCatalogue, Actor, PrepareReadDecisionsInput, PreparedAccessCheckInvocation, PreparedAccessCheckWork, ReadDecisions, Resource, ResourcePage } from '../request/access.ts';
export { AuthenticationError } from './contract/authentication.ts';
export type * from '../request/access.ts';
/** Reject malformed pages synchronously, before any database or actor read. */
export declare function resourcePage(page: ResourcePage): ResourcePage;
/** Validate the bounded catalogue before reading any authority dependency. */
export declare function validReadDecisionActions(input: PrepareReadDecisionsInput, catalogue: ActionCatalogue): boolean;
type PreparedWorkFactory = (actor: Actor, action: string, resource: Resource, evidence: unknown, dispatch: (input: PreparedAccessCheckInvocation) => Promise<boolean>) => PreparedAccessCheckWork | undefined;
/** Installed only by the original native evaluator and its original wrapper. */
export declare function installPreparedAccessCheckWork(access: Access, factory: PreparedWorkFactory): void;
export declare function nativePreparedAccessCheckWork(access: Access, actor: Actor, action: string, resource: Resource, evidence: unknown, dispatch: (input: PreparedAccessCheckInvocation) => Promise<boolean>): PreparedAccessCheckWork | undefined;
export declare function accessCheck(access: Access, actor: Actor, action: string, resource: Resource, context: AccessContext): Promise<AccessCheck>;
/** Resolve the installed port through derived adapters; never infer explicit
 * authority from an adapter's ordinary boolean decision. */
export declare function accessExplicitCheck(access: Access, actor: Actor, action: string, resource: Resource, context: AccessContext): Promise<AccessExplicitCheck>;
/** The installed root owns the sole batch read formula, including through adapters. */
export declare function prepareReadDecisions(access: Access, input: PrepareReadDecisionsInput): Promise<ReadDecisions>;
