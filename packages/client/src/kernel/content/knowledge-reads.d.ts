import type { ReadContext } from './model.ts';
import { type KnowledgeOutlinePageInput, type KnowledgePageInput, type KnowledgeDependencies } from './knowledge-model.ts';
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
            canonicalBytes: string;
            sha256: string;
            licence: string;
            subjectIds: string[];
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
export declare function readKnowledgePrivateDocument(deps: KnowledgeDependencies, accountId: string, notebookId: string, documentId: string, context: ReadContext): Promise<{
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
