import { expect, test } from 'bun:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createKernelClient } from '@rezics/client';
import {
  RealmDiscoverySection,
  loadRealmDiscovery,
  type RealmDiscoveryCard,
  type RealmDiscoverySort,
  type RealmDiscoveryState,
} from '../src/community/realm-discovery';
import { withPlatformClosedRecognition } from '../src/kernel/platform-closed';
import realm from '../src/kernel/recorded/board-realm-realm.json';
import { m } from '../src/paraglide/messages.js';

const card: RealmDiscoveryCard = {
  realmId: realm.realm.realmId,
  spaceId: realm.realm.spaceId,
  name: realm.realm.title,
  description: realm.realm.summary,
  avatar: null,
};
const selected = {
  id: '0192f3a0-6c1e-7b2a-a001-000000000001',
  containerId: card.realmId,
  digest: 'a'.repeat(64),
  width: 160,
  height: 160,
  variants: [{ format: 'webp' as const, width: 160, height: 160 }],
  placeholder: null,
  focalPoint: { x: 0.25, y: 0.75 },
  credit: null,
};
function render(state: RealmDiscoveryState, sort: RealmDiscoverySort = 'popular', locale = 'en') {
  return renderToStaticMarkup(
    createElement(RealmDiscoverySection, { sort, state, locale, onNext: () => {}, onRetry: () => {} }),
  );
}

test('the assigned real current-authorized journey binds its native source while privacy retry and request bounds remain meaningful', async () => {
  for (const sort of ['popular', 'trending'] as const) {
    const calls: Request[] = [];
    const cursor = 'opaque-native-page';
    const responses = [
      Response.json({ realms: [], next: cursor }),
      Response.json({ realms: [card], next: null }),
      Response.json({ code: 'dependency_unavailable' }, { status: 503 }),
      Response.json({ realms: [{ ...card, avatar: selected }], next: null }),
      Response.json({ code: 'platform_closed' }, { status: 403 }),
      Response.json({ code: 'not_found' }, { status: 404 }),
    ];
    const client = createKernelClient('https://kernel.test', {
      fetch: async (input, init) => {
        calls.push(new Request(input, init));
        const response = responses.shift();
        if (!response) throw new Error('Unexpected additional request');
        return response;
      },
    });
    const sparse = await loadRealmDiscovery(client, { sort, limit: 2 });
    expect(sparse).toEqual({ kind: 'ready', realms: [], next: cursor });
    expect(calls).toHaveLength(1);
    const emptyPage = render(sparse, sort);
    expect(emptyPage).toContain(m.realm_discovery_page_empty({}, { locale: 'en' }));
    expect(emptyPage).toContain(m.realm_discovery_continue({}, { locale: 'en' }));
    expect(emptyPage).not.toContain(m.realm_discovery_empty({}, { locale: 'en' }));
    const ready = await loadRealmDiscovery(client, { sort, limit: 2, cursor });
    expect(ready).toEqual({ kind: 'ready', realms: [card], next: null });
    const markup = render(ready, sort, 'zh-Hant');
    expect(markup).toContain(`/zh-Hant/realms/${card.realmId}`);
    expect(markup).toContain(card.name);
    expect(markup).toContain(card.description);
    expect(markup).toContain('data-slot="realm-discovery-initials"');
    expect(markup).not.toContain(`/spaces/${card.spaceId}`);
    expect(calls).toHaveLength(2);
    const unavailable = await loadRealmDiscovery(client, { sort, limit: 2 });
    expect(unavailable).toEqual({ kind: 'unavailable' });
    expect(render(unavailable)).toContain(m.realm_discovery_retry({}, { locale: 'en' }));
    expect(render(unavailable)).not.toContain(card.name);
    const retry = await loadRealmDiscovery(client, { sort, limit: 2 });
    expect(retry).toEqual({ kind: 'ready', realms: [{ ...card, avatar: selected }], next: null });
    const image = render(retry, sort);
    expect(image).toContain(`/media/${selected.id}/webp-160`);
    expect(image).toContain('data-slot="media-image"');
    expect(image).not.toContain('https://kernel.test');
    const closed = await loadRealmDiscovery(client, { sort, limit: 2 });
    expect(closed).toEqual({ kind: 'closed' });
    expect(render(closed)).not.toContain(card.name);
    expect(render(closed)).not.toContain('<button');
    expect(await loadRealmDiscovery(client, { sort, limit: 2 })).toEqual({ kind: 'unavailable' });
    expect(calls).toHaveLength(6);
    for (const [index, request] of calls.entries()) {
      const url = new URL(request.url);
      expect(request.method).toBe('GET');
      expect(url.pathname).toBe('/v1/realms/discovery');
      expect(url.searchParams.get('sort')).toBe(sort);
      expect(url.searchParams.get('limit')).toBe('2');
      expect(url.searchParams.get('cursor')).toBe(index === 1 ? cursor : null);
    }
  }
});

test('the closed discovery boundary accepts only native cards and same-Realm selected derivatives within the examined page bound', async () => {
  const invalid = [
    { items: [card], next: null },
    { realms: [card], next: null, count: 1 },
    { realms: [{ ...card, score: 1 }], next: null },
    { realms: [{ ...card, realmId: 'not-a-routed-id' }], next: null },
    { realms: [{ ...card, avatar: 'https://images.test/avatar.png' }], next: null },
    { realms: [{ ...card, avatar: { ...selected, containerId: card.spaceId } }], next: null },
    { realms: [{ ...card, avatar: { ...selected, variants: Array(13).fill(selected.variants[0]) } }], next: null },
    { realms: [{ ...card, avatar: { ...selected, accountId: card.spaceId } }], next: null },
    { realms: [card, card], next: null },
  ];
  for (const body of invalid) {
    let calls = 0;
    const client = createKernelClient('https://kernel.test', {
      fetch: async () => {
        calls++;
        return Response.json(body);
      },
    });
    expect(await loadRealmDiscovery(client, { sort: 'popular', limit: 1 })).toEqual({ kind: 'unavailable' });
    expect(calls).toBe(1);
  }
  let calls = 0;
  const client = createKernelClient('https://kernel.test', {
    fetch: async () => {
      calls++;
      return Response.json({ realms: [], next: null });
    },
  });
  for (const limit of [0, 101, 1.5])
    expect(await loadRealmDiscovery(client, { sort: 'popular', limit })).toEqual({ kind: 'unavailable' });
  expect(await loadRealmDiscovery(client, { sort: 'popular', cursor: '' })).toEqual({ kind: 'unavailable' });
  expect(calls).toBe(0);
  expect(await loadRealmDiscovery(client, { sort: 'popular' })).toEqual({ kind: 'ready', realms: [], next: null });
  expect(calls).toBe(1);
  const unicodeCard = { ...card, description: '🌍'.repeat(160) };
  const unicode = await loadRealmDiscovery(
    createKernelClient('https://kernel.test', {
      fetch: async () => Response.json({ realms: [unicodeCard], next: null }),
    }),
    { sort: 'trending' },
  );
  expect(unicode).toEqual({ kind: 'ready', realms: [unicodeCard], next: null });
  const wrapped = withPlatformClosedRecognition(
    createKernelClient('https://kernel.test', {
      fetch: async () => Response.json({ code: 'platform_closed' }, { status: 403 }),
    }),
  );
  expect(await loadRealmDiscovery(wrapped, { sort: 'popular' })).toEqual({ kind: 'closed' });
  const disconnected = createKernelClient('https://kernel.test', {
    fetch: async () => {
      throw new Error('Connection lost');
    },
  });
  expect(await loadRealmDiscovery(disconnected, { sort: 'trending' })).toEqual({ kind: 'unavailable' });
});
