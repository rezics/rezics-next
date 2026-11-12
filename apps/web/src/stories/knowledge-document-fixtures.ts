import { fromPlainText, serializeDocument } from '@rezics/document';
import type { KnowledgePublicDocument, KnowledgeReadRequest, KnowledgeReadState } from '../knowledge/public-read';

/** Constructed Knowledge reader examples; not native public_read recordings. */
export const knowledgeDocumentId = '0192f3a0-6c1e-7b2a-9d4e-000000000001';
export const knowledgeRevisionId = '0192f3a0-6c1e-7b2a-9d4e-000000000002';
export const knowledgeOtherRevisionId = '0192f3a0-6c1e-7b2a-9d4e-000000000012';
export const knowledgePublicationId = '0192f3a0-6c1e-7b2a-9d4e-000000000003';
export const knowledgeSubjectId = '0192f3a0-6c1e-7b2a-9d4e-000000000004';
export const knowledgeAuthorId = '0192f3a0-6c1e-7b2a-9d4e-000000000090';
export const knowledgeTitle = 'Selected public knowledge';
export const knowledgeLongTitle =
  'Selected public knowledge whose wrapped heading must remain readable on a 390px phone and a 1280px desktop';
export const knowledgePublicationText = 'The selected publication keeps these exact words.';
export const knowledgeLicence = 'CC-BY-SA-4.0';
export const knowledgePublishedAt = '2026-10-30T12:00:00.000Z';
export const knowledgeSha256 = 'a'.repeat(64);

export const knowledgeLiveRequest: KnowledgeReadRequest = {
  documentId: knowledgeDocumentId,
  revisionId: null,
  locale: 'en',
};
export const knowledgeExactRequest: KnowledgeReadRequest = {
  documentId: knowledgeDocumentId,
  revisionId: knowledgeRevisionId,
  locale: 'en',
};

export function knowledgeBody(text = knowledgePublicationText) {
  return fromPlainText(text);
}

export function knowledgeCanonicalBytes(text = knowledgePublicationText) {
  return Buffer.from(serializeDocument(knowledgeBody(text)), 'utf8').toString('base64');
}

export function knowledgePublicDto(overrides: Record<string, unknown> = {}): { document: Record<string, unknown> } {
  return {
    document: {
      documentId: knowledgeDocumentId,
      revisionId: knowledgeRevisionId,
      title: knowledgeTitle,
      language: 'en',
      canonicalBytes: knowledgeCanonicalBytes(),
      sha256: knowledgeSha256,
      licence: knowledgeLicence,
      subjectIds: [knowledgeSubjectId],
      publicationId: knowledgePublicationId,
      subjectId: knowledgeSubjectId,
      publishedAt: knowledgePublishedAt,
      authorId: null,
      ...overrides,
    },
  };
}

export function knowledgeAdmitted(overrides: Partial<KnowledgePublicDocument> = {}): KnowledgePublicDocument {
  return {
    documentId: knowledgeDocumentId,
    revisionId: knowledgeRevisionId,
    publicationId: knowledgePublicationId,
    subjectId: knowledgeSubjectId,
    title: knowledgeTitle,
    language: 'en',
    licence: knowledgeLicence,
    publishedAt: knowledgePublishedAt,
    body: knowledgeBody(),
    ...overrides,
  };
}

export const knowledgeReadyDocument = knowledgeAdmitted();
export const knowledgeLongDocument = knowledgeAdmitted({ title: knowledgeLongTitle });
export const knowledgeReady: KnowledgeReadState = { state: 'ready', document: knowledgeReadyDocument };
export const knowledgeLongReady: KnowledgeReadState = { state: 'ready', document: knowledgeLongDocument };

export const knowledgeViewports = {
  phone390: { name: 'Phone 390', styles: { width: '390px', height: '844px' } },
  desktop1280: { name: 'Desktop 1280', styles: { width: '1280px', height: '900px' } },
};
