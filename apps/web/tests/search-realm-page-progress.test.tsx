import { expect, test } from 'bun:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  RealmDiscoverySection,
  type RealmDiscoveryCard,
  type RealmDiscoveryState,
} from '../src/community/realm-discovery';
import { createSearchRealmDiscoveryPage } from '../src/search/realm-discovery-section';
import {
  advanceRealmPageProgress,
  createRealmPageProgress,
  initialRealmPageProgress,
  REALM_DISCOVERY_CURSOR_MAX_LENGTH,
} from '../src/search/realm-page-progress';
import type { SearchRealmDiscoveryRequest } from '../src/search/realm-discovery-section';
import type { RealmDiscoveryWindow } from '../src/search/realm-discovery-loader';
import { m } from '../src/paraglide/messages.js';

type Page = Exclude<RealmDiscoveryState, { kind: 'loading' }>;
const cursor = 'signed +/= continuation';
const card = (name: string): RealmDiscoveryCard => ({
  realmId: name,
  spaceId: `${name}-space`,
  name,
  description: '',
  avatar: null,
});
const ready = (name: string, next: string | null): Page => ({ kind: 'ready', realms: [card(name)], next });
const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => (resolve = done));
  return { promise, resolve };
};

test('Realm continuation progress is constant-space and rejects repeats and invalid cursors', () => {
  let progress = advanceRealmPageProgress(initialRealmPageProgress(), undefined, 'a')!;
  progress = advanceRealmPageProgress(progress, 'a', 'b')!;
  progress = advanceRealmPageProgress(progress, 'b', 'a')!;
  expect(advanceRealmPageProgress(progress, 'a', 'b')).toBeNull();
  expect(advanceRealmPageProgress(initialRealmPageProgress(), undefined, '')).toBeNull();
  expect(
    advanceRealmPageProgress(initialRealmPageProgress(), undefined, 'x'.repeat(REALM_DISCOVERY_CURSOR_MAX_LENGTH + 1)),
  ).toBeNull();
});

test('More replaces the visible page, preserves it while pending or failed, and retries the exact cursor', async () => {
  const calls: SearchRealmDiscoveryRequest[] = [];
  const failure = deferred<Page>();
  const snapshots: { state: RealmDiscoveryState; pending: boolean; retry: boolean; restart: boolean }[] = [];
  const page = createSearchRealmDiscoveryPage(
    async (request) => {
      calls.push(request);
      if (calls.length === 1)
        return {
          kind: 'ready',
          realms: Array.from({ length: 24 }, (_, index) => card(`first-${index}`)),
          next: cursor,
        };
      if (calls.length === 2) return failure.promise;
      return ready('second-page', 'next-page');
    },
    'en',
    (state, progress) => snapshots.push({ state, ...progress }),
  );

  await page.start();
  expect(calls).toHaveLength(1);
  expect(snapshots.at(-1)?.state).toMatchObject({ kind: 'ready', realms: expect.any(Array) });
  if (snapshots.at(-1)?.state.kind !== 'ready') throw new Error('Expected the first page');
  expect(snapshots.at(-1)?.state.realms).toHaveLength(20);

  const next = page.next();
  expect(calls).toHaveLength(2);
  expect(snapshots.at(-1)).toMatchObject({ state: { kind: 'ready', realms: expect.any(Array) }, pending: true });
  failure.resolve({ kind: 'unavailable' });
  await next;
  expect(snapshots.at(-1)).toMatchObject({ state: { kind: 'ready' }, pending: false, retry: true, restart: false });
  if (snapshots.at(-1)?.state.kind !== 'ready') throw new Error('Expected the accepted page to remain visible');
  expect(snapshots.at(-1)?.state.realms).toHaveLength(20);

  await page.retry();
  expect(calls[2]).toMatchObject({ locale: 'en', sort: 'trending', cursor, limit: 20 });
  expect(snapshots.at(-1)?.state).toEqual(ready('second-page', 'next-page'));
  page.dispose();
});

test('a repeated cycle offers a visible restart and issues one fresh first-page request', async () => {
  const calls: SearchRealmDiscoveryRequest[] = [];
  const snapshots: { state: RealmDiscoveryState; pending: boolean; retry: boolean; restart: boolean }[] = [];
  const page = createSearchRealmDiscoveryPage(
    async (request) => {
      calls.push(request);
      if (request.cursor === undefined)
        return ready(calls.length === 1 ? 'first-page' : 'restarted', calls.length === 1 ? 'a' : 'c');
      if (request.cursor === 'a') return ready('page-a', 'b');
      return ready('page-b', 'a');
    },
    'en',
    (state, progress) => snapshots.push({ state, ...progress }),
  );

  await page.start();
  await page.next();
  await page.next();
  await page.next();
  expect(calls.map((request) => request.cursor)).toEqual([undefined, 'a', 'b', 'a']);
  expect(snapshots.at(-1)).toMatchObject({ pending: false, retry: true, restart: true });
  expect(snapshots.at(-1)?.state).toEqual(ready('page-b', 'a'));

  const html = renderToStaticMarkup(
    createElement(RealmDiscoverySection, {
      sort: 'trending',
      state: snapshots.at(-1)!.state,
      locale: 'en',
      retry: true,
      restart: true,
      onRetry() {},
    }),
  );
  expect(html).toContain(m.discovery_restart_action({}, { locale: 'en' }));
  await page.retry();
  expect(calls.at(-1)?.cursor).toBeUndefined();
  expect(snapshots.at(-1)?.state).toEqual(ready('restarted', 'c'));
  expect(snapshots.at(-1)?.restart).toBe(false);
  page.dispose();
});

test('unseeded Search and header controllers issue one first-page request, ignore a second start, and retry the same first cursor', async () => {
  const searchReads: Array<string | undefined> = [];
  const searchWindows: RealmDiscoveryWindow[] = [];
  const searchPage = deferred<Page>();
  const search = createRealmPageProgress({
    read: async ({ cursor }) => {
      searchReads.push(cursor);
      return searchPage.promise;
    },
    publish: (window) => searchWindows.push(window),
  });
  expect(search.snapshot()).toMatchObject({ state: { kind: 'loading' }, pending: true });
  const searchStarted = search.start();
  search.start();
  expect(searchReads).toEqual([undefined]);
  expect(searchWindows.at(-1)).toMatchObject({ state: { kind: 'loading' }, pending: true });
  searchPage.resolve(ready('search-first', cursor));
  await searchStarted;
  expect(searchWindows.at(-1)?.state).toEqual(ready('search-first', cursor));
  search.dispose();

  const headerReads: SearchRealmDiscoveryRequest[] = [];
  const headerWindows: { state: RealmDiscoveryState; pending: boolean; retry: boolean }[] = [];
  const headerFailure = deferred<Page>();
  const header = createSearchRealmDiscoveryPage(
    async (request) => {
      headerReads.push(request);
      return headerReads.length === 1 ? headerFailure.promise : ready('header-retry', null);
    },
    'en',
    (state, progress) => headerWindows.push({ state, ...progress }),
  );
  const headerStarted = header.start();
  header.start();
  expect(headerReads).toEqual([{ locale: 'en', sort: 'trending', limit: 20 }]);
  headerFailure.resolve({ kind: 'unavailable' });
  await headerStarted;
  expect(headerWindows.at(-1)).toMatchObject({ state: { kind: 'unavailable' }, pending: false, retry: true });
  await header.retry();
  expect(headerReads[1]).toEqual({ locale: 'en', sort: 'trending', limit: 20 });
  expect(headerWindows.at(-1)?.state).toEqual(ready('header-retry', null));
  header.dispose();
});

test('dispose suppresses an unseeded first read or a late first-page publication, and a seeded window does not reread', async () => {
  let abandoned = 0;
  const beforeStart = createRealmPageProgress({
    read: async () => {
      abandoned += 1;
      return ready('abandoned', null);
    },
    publish: () => {
      abandoned += 1;
    },
  });
  beforeStart.dispose();
  await beforeStart.start();
  expect(abandoned).toBe(0);

  const late = deferred<Page>();
  const lateWindows: RealmDiscoveryWindow[] = [];
  const inFlight = createRealmPageProgress({
    read: async () => late.promise,
    publish: (window) => lateWindows.push(window),
  });
  const pending = inFlight.start();
  inFlight.dispose();
  late.resolve(ready('late', cursor));
  await pending;
  expect(lateWindows).toEqual([{ state: { kind: 'loading' }, pending: true, retry: false, restart: false }]);

  const seededReads: Array<string | undefined> = [];
  const seeded = createRealmPageProgress({
    initial: ready('seeded', cursor),
    read: async ({ cursor: next }) => {
      seededReads.push(next);
      return ready('more', null);
    },
    publish: () => {},
  });
  await seeded.start();
  expect(seededReads).toEqual([]);
  expect(seeded.snapshot().state).toEqual(ready('seeded', cursor));
  await seeded.next();
  expect(seededReads).toEqual([cursor]);
  seeded.dispose();
});
