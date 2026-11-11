import type { ReadContext } from './model.ts';
import { type KnowledgeDependencies } from './knowledge-model.ts';
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
        };
    };
    anchors: Readonly<{
        partition: import("../partition/partition.ts").Partition;
        epoch: number;
        position: bigint;
    }>[];
}>;
