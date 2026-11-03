import { type RealmSubjectReadContext } from './realm-subject-disclosure-work.ts';
import type { Pool } from 'pg';
import type { AuthoritativeTime } from '../command/command.ts';
import type { AccessContext } from '../request/access.ts';
import type { ContentEditionSource } from './edition-model.ts';
import { type DurableOperationAnchor, type InitiatorRestorer } from '../access/durable-initiator.ts';
import { type Partition } from '../partition/partition.ts';
import { type Access, type AccessClient, type Actor, type ReadDecisions, type Resource } from '../request/access.ts';
import type { KeyRing } from '../tokens/seal.ts';
import type { Anchored, AnchoredPosition, BoardId, BoardRecord as BoardView, ErasedPlaceholder, ItemView as StoredItemView, Page, PostId, ReadContext, RevisionId, RevisionView as StoredRevisionView, ReviewVoteCitation, ThreadId, ThreadView as StoredThreadView, Visibility } from './model.ts';
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
/** Server-owned work between initial and final disclosure, without changing the published reader port. */
export declare function withThreadReadAdmission<T>(beforeFinal: () => Promise<void>, read: () => Promise<T>): Promise<T>;
/** Share one containing-Realm proof across the thread and post checks in a disclosure. */
export declare function currentRealmDisclosureScope(): RealmDisclosureScope | undefined;
/** One exact command replay. GET reads stay outside this scope, so owner roles
 * and the public floor still cannot authorize erased metadata. */
export declare function withReplayedRevision<T>(revisionId: string, read: () => Promise<T>): Promise<T>;
export type ViewerReactionKind = (typeof REACTION_KINDS)[number];
/** Erased slots retain identity without disclosing bytes or a digest of erased text. */
type AvailablePayload = Readonly<{
    availability: 'available';
    body: NonNullable<StoredItemView['body']>;
    sha256: string;
}>;
type ErasedPayload = Readonly<{
    availability: 'erased';
    removed: true;
    body: null;
    sha256: null;
    restorableUntil?: string;
}>;
type ContentPayload = AvailablePayload | ErasedPayload;
type WithheldPayload = Readonly<{
    availability: 'withheld';
    removed: true;
    body: null;
    sha256: null;
    decisionId?: string;
}>;
type ItemFields = Omit<StoredItemView, 'availability' | 'body' | 'sha256'>;
export type ItemView = ItemFields & ContentPayload;
export type WithheldPostEntry = ItemFields & WithheldPayload;
export type RevisionView = Omit<StoredRevisionView, 'availability' | 'body' | 'sha256'> & ContentPayload;
export type PostEntry = ItemView | (ErasedPlaceholder & {
    readonly restorableUntil?: string;
}) | WithheldPostEntry;
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
type Kind = 'board' | 'thread' | 'post' | 'revision';
type Row = {
    kind: Kind;
    id: string;
    thread_id: string | null;
    board_id: string | null;
    parent_id: string | null;
    author_id: string | null;
    head_id: string | null;
    first_post_id: string | null;
    thread_kind: 'discussion' | 'review' | null;
    board_purpose: 'discussion' | 'reviews' | null;
    vote_citation: ReviewVoteCitation | null;
    title: string | null;
    visibility: Visibility;
    security_revision: string;
    availability: 'available' | 'erased';
    created_at: Date;
    revised_at: Date | null;
    licence: string;
    subject_ids: string[];
    media_ids: string[];
    body: Buffer | null;
    sha256: Buffer | null;
    realm_id: string | null;
    deleted_at: Date | null;
    restorable: boolean;
    decision_id: string | null;
    matches?: boolean | null;
};
export declare class ContentNotFoundError extends Error {
    constructor();
}
/** All pool preparation happens outside this boundary. A failed rollback evicts
 * the connection rather than returning an open transaction to the pool. */
export declare function snapshot<T>(dependencies: Pick<ContentReadDependencies, 'pool' | 'access'>, id: string, context: Pick<RealmSubjectReadContext, 'deadline' | 'work'>, work: (client: AccessClient) => Promise<T>): Promise<Anchored<T>>;
type BoardDisclosureFinal = Readonly<{
    boardAnchor: AnchoredPosition;
    parentAllowed: boolean;
}>;
type BoardDisclosureHint = Readonly<{
    boardId: BoardId;
    board: BoardView;
    decisions?: ReadDecisions;
    query?: string;
    expectedRevisions?: ReadonlyMap<string, string>;
    onFinal?: (final: BoardDisclosureFinal) => void;
}>;
export declare function withBoardDisclosure<T>(boardId: BoardId, board: BoardView, work: () => Promise<T>, decisions?: ReadDecisions, options?: Pick<BoardDisclosureHint, 'query' | 'expectedRevisions' | 'onFinal'>): Promise<T>;
export declare function prepareBoardPageDecisions(dependencies: ContentReadDependencies, context: ReadContext): Promise<ReadDecisions>;
/** @internal Shared post-read resources: every domain operand uses the evaluator's principal. */
export declare function readResource(row: Row, evidence: object, tombstone?: boolean, placeholder?: boolean, withheldReference?: boolean): Resource;
export declare function readBoard(dependencies: ContentReadDependencies, boardId: BoardId, context: ReadContext): Promise<Anchored<import('./model.ts').BoardView | null>>;
export declare function readBoardPageCandidateSnapshot<T>(dependencies: ContentReadDependencies, boardId: BoardId, context: ReadContext, decisions: ReadDecisions, candidatePage: (client: AccessClient, partition: Partition) => Promise<T>): Promise<Readonly<{
    board: BoardView;
    anchor: Anchored<BoardView>;
    candidate: T;
}> | null>;
type SelectionRound = Readonly<{
    survivors: readonly string[];
    revisions: ReadonlyMap<string, string>;
    anchors: readonly AnchoredPosition[];
}>;
export declare function selectBoardThreadCandidates(dependencies: ContentReadDependencies, boardId: BoardId, threadIds: readonly string[], context: ReadContext, decisions: ReadDecisions, query?: string): Promise<SelectionRound>;
export declare function discloseBoardPageThreads(dependencies: ContentReadDependencies, boardId: BoardId, baseline: BoardView, threadIds: readonly string[], expectedRevisions: ReadonlyMap<string, string>, context: ReadContext, decisions: ReadDecisions, query?: string): Promise<Readonly<{
    items: readonly Anchored<ThreadView | null>[];
    boardAnchor: AnchoredPosition;
    parentAllowed: boolean;
}>>;
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
/** Internal exact-opening evidence. This shares the ordinary native resources,
 * board observation, ancestry, account fences and Access evaluator. It loads no
 * document bytes and cannot enumerate candidates or establish census coverage.
 */
export declare function prepareRealmSubjectThreadDisclosure(dependencies: Pick<ContentReadDependencies, 'pool' | 'access'>, candidate: Readonly<{
    threadId: string;
    openingPostId: string;
    subjectId: string;
}>, realmId: string, context: RealmSubjectReadContext): Promise<Readonly<{
    state: 'positive' | 'absent' | 'withheld';
    signature: string | null;
    anchors: readonly AnchoredPosition[];
    final(): Promise<Readonly<{
        signature: string;
        anchors: readonly AnchoredPosition[];
    }> | null>;
}>>;
/** Send-time disclosure uses the ordinary read resources and current account standing,
 * without constructing a bearer principal. Release every observation before Access checks. */
export declare function postReadableByAccount(dependencies: Pick<ContentReadDependencies, 'pool' | 'access'>, accountId: string, threadId: string, postId: string, context: Pick<ReadContext, 'deadline'>): Promise<boolean>;
export declare function readPost(dependencies: ContentReadDependencies, threadId: ThreadId, postId: PostId, context: ReadContext, revisionId?: RevisionId): Promise<Anchored<PostEntry | null>>;
export declare function listThreadPosts(dependencies: ContentReadDependencies, threadId: ThreadId, context: ReadContext, cursor?: string, limit?: number): Promise<Page<PostEntry>>;
export declare function listPostRevisions(dependencies: ContentReadDependencies, threadId: ThreadId, postId: PostId, context: ReadContext, cursor?: string, limit?: number): Promise<Page<RevisionView>>;
export declare function discloseThreads(dependencies: ContentReadDependencies, threadIds: readonly ThreadId[], context: ReadContext): Promise<readonly Anchored<ThreadView | null>[]>;
/** Exact native rules reader. It shares the ordinary row, ancestry and Access
 * formula; the immutable requested revision never becomes the current head. */
export declare function readExactPublishedRules(dependencies: Pick<ContentReadDependencies, 'pool' | 'access' | 'clock'>, references: readonly (import('./community-presentation-rules.ts').RulesReference & {
    realmId: string;
})[], context: ReadContext): Promise<ReadonlyMap<string, import('./community-presentation-rules.ts').PresentedRules>>;
/** Current bounded board response composition. The native internal reader stays
 * independent, so exact post/rules reads cannot recurse into presentation. */
export declare function readBoards(dependencies: ContentReadDependencies, boardIds: readonly string[], context: ReadContext): Promise<readonly Anchored<import('./model.ts').BoardView | null>[]>;
/** Edition publication enrolls just the selected source post. Ancestors keep their
 * ordinary read formula; this port cannot authorize an ordinary post route. */
export declare function prepareEditionSource(dependencies: Pick<ContentReadDependencies, 'pool' | 'access'>, source: ContentEditionSource, context: ReadContext, time: AuthoritativeTime, accessContext: AccessContext, ordinarySource: boolean): Promise<Readonly<{
    check(client: AccessClient): Promise<boolean>;
    final(): Promise<boolean>;
}> | null>;
/** Native publisher checks restore separately for every action and exact resource.
 * This never creates a workflow ReadContext or supplies a buyer identity. */
export declare function prepareEditionPublisherSource(dependencies: Pick<ContentReadDependencies, 'pool' | 'access'>, source: ContentEditionSource, operation: DurableOperationAnchor, restorer: InitiatorRestorer, time: AuthoritativeTime, accessContext: AccessContext): Promise<Readonly<{
    check(client: AccessClient): Promise<boolean>;
    final(): Promise<boolean>;
}> | null>;
