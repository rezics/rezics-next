import { afterAll, beforeAll, expect, setDefaultTimeout, test } from 'bun:test';
import { fromPlainText } from '@rezics/document';
import candidates from '../../src/content/media-presentation.sql';
import {
  READING_PAGE_DOCUMENT_MEDIA_LIMIT,
  selectReadingPageDocumentMedia,
} from '../../src/content/reading-page-documents.ts';
import type { PostEntry } from '../../src/content/reads.ts';
import { observeSql } from './support/sql-observer.ts';
import { mediaRealmDownloadFixture } from './media-realm-download-fixture.ts';

setDefaultTimeout(360_000);
let fixture: Awaited<ReturnType<typeof mediaRealmDownloadFixture>>;
beforeAll(async () => {
  fixture = await mediaRealmDownloadFixture();
}, 360_000);
afterAll(async () => fixture?.close());

const id = (value: number) => `00000000-0000-4000-8000-${String(value).padStart(12, '0')}`;

test('the native page binds declared images to the current revision and rejects a stale final admission', async () => {
  const image = fixture.globalImage;
  const path = `/v1/threads/${image.threadId}/reading-page`;
  const initial = await fixture.call('GET', path);
  expect(initial.response.status, initial.text).toBe(200);
  expect(initial.response.headers.get('cache-control')).toBe('private, no-store');
  const post = initial.value.replies.items.find((entry: any) => entry.mediaIds.includes(image.id));
  expect(post).toBeDefined();

  const body = fromPlainText('The image keeps its readable text', 'blocks');
  body.doc.content ??= [];
  body.doc.content.push(
    { type: 'image', attrs: { src: image.id, alt: 'Declared image' } },
    { type: 'image', attrs: { src: id(900), alt: 'Undeclared image' } },
  );
  const revised = await fixture.checked(
    'POST',
    `/v1/posts/${post.id}/revisions`,
    { body, licence: 'MIT', subjectIds: [] },
    200,
    { headers: { 'if-match': JSON.stringify(post.revisionId) } },
  );
  const admitted = await fixture.call('GET', path);
  expect(admitted.response.status, admitted.text).toBe(200);
  const document = admitted.value.documentMedia.documents.find((entry: any) => entry.postId === post.id);
  expect(document).toMatchObject({
    postId: post.id,
    threadId: image.threadId,
    revisionId: revised.post.revisionId,
    sha256: revised.post.sha256,
    state: 'available',
  });
  expect(document.images.map((entry: any) => entry.id)).toEqual([image.id]);
  expect(document.images[0]).toMatchObject({
    id: image.id,
    state: 'available',
    presentation: {
      id: image.id,
      containerId: image.threadId,
      digest: image.sha256,
      credit: null,
    },
  });
  expect(document.images[0].presentation.variants.length).toBeGreaterThan(0);
  expect(Object.keys(document.images[0].presentation.variants[0]).sort()).toEqual(['format', 'height', 'width']);
  expect(JSON.stringify(document.images[0].presentation)).not.toContain('"key"');

  const observer = observeSql(fixture.db.pool);
  const barrier = observer.hold({ statement: candidates.sql }, 'after');
  let pending: ReturnType<typeof fixture.call> | undefined;
  try {
    pending = fixture.call('GET', path);
    await barrier.entered;
    const edited = await fixture.checked(
      'POST',
      `/v1/posts/${post.id}/revisions`,
      { body: fromPlainText('A later text edit remains readable', 'blocks'), licence: 'MIT', subjectIds: [] },
      200,
      {
        kernel: fixture.mutationKernel,
        headers: { 'if-match': JSON.stringify(revised.post.revisionId) },
      },
    );
    barrier.release();
    const stale = await pending;
    expect(stale.response.status).toBe(503);
    expect(stale.value.code).toBe('dependency_unavailable');

    const current = await fixture.call('GET', path);
    expect(current.response.status, current.text).toBe(200);
    expect(current.value.documentMedia).toEqual({ state: 'available', documents: [] });
    const currentPost = current.value.replies.items.find((entry: any) => entry.id === post.id);
    expect(currentPost.revisionId).toBe(edited.post.revisionId);
    expect(JSON.stringify(currentPost.body)).toContain('A later text edit remains readable');
  } finally {
    barrier.release();
    await pending?.catch(() => {});
    await observer.close();
  }
});

test('the native document image bound stays explicit on overflow', () => {
  const threadId = id(1);
  const mediaIds = Array.from({ length: READING_PAGE_DOCUMENT_MEDIA_LIMIT + 1 }, (_, index) => id(index + 10));
  const body = fromPlainText('Overflow remains text', 'blocks');
  body.doc.content ??= [];
  body.doc.content.push(...mediaIds.map((src) => ({ type: 'image', attrs: { src } })));
  const post = {
    id: id(2),
    threadId,
    route: 0,
    authorId: id(3),
    parentId: null,
    licence: 'MIT',
    subjectIds: [],
    boardId: id(4),
    visibility: 'published',
    securityRevision: '1',
    availability: 'available',
    createdAt: '2026-11-05T00:00:00.000Z',
    revisedAt: null,
    sha256: 'a'.repeat(64),
    mediaIds,
    voteCitation: null,
    revisionId: id(5),
    body,
  } satisfies PostEntry;
  const selection = selectReadingPageDocumentMedia(threadId, [post]);
  expect(selection.state).toBe('overflow');
  if (selection.state !== 'overflow') throw new Error('Expected explicit overflow');
  expect(selection.documents[0]).toMatchObject({ postId: post.id });
  expect(selection.documents[0]?.mediaIds).toHaveLength(READING_PAGE_DOCUMENT_MEDIA_LIMIT + 1);
});
