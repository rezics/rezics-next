import { type KnowledgeProvenance } from './knowledge-portable.ts';
import type { Actor } from '../request/access.ts';
import { type KnowledgeCommandContext, type KnowledgeCreateDocumentInput, type KnowledgeCreateNotebookInput, type KnowledgeDependencies, type KnowledgeDocumentInput, type KnowledgeMovePlacementInput, type KnowledgePublicationInput, type KnowledgeReviseDocumentInput } from './knowledge-model.ts';
export declare function createKnowledgeNotebook(deps: KnowledgeDependencies, actor: Actor, input: KnowledgeCreateNotebookInput, context: KnowledgeCommandContext): Promise<import("../command/command.ts").CommandOutcome<{
    notebookId: string;
    structureRevisionId: string;
}>>;
export declare function createKnowledgeDocument(deps: KnowledgeDependencies, actor: Actor, notebookId: string, input: KnowledgeCreateDocumentInput, context: KnowledgeCommandContext): Promise<import("../command/command.ts").CommandOutcome<{
    notebookId: string;
    documentId: string;
    placementId: string;
    revisionId: string;
    structureRevisionId: string;
}>>;
/** Shared destination path: account authority, structure CAS, ancestry, private insert, event and receipt. */
export declare function writeKnowledgeDocument(deps: KnowledgeDependencies, actor: Actor, notebookId: string, placement: Readonly<{
    expectedStructureRevisionId: string;
    parentPlacementId: string | null;
}>, context: KnowledgeCommandContext, source: Readonly<{
    kind: string;
    receiptInput: unknown;
    prepare: () => Promise<Readonly<{
        input: KnowledgeDocumentInput;
        provenance: KnowledgeProvenance | null;
    }>>;
}>): Promise<import("../command/command.ts").CommandOutcome<{
    notebookId: string;
    documentId: string;
    placementId: string;
    revisionId: string;
    structureRevisionId: string;
}>>;
export declare function moveKnowledgePlacement(deps: KnowledgeDependencies, actor: Actor, notebookId: string, placementId: string, input: KnowledgeMovePlacementInput, context: KnowledgeCommandContext): Promise<import("../command/command.ts").CommandOutcome<{
    notebookId: string;
    placementId: string;
    structureRevisionId: string;
}>>;
export declare function reviseKnowledgeDocument(deps: KnowledgeDependencies, actor: Actor, documentId: string, input: KnowledgeReviseDocumentInput, context: KnowledgeCommandContext): Promise<import("../command/command.ts").CommandOutcome<{
    documentId: string;
    revisionId: string;
}>>;
export declare function setKnowledgePublication(deps: KnowledgeDependencies, actor: Actor, documentId: string, input: KnowledgePublicationInput, context: KnowledgeCommandContext): Promise<import("../command/command.ts").CommandOutcome<{
    documentId: string;
    publicationId: string | null;
    revisionId?: string;
}>>;
