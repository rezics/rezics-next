import { afterAll, afterEach, expect, spyOn, test } from 'bun:test';
import { isValidElement, type ReactElement, type ReactNode } from 'react';
import { materializeData } from 'native-i18n';
import type { AnswerPersona, AnswerRecord } from '../../../../scripts/api/answer-record.ts';
import manga from '../../../../tests/qa/fixtures/outcomes/manga/catalogue-browse-and-search-in-its-zone.json';
import { uiLocales, type UiLocale } from '../../i18n/define.ts';
import { replaceModule } from '../../tests/support/module-replacement.ts';
import { BFF_PREFIX, browserMainApi } from '../api/browser.ts';
import { ACCESS_COOKIE, SESSION_KEY_COOKIE } from '../auth/cookies.ts';
import { readBrowseAnswer } from '../realm/browse-page-read.ts';
import type { FacetList, ZoneBrowsePage } from '../realm/types.ts';
import { recordedFetch } from '../stories/recorded-fetch.ts';
import type { BrowseModel } from './browse-view.ts';
import { messages } from './messages.ts';
import {
  mangaBrowsePersonas, recordedActingSubject, recordedFrameLabels, recordedSample, recordedSearch, recordedSiteKey,
} from './manga-browse-recorded-page.ts';

const record = manga as AnswerRecord;
const disposals: (() => void)[] = [];
afterEach(() => { for (const dispose of disposals.splice(0)) dispose(); });

function pageAnswer(persona: AnswerPersona, label: string): ZoneBrowsePage {
  return recordedSample(record, persona, label).answer as ZoneBrowsePage;
}

function resultsText(answer: ZoneBrowsePage): string {
  const t = materializeData(messages, { locale: 'en' });
  return answer.matches.kind === 'exact'
    ? t.results(answer.matches.value)
    : t.resultsAtLeast({ count: String(answer.matches.value) });
}

let persona: AnswerPersona = 'visitor';
const host = { ...(await import('next/headers')) };
const restoreHost = replaceModule(import.meta.resolve('next/headers'), host, {
  cookies: async () => ({ get: (name: string) => persona === 'visitor' ? undefined
    : name === ACCESS_COOKIE ? { value: `recorded-${persona}` }
      : name === SESSION_KEY_COOKIE ? { value: '00000000-0000-4000-8000-000000000001' } : undefined }),
  headers: async () => new Headers(),
});
const api = { ...(await import('../api/main.ts')) };
let fetcher: typeof fetch = globalThis.fetch;
const restoreApi = replaceModule(import.meta.resolve('../api/main.ts'), api, {
  mainApiWithToken: (token: string | undefined) => api.mainApiWithToken(token, { fetcher }),
});
const { ZoneSiteRoute } = await import('./site-route.tsx');
const { ZoneBrowse } = await import('./browse.tsx');
const { RealmBrowseRoute } = await import('../realm/routes.tsx');
afterAll(() => { restoreApi(); restoreHost(); });

const pages = ['page-browse-default', 'page-browse-newest', 'page-search-default', 'page-search-no-match'] as const;

function replay(labels: string[]) {
  const transport = recordedFetch(record, persona, labels.map(label => ({
    label, state: recordedSample(record, persona, label).status >= 400 ? 'error' as const : 'populated' as const,
  })));
  disposals.push(transport.dispose);
  const requests: { method: string; path: string; query: Record<string, string>; authorization: string | null }[] = [];
  const gaps: string[] = [];
  fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    requests.push({ method: request.method, path: url.pathname, query: Object.fromEntries(url.searchParams),
      authorization: request.headers.get('authorization') });
    try { return await transport.fetcher(input, init); }
    catch (error) { gaps.push(error instanceof Error ? error.message : String(error)); throw error; }
  }) as typeof fetch;
  const escaped = spyOn(globalThis, 'fetch').mockImplementation(Object.assign(fetcher, {
    preconnect: globalThis.fetch.preconnect,
  }));
  disposals.push(() => escaped.mockRestore());
  return { requests, gaps };
}

function findBrowse(node: ReactNode): BrowseModel {
  const found = (function walk(current: ReactNode): ReactElement<{ model: BrowseModel }> | null {
    if (Array.isArray(current)) return current.map(walk).find(Boolean) ?? null;
    if (!isValidElement<{ children?: ReactNode; model?: BrowseModel }>(current)) return null;
    return current.type === ZoneBrowse
      ? current as ReactElement<{ model: BrowseModel }>
      : walk(current.props.children);
  })(node);
  if (!found) throw new Error('The production browse route did not render the catalogue');
  return found.props.model;
}

function expectRecordedPage(model: BrowseModel, answer: ZoneBrowsePage) {
  expect(model.items.map(item => item.id)).toEqual(answer.items.map(item => item.id));
  expect(model.items.map(item => item.title?.value)).toEqual(answer.items.map(item => item.title.value));
  expect(model.items.map(item => item.author?.value ?? null)).toEqual(answer.items.map(item =>
    item.primaryCredits.find(credit => credit.displayName)?.displayName ?? null));
  expect(model.results).toBe(resultsText(answer));
  expect(model.state.text).toBe(answer.query.text);
  expect(model.next).toBeNull();
  expect(model.first).toBeNull();
  const sorts: BrowseModel['sorts'][number]['sort'][] = answer.query.text
    ? ['relevance', 'newest', 'updated'] : ['newest', 'updated'];
  expect(model.sorts.map(item => item.sort)).toEqual(sorts);
  expect(model.sorts.find(item => item.current)?.sort).toBe(answer.query.sort);
}

async function visit(page: string) {
  const seen = replay(recordedFrameLabels(record, persona, page));
  const rendered = await ZoneSiteRoute({
    params: Promise.resolve({ locale: 'en', space: recordedSiteKey(record), path: ['browse'] }),
    searchParams: Promise.resolve(recordedSearch(record, persona, page)),
  });
  return { ...seen, model: findBrowse(rendered) };
}

async function visitInjected(page: string) {
  const seen = replay(recordedFrameLabels(record, persona, page).filter(label => label !== 'frame-routes'));
  const actor = recordedActingSubject(record, persona);
  const main = api.mainApiWithToken(undefined, { fetcher });
  const rendered = await RealmBrowseRoute({
    params: Promise.resolve({ locale: 'en', realm: recordedSiteKey(record) }),
    searchParams: Promise.resolve(recordedSearch(record, persona, page)),
  }, undefined, {
    main,
    personal: actor ? api.mainApiWithToken(`recorded-${persona}`, { fetcher }) : main,
    actingSubject: actor,
    signedIn: persona !== 'visitor',
  });
  return { ...seen, model: findBrowse(rendered) };
}

function expectProductionRequests(requests: { path: string; query: Record<string, string>; authorization: string | null }[],
  page: string) {
  const browseCalls = requests.filter(request => request.path.endsWith('/modules/browse'));
  expect(browseCalls.length).toBeGreaterThan(0);
  expect(browseCalls.every(request => request.authorization === null
    && request.query.limit === undefined && request.query.language === undefined
    && request.query.publicationYear === undefined)).toBe(true);
  expect(browseCalls.at(-1)?.query).toEqual(recordedSearch(record, persona, page));
  const actor = recordedActingSubject(record, persona);
  const realmId = new URL(recordedSample(record, persona, 'frame-realm-header').path, 'https://recorded.invalid')
    .pathname.split('/')[3];
  expect(requests.filter(request => request.path === `/v1/realms/${realmId}`)
    .every(request => request.authorization === null && Object.keys(request.query).length === 0)).toBe(true);
  const presentations = requests.filter(request => request.path.endsWith('/presentation'));
  expect(presentations.every(request => request.query.actingSubject === actor
    && request.authorization === (actor ? `Bearer recorded-${persona}` : null))).toBe(true);
}

test('the recorded unsupported query stays a failure rather than an empty catalogue', async () => {
  for (const who of mangaBrowsePersonas) {
    const sample = recordedSample(record, who, 'unsupported-query-shape');
    expect(sample.status).toBe(400);
    expect(sample.answer).toMatchObject({ code: 'unsupported_query_shape', title: 'Relevance needs text' });
    const replay = recordedFetch(record, who, [{ label: 'unsupported-query-shape', state: 'error' }],
      { pathPrefix: BFF_PREFIX });
    disposals.push(replay.dispose);
    const main = browserMainApi('https://recorded.invalid', { fetcher: replay.fetcher });
    const realm = new URL(sample.path, 'https://recorded.invalid').pathname.split('/')[3]!;
    const page = await readBrowseAnswer(main, realm, { sort: 'relevance', limit: 3 });
    expect(page).toEqual({ ok: false, failure: 'invalid', status: sample.status, problem: sample.answer });
  }
});

for (const who of mangaBrowsePersonas) {
  for (const page of pages) {
    test(`${who} production ${page} keeps the recorded catalogue`, async () => {
      persona = who;
      const answer = pageAnswer(who, page);
      const { requests, gaps, model } = await visit(page);
      expect(gaps).toEqual([]);
      expectRecordedPage(model, answer);
      expectProductionRequests(requests, page);
      const routeAt = requests.findIndex(request => request.path.endsWith('/routes'));
      const browseAt = requests.findIndex(request => request.path.endsWith('/modules/browse'));
      expect(routeAt).toBeGreaterThanOrEqual(0);
      expect(routeAt).toBeLessThan(browseAt);
      expect(requests.find(request => request.path.endsWith('/routes'))?.query.path).toBe('browse');
    });

    test(`${who} production route ${page} reads the catalogue through the supplied client`, async () => {
      persona = who;
      const answer = pageAnswer(who, page);
      const { requests, gaps, model } = await visitInjected(page);
      expect(gaps).toEqual([]);
      expectRecordedPage(model, answer);
      expectProductionRequests(requests, page);
      expect(requests.some(request => request.path.endsWith('/routes'))).toBe(false);
    });
  }
}

test('the owner facet labels stay the headings in every interface locale', async () => {
  persona = 'owner';
  const facets = recordedSample(record, 'owner', 'frame-facets').answer as FacetList;
  const concept = facets.facets.find(item => item.name === 'concept' && item.current);
  if (!concept) throw new Error('The recorded facet list has no current concept facet');
  for (const locale of uiLocales) {
    const seen = replay(recordedFrameLabels(record, 'owner', 'page-browse-default'));
    const rendered = await ZoneSiteRoute({
      params: Promise.resolve({ locale, space: recordedSiteKey(record), path: ['browse'] }),
      searchParams: Promise.resolve({}),
    });
    expect(seen.gaps).toEqual([]);
    const model = findBrowse(rendered);
    expect(model.groups.find(group => group.facet === 'concept')?.label).toBe(concept.labels[locale as UiLocale]);
  }
});
