import { afterAll, afterEach, expect, test } from 'bun:test';
import { materializeData } from 'native-i18n';
import { isValidElement, type ReactElement, type ReactNode } from 'react';
import { replaceModule } from '../../tests/support/module-replacement.ts';
import type { AnswerPersona, AnswerRecord } from '../../../../scripts/api/answer-record.ts';
import visualNovels from '../../../../tests/qa/fixtures/outcomes/visual-novels/catalogue-browse-and-search-in-its-zone.json';
import { buildBrowsePage } from '../realm/browse-page.ts';
import type { ZoneBrowsePage } from '../realm/types.ts';
import { recordedFetch, type RecordedState } from '../stories/recorded-fetch.ts';
import { mainBrowseQuery, parseBrowseState } from './browse-state.ts';
import type { BrowseModel } from './browse-view.ts';
import { messages } from './messages.ts';
import {
  BFF_PREFIX, recordedActingSubject, recordedBrowseClient, recordedBrowseSample, recordedBrowseSearch,
  recordedBrowseSelections, recordedRefusalQuery, recordedSiteKey, visualNovelsBrowseSamples,
} from './visual-novels-browse-recorded-page.ts';

const record = visualNovels as AnswerRecord;
const locale = 'en' as const;
const disposals: (() => void)[] = [];
afterEach(() => { for (const dispose of disposals.splice(0)) dispose(); });

const host = { ...(await import('next/headers')) };
const restoreHost = replaceModule(import.meta.resolve('next/headers'), host, {
  cookies: async () => ({ get: () => undefined }),
  headers: async () => new Headers(),
});
const { RealmBrowseRoute } = await import('../realm/routes.tsx');
const { readZoneBrowse } = await import('../realm/read.ts');
const { ZoneBrowse } = await import('./browse.tsx');
afterAll(() => { restoreHost(); });

function authorOf(item: { primaryCredits?: readonly { displayName?: string | null }[] | null }): string | null {
  return item.primaryCredits?.find(credit => credit.displayName)?.displayName ?? null;
}

function resultText(matches: ZoneBrowsePage['matches']): string {
  const t = materializeData(messages, { locale });
  return matches.kind === 'exact' ? t.results(matches.value) : t.resultsAtLeast({ count: String(matches.value) });
}

function findBrowse(node: ReactNode): BrowseModel {
  const found = (function walk(current: ReactNode): ReactElement<{ model: BrowseModel }> | null {
    if (Array.isArray(current)) return current.map(walk).find(Boolean) ?? null;
    if (!isValidElement<{ children?: ReactNode; model?: BrowseModel }>(current)) return null;
    return current.type === ZoneBrowse ? current as ReactElement<{ model: BrowseModel }> : walk(current.props.children);
  })(node);
  if (!found) throw new Error('The production browse route did not render the catalogue');
  return found.props.model;
}

async function visit(persona: AnswerPersona, label: string, state: RecordedState) {
  const replay = recordedFetch(record, persona, recordedBrowseSelections(record, persona, label, state),
    { pathPrefix: BFF_PREFIX });
  disposals.push(replay.dispose);
  const seen: string[] = [];
  const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input instanceof Request ? input : String(input), init);
    const url = new URL(request.url);
    seen.push(url.pathname + url.search);
    return replay.fetcher(request);
  }) as typeof fetch;
  const client = recordedBrowseClient(fetcher, persona, recordedActingSubject(record, persona));
  const rendered = await RealmBrowseRoute({
    params: Promise.resolve({ locale, realm: recordedSiteKey(record) }),
    searchParams: Promise.resolve(recordedBrowseSearch(record, persona, label)),
  }, undefined, client);
  return { model: findBrowse(rendered), seen, sample: recordedBrowseSample(record, persona, label) };
}

function browsePaths(seen: readonly string[]): URL[] {
  return seen.filter(path => path.includes('/modules/browse')).map(path => new URL(path, 'https://recorded.invalid'));
}

test('recorded visual novel browse keeps titles, authors, lower-bound count, sort and opaque continuation', async () => {
  const { model, seen, sample } = await visit('visitor', visualNovelsBrowseSamples.newest, 'populated');
  const answer = sample.answer as ZoneBrowsePage;
  expect(seen.some(path => path.includes('/v1/facets'))).toBe(true);
  expect(model.items.map(item => item.title?.value)).toEqual(answer.items.map(item => item.title.value));
  expect(model.items.map(item => item.id)).toEqual(answer.items.map(item => item.id));
  expect(model.items.map(item => item.author?.value ?? null)).toEqual(answer.items.map(item => authorOf(item)));
  expect(model.items[0]?.title?.lang).toBe(answer.items[0]?.title.language);
  expect(model.results).toBe(resultText(answer.matches));
  expect(model.sorts.map(item => [item.sort, item.current])).toEqual([['newest', true], ['updated', false]]);
  const browse = browsePaths(seen);
  expect(browse).toHaveLength(1);
  expect(browse[0]!.searchParams.has('limit')).toBe(false);
  expect(browse[0]!.searchParams.has('type')).toBe(false);
  expect(browse[0]!.searchParams.get('sort')).toBe('newest');
  const next = new URL(model.next!, 'https://recorded.invalid');
  expect(next.searchParams.get('cursor')).toBe(answer.nextCursor);
  expect(next.searchParams.get('sort')).toBe('newest');
  expect(next.searchParams.has('limit')).toBe(false);
  expect(next.searchParams.has('type')).toBe(false);
  expect(model.first).toBeNull();
});

test('recorded visual novel search keeps the query, relevance sort and titles', async () => {
  const { model, seen, sample } = await visit('visitor', visualNovelsBrowseSamples.relevance, 'populated');
  const answer = sample.answer as ZoneBrowsePage;
  expect(model.state.text).toBe(answer.query.text);
  expect(model.items.map(item => item.title?.value)).toEqual(answer.items.map(item => item.title.value));
  expect(model.results).toBe(resultText(answer.matches));
  expect(model.sorts.map(item => [item.sort, item.current])).toEqual([
    ['relevance', true], ['newest', false], ['updated', false],
  ]);
  const browse = browsePaths(seen);
  expect(browse).toHaveLength(1);
  expect(browse[0]!.searchParams.get('q')).toBe(answer.query.text);
  expect(browse[0]!.searchParams.has('limit')).toBe(false);
  expect(browse[0]!.searchParams.has('type')).toBe(false);
  const next = new URL(model.next!, 'https://recorded.invalid');
  expect(next.searchParams.get('cursor')).toBe(answer.nextCursor);
  expect(next.searchParams.has('limit')).toBe(false);
  expect(next.searchParams.has('type')).toBe(false);
});

test('recorded visual novel updated sort stays current for the searched page', async () => {
  const { model, seen, sample } = await visit('visitor', visualNovelsBrowseSamples.updated, 'populated');
  const answer = sample.answer as ZoneBrowsePage;
  expect(model.sorts.map(item => [item.sort, item.current])).toEqual([
    ['relevance', false], ['newest', false], ['updated', true],
  ]);
  expect(model.items[0]?.id).toBe(answer.items[0]?.id);
  expect(model.results).toBe(resultText(answer.matches));
  const browse = browsePaths(seen);
  expect(browse[0]!.searchParams.get('sort')).toBe('updated');
  expect(browse[0]!.searchParams.has('limit')).toBe(false);
  expect(browse[0]!.searchParams.has('type')).toBe(false);
});

test('recorded visual novel continuation keeps the last title and drops the next cursor', async () => {
  const { model, sample } = await visit('visitor', visualNovelsBrowseSamples.continuation, 'populated');
  const answer = sample.answer as ZoneBrowsePage;
  expect(answer.items).toHaveLength(1);
  expect(model.items.map(item => [item.id, item.title?.value])).toEqual(answer.items.map(item => [item.id, item.title.value]));
  expect(model.results).toBe(resultText(answer.matches));
  expect(answer.matches).toEqual({ value: 21, kind: 'exact' });
  expect(model.next).toBeNull();
  const first = new URL(model.first!, 'https://recorded.invalid');
  expect(first.searchParams.has('cursor')).toBe(false);
  expect(first.searchParams.get('sort')).toBe('newest');
  expect(first.searchParams.has('limit')).toBe(false);
  expect(first.searchParams.has('type')).toBe(false);
});

test('the production browse page does not send the recorded unsupported query', () => {
  const sample = recordedBrowseSample(record, 'visitor', visualNovelsBrowseSamples.refusal);
  const url = new URL(sample.path, 'https://recorded.invalid');
  expect(sample.status).toBe(400);
  expect(url.searchParams.has('q')).toBe(false);
  expect(url.searchParams.get('limit')).toBe('10');
  expect(url.searchParams.get('type')).toBe('https://schema.org/VideoGame');
  expect(mainBrowseQuery(parseBrowseState({ sort: 'relevance' }))).toEqual({});
});

test('the recorded unsupported query refusal stays a failure rather than an empty catalogue', async () => {
  const sample = recordedBrowseSample(record, 'visitor', visualNovelsBrowseSamples.refusal);
  const replay = recordedFetch(record, 'visitor', [{ label: visualNovelsBrowseSamples.refusal, state: 'error' }],
    { pathPrefix: BFF_PREFIX });
  disposals.push(replay.dispose);
  const client = recordedBrowseClient(replay.fetcher, 'visitor');
  const realm = new URL(sample.path, 'https://recorded.invalid').pathname.split('/')[3]!;
  const page = await readZoneBrowse(realm, locale, recordedRefusalQuery(sample), client.main);
  const built = buildBrowsePage({
    page, facets: { ok: false, failure: 'unavailable' }, base: '/browse', zoneName: 'recorded',
    state: parseBrowseState({}), context: { realm, ref: recordedSiteKey(record), locale }, locale, messages,
  });
  expect(sample.answer).toMatchObject({ code: 'unsupported_query_shape', title: 'Relevance needs text' });
  // The shared adapter classifies 400 as invalid and does not keep the problem body.
  expect(page).toEqual({ ok: false, failure: 'invalid' });
  expect(page).not.toHaveProperty('problem');
  if (page.ok || built.ok) throw new Error('The refusal became a catalogue page');
  expect(built).toBe(page);
});

test('the recorded member empty search stays an empty page with an exact zero count', async () => {
  const { model, seen, sample } = await visit('member', visualNovelsBrowseSamples.empty, 'empty');
  const answer = sample.answer as ZoneBrowsePage;
  expect(answer.items).toEqual([]);
  expect(answer.matches).toEqual({ value: 0, kind: 'exact' });
  expect(answer.nextCursor).toBeNull();
  expect(seen.some(path => path.includes('/v1/facets'))).toBe(true);
  expect(seen.some(path => path.includes('/session-agent'))).toBe(true);
  expect(seen.some(path => path.includes('/member-ban'))).toBe(true);
  expect(model.items).toEqual([]);
  expect(model.results).toBe(resultText(answer.matches));
  expect(model.next).toBeNull();
  expect(model.state.text).toBe(answer.query.text);
  expect(browsePaths(seen)[0]!.searchParams.has('limit')).toBe(false);
  expect(browsePaths(seen)[0]!.searchParams.has('type')).toBe(false);
});
