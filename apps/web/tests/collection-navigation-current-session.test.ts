import { expect, mock, spyOn, test } from 'bun:test';
import { createKernelClient } from '@rezics/client';
import * as start from '../.storybook/react-start';
import type { SessionEnv } from '../src/session/client';
import { newCsrfToken } from '../src/session/csrf';
import { prepareSession, sessionSubject, viewerCredential } from '../src/session/request';
import { loadMineCollectionsForOwner, loadMineCollectionsPage } from '../src/library/mine-collections';

const origin = 'https://site.test';
const csrfToken = newCsrfToken();
let preparation: 'active' | 'absent' | 'unavailable' = 'active';
let credentialReads = 0;
const responseHeaders = new Headers();
const env = {
  KERNEL_ORIGIN: 'https://kernel.test',
  AUTH_ISSUER: 'https://auth.test',
  API_RESOURCE: 'https://kernel.test',
  WEBSITE_SCOPES: 'openid',
  WEBSITE_CLIENT_ID: 'web',
  WEBSITE_CLIENT_KEY: '{}',
  SITE_ORIGINS: origin,
  SESSIONS: {
    idFromName: (id: string) => id,
    get: () => ({
      credential: async () => {
        credentialReads++;
        return preparation === 'active'
          ? { status: preparation, accessToken: 'current-viewer', subject: 'owner', csrfToken }
          : { status: preparation, csrfToken };
      },
    }),
  },
};
// Only the Durable Object transport is a fixture; preparation and its Request caches are real.
const sessionEnv = env as unknown as Partial<SessionEnv>;
function request(method = 'GET') {
  return new Request(`${origin}/en/library/collections`, {
    method,
    headers: { cookie: `__Host-rezics_session=${'a'.repeat(43)}`, origin, 'x-csrf-token': csrfToken },
  });
}
let currentRequest = request();
mock.module('cloudflare:workers', () => ({ env }));
mock.module('@tanstack/react-start', () => start);
mock.module('@tanstack/react-start/server', () => ({
  getRequest: () => currentRequest,
  setResponseHeader: (name: string, value: string) => responseHeaders.set(name, value),
}));
const { loadLibraryNavigation, readLibraryNavigationPage, readLibraryPins, readLibraryPinsPage } =
  await import('../src/library/pins-read');
const { readMineCollectionsPage } = await import('../src/library/mine-collections-route');
const signedOut = { signedIn: false, collections: [], next: null };
const closedNavigation = { pins: { state: 'closed' }, collections: [], collectionsState: 'loaded' };

// Authored for controller integration; native authority and browser acceptance remain separate obligations.
test('real absent-session refusal closes Collection and personal navigation entrypoints before any cached private read', async () => {
  preparation = 'active';
  currentRequest = request();
  const transport = spyOn(globalThis, 'fetch').mockImplementation(async () => {
    throw new Error('Refused preparation reached private native IO');
  });
  const client = createKernelClient(env.KERNEL_ORIGIN);
  const reads = [
    () => loadMineCollectionsPage(client, currentRequest, sessionEnv, { layout: 'previews' }),
    () => loadLibraryNavigation(client, currentRequest, sessionEnv),
    () => readMineCollectionsPage({ data: { layout: 'previews' } }),
    () => readLibraryNavigationPage({ data: 100 }),
    () => readLibraryPinsPage({ data: 100 }),
  ];
  try {
    expect(await prepareSession(currentRequest, sessionEnv)).toBe(false);
    expect(viewerCredential(currentRequest)).toBe('Bearer current-viewer');
    expect(sessionSubject(currentRequest)).toBe('owner');
    preparation = 'absent';
    expect(await prepareSession(currentRequest, sessionEnv)).toBe(true);
    for (const [index, read] of reads.entries())
      expect(await read()).toEqual(
        [signedOut, closedNavigation, signedOut, closedNavigation, { state: 'closed' }][index],
      );
    expect(viewerCredential(currentRequest)).toBe('Bearer current-viewer');
    expect(sessionSubject(currentRequest)).toBe('owner');
    expect(responseHeaders.get('cache-control')).toBe('private, no-store');

    preparation = 'unavailable';
    for (const read of reads)
      await expect(read()).rejects.toMatchObject({ problem: { status: 502, code: 'dependency_unavailable' } });
    currentRequest = request('POST');
    preparation = 'active';
    expect(await prepareSession(currentRequest, sessionEnv)).toBe(false);
    preparation = 'absent';
    for (const read of reads)
      await expect(read()).rejects.toMatchObject({ problem: { status: 403, code: 'forbidden' } });
    preparation = 'active';
    for (const header of ['origin', 'x-csrf-token']) {
      currentRequest = request('POST');
      currentRequest.headers.set(header, 'invalid');
      for (const read of reads)
        await expect(read()).rejects.toMatchObject({ problem: { status: 403, code: 'forbidden' } });
    }
    expect(transport).not.toHaveBeenCalled();
  } finally {
    transport.mockRestore();
  }
});

test('healthy owner, pins and preview navigation keep bounded current reads, restrictive transport and honest native states', async () => {
  preparation = 'active';
  credentialReads = 0;
  currentRequest = request();
  const calls: Request[] = [];
  const cursor = 'signed/keyset+cursor==&next=private';
  const next = 'signed/next+cursor';
  let stale = false;
  let collectionStatus = 200;
  let pinsStatus = 200;
  let savedQueryCapability: 'available' | 'unavailable' = 'available';
  const collection = {
    id: 'own-private',
    title: 'Owner collection',
    visibility: 'private',
    memberCount: 31,
    curator: { handle: 'owner', displayName: 'Owner' },
    previewStatus: 'ready',
    previewMembers: [1, 2, 3].map((id) => ({
      subjectId: `subject-${id}`,
      subject: {
        id: `subject-${id}`,
        type: 'Book',
        types: ['Book'],
        label: { value: `Book ${id}`, language: 'en' },
        cover: null,
      },
    })),
  };
  let collectionInventory = [
    collection,
    { ...collection, id: 'pending', previewStatus: 'pending' as const, previewMembers: [] },
    { ...collection, id: 'empty', previewMembers: [] },
  ];
  let paths: Record<string, unknown> = {
    '/v1/libraryPins': { get: { operationId: 'library_pin.list' } },
    '/v1/libraryPins/{collectionId}': {
      put: { operationId: 'library_pin.put' },
      delete: { operationId: 'library_pin.delete' },
    },
  };
  const pins = [
    { collectionId: collection.id, target: { id: collection.id, title: collection.title } },
    { collectionId: 'unreadable', target: null },
  ];
  const transport = spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const call = new Request(input, init);
    calls.push(call);
    const url = new URL(call.url);
    if (url.pathname === '/v1/openapi.json') return Response.json({ paths });
    if (url.pathname === '/v1/libraryPins')
      return Response.json(pinsStatus === 202 ? { preparing: true } : { pins, revision: 7, next }, {
        status: pinsStatus,
      });
    if (url.pathname === '/v1/collections') {
      if (stale || url.searchParams.get('cursor') === 'stale')
        return Response.json({ code: 'stale_cursor' }, { status: 409 });
      if (collectionStatus !== 200)
        return Response.json(collectionStatus === 202 ? { preparing: true } : { code: 'forbidden' }, {
          status: collectionStatus,
        });
      return Response.json({
        collections: collectionInventory,
        next,
        savedQueryCapability,
      });
    }
    throw new Error(`Unexpected private read: ${call.method} ${url}`);
  });
  const timeouts = spyOn(AbortSignal, 'timeout');
  const client = createKernelClient(env.KERNEL_ORIGIN);
  const queries = (from: number) => calls.slice(from).map((call) => Object.fromEntries(new URL(call.url).searchParams));
  try {
    const rows = await loadMineCollectionsPage(client, currentRequest, sessionEnv, { layout: 'rows', cursor });
    expect(rows).toMatchObject({ signedIn: true, state: 'loaded', next });
    expect(queries(0)).toEqual([
      { view: 'FULL', limit: '100', curatorAccountId: 'owner', cursor },
      { view: 'FULL', limit: '100', curatorAccountId: 'owner' },
    ]);
    const previewStart = calls.length;
    const previews = await readMineCollectionsPage({ data: { layout: 'previews', cursor } });
    expect(previews.savedQueryCapability).toBe('available');
    expect(queries(previewStart)).toEqual([
      { view: 'FULL', limit: '20', preview: '3', curatorAccountId: 'owner', cursor },
    ]);
    expect(previews.navigationCollections).toEqual(previews.collections);
    expect(previews.collections.map((item) => item.preview)).toEqual([
      {
        state: 'loaded',
        members: collection.previewMembers.map(({ subject }) => ({ ...subject, labelLanguage: 'en' })),
      },
      { state: 'preparing' },
      { state: 'loaded', members: [], emptyConfirmed: true },
    ]);
    collectionInventory = [];
    const emptyInventory = await loadMineCollectionsPage(client, currentRequest, sessionEnv, { layout: 'rows' });
    expect(emptyInventory).toMatchObject({
      state: 'loaded',
      collections: [],
      savedQueryCapability: 'available',
    });
    collectionInventory = [collection];
    let start = calls.length;
    expect(
      await loadMineCollectionsPage(client, currentRequest, sessionEnv, { cursor: 'stale', layout: 'previews' }),
    ).toMatchObject({ state: 'loaded', cursorReset: true, next });
    expect(queries(start)).toEqual([
      { view: 'FULL', limit: '20', preview: '3', curatorAccountId: 'owner', cursor: 'stale' },
      { view: 'FULL', limit: '20', preview: '3', curatorAccountId: 'owner' },
    ]);
    stale = true;
    start = calls.length;
    expect(await loadMineCollectionsPage(client, currentRequest, sessionEnv, { cursor })).toEqual({
      signedIn: true,
      state: 'unavailable',
      cursorReset: true,
      collections: [],
      next: null,
    });
    expect(calls.length - start).toBe(2);
    stale = false;

    const preparations = credentialReads;
    start = calls.length;
    expect(await loadMineCollectionsForOwner(client, 'owner', 'Bearer current-viewer')).toMatchObject({
      signedIn: true,
      next,
    });
    expect(credentialReads).toBe(preparations);
    expect(queries(start)).toEqual([{ view: 'FULL', limit: '100', curatorAccountId: 'owner' }]);
    for (const limit of [8, 100] as const) {
      start = calls.length;
      const navigation =
        limit === 8
          ? await loadLibraryNavigation(client, currentRequest, sessionEnv)
          : await readLibraryNavigationPage({ data: limit });
      expect(navigation).toMatchObject({
        collectionsState: 'loaded',
        pins: { state: 'loaded', pins, revision: 7, next, canUpdate: true, canRemove: true },
      });
      expect(
        calls
          .slice(start)
          .map((call) => new URL(call.url).pathname)
          .sort(),
      ).toEqual(['/v1/collections', '/v1/libraryPins', '/v1/openapi.json']);
      expect(queries(start)).toContainEqual({ limit: String(limit) });
      expect(queries(start)).toContainEqual({ view: 'FULL', limit: '100', curatorAccountId: 'owner' });
    }
    expect(credentialReads).toBe(preparations + 2);
    for (const [status, state] of [
      [202, 'preparing'],
      [403, 'denied'],
      [503, 'unavailable'],
    ] as const) {
      collectionStatus = status;
      expect(await loadMineCollectionsPage(client, currentRequest, sessionEnv, {})).toEqual({
        signedIn: true,
        state,
        collections: [],
        next: null,
      });
    }
    expect(calls.every((call) => call.headers.get('authorization') === 'Bearer current-viewer')).toBe(true);

    // Pins permit an explicit Authorization without a cookie or cached subject; owner-filtered reads do not.
    currentRequest = new Request(`${origin}/en/library/collections`, { headers: { authorization: 'Bearer explicit' } });
    start = calls.length;
    expect(await loadMineCollectionsPage(client, currentRequest, {}, {})).toEqual(signedOut);
    expect(await loadLibraryNavigation(client, currentRequest, {})).toEqual(closedNavigation);
    expect(calls).toHaveLength(start);
    pinsStatus = 202;
    expect(await readLibraryPinsPage({ data: 8 })).toEqual({ state: 'preparing' });
    expect(queries(start)).toEqual([{}, { limit: '8' }]);
    expect(calls.slice(start).every((call) => call.headers.get('authorization') === 'Bearer explicit')).toBe(true);
    expect(credentialReads).toBe(preparations + 5);
    pinsStatus = 403;
    expect(await readLibraryPins(client, 'Bearer authenticated', 100)).toEqual({ state: 'unavailable' });
    pinsStatus = 200;
    paths = {
      '/v1/libraryPins': { get: { operationId: 'library_pin.list' }, post: { operationId: 'library_pin.put' } },
      '/v1/libraryPins/{collectionId}': {
        put: { operationId: 'collection.update' },
        delete: { operationId: 'library_pin.put' },
      },
    };
    expect(await readLibraryPins(client, 'Bearer authenticated', 100)).toEqual({
      state: 'loaded',
      pins,
      revision: 7,
      next,
      canUpdate: false,
      canRemove: false,
    });
    paths = { '/v1/libraryPins': { post: { operationId: 'library_pin.list' } } };
    start = calls.length;
    expect(await readLibraryPins(client, 'Bearer authenticated', 8)).toEqual({ state: 'closed' });
    expect(queries(start)).toEqual([{}]);
    expect(
      calls.every((call) => call.method === 'GET' && call.cache === 'no-store' && call.redirect === 'manual'),
    ).toBe(true);
    expect(timeouts.mock.calls).toHaveLength(calls.length);
    expect(timeouts.mock.calls.every(([milliseconds]) => milliseconds === 2_000)).toBe(true);
    expect(responseHeaders.get('cache-control')).toBe('private, no-store');
  } finally {
    timeouts.mockRestore();
    transport.mockRestore();
  }
});
