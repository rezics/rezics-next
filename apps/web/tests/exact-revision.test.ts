import { expect, test } from 'bun:test';
import { createKernelClient } from '@rezics/client';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { m } from '../src/paraglide/messages.js';
import { loadExactRevision, type ExactRevisionResponse, type ExactRevisionState } from '../src/threads/exact-revision';
import { exactRevisionHref } from '../src/threads/exact-revision-href';
import { ExactRevisionView } from '../src/threads/exact-revision-view';
import { current, identity, later, selected } from '../src/stories/exact-revision/fixture';

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
