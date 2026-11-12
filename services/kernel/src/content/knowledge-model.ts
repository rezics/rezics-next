import type { KnowledgeReference } from './knowledge-portable.ts';
import type { ContentCommandDependencies } from './commands.ts';
import type { ContentReadDependencies } from './reads.ts';

export const KNOWLEDGE_ANCESTOR_LIMIT = 31;
export const KNOWLEDGE_REFERENCE_LIMIT = 64;
export const KNOWLEDGE_PAGE_LIMIT = 50;
export const KNOWLEDGE_OUTLINE_SCAN_LIMIT = 128;

export type KnowledgeDependencies = ContentCommandDependencies & ContentReadDependencies;
export type KnowledgeCommandContext = Readonly<{ idempotencyKey: string; deadline: number; requestId: string }>;
export type KnowledgeReadContext = Readonly<{ actor: import('../request/access.ts').Actor; deadline: number }>;
export type KnowledgePageInput = Readonly<{ limit?: number; cursor?: string }>;
export type KnowledgeOutlinePageInput = KnowledgePageInput & Readonly<{ parentPlacementId?: string }>;
export type KnowledgeDocumentInput = Readonly<{
  title: string;
  language?: string | null;
  body: unknown;
  licence: string;
  subjectIds: readonly string[];
  references?: readonly KnowledgeReference[];
}>;
export type KnowledgeCreateNotebookInput = Readonly<{ subjectId: string; title: string }>;
export type KnowledgeCreateDocumentInput = KnowledgeDocumentInput &
  Readonly<{ expectedStructureRevisionId: string; parentPlacementId: string | null }>;
export type KnowledgeReviseDocumentInput = KnowledgeDocumentInput & Readonly<{ expectedHeadRevisionId: string }>;
export type KnowledgePublicationInput = Readonly<{
  expectedHeadRevisionId: string;
  expectedPublicationId: string | null;
  revisionId: string | null;
}>;

export type KnowledgeCommandValue = Readonly<{
  notebookId?: string;
  documentId?: string;
  placementId?: string;
  structureRevisionId?: string;
  revisionId?: string;
  publicationId?: string | null;
}>;

export type KnowledgeDocumentView = Readonly<{
  documentId: string;
  notebookId: string;
  publicationId: string | null;
  revisionId: string;
  title: string;
  language: string | null;
  canonicalBytes: string;
  sha256: string;
  licence: string;
  subjectIds: readonly string[];
}>;

export type KnowledgePublicDocumentView = Omit<KnowledgeDocumentView, 'notebookId' | 'publicationId'> &
  Readonly<{
    publicationId: string;
    subjectId: string;
    publishedAt: string;
    authorId: string | null;
  }>;

export class KnowledgeNotFoundError extends Error {
  constructor() {
    super('Knowledge resource not found');
    this.name = 'KnowledgeNotFoundError';
  }
}

export class KnowledgeInvalidInputError extends Error {
  constructor() {
    super('Invalid knowledge input');
    this.name = 'KnowledgeInvalidInputError';
  }
}

export class KnowledgeInvalidCursorError extends Error {
  constructor() {
    super('Invalid knowledge cursor');
    this.name = 'KnowledgeInvalidCursorError';
  }
}

export class KnowledgeStaleCursorError extends Error {
  constructor() {
    super('Knowledge cursor is stale');
    this.name = 'KnowledgeStaleCursorError';
  }
}

/** One bounded currentness pass covers the notebook's anchor and this revision's managed Subject references. */
export function knowledgeSubjectTargets(subjectId: string, references: readonly string[]): readonly string[] {
  if (references.length > KNOWLEDGE_REFERENCE_LIMIT) throw new KnowledgeInvalidInputError();
  return [...new Set([subjectId, ...references])];
}
