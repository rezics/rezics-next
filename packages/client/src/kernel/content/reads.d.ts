import type { Pool } from 'pg';
import { type Access, type Actor } from '../request/access.ts';
import type { KeyRing } from '../tokens/seal.ts';
import type { Anchored, BoardId, BoardView, ItemView as StoredItemView, Page, PostId, ReadContext, RevisionId, RevisionView as StoredRevisionView, ThreadId, ThreadView as StoredThreadView } from './model.ts';
import { REACTION_KINDS } from './events.ts';
export type ViewerReactionKind = (typeof REACTION_KINDS)[number];
/** Erased slots retain identity without disclosing bytes or a digest of erased text. */
type ContentPayload = Readonly<{
    availability: 'available';
    body: NonNullable<StoredItemView['body']>;
    sha256: string;
}> | Readonly<{
    availability: 'erased';
    removed: true;
    body: null;
    sha256: null;
}>;
export type ItemView = Omit<StoredItemView, 'availability' | 'body' | 'sha256'> & ContentPayload;
export type RevisionView = Omit<StoredRevisionView, 'availability' | 'body' | 'sha256'> & ContentPayload;
export type ThreadView = Omit<StoredThreadView, 'firstPost'> & Readonly<{
    firstPost: ItemView;
}>;
export type ContentReadDependencies = Readonly<{
    pool: Pool;
    access: Access;
    tokens: KeyRing;
    clock?: () => Date;
}>;
export type { Actor };
export declare class ContentNotFoundError extends Error {
    constructor();
}
export declare function readBoard(dependencies: ContentReadDependencies, boardId: BoardId, context: ReadContext): Promise<Anchored<BoardView | null>>;
/** One partition seek for the account viewer's slots. Anonymous responses omit the field. */
export declare function withViewerReactions<T extends {
    readonly id: string;
}>(dependencies: ContentReadDependencies, actor: Actor, targets: readonly T[], deadline: number): Promise<readonly (T & {
    viewerReaction?: ViewerReactionKind | null;
})[]>;
export type ReactionCountFreshness = Readonly<{
    epoch: number;
    position: string;
}>;
type ReactionCountMap = Partial<Record<ViewerReactionKind, number>>;
/** One index seek per partition over the page's targets. Zero kinds are omitted.
 * The freshness is the oldest source watermark among the count rows actually read. */
export declare function withReactionCounts<T extends {
    readonly id: string;
}>(dependencies: ContentReadDependencies, targets: readonly T[], deadline: number): Promise<{
    readonly items: readonly (T & {
        readonly reactions: ReactionCountMap;
    })[];
    readonly reactionsAsOf: ReactionCountFreshness | null;
}>;
export declare function readThread(dependencies: ContentReadDependencies, threadId: ThreadId, context: ReadContext): Promise<Anchored<ThreadView | null>>;
export declare function readPost(dependencies: ContentReadDependencies, threadId: ThreadId, postId: PostId, context: ReadContext, revisionId?: RevisionId): Promise<Anchored<ItemView | null>>;
export declare function listThreadPosts(dependencies: ContentReadDependencies, threadId: ThreadId, context: ReadContext, cursor?: string, limit?: number): Promise<Page<ItemView>>;
export declare function listPostRevisions(dependencies: ContentReadDependencies, threadId: ThreadId, postId: PostId, context: ReadContext, cursor?: string, limit?: number): Promise<Page<RevisionView>>;
export declare function discloseThreads(dependencies: ContentReadDependencies, threadIds: readonly ThreadId[], context: ReadContext): Promise<readonly Anchored<ThreadView | null>[]>;
