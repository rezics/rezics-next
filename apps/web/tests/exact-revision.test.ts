import { expect, mock, test } from 'bun:test';
import { createKernelClient } from '@rezics/client';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { m } from '../src/paraglide/messages.js';
import { loadExactRevision, type ExactRevisionResponse, type ExactRevisionState } from '../src/threads/exact-revision';
import { exactRevisionHref } from '../src/threads/exact-revision-href';
import { ExactRevisionView } from '../src/threads/exact-revision-view';
import { loadRevisionDocumentMedia, revisionDocumentImageIds } from '../src/threads/exact-revision-media';
import { threadLocation } from '../src/threads/thread-href';
import { current, id, identity, later, selected } from '../src/stories/exact-revision/fixture';
import type { DocumentImagePresentation } from '../src/threads/document-media';
import * as start from '../.storybook/react-start';

function client(handler: (request: Request) => Response) {
  return createKernelClient('https://kernel.test', {
    fetch: Object.assign(async (input: RequestInfo | URL, init?: RequestInit) => handler(new Request(input, init)), {
      preconnect() {},
    }),
  });
}
const markup = (page: ExactRevisionState, revisionId = selected.revisionId) =>
  renderToStaticMarkup(createElement(ExactRevisionView, { identity: { ...identity, revisionId }, page }));

test('two exact revisions retain their original document/block identity, licence and references within fixed request bounds', async () => {
  const requests: Request[] = [];
  const kernel = client((call) => {
    requests.push(call);
    const path = new URL(call.url).pathname;
    for (const revision of [selected, later]) {
      if (path === `/v1/posts/${revision.id}/revisions/${revision.revisionId}`)
        return Response.json({ post: revision } satisfies ExactRevisionResponse);
    }
    if (path === `/v1/threads/${selected.threadId}`) return Response.json(current);
    if (path === '/v1/accounts') return Response.json({ accounts: [] });
    throw new Error(`Unexpected request: ${path}`);
  });
  for (const revision of [selected, later]) {
    const page = await loadExactRevision(
      kernel,
      { postId: revision.id, revisionId: revision.revisionId },
      'Bearer reader',
    );
    expect(page.state).toBe('ready');
    if (page.state !== 'ready') throw new Error('Expected the exact revision');
    expect(page.revision).toEqual(revision);
    const html = markup(page, revision.revisionId);
    expect(html).toContain(`href="${threadLocation('en', page.thread, undefined, revision.id)}"`);
    expect(html).toContain(revision.licence);
    expect(html).toContain(revision.subjectIds[0]!);
    expect(html).toContain(
      m.thread_provenance_vote({
        units: String(revision.voteCitation!.units),
        questionId: revision.voteCitation!.questionId,
        revision: String(revision.voteCitation!.revision),
      }),
    );
    expect(html).toContain(revision === selected ? 'The original edition' : 'The later edition');
    expect(html).not.toContain(revision === selected ? later.licence : selected.licence);
    expect(page.revision.body.doc.content?.[0]?.attrs?.id).toBe('recorded-paragraph');
    expect(page.thread.differentHead).toBe(revision === selected);
    expect(html).not.toContain(m.thread_provenance_current_vote());
    expect(exactRevisionHref({ postId: revision.id, revisionId: revision.revisionId }, 'zh-Hant')).toBe(
      `/zh-Hant/posts/${revision.id}/revisions/${revision.revisionId}`,
    );
  }
  expect(requests).toHaveLength(6);
  expect(
    requests
      .filter((call) => !call.url.includes('/accounts'))
      .every((call) => call.headers.get('authorization') === 'Bearer reader'),
  ).toBe(true);
  expect(
    requests.some((call) => /\/posts\/[^/]+$|\/posts$|\/vote$|\/subjects\//.test(new URL(call.url).pathname)),
  ).toBe(false);
});

test('current denial replaces readable content without cached body, parent title or an invented erasure reason; problems retry the exact resource', async () => {
  let exactStatus = 200;
  let contextStatus = 200;
  let post: ExactRevisionResponse['post'] = selected;
  const calls: string[] = [];
  const kernel = client((call) => {
    const path = new URL(call.url).pathname;
    calls.push(path);
    if (path.endsWith(`/revisions/${selected.revisionId}`))
      return Response.json(
        exactStatus === 200 ? { post } : { code: exactStatus === 404 ? 'not_found' : 'dependency_unavailable' },
        { status: exactStatus },
      );
    if (path === `/v1/threads/${selected.threadId}`)
      return Response.json(contextStatus === 200 ? current : { code: 'not_found' }, { status: contextStatus });
    return Response.json({ accounts: [] });
  });
  expect(markup(await loadExactRevision(kernel, identity))).toContain('The original edition');
  for (const status of [403, 404]) {
    contextStatus = status;
    const denied = await loadExactRevision(kernel, identity);
    expect(denied).toEqual({ state: 'unavailable', status });
    const html = markup(denied);
    expect(html).toContain(m.exact_revision_unavailable());
    for (const hidden of [
      'The original edition',
      selected.licence,
      current.thread.title!,
      '#post-',
      'data-slot="document-body"',
    ])
      expect(html).not.toContain(hidden);
    expect(html).not.toContain('erased');
  }
  contextStatus = 200;
  exactStatus = 404;
  calls.length = 0;
  expect(await loadExactRevision(kernel, identity)).toEqual({ state: 'unavailable', status: 404 });
  expect(calls).toEqual([`/v1/posts/${selected.id}/revisions/${selected.revisionId}`]);
  exactStatus = 200;
  for (const availability of ['erased', 'withheld'] as const) {
    post = { ...selected, availability, body: null, sha256: null, removed: true };
    expect(markup(await loadExactRevision(kernel, identity))).not.toContain('The original edition');
  }
  exactStatus = 503;
  expect(await loadExactRevision(kernel, identity)).toEqual({
    state: 'problem',
    status: 503,
    code: 'dependency_unavailable',
  });
  exactStatus = 200;
  post = selected;
  expect(markup(await loadExactRevision(kernel, identity))).toContain('The original edition');
});

test('Exact revision and history use genuine current derivative images', async () => {
  // Each explicit load uses the original shared producer. A native source failure stays
  // unavailable, never an invented variant, original download or a per-image retry.
  const revision = {
    ...selected,
    mediaIds: [id(60), id(61)],
    body: {
      ...selected.body,
      doc: {
        ...selected.body.doc,
        content: [
          ...(selected.body.doc.content ?? []),
          { type: 'image', attrs: { id: 'native-image', src: id(60), alt: 'A quiet reading room' } },
          { type: 'image', attrs: { id: 'undeclared-image', src: id(62), alt: 'Unavailable illustration' } },
          { type: 'image', attrs: { id: 'external-image', src: 'https://images.example/private.jpg', alt: '' } },
        ],
      },
    },
  };
  const requests: Request[] = [];
  let denied = false;
  const kernel = client((call) => {
    requests.push(call);
    const path = new URL(call.url).pathname;
    if (path === `/v1/posts/${identity.postId}/revisions/${identity.revisionId}`)
      return denied ? Response.json({ code: 'not_found' }, { status: 404 }) : Response.json({ post: revision });
    if (path === `/v1/threads/${selected.threadId}`) return Response.json(current);
    if (path === '/v1/media/presentations') return new Response(null, { status: 503 });
    if (path === '/v1/accounts') return Response.json({ accounts: [] });
    throw new Error(`Unexpected request: ${path}`);
  });
  const page = await loadExactRevision(kernel, identity, 'Bearer reader');
  expect(page.state).toBe('ready');
  if (page.state !== 'ready') throw new Error('Expected independently readable exact revision');
  expect(page.documentMedia).toEqual({ kind: 'unavailable' });
  expect(revisionDocumentImageIds([page.revision])).toEqual([id(60)]);
  const html = markup(page);
  expect(html).toContain('A quiet reading room');
  expect(html).toContain(m.content_edition_image_unavailable());
  expect(html).not.toContain('<img');
  expect(html).not.toContain('<picture');
  expect(html).not.toContain('https://images.example');
  expect(html).not.toContain('/original');
  expect(html).toContain(selected.licence);
  expect(page.revision.sha256).toBe(selected.sha256);
  expect(page.thread.differentHead).toBe(true);
  // History makes its own bounded page read; it has no per-revision/per-image substitute.
  expect(await loadRevisionDocumentMedia(kernel, revisionDocumentImageIds([revision, later]), 'Bearer reader')).toEqual(
    { kind: 'unavailable' },
  );
  expect(requests).toHaveLength(5);
  const mediaRequests = requests.filter((request) => new URL(request.url).pathname === '/v1/media/presentations');
  expect(mediaRequests).toHaveLength(2);
  expect(mediaRequests.every((request) => request.method === 'POST')).toBe(true);
  expect(await Promise.all(mediaRequests.map((request) => request.json()))).toEqual([
    { ids: [id(60)] },
    { ids: [id(60)] },
  ]);
  expect(
    requests
      .filter((request) => new URL(request.url).pathname !== '/v1/media/presentations')
      .map((request) => new URL(request.url).pathname),
  ).toEqual([
    `/v1/posts/${identity.postId}/revisions/${identity.revisionId}`,
    `/v1/threads/${selected.threadId}`,
    '/v1/accounts',
  ]);
  expect(
    requests
      .filter((request) => !request.url.includes('/accounts'))
      .every((request) => request.headers.get('authorization') === 'Bearer reader'),
  ).toBe(true);

  denied = true;
  requests.length = 0;
  const withheld = await loadExactRevision(kernel, identity, 'Bearer reader');
  expect(withheld).toEqual({ state: 'unavailable', status: 404 });
  expect(requests).toHaveLength(1);
  expect(markup(withheld)).not.toContain('A quiet reading room');
  expect(markup(withheld)).not.toContain('data-slot="document-body"');
});

test('history image references stay within each native page and each available revision declaration', () => {
  const images = Array.from({ length: 35 }, (_, index) => id(100 + index));
  const revision = {
    ...selected,
    mediaIds: [...images, id(200)],
    body: {
      ...selected.body,
      doc: {
        type: 'doc',
        content: images.flatMap((src, index) => [
          { type: 'image', attrs: { id: `image-${index}`, src, alt: 'Recorded illustration' } },
          { type: 'image', attrs: { id: `repeated-image-${index}`, src, alt: 'Repeated illustration' } },
        ]),
      },
    },
  };
  const firstPage = revisionDocumentImageIds([revision]);
  expect(firstPage).toEqual(images.slice(0, 32));
  expect(firstPage).not.toContain(id(200));
  expect(firstPage).not.toContain(images[32]!);

  const nextPage = {
    ...revision,
    revisionId: id(201),
    mediaIds: [id(202)],
    body: {
      ...revision.body,
      doc: {
        type: 'doc',
        content: [
          { type: 'image', attrs: { id: 'current-page-image', src: id(202), alt: 'Next recorded illustration' } },
          // This was declared on another page; that declaration cannot rescue this reference.
          { type: 'image', attrs: { id: 'old-page-image', src: images[0]!, alt: 'Unbound reference' } },
        ],
      },
    },
  };
  expect(revisionDocumentImageIds([nextPage])).toEqual([id(202)]);
  for (const availability of ['withheld', 'erased'])
    expect(revisionDocumentImageIds([{ ...revision, availability }])).toEqual([]);
  expect(revisionDocumentImageIds([{ ...revision, body: null }])).toEqual([]);
  // A declaration on a different revision in the same page is also insufficient.
  expect(
    revisionDocumentImageIds([
      { ...revision, body: selected.body },
      { ...nextPage, mediaIds: [] },
    ]),
  ).toEqual([]);
});

const presentation = (mediaId: string): DocumentImagePresentation => ({
  id: mediaId,
  containerId: selected.threadId,
  digest: 'a'.repeat(64),
  width: 457,
  height: 271,
  variants: [{ format: 'webp', width: 113, height: 67 }],
  placeholder: null,
  focalPoint: null,
  credit: null,
});
const illustrated = (references: string[], mediaIds = references) => ({
  ...selected,
  mediaIds,
  subjectIds: [],
  body: {
    ...selected.body,
    doc: {
      ...selected.body.doc,
      content: [
        ...(selected.body.doc.content ?? []),
        ...references.map((src, index) => ({
          type: 'image',
          attrs: { id: `illustration-${index}`, src, alt: `Recorded illustration ${index}` },
        })),
      ],
    },
  },
});

// Exercise the actual server handler with request/session boundaries and the original native client transport.
mock.module('@tanstack/react-start', () => start);
mock.module('cloudflare:workers', () => ({ env: {} }));
let historyRequest = new Request('https://site.test/en/thread', { headers: { authorization: 'Bearer first-page' } });
mock.module('@tanstack/react-start/server', () => ({
  getRequest: () => historyRequest,
  setResponseHeader: () => {},
}));
let historyClient: ReturnType<typeof client>;
mock.module('../src/kernel/client', () => ({ kernelClient: () => historyClient }));
const { readPostHistory } = await import('../src/threads/reads');
const { createHistoricalReadBinding } = await import('../src/threads/historical-reader-provenance');
const { RevisionEntry } = await import('../src/threads/post-history');
type HistoryPage = Extract<Awaited<ReturnType<typeof readPostHistory>>['data'], { available: true }>;
function historyInput(postId: string, cursor?: string) {
  const locale = 'en';
  const credentialMode = 'session' as const;
  const binding = createHistoricalReadBinding(
    undefined,
    { kind: 'post-history', postId, cursor: cursor ?? null, locale, credentialMode },
    1,
    0,
    1,
  );
  return { postId, ...(cursor !== undefined ? { cursor } : {}), locale, credentialMode, binding };
}
const historyMarkup = (page: HistoryPage, index = 0) =>
  renderToStaticMarkup(
    createElement(RevisionEntry, {
      revision: page.revisions[index]!,
      number: index + 1,
      authors: page.authors,
      mentions: page.mentions,
      documentMedia: page.documentMedia,
      now: page.now,
      subjects: page.subjects,
      currentVote: undefined,
      review: true,
    }),
  );

test('Exact revision and each explicit native history page use the sole delivered DocumentMedia reader and renderer, while unauthorized omitted or overflow image references remain unavailable', async () => {
  const calls: Request[] = [];
  const exact = illustrated([id(60), id(61), id(62), id(60)], [id(60), id(61), id(63)]);
  const images = Array.from({ length: 35 }, (_, index) => id(100 + index));
  const first = illustrated(images);
  const unbound = { ...illustrated([images[0]!], []), revisionId: id(500) };
  const withheld = {
    ...illustrated([id(600)]),
    revisionId: id(502),
    availability: 'withheld',
    body: null,
    sha256: null,
    removed: true,
  };
  const second = { ...illustrated([images[32]!, images[0]!]), revisionId: id(501) };
  const cursor = 'native-signed/+=';
  let pageIndex = -1;
  let historyDenied = false;
  historyClient = client((request) => {
    calls.push(request);
    const url = new URL(request.url);
    if (url.pathname.endsWith(`/revisions/${selected.revisionId}`)) return Response.json({ post: exact });
    if (url.pathname === `/v1/threads/${selected.threadId}`) return Response.json(current);
    if (url.pathname === `/v1/posts/${selected.id}/revisions`) {
      if (historyDenied) return new Response(null, { status: 404 });
      pageIndex = url.searchParams.has('cursor') ? 1 : 0;
      return Response.json({
        revisions: pageIndex ? [second] : [first, unbound, withheld],
        next: pageIndex ? null : cursor,
      });
    }
    if (url.pathname === '/v1/media/presentations')
      return Response.json({ images: [presentation(pageIndex < 0 ? id(60) : pageIndex ? images[32]! : images[0]!)] });
    if (url.pathname === '/v1/accounts') return Response.json({ accounts: [] });
    throw new Error(`Unexpected request: ${url.pathname}`);
  });
  const exactPage = await loadExactRevision(historyClient, identity, 'Bearer exact-reader');
  expect(exactPage.state).toBe('ready');
  if (exactPage.state !== 'ready') throw new Error('Expected exact document');
  const html = markup(exactPage);
  expect(html.match(/<picture>/g)).toHaveLength(2);
  expect(html).toContain(`src="/media/${id(60)}/webp-113"`);
  expect(html).toContain('alt="Recorded illustration 0"');
  expect(html.match(/data-state="unavailable"/g)).toHaveLength(2);
  expect(html).not.toContain(`/media/${id(61)}/`);
  expect(html).not.toContain(`/media/${id(62)}/`);
  expect(exactPage.revision.sha256).toBe(selected.sha256);
  expect(html).toContain(selected.licence);

  const firstResponse = await readPostHistory({ data: historyInput(selected.id) });
  expect(firstResponse.data.available).toBe(true);
  if (!firstResponse.data.available) throw new Error('Expected first history page');
  const firstPage = firstResponse.data;
  expect(firstPage.next).toBe(cursor);
  expect(historyMarkup(firstPage)).toContain(`/media/${images[0]}/webp-113`);
  expect(historyMarkup(firstPage).match(/data-state="unavailable"/g)).toHaveLength(34);
  expect(historyMarkup(firstPage, 1)).not.toContain('<picture');
  expect(historyMarkup(firstPage, 2)).not.toContain('data-slot="document-body"');
  expect(calls.filter((request) => new URL(request.url).pathname.endsWith('/revisions'))).toHaveLength(1);

  historyRequest = new Request('https://site.test/en/thread', { headers: { authorization: 'Bearer second-page' } });
  const secondResponse = await readPostHistory({ data: historyInput(selected.id, firstPage.next!) });
  expect(secondResponse.data.available).toBe(true);
  if (!secondResponse.data.available) throw new Error('Expected second history page');
  const secondPage = secondResponse.data;
  expect(historyMarkup(secondPage)).toContain(`/media/${images[32]}/webp-113`);
  expect(historyMarkup(secondPage)).not.toContain(`/media/${images[0]}/`);
  // A later page cannot refill an earlier page's overflow or omission.
  expect(historyMarkup(firstPage)).not.toContain(`/media/${images[32]}/`);
  const batches = calls.filter((request) => new URL(request.url).pathname === '/v1/media/presentations');
  expect(batches).toHaveLength(3);
  expect(await Promise.all(batches.map((request) => request.json()))).toEqual([
    { ids: [id(60), id(61)] },
    { ids: images.slice(0, 32) },
    { ids: [images[32], images[0]] },
  ]);
  expect(batches.map((request) => request.headers.get('authorization'))).toEqual([
    'Bearer exact-reader',
    'Bearer first-page',
    'Bearer second-page',
  ]);
  expect(batches.every((request) => request.method === 'POST')).toBe(true);
  const historyReads = calls.filter((request) => new URL(request.url).pathname.endsWith('/revisions'));
  expect(historyReads.map((request) => [...new URL(request.url).searchParams])).toEqual([
    [['limit', '20']],
    [
      ['limit', '20'],
      ['cursor', cursor],
    ],
  ]);
  expect(historyReads.map((request) => request.headers.get('authorization'))).toEqual([
    'Bearer first-page',
    'Bearer second-page',
  ]);
  const count = calls.length;
  historyDenied = true;
  expect((await readPostHistory({ data: historyInput(selected.id, cursor) })).data).toEqual({ available: false });
  expect(calls).toHaveLength(count + 1);
});

test('optional current media denial cannot rescue a missing exact source or reuse an earlier image result', async () => {
  let sourceStatus = 200;
  let mediaStatus = 200;
  const calls: Request[] = [];
  const kernel = client((request) => {
    calls.push(request);
    const path = new URL(request.url).pathname;
    if (path.endsWith(`/revisions/${selected.revisionId}`))
      return sourceStatus === 200
        ? Response.json({ post: illustrated([id(60)]) })
        : new Response(null, { status: sourceStatus });
    if (path === `/v1/threads/${selected.threadId}`) return Response.json(current);
    if (path === '/v1/media/presentations')
      return mediaStatus === 200
        ? Response.json({ images: [presentation(id(60))] })
        : new Response(null, { status: mediaStatus });
    if (path === '/v1/accounts') return Response.json({ accounts: [] });
    throw new Error(`Unexpected request: ${path}`);
  });
  expect(markup(await loadExactRevision(kernel, identity, 'Bearer current-reader'))).toContain('<picture');
  for (const status of [403, 404, 503]) {
    mediaStatus = status;
    const page = await loadExactRevision(kernel, identity, 'Bearer current-reader');
    expect(page.state).toBe('ready');
    expect(markup(page)).toContain('The original edition');
    expect(markup(page)).toContain('data-state="unavailable"');
    expect(markup(page)).not.toContain('<picture');
  }
  sourceStatus = 404;
  mediaStatus = 200;
  calls.length = 0;
  const page = await loadExactRevision(kernel, identity, 'Bearer current-reader');
  expect(page).toEqual({ state: 'unavailable', status: 404 });
  expect(markup(page)).not.toContain('data-slot="document-body"');
  expect(calls).toHaveLength(1);
});
