import type { CommunityPresentation } from './community-presentation-model.ts';
export type { CommunityPresentation } from './community-presentation-model.ts';
import type { DocumentSnapshot } from '@rezics/document';
import type { Actor } from '../request/access.ts';
import type { Partition } from '../partition/partition.ts';
export type ContentId = string;
export type BoardId = ContentId;
export type ThreadId = ContentId;
export type PostId = ContentId;
export type RevisionId = ContentId;
export type ReportId = ContentId;
export type MediaId = ContentId;
export type Route = number;
export type SecurityRevision = string;
export type Visibility = 'published' | 'draft' | 'protected' | 'taken_down';
export type Availability = 'available' | 'erased';
export type Component = Readonly<{
    partition: number;
    epoch: number;
    position: bigint;
    transactionId: string;
}>;
export type ContentCommandValue = Readonly<{
    threadId: ThreadId;
    itemId: PostId;
    revisionId: RevisionId;
}>;
export type ReviewVoteCitation = Readonly<{
    questionId: string;
    units: number;
    revision: number;
}>;
export type FeedReviewContext = Readonly<{
    target: Readonly<{
        state: 'available';
        subject: Readonly<{
            id: ContentId;
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
            id: ContentId;
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
export type FeedParentAuthor = Readonly<{
    id: ContentId;
    displayName: string | null;
    handle: string | null;
}>;
export type FeedParentContext = Readonly<{
    kind: 'opening';
}> | Readonly<{
    kind: 'reply';
    parent: Readonly<{
        state: 'available';
        id: PostId;
        revisionId: RevisionId;
        createdAt: string;
        author: FeedParentAuthor | null;
        excerpt: string | null;
        language: string | null;
        spoiler: boolean;
    }> | Readonly<{
        state: 'removed';
        id: PostId;
    }> | Readonly<{
        state: 'withheld';
    }>;
}>;
export type ItemMetadata = Readonly<{
    id: PostId;
    threadId: ThreadId;
    route: Route;
    authorId: ContentId;
    parentId: PostId | null;
    licence: string;
    subjectIds: readonly ContentId[];
    boardId: BoardId;
    visibility: Visibility;
    securityRevision: SecurityRevision;
    availability: Availability;
    createdAt: string;
    revisedAt: string | null;
    sha256: string;
    mediaIds: readonly MediaId[];
    voteCitation: ReviewVoteCitation | null;
}>;
export type RevisionMetadata = Readonly<{
    id: RevisionId;
    itemId: PostId;
    threadId: ThreadId;
    route: Route;
    authorId: ContentId;
    licence: string;
    subjectIds: readonly ContentId[];
    boardId: BoardId;
    createdAt: string;
    revisedAt: string | null;
    sha256: string;
    mediaIds: readonly MediaId[];
    voteCitation: ReviewVoteCitation | null;
}>;
export type ErasedPlaceholder = Readonly<{
    id: PostId;
    threadId: ThreadId;
    route: Route;
    parentId: PostId | null;
    removed: true;
    availability: 'erased';
    body: null;
    sha256: null;
}>;
export type ItemView = Readonly<ItemMetadata & {
    revisionId: RevisionId;
} & ({
    body: DocumentSnapshot;
    availability: 'available';
} | {
    body: null;
    availability: 'erased';
})>;
export type PostEntry = ItemView | ErasedPlaceholder;
export type RevisionView = Readonly<RevisionMetadata & ({
    body: DocumentSnapshot;
    availability: 'available';
} | {
    body: null;
    availability: 'erased';
})>;
export type ThreadView = Readonly<{
    id: ThreadId;
    route: Route;
    authorId: ContentId;
    kind: 'discussion' | 'review';
    title: string | null;
    licence: string;
    subjectIds: readonly ContentId[];
    boardId: BoardId;
    visibility: Visibility;
    securityRevision: SecurityRevision;
    availability: Availability;
    createdAt: string;
    firstPost: PostEntry;
}>;
export declare function isErasedPlaceholder(entry: Readonly<{
    availability: Availability | 'withheld';
    revisionId?: RevisionId;
}>): entry is ErasedPlaceholder;
export type BoardView = Readonly<{
    id: BoardId;
    realmId: string | null;
    community: CommunityPresentation | null;
    route: Route;
    title: string | null;
    purpose: 'discussion' | 'reviews';
    visibility: Visibility;
    securityRevision: SecurityRevision;
    availability: Availability;
    createdAt: string;
}>;
export type BoardRecord = Omit<BoardView, 'community'>;
export type ThreadInput = Readonly<{
    kind?: 'discussion' | 'review';
    title: string;
    body: unknown;
    licence: string;
    subjectIds: readonly ContentId[];
    boardId: BoardId;
    visibility: 'published' | 'draft' | 'protected';
    voteCitation?: ReviewVoteCitation;
}>;
export type PostInput = Readonly<{
    threadId: ThreadId;
    visibility?: 'published' | 'draft' | 'protected';
    body: unknown;
    licence: string;
    subjectIds?: readonly ContentId[];
    boardId?: BoardId;
    parentId?: PostId | null;
    mediaIds?: readonly MediaId[];
}>;
export type RevisionInput = Readonly<{
    threadId: ThreadId;
    /** Review opening title, committed with this body revision. */
    title?: string;
    visibility?: 'published' | 'draft';
    itemId: PostId;
    body: unknown;
    licence?: string;
    subjectIds?: readonly ContentId[];
    boardId?: BoardId;
    mediaIds?: readonly MediaId[];
    /** Head the caller last observed. Null omits the check; the digest still records it. */
    expectedRevisionId?: string | null;
    voteCitation?: ReviewVoteCitation;
}>;
export type RequestContext = Readonly<{
    idempotencyKey: string;
    deadline: number;
    requestId: string;
}>;
export type AnchoredPosition = Readonly<{
    partition: Partition;
    epoch: number;
    position: bigint;
}>;
export type Anchored<T> = Readonly<{
    value: T;
    anchor: AnchoredPosition;
}>;
export type ReadContext = Readonly<{
    actor: Actor;
    deadline: number;
}>;
export type Page<T> = Readonly<{
    entries: readonly T[];
    nextCursor: string | null;
    anchor: AnchoredPosition;
}>;
export type UnfinishedPortError = Error & {
    readonly port: string;
};
export declare function unfinishedPort(port: string): UnfinishedPortError;
