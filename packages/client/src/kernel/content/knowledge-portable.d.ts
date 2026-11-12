import { type DocumentNode, type DocumentSnapshot } from '@rezics/document';
import type { Static } from 'typebox';
export declare const KNOWLEDGE_REFERENCE_DEFINITION = "rezics.knowledge.reference";
export type KnowledgeReference = Readonly<Static<typeof KnowledgeReferenceSchema>>;
export type KnowledgeReferenceTarget = NonNullable<KnowledgeReference['target']>;
export type KnowledgeProvenance = Readonly<Static<typeof KnowledgeProvenanceSchema>>;
export declare const KnowledgeReferenceSchema: import("typebox").TObject<{
    id: import("typebox").TString;
    role: import("typebox").TUnion<[import("typebox").TLiteral<"about">, import("typebox").TLiteral<"cites">, import("typebox").TLiteral<"explains">, import("typebox").TLiteral<"uses">, import("typebox").TLiteral<"inspired-by">]>;
    sourceBlockId: import("typebox").TOptional<import("typebox").TString>;
    target: import("typebox").TUnion<[import("typebox").TNull, import("typebox").TObject<{
        kind: import("typebox").TLiteral<"subject">;
        subjectId: import("typebox").TString;
    }>, import("typebox").TObject<{
        kind: import("typebox").TLiteral<"document">;
        documentId: import("typebox").TString;
    }>, import("typebox").TObject<{
        kind: import("typebox").TLiteral<"revision">;
        documentId: import("typebox").TString;
        revisionId: import("typebox").TString;
        sha256: import("typebox").TString;
        blockId: import("typebox").TOptional<import("typebox").TString>;
    }>]>;
}>;
export declare const KnowledgeReferencesSchema: import("typebox").TArray<import("typebox").TObject<{
    id: import("typebox").TString;
    role: import("typebox").TUnion<[import("typebox").TLiteral<"about">, import("typebox").TLiteral<"cites">, import("typebox").TLiteral<"explains">, import("typebox").TLiteral<"uses">, import("typebox").TLiteral<"inspired-by">]>;
    sourceBlockId: import("typebox").TOptional<import("typebox").TString>;
    target: import("typebox").TUnion<[import("typebox").TNull, import("typebox").TObject<{
        kind: import("typebox").TLiteral<"subject">;
        subjectId: import("typebox").TString;
    }>, import("typebox").TObject<{
        kind: import("typebox").TLiteral<"document">;
        documentId: import("typebox").TString;
    }>, import("typebox").TObject<{
        kind: import("typebox").TLiteral<"revision">;
        documentId: import("typebox").TString;
        revisionId: import("typebox").TString;
        sha256: import("typebox").TString;
        blockId: import("typebox").TOptional<import("typebox").TString>;
    }>]>;
}>>;
export declare const KnowledgeProvenanceSchema: import("typebox").TObject<{
    documentId: import("typebox").TString;
    revisionId: import("typebox").TString;
    representation: import("typebox").TUnion<[import("typebox").TLiteral<"authoring">, import("typebox").TLiteral<"public">]>;
    sha256: import("typebox").TString;
    publicationId: import("typebox").TOptional<import("typebox").TString>;
}>;
export declare const KnowledgeExportSchema: import("typebox").TObject<{
    version: import("typebox").TLiteral<"knowledge-document-export-v1">;
    representation: import("typebox").TUnion<[import("typebox").TLiteral<"authoring">, import("typebox").TLiteral<"public">]>;
    selection: import("typebox").TObject<{
        documentId: import("typebox").TString;
        revisionId: import("typebox").TString;
        representation: import("typebox").TUnion<[import("typebox").TLiteral<"authoring">, import("typebox").TLiteral<"public">]>;
        sha256: import("typebox").TString;
        publicationId: import("typebox").TOptional<import("typebox").TString>;
    }>;
    title: import("typebox").TString;
    language: import("typebox").TUnion<[import("typebox").TString, import("typebox").TNull]>;
    licence: import("typebox").TString;
    subjectIds: import("typebox").TArray<import("typebox").TString>;
    snapshot: import("typebox").TUnknown;
    references: import("typebox").TArray<import("typebox").TObject<{
        id: import("typebox").TString;
        role: import("typebox").TUnion<[import("typebox").TLiteral<"about">, import("typebox").TLiteral<"cites">, import("typebox").TLiteral<"explains">, import("typebox").TLiteral<"uses">, import("typebox").TLiteral<"inspired-by">]>;
        sourceBlockId: import("typebox").TOptional<import("typebox").TString>;
        target: import("typebox").TUnion<[import("typebox").TNull, import("typebox").TObject<{
            kind: import("typebox").TLiteral<"subject">;
            subjectId: import("typebox").TString;
        }>, import("typebox").TObject<{
            kind: import("typebox").TLiteral<"document">;
            documentId: import("typebox").TString;
        }>, import("typebox").TObject<{
            kind: import("typebox").TLiteral<"revision">;
            documentId: import("typebox").TString;
            revisionId: import("typebox").TString;
            sha256: import("typebox").TString;
            blockId: import("typebox").TOptional<import("typebox").TString>;
        }>]>;
    }>>;
    provenance: import("typebox").TUnion<[import("typebox").TObject<{
        documentId: import("typebox").TString;
        revisionId: import("typebox").TString;
        representation: import("typebox").TUnion<[import("typebox").TLiteral<"authoring">, import("typebox").TLiteral<"public">]>;
        sha256: import("typebox").TString;
        publicationId: import("typebox").TOptional<import("typebox").TString>;
    }>, import("typebox").TNull]>;
    sha256: import("typebox").TString;
}>;
export type KnowledgeExport = Readonly<{
    version: 'knowledge-document-export-v1';
    representation: 'authoring' | 'public';
    selection: KnowledgeProvenance;
    title: string;
    language: string | null;
    licence: string;
    subjectIds: readonly string[];
    snapshot: DocumentSnapshot;
    references: readonly KnowledgeReference[];
    provenance: KnowledgeProvenance | null;
    sha256: string;
}>;
export declare function knowledgeDigest(bytes: string | Uint8Array): string;
/** The same RFC 8785 encoder used by Document, applied to the exchange wrapper. */
export declare function canonicalKnowledgeJson(value: unknown): string;
export declare function visitKnowledgeNodes(node: DocumentNode, visit: (node: DocumentNode) => void): void;
/** HTTP authoring input: reference payloads contain local identity only, never resolver caches. */
export declare function validateKnowledgeReferences(snapshot: DocumentSnapshot, input?: unknown): readonly KnowledgeReference[];
/** Digest covers the actual wrapper except its own digest field; snapshot gets its independent codec check. */
export declare function makeKnowledgeExport(input: Omit<KnowledgeExport, 'version' | 'sha256'>): KnowledgeExport;
/** An external artifact can be checked independently of any Kernel storage or destination notebook. */
export declare function parseKnowledgeExport(value: unknown): KnowledgeExport;
/** Only declared identities and fragment links are rewritten. Opaque payloads and external locators survive. */
export declare function remapKnowledgeCopy(snapshot: DocumentSnapshot, references: readonly KnowledgeReference[], generateId?: () => string): Readonly<{
    snapshot: DocumentSnapshot;
    references: readonly KnowledgeReference[];
}>;
