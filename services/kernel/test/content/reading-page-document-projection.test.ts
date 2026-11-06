import { expect, test } from 'bun:test';
import { projectReadingPageDocumentMedia } from '../../src/content/reading-page-document-projection.ts';

const id = (value: number) => `00000000-0000-4000-8000-${String(value).padStart(12, '0')}`;

test('a successful presentation read keeps available images when later rows are missing or duplicated', () => {
  const threadId = id(1);
  const availableId = id(10);
  const missingId = id(11);
  const selection = {
    state: 'selected' as const,
    documents: [
      {
        postId: id(2),
        threadId,
        revisionId: id(5),
        sha256: 'a'.repeat(64),
        mediaIds: [availableId, missingId],
      },
    ],
    mediaIds: [availableId, missingId],
  };
  const presentation = {
    id: availableId,
    containerId: threadId,
    digest: 'b'.repeat(64),
    width: 640,
    height: 480,
    variants: [{ format: 'webp' as const, width: 640, height: 480 }],
    placeholder: null,
    focalPoint: null,
    credit: null,
  };
  const foreign = { ...presentation, id: missingId, containerId: id(99) };
  const duplicate = { ...presentation, digest: 'c'.repeat(64) };
  const projected = projectReadingPageDocumentMedia(selection, [presentation, duplicate, foreign]);
  expect(projected.state).toBe('available');
  expect(projected.documents[0]).toMatchObject({
    postId: id(2),
    state: 'available',
    images: [
      { id: availableId, state: 'available', presentation },
      { id: missingId, state: 'unavailable' },
    ],
  });
});
