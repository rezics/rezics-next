import type { ContentReadDependencies } from './reads.ts';
export declare const HOSTED_PLACEMENT_LIMIT = 512;
export declare const HOSTED_DEPTH_LIMIT = 16;
export declare const HOSTED_PAGE_LIMIT = 20;
export type HostedDependencies = ContentReadDependencies;
export type HostedCommandContext = Readonly<{
    idempotencyKey: string;
    deadline: number;
    requestId: string;
}>;
export type HostedChapterTarget = Readonly<{
    threadId: string;
    postId: string;
    revisionId: string;
    sha256: string;
}>;
type PlacementBase = Readonly<{
    occurrenceId: string;
    parentId: string | null;
    position: number;
    title: string;
}>;
export type HostedPlacement = PlacementBase & (Readonly<{
    kind: 'part';
    target?: never;
}> | Readonly<{
    kind: 'chapter';
    target: HostedChapterTarget;
}>);
export type OrderedHostedPlacement = HostedPlacement & Readonly<{
    ordinal: number;
}>;
export type HostedStructureInput = Readonly<{
    placements: readonly HostedPlacement[];
}>;
export type HostedCreateInput = HostedStructureInput & Readonly<{
    postId: string;
    threadId: string;
}>;
export type HostedReviseInput = HostedStructureInput & Readonly<{
    expectedRevisionId: string;
}>;
export type HostedPublishInput = Readonly<{
    expectedRevisionId: string;
    expectedPublicationId: string | null;
    occurrenceIds: readonly string[];
}>;
export type HostedCommandValue = Readonly<{
    catalogueId: string;
    revisionId: string;
}>;
export type HostedRevisionView = Readonly<{
    catalogueId: string;
    revisionId: string;
    kind: 'structure' | 'publication';
    sourceRevisionId: string | null;
}>;
export type HostedOccurrenceView = Readonly<{
    occurrenceId: string;
    parentId: string | null;
    position: number;
}> & (Readonly<{
    availability: 'unavailable';
    kind: 'part' | 'chapter';
}> | Readonly<{
    availability: 'available';
    kind: 'part';
    title: string;
    target: null;
}> | Readonly<{
    availability: 'available';
    kind: 'chapter';
    title: string;
    target: HostedChapterTarget;
}>);
export type HostedReadSelection = Readonly<{
    revisionId?: string;
    kind?: 'structure' | 'publication';
}>;
/** Inventory covers only the acting account's route. A complete cross-home
 * catalogue locator is not installed; an empty home page proves nothing abroad. */
export type HostedOwnerInventoryScope = Readonly<{
    kind: 'same-home';
    route: number;
    crossHome: 'unavailable';
}>;
export type HostedOwnerInventoryInput = Readonly<{
    scope?: 'same-home' | 'all-homes';
    limit?: number;
    cursor?: string;
}>;
export type HostedOwnerInventoryEntry = Readonly<{
    catalogueId: string;
    threadId: string;
    createdAt: string;
    postRevisionId: string;
    postVisibility: 'draft' | 'published' | 'protected';
    headRevisionId: string;
    publicationId: string | null;
}>;
export type HostedOwnerInventoryView = Readonly<{
    scope: HostedOwnerInventoryScope;
    viewer: Readonly<{
        accountId: string;
        authnEpoch: number;
    }>;
    items: readonly HostedOwnerInventoryEntry[];
    nextCursor: string | null;
}>;
export declare class HostedOwnerInventoryUnavailableError extends Error {
    constructor();
}
export type HostedChildrenInput = HostedReadSelection & Readonly<{
    parentId?: string;
    limit?: number;
    cursor?: string;
}>;
export type HostedNavigationInput = HostedReadSelection & Readonly<{
    occurrenceId: string;
    direction: 'previous' | 'next';
    limit?: number;
    cursor?: string;
}>;
export type HostedPageView = HostedRevisionView & Readonly<{
    items: readonly HostedOccurrenceView[];
    nextCursor: string | null;
}>;
export type HostedResolutionView = HostedRevisionView & Readonly<{
    occurrence: HostedOccurrenceView;
    document: Readonly<{
        encoding: 'base64';
        canonicalBytes: string;
        sha256: string;
        authorId: string;
        licence: string;
    }> | null;
}>;
export declare class InvalidHostedCursorError extends Error {
    constructor();
}
export declare class InvalidHostedStructureError extends Error {
    constructor(message?: string);
}
export {};
