import { afterEach, expect, test } from 'bun:test';
import { materializeData } from 'native-i18n';
import type { AnswerPersona, AnswerRecord } from '../../../../scripts/api/answer-record.ts';
import visualNovels from '../../../../tests/qa/fixtures/outcomes/visual-novels/catalogue-browse-and-search-in-its-zone.json';
import { BFF_PREFIX, browserMainApi } from '../api/browser.ts';
import type { ZoneBrowsePage } from '../realm/types.ts';
import { recordedFetch, type RecordedState } from '../stories/recorded-fetch.ts';
import { messages } from './messages.ts';
import {
  loadRecordedBrowse, recordedBrowseRequest, recordedBrowseSample, recordedBrowseSelections, recordedBrowseZone,
  visualNovelsBrowseSamples,
} from './visual-novels-browse-recorded-page.ts';

const record = visualNovels as AnswerRecord;
const locale = 'en' as const;
const disposals: (() => void)[] = [];
afterEach(() => { for (const dispose of disposals.splice(0)) dispose(); });

function authorOf(item: { primaryCredits?: readonly { displayName?: string | null }[] | null }): string | null {
  return item.primaryCredits?.find(credit => credit.displayName)?.displayName ?? null;
}

async function load(persona: AnswerPersona, label: string, state: RecordedState) {
  const replay = recordedFetch(record, persona, recordedBrowseSelections(record, persona, label, state),
    { pathPrefix: BFF_PREFIX });
  disposals.push(replay.dispose);
  const main = browserMainApi('https://recorded.invalid', { anonymous: true, fetcher: replay.fetcher });
  const { zone, ref } = recordedBrowseZone(record, persona, locale);
  return loadRecordedBrowse(main, record, persona, label, zone, ref, locale, messages);
}

function resultText(matches: ZoneBrowsePage['matches']): string {
  const t = materializeData(messages, { locale });
  return matches.kind === 'exact' ? t.results(matches.value) : t.resultsAtLeast({ count: String(matches.value) });
}

test('recorded visual novel browse keeps titles, authors, lower-bound count, sort and opaque continuation', async () => {
  const { result, page, facets, sample } = await load('visitor', visualNovelsBrowseSamples.newest, 'populated');
  const answer = sample.answer as ZoneBrowsePage;
  expect(facets).toBeNull();
  expect(page.ok && result.ok).toBe(true);
  if (!result.ok || !page.ok) throw new Error('The recorded browse did not build');
  expect(result.data.items.map(item => item.title?.value)).toEqual(answer.items.map(item => item.title.value));
  expect(result.data.items.map(item => item.id)).toEqual(answer.items.map(item => item.id));
  expect(result.data.items.map(item => item.author?.value ?? null)).toEqual(answer.items.map(item => authorOf(item)));
  expect(result.data.items[0]?.title?.lang).toBe(answer.items[0]?.title.language);
  expect(result.data.results).toBe(resultText(answer.matches));
  expect(result.data.sorts.map(item => [item.sort, item.current])).toEqual([['newest', true], ['updated', false]]);
  const next = new URL(result.data.next!, 'https://recorded.invalid');
  expect(next.searchParams.get('cursor')).toBe(answer.nextCursor);
  expect(next.searchParams.get('type')).toBe('schema:VideoGame');
  expect(result.data.first).toBeNull();
});

test('recorded visual novel search keeps the query, relevance sort and titles', async () => {
  const { result, sample } = await load('visitor', visualNovelsBrowseSamples.relevance, 'populated');
  const answer = sample.answer as ZoneBrowsePage;
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error('The recorded search did not build');
  expect(recordedBrowseRequest(sample).state.text).toBe(answer.query.text);
  expect(result.data.items.map(item => item.title?.value)).toEqual(answer.items.map(item => item.title.value));
  expect(result.data.results).toBe(resultText(answer.matches));
  expect(result.data.sorts.map(item => [item.sort, item.current])).toEqual([
    ['relevance', true], ['newest', false], ['updated', false],
  ]);
  expect(new URL(result.data.next!, 'https://recorded.invalid').searchParams.get('cursor')).toBe(answer.nextCursor);
});

test('recorded visual novel updated sort stays current for the searched page', async () => {
  const { result, sample } = await load('visitor', visualNovelsBrowseSamples.updated, 'populated');
  const answer = sample.answer as ZoneBrowsePage;
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error('The recorded updated sort did not build');
  expect(result.data.sorts.map(item => [item.sort, item.current])).toEqual([
    ['relevance', false], ['newest', false], ['updated', true],
  ]);
  expect(result.data.items[0]?.id).toBe(answer.items[0]?.id);
  expect(result.data.results).toBe(resultText(answer.matches));
});

test('recorded visual novel continuation keeps the last title and drops the next cursor', async () => {
  const { result, sample } = await load('visitor', visualNovelsBrowseSamples.continuation, 'populated');
  const answer = sample.answer as ZoneBrowsePage;
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error('The recorded continuation did not build');
  expect(answer.items).toHaveLength(1);
  expect(result.data.items.map(item => [item.id, item.title?.value])).toEqual(answer.items.map(item => [item.id, item.title.value]));
  expect(result.data.results).toBe(resultText(answer.matches));
  expect(answer.matches).toEqual({ value: 21, kind: 'exact' });
  expect(result.data.next).toBeNull();
  const first = new URL(result.data.first!, 'https://recorded.invalid');
  expect(first.searchParams.has('cursor')).toBe(false);
  expect(first.searchParams.get('sort')).toBe('newest');
  expect(first.searchParams.get('type')).toBe('schema:VideoGame');
});

test('the recorded unsupported query refusal stays a failure rather than an empty catalogue', async () => {
  const loaded = await load('visitor', visualNovelsBrowseSamples.refusal, 'error');
  const sample = recordedBrowseSample(record, 'visitor', visualNovelsBrowseSamples.refusal);
  expect(sample.status).toBe(400);
  expect(sample.answer).toMatchObject({ code: 'unsupported_query_shape', title: 'Relevance needs text' });
  expect(loaded.page).toEqual({ ok: false, failure: 'invalid' });
  expect(loaded.result).toEqual({ ok: false, failure: 'invalid' });
  expect(Object.is(loaded.result, loaded.page)).toBe(true);
});

test('the recorded member empty search stays an empty page with an exact zero count', async () => {
  const { result, page, facets, sample } = await load('member', visualNovelsBrowseSamples.empty, 'empty');
  const answer = sample.answer as ZoneBrowsePage;
  expect(answer.items).toEqual([]);
  expect(answer.matches).toEqual({ value: 0, kind: 'exact' });
  expect(answer.nextCursor).toBeNull();
  expect(facets?.ok).toBe(true);
  expect(page.ok && result.ok).toBe(true);
  if (!result.ok) throw new Error('The recorded empty search did not build');
  expect(result.data.items).toEqual([]);
  expect(result.data.results).toBe(resultText(answer.matches));
  expect(result.data.next).toBeNull();
  expect(result.data.state.text).toBe(answer.query.text);
});
