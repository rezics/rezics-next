import { afterAll, expect, mock, spyOn, test } from 'bun:test';
import { createKernelClient } from '@rezics/client';
import { QueryClient } from '@tanstack/react-query';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { fromPlainText } from '@rezics/document';
import { editionDocumentDigest } from '../src/content-editions/edition-model';
import { createHistoricalReadBinding, historicalReaderSource } from '../src/threads/historical-reader-provenance';
import { StudioController } from '../src/studio/controller';
import { StudioVersions } from '../src/studio/revisions';
import { setLocale } from '../src/paraglide/runtime.js';
import type { StudioPort, StudioSelection } from '../src/studio/contract';
import * as start from '../.storybook/react-start';

mock.module('@tanstack/react-start', () => start);
const request = new Request('https://site.test/studio');
const responseHeaders = new Headers();
mock.module('@tanstack/react-start/server', () => ({
  getRequest: () => request,
  setResponseHeader: (name: string, value: string) => responseHeaders.set(name, value),
  setResponseStatus: () => {},
}));
const accountId = '00000000-0000-8000-8000-000100000001';
const postId = '00000000-0000-8000-8000-000200000001';
const revisionId = '00000000-0000-8000-8000-000200000002';
const header = {
  postId,
  revisionId,
  sha256: 'a'.repeat(64),
  recordedAt: '2026-11-12T12:34:56.123456Z',
  threadId: postId,
  authorId: accountId,
  licence: 'CC-BY-4.0',
  subjectIds: [],
  kind: 'discussion',
  documentKind: 'opening',
};
let subject: string | undefined = accountId;
let respond = async (_request: Request): Promise<Response> => Response.json({ revisions: [header], next: null });
const calls: Request[] = [];
const client = createKernelClient('https://kernel.test', {
  fetch: async (input, init) => {
    const call = new Request(input, init);
    calls.push(call);
    return respond(call);
  },
});
const native = await import('../src/kernel/client');
const session = await import('../src/session/request');
const spies = [
  spyOn(native, 'kernelClient').mockReturnValue(client),
  spyOn(session, 'prepareSession').mockResolvedValue(false),
  spyOn(session, 'viewerCredential').mockImplementation(() => (subject ? 'Bearer prepared' : null)),
  spyOn(session, 'sessionSubject').mockImplementation(() => subject),
];
afterAll(() => spies.forEach((spy) => spy.mockRestore()));
const { readPostRevisionHeaders } = await import('../src/studio/post-revision-headers-read');
const { createPostDocumentPort } = await import('../src/studio/post-document-port');
function visit() {
  subject = accountId;
  calls.length = 0;
  const cache = new QueryClient();
  const value = { state: 'signed-in', subject: accountId, csrfToken: 'write-session' };
  cache.setQueryData(['session'], value);
  const source = historicalReaderSource(cache);
  const port = createPostDocumentPort({
    projectId: postId,
    accountId,
    locale: 'en',
    source,
    csrfToken: 'write-session',
    isCurrent: () => true,
    admitsPost: (id) => id === postId,
  });
  return { port, source, replace: () => cache.setQueryData(['session'], { ...value }) };
}
const address = (cursor: string | null = null) => ({ projectId: postId, postId, cursor });
const signal = () => new AbortController().signal;

test('Studio lists native headers with exact identity and precision, one authenticated request and no body/title joins', async () => {
  const { port } = visit();
  respond = async () => Response.json({ revisions: [header], next: 'opaque+/=' });
  expect(await port.versions(address(), signal())).toEqual({
    ok: true,
    value: {
      items: [
        {
          exact: { postId, revisionId, sha256: header.sha256 },
          savedAt: header.recordedAt,
        },
      ],
      nextCursor: 'opaque+/=',
    },
  });
  expect(calls).toHaveLength(1);
  expect(new URL(calls[0]!.url).pathname).toBe(`/v1/posts/${postId}/revision-headers`);
  expect(new URL(calls[0]!.url).searchParams.get('limit')).toBe('20');
  expect(calls[0]!.headers.get('authorization')).toBe('Bearer prepared');
  expect(responseHeaders.get('cache-control')).toBe('private, no-store');
  respond = async () => Response.json({ revisions: [], next: 'next-native-boundary' });
  expect(await port.versions(address('opaque+/='), signal())).toEqual({
    ok: true,
    value: { items: [], nextCursor: 'next-native-boundary' },
  });
  expect(new URL(calls[1]!.url).searchParams.get('cursor')).toBe('opaque+/=');
  respond = async () => Response.json({}, { status: 400 });
  expect((await port.versions(address('opaque+/='), signal())).ok).toBe(false);
  expect(new URL(calls[2]!.url).searchParams.get('cursor')).toBe('opaque+/=');
});

test('header binding excludes body-history projection and rejects wrong readers, foreign Post/digest and late retired visits', async () => {
  const { port, source, replace } = visit();
  const binding = createHistoricalReadBinding(
    source,
    { kind: 'post-history', postId, cursor: null, locale: 'en', credentialMode: 'session' },
    0,
    0,
    1,
  );
  expect(() =>
    readPostRevisionHeaders({ data: { postId, locale: 'en', credentialMode: 'session', binding } }),
  ).toThrow();
  expect(calls).toHaveLength(0);
  for (const row of [
    { ...header, postId: accountId },
    { ...header, sha256: 'invalid' },
  ]) {
    respond = async () => Response.json({ revisions: [row], next: null });
    expect((await port.versions(address(), signal())).ok).toBe(false);
  }
  subject = postId;
  respond = async () => Response.json({ revisions: [header], next: null });
  expect((await port.versions(address(), signal())).ok).toBe(false);
  subject = undefined;
  const before = calls.length;
  expect((await port.versions(address(), signal())).ok).toBe(false);
  expect(calls).toHaveLength(before);
  subject = accountId;
  respond = async () => {
    replace();
    return Response.json({ revisions: [header], next: null });
  };
  expect((await port.versions(address(), signal())).ok).toBe(false);
  expect(port.isCurrent()).toBe(false);
});

test('sparse metadata pages show progress and exact comparison remains a separate selected-body read', async () => {
  const { port } = visit();
  respond = async () => Response.json({ revisions: [], next: 'continue-native' });
  const body = fromPlainText('Exact comparison body.', 'blocks');
  const exact = { postId, revisionId, sha256: await editionDocumentDigest(body) };
  const selected: StudioSelection = {
    revision: { exact, title: 'Current conversation', body, mediaIds: [], savedAt: header.recordedAt },
    permissions: { edit: true, publish: false },
  };
  const comparisons: unknown[] = [];
  const controller = new StudioController(
    {
      visitKey: 'test',
      projectId: postId,
      title: 'Column',
      profile: { kind: 'articles', seriesTitle: null },
      initialSelection: selected,
      documents: { items: [], nextCursor: null },
      publications: { items: [], nextCursor: null },
      canCreateDraft: false,
      canPublish: false,
    },
    {
      ...port,
      revision: async (input) => {
        comparisons.push(input.document);
        return { ok: true, value: selected.revision };
      },
    } as StudioPort,
  );
  setLocale('en', { reload: false });
  const disconnect = controller.connect();
  await controller.loadVersions();
  const html = () =>
    renderToStaticMarkup(createElement(StudioVersions, { controller, state: controller.snapshot(), presentation: {} }));
  expect(html()).toContain('No revisions were added on this page.');
  expect(html()).toContain('Load more versions');
  expect(html()).not.toContain('No revisions are available.');
  expect(comparisons).toHaveLength(0);
  await controller.loadVersions(true);
  expect(new URL(calls[1]!.url).searchParams.get('cursor')).toBe('continue-native');
  await controller.inspectVersion(exact);
  expect(comparisons).toEqual([exact]);
  expect(controller.snapshot().historical?.body).toEqual(body);
  await controller.inspectVersion({ ...exact, sha256: 'b'.repeat(64) });
  expect(controller.snapshot().historical).toBeNull();
  expect(controller.snapshot().issue?.kind).toBe('invalid');
  expect(calls).toHaveLength(2);
  disconnect();
});
