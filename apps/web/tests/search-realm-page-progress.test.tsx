import { expect, test } from 'bun:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { RealmDiscoverySection, type RealmDiscoveryCard, type RealmDiscoveryState } from '../src/community/realm-discovery';
import { createSearchRealmDiscoveryPage } from '../src/search/realm-discovery-section';
import {
  advanceRealmPageProgress,
  initialRealmPageProgress,
  REALM_DISCOVERY_CURSOR_MAX_LENGTH,
} from '../src/search/realm-page-progress';
import type { SearchRealmDiscoveryRequest } from '../src/search/realm-discovery-section';
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
        return { kind: 'ready', realms: Array.from({ length: 24 }, (_, index) => card(`first-${index}`)), next: cursor };
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
      if (request.cursor === undefined) return ready(calls.length === 1 ? 'first-page' : 'restarted', calls.length === 1 ? 'a' : 'c');
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
