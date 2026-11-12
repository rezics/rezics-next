import { expect, mock, test } from 'bun:test';
import { createKernelClient } from '@rezics/client';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  hostedCheckpointHref,
  presentHostedCheckpoints,
  readHostedCheckpointPage,
  type HostedCheckpointPage,
  type HostedCheckpointTransport,
} from '../src/library/hosted-checkpoint-source';
import { hostedBookHref } from '../src/books/reader/address';
import { HostedCheckpointBooksView } from '../src/library/hosted-checkpoint-books';
import { m } from '../src/paraglide/messages.js';
import type { SessionEnv } from '../src/session/client';
import type { SessionStore } from '../src/session/store';

mock.module('cloudflare:workers', () => ({ env: {} }));
const { loadHostedCheckpointState } = await import('../src/library/hosted-checkpoint-read');
const id = (n: number) => `0192f3a0-6c1e-7b2a-9d4e-${String(n).padStart(12, '0')}`;
const row = (n: number): HostedCheckpointPage['items'][number] => ({
  subjectId: id(n),
  revision: '2',
  activityAt: '2026-11-12T10:00:00.123456Z',
  address: {
    catalogueId: id(100 + n),
    publicationRevisionId: id(200 + n),
    occurrenceId: id(300 + n),
    targetRevisionId: id(400 + n),
    targetSha256: 'a'.repeat(64),
    documentPosition: null,
  },
  metadata: {
    availability: 'available',
    occurrenceId: id(300 + n),
    parentId: null,
    position: n,
    kind: 'chapter',
    title: `Saved chapter ${n}`,
    target: { threadId: id(500 + n), postId: id(600 + n), revisionId: id(400 + n), sha256: 'a'.repeat(64) },
  },
});
const client = createKernelClient('https://kernel.test');
const signal = () => new AbortController().signal;

test('native order, repeated Books, withheld rows and sparse continuation survive one-page receiving', () => {
  const hidden = { ...row(2), metadata: { availability: 'unavailable', occurrenceId: id(302), kind: 'unknown' } };
  const result = presentHostedCheckpoints({ items: [row(3), hidden, row(1), row(3)], nextCursor: 'opaque+/next==' });
  expect(result.state).toBe('loaded');
  if (result.state !== 'loaded') throw new Error('expected native page');
  expect(result.items.map((item) => item.subjectId)).toEqual([id(3), id(2), id(1), id(3)]);
  expect(result.items[1]).toEqual({ availability: 'unavailable', subjectId: id(2), revision: '2' });
  expect(result.nextCursor).toBe('opaque+/next==');
  expect(presentHostedCheckpoints({ items: [], nextCursor: 'sparse-next' })).toEqual({
    state: 'loaded',
    items: [],
    nextCursor: 'sparse-next',
  });
});

test('exact resume retains the saved publication, occurrence, catalogue, Subject and locale', () => {
  const result = presentHostedCheckpoints({ items: [row(1)], nextCursor: null });
  if (result.state !== 'loaded' || result.items[0]?.availability !== 'available')
    throw new Error('expected available chapter');
  const url = new URL(hostedCheckpointHref(result.items[0], 'zh-Hant', hostedBookHref), 'https://site.test');
  expect(url.pathname).toBe(`/zh-Hant/books/${id(101)}/read`);
  expect([...url.searchParams]).toEqual([
    ['subject', id(1)],
    ['release', id(201)],
    ['occurrence', id(301)],
    ['view', 'chapter'],
  ]);
});

test('external response defects cannot disclose a title for a different exact target or masquerade as empty', () => {
  const available = row(1);
  if (available.metadata.availability !== 'available') throw new Error('fixture');
  for (const value of [
    {},
    { items: [], nextCursor: '' },
    { items: [], nextCursor: 'x'.repeat(4097) },
    { items: Array.from({ length: 21 }, () => available), nextCursor: null },
    { items: [{ ...available, metadata: { ...available.metadata, occurrenceId: id(999) } }], nextCursor: null },
    {
      items: [
        {
          ...available,
          metadata: { ...available.metadata, target: { ...available.metadata.target, revisionId: id(999) } },
        },
      ],
      nextCursor: null,
    },
    {
      items: [
        {
          ...available,
          metadata: { availability: 'unavailable', occurrenceId: id(301), kind: 'unknown', title: 'Withheld title' },
        },
      ],
      nextCursor: null,
    },
  ])
    expect(presentHostedCheckpoints(value)).toEqual({ state: 'unavailable' });
});

test('one bounded native read forwards the opaque cursor and private transport policy unchanged', async () => {
  let reads = 0;
  const transport: HostedCheckpointTransport = async (received, options) => {
    reads++;
    expect(received).toBe(client);
    expect(options).toEqual({
      query: { limit: 20, cursor: 'opaque+/cursor==' },
      headers: { authorization: 'Bearer owner' },
      fetch: { signal: currentSignal, cache: 'no-store', redirect: 'manual' },
    });
    return { status: 200, error: null, data: { items: [row(1)], nextCursor: null } };
  };
  const currentSignal = signal();
  expect(
    (await readHostedCheckpointPage(client, 'Bearer owner', { cursor: 'opaque+/cursor==' }, currentSignal, transport))
      .state,
  ).toBe('loaded');
  expect(reads).toBe(1);
  expect(await readHostedCheckpointPage(client, 'Bearer owner', {}, signal())).toEqual({
    state: 'unavailable',
    reason: 'client-pending',
  });
});

test('successful empty, sign-out, denied, stale and unavailable responses remain distinct', async () => {
  for (const [status, state] of [
    [200, 'loaded'],
    [401, 'signed-out'],
    [403, 'denied'],
    [400, 'stale'],
    [409, 'stale'],
    [503, 'unavailable'],
  ] as const) {
    const result = await readHostedCheckpointPage(client, 'Bearer owner', {}, signal(), async () => ({
      status,
      error: null,
      data: { items: [], nextCursor: null },
    }));
    expect(result.state).toBe(state);
  }
  await expect(
    readHostedCheckpointPage(client, 'Bearer owner', {}, signal(), async () => {
      throw new Error('unexpected defect');
    }),
  ).rejects.toThrow('unexpected defect');
});

test('prepared viewer mismatch and sign-out stop before connecting; admitted reads use the fresh credential', async () => {
  const stub = {
    credentialIfFresh: async () => ({
      status: 'active',
      subject: id(1),
      accessToken: 'fresh-token',
      csrfToken: 'test-csrf',
    }),
  };
  const env = {
    AUTH_ISSUER: 'https://auth.test',
    API_RESOURCE: 'https://kernel.test',
    WEBSITE_SCOPES: 'openid',
    WEBSITE_CLIENT_ID: 'web',
    WEBSITE_CLIENT_KEY: 'test-key',
    SITE_ORIGINS: 'https://site.test',
    SESSIONS: {
      idFromName: (name: string) => name,
      get: () => stub,
    } as unknown as DurableObjectNamespace<SessionStore>,
  } as Partial<SessionEnv>;
  const request = () =>
    new Request('https://site.test/en/library/continue', {
      headers: { cookie: `__Host-rezics_session=${'c'.repeat(43)}` },
    });
  let connections = 0;
  const connect = (authorization: string) => {
    connections++;
    expect(authorization).toBe('Bearer fresh-token');
    return client;
  };
  expect(
    await loadHostedCheckpointState(new Request('https://site.test'), env, { viewer: id(1), locale: 'en' }, connect),
  ).toEqual({ state: 'signed-out' });
  expect(await loadHostedCheckpointState(request(), env, { viewer: id(2), locale: 'en' }, connect)).toEqual({
    state: 'denied',
  });
  expect(connections).toBe(0);
  expect(
    await loadHostedCheckpointState(request(), env, { viewer: id(1), locale: 'en' }, connect, async () => ({
      status: 200,
      error: null,
      data: { items: [], nextCursor: null },
    })),
  ).toEqual({ state: 'loaded', items: [], nextCursor: null });
  expect(connections).toBe(1);
});

test('compact presentation lists disclosed chapter titles and keeps withheld targets without open actions', () => {
  const result = presentHostedCheckpoints({
    items: [{ ...row(2), metadata: { availability: 'unavailable', occurrenceId: id(302), kind: 'unknown' } }],
    nextCursor: null,
  });
  const html = renderToStaticMarkup(
    <HostedCheckpointBooksView
      locale="en"
      bookHref={hostedBookHref}
      snapshot={{ result, busy: false, cursor: null, previous: false, first: false }}
    />,
  );
  expect(html).toContain(m.book_reader_checkpoint_withheld({}, { locale: 'en' }));
  expect(html).not.toContain('<a ');
  expect(html).not.toContain(id(102));
  const available = presentHostedCheckpoints({ items: [row(1)], nextCursor: null });
  const visible = renderToStaticMarkup(
    <HostedCheckpointBooksView
      locale="en"
      bookHref={hostedBookHref}
      snapshot={{ result: available, busy: false, cursor: null, previous: false, first: false }}
    />,
  );
  expect(visible).toContain('Saved chapter 1');
  expect(visible).toContain(`release=${id(201)}`);
  expect(visible).toContain(`occurrence=${id(301)}`);
  for (const state of ['loading', 'signed-out', 'denied', 'stale', 'unavailable'] as const) {
    const failure = renderToStaticMarkup(
      <HostedCheckpointBooksView
        locale="en"
        bookHref={hostedBookHref}
        snapshot={{ result: { state }, busy: state === 'loading', cursor: null, previous: false, first: false }}
      />,
    );
    expect(failure).not.toContain('Saved chapter 1');
    expect(failure).not.toContain(m.library_hosted_empty({}, { locale: 'en' }));
    expect(failure).not.toContain('<a ');
  }
});
