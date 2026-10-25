import type { Pool } from 'pg';
import { type Access, type Actor } from '../request/access.ts';
import type { KeyRing } from '../tokens/seal.ts';
import type { Anchored, BoardId, BoardView, ItemView as StoredItemView, Page, PostId, ReadContext, RevisionId, RevisionView, ThreadId, ThreadView as StoredThreadView } from './model.ts';
/** Published erased slots remain readable, but never disclose revision bodies. */
export type ItemView = StoredItemView & (Readonly<{
    availability: 'available';
}> | Readonly<{
    availability: 'erased';
    removed: true;
}>);
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
export declare function readThread(dependencies: ContentReadDependencies, threadId: ThreadId, context: ReadContext): Promise<Anchored<ThreadView | null>>;
export declare function readPost(dependencies: ContentReadDependencies, threadId: ThreadId, postId: PostId, context: ReadContext, revisionId?: RevisionId): Promise<Anchored<ItemView | null>>;
export declare function listThreadPosts(dependencies: ContentReadDependencies, threadId: ThreadId, context: ReadContext, cursor?: string, limit?: number): Promise<Page<ItemView>>;
export declare function listPostRevisions(dependencies: ContentReadDependencies, threadId: ThreadId, postId: PostId, context: ReadContext, cursor?: string, limit?: number): Promise<Page<RevisionView>>;
export declare function discloseThreads(dependencies: ContentReadDependencies, threadIds: readonly ThreadId[], context: ReadContext): Promise<readonly Anchored<ThreadView | null>[]>;
