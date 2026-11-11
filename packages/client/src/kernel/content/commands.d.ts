import type { Pool } from 'pg';
import { type CommandAuthorization, type CommandOutcome } from '../command/command.ts';
import type { Access, Actor, Resource } from '../request/access.ts';
import { type RealmParticipationCheck } from '../community/participation.ts';
import type { ContentCommandValue, PostInput, RequestContext, RevisionInput, ThreadInput } from './model.ts';
import { type BoardSlowReceiptReference } from './board-slow.ts';
export type { ReviewVoteCitation } from './model.ts';
export { DocumentTooLargeError, InvalidDocumentError } from './document.ts';
export type ContentCommandDependencies = Readonly<{
    pool: Pool;
    access: Access;
    routeKey: Uint8Array;
    realmParticipation?: RealmParticipationCheck;
    clock: () => Date;
}>;
export type ThreadTarget = Resource;
type ThreadCreationInput = ThreadInput & Readonly<{
    mediaIds?: readonly string[];
}>;
export declare class ContentNotFoundError extends Error {
    constructor();
}
export declare class ContentUndisclosedError extends ContentNotFoundError {
    constructor();
}
export declare class ContentForbiddenError extends Error {
    constructor();
}
export declare class RevisionPreconditionError extends Error {
    constructor();
}
export declare class ReviewConflictError extends Error {
    constructor();
}
export declare function threadTarget(routeKey: Uint8Array, accountId: string, idempotencyKey: string): Resource;
/** Hosted structure edits share the ordinary Post owner and container admission.
 * They do not create a Post, publish a body or reserve a posting interval. */
export declare function hostedPostAuthorization(dependencies: ContentCommandDependencies, actor: Actor, threadId: string, postId: string, context: RequestContext, receipt: BoardSlowReceiptReference): CommandAuthorization;
export declare function createThread(dependencies: ContentCommandDependencies, actor: Actor, input: ThreadCreationInput, context: RequestContext): Promise<CommandOutcome<ContentCommandValue>>;
export declare function createPost(dependencies: ContentCommandDependencies, actor: Actor, input: PostInput, context: RequestContext): Promise<CommandOutcome<ContentCommandValue>>;
export declare function revisePost(dependencies: ContentCommandDependencies, actor: Actor, input: RevisionInput, context: RequestContext): Promise<CommandOutcome<ContentCommandValue>>;
