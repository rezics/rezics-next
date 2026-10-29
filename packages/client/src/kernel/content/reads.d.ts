import type { Pool } from 'pg';
import { type Access, type Actor, type Resource } from '../request/access.ts';
import type { KeyRing } from '../tokens/seal.ts';
import type { Anchored, BoardId, BoardView, ErasedPlaceholder, ItemView as StoredItemView, Page, PostId, ReadContext, RevisionId, RevisionView as StoredRevisionView, ThreadId, ThreadView as StoredThreadView } from './model.ts';
import { REACTION_KINDS } from './events.ts';
declare const subjectReactionKinds: readonly ['like', 'love', 'laugh', 'insightful', 'sad'];
export type RealmDisclosureScope = {
    realmId?: string | null;
    realmResource?: Resource;
    realmEvidence?: unknown;
    realmEvidencePrepared?: boolean;
    associationCheck?: Promise<boolean>;
    accessCheck?: Promise<boolean>;
};
/** Share one containing-Realm proof across the thread and post checks in a disclosure. */
export declare function currentRealmDisclosureScope(): RealmDisclosureScope | undefined;
/** One exact command replay. GET reads stay outside this scope, so owner roles
 * and the public floor still cannot authorize erased metadata. */
export declare function withReplayedRevision<T>(revisionId: string, read: () => Promise<T>): Promise<T>;
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
export type PostEntry = ItemView | ErasedPlaceholder;
export type ThreadView = Omit<StoredThreadView, 'firstPost'> & Readonly<{
    firstPost: PostEntry;
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
export type SubjectReactionKind = (typeof subjectReactionKinds)[number];
export type SubjectReactionCount = Readonly<{
    kind: SubjectReactionKind;
    count: number;
}>;
export type SubjectReactionCounts = readonly SubjectReactionCount[];
type Counted<T> = T extends ErasedPlaceholder & {
    readonly revisionId?: never;
} ? T : T & {
    readonly reactions: ReactionCountMap;
};
/** One index seek per partition over the page's targets. Zero kinds are omitted.
 * The freshness is the oldest source watermark among the count rows actually read. */
export declare function withReactionCounts<T extends {
    readonly id: string;
}>(dependencies: ContentReadDependencies, targets: readonly T[], deadline: number): Promise<{
    readonly items: readonly Counted<T>[];
    readonly reactionsAsOf: ReactionCountFreshness | null;
}>;
/** Read at most five relayed subject totals per id with one statement per target partition. */
export declare function readSubjectReactionCounts(dependencies: Pick<ContentReadDependencies, 'pool'>, subjectIds: readonly string[], deadline?: number): Promise<Map<string, SubjectReactionCounts>>;
export declare function readThread(dependencies: ContentReadDependencies, threadId: ThreadId, context: ReadContext): Promise<Anchored<ThreadView | null>>;
/** Subject listings use the same final thread, post, board and Access checks as exact thread reads, then
 * confirm the current subject reference and board's current Global/Realm placement in that snapshot. */
export declare function readSubjectThread(dependencies: ContentReadDependencies, threadId: ThreadId, subjectId: string, placeId: string, context: ReadContext): Promise<Anchored<ThreadView | null>>;
/** Send-time disclosure uses the ordinary read resources and current account standing,
 * without constructing a bearer principal. Release every observation before Access checks. */
export declare function postReadableByAccount(dependencies: Pick<ContentReadDependencies, 'pool' | 'access'>, accountId: string, threadId: string, postId: string, context: Pick<ReadContext, 'deadline'>): Promise<boolean>;
export declare function readPost(dependencies: ContentReadDependencies, threadId: ThreadId, postId: PostId, context: ReadContext, revisionId?: RevisionId): Promise<Anchored<PostEntry | null>>;
export declare function listThreadPosts(dependencies: ContentReadDependencies, threadId: ThreadId, context: ReadContext, cursor?: string, limit?: number): Promise<Page<PostEntry>>;
export declare function listPostRevisions(dependencies: ContentReadDependencies, threadId: ThreadId, postId: PostId, context: ReadContext, cursor?: string, limit?: number): Promise<Page<RevisionView>>;
export declare function discloseThreads(dependencies: ContentReadDependencies, threadIds: readonly ThreadId[], context: ReadContext): Promise<readonly Anchored<ThreadView | null>[]>;
