import { expect, mock, test } from 'bun:test';
import { fromPlainText, type DocumentSnapshot } from '@rezics/document';
import { knowledgeMediaSource, type KnowledgeMediaSelection } from '@rezics/definitions/knowledge-media';
import {
  createKnowledgeImageUploader,
  knowledgeImageHref,
  knowledgeImageSelection,
  knowledgeImageSources,
} from '../src/knowledge/media';

const id = (value: number) => `0192f3a0-6c1e-7b2a-9d4e-${String(value).padStart(12, '0')}`;
const own: KnowledgeMediaSelection = {
  representation: 'authoring',
  documentId: id(1),
  revisionId: id(2),
  sourceSha256: 'a'.repeat(64),
};
const published: KnowledgeMediaSelection = {
  representation: 'public',
  documentId: id(3),
  revisionId: id(4),
  sourceSha256: 'b'.repeat(64),
  publicationId: id(5),
};
const image = (src: string) => ({ type: 'image', attrs: { id: 'authored-image', src, alt: 'Original image' } });
function body(sources: readonly string[]): DocumentSnapshot {
  const base = fromPlainText('Authored image context', 'blocks');
  return {
    ...base,
    doc: {
      ...base.doc,
      content: [
        ...base.doc.content,
        ...sources.map((src, index) => ({
          ...image(src),
          attrs: { ...image(src).attrs, id: `authored-image-${index}` },
        })),
      ],
    },
  };
}

test('download resolution preserves each explicit source and never changes an authored URI', () => {
  const source = knowledgeMediaSource(id(6), published),
    original = source;
  expect(knowledgeImageSelection(source, own)).toEqual(published);
  const href = new URL(knowledgeImageHref(source, 'webp-640', own)!, 'https://site.test');
  expect(href.pathname).toBe(`/media/${id(6)}/webp-640`);
  expect(href.searchParams.get('knowledgeDocumentId')).toBe(published.documentId);
  expect(href.searchParams.get('knowledgeSourceSha256')).toBe(published.sourceSha256);
  expect(href.searchParams.get('knowledgePublicationId')).toBe(published.publicationId);
  expect(source).toBe(original);
  expect(knowledgeImageHref(knowledgeMediaSource(id(7)), 'avif-320', own)).toContain(
    `knowledgeDocumentId=${own.documentId}`,
  );
  expect(knowledgeImageHref(knowledgeMediaSource(id(7)), 'webp-640', published)).toBeNull();
  for (const source of ['https://storage.test/signed?token=secret', 'blob:private', id(6)])
    expect(knowledgeImageHref(source, 'webp-640', own)).toBeNull();
  expect(knowledgeImageHref(original, 'webp-333', own)).toBeNull();
});

test('the image metadata index stays bounded without mutating or serializing the document', () => {
  const sources = Array.from({ length: 32 }, (_, index) =>
    knowledgeMediaSource(id(index + 10), index % 2 ? published : undefined),
  );
  const draft = body(sources),
    imageNode = draft.doc.content.at(-1);
  expect(knowledgeImageSources(draft)).toEqual({ sources, overflow: false });
  expect(draft.doc.content.at(-1)).toBe(imageNode);
  expect(knowledgeImageSources(body([...sources, knowledgeMediaSource(id(90))]))).toEqual({
    sources: [],
    overflow: true,
  });
});

test('the host reuses the existing document upload port and inserts only a canonical claim URI', async () => {
  const file = new File(['image'], 'photo.png', { type: 'image/png' }),
    draft = body([]);
  const upload = mock(async () => ({ src: knowledgeMediaSource(id(8)), width: 640, height: 480 }));
  const uploader = createKnowledgeImageUploader({
    documentId: own.documentId,
    readBody: () => draft,
    current: () => true,
    upload,
  });
  expect(await uploader(file, new AbortController().signal)).toEqual({
    src: knowledgeMediaSource(id(8)),
    width: 640,
    height: 480,
  });
  expect(upload.mock.calls[0]!.slice(0, 2)).toEqual([own.documentId, file]);
  expect(knowledgeImageSources(draft).sources).toEqual([]);
  expect(() =>
    createKnowledgeImageUploader({ documentId: 'unsaved', readBody: () => draft, current: () => true, upload }),
  ).toThrow();
});
