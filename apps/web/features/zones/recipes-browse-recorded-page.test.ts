import { afterEach, expect, test } from 'bun:test';
import { materializeData } from 'native-i18n';
import type { AnswerPersona, AnswerRecord } from '../../../../scripts/api/answer-record.ts';
import browseFixture from '../../../../tests/qa/fixtures/outcomes/recipes/catalogue-browse-and-search-in-its-zone.json';
import paginationFixture from '../../../../tests/qa/fixtures/outcomes/recipes/catalogue-pagination-in-its-zone.json';
import { spaceHref } from '../address/path.ts';
import { BFF_PREFIX, browserMainApi } from '../api/browser.ts';
import { buildBrowsePage } from '../realm/browse-page.ts';
import { readBrowseAnswer, readFacetAnswer } from '../realm/browse-page-read.ts';
import type { Loaded, ZoneBrowsePage } from '../realm/types.ts';
import { recordedFetch, type RecordedState } from '../stories/recorded-fetch.ts';
import type { BrowseModel } from './browse-view.ts';
import { messages } from './messages.ts';
import { recordedBrowseRequest } from './recipes-browse-recorded-page.ts';

const browse = browseFixture as AnswerRecord;
const pagination = paginationFixture as AnswerRecord;
const disposals: (() => void)[] = [];
afterEach(() => { for (const dispose of disposals.splice(0)) dispose(); });

function sampleOf(record: AnswerRecord, persona: AnswerPersona, label: string) {
  const sample = record.personas[persona].find(item => item.label === label);
  if (!sample) throw new Error(`Missing recorded recipe answer: ${record.row}/${persona}/${label}`);
  return sample;
}

function pageAnswer(sample: { answer: unknown }): ZoneBrowsePage {
  return sample.answer as ZoneBrowsePage;
}

function resultsText(answer: ZoneBrowsePage) {
  const t = materializeData(messages, { locale: 'en' });
  return answer.matches.kind === 'exact'
    ? t.results(answer.matches.value)
    : t.resultsAtLeast({ count: String(answer.matches.value) });
}

function siteKey(record: AnswerRecord) {
  const answer = sampleOf(record, 'owner', 'zone-presentation').answer as { address: { key: string } };
  return answer.address.key;
}

function realmName(record: AnswerRecord) {
  const answer = sampleOf(record, 'owner', 'realm-context').answer as { name: { value: string } };
  return answer.name.value;
}

/** Facet labels are recorded for the owner. A visitor read stops at the browse answer. */
async function readRecorded(record: AnswerRecord, persona: AnswerPersona, label: string, state: RecordedState,
  facets: boolean) {
  const sample = sampleOf(record, persona, label);
  const request = recordedBrowseRequest(sample.path);
  const replay = recordedFetch(record, persona, [
    { label, state },
    ...(facets ? [{ label: 'facet-labels', state: 'populated' as const }] : []),
  ], { pathPrefix: BFF_PREFIX });
  disposals.push(replay.dispose);
  const main = browserMainApi('https://recorded.invalid', { fetcher: replay.fetcher });
  const page = await readBrowseAnswer(main, request.realm, request.query);
  if (!facets) return { sample, request, page, built: null };
  const facetList = await readFacetAnswer(main);
  const built = buildBrowsePage({
    page, facets: facetList, base: spaceHref(siteKey(record), 'site', ['browse']), zoneName: realmName(record),
    state: request.state, context: { realm: request.realm, ref: siteKey(record), locale: 'en' },
    locale: 'en', messages,
  });
  return { sample, request, page, built };
}

function expectCatalogue(built: Loaded<BrowseModel>, answer: ZoneBrowsePage) {
  expect(built.ok).toBe(true);
  if (!built.ok) throw new Error('The recorded browse did not build');
  expect(built.data.items.map(item => item.title?.value)).toEqual(answer.items.map(item => item.title.value));
  expect(built.data.items.map(item => item.id)).toEqual(answer.items.map(item => item.id));
  expect(built.data.items.map(item => item.author?.value ?? null)).toEqual(answer.items.map(item =>
    item.primaryCredits.find(credit => credit.displayName)?.displayName ?? null));
  expect(built.data.results).toBe(resultsText(answer));
  if (answer.items[0]) expect(built.data.items[0]?.title?.lang).toBe(answer.items[0].title.language);
  const next = built.data.next ? new URL(built.data.next, 'https://recorded.invalid') : null;
  expect(next?.searchParams.get('cursor') ?? null).toBe(answer.nextCursor);
}

test('the owner browse answer keeps titles, credit, lower-bound count, sorts and the opaque continuation', async () => {
  const { sample, page, built } = await readRecorded(browse, 'owner', 'browse-newest-0', 'populated', true);
  const answer = pageAnswer(sample);
  expect(page.ok).toBe(true);
  if (!built) throw new Error('The owner page was not built');
  expectCatalogue(built, answer);
  if (!built.ok) return;
  expect(built.data.sorts.map(item => [item.sort, item.current])).toEqual([['newest', true], ['updated', false]]);
  expect(built.data.state.text).toBeNull();
  expect(new URL(built.data.next!, 'https://recorded.invalid').searchParams.get('type')).toBe('schema:Recipe');
  expect(built.data.first).toBeNull();
});

test('the owner search answer keeps the recorded text, relevance sort and lower-bound count', async () => {
  const { sample, built } = await readRecorded(browse, 'owner', 'search-relevance-0', 'populated', true);
  const answer = pageAnswer(sample);
  if (!built) throw new Error('The owner page was not built');
  expectCatalogue(built, answer);
  if (!built.ok) return;
  expect(built.data.state.text).toBe(answer.query.text);
  expect(built.data.sorts.map(item => [item.sort, item.current])).toEqual([
    ['relevance', true], ['newest', false], ['updated', false],
  ]);
});

test('the owner empty search stays an exact zero catalogue', async () => {
  const { sample, built } = await readRecorded(browse, 'owner', 'search-no-match', 'empty', true);
  const answer = pageAnswer(sample);
  expect(answer.items).toEqual([]);
  expect(answer.matches).toEqual({ value: 0, kind: 'exact' });
  if (!built) throw new Error('The owner page was not built');
  expectCatalogue(built, answer);
  if (!built.ok) return;
  expect(built.data.items).toEqual([]);
  expect(built.data.next).toBeNull();
  expect(built.data.first).toBeNull();
});

test('the owner unsupported query refusal stays a failure rather than an empty catalogue', async () => {
  const { sample, page, built } = await readRecorded(browse, 'owner', 'unsupported-query-shape', 'error', true);
  expect(sample.status).toBe(400);
  expect(sample.answer).toMatchObject({ code: 'unsupported_query_shape' });
  expect(page).toEqual({ ok: false, failure: 'invalid' });
  expect(built).toBe(page as typeof built);
});

test('the owner next page is the recorded continuation, with an exact count and no further cursor', async () => {
  const { sample, built } = await readRecorded(browse, 'owner', 'browse-newest-1', 'populated', true);
  const answer = pageAnswer(sample);
  expect(answer.matches).toEqual({ value: 21, kind: 'exact' });
  expect(answer.nextCursor).toBeNull();
  if (!built) throw new Error('The owner page was not built');
  expectCatalogue(built, answer);
  if (!built.ok) return;
  expect(built.data.next).toBeNull();
  expect(built.data.first).not.toBeNull();
  expect(new URL(built.data.first!, 'https://recorded.invalid').searchParams.has('cursor')).toBe(false);
});

test('the owner filtered first page keeps the recorded query and continuation', async () => {
  const { sample, built } = await readRecorded(pagination, 'owner', 'browse-newest-first', 'populated', true);
  const answer = pageAnswer(sample);
  if (!built) throw new Error('The owner page was not built');
  expectCatalogue(built, answer);
  if (!built.ok) return;
  expect(built.data.state.text).toBe(answer.query.text);
  expect(built.data.sorts.find(item => item.current)?.sort).toBe('newest');
  expect(built.data.results).toBe(resultsText(answer));
  expect(built.data.first).toBeNull();
});

test('the owner filtered continuation is the recorded terminal page', async () => {
  const { sample, built } = await readRecorded(pagination, 'owner', 'browse-newest-continuation', 'populated', true);
  const answer = pageAnswer(sample);
  expect(answer.items).toHaveLength(1);
  expect(answer.matches).toEqual({ value: 21, kind: 'exact' });
  expect(answer.nextCursor).toBeNull();
  if (!built) throw new Error('The owner page was not built');
  expectCatalogue(built, answer);
  if (!built.ok) return;
  expect(built.data.items.map(item => item.id)).toEqual(answer.items.map(item => item.id));
  expect(built.data.next).toBeNull();
  expect(built.data.first).not.toBeNull();
});

test('a changed cursor query stays the recorded refusal rather than a locally filtered page', async () => {
  const { sample, page, built } = await readRecorded(pagination, 'owner', 'cursor-newest-q-refused', 'error', true);
  expect(sample.status).toBe(400);
  expect(sample.answer).toMatchObject({ code: 'invalid_work_read' });
  expect(page).toEqual({ ok: false, failure: 'invalid' });
  expect(built).toBe(page as typeof built);
});

test('the visitor browse reader keeps titles, language and the opaque continuation', async () => {
  const { sample, page } = await readRecorded(browse, 'visitor', 'browse-newest-0', 'populated', false);
  const answer = pageAnswer(sample);
  expect(page.ok).toBe(true);
  if (!page.ok) return;
  expect(page.data.items.map(item => item.title.value)).toEqual(answer.items.map(item => item.title.value));
  expect(page.data.items.map(item => item.id)).toEqual(answer.items.map(item => item.id));
  expect(page.data.matches).toEqual(answer.matches);
  expect(page.data.nextCursor).toBe(answer.nextCursor);
  expect(page.data.items[0]?.title.language).toBe('en');
});

test('the visitor next page is the recorded terminal continuation', async () => {
  const { sample, page } = await readRecorded(browse, 'visitor', 'browse-newest-1', 'populated', false);
  const answer = pageAnswer(sample);
  expect(page.ok).toBe(true);
  if (!page.ok) return;
  expect(page.data.items.map(item => item.id)).toEqual(answer.items.map(item => item.id));
  expect(page.data.matches).toEqual({ value: 21, kind: 'exact' });
  expect(page.data.nextCursor).toBeNull();
});

test('the visitor unsupported query stays a failure', async () => {
  const { sample, page } = await readRecorded(browse, 'visitor', 'unsupported-query-shape', 'error', false);
  expect(sample.status).toBe(400);
  expect(sample.answer).toMatchObject({ code: 'unsupported_query_shape' });
  expect(page).toEqual({ ok: false, failure: 'invalid' });
});

test('the visitor filtered continuation is the recorded terminal page', async () => {
  const { sample, page } = await readRecorded(pagination, 'visitor', 'browse-newest-continuation', 'populated', false);
  const answer = pageAnswer(sample);
  expect(page.ok).toBe(true);
  if (!page.ok) return;
  expect(page.data.items.map(item => [item.id, item.title.value])).toEqual(answer.items.map(item =>
    [item.id, item.title.value]));
  expect(page.data.matches).toEqual({ value: 21, kind: 'exact' });
  expect(page.data.nextCursor).toBeNull();
});

test('the visitor changed cursor stays the recorded refusal', async () => {
  const { sample, page } = await readRecorded(pagination, 'visitor', 'cursor-newest-q-refused', 'error', false);
  expect(sample.status).toBe(400);
  expect(sample.answer).toMatchObject({ code: 'invalid_work_read' });
  expect(page).toEqual({ ok: false, failure: 'invalid' });
});
