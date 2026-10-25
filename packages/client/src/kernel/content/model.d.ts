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
    sha256: string;
    mediaIds: readonly MediaId[];
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
    sha256: string;
    mediaIds: readonly MediaId[];
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
    title: string | null;
    licence: string;
    subjectIds: readonly ContentId[];
    boardId: BoardId;
    visibility: Visibility;
    securityRevision: SecurityRevision;
    availability: Availability;
    createdAt: string;
    firstPost: ItemView;
}>;
export type BoardView = Readonly<{
    id: BoardId;
    route: Route;
    title: string | null;
    visibility: Visibility;
    securityRevision: SecurityRevision;
    availability: Availability;
    createdAt: string;
}>;
export type ThreadInput = Readonly<{
    title: string;
    body: unknown;
    licence: string;
    subjectIds: readonly ContentId[];
    boardId: BoardId;
    visibility: 'published' | 'draft';
}>;
export type PostInput = Readonly<{
    threadId: ThreadId;
    body: unknown;
    licence: string;
    subjectIds?: readonly ContentId[];
    boardId?: BoardId;
    parentId?: PostId | null;
    mediaIds?: readonly MediaId[];
}>;
export type RevisionInput = Readonly<{
    threadId: ThreadId;
    itemId: PostId;
    body: unknown;
    licence?: string;
    subjectIds?: readonly ContentId[];
    boardId?: BoardId;
    mediaIds?: readonly MediaId[];
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
