import { expect, test } from 'bun:test';
import { normalizeDocument, serializeDocument } from '@rezics/document';
import { knowledgeMediaSource } from '@rezics/definitions/knowledge-media';
import {
  collectKnowledgeMediaIds,
  contextualizeKnowledgeCopyMedia,
} from '../../src/content/knowledge-media-membership.ts';
import { newId } from '../../src/route/route.ts';

function body(sources: readonly string[]) {
  return normalizeDocument({
    version: 'rezics-document-v1',
    profile: 'blocks',
    doc: {
      type: 'doc',
      content: sources.map((src, index) => ({ type: 'image', attrs: { id: `image-${index}`, src } })),
    },
  });
}

test('immutable membership contains only unique bare managed image locators within the revision bound', () => {
  const mediaId = newId(0);
  const source = {
    representation: 'authoring' as const,
    documentId: newId(0),
    revisionId: newId(0),
    sourceSha256: 'a'.repeat(64),
  };
  expect(collectKnowledgeMediaIds(body([
    knowledgeMediaSource(mediaId),
    knowledgeMediaSource(mediaId),
    knowledgeMediaSource(newId(0), source),
    'https://private.example/image?token=opaque',
    'rezics-media:invalid',
  ]))).toEqual([mediaId]);
  const maximum = Array.from({ length: 32 }, () => knowledgeMediaSource(newId(0)));
  expect(collectKnowledgeMediaIds(body(maximum))).toHaveLength(32);
  expect(() => collectKnowledgeMediaIds(body([...maximum, knowledgeMediaSource(newId(0))]))).toThrow();
});

test('copy makes bare media source-contextual without mutating authoring bytes or existing independent contexts', () => {
  const mediaId = newId(0);
  const selection = {
    representation: 'public' as const,
    documentId: newId(0),
    revisionId: newId(0),
    publicationId: newId(0),
    sourceSha256: 'b'.repeat(64),
  };
  const independent = knowledgeMediaSource(newId(0), { ...selection, documentId: newId(0) });
  const original = body([knowledgeMediaSource(mediaId), independent]);
  const bytes = serializeDocument(original);
  const copied = contextualizeKnowledgeCopyMedia(original, selection);
  expect(serializeDocument(original)).toBe(bytes);
  expect(copied.doc.content![0]!.attrs!.src).toBe(knowledgeMediaSource(mediaId, selection));
  expect(copied.doc.content![1]!.attrs!.src).toBe(independent);
  expect(collectKnowledgeMediaIds(copied)).toEqual([]);
});
