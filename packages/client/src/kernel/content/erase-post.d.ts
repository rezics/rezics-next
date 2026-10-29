import type { Pool } from 'pg';
import type { DurableOperationAnchor, InitiatorRestorer } from '../access/durable-initiator.ts';
import { type CommandOutcome } from '../command/command.ts';
import { type Access, type Actor } from '../request/access.ts';
export type ErasePostDependencies = Readonly<{
    pool: Pool;
    access: Access;
    routeKey: Uint8Array;
    clock?: () => Date;
}>;
export type ErasePostContext = Readonly<{
    deadline: number;
    idempotencyKey: string;
    requestId: string;
}>;
export type ErasePostInput = Readonly<{
    postId: string;
    reason: string;
}>;
/** Trusted workflow composition only. Attribution locates the original person's
 * receipt; it supplies no authority. Restoration verifies the immutable source
 * and returns a fresh native identity inside every command attempt's prepare.
 */
export type ErasureInitiator = Readonly<{
    kind: 'durable-initiator';
    operation: DurableOperationAnchor;
    accountId: string;
    clientId: string;
    requestedBy: string | null;
    restorer: InitiatorRestorer;
}>;
type Point = Readonly<{
    action: 'moderation:takedown';
    kind: 'board' | 'thread' | 'post';
    id: string;
    reason: string;
}> | Readonly<{
    action: 'post:erase';
    kind: 'post';
    id: string;
    reason: string;
    softDelete?: boolean;
}> | Readonly<{
    action: 'media:erase';
    kind: 'media';
    id: string;
    reason: string;
}>;
/** Ordinary point callers retain the original authenticated-actor boundary. */
export declare function mutateContentPoint(deps: ErasePostDependencies, actor: Actor, requested: Point, context: ErasePostContext): Promise<CommandOutcome<{
    targetId: string;
    securityRevision: string;
}>>;
/** The ordinary owner DELETE retains history during its restore window. */
export declare function softDeletePost(deps: ErasePostDependencies, actor: Actor, input: ErasePostInput, context: ErasePostContext): Promise<{
    partition: number;
    epoch: number;
    position: bigint;
    transactionId: string;
    replayed: boolean;
    value: {
        postId: string;
        securityRevision: string;
    };
}>;
export declare function erasePostLogical(deps: ErasePostDependencies, actor: Actor, input: ErasePostInput, context: ErasePostContext): Promise<CommandOutcome<{
    postId: string;
    securityRevision: string;
}>>;
/** Person-attributed native workflow variant; uses the identical point command,
 * mutation, authorization/admission seam and source receipts as ordinary erasure.
 */
export declare function erasePostLogicalAsInitiator(deps: Omit<ErasePostDependencies, 'routeKey'>, initiator: ErasureInitiator, input: ErasePostInput, context: ErasePostContext): Promise<CommandOutcome<{
    postId: string;
    securityRevision: string;
}>>;
/** One bounded logical page, authorized completely at the command's T before
 * receipt lookup or mutations. Access prepares evidence once per attempt and
 * evaluates one formula statement for every post; one denied post rolls back
 * the entire page, including its events and receipt.
 */
export declare function erasePostLogicalPageAsInitiator(deps: Omit<ErasePostDependencies, 'routeKey'>, initiator: ErasureInitiator, input: Readonly<{
    postIds: readonly string[];
    threadId: string;
    reason: string;
}>, context: ErasePostContext): Promise<CommandOutcome<{
    postIds: string[];
    processedPosts: number;
    erasedRevisions: number;
}>>;
export {};
