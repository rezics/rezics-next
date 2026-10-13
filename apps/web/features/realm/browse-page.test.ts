import { afterEach, expect, test } from 'bun:test';
import { materializeData } from 'native-i18n';
import type { AnswerRecord } from '../../../../scripts/api/answer-record.ts';
import books from '../../../../tests/qa/fixtures/outcomes/books/catalogue-browse-and-search-in-its-zone.json';
import { spaceHref } from '../address/path.ts';
import { BFF_PREFIX, browserMainApi } from '../api/browser.ts';
import { recordedFetch } from '../stories/recorded-fetch.ts';
import { parseBrowseState } from '../zones/browse-state.ts';
import { messages } from '../zones/messages.ts';
import { buildBrowsePage } from './browse-page.ts';
import { readBrowseAnswer, readFacetAnswer } from './browse-page-read.ts';
import type { ZoneBrowsePage } from './types.ts';

const record = books as AnswerRecord;
const disposals: (() => void)[] = [];
afterEach(() => { for (const dispose of disposals.splice(0)) dispose(); });

async function pageFrom(label: string, sort: 'newest' | 'relevance') {
  const sample = record.personas.visitor.find(item => item.label === label)!;
  const replay = recordedFetch(record, 'visitor', [
    { label, state: sample.status === 200 ? 'populated' : 'error' },
    { label: 'facet-labels', state: 'populated' },
  ], { pathPrefix: BFF_PREFIX });
  disposals.push(replay.dispose);
  const main = browserMainApi('https://recorded.invalid', { fetcher: replay.fetcher });
  const realm = new URL(sample.path, 'https://recorded.invalid').pathname.split('/')[3]!;
  const [page, facets] = await Promise.all([
    readBrowseAnswer(main, realm, { sort, limit: 10, type: ['https://schema.org/Book'] }),
    readFacetAnswer(main),
  ]);
  const result = buildBrowsePage({ page, facets, base: spaceHref('books', 'site', ['browse']), zoneName: 'Books',
    state: parseBrowseState({ type: 'schema:Book', sort }), context: { realm, ref: 'books', locale: 'en' },
    locale: 'en', messages });
  return { result, page, facets, sample };
}

test('recorded answers keep titles, lower-bound count, sorts and opaque continuation in the page', async () => {
  const { result, sample, facets } = await pageFrom('browse-newest-0', 'newest');
  expect(facets.ok).toBe(true);
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error('The recorded browse did not build');
  const answer = sample.answer as ZoneBrowsePage;
  expect(result.data.items.map(item => item.title?.value)).toEqual(answer.items.map(item => item.title.value));
  expect(result.data.items.map(item => item.id)).toEqual(answer.items.map(item => item.id));
  expect(result.data.items[0]?.title?.lang).toBe(answer.items[0]?.title.language);
  const t = materializeData(messages, { locale: 'en' });
  expect(result.data.results).toBe(t.resultsAtLeast({ count: String(answer.matches.value) }));
  expect(result.data.sorts.map(item => [item.sort, item.current])).toEqual([['newest', true], ['updated', false]]);
  const next = new URL(result.data.next!, 'https://recorded.invalid');
  expect(next.searchParams.get('cursor')).toBe(answer.nextCursor);
  expect(next.searchParams.get('type')).toBe('schema:Book');
  expect(result.data.first).toBeNull();
});

test('the recorded unsupported query refusal stays a failure rather than an empty catalogue', async () => {
  const { result, page, sample } = await pageFrom('unsupported-query-shape', 'relevance');
  expect(sample.status).toBe(400);
  expect(sample.answer).toMatchObject({ code: 'unsupported_query_shape' });
  expect(page).toEqual({ ok: false, failure: 'invalid' });
  if (page.ok) throw new Error('The recorded refusal became a successful read');
  expect(result).toBe(page);
});
