import { expect, test } from 'bun:test';
import { AppRouterContext } from 'next/dist/shared/lib/app-router-context.shared-runtime';
import { renderToStaticMarkup } from 'react-dom/server';
import { catalogs } from '../../i18n/catalogs.ts';
import { uiLocales } from '../../i18n/define.ts';
import { libraryState, memoryLibraryApi, readingRows, storyNow, storyOverview, storyReaderActions, storyView } from './fixtures.ts';
import { LibraryPage, type LibraryPageProps } from './library-page.tsx';
import { messages } from './messages.ts';
import type { Loaded, ReadingYear, YearlyGoal } from './types.ts';

const router = { bfcacheId: 'library-page-test', back() {}, forward() {}, refresh() {}, hmrRefresh() {},
  push() {}, replace() {}, prefetch() {} };
const state = libraryState();
const goal: Loaded<YearlyGoal> = { ok: true, data: { year: 2026, target: 12, completed: 0,
  version: 1, changedAt: '2026-10-01T00:00:00Z' } };
const stats: Loaded<ReadingYear> = { ok: true, data: { year: 2026, books: 0, chapters: 9,
  detailsAvailability: 'complete', averageRating: null, ratedBooks: 0, knownChapters: 0, booksWithChapters: 0,
  topConcepts: [], titleLanguages: [],
  months: Array.from({ length: 12 }, (_, index) => ({ month: index + 1, books: 0, chapters: index === 9 ? 9 : 0 })) } };

function render(overrides: Partial<LibraryPageProps> = {}) {
  return renderToStaticMarkup(<AppRouterContext value={router}>
    <LibraryPage state={state} overview={{ ok: true, data: storyOverview(readingRows) }}
      view={{ ok: true, data: storyView(state, readingRows) }} reading={readingRows} goal={goal} stats={stats}
      now={storyNow} api={memoryLibraryApi()} readerActions={storyReaderActions(readingRows)}
      locale="en" messages={messages} {...overrides} />
  </AppRouterContext>);
}

test('a returning reader reaches the actual reading rows and next chapter before closed secondary tools', () => {
  const html = render();
  const reading = html.indexOf('id="library-reading"');
  const tools = html.indexOf(messages.libraryTools);
  expect(reading).toBeGreaterThan(0);
  expect(tools).toBeGreaterThan(reading);
  for (const row of readingRows) {
    const href = row.progress?.next?.href ?? row.work.href;
    const action = html.indexOf(`href="/en${href}"`, reading);
    expect(action).toBeGreaterThan(reading);
    expect(action).toBeLessThan(tools);
  }
  const toolsStart = html.lastIndexOf('<details', tools);
  expect(html.slice(toolsStart, tools)).not.toMatch(/\bopen(?:=|\s|>)/);
  expect(html.indexOf('id="library-yearly-goal"')).toBeGreaterThan(tools);
  expect(html.indexOf('id="library-reading-stats"')).toBeGreaterThan(tools);
  expect(html.indexOf(messages.importTitle)).toBeGreaterThan(tools);
  expect(html.indexOf('Download your library')).toBeGreaterThan(tools);
  expect(html).toContain('9 chapters completed');
});

test('an empty library leads with ways to find books and keeps transfers available afterwards', () => {
  const html = render({ overview: { ok: true, data: storyOverview([], { customShelves: [] }) },
    view: { ok: true, data: storyView(state, []) }, reading: [] });
  const tools = html.indexOf(messages.libraryTools);
  expect(html.indexOf('Your library starts here')).toBeGreaterThan(0);
  expect(html.indexOf('Your library starts here')).toBeLessThan(tools);
  expect(html.indexOf('href="/en/discover"')).toBeLessThan(tools);
  expect(html).not.toContain('id="library-reading"');
  expect(html).toContain(messages.importTitle);
  expect(html).toContain('Download your library');
});

test('loans and denied identities retain their own main task without unrelated tools', () => {
  const loans = render({ loansView: <h2>Copies and loans</h2> });
  expect(loans).toContain('Copies and loans');
  expect(loans).not.toContain(messages.libraryTools);
  const denied = render({ overview: { ok: false, failure: 'sign-in' } });
  expect(denied).toContain('Choose identity');
  expect(denied).not.toContain(messages.libraryTools);
  expect(denied).not.toContain('id="library-reading"');
});

for (const locale of uiLocales) {
  test(`${locale}: the secondary tools have a localized, discoverable label`, async () => {
    const translated = await catalogs.library[locale]();
    const html = render({ locale, messages: translated });
    expect(translated.libraryTools).toBeTruthy();
    if (locale !== 'en') expect(translated.libraryTools).not.toBe(messages.libraryTools);
    expect(html).toContain(translated.libraryTools);
  });
}
