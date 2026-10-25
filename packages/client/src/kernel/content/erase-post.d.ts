import type { Pool } from 'pg';
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
}> | Readonly<{
    action: 'media:erase';
    kind: 'media';
    id: string;
    reason: string;
}>;
/** Shared native point boundary. Callers bind an action and kind in server code;
 * request bodies cannot supply authority, author selection or storage keys.
 * All account, scope, delegation and grant checks belong to shared Access.
 */
export declare function mutateContentPoint(deps: ErasePostDependencies, actor: Actor, requested: Point, context: ErasePostContext): Promise<CommandOutcome<{
    targetId: string;
    securityRevision: string;
}>>;
/** Erase one actual post without enumerating its revisions or media. Native
 * author-erasure work separately pages physical rows and authorizes each post.
 */
export declare function erasePostLogical(deps: ErasePostDependencies, actor: Actor, input: ErasePostInput, context: ErasePostContext): Promise<CommandOutcome<{
    postId: string;
    securityRevision: string;
}>>;
export {};
