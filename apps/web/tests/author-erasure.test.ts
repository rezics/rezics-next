import { expect, test } from 'bun:test';
import { createKernelClient } from '@rezics/client';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  authorErasureRequest,
  authorErasureRefreshes,
  enqueueAuthorErasure,
  erasureStage,
  parseErasureOperation,
  readAuthorErasure,
  type ErasureOperation,
} from '../src/threads/author-erasure';
import {
  authorErasureAdmissionReads,
  currentAuthorErasureAdmission,
  parseAuthorErasureAdmission,
} from '../src/threads/author-erasure-admission';
import { authorErasureIdentity } from '../src/threads/author-erasure-session';
import { AuthorErasureOperationPage } from '../src/threads/author-erasure-operation';
import { m } from '../src/paraglide/messages.js';
import { newCsrfToken } from '../src/session/csrf';
import type { SessionEnv } from '../src/session/client';

const threadId = '01a17a7a-1071-720c-8100-2345e36e8473';
const authorId = '01a17a79-0af6-71c2-a357-5eefeef704f4';
const operationId = '01a17a7a-1071-720f-8100-2345e36e8473';
const identity = { authorization: 'Bearer own-session', subject: authorId };
function operation(progress = 0): ErasureOperation {
  return {
    name: `operations/${operationId}`,
    done: false,
    metadata: {
      type: 'content.author_erasure',
      threadId,
      authorId,
      processedPosts: progress,
      erasedRevisions: progress * 2,
      steps: progress ? 1 : 0,
    },
  };
}

test('Author scope thread erasure to native operation progress and terminal outcome', async () => {
  const calls: { path: string; method: string; key: string | null; authorization: string | null; body: unknown }[] = [];
  let lost = true;
  let current: unknown = operation();
  const client = createKernelClient('https://kernel.test', {
    fetch: async (input, init) => {
      const request = new Request(input, init);
      const path = new URL(request.url).pathname;
      const body = request.method === 'POST' ? await request.json() : null;
      calls.push({
        path,
        method: request.method,
        key: request.headers.get('idempotency-key'),
        authorization: request.headers.get('authorization'),
        body,
      });
      if (request.method === 'POST') {
        if (lost) {
          lost = false;
          throw new Error('response lost after commit');
        }
        return Response.json(operation(), { status: 202 });
      }
      expect(request.headers.get('cache-control')).toBe('no-store');
      return Response.json(current);
    },
  });
  const attempt = authorErasureRequest({ threadId, idempotencyKey: 'one-explicit-intent' }, (intent) =>
    enqueueAuthorErasure(client, identity, intent),
  );
  expect(await attempt()).toEqual({ kind: 'uncertain' });
  expect(await attempt()).toEqual({ kind: 'accepted', operationId });
  expect(calls.slice(0, 2)).toEqual(
    Array.from({ length: 2 }, () => ({
      path: `/v1/threads/${threadId}:erase`,
      method: 'POST',
      key: JSON.stringify('one-explicit-intent'),
      authorization: identity.authorization,
      body: { authorId },
    })),
  );
  for (const expected of ['queued', 'running', 'failed', 'completed']) {
    if (expected === 'running') current = operation(8);
    if (expected === 'failed')
      current = {
        ...operation(8),
        done: true,
        error: { code: 7, message: 'private SQL and authored content', details: ['secret'] },
      };
    if (expected === 'completed')
      current = { ...operation(8), done: true, response: { processedPosts: 8, erasedRevisions: 16 } };
    const result = await readAuthorErasure(client, identity.authorization, operationId);
    expect(result.kind).toBe('available');
    if (result.kind !== 'available') throw new Error('Expected native operation');
    expect(erasureStage(result.operation)).toBe(expected);
    expect(JSON.stringify(result)).not.toContain('private SQL');
    expect(JSON.stringify(result)).not.toContain('secret');
  }
  expect(calls.filter((call) => call.method === 'POST')).toHaveLength(2);
  expect(
    calls
      .slice(2)
      .every((call) => call.path === `/v1/operations/${operationId}` && call.authorization === identity.authorization),
  ).toBe(true);
});

test('native refusals, uncertain acknowledgements and unrelated operation IDs never become success', async () => {
  for (const [status, expected] of [
    [403, 'forbidden'],
    [404, 'not-found'],
    [409, 'conflict'],
    [503, 'uncertain'],
    [200, 'uncertain'],
  ] as const) {
    const client = createKernelClient('https://kernel.test', {
      fetch: async () => Response.json(status === 200 ? operation() : { message: 'private', status }, { status }),
    });
    expect(await enqueueAuthorErasure(client, identity, { threadId, idempotencyKey: 'fixed' })).toEqual({
      kind: expected,
    });
    expect((await readAuthorErasure(client, identity.authorization, operationId)).kind).toBe(
      status === 200 ? 'available' : status === 409 ? 'conflict' : expected === 'uncertain' ? 'unavailable' : expected,
    );
  }
  for (const payload of [
    { ...operation(), name: 'operations/not-an-id' },
    { ...operation(), metadata: { ...operation().metadata, threadId: operationId } },
    { ...operation(), metadata: { ...operation().metadata, authorId: operationId } },
  ]) {
    const client = createKernelClient('https://kernel.test', {
      fetch: async () => Response.json(payload, { status: 202 }),
    });
    expect(await enqueueAuthorErasure(client, identity, { threadId, idempotencyKey: 'fixed' })).toEqual({
      kind: 'uncertain',
    });
  }
  const mismatch = createKernelClient('https://kernel.test', {
    fetch: async () => Response.json({ ...operation(), name: `operations/${threadId}` }),
  });
  expect(await readAuthorErasure(mismatch, identity.authorization, operationId)).toEqual({ kind: 'unavailable' });
  for (const payload of [
    { ...operation(), done: true },
    { ...operation(), done: true, response: { processedPosts: 0, erasedRevisions: 0 }, error: { code: 7 } },
    { ...operation(), metadata: { ...operation().metadata, processedPosts: -1 } },
    { ...operation(), metadata: { ...operation().metadata, steps: Number.MAX_SAFE_INTEGER + 1 } },
  ])
    expect(parseErasureOperation(payload)).toBeNull();
});

test('only four foreground point refreshes are automatic; a manual read never recreates work', async () => {
  let reads = 0;
  const read = async () => {
    reads += 1;
    return { kind: 'available' as const, operation: operation(reads) };
  };
  const refreshes = authorErasureRefreshes(read);
  expect(await refreshes.foreground(false)).toBeNull();
  for (let i = 0; i < 4; i += 1) expect((await refreshes.foreground(true))?.kind).toBe('available');
  for (let i = 0; i < 3; i += 1) expect(await refreshes.foreground(true)).toBeNull();
  expect(reads).toBe(4);
  expect(refreshes.remaining()).toBe(0);
  expect((await read()).kind).toBe('available');
  expect(reads).toBe(5);
});

test('session/CSRF supplies the own actor for native erasure', async () => {
  const csrfToken = newCsrfToken();
  let available = true;
  const config = {
    AUTH_ISSUER: 'https://auth.test',
    API_RESOURCE: 'https://api.test',
    WEBSITE_SCOPES: 'post:erase',
    WEBSITE_CLIENT_ID: 'web',
    WEBSITE_CLIENT_KEY: 'test-only',
    SITE_ORIGINS: 'https://site.test',
    SESSIONS: {
      idFromName: (id: string) => id,
      get: () => ({
        credential: async () =>
          available
            ? { status: 'active', accessToken: 'own-session', subject: authorId, csrfToken }
            : { status: 'unavailable', csrfToken },
      }),
    },
  } as unknown as SessionEnv;
  const request = (token: string | null = csrfToken, origin = 'https://site.test') =>
    new Request('https://site.test/server-fn', {
      method: 'POST',
      headers: {
        cookie: `__Host-rezics_session=${'a'.repeat(43)}`,
        origin,
        ...(token ? { 'X-CSRF-Token': token } : {}),
      },
      body: JSON.stringify({ authorId: operationId }),
    });
  expect(await authorErasureIdentity(request(), config)).toEqual({ kind: 'available', identity });
  expect(await authorErasureIdentity(request(null), config)).toEqual({ kind: 'forbidden' });
  expect(await authorErasureIdentity(request(csrfToken, 'https://foreign.test'), config)).toEqual({
    kind: 'forbidden',
  });
  available = false;
  expect(await authorErasureIdentity(request(), config)).toEqual({ kind: 'unavailable' });
  expect(
    await authorErasureIdentity(
      new Request('https://site.test/', { headers: { authorization: 'Bearer invented-actor' } }),
      config,
    ),
  ).toEqual({ kind: 'signed-out' });
});

test('operation UI shows native counters without totals, keeps terminal denial distinct and drops inaccessible progress', () => {
  const render = (value: Parameters<typeof AuthorErasureOperationPage>[0]['initial']) =>
    renderToStaticMarkup(createElement(AuthorErasureOperationPage, { initial: value, read: async () => value }));
  const running = render({ kind: 'available', operation: operation(8) });
  expect(running).toContain(m.author_erasure_running());
  expect(running).toContain(m.author_erasure_processed());
  expect(running).not.toContain('progressbar');
  expect(running).not.toContain('%');
  const failed = render({
    kind: 'available',
    operation: parseErasureOperation({
      ...operation(8),
      done: true,
      error: { code: 7, message: 'private SQL', details: ['secret'] },
    })!,
  });
  expect(failed).toContain(m.author_erasure_terminal_permission());
  expect(failed).not.toContain(m.author_erasure_success());
  expect(failed).not.toContain('private SQL');
  expect(failed).not.toContain('secret');
  const completed = render({
    kind: 'available',
    operation: { ...operation(8), done: true, response: { processedPosts: 8, erasedRevisions: 16 } },
  });
  expect(completed).toContain(m.author_erasure_completed());
  expect(completed).toContain(m.author_erasure_success());
  for (const kind of ['forbidden', 'not-found', 'unavailable'] as const) {
    const html = render({ kind });
    expect(html).not.toContain(m.author_erasure_processed());
    expect(html).not.toContain(m.author_erasure_success());
    expect(html).toContain(m.author_erasure_check_again());
  }
});

test('current admission consumes only the same generated thread read and exact native acting-author field', async () => {
  let payload: unknown = { thread: { id: threadId }, authorErasure: { authorId, mayErase: true } };
  let status = 200;
  let reads = 0;
  const client = createKernelClient('https://kernel.test', {
    fetch: async (input, init) => {
      const request = new Request(input, init);
      expect(request.method).toBe('GET');
      expect(new URL(request.url).pathname).toBe(`/v1/threads/${threadId}`);
      expect(request.headers.get('authorization')).toBe(identity.authorization);
      expect(request.headers.get('cache-control')).toBe('no-store');
      reads++;
      return Response.json(payload, { status });
    },
  });
  expect(await currentAuthorErasureAdmission(client, identity, threadId)).toEqual({
    kind: 'current',
    authorId,
    mayErase: true,
  });
  payload = { thread: { id: threadId }, authorErasure: { authorId, mayErase: false } };
  expect(await currentAuthorErasureAdmission(client, identity, threadId)).toEqual({
    kind: 'current',
    authorId,
    mayErase: false,
  });
  for (const value of [
    { thread: { id: threadId, authorId, mayEdit: true, mayDelete: true } },
    { thread: { id: operationId }, authorErasure: { authorId, mayErase: true } },
    { thread: { id: threadId }, authorErasure: { authorId: operationId, mayErase: true } },
    { thread: { id: threadId }, authorErasure: { authorId, mayErase: 1 } },
    { thread: { id: threadId }, authorErasure: { authorId, mayErase: true, postId: operationId } },
  ]) {
    payload = value;
    expect(await currentAuthorErasureAdmission(client, identity, threadId)).toEqual({ kind: 'unavailable' });
  }
  for (const [nativeStatus, kind] of [
    [401, 'signed-out'],
    [403, 'forbidden'],
    [404, 'not-found'],
    [503, 'unavailable'],
  ] as const) {
    status = nativeStatus;
    expect(await currentAuthorErasureAdmission(client, identity, threadId)).toEqual({ kind });
  }
  expect(reads).toBe(11);
});

test('explicit admission refresh clears previous authority and discards late closed, account and thread results', async () => {
  const reads = authorErasureAdmissionReads();
  const current = { kind: 'current' as const, authorId, mayErase: true };
  const value = () => reads.bind(threadId, authorId, true);
  expect(value()).toEqual({ kind: 'unavailable' });
  await reads.refresh(authorId, async () => current);
  expect(value()).toEqual(current);
  for (const stale of [
    () => reads.bind(threadId, authorId, false),
    () => reads.bind(operationId, authorId, true),
    () => reads.bind(threadId, operationId, true),
    () => reads.bind(threadId, null, true),
  ]) {
    let resolve!: (value: typeof current) => void;
    const refresh = reads.refresh(
      authorId,
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    expect(value()).toEqual({ kind: 'unavailable' });
    stale();
    resolve(current);
    expect(await refresh).toBe(false);
    expect(value()).toEqual({ kind: 'unavailable' });
  }
  await reads.refresh(authorId, async () => current);
  await reads.refresh(authorId, async () => ({ ...current, authorId: operationId }));
  expect(value()).toEqual({ kind: 'unavailable' });
  await reads.refresh(authorId, async () => ({ ...current, mayErase: false }));
  expect(value()).toEqual({ ...current, mayErase: false });
  let resolve!: (value: typeof current) => void;
  const late = reads.refresh(
    authorId,
    () =>
      new Promise((done) => {
        resolve = done;
      }),
  );
  await reads.refresh(authorId, async () => ({ kind: 'unavailable' }));
  resolve(current);
  expect(await late).toBe(false);
  expect(value()).toEqual({ kind: 'unavailable' });
  // Presentation failure cannot consume or replace the separately held intent.
  const intents: unknown[] = [];
  const retry = authorErasureRequest({ threadId, idempotencyKey: 'uncertain-original' }, async (intent) => {
    intents.push(intent);
    return { kind: 'uncertain' };
  });
  await retry();
  reads.bind(threadId, null, false);
  await reads.refresh(authorId, async () => parseAuthorErasureAdmission({}, threadId, authorId));
  await retry();
  expect(intents).toEqual([
    { threadId, idempotencyKey: 'uncertain-original' },
    { threadId, idempotencyKey: 'uncertain-original' },
  ]);
});
