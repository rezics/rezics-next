import type { ReadContext } from './model.ts';
import { type KnowledgeOutlinePageInput, type KnowledgePageInput, type KnowledgeStructureHistoryInput, type KnowledgeStructureChangeAction, type KnowledgeStructureChangeKind, type KnowledgeDependencies } from './knowledge-model.ts';
/** A public read selects only the document's current publication pointer. Search may be behind or paused;
 * its candidate is never authority to return an older publication. */
export declare function readKnowledgePublicDocument(deps: KnowledgeDependencies, documentId: string, selection: Readonly<{
    revisionId?: string;
}>, context: ReadContext): Promise<{
    value: {
        document: {
            documentId: string;
            revisionId: string;
            title: string;
            language: string | null;
            licence: string;
            subjectIds: string[];
            canonicalBytes: string;
            sha256: string;
            references: Readonly<{
                id: string;
                role: "about" | "cites" | "explains" | "inspired-by" | "uses";
                sourceBlockId?: string;
                target: {
                    kind: "subject";
                    subjectId: string;
                } | {
                    kind: "document";
                    documentId: string;
                } | {
                    kind: "revision";
                    documentId: string;
                    revisionId: string;
                    sha256: string;
                    blockId?: string;
                } | null;
            }>[];
            provenance: Readonly<{
                documentId: string;
                revisionId: string;
                representation: "authoring" | "public";
                sha256: string;
                publicationId?: string;
            }> | null;
            publicationId: string;
            subjectId: string;
            publishedAt: string;
            authorId: null;
        };
    };
    anchors: Readonly<{
        partition: import("../partition/partition.ts").Partition;
        epoch: number;
        position: bigint;
    }>[];
}>;
/** The private route is same-home only. Full ancestry and account authority are rechecked in the
 * notebook partition snapshot before exact current-head bytes are disclosed. */
export declare function readKnowledgePrivateDocument(deps: KnowledgeDependencies, accountId: string, notebookId: string, documentId: string, context: ReadContext, revisionId?: string): Promise<{
    value: {
        document: {
            documentId: string;
            revisionId: string;
            title: string;
            language: string | null;
            canonicalBytes: string;
            sha256: string;
            licence: string;
            subjectIds: string[];
            references: Readonly<{
                id: string;
                role: "about" | "cites" | "explains" | "inspired-by" | "uses";
                sourceBlockId?: string;
                target: {
                    kind: "subject";
                    subjectId: string;
                } | {
                    kind: "document";
                    documentId: string;
                } | {
                    kind: "revision";
                    documentId: string;
                    revisionId: string;
                    sha256: string;
                    blockId?: string;
                } | null;
            }>[];
            provenance: Readonly<{
                documentId: string;
                revisionId: string;
                representation: "authoring" | "public";
                sha256: string;
                publicationId?: string;
            }> | null;
            notebookId: string;
            publicationId: string | null;
        };
    };
    anchors: Readonly<{
        partition: import("../partition/partition.ts").Partition;
        epoch: number;
        position: bigint;
    }>[];
}>;
/** Reloads an owner's notebook directory with the native encrypted keyset cursor. */
export declare function readKnowledgeOwnedNotebooks(deps: KnowledgeDependencies, accountId: string, query: KnowledgePageInput, context: ReadContext): Promise<{
    value: {
        notebooks: {
            notebookId: string;
            subjectId: string;
            title: string;
            structureRevisionId: string;
            createdAt: string;
        }[];
        next: string | null;
    };
    anchors: Readonly<{
        partition: import("../partition/partition.ts").Partition;
        epoch: number;
        position: bigint;
    }>[];
}>;
/** Pages the immediate children of the current selected outline. Each request examines at most
 * 128 indexed siblings and resumes from the last eligible or examined key when rows are sparse. */
export declare function readKnowledgeOutline(deps: KnowledgeDependencies, accountId: string, notebookId: string, query: KnowledgeOutlinePageInput, context: ReadContext): Promise<{
    value: {
        notebookId: string;
        structureRevisionId: string;
        parentPlacementId: string | null;
        placements: {
            placementId: string;
            documentId: string;
            parentPlacementId: string | null;
            position: string;
            title: string;
        }[];
        next: string | null;
    };
    anchors: Readonly<{
        partition: import("../partition/partition.ts").Partition;
        epoch: number;
        position: bigint;
    }>[];
}>;
export declare function readKnowledgeHistoricalOutline(deps: KnowledgeDependencies, accountId: string, notebookId: string, revisionId: string, query: KnowledgeOutlinePageInput, context: ReadContext): Promise<{
    value: {
        notebookId: string;
        structureRevisionId: string;
        revisionNumber: string;
        parentPlacementId: string | null;
        placements: {
            placementId: string;
            documentId: string;
            parentPlacementId: string | null;
            position: string;
            title: string;
        }[];
        next: string | null;
    };
    anchors: Readonly<{
        partition: import("../partition/partition.ts").Partition;
        epoch: number;
        position: bigint;
    }>[];
}>;
export declare function readKnowledgeStructureHistory(deps: KnowledgeDependencies, accountId: string, notebookId: string, query: KnowledgeStructureHistoryInput, context: ReadContext): Promise<{
    value: {
        notebookId: string;
        revisions: {
            structureRevisionId: string;
            revisionNumber: string;
            historyAvailable: boolean;
            changeKind: KnowledgeStructureChangeKind;
            createdAt: string;
            changes: {
                placementId: string;
                action: KnowledgeStructureChangeAction;
                previousParentPlacementId: string | null;
                previousPosition: string | null;
                parentPlacementId: string | null;
                position: string;
            }[];
        }[];
        next: string | null;
    };
    anchors: Readonly<{
        partition: import("../partition/partition.ts").Partition;
        epoch: number;
        position: bigint;
    }>[];
}>;
export declare function readKnowledgeDocumentHistory(deps: KnowledgeDependencies, accountId: string, notebookId: string, documentId: string, query: KnowledgePageInput, context: ReadContext): Promise<{
    value: {
        documentId: string;
        revisions: {
            revisionId: string;
            title: string;
            language: string | null;
            sha256: string;
            licence: string;
            createdAt: string;
        }[];
        next: string | null;
    };
    anchors: Readonly<{
        partition: import("../partition/partition.ts").Partition;
        epoch: number;
        position: bigint;
    }>[];
}>;
export declare function readKnowledgeDocumentCompare(deps: KnowledgeDependencies, accountId: string, notebookId: string, documentId: string, revisionIds: readonly [string, string], context: ReadContext): Promise<{
    value: {
        documentId: string;
        left: {
            documentId: string;
            revisionId: string;
            title: string;
            language: string | null;
            canonicalBytes: string;
            sha256: string;
            licence: string;
            subjectIds: string[];
            references: Readonly<{
                id: string;
                role: "about" | "cites" | "explains" | "inspired-by" | "uses";
                sourceBlockId?: string;
                target: {
                    kind: "subject";
                    subjectId: string;
                } | {
                    kind: "document";
                    documentId: string;
                } | {
                    kind: "revision";
                    documentId: string;
                    revisionId: string;
                    sha256: string;
                    blockId?: string;
                } | null;
            }>[];
            provenance: Readonly<{
                documentId: string;
                revisionId: string;
                representation: "authoring" | "public";
                sha256: string;
                publicationId?: string;
            }> | null;
        };
        right: {
            documentId: string;
            revisionId: string;
            title: string;
            language: string | null;
            canonicalBytes: string;
            sha256: string;
            licence: string;
            subjectIds: string[];
            references: Readonly<{
                id: string;
                role: "about" | "cites" | "explains" | "inspired-by" | "uses";
                sourceBlockId?: string;
                target: {
                    kind: "subject";
                    subjectId: string;
                } | {
                    kind: "document";
                    documentId: string;
                } | {
                    kind: "revision";
                    documentId: string;
                    revisionId: string;
                    sha256: string;
                    blockId?: string;
                } | null;
            }>[];
            provenance: Readonly<{
                documentId: string;
                revisionId: string;
                representation: "authoring" | "public";
                sha256: string;
                publicationId?: string;
            }> | null;
        };
    };
    anchors: Readonly<{
        partition: import("../partition/partition.ts").Partition;
        epoch: number;
        position: bigint;
    }>[];
}>;
