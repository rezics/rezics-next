import type { Actor } from '../request/access.ts';
import { type KnowledgeCommandContext, type KnowledgeCreateDocumentInput, type KnowledgeCreateNotebookInput, type KnowledgeDependencies, type KnowledgePublicationInput, type KnowledgeReviseDocumentInput } from './knowledge-model.ts';
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
export declare function reviseKnowledgeDocument(deps: KnowledgeDependencies, actor: Actor, documentId: string, input: KnowledgeReviseDocumentInput, context: KnowledgeCommandContext): Promise<import("../command/command.ts").CommandOutcome<{
    documentId: string;
    revisionId: string;
}>>;
export declare function setKnowledgePublication(deps: KnowledgeDependencies, actor: Actor, documentId: string, input: KnowledgePublicationInput, context: KnowledgeCommandContext): Promise<import("../command/command.ts").CommandOutcome<{
    documentId: string;
    publicationId: string | null;
    revisionId?: string;
}>>;
