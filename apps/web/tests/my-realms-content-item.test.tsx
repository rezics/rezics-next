import { expect, test } from 'bun:test';
import { createElement } from 'react';
import { renderToString } from 'react-dom/server';
import { createMemoryHistory, createRootRoute, createRouter, RouterProvider } from '@tanstack/react-router';
import { m } from '../src/paraglide/messages.js';
import { deLocalizeUrl, localizeUrl, setLocale } from '../src/paraglide/runtime.js';
import { MyRealmsPageView } from '../src/community/my-realms-page';
import type { MyRealmsPage } from '../src/community/space';
import type { MyRealmsNativeItem } from '../src/community/my-realms-current/contract';
import { formatMyRealmsCurrent } from '../src/community/my-realms-native';
import recording from '../src/kernel/recorded/my-realms.json';

type Locale = 'en' | 'zh-Hant';
const cursor = 'opaque cursor/v1?scope=all&token=%25';

function row(index: number, name: string, description: string) {
  const source = recording.items[0];
  if (!source) throw new Error('The refreshed My Realms response must include a current row.');
  const realmId = `0192f3a0-6c1e-7b2a-9d4e-${String(index + 2).padStart(12, '0')}`;
  const path = (action: MyRealmsNativeItem['current']['actions']['enter'], suffix: string) =>
    action.state === 'available' ? { ...action, path: `/v1/realms/${realmId}${suffix}` } : action;
  const item: MyRealmsNativeItem = {
    ...source,
    realmId,
    name,
    current: {
      ...source.current,
      description,
      destination: { ...source.current.destination, realmId },
      actions: {
        ...source.current.actions,
        enter: path(source.current.actions.enter, ''),
        manage: path(source.current.actions.manage, '/settings'),
        leave: path(source.current.actions.leave, '/membership'),
      },
    },
  };
  const [result] = formatMyRealmsCurrent({ items: [item], next: null }).realms;
  if (!result) throw new Error('Expected the formatted current row.');
  return result;
}

const page: MyRealmsPage = {
  signedIn: true,
  realms: [
    row(0, 'The Quiet Novel Club', 'Read translated fiction together.'),
    row(1, 'Night Shift Translators', 'Share notes from late-night editing sessions.'),
  ],
  next: cursor,
};

async function renderPage(locale: Locale) {
  await setLocale(locale, { reload: false });
  const root = createRootRoute({ component: () => createElement(MyRealmsPageView, { page }) });
  const router = createRouter({
    routeTree: root,
    history: createMemoryHistory({ initialEntries: [`/${locale}/realms`] }),
    rewrite: {
      input: ({ url }) => deLocalizeUrl(url).href,
      output: ({ url }) => localizeUrl(url).href,
    },
  });
  await router.load();
  return renderToString(createElement(RouterProvider, { router }));
}

function listItems(markup: string) {
  return [...markup.matchAll(/<li\b[^>]*>([\s\S]*?)<\/li>/gu)].map((match) => match[1]!);
}

function actionLink(row: string, label: string) {
  return [...row.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/gu)].find((match) => match[2] === label);
}

function cursorFromContinuation(markup: string, locale: Locale) {
  const label = m.realms_more({}, { locale });
  const continuation = [...markup.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/gu)].find((match) => match[2] === label);
  expect(continuation).toBeDefined();
  const href = continuation?.[1]?.match(/\bhref="([^"]+)"/u)?.[1];
  expect(href).toBeTruthy();
  const url = new URL(href!.replaceAll('&amp;', '&'), 'https://rezics.example');
  expect(url.pathname).toBe(`/${locale}/realms`);
  expect([...url.searchParams.keys()]).toEqual(['cursor']);
  expect(url.searchParams.get('cursor')).toBe(cursor);
}

test('My Realms renders supplied descriptions, current media and only independently admitted actions', async () => {
  for (const locale of ['en', 'zh-Hant'] as const) {
    const markup = await renderPage(locale);
    const rows = listItems(markup);
    expect(markup).toContain('<ul');
    expect(markup.match(/<h1\b/gu)).toHaveLength(1);
    expect(rows).toHaveLength(page.realms.length);

    rows.forEach((itemMarkup, index) => {
      const realm = page.realms[index]!;
      expect(itemMarkup).toContain(`>${realm.name}</h2>`);
      expect(itemMarkup).toContain(realm.current.description);
      const enter = realm.current.actions.enter;
      const manage = realm.current.actions.manage;
      const open = actionLink(itemMarkup, m.my_realms_open({}, { locale }));
      const management = actionLink(itemMarkup, m.my_realms_manage({}, { locale }));
      if (enter.state === 'available') {
        expect(open).toBeDefined();
        expect(open?.[1]).toContain(`/realms/${realm.realmId}`);
      } else expect(open).toBeUndefined();
      if (manage.state === 'available') {
        expect(management).toBeDefined();
        expect(management?.[1]).toContain(`/realms/${realm.realmId}/members`);
      } else expect(management).toBeUndefined();
      expect(itemMarkup).not.toContain('data-slot="my-realms-leave-review"');
      if (realm.current.actions.leave.state === 'available')
        expect(itemMarkup).toContain(m.my_realms_read_only({}, { locale }));
      const media = [realm.current.avatar, realm.current.banner];
      if (media.some((image) => image.state === 'available')) expect(itemMarkup).toMatch(/<(?:img|picture)\b/iu);
      if (media.some((image) => image.state === 'none'))
        expect(itemMarkup).toContain(m.realm_appearance_no_image({}, { locale }));
      if (media.some((image) => image.state === 'unavailable'))
        expect(itemMarkup).toContain(m.realm_appearance_image_unavailable({}, { locale }));
    });
    cursorFromContinuation(markup, locale);
  }
});

test('My Realms keeps a terminal empty page distinct from an empty sparse page', async () => {
  const empty = { signedIn: true, realms: [], next: null } satisfies MyRealmsPage;
  const sparse = { signedIn: true, realms: [], next: cursor } satisfies MyRealmsPage;
  for (const [value, expected, absent] of [
    [empty, m.realms_empty({}, { locale: 'en' }), m.realm_list_details_sparse_page_empty({}, { locale: 'en' })],
    [sparse, m.realm_list_details_sparse_page_empty({}, { locale: 'en' }), m.realms_empty({}, { locale: 'en' })],
  ] as const) {
    const root = createRootRoute({ component: () => createElement(MyRealmsPageView, { page: value }) });
    const router = createRouter({ routeTree: root, history: createMemoryHistory({ initialEntries: ['/en/realms'] }) });
    await router.load();
    const markup = renderToString(createElement(RouterProvider, { router }));
    expect(markup).toContain(expected);
    expect(markup).not.toContain(absent);
  }
});
