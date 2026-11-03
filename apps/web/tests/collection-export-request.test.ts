import { expect, mock, test } from 'bun:test';
import { createKernelClient } from '@rezics/client';
import { loadEditableCollectionPage } from '../src/library/collection-load';
import type { SessionEnv } from '../src/session/client';
import {
  captureCollectionExport,
  CollectionExportAttempt,
  finishCollectionExport,
  validateCollectionExportCapture,
} from '../src/library/collection-export-request';

mock.module('cloudflare:workers', () => ({ env: { PUBLIC_ORIGIN: 'https://rezics.com' } }));
const { loadCollectionExport } = await import('../src/library/collection-export-read');
const context = { origin: 'https://rezics.com', locale: 'en' } as const;
const request = new Request('https://rezics.com/collections/list');
const members = ['one', 'two'].map((id) => ({
  id,
  note: `Note ${id}`,
  addedAt: '',
  subject: { id: 'same-subject', label: 'Book', type: 'schema:Book' },
}));
function native() {
  const calls: URL[] = [];
  const state = { denyAt: Infinity, next: null as string | null, revision: 1, members };
  const client = createKernelClient('https://kernel.test', {
    fetch: async (input, init) => {
      const url = new URL(new Request(input, init).url);
      calls.push(url);
      expect(url.searchParams.get('view')).toBe('FULL');
      if (calls.length >= state.denyAt) return Response.json({ code: 'not_found' }, { status: 404 });
      return Response.json(
        url.pathname.endsWith('/members')
          ? { members: state.members, next: state.next }
          : {
              collection: {
                id: 'list',
                membershipKind: 'curated',
                title: 'List',
                description: null,
                visibility: 'public',
                curatorAccountId: 'curator',
                curator: null,
                revision: state.revision,
                memberCount: members.length,
                createdAt: '',
                updatedAt: '',
              },
            },
      );
    },
  });
  const page = () => loadEditableCollectionPage(client, request, {}, { id: 'list' }, 'anonymous');
  return { client, state, calls, page };
}

test('native completion revalidates FULL reads and retains occurrence notes, duplicates and order', async () => {
  const source = native();
  const capture = captureCollectionExport(await source.page())!;
  const result = await loadCollectionExport(source.client, request, {}, capture, context);
  expect(result.state).toBe('complete');
  if (result.state !== 'complete') throw new Error('Expected complete export');
  const file = JSON.parse(result.file.text);
  expect(
    file.itemListElement.map((item: { identifier: string; description: string }) => [
      item.identifier,
      item.description,
    ]),
  ).toEqual([
    ['one', 'Note one'],
    ['two', 'Note two'],
  ]);
  expect(file.itemListElement[0].url).toBe(file.itemListElement[1].url);
  expect(source.calls).toHaveLength(6); // displayed read, capture read, terminal read; each header + members
  expect(
    source.calls
      .filter((url) => url.pathname.endsWith('/members'))
      .every((url) => url.searchParams.get('limit') === '100'),
  ).toBe(true);
});

test('terminal native denial, changed population and revision never deliver a file; larger reads refuse', async () => {
  const source = native();
  const capture = captureCollectionExport(await source.page())!;
  source.state.denyAt = 5;
  expect(await loadCollectionExport(source.client, request, {}, capture, context)).toEqual({ state: 'unavailable' });
  source.state.denyAt = Infinity;
  source.state.members = [...members].reverse();
  expect(await loadCollectionExport(source.client, request, {}, capture, context)).toEqual({ state: 'changed' });
  source.state.members = members;
  source.state.revision++;
  expect(await loadCollectionExport(source.client, request, {}, capture, context)).toEqual({ state: 'changed' });
  source.state.next = 'later';
  expect(captureCollectionExport(await source.page())).toBeNull();
});

test('cancelled deliveries cannot finish and retry keeps its detached capture after source mutation', async () => {
  const source = native();
  const capture = captureCollectionExport(await source.page())!;
  const attempt = new CollectionExportAttempt(capture);
  let settle!: (value: Awaited<ReturnType<typeof finishCollectionExport>>) => void;
  const pending = attempt.run(
    async () =>
      new Promise((resolve) => {
        settle = resolve;
      }),
  );
  attempt.cancel();
  settle({ state: 'complete', file: { filename: 'old', mediaType: 'application/ld+json', text: 'old' } });
  expect(await pending).toEqual({ state: 'cancelled' });
  capture.provenance.viewerId = 'replaced';
  const seen: unknown[] = [];
  expect(
    await attempt.run(async (retained) => {
      seen.push(retained);
      throw new Error('transport');
    }),
  ).toEqual({ state: 'unavailable' });
  await attempt.run(async (retained) => {
    seen.push(retained);
    return { state: 'unavailable' };
  });
  expect(seen[0]).toEqual(seen[1]);
  expect((seen[0] as typeof capture).provenance.viewerId).toBeNull();
});

test('curated filters and invalid captures refuse instead of falling back to an unfiltered population', async () => {
  const source = native();
  const page = await source.page();
  const capture = captureCollectionExport(page)!;
  expect(captureCollectionExport({ ...page, filter: { and: [] } })).toBeNull();
  expect(() => validateCollectionExportCapture({ ...capture, filter: { and: [] } })).toThrow();
  expect(() =>
    validateCollectionExportCapture({ ...capture, population: [capture.population[0], capture.population[0]] }),
  ).toThrow();
  expect(captureCollectionExport({ ...page, provenance: undefined })).toBeNull();
});

test('native logical zero exports empty without writes and refuses stale or invented identities', async () => {
  const source = native();
  const curated = await source.page();
  expect(captureCollectionExport({ ...curated, revision: 0 })).toBeNull();
  expect(() => validateCollectionExportCapture({ ...captureCollectionExport(curated), revision: 0 })).toThrow();
  const collection = {
    id: 'logical-everything', curatorAccountId: 'owner', membershipKind: 'dynamic',
    builtinKind: 'everything', builtin: { kind: 'everything' }, revision: 0,
    title: null, description: null, visibility: 'private',
  };
  let status = 200;
  const client = createKernelClient('https://kernel.test', { fetch: async (input, init) => {
    const req = new Request(input, init);
    expect(req.headers.get('authorization')).toBe('Bearer owner-token');
    const path = new URL(req.url).pathname;
    if (path === '/v1/viewerActions') return Response.json({ resources: [] });
    expect(req.method).toBe('GET');
    if (path.endsWith('/members')) return Response.json(status === 200 ? { members: [], next: null } : {}, { status });
    if (path.includes('/follows/')) return Response.json({ follow: { state: 'unfollowed' } });
    return Response.json({ collection });
  } });
  const env = {
    AUTH_ISSUER: 'https://auth.test', API_RESOURCE: 'https://kernel.test', WEBSITE_SCOPES: 'openid',
    WEBSITE_CLIENT_ID: 'web', WEBSITE_CLIENT_KEY: 'unused',
    SESSIONS: { idFromName: (id: string) => id, get: () => ({ credential: async () => ({
      status: 'active', subject: 'owner', accessToken: 'owner-token', csrfToken: null,
    }) }) },
  } as unknown as SessionEnv;
  const request = new Request('https://rezics.com/collections/logical-everything', {
    headers: { cookie: `__Host-rezics_session=${'a'.repeat(43)}` },
  });
  const page = await loadEditableCollectionPage(client, request, env, { id: collection.id });
  const capture = captureCollectionExport(page);
  expect(capture).not.toBeNull();
  if (!capture) throw new Error('Expected logical export capture');
  expect(validateCollectionExportCapture(capture)).toEqual(capture);
  const result = await loadCollectionExport(client, request, env, capture, context);
  expect(result.state).toBe('complete');
  if (result.state !== 'complete') throw new Error('Expected empty export');
  expect(JSON.parse(result.file.text)).toMatchObject({ numberOfItems: 0, itemListElement: [] });
  const members = ['second', 'first'].map((id) => ({
    id: 'invented-occurrence', note: 'Invented note', subject: {
      id, label: id, type: 'schema:Book', types: ['schema:Book'], cover: null,
    },
  }));
  const populated = { ...page, members };
  const unique = captureCollectionExport(populated)!;
  const exported = await finishCollectionExport(unique, context, async () => populated);
  if (exported.state !== 'complete') throw new Error('Expected subject export');
  const items = JSON.parse(exported.file.text).itemListElement;
  expect(items.map((item: { url: string }) => item.url)).toEqual([
    'https://rezics.com/en/subjects/second/book-second', 'https://rezics.com/en/subjects/first/book-first',
  ]);
  expect(items.every((item: object) => !('identifier' in item) && !('description' in item))).toBe(true);
  expect(captureCollectionExport({ ...populated, members: [members[0]!, members[0]!] })).toBeNull();
  expect(captureCollectionExport({ ...page, provenance: { ...page.provenance!, viewerId: 'foreign' } })).toBeNull();
  expect(captureCollectionExport({ ...page, provenance: { ...page.provenance!, logicalBuiltin: undefined } })).toBeNull();
  collection.revision = 1;
  expect(await loadCollectionExport(client, request, env, capture, context)).toEqual({ state: 'changed' });
  status = 503;
  expect(await loadCollectionExport(client, request, env, capture, context)).toEqual({ state: 'changed' });
});
