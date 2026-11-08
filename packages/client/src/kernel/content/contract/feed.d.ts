import type { SubjectSummary } from '../../semantic/contract/index.ts';
import type { ContinuePage, ContinueSubject } from '../../library/contract/index.ts';
/** Mixed Home feed vocabulary and consumer-owned continuation, summary and presentation ports. */
export declare const FEED_PAGE_LIMIT = 20;
export declare const FEED_CANDIDATE_LIMIT = 160;
export declare const FEED_CONTINUE_WIDTH = 6;
export declare const FEED_CONTINUE_CANDIDATES = 39;
export declare const FEED_DISCOVERY_CANDIDATES_PER_RESULT = 6;
export declare const FEED_DISCOVERY_FIXED_CANDIDATES = 3;
export declare const FEED_ACCOUNT_BATCH_LIMIT = 100;
export declare const FEED_AUTHOR_KEYS_PER_CANDIDATE = 3;
export declare const FEED_SPACE_FIXED_KEYS = 4;
export declare const FEED_SPACE_BOARD_KEYS_PER_CANDIDATE = 1;
export declare const FEED_CURSOR_BYTES = 32768;
export declare const FEED_KIND_MAX = 256;
export declare const FEED_LANES: readonly ['continue', 'following', 'discovery'];
export type FeedLane = (typeof FEED_LANES)[number];
export type FeedStream = 'home' | 'following';
export type FeedSourceState = 'ready' | 'preparing' | 'unavailable' | 'not_requested';
export type FeedAccountActor = Readonly<{
    kind: 'account';
    accountId: string;
    scopes: readonly string[];
}>;
export type FeedAnonymousActor = Readonly<{
    kind: 'anonymous';
}>;
export type FeedActor = FeedAccountActor | FeedAnonymousActor;
export type FeedSelection = Readonly<{
    spaceId?: string;
    ratingQuestionId?: string;
}>;
export type FeedReadQuery = Readonly<{
    stream?: FeedStream;
    limit?: number;
    cursor?: string;
    kind?: string;
    spaceId?: string;
    ratingQuestionId?: string;
}>;
export type FeedPosition = Readonly<{
    boundary: string;
    turn: number;
    discovery: string | null | false;
    following: string | null | false;
    continue: string | null | false;
    resume: Readonly<{
        fingerprint: string;
        after: string;
    }> | null;
}>;
export type FeedKey<Owner extends string = string, Kind extends string = string> = Readonly<{
    owner: Owner;
    kind: Kind;
    route: number;
    id: string;
}>;
export type FeedSubjectReactionKind = 'like' | 'love' | 'laugh' | 'insightful' | 'sad';
export type FeedSubjectReactions = {
    target: {
        targetKind: 'subject';
        targetId: string;
    };
    counts: {
        state: 'available';
        values: Partial<Record<FeedSubjectReactionKind, number>>;
        asOf: FeedReactionFreshness | null;
    } | {
        state: 'unavailable';
    };
    viewer?: {
        state: 'available';
        kind: FeedSubjectReactionKind | null;
    } | {
        state: 'unavailable';
    };
    action: 'sign_in' | 'allowed' | 'denied' | 'unavailable';
};
/** Semantic owns the disclosed summary; reactions are a Content-only addition. */
export type FeedPublicSummary = SubjectSummary & {
    subjectReactions?: FeedSubjectReactions;
};
export type FeedContinuationSubject = ContinueSubject<FeedPublicSummary>;
export type FeedContinuationPage = ContinuePage<FeedPublicSummary>;
export type FeedContinuationQuery = Readonly<{
    limit: number;
    view: 'FULL';
    cursor?: string;
    spaceId?: string;
    kind?: string;
}>;
export type FeedAvatar = Readonly<{
    media: string;
    width: number;
    height: number;
    placeholder: Readonly<{
        thumbhash: string;
        color: string;
    }>;
    variants: readonly Readonly<{
        format: 'avif' | 'webp';
        width: number;
    }>[];
    focalPoint: Readonly<{
        x: number;
        y: number;
    }> | null;
    credit: null;
}>;
export type FeedAuthor = Readonly<{
    displayName: string | null;
    handle: string | null;
    avatar: FeedAvatar | null;
}>;
export type FeedReactionKind = 'upvote' | 'downvote' | 'like' | 'love' | 'laugh' | 'insightful' | 'sad';
export type FeedReactionTarget = Readonly<{
    targetKind: 'thread' | 'post';
    targetId: string;
}>;
export type FeedReactionCounts = Readonly<Partial<Record<FeedReactionKind, number>>>;
export type FeedReactionAdvice = Readonly<{
    target: FeedReactionTarget;
    state: 'current';
    allowed: readonly FeedReactionKind[];
}> | Readonly<{
    target: FeedReactionTarget;
    state: 'sign_in' | 'unavailable';
}>;
export type FeedReactionFreshness = Readonly<{
    epoch: number;
    position: string;
}>;
export type FeedConversationActivity = Readonly<{
    state: 'current';
    cohort: 'public';
    count: Readonly<{
        kind: 'exact' | 'lower-bound';
        value: number;
    }>;
    lastActivityAt: string | null;
}> | Readonly<{
    state: 'withheld';
}>;
export type FeedReviewContext = Readonly<{
    target: Readonly<{
        state: 'available';
        subject: Readonly<{
            id: string;
            kind: string;
            label: Readonly<{
                value: string;
                language: string;
            }> | null;
        }>;
    }> | Readonly<{
        state: 'absent' | 'withheld';
    }>;
    citation: Readonly<{
        state: 'available';
        question: Readonly<{
            id: string;
            revision: number;
            label: string;
            grain: 'work' | 'release' | 'episode' | 'character';
            scale: Readonly<{
                min: number;
                max: number;
                displayStep: number;
            }>;
        }>;
        units: number;
        voteRevision: number;
    }> | Readonly<{
        state: 'absent' | 'withheld';
    }>;
}>;
export type FeedParentContext = Readonly<{
    kind: 'opening';
}> | Readonly<{
    kind: 'reply';
    parent: Readonly<{
        state: 'available';
        id: string;
        revisionId: string;
        createdAt: string;
        author: Readonly<{
            id: string;
            displayName: string | null;
            handle: string | null;
        }> | null;
        excerpt: string | null;
        language: string | null;
        spoiler: boolean;
    }> | Readonly<{
        state: 'removed';
        id: string;
    }> | Readonly<{
        state: 'withheld';
    }>;
}>;
export type FeedContentSummary = {
    author?: FeedAuthor;
    excerpt?: string;
    reviewContext?: FeedReviewContext;
    conversationActivity?: FeedConversationActivity;
    reactionTarget?: FeedReactionTarget;
    reactions?: FeedReactionCounts;
    viewerReaction?: FeedReactionKind | null;
    reactionAdvice?: FeedReactionAdvice;
};
export type FeedDiscoveryReviewSummary = Omit<FeedContentSummary, 'author'> & {
    id: string;
    kind: 'review';
    title: string | null;
    author?: {
        displayName: string | null;
        handle: string | null;
    };
    subject?: {
        id: string;
        title: string | null;
    } | null;
};
export type FeedSubjectDestination = {
    kind: 'subject';
    id: string;
    title: string | null;
};
export type FeedAccountDestination = {
    kind: 'account';
    id: string;
    title: string | null;
};
export type FeedThreadDestination = {
    kind: 'thread';
    id: string;
    title: string | null;
};
export type FeedCollectionDestination = {
    kind: 'collection';
    id: string;
    title: string | null;
};
export type FeedPostDestination = {
    kind: 'post';
    id: string;
    title: string | null;
    threadId: string;
    postId: string;
};
export type FeedSpaceDestination = {
    kind: 'space';
    id: string;
    title: string | null;
    address: string;
};
export type FeedDestination = FeedSubjectDestination | FeedAccountDestination | FeedThreadDestination | FeedCollectionDestination | FeedPostDestination | FeedSpaceDestination;
type FeedRow<Source extends string, Key extends FeedKey, Summary, Destination extends FeedDestination, Extra = object> = Extra & {
    id: string;
    source: Source;
    key: Key;
    occurredAt: string | null;
    summary: Summary;
    destination: Destination;
};
export type FeedItem = FeedRow<'discovery', FeedKey<'semantic', string>, FeedPublicSummary, FeedSubjectDestination> | FeedRow<'discovery', FeedKey<'accounts', 'account'>, {
    id: string;
    accountKind: 'actor' | 'organization';
    handle: string | null;
    displayName: string | null;
    automated: boolean;
    operatorId: string | null;
    avatar: FeedAvatar | null;
    verifiedAgent: {
        id: string;
        label: string;
        type: string;
    } | null;
}, FeedAccountDestination> | FeedRow<'discovery', FeedKey<'commerce', 'collection'>, {
    id: string;
    title: string;
    description: string | null;
    card: unknown;
}, FeedCollectionDestination> | FeedRow<'discovery', FeedKey<'content', 'review'>, FeedDiscoveryReviewSummary, FeedThreadDestination> | FeedRow<'discovery', FeedKey<'content', 'space'>, {
    id: string;
    title: string;
    address: string;
    summary?: string;
    realm?: {
        id: string;
        title: string | null;
    } | null;
}, FeedSpaceDestination> | FeedRow<'continue', FeedKey<'semantic', string>, FeedPublicSummary, FeedSubjectDestination, {
    continue: FeedContinuationSubject;
}> | FeedRow<'following', FeedKey<'semantic', string>, FeedPublicSummary, FeedSubjectDestination> | FeedRow<'following', FeedKey<'content', 'thread'>, FeedContentSummary & {
    id: string;
    kind: 'discussion' | 'review';
    title: string | null;
    createdAt: string;
}, FeedThreadDestination> | FeedRow<'following', FeedKey<'content', 'post'>, FeedContentSummary & {
    id: string;
    threadId: string;
    createdAt: string;
    title: string | null;
    parentContext?: FeedParentContext;
}, FeedPostDestination> | FeedRow<'following', FeedKey<'library', 'collection'>, {
    id: string;
    title: string;
    description: string | null;
}, FeedCollectionDestination>;
export type FeedLaneCandidate = Readonly<{
    item: FeedItem | null;
    after?: string;
}>;
export type FeedPage = Readonly<{
    feedItems: readonly FeedItem[];
    viewerPersonalActions?: unknown;
    next: string | null;
    asOf: string;
    reactionsAsOf?: FeedReactionFreshness | null;
    sources: Readonly<{
        discovery: FeedSourceState;
        following: FeedSourceState;
        continue: FeedSourceState;
    }>;
}>;
export type FeedReads = Readonly<{
    list(actor: FeedActor, query: FeedReadQuery, deadline: number, languages: readonly string[]): Promise<FeedPage>;
}>;
export type FeedRefusalCode = 'invalid_request' | 'invalid_cursor' | 'stale_cursor' | 'forbidden' | 'authentication_required' | 'not_found' | 'unsupported_query' | 'dependency_unavailable' | 'deadline_exceeded';
export declare class FeedRefusedError extends Error {
    readonly code: FeedRefusalCode;
    constructor(code: FeedRefusalCode);
}
export declare class FeedBoundExceededError extends RangeError {
    constructor();
}
export type FeedLaneLoad = Readonly<{
    candidates: readonly FeedLaneCandidate[];
    next: string | null | false;
    asOf?: string;
    fingerprint?: string;
}>;
export type FeedSpaceSession = Readonly<{
    spaceId: string;
    finish(): Promise<void>;
}>;
export type FeedContinuationPort = Readonly<{
    page(actor: FeedActor, query: FeedContinuationQuery, deadline: number, languages: readonly string[]): Promise<FeedContinuationPage>;
}>;
export type FeedPublicSummaryPort = Readonly<{
    read(actor: FeedActor, ids: readonly string[], languages: readonly string[], deadline: number): Promise<ReadonlyMap<string, FeedPublicSummary>>;
}>;
export type FeedPresentationPort = Readonly<{
    present(row: FeedContinuationSubject): FeedContinuationSubject;
}>;
export type FeedDiscoveryPort = Readonly<{
    page(input: {
        actor: FeedActor;
        limit: number;
        languages: readonly string[];
        kind?: string;
        spaceId?: string;
        cursor?: string;
        deadline: number;
    }): Promise<FeedLaneLoad>;
}>;
export type FeedFollowingPort = Readonly<{
    page(input: {
        actor: FeedAccountActor;
        limit: number;
        languages: readonly string[];
        kind?: string;
        boundary: string;
        cursor?: string;
        deadline: number;
        space?: FeedSpaceSession;
    }): Promise<FeedLaneLoad>;
}>;
export type FeedAdmissionPort = Readonly<{
    following(actor: FeedAccountActor, deadline: number): Promise<void>;
    personalLibrary(actor: FeedAccountActor, deadline: number): Promise<void>;
    readingProgress(actor: FeedAccountActor, deadline: number): Promise<void>;
    discovery(actor: FeedActor, deadline: number): Promise<void>;
}>;
export type FeedCursorPort = Readonly<{
    fingerprint(value: unknown): string;
    encode(actor: FeedActor, query: FeedReadQuery, languages: readonly string[], position: FeedPosition, now: Date): Promise<string>;
    decode(actor: FeedActor, query: FeedReadQuery, languages: readonly string[], cursor: string, now: Date): Promise<FeedPosition>;
}>;
export type FeedSpacePort = Readonly<{
    open(actor: FeedActor, spaceId: string, deadline: number, asOf: string): Promise<FeedSpaceSession>;
    openPopulation(actor: FeedActor, space: FeedSpaceSession, deadline: number, asOf: string): Promise<FeedSpaceSession | undefined>;
}>;
export type FeedFinishResult = {
    items: FeedItem[];
    rewind?: ReadonlySet<FeedLane>;
    error?: unknown;
    reactionsAsOf?: FeedReactionFreshness | null;
};
export type FeedFinishPort = Readonly<{
    beginConversation(items: FeedItem[], deadline: number): Promise<Pick<FeedFinishResult, 'rewind' | 'error'>>;
    confirmConversation(items: FeedItem[], deadline: number): Promise<FeedFinishResult>;
    contentContext(items: FeedItem[], actor: FeedActor, languages: readonly string[], deadline: number): Promise<FeedFinishResult>;
    reactions(items: FeedItem[], actor: FeedActor, deadline: number): Promise<FeedFinishResult>;
    reactionAdvice(items: FeedItem[], actor: FeedActor, deadline: number, stream: FeedStream): Promise<{
        items: FeedItem[];
        finish?(items: FeedItem[]): Promise<FeedItem[]>;
        hasTargets?: boolean;
    }>;
    subjectReactions(items: FeedItem[], actor: FeedActor, deadline: number): Promise<FeedFinishResult>;
    followSupport(items: FeedItem[], actor: FeedActor, deadline: number): Promise<FeedFinishResult>;
    personalActions(items: FeedItem[], actor: FeedActor, languages: readonly string[], deadline: number, reopen: () => Promise<FeedItem[]>): Promise<{
        items: FeedItem[];
        viewerPersonalActions?: unknown;
    }>;
    reopenSelected(items: FeedItem[], actor: FeedActor, query: FeedReadQuery, languages: readonly string[], deadline: number): Promise<FeedItem[]>;
}>;
export type FeedApplicationPorts = Readonly<{
    continuation?: FeedContinuationPort;
    publicSummary?: FeedPublicSummaryPort;
    presentation?: FeedPresentationPort;
    discovery?: FeedDiscoveryPort;
    following?: FeedFollowingPort;
    admission: FeedAdmissionPort;
    cursor: FeedCursorPort;
    space: FeedSpacePort;
    finish: FeedFinishPort;
    classifyFailure(error: unknown): FeedSourceState;
    refuse(code: FeedRefusalCode): never;
    now(): Date;
}>;
export {};
