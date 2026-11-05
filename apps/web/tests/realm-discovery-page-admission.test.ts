import { expect, test } from 'bun:test';
import type { RealmDiscoveryCard } from '../src/community/realm-discovery';
import { createRealmDiscoveryWindow, type RealmDiscoveryPage } from '../src/search/realm-discovery-loader';
import { createRealmPageProgress } from '../src/search/realm-page-progress';

const id = (n: number) => `01a1a000-0000-7000-8000-${String(n).padStart(12, '0')}`;
const row = (n: number): RealmDiscoveryCard => ({
  realmId: id(n),
  spaceId: id(n + 100),
  name: `Realm ${n}`,
  description: '',
  avatar: null,
});
const ready = (realms: readonly RealmDiscoveryCard[], next: string | null): RealmDiscoveryPage => ({
  kind: 'ready',
  realms,
  next,
});
const reject = (page: RealmDiscoveryPage) => createRealmDiscoveryWindow(page).state;

test('invalid initial rows are not retained and cannot advance their cursor', async () => {
  const cursors: Array<string | undefined> = [];
  const pages = createRealmPageProgress({
    initial: ready([{ ...row(1), realmId: 'bad-id' }], 'untrusted'),
    read: async ({ cursor }) => {
      cursors.push(cursor);
      return ready([], null);
    },
    publish() {},
  });
  expect(pages.snapshot()).toMatchObject({ state: { kind: 'unavailable' }, retry: true });
  await pages.retry();
  expect(cursors).toEqual([undefined]);
  pages.dispose();
});

test('validates every row and rejects a response past Content’s twenty-row bound', () => {
  const rows = Array.from({ length: 21 }, (_, index) => row(index + 1));
  expect(reject(ready(rows, 'next'))).toEqual({ kind: 'unavailable' });
  expect(reject(ready([...rows.slice(0, 20), { ...row(21), realmId: 'bad-id' }], 'next'))).toEqual({
    kind: 'unavailable',
  });
});

test('rejects malformed row identity and image ownership', () => {
  const image = {
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
  expect(reject(ready([{ ...row(1), spaceId: 'bad-id' }], null))).toEqual({ kind: 'unavailable' });
  expect(reject(ready([{ ...row(2), avatar: image }], null))).toEqual({ kind: 'unavailable' });
});

test('a malformed continuation preserves the accepted page and offers a first-page restart', async () => {
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
  pages.dispose();
});

test('valid sparse and empty pages stay unchanged', () => {
  const sparse = ready([row(1), row(2)], 'next');
  const empty = ready([], null);
  expect(createRealmDiscoveryWindow(sparse).state).toEqual(sparse);
  expect(createRealmDiscoveryWindow(empty).state).toEqual(empty);
});
