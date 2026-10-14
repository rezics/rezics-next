import { afterAll, afterEach, expect, spyOn, test } from 'bun:test';
import { replaceModule } from '../../tests/support/module-replacement.ts';
import '../../tests/support/official-package-fixture.ts';
import { isValidElement, type ReactElement, type ReactNode } from 'react';
import { materializeData } from 'native-i18n';
import type { AnswerPersona, AnswerRecord } from '../../../../scripts/api/answer-record.ts';
import browseFixture from '../../../../tests/qa/fixtures/outcomes/books/catalogue-browse-and-search-in-its-zone.json';
import { BFF_PREFIX, browserMainApi } from '../api/browser.ts';
import { ACCESS_COOKIE, SESSION_KEY_COOKIE } from '../auth/cookies.ts';
import { buildBrowsePage } from '../realm/browse-page.ts';
import { readBrowseAnswer, readFacetAnswer } from '../realm/browse-page-read.ts';
import type { Loaded, ZoneBrowsePage } from '../realm/types.ts';
import { recordedFetch, type RecordedState } from '../stories/recorded-fetch.ts';
import { spaceHref } from '../address/path.ts';
import type { BrowseModel } from './browse-view.ts';
import { messages } from './messages.ts';
import { recordedBrowseRequest } from './books-browse-recorded-page.ts';

const browse = browseFixture as AnswerRecord;
const disposals: (() => void)[] = [];
afterEach(() => { for (const dispose of disposals.splice(0)) dispose(); });

function sampleOf(persona: AnswerPersona, label: string) {
  const sample = browse.personas[persona].find(item => item.label === label);
  if (!sample) throw new Error(`Missing recorded Books answer: ${persona}/${label}`);
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

function siteKey() {
  const answer = sampleOf('owner', 'zone-presentation').answer as { address: { key: string } };
  return answer.address.key;
}

function realmName() {
  const answer = sampleOf('owner', 'realm-context').answer as { name: { value: string } };
  return answer.name.value;
}

/** Facet labels are recorded for the owner. A visitor read stops at the browse answer. */
async function readRecorded(persona: AnswerPersona, label: string, state: RecordedState, facets: boolean) {
  const sample = sampleOf(persona, label);
  const request = recordedBrowseRequest(sample.path);
  const replay = recordedFetch(browse, persona, [
    { label, state },
    ...(facets ? [{ label: 'facet-labels', state: 'populated' as const }] : []),
  ], { pathPrefix: BFF_PREFIX });
  disposals.push(replay.dispose);
  const main = browserMainApi('https://recorded.invalid', { fetcher: replay.fetcher });
  const page = await readBrowseAnswer(main, request.realm, request.query);
  if (!facets) return { sample, request, page, built: null };
  const facetList = await readFacetAnswer(main);
  const built = buildBrowsePage({
    page, facets: facetList, base: spaceHref(siteKey(), 'site', ['browse']), zoneName: realmName(),
    state: request.state, context: { realm: request.realm, ref: siteKey(), locale: 'en' },
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
  expect(next?.searchParams.has('limit') ?? false).toBe(false);
  expect(next?.searchParams.has('language') ?? false).toBe(false);
  expect(next?.searchParams.has('type') ?? false).toBe(false);
}

test('the owner browse answer keeps titles, credit, the lower-bound count and the opaque continuation', async () => {
  const { sample, request, page, built } = await readRecorded('owner', 'page-browse-default', 'populated', true);
  const answer = pageAnswer(sample);
  expect(request.query).toEqual({});
  expect(page.ok).toBe(true);
  if (!built) throw new Error('The owner page was not built');
  expectCatalogue(built, answer);
  if (!built.ok) return;
  expect(built.data.sorts.map(item => [item.sort, item.current])).toEqual([['newest', true], ['updated', false]]);
  expect(built.data.state.text).toBeNull();
  expect(built.data.first).toBeNull();
  expect(answer.nextCursor).toBeTruthy();
});

test('the owner search answer keeps the recorded text, relevance sort and lower-bound count', async () => {
  const { sample, request, built } = await readRecorded('owner', 'page-search-relevance', 'populated', true);
  const answer = pageAnswer(sample);
  expect(request.query).toEqual({ q: answer.query.text, sort: 'relevance' });
  if (!built) throw new Error('The owner page was not built');
  expectCatalogue(built, answer);
  if (!built.ok) return;
  expect(built.data.state.text).toBe(answer.query.text);
  expect(built.data.sorts.map(item => [item.sort, item.current])).toEqual([
    ['relevance', true], ['newest', false], ['updated', false],
  ]);
});

test('the owner empty search stays an exact zero catalogue', async () => {
  const { sample, built } = await readRecorded('owner', 'page-search-no-match', 'empty', true);
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

test('the owner continuation is the recorded terminal page and keeps the cursor', async () => {
  const { sample, request, built } = await readRecorded('owner', 'page-browse-default-continuation-1', 'populated', true);
  const answer = pageAnswer(sample);
  expect(request.query).toEqual({ cursor: new URL(sample.path, 'https://recorded.invalid').searchParams.get('cursor') });
  expect(answer.matches).toEqual({ value: 21, kind: 'exact' });
  expect(answer.nextCursor).toBeNull();
  if (!built) throw new Error('The owner page was not built');
  expectCatalogue(built, answer);
  if (!built.ok) return;
  expect(built.data.next).toBeNull();
  expect(built.data.first).not.toBeNull();
  expect(new URL(built.data.first!, 'https://recorded.invalid').searchParams.has('cursor')).toBe(false);
});

test('the owner unsupported query refusal stays a failure rather than an empty catalogue', async () => {
  const { sample, request, page, built } = await readRecorded('owner', 'unsupported-query-shape', 'error', true);
  expect(sample.status).toBe(400);
  expect(sample.answer).toMatchObject({ code: 'unsupported_query_shape' });
  expect(request.query.limit).toBe(10);
  expect(request.query.sort).toBe('relevance');
  expect(page).toEqual({ ok: false, failure: 'invalid' });
  expect(built).toBe(page as typeof built);
});

test('the visitor browse reader keeps titles, language and the opaque continuation', async () => {
  const { sample, page } = await readRecorded('visitor', 'page-browse-default', 'populated', false);
  const answer = pageAnswer(sample);
  expect(page.ok).toBe(true);
  if (!page.ok) return;
  expect(page.data.items.map(item => item.title.value)).toEqual(answer.items.map(item => item.title.value));
  expect(page.data.items.map(item => item.id)).toEqual(answer.items.map(item => item.id));
  expect(page.data.matches).toEqual(answer.matches);
  expect(page.data.nextCursor).toBe(answer.nextCursor);
  expect(page.data.items[0]?.title.language).toBe('en');
});

test('the visitor unsupported query stays a failure', async () => {
  const { sample, page } = await readRecorded('visitor', 'unsupported-query-shape', 'error', false);
  expect(sample.status).toBe(400);
  expect(sample.answer).toMatchObject({ code: 'unsupported_query_shape' });
  expect(page).toEqual({ ok: false, failure: 'invalid' });
});

let persona: AnswerPersona = 'visitor';
const host = { ...(await import('next/headers')) };
const restoreHost = replaceModule(import.meta.resolve('next/headers'), host, {
  cookies: async () => ({ get: (name: string) => persona === 'visitor' ? undefined
    : name === ACCESS_COOKIE ? { value: `recorded-${persona}` }
      : name === SESSION_KEY_COOKIE ? { value: '00000000-0000-4000-8000-000000000001' } : undefined }),
  headers: async () => new Headers(),
});
const api = { ...(await import('../api/main.ts')) };
let fetcher: typeof fetch;
const restoreApi = replaceModule(import.meta.resolve('../api/main.ts'), api, {
  mainApiWithToken: (token: string | undefined) => api.mainApiWithToken(token, { fetcher }),
});
const { ZoneSiteRoute } = await import('./site-route.tsx');
const { ZoneBrowse } = await import('./browse.tsx');
const { RealmBrowseRoute } = await import('../realm/routes.tsx');
afterAll(() => { restoreApi(); restoreHost(); });

const personas = ['visitor', 'stranger', 'member', 'owner', 'moderator', 'operator'] as const;
const pages = ['page-browse-default', 'page-search-default', 'page-search-relevance', 'page-search-no-match'] as const;

function productionSample(label: string) {
  return sampleOf(persona, label);
}

function searchFrom(label: string) {
  return Object.fromEntries(new URL(productionSample(label).path, 'https://recorded.invalid').searchParams);
}

function replay(labels: string[]) {
  const transport = recordedFetch(browse, persona, labels.map(label => ({ label,
    state: productionSample(label).status >= 400 ? 'error' as const : 'populated' as const })));
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

function frameLabels(page: string, routes = 'frame-routes') {
  return ['frame-address', 'frame-presentation', routes, 'frame-realm-header', 'frame-facets', page,
    ...(persona === 'visitor' ? [] : ['frame-session-agent', 'frame-person-preferences', 'frame-joining', 'frame-member-ban',
      'frame-follow', 'frame-platform-access'])];
}

/** Labels the browse route reaches. The site route's `routes` read is absent here. */
function routeLabels(page: string) {
  return frameLabels(page).filter(label => label !== 'frame-routes');
}

function addressKey() {
  const key = new URL(productionSample('frame-address').path, 'https://recorded.invalid').searchParams.get('key');
  if (!key) throw new Error('Recorded address has no site key');
  return key;
}

async function visit(page: string, routes = 'frame-routes') {
  const seen = replay(frameLabels(page, routes));
  const rendered = await ZoneSiteRoute({
    params: Promise.resolve({ locale: 'en', space: addressKey(), path: ['browse'] }),
    searchParams: Promise.resolve(searchFrom(page)),
  });
  return { ...seen, model: findBrowse(rendered) };
}

function expectRecordedPage(model: BrowseModel, answer: ZoneBrowsePage) {
  expect(model.items.map(item => item.id)).toEqual(answer.items.map(item => item.id));
  expect(model.items.map(item => item.title?.value)).toEqual(answer.items.map(item => item.title.value));
  expect(model.items.map(item => item.author?.value ?? null)).toEqual(answer.items.map(item =>
    item.primaryCredits.find(credit => credit.displayName)?.displayName ?? null));
  expect(model.results).toBe(resultsText(answer));
  expect(model.state.text).toBe(answer.query.text);
  const next = model.next ? new URL(model.next, 'https://recorded.invalid') : null;
  expect(next?.searchParams.get('cursor') ?? null).toBe(answer.nextCursor);
  expect(next?.searchParams.has('limit') ?? false).toBe(false);
  expect(next?.searchParams.has('language') ?? false).toBe(false);
  const sorts: BrowseModel['sorts'][number]['sort'][] = answer.query.text
    ? ['relevance', 'newest', 'updated'] : ['newest', 'updated'];
  expect(model.sorts.map(item => item.sort)).toEqual(sorts);
  expect(model.sorts.find(item => item.current)?.sort).toBe(answer.query.sort);
}

function expectBrowseCalls(requests: { path: string; query: Record<string, string>; authorization: string | null }[],
  page: string) {
  const browseCalls = requests.filter(request => request.path.endsWith('/modules/browse'));
  expect(browseCalls.length).toBeGreaterThan(0);
  expect(browseCalls.every(request => request.authorization === null
    && request.query.limit === undefined && request.query.language === undefined
    && request.query.type === undefined && request.query.actingSubject === undefined)).toBe(true);
  expect(browseCalls.at(-1)?.query).toEqual(searchFrom(page));
  const actor = persona === 'visitor' ? undefined : (productionSample('frame-session-agent').answer as {
    sessionAgent: { actingSubject: string };
  }).sessionAgent.actingSubject;
  const realmId = new URL(productionSample('frame-realm-header').path, 'https://recorded.invalid').pathname.split('/')[3];
  expect(requests.filter(request => request.path === `/v1/realms/${realmId}`)
    .every(request => request.authorization === null && Object.keys(request.query).length === 0)).toBe(true);
  const presentations = requests.filter(request => request.path.endsWith('/presentation'));
  expect(presentations.every(request => request.query.actingSubject === actor
    && request.authorization === (actor ? `Bearer recorded-${persona}` : null))).toBe(true);
  return actor;
}

for (const who of personas) {
  for (const page of pages) {
    test(`${who} production ${page} keeps the recorded catalogue and sends no limit or language`, async () => {
      persona = who;
      const answer = pageAnswer(productionSample(page));
      const { requests, gaps, model } = await visit(page);
      expect(gaps).toEqual([]);
      expectRecordedPage(model, answer);
      expectBrowseCalls(requests, page);
      const routeAt = requests.findIndex(request => request.path.endsWith('/routes'));
      const browseAt = requests.findIndex(request => request.path.endsWith('/modules/browse'));
      if (routeAt >= 0) expect(routeAt).toBeLessThan(browseAt);
    });
  }

  test(`${who} production continuation keeps the recorded cursor on the routes read and the next page`, async () => {
    persona = who;
    const page = 'page-browse-default-continuation-1';
    const answer = pageAnswer(productionSample(page));
    const cursor = new URL(productionSample(page).path, 'https://recorded.invalid').searchParams.get('cursor');
    expect(cursor).toBeTruthy();
    expect(answer.nextCursor).toBeNull();
    const { requests, gaps, model } = await visit(page, 'page-browse-default-zone-continuation');
    expect(gaps).toEqual([]);
    expectRecordedPage(model, answer);
    expectBrowseCalls(requests, page);
    const actor = who === 'visitor' ? undefined : (productionSample('frame-session-agent').answer as {
      sessionAgent: { actingSubject: string };
    }).sessionAgent.actingSubject;
    const routes = requests.filter(request => request.path.endsWith('/routes'));
    expect(routes.some(request => request.query.path === 'browse' && request.query.cursor === cursor
      && request.query.actingSubject === actor)).toBe(true);
    expect(model.first).not.toBeNull();
    expect(model.next).toBeNull();
  });

  for (const page of pages) {
    test(`${who} production route ${page} reads the recorded catalogue through the supplied client`, async () => {
      persona = who;
      const answer = pageAnswer(productionSample(page));
      const { requests, gaps, model } = await visitInjected(page);
      expect(gaps).toEqual([]);
      expectRecordedPage(model, answer);
      expectBrowseCalls(requests, page);
      expect(requests.some(request => request.path.endsWith('/routes'))).toBe(false);
    });
  }
}

async function visitInjected(page: string) {
  const seen = replay(routeLabels(page));
  const actor = persona === 'visitor' ? undefined : (productionSample('frame-session-agent').answer as {
    sessionAgent: { actingSubject: string };
  }).sessionAgent.actingSubject;
  const main = api.mainApiWithToken(undefined, { fetcher });
  const rendered = await RealmBrowseRoute({
    params: Promise.resolve({ locale: 'en', realm: addressKey() }),
    searchParams: Promise.resolve(searchFrom(page)),
  }, undefined, {
    main,
    personal: actor ? api.mainApiWithToken(`recorded-${persona}`, { fetcher }) : main,
    actingSubject: actor,
    signedIn: persona !== 'visitor',
  });
  return { ...seen, model: findBrowse(rendered) };
}
