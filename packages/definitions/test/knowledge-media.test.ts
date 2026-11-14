import { expect, test } from 'bun:test';
import {
  knowledgeMediaSource, parseKnowledgeMediaSource, parseKnowledgeMediaQuery, knowledgeMediaQuery,
} from '../src/knowledge-media.ts';

const media = '00000000-0000-7000-8000-000000000001';
const selection = {
  representation: 'public' as const,
  documentId: '00000000-0000-7000-8000-000000000002',
  revisionId: '00000000-0000-7000-8000-000000000003',
  sourceSha256: 'a'.repeat(64),
  publicationId: '00000000-0000-7000-8000-000000000004',
};

test('managed own locators and exact source references retain different custody', () => {
  expect(parseKnowledgeMediaSource(knowledgeMediaSource(media))).toEqual({ mediaId: media, selection: null });
  expect(parseKnowledgeMediaSource(knowledgeMediaSource(media, selection))).toEqual({ mediaId: media, selection });
  expect(parseKnowledgeMediaQuery(knowledgeMediaQuery(selection))).toEqual(selection);
  expect(knowledgeMediaSource(media, {
    publicationId: selection.publicationId, sourceSha256: selection.sourceSha256,
    revisionId: selection.revisionId, documentId: selection.documentId, representation: 'public',
  })).toBe(knowledgeMediaSource(media, selection));
  expect(parseKnowledgeMediaQuery({})).toBeUndefined();
});

test('opaque URLs and incomplete, duplicated or detached source coordinates grant no managed reference', () => {
  expect(parseKnowledgeMediaSource(`https://images.example/${media}?signature=opaque`)).toBeNull();
  expect(parseKnowledgeMediaSource(`rezics-media:${media}?representation=public`)).toBeNull();
  expect(parseKnowledgeMediaSource(knowledgeMediaSource(media, selection) + '&revisionId=' + selection.revisionId)).toBeNull();
  expect(parseKnowledgeMediaSource(knowledgeMediaSource(media, selection) + '#another-block')).toBeNull();
  expect(() => parseKnowledgeMediaQuery({ knowledgeDocumentId: selection.documentId })).toThrow();
  expect(() => parseKnowledgeMediaQuery({ ...knowledgeMediaQuery(selection), knowledgeRepresentation: 'authoring' })).toThrow();
});
