import { expect, test } from 'bun:test';
import { createElement } from 'react';
import { renderToString } from 'react-dom/server';
import { createMemoryHistory, createRootRoute, createRouter, RouterProvider } from '@tanstack/react-router';
import { MyRealmsPageView } from '../src/community/my-realms-page';
import type { MyRealmsPage } from '../src/community/space';
import { m } from '../src/paraglide/messages.js';
import { deLocalizeUrl, localizeUrl, setLocale } from '../src/paraglide/runtime.js';
import { ClosedErrorPage } from '../src/shell/closed';
import recording from '../src/kernel/recorded/my-realms.json';
import en from '../messages/en.json';
import zhHant from '../messages/zh-Hant.json';
import zhHans from '../messages/zh-Hans.json';
import ja from '../messages/ja.json';
import ko from '../messages/ko.json';
import fr from '../messages/fr.json';
import es from '../messages/es.json';
import de from '../messages/de.json';

// Supplied-page presentation examples; these establish no native admission or lifetime evidence.
type Locale = 'en' | 'zh-Hant';
const locales = ['en', 'zh-Hant'] as const;
const cursor = 'opaque-empty-page.cursor?next=2&keep=%2F';
const populated: MyRealmsPage = {
  signedIn: true,
  realms: recording.items.map((item, index) => ({
    realmId: item.realmId,
    name: item.name,
    description: index === 0 ? 'Patient readers share their notes here.' : null,
  })),
  next: cursor,
};

async function render(pages: readonly MyRealmsPage[], locale: Locale, dir: 'ltr' | 'rtl' = 'ltr', unavailable = false) {
  await setLocale(locale, { reload: false });
  const root = createRootRoute({
    component: () =>
      createElement(
        'main',
        { dir, lang: locale },
        unavailable
          ? createElement(ClosedErrorPage, { error: new Error('Realm list is unavailable') })
          : pages.map((page, index) => createElement(MyRealmsPageView, { key: index, page })),
      ),
  });
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

function continuation(markup: string, locale: Locale, expectedCursor: string) {
  const nav = markup.match(/<nav\b[^>]*>[\s\S]*?<\/nav>/u)?.[0];
  expect(nav).toBeDefined();
  expect(nav).toContain(`aria-label="${m.realms_heading({}, { locale })}"`);
  const links = [...(nav ?? '').matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/gu)];
  expect(links).toHaveLength(1);
  const attributes = links[0]![1]!;
  expect(links[0]![2]).toBe(m.realms_more({}, { locale }));
  const href = attributes.match(/\bhref="([^"]+)"/u)?.[1];
  expect(href).toBeTruthy();
  const url = new URL(href!.replaceAll('&amp;', '&'), 'https://rezics.example');
  expect(url.pathname).toBe(`/${locale}/realms`);
  expect([...url.searchParams.keys()]).toEqual(['cursor']);
  expect(url.searchParams.get('cursor')).toBe(expectedCursor);
  expect(url.hash).toBe('');
  expect(attributes).not.toMatch(/\b(?:disabled|aria-disabled|tabindex|onclick|role)=/iu);
  for (const token of [
    'min-h-11',
    'min-w-11',
    'max-w-full',
    'whitespace-normal',
    'focus-visible:outline-2',
    'focus-visible:outline-offset-2',
    'focus-visible:outline-ring',
  ])
    expect(attributes).toContain(token);
}

test('all eight installed catalogs supply the sparse-page message without a no-membership conclusion', () => {
  const catalogs = { en, 'zh-Hant': zhHant, 'zh-Hans': zhHans, ja, ko, fr, es, de };
  for (const [locale, catalog] of Object.entries(catalogs)) {
    const copy = catalog.realm_list_details_sparse_page_empty;
    expect(copy.trim().length).toBeGreaterThan(0);
    expect(copy).not.toBe(catalog.realms_empty);
    expect(m.realm_list_details_sparse_page_empty({}, { locale: locale as keyof typeof catalogs })).toBe(copy);
    expect(catalog.realms_first_page.trim().length).toBeGreaterThan(0);
    expect(m.realms_first_page({}, { locale: locale as keyof typeof catalogs })).toBe(catalog.realms_first_page);
  }
  expect(en.realm_list_details_sparse_page_empty).toBe('No communities on this page. Continue to see more.');
  expect(zhHant.realm_list_details_sparse_page_empty).toBe('此頁沒有社群。繼續查看其他社群。');
});

test('Make My Realms sparse-page continuation truthful', async () => {
  for (const locale of locales)
    for (const dir of ['ltr', 'rtl'] as const) {
      const markup = await render([{ signedIn: true, realms: [], next: cursor }], locale, dir);
      expect(markup).toContain(m.realm_list_details_sparse_page_empty({}, { locale }));
      expect(markup).not.toContain(m.realms_empty({}, { locale }));
      expect(rowsIn(markup)).toHaveLength(0);
      expect(markup).not.toMatch(/<(?:ul|img|picture|source)\b/iu);
      continuation(markup, locale, cursor);
    }
});

test('a final empty supplied page retains the original empty copy and has no continuation', async () => {
  for (const locale of locales) {
    const markup = await render([{ signedIn: true, realms: [], next: null }], locale);
    expect(markup).toContain(m.realms_empty({}, { locale }));
    expect(markup).not.toContain(m.realm_list_details_sparse_page_empty({}, { locale }));
    expect(markup).not.toContain(m.realms_more({}, { locale }));
    expect(markup).not.toMatch(/<(?:nav|a|li)\b/iu);
  }
});

test('populated supplied pages preserve row order, descriptions and continuation only when supplied', async () => {
  for (const locale of locales)
    for (const next of [cursor, null]) {
      const markup = await render([{ ...populated, next }], locale);
      const rows = rowsIn(markup);
      expect(rows).toHaveLength(populated.realms.length);
      rows.forEach((row, index) => {
        const realm = populated.realms[index]!;
        expect(row).toContain(`>${realm.name}</h2>`);
        expect(row).toContain(`href="/${locale}/realms/${encodeURIComponent(realm.realmId)}"`);
        expect([...row.matchAll(/<a\b/gu)]).toHaveLength(1);
        if (realm.description)
          expect(row).toContain(`<p class="text-sm leading-relaxed text-muted-foreground">${realm.description}</p>`);
        else expect(row).not.toContain('data-content-item-slot="preview"');
      });
      expect(markup).not.toContain(m.realms_empty({}, { locale }));
      expect(markup).not.toContain(m.realm_list_details_sparse_page_empty({}, { locale }));
      expect(markup).not.toMatch(/<(?:img|picture|source)\b|\b\d+ (?:members|followers)\b/iu);
      if (next) continuation(markup, locale, next);
      else {
        expect(markup).not.toMatch(/<nav\b/iu);
        expect(markup).not.toContain(m.realms_more({}, { locale }));
      }
    }
});

test('long supplied text and multiple instances keep distinct visible heading identities without inventing visuals', async () => {
  const longPage: MyRealmsPage = {
    signedIn: true,
    realms: Array.from({ length: 20 }, (_, index) => ({
      realmId: `supplied-realm-${index}`,
      name: `Readers ${index} ${'LongCommunityTitle'.repeat(12)} 共讀社群`,
      description: `${'Shared reading notes and patient discussion. '.repeat(12)}${'閱讀筆記'.repeat(40)}`,
    })),
    next: cursor,
  };
  for (const locale of locales) {
    const markup = await render([longPage, { ...longPage, next: null }], locale, 'rtl');
    const rows = rowsIn(markup);
    expect(rows).toHaveLength(40);
    const ids = rows.map((row, index) => {
      const heading = row.match(/<h2\b[^>]*\bid="([^"]+)"[^>]*>([\s\S]*?)<\/h2>/u);
      expect(heading).not.toBeNull();
      const id = heading![1]!;
      expect(heading![2]).toBe(longPage.realms[index % 20]!.name);
      expect(row).toContain(`aria-labelledby="${id}"`);
      expect([...row.matchAll(/<a\b/gu)]).toHaveLength(1);
      expect(row).toContain(
        `<p class="text-sm leading-relaxed text-muted-foreground">${longPage.realms[index % 20]!.description}</p>`,
      );
      return id;
    });
    expect(new Set(ids).size).toBe(40);
    expect(markup).toContain('[overflow-wrap:anywhere]');
    expect(markup).not.toMatch(/<(?:img|picture|source)\b/iu);
    continuation(markup, locale, cursor);
  }
});

test('the existing unavailable presentation does not substitute a final empty or sparse page', async () => {
  for (const locale of locales) {
    const markup = await render([], locale, 'ltr', true);
    expect(markup).toContain(m.error_heading({}, { locale }));
    expect(markup).toContain(m.error_message({}, { locale }));
    expect(markup).not.toContain(m.realms_empty({}, { locale }));
    expect(markup).not.toContain(m.realm_list_details_sparse_page_empty({}, { locale }));
    expect(markup).not.toContain(m.realms_more({}, { locale }));
    expect(rowsIn(markup)).toHaveLength(0);
  }
});
