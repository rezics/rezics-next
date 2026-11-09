import { expect, test } from 'bun:test';
import { createKernelClient } from '@rezics/client';
import example from '../src/kernel/recorded/my-realms.json';
import { formatMyRealmsCurrent } from '../src/community/my-realms-native';
import { MyRealmsPageView } from '../src/community/my-realms-page';
import { m } from '../src/paraglide/messages.js';
import { deLocalizeUrl, localizeUrl, setLocale } from '../src/paraglide/runtime.js';
import { createElement } from 'react';
import { renderToString } from 'react-dom/server';
import { createMemoryHistory, createRootRoute, createRouter, RouterProvider } from '@tanstack/react-router';
import type { MyRealmsNativeItem } from '../src/community/my-realms-current/contract';
import { createMyRealmsLeaveIntent, sameLeaveAdmission } from '../src/community/my-realms-current/selection';
import { realmLeaveReadResolves } from '../src/community/realm-leave-recovery';

const locales = ['en', 'zh-Hant', 'zh-Hans', 'ja', 'ko', 'de', 'fr', 'es'] as const;

function itemAt(index: number): MyRealmsNativeItem {
  const source = example.items[0];
  if (!source) throw new Error('The My Realms recording needs a current member example.');
  const realmId = `0192f3a0-6c1e-7b2a-9d4e-${String(index + 1).padStart(12, '0')}`;
  return {
    ...source,
    realmId,
    name: `Readers ${index}`,
    current: {
      ...source.current,
      destination: { ...source.current.destination, realmId },
      actions: {
        state: 'current',
        enter: { state: 'available', method: 'GET', path: `/v1/realms/${realmId}`, body: null, expectedStatus: 200 },
        manage: {
          state: 'available',
          method: 'GET',
          path: `/v1/realms/${realmId}/settings`,
          body: null,
          expectedStatus: 200,
        },
        leave: {
          state: 'available',
          method: 'DELETE',
          path: `/v1/realms/${realmId}/membership`,
          body: null,
          expectedStatus: 202,
        },
      },
    },
  };
}

test('installed My Realms projection keeps one bounded ordered native page with current advice and no row reads', async () => {
  for (const count of [0, 1, 10, 20]) {
    const items = Array.from({ length: count }, (_, index) => itemAt(index));
    const next = 'opaque/sparse?cursor=%25';
    let reads = 0;
    const client = createKernelClient('https://kernel.example', {
      fetch: async () => {
        reads++;
        return Response.json({ items, next });
      },
    });
    const { data } = await client.me.realms.get();
    if (!data) throw new Error('Expected the recorded My Realms current page.');
    const page = formatMyRealmsCurrent(data);
    expect(page.realms).toEqual(items.map(({ realmId, name, current }) => ({ realmId, name, current })));
    expect(page.realms.map((row) => row.realmId)).toEqual(items.map(({ realmId }) => realmId));
    expect(page.next).toBe(next);
    expect(reads).toBe(1);
  }

  const oversized = createKernelClient('https://kernel.example', {
    fetch: async () => Response.json({ items: Array.from({ length: 21 }, (_, index) => itemAt(index)), next: null }),
  });
  const { data } = await oversized.me.realms.get();
  if (!data) throw new Error('Expected the concrete oversized fixture.');
  expect(() => formatMyRealmsCurrent(data)).toThrow('My Realms page exceeded its installed page bound');
});

test('selected leave admission freezes the Account episode, advice, key and credential through uncertainty', () => {
  const row = formatMyRealmsCurrent({ items: [itemAt(0)], next: null }).realms[0]!;
  const page = { cursor: null };
  const intent = createMyRealmsLeaveIntent({
    page,
    visitId: 'my-realms-visit',
    accountId: 'account-current',
    row,
    advice: row.current.actions.leave as Extract<typeof row.current.actions.leave, { state: 'available' }>,
    credential: 'csrf-original',
    key: '123e4567-e89b-42d3-a456-426614174000',
    observation: 4,
  });

  expect(intent.attempt.body).toEqual({
    realmId: row.realmId,
    action: 'leave',
    idempotencyKey: '123e4567-e89b-42d3-a456-426614174000',
  });
  expect(intent.attempt.credential).toBe('csrf-original');
  expect(sameLeaveAdmission(intent, row)).toBe(true);

  const replacementEpisode = {
    ...row,
    current: {
      ...row.current,
      viewer: {
        ...row.current.viewer,
        membership: {
          ...row.current.viewer.membership,
          reservationId: 'new-membership-episode',
        },
      },
    },
  };
  const replacementAdvice = {
    ...row,
    current: {
      ...row.current,
      actions: {
        ...row.current.actions,
        leave: { ...row.current.actions.leave, expectedStatus: 200 as const },
      },
    },
  };
  expect(sameLeaveAdmission(intent, replacementEpisode)).toBe(false);
  expect(sameLeaveAdmission(intent, replacementAdvice)).toBe(false);
  expect(realmLeaveReadResolves({ kind: 'uncertain', ownerReason: 'unavailable' }, 'none')).toBe(false);
});

async function render(items: MyRealmsNativeItem[], next: string | null, locale: (typeof locales)[number]) {
  await setLocale(locale, { reload: false });
  const response = { items, next };
  const client = createKernelClient('https://kernel.example', { fetch: async () => Response.json(response) });
  const { data } = await client.me.realms.get();
  if (!data) throw new Error('Expected the supplied native page.');
  const page = { signedIn: true, ...formatMyRealmsCurrent(data) };
  const root = createRootRoute({ component: () => createElement(MyRealmsPageView, { page }) });
  const router = createRouter({
    routeTree: root,
    history: createMemoryHistory({ initialEntries: [`/${locale}/realms`] }),
    rewrite: {
      input: ({ url }) => deLocalizeUrl(url).href,
      output: ({ url }) => localizeUrl(url, { locale }).href,
    },
  });
  await router.load();
  return { markup: renderToString(createElement(RouterProvider, { router })), page };
}

test('rendered current rows expose only admitted destinations and retain supplied media, description and sparse cursor', async () => {
  for (const locale of locales) {
    for (const count of [0, 1, 10, 20]) {
      const items = Array.from({ length: count }, (_, index) => itemAt(index));
      const cursor = 'opaque/sparse?cursor=%25';
      const { markup, page } = await render(items, cursor, locale);
      const rows = [...markup.matchAll(/<li\b[^>]*>([\s\S]*?)<\/li>/gu)].map((match) => match[1]!);
      expect(rows).toHaveLength(count);
      rows.forEach((row, index) => {
        const realm = page.realms[index]!;
        expect(row).toContain(`>${realm.name}</h2>`);
        expect(row).toContain(realm.current.description);
        expect(row).toContain('href="');
        expect(row).toContain(m.my_realms_open({}, { locale }));
        expect(row).toContain(m.my_realms_manage({}, { locale }));
        expect(row).toContain('/realms/');
        expect(row).toContain('/members');
        expect(row).not.toContain('<button'); // Explanatory read-only copy is not a Leave action.
        if (realm.current.avatar.state === 'none') expect(row).toContain(m.realm_appearance_no_image({}, { locale }));
        if (realm.current.avatar.state === 'unavailable')
          expect(row).toContain(m.realm_appearance_image_unavailable({}, { locale }));
      });
      const continuation = markup
        .match(/<a\b([^>]*)>([\s\S]*?)<\/a>/gu)
        ?.find((anchor) => anchor.includes(m.realms_more({}, { locale })));
      expect(continuation).toBeDefined();
      expect(
        new URL(continuation!.match(/href="([^"]+)"/)![1]!, 'https://site.example').searchParams.get('cursor'),
      ).toBe(cursor);
      expect(markup).not.toContain(m.realms_empty({}, { locale }));
    }
  }
});
