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

const sceneParagraphs = [
  'Mara returns to the lighthouse at low tide. The ferry will leave before the weather turns, and she has promised to carry a letter to the mainland. Her brother asks her to stay. He does not ask directly: he puts a second cup beside the kettle and begins to describe a repair they could finish together.',
  'The first version of this scene made departure look inevitable. That removed the decision from Mara. In this version, both choices offer something she wants. Staying would keep a familiar promise; leaving would make room for a promise she has not yet learned to keep. The scene needs to let both possibilities remain credible.',
  'The letter is an object with a clear destination, but it also gives the conversation a rhythm. Mara folds it when she avoids an answer, opens it when she wants to explain, and finally puts it in her coat without another word. These gestures carry the decision before either character names it.',
  'Her brother notices the empty cup after she leaves. We should resist explaining that image in dialogue. The reader already knows what it means because the cup was offered before the argument began. Returning to an ordinary object gives the ending a smaller, more human scale than another statement of the theme.',
  'Revision question: does Mara hear the ferry before or after she answers? Hearing it first makes the choice feel pressured. Hearing it afterward lets the sound confirm a decision already made. The latter gives her more agency, while keeping the practical cost of waiting visible in the scene.',
  'The next scene should not repeat the same conflict in a new location. It can test the choice through a small consequence: an unexpected passenger, a missed connection, or the discovery that the letter was addressed long before Mara agreed to carry it. The consequence must grow from this scene rather than cancel it.',
];
const longStudyText = [
  'A scene is a sequence of choices, not a list of things that happen.',
  ...sceneParagraphs,
  'Second pass: what changes when the story stays close to Mara?',
  ...sceneParagraphs.map((paragraph) => paragraph.replaceAll('Mara', 'the narrator')),
  'Working conclusion: end with a decision the reader can recognize, and leave its full consequences for the next scene.',
].join('\n');
export const knowledgeLongStudyBody = knowledgeBody(longStudyText);

export const knowledgeReadyDocument = knowledgeAdmitted();
export const knowledgeLongDocument = knowledgeAdmitted({
  title: knowledgeLongTitle,
  body: knowledgeBody(`${knowledgePublicationText}\n${longStudyText}`),
});
export const knowledgeReady: KnowledgeReadState = { state: 'ready', document: knowledgeReadyDocument };
export const knowledgeLongReady: KnowledgeReadState = { state: 'ready', document: knowledgeLongDocument };

export const knowledgeViewports = {
  phone390: { name: 'Phone 390', styles: { width: '390px', height: '844px' } },
  desktop1280: { name: 'Desktop 1280', styles: { width: '1280px', height: '900px' } },
};
