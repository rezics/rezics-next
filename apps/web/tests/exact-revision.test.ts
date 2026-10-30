import { expect, test } from 'bun:test';
import { createKernelClient } from '@rezics/client';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { m } from '../src/paraglide/messages.js';
import { loadExactRevision, type ExactRevisionResponse, type ExactRevisionState } from '../src/threads/exact-revision';
import { exactRevisionHref } from '../src/threads/exact-revision-href';
import { ExactRevisionView } from '../src/threads/exact-revision-view';
import { loadRevisionDocumentMedia, revisionDocumentImageIds } from '../src/threads/exact-revision-media';
import { current, id, identity, later, selected } from '../src/stories/exact-revision/fixture';

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
  // The original shared producer is absent in this checkout. Its admitted outcome is typed
  // unavailability, never an invented variant, original download or a second media caller.
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
  // History shares this exact absence boundary; it has no per-revision/per-image substitute.
  expect(
    await loadRevisionDocumentMedia(kernel, revisionDocumentImageIds([revision, later]), 'Bearer reader'),
  ).toEqual({ kind: 'unavailable' });
  expect(requests).toHaveLength(3);
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
  expect(revisionDocumentImageIds([{ ...revision, body: selected.body }, { ...nextPage, mediaIds: [] }])).toEqual([]);
});
