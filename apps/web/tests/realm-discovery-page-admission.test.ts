import { expect, test } from 'bun:test';
import type { RealmDiscoveryCard, RealmDiscoveryState } from '../src/community/realm-discovery';
import { createRealmDiscoveryWindow, type RealmDiscoveryPage } from '../src/search/realm-discovery-loader';
import { createRealmPageProgress } from '../src/search/realm-page-progress';

const id = (value: number) => `01a1a000-0000-7000-8000-${String(value).padStart(12, '0')}`;
const row = (value: number): RealmDiscoveryCard => ({
  realmId: id(value),
  spaceId: id(value + 100),
  name: `Realm ${value}`,
  description: '',
  avatar: null,
});
const ready = (realms: readonly RealmDiscoveryCard[], next: string | null): RealmDiscoveryPage => ({
  kind: 'ready',
  realms,
  next,
});

test('invalid initial data is rejected before its continuation can be retained', async () => {
  const cursors: Array<string | undefined> = [];
  const initial = ready([{ ...row(1), realmId: 'bad-id' }], 'untrusted-cursor');
  const pages = createRealmPageProgress({
    initial,
    read: async ({ cursor }) => {
      cursors.push(cursor);
      return ready([], null);
    },
    publish() {},
  });

  expect(pages.snapshot()).toMatchObject({ state: { kind: 'unavailable' }, retry: true });
  await pages.retry();
  expect(cursors).toEqual([undefined]);
  expect(pages.snapshot().state).toEqual(ready([], null));
  pages.dispose();
});

test('the whole page is validated before its display window is retained', () => {
  const validRows = Array.from({ length: 21 }, (_, index) => row(index + 1));
  const invalidTail = [...validRows.slice(0, 20), { ...row(21), realmId: 'bad-id' }];

  expect(createRealmDiscoveryWindow(ready(validRows, 'next')).state).toEqual({ kind: 'unavailable' });
  expect(createRealmDiscoveryWindow(ready(invalidTail, 'next')).state).toEqual({ kind: 'unavailable' });
});

test('invalid row identity and image ownership fail Content admission', () => {
  const wrongOwner = {
    id: id(300),
    containerId: id(301),
    digest: 'a'.repeat(64),
    width: 160,
    height: 160,
    variants: [{ format: 'webp' as const, width: 160, height: 160 }],
    placeholder: null,
    focalPoint: null,
    credit: null,
  };
  const invalidIdentity = { ...row(1), spaceId: 'bad-id' };
  const invalidImage = { ...row(2), avatar: wrongOwner };

  expect(createRealmDiscoveryWindow(ready([invalidIdentity], null)).state).toEqual({ kind: 'unavailable' });
  expect(createRealmDiscoveryWindow(ready([invalidImage], null)).state).toEqual({ kind: 'unavailable' });
});

test('an invalid continuation preserves the admitted page and explicitly restarts', async () => {
  const accepted = ready([row(1)], 'accepted-cursor');
  const cursors: Array<string | undefined> = [];
  const pages = createRealmPageProgress({
    initial: accepted,
    read: async ({ cursor }) => {
      cursors.push(cursor);
      return cursors.length === 1 ? ready([row(2)], 'x'.repeat(4097)) : ready([], null);
    },
    publish() {},
  });

  await pages.next();
  expect(pages.snapshot()).toMatchObject({ state: accepted, pending: false, retry: true, restart: true });
  await pages.retry();
  expect(cursors).toEqual(['accepted-cursor', undefined]);
  expect(pages.snapshot().state).toEqual(ready([], null));
  pages.dispose();
});

test('sparse and empty pages remain valid and unchanged', () => {
  const sparse = ready([row(1), row(2)], 'next');
  const empty = ready([], null);
  const state: RealmDiscoveryState = sparse;

  expect(createRealmDiscoveryWindow(state).state).toEqual(sparse);
  expect(createRealmDiscoveryWindow(empty).state).toEqual(empty);
});
