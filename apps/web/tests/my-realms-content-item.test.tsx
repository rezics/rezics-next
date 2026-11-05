import { expect, test } from 'bun:test';
import { createElement } from 'react';
import { renderToString } from 'react-dom/server';
import { createMemoryHistory, createRootRoute, createRouter, RouterProvider } from '@tanstack/react-router';
import { m } from '../src/paraglide/messages.js';
import { deLocalizeUrl, localizeUrl, setLocale } from '../src/paraglide/runtime.js';
import { MyRealmsPageView } from '../src/community/my-realms-page';
import type { MyRealmsPage } from '../src/community/space';

type Locale = 'en' | 'zh-Hant';

async function render(page: MyRealmsPage, locale: Locale = 'en') {
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

function rowsIn(markup: string) {
  return [...markup.matchAll(/<li\b[^>]*data-slot="list-row"[^>]*>[\s\S]*?<\/li>/gu)].map((match) => match[0]);
}

function inventoryHeading(row: string) {
  const heading = row.match(/<h2\b([^>]*)>([\s\S]*?)<\/h2>/u);
  expect(heading).not.toBeNull();
  if (!heading) throw new Error('A Realm ContentItem should have a visible level-two heading.');

  const headingId = heading[1]!.match(/\bid="([^"]+)"/u)?.[1];
  expect(headingId).toBeTruthy();
  expect(heading[1]).toContain('data-content-item-slot="title"');
  expect(heading[1]).not.toContain('aria-hidden');

  expect(row).not.toMatch(/<a\b/gu);
  return heading[2]!;
}

function cursorFromContinuation(markup: string, locale: Locale, cursor: string) {
  const label = m.realms_more({}, { locale });
  const continuations = [...markup.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/gu)].filter((match) => match[2] === label);
  expect(continuations).toHaveLength(1);
  const encodedHref = continuations[0]?.[1]?.match(/\bhref="([^"]+)"/u)?.[1];
  expect(encodedHref).toBeTruthy();
  if (!encodedHref) throw new Error('A supplied Realm cursor should remain a native continuation link.');
  const url = new URL(encodedHref.replaceAll('&amp;', '&'), 'https://rezics.example');
  expect(url.pathname).toBe(`/${locale}/realms`);
  expect([...url.searchParams.keys()]).toEqual(['cursor']);
  expect(url.searchParams.get('cursor')).toBe(cursor);
}

const pageWithRealms: MyRealmsPage = {
  signedIn: true,
  realms: [
    {
      realmId: '01a1a000-0000-7000-8000-000000000002',
      name: 'The Quiet Novel Club',
      description: 'Read translated fiction together.',
    },
    {
      realmId: '01a1a000-0000-7000-8000-000000000051',
      name: 'Night Shift Translators',
      description: 'Share notes from late-night editing sessions.',
    },
  ],
  next: 'opaque cursor/v1?scope=all&token=%25',
};

test('My Realms composes ordered ContentItems with named headings, supplied descriptions and unavailable entry', async () => {
  for (const locale of ['en', 'zh-Hant'] as const) {
    const markup = await render(pageWithRealms, locale);
    const rows = rowsIn(markup);

    expect(markup).toContain('<ul');
    expect(markup.match(/<h1\b/gu)).toHaveLength(1);
    expect(rows).toHaveLength(pageWithRealms.realms.length);
    expect(markup).not.toMatch(/<(?:img|picture|source)\b/iu);

    const rendered = rows.map((row, index) => {
      const item = pageWithRealms.realms[index]!;
      const title = inventoryHeading(row);
      expect(title).toBe(item.name);
      expect(row).toContain(m.realms_entry_unavailable({}, { locale }));
      expect(row).toContain(`<p class="text-sm leading-relaxed text-muted-foreground">${item.description}</p>`);
      return title;
    });
    expect(rendered).toEqual(pageWithRealms.realms.map((realm) => realm.name));
    cursorFromContinuation(markup, locale, pageWithRealms.next!);
  }
});

test('My Realms keeps final empty and sparse empty pages distinct by their opaque continuation', async () => {
  const finalMarkup = await render({ signedIn: true, realms: [], next: null });
  expect(finalMarkup).toContain(m.realms_empty({}, { locale: 'en' }));
  expect(rowsIn(finalMarkup)).toHaveLength(0);
  expect(finalMarkup).not.toContain(m.realms_more({}, { locale: 'en' }));

  const cursor = 'opaque-empty-page.cursor?next=2&keep=%2F';
  const sparseMarkup = await render({ signedIn: true, realms: [], next: cursor });
  expect(sparseMarkup).toContain(m.realm_list_details_sparse_page_empty({}, { locale: 'en' }));
  expect(sparseMarkup).not.toContain(m.realms_empty({}, { locale: 'en' }));
  expect(rowsIn(sparseMarkup)).toHaveLength(0);
  cursorFromContinuation(sparseMarkup, 'en', cursor);
});
