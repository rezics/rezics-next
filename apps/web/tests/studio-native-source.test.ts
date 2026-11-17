import { AsyncLocalStorage } from 'node:async_hooks';
import { afterAll, expect, mock, spyOn, test } from 'bun:test';
import { QueryClient } from '@tanstack/react-query';
import { createKernelClient } from '@rezics/client';
import { fromPlainText, type DocumentSnapshot } from '@rezics/document';
import { editionDocumentDigest } from '../src/content-editions/edition-model';
import { setLocale } from '../src/paraglide/runtime.js';
import type { StudioInput } from '../src/studio/contract';
import type { OwnDraftCommands } from '../src/threads';
import * as start from '../.storybook/react-start';

const requests = new AsyncLocalStorage<Request>();
mock.module('@tanstack/react-start', () => ({
  ...start,
  createServerFn({ method }: { method: string }) {
    const chain = start.createServerFn();
    const serverFn = {
      validator(validate: (input: unknown) => unknown) {
        chain.validator(validate);
        return serverFn;
      },
      handler(handle: (context: never) => unknown) {
        const dispatch = chain.handler(handle);
        return (input?: { data?: unknown; headers?: HeadersInit }) =>
          requests.run(new Request('https://site.test/studio', { method, headers: input?.headers }), () =>
            dispatch(input as never),
          );
      },
    };
    return serverFn;
  },
}));
mock.module('@tanstack/react-start/server', () => ({
  getRequest: () => requests.getStore()!,
  setResponseHeader: () => {},
  setResponseStatus: () => {},
}));

const id = (value: number) => `00000000-0000-8000-8000-${String(value).padStart(12, '0')}`;
const accountId = id(1),
  postId = id(2),
  threadId = id(3),
  revisionId = id(4);
const changedId = id(5),
  boardId = id(6),
  mediaId = id(7),
  outlineId = id(8);
const csrfToken = 'test-csrf';
const viewer = { accountId, authnEpoch: 9 };
const textBody = fromPlainText('A stored manuscript', 'text');
const title = 'The Book opening';
const account = await import('../src/session/request');
const browser = await import('../src/session/browser-state');
const kernel = await import('../src/kernel/client');
let send: (request: Request) => Promise<Response>;
const client = createKernelClient('https://kernel.test', {
  fetch: (input, init) => send(new Request(input, init)),
});
const spies = [
  spyOn(kernel, 'kernelClient').mockReturnValue(client),
  spyOn(kernel, 'hasKernelOrigin').mockReturnValue(true),
  spyOn(account, 'prepareSession').mockImplementation(async (request) => {
    if (request.method === 'POST' && request.headers.get('X-CSRF-Token') !== csrfToken)
      throw new Error('Missing session CSRF header');
    return false;
  }),
  spyOn(account, 'sessionSubject').mockReturnValue(accountId),
  spyOn(account, 'viewerCredential').mockReturnValue('Bearer test'),
  spyOn(browser, 'sessionCsrfToken').mockReturnValue(csrfToken),
];
afterAll(() => spies.forEach((spy) => spy.mockRestore()));
setLocale('en');

const { StudioController } = await import('../src/studio/controller');
const { createStudioAccountPort } = await import('../src/studio/account-port');
const { hostedBookNative } = await import('../src/studio/hosted-actions');
const { historicalReaderSource } = await import('../src/threads/historical-reader-provenance');
const { nativeOwnDraftRequests } = await import('../src/threads/own-drafts/native-requests');
const { ownDraftNativeCommandTransport } = await import('../src/threads/own-drafts/visit');

async function savedPost(body: DocumentSnapshot, revision = revisionId, mediaIds: string[] = []) {
  return {
    id: postId,
    threadId,
    revisionId: revision,
    parentId: null,
    authorId: accountId,
    boardId,
    licence: 'CC-BY-4.0',
    subjectIds: [],
    visibility: 'draft',
    availability: 'available',
    body,
    sha256: await editionDocumentDigest(body),
    mediaIds,
    createdAt: '2026-11-16T00:00:00Z',
    revisedAt: null,
  };
}

function visit(commands?: OwnDraftCommands) {
  const cache = new QueryClient();
  cache.setQueryData(['session'], { state: 'signed-in', subject: accountId, csrfToken });
  return createStudioAccountPort({
    identity: { ...viewer, callerEpoch: 'test', source: 'content', address: '/studio', locale: 'en' },
    initialPage: { viewer, state: 'preparing', drafts: [], next: null },
    reader: nativeOwnDraftRequests(client),
    ...(commands ? { commands } : {}),
    source: historicalReaderSource(cache),
    csrfToken,
    locale: 'en',
    isCurrent: () => true,
  });
}

const postResponse = (post: Awaited<ReturnType<typeof savedPost>>) =>
  Response.json({ post }, { headers: { etag: JSON.stringify(post.revisionId) } });

function readNativeOpening(request: Request, post: Awaited<ReturnType<typeof savedPost>>) {
  const { pathname, searchParams } = new URL(request.url);
  if (pathname === `/v1/posts/${postId}`) return postResponse(post);
  if (pathname === `/v1/threads/${threadId}`)
    return Response.json({ thread: { id: threadId, title, kind: 'discussion', firstPost: post } });
  if (pathname === `/v1/accounts/${accountId}/drafts/${postId}`) {
    expect(searchParams.get('threadId')).toBe(threadId);
    return postResponse(post);
  }
  throw new Error(`Unexpected native request ${pathname}`);
}

test('an exact Studio URL resumes an owned opening outside the preparing inventory and rejects a changed revision', async () => {
  const port = visit();
  const post = await savedPost(textBody);
  const abort = new AbortController();
  send = async (request) => readNativeOpening(request, post);
  expect(await port.resume(postId, abort.signal)).toMatchObject({
    ok: true,
    value: { revision: { exact: { postId, revisionId, sha256: post.sha256 } } },
  });
  send = async (request) =>
    new URL(request.url).pathname.includes('/drafts/')
      ? postResponse({ ...post, revisionId: changedId })
      : readNativeOpening(request, post);
  expect(await port.resume(postId, abort.signal)).toMatchObject({ ok: false, error: { kind: 'stale' } });
});

test('Studio keeps the exact text source and conditionally saves its rich working copy with native media and digest', async () => {
  let post = await savedPost(textBody);
  const writes: Request[] = [];
  send = async (request) => {
    if (request.method === 'POST') {
      writes.push(request.clone());
      const input = (await request.json()) as { body: DocumentSnapshot; mediaIds: string[] };
      post = await savedPost(input.body, changedId, input.mediaIds);
      return Response.json({ post }, { status: 201 });
    }
    return readNativeOpening(request, post);
  };
  const port = visit();
  const opened = await port.resume(postId, new AbortController().signal);
  if (!opened.ok) throw new Error(opened.error.message);
  const input: StudioInput = {
    visitKey: 'native',
    projectId: accountId,
    title: 'Drafts',
    profile: { kind: 'articles', seriesTitle: null },
    documents: { items: [], nextCursor: null },
    publications: { items: [], nextCursor: null },
    initialSelection: opened.value,
    canCreateDraft: true,
    canPublish: true,
    nativeDrafts: true,
  };
  const controller = new StudioController(input, port);
  const disconnect = controller.connect();
  try {
    const initial = controller.snapshot().selected!;
    expect(initial.source.revision.body).toEqual(textBody);
    expect(initial.dirty).toBe(false);
    expect(initial.body.profile).toBe('blocks');
    expect(initial.body.doc).toEqual(textBody.doc);
    const body = structuredClone(initial.body);
    body.doc.content!.push({ type: 'image', attrs: { id: id(9), src: mediaId, alt: 'Original cover' } });
    controller.changeBody(body);
    expect(await controller.save()).toBe(true);
    expect(writes).toHaveLength(1);
    expect(writes[0]!.headers.get('if-match')).toBe(JSON.stringify(revisionId));
    expect(writes[0]!.headers.get('idempotency-key')).toMatch(/^"[0-9a-f-]{36}"$/i);
    expect(controller.snapshot().selected?.source.revision).toMatchObject({
      exact: { postId, revisionId: changedId, sha256: await editionDocumentDigest(body) },
      mediaIds: [mediaId],
    });
  } finally {
    disconnect();
  }
});

test('account publication sends the exact reviewed Text revision through the native revision command', async () => {
  let post = { ...(await savedPost(textBody)), subjectIds: [id(9)] };
  const key = id(10);
  const writes: Request[] = [];
  send = async (request) => {
    if (request.method === 'POST') {
      writes.push(request.clone());
      post = { ...post, revisionId: changedId, visibility: 'published' };
      return postResponse(post);
    }
    return readNativeOpening(request, post);
  };
  const port = visit({
    revise: (input, signal) => ownDraftNativeCommandTransport.revise!(input, csrfToken, signal),
    readback: ownDraftNativeCommandTransport.readback,
    write: (input, signal) => ownDraftNativeCommandTransport.write(input, csrfToken, signal),
    erase: (input, signal) => ownDraftNativeCommandTransport.erase(input, csrfToken, signal),
  });
  const signal = new AbortController().signal;
  const selected = await port.resume(postId, signal);
  if (!selected.ok) throw new Error(selected.error.message);
  const review = await port.reviewPublication(
    { projectId: accountId, target: { kind: 'article', document: selected.value.revision.exact } },
    signal,
  );
  if (!review.ok) throw new Error(review.error.message);

  expect(await port.publish({ projectId: accountId, review: review.value, idempotencyKey: key }, signal)).toMatchObject(
    {
      ok: true,
      value: {
        state: 'published',
        readbackSelection: {
          revision: { exact: { postId, revisionId: changedId, sha256: post.sha256 }, title, body: textBody },
        },
      },
    },
  );
  expect(writes).toHaveLength(1);
  const command = writes[0]!;
  expect(new URL(command.url).pathname).toBe(`/v1/posts/${postId}/revisions`);
  expect(command.headers.get('if-match')).toBe(JSON.stringify(revisionId));
  expect(command.headers.get('idempotency-key')).toBe(JSON.stringify(key));
  expect(await command.json()).toEqual({
    body: textBody,
    boardId,
    licence: post.licence,
    subjectIds: post.subjectIds,
    mediaIds: [],
    visibility: 'published',
  });
});

test('own-drafts publication also accepts the native Text profile', async () => {
  const post = { ...(await savedPost(textBody, changedId)), visibility: 'published' };
  const key = id(11);
  let delivered = false;
  send = async (request) => {
    expect(request.method).toBe('POST');
    expect(new URL(request.url).pathname).toBe(`/v1/posts/${postId}/revisions`);
    expect(request.headers.get('if-match')).toBe(JSON.stringify(revisionId));
    expect(request.headers.get('idempotency-key')).toBe(JSON.stringify(key));
    expect(await request.json()).toEqual({ body: textBody, mediaIds: [], visibility: 'published' });
    delivered = true;
    return postResponse(post);
  };
  const result = await ownDraftNativeCommandTransport.write(
    { action: 'publish', postId, threadId, body: textBody, revisionId, mediaIds: [], idempotencyKey: key },
    csrfToken,
    new AbortController().signal,
  );
  expect(result).toEqual({ ok: true, post });
  expect(delivered).toBe(true);
});

test('Book creation carries the browser session proof and reads the exact acknowledged outline', async () => {
  const revision = { catalogueId: postId, revisionId: outlineId, kind: 'structure', sourceRevisionId: null };
  const key = id(10);
  const calls: Request[] = [];
  send = async (request) => {
    calls.push(request);
    const target = new URL(request.url);
    if (request.method === 'POST') {
      expect(target.pathname).toBe('/v1/hostedCatalogues');
      expect(request.headers.get('idempotency-key')).toBe(JSON.stringify(key));
      expect(await request.json()).toEqual({ postId, threadId, placements: [] });
      return Response.json({ catalogueId: postId, revisionId: outlineId }, { status: 201 });
    }
    expect(target.searchParams.get('revisionId')).toBe(outlineId);
    return Response.json(
      target.pathname.endsWith('/outline') ? { ...revision, items: [], nextCursor: null } : revision,
    );
  };
  expect(
    await hostedBookNative.create({ postId, threadId, placements: [] }, key, new AbortController().signal),
  ).toEqual({ ok: true, value: { revision, placements: [], defaultLanguages: {} } });
  expect(calls.map(({ method }) => method)).toEqual(['POST', 'GET', 'GET']);
});
