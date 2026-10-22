import { expect, test } from 'bun:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { AppRouterContext, type AppRouterInstance } from 'next/dist/shared/lib/app-router-context.shared-runtime.js';
import { browserMainApi } from '../api/browser.ts';
import { animeRelationsReads } from '../work-page/anime-relations-recorded-page.ts';
import { iri, summary } from './fixtures.ts';
import { NameLink, nameOf } from './names.tsx';

const calories = 'https://schema.org/calories', book = 'https://schema.org/Book';
const hidden = iri('801'), unnamed = iri('802'), missing = iri('803');
const unknown = 'https://schema.org/calcium';
const labels = { unavailable: 'Unavailable', undisclosed: 'Not shown', unnamed: 'Unnamed' };
const router = { refresh() {}, push() {}, replace() {}, back() {}, forward() {}, prefetch() {}, bfcacheId: '' } satisfies AppRouterInstance;

test('the production batch reader composes public terms with native disclosure, unnamed and partial-read states', async () => {
  const requests: unknown[] = [];
  const main = browserMainApi('https://record.invalid', { fetcher: (async (input, init) => {
    const body = input instanceof Request ? await input.json() : JSON.parse(String(init?.body));
    requests.push(body);
    return Response.json({ profile: 'resource-summary-batch-v1', complete: true, summaries: [
      { reference: hidden, status: 'unavailable' }, summary(unnamed, ''),
      { reference: unknown, status: 'unavailable' },
    ] });
  }) as typeof fetch });
  const names = await animeRelationsReads({ main, actingSubject: 'actual-reader' })
    .namesOf([calories, hidden, unnamed, missing, book, unknown], 'exact-position');
  expect(requests).toEqual([{ profile: 'resource-summary-batch-v1',
    resources: [hidden, unnamed, missing, unknown].sort(), position: 'exact-position', actingSubject: 'actual-reader' }]);
  expect(names.get(calories)).toEqual({ reference: calories, status: 'public-term',
    name: expect.objectContaining({ value: 'Calories', language: 'en' }) });
  expect(nameOf(names, calories)?.direction).toBe('ltr');
  expect(nameOf(names, book)?.value).toBe('Book');
  expect(names.get(hidden)?.status).toBe('unavailable');
  expect(nameOf(names, hidden)).toBeNull();
  expect(nameOf(names, unnamed)?.value).toBe('');
  expect(names.get(missing)?.status).toBe('unavailable-read');
  expect(nameOf(names, unknown)).toBeNull();
  const render = (reference: string) => renderToStaticMarkup(createElement(AppRouterContext.Provider,
    { value: router }, createElement(NameLink, { reference, names, ...labels })));
  // The same name adapter serves non-Recipe consumers without inventing a native destination.
  expect(render(book)).toContain('lang="en"');
  expect(render(book)).toContain('Book');
  expect(render(book)).not.toContain('<a');
  expect(render(hidden)).toContain('data-name-state="undisclosed"');
  expect(render(unnamed)).toContain('data-name-state="unnamed"');
  expect(render(missing)).toContain('data-name-state="unavailable"');
});

test('a failed native batch cannot erase public vocabulary labels or manufacture native names', async () => {
  const main = browserMainApi('https://record.invalid', { fetcher: Object.assign(async () =>
    Response.json({ code: 'unavailable' }, { status: 503 }), { preconnect: fetch.preconnect }) });
  const names = await animeRelationsReads({ main }).namesOf([calories, hidden,
    'http://schema.org/calories', 'https://schema.org/calories#guess', 'https://example.test/calories']);
  expect(nameOf(names, calories)?.value).toBe('Calories');
  expect(nameOf(names, calories)?.language).toBe('en');
  expect(nameOf(names, calories)?.direction).toBe('ltr');
  for (const [reference, state] of names) if (reference !== calories) {
    expect(state.status).toBe('unavailable-read');
    expect(nameOf(names, reference)).toBeNull();
  }
});
