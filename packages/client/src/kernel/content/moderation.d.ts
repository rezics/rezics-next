import type { Pool } from 'pg';
import type { CommandOutcome } from '../command/command.ts';
import type { Access, Actor } from '../request/access.ts';
import { type ErasePostInput } from './erase-post.ts';
import type { MediaId, PostId, RequestContext, ThreadId } from './model.ts';
export type ModerationDependencies = Readonly<{
    pool: Pool;
    access: Access;
    routeKey: Uint8Array;
    clock: () => Date;
}>;
export type TakedownTarget = Readonly<{
    kind: 'board';
    id: string;
}> | Readonly<{
    kind: 'thread';
    id: ThreadId;
}> | Readonly<{
    kind: 'post';
    id: PostId;
}>;
export type TakedownInput = Readonly<{
    target: TakedownTarget;
    reason: string;
}>;
export type EraseStandaloneMediaInput = Readonly<{
    mediaId: MediaId;
    reason: string;
}>;
export type ModerationValue = Readonly<{
    targetId: string;
    securityRevision: string;
}>;
export declare function takedown(dependencies: ModerationDependencies, actor: Actor, input: TakedownInput, context: RequestContext): Promise<CommandOutcome<ModerationValue>>;
export declare function erasePost(dependencies: ModerationDependencies, actor: Actor, input: ErasePostInput, context: RequestContext): Promise<CommandOutcome<{
    postId: string;
    securityRevision: string;
}>>;
export declare function eraseStandaloneMedia(dependencies: ModerationDependencies, actor: Actor, input: EraseStandaloneMediaInput, context: RequestContext): Promise<CommandOutcome<ModerationValue>>;
