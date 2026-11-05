import { expect, test } from 'bun:test';
import { Compile } from 'typebox/compile';
import { SitemapBoardItemSchema } from '../../src/content/schemas.ts';
import { SitemapRealmPageSchema, SitemapSpacePageSchema } from '../../src/community/schemas.ts';
import { newId } from '../../src/route/route.ts';
import type { KernelClient } from '@rezics/client';

type DeliveredRealmItem = NonNullable<
  Awaited<ReturnType<KernelClient['sitemap']['realms']['get']>>['data']
>['items'][number];

const realmId = newId(0x4321);
const spaceId = newId(0x4321);
const lastModified = '2026-10-01T00:00:00.000Z';
const realmPage = Compile(SitemapRealmPageSchema());
const spacePage = Compile(SitemapSpacePageSchema());

test('Community owns closed canonical Realm destinations without widening ordinary board items', () => {
  const native = { id: realmId, lastModified };
  const addressed = { kind: 'space', spaceId, address: 'public-home' };
  const fallback = { kind: 'realm', realmId };
  for (const canonicalDestination of [addressed, fallback]) {
    expect(realmPage.Check({ items: [{ ...native, canonicalDestination }], next: null })).toBe(true);
    expect(Compile(SitemapBoardItemSchema).Check({ ...native, canonicalDestination })).toBe(false);
  }
  const delivered: DeliveredRealmItem = {
    ...native,
    canonicalDestination: { kind: 'space', spaceId, address: 'public-home' },
  };
  expect(realmPage.Check({ items: [delivered], next: null })).toBe(true);
  expect(realmPage.Check({ items: [native], next: null })).toBe(false);
  for (const canonicalDestination of [
    { ...addressed, realmId },
    { ...addressed, absoluteUrl: 'https://example.test/home' },
    { ...fallback, address: 'private-home' },
    { kind: 'space', spaceId },
    { kind: 'board', boardId: realmId },
  ]) {
    expect(realmPage.Check({ items: [{ ...native, canonicalDestination }], next: null })).toBe(false);
  }
  expect(Compile(SitemapBoardItemSchema).Check(native)).toBe(true);
});

test('standalone Space items and both items/next envelopes retain their closed public shape', () => {
  const item = { id: spaceId, address: 'standalone-home', lastModified };
  expect(spacePage.Check({ items: [item], next: null })).toBe(true);
  expect(spacePage.Check({ items: [{ ...item, realmId }], next: null })).toBe(false);
  expect(spacePage.Check({ items: [item], next: null, total: 1 })).toBe(false);
  expect(realmPage.Check({ items: [], next: 'opaque-source-cursor' })).toBe(true);
  expect(spacePage.Check({ items: [], next: 'opaque-source-cursor' })).toBe(true);
});
