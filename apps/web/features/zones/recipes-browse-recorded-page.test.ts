import { afterAll, afterEach, expect, spyOn, test } from 'bun:test';
import { replaceModule } from '../../tests/support/module-replacement.ts';
import '../../tests/support/official-package-fixture.ts';
import { isValidElement, type ReactElement, type ReactNode } from 'react';
import { materializeData } from 'native-i18n';
import type { AnswerPersona, AnswerRecord } from '../../../../scripts/api/answer-record.ts';
import browseFixture from '../../../../tests/qa/fixtures/outcomes/recipes/catalogue-browse-and-search-in-its-zone.json';
import paginationFixture from '../../../../tests/qa/fixtures/outcomes/recipes/catalogue-pagination-in-its-zone.json';
import { spaceHref } from '../address/path.ts';
import { BFF_PREFIX, browserMainApi } from '../api/browser.ts';
import { ACCESS_COOKIE, SESSION_KEY_COOKIE } from '../auth/cookies.ts';
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

/** A recorded cursor is null when the page ends; a query omits it. Both mean the same absence. */
function expectSameCursor(actual: string | null | undefined, expected: string | null | undefined) {
  expect(actual ?? null).toBe(expected ?? null);
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

// API probes retain coverage independently of the production route's reached states.
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

let persona: AnswerPersona = 'visitor';
const observedAddresses: { key: string | null; authorization: string | null; scope: string | null; actingSubject: string | null }[] = [];
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
  return sampleOf(browse, persona, label);
}

function searchFrom(label: string) {
  return Object.fromEntries(new URL(productionSample(label).path, 'https://recorded.invalid').searchParams);
}

function searchFromRecord(record: AnswerRecord, label: string) {
  return Object.fromEntries(new URL(sampleOf(record, persona, label).path, 'https://recorded.invalid').searchParams);
}

function replay(labels: string[], record: AnswerRecord = browse) {
  const transport = recordedFetch(record, persona, labels.map(label => ({ label,
    state: sampleOf(record, persona, label).status >= 400 ? 'error' : 'populated' })));
  disposals.push(transport.dispose);
  const requests: { method: string; path: string; query: Record<string, string>; authorization: string | null }[] = [];
  const gaps: string[] = [];
  fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    const seen = { method: request.method, path: url.pathname, query: Object.fromEntries(url.searchParams),
      authorization: request.headers.get('authorization') };
    requests.push(seen);
    if (url.pathname.endsWith('/addresses/resolve')) observedAddresses.push({
      key: url.searchParams.get('key'), authorization: seen.authorization, scope: url.searchParams.get('scope'),
      actingSubject: url.searchParams.get('actingSubject'),
    });
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

function followStateLabel(record: AnswerRecord) {
  return record.personas[persona].some(sample => sample.label === 'frame-follow-state') ? ['frame-follow-state'] : [];
}

function frameLabels(page: string) {
  return ['frame-address', 'frame-presentation', 'frame-routes', 'frame-realm-header', 'frame-facets', page,
    ...(persona === 'visitor' ? [] : ['frame-session-agent', 'frame-person-preferences', 'frame-joining', 'frame-member-ban',
      'frame-follow', 'frame-platform-access', ...followStateLabel(browse)])];
}

/** Labels the browse route reaches. The site route's `routes` read is absent here. */
function routeLabels(page: string) {
  return frameLabels(page).filter(label => label !== 'frame-routes');
}

function addressKey(record: AnswerRecord, label: string) {
  const key = new URL(sampleOf(record, persona, label).path, 'https://recorded.invalid').searchParams.get('key');
  if (!key) throw new Error('Recorded address has no site key');
  return key;
}

async function visitRoute(record: AnswerRecord, labels: string[], page: string, spaceLabel: string) {
  const seen = replay(labels, record);
  const rendered = await ZoneSiteRoute({
    params: Promise.resolve({ locale: 'en', space: addressKey(record, spaceLabel), path: ['browse'] }),
    searchParams: Promise.resolve(searchFromRecord(record, page)),
  });
  return { ...seen, model: findBrowse(rendered) };
}

async function visit(page: string) {
  return visitRoute(browse, frameLabels(page), page, 'frame-address');
}

function actingSubject(record: AnswerRecord) {
  if (persona === 'visitor') return undefined;
  return (sampleOf(record, persona, 'frame-session-agent').answer as {
    sessionAgent: { actingSubject: string };
  }).sessionAgent.actingSubject;
}

function expectSiteGraph(requests: { method: string; path: string; query: Record<string, string>; authorization: string | null }[],
  record: AnswerRecord, spaceLabel: string) {
  const actor = actingSubject(record);
  const browseCalls = requests.filter(request => request.path.endsWith('/modules/browse'));
  expect(browseCalls.length).toBeGreaterThan(0);
  expect(browseCalls.every(request => request.authorization === null
    && request.query.limit === undefined && request.query.language === undefined)).toBe(true);
  const presentations = requests.filter(request => request.path.endsWith('/presentation'));
  expect(presentations.length).toBeGreaterThan(0);
  expect(presentations.every(request => request.query.actingSubject === actor
    && request.authorization === (actor ? `Bearer recorded-${persona}` : null))).toBe(true);
  // Anonymous address resolution is cached for the page. A later visit of the same key sends no second lookup.
  const key = addressKey(record, spaceLabel);
  const addresses = requests.filter(request => request.path.endsWith('/addresses/resolve'));
  expect(addresses.every(request => request.authorization === null && request.query.actingSubject === undefined
    && request.query.scope === 'space' && request.query.key === key)).toBe(true);
  expect(observedAddresses.some(item => item.key === key && item.authorization === null
    && item.scope === 'space' && item.actingSubject === null)).toBe(true);
  const routeAt = requests.findIndex(request => request.path.endsWith('/routes'));
  const browseAt = requests.findIndex(request => request.path.endsWith('/modules/browse'));
  expect(routeAt).toBeGreaterThanOrEqual(0);
  expect(routeAt).toBeLessThan(browseAt);
  return actor;
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

for (const who of personas) {
  for (const page of pages) {
    test(`${who} production ${page} keeps the recorded catalogue and sends no limit or language`, async () => {
      persona = who;
      const answer = pageAnswer(productionSample(page));
      const { requests, gaps, model } = await visit(page);
      expect(gaps).toEqual([]);
      expectRecordedPage(model, answer);
      const browseCalls = requests.filter(request => request.path.endsWith('/modules/browse'));
      expect(browseCalls.length).toBeGreaterThan(0);
      expect(browseCalls.every(request => request.authorization === null
        && request.query.limit === undefined && request.query.language === undefined)).toBe(true);
      expect(browseCalls.at(-1)?.query).toEqual(searchFrom(page));
      const actor = who === 'visitor' ? undefined : (productionSample('frame-session-agent').answer as {
        sessionAgent: { actingSubject: string };
      }).sessionAgent.actingSubject;
      const realmId = new URL(productionSample('frame-realm-header').path, 'https://recorded.invalid').pathname.split('/')[3];
      expect(requests.filter(request => request.path === `/v1/realms/${realmId}`)
        .every(request => request.authorization === null && Object.keys(request.query).length === 0)).toBe(true);
      const presentations = requests.filter(request => request.path.endsWith('/presentation'));
      expect(presentations.every(request => request.query.actingSubject === actor
        && request.authorization === (actor ? `Bearer recorded-${who}` : null))).toBe(true);
      const routeAt = requests.findIndex(request => request.path.endsWith('/routes'));
      const browseAt = requests.findIndex(request => request.path.endsWith('/modules/browse'));
      if (routeAt >= 0) expect(routeAt).toBeLessThan(browseAt);
    });
  }

  test(`${who} follows the recorded next page through the site route`, async () => {
    persona = who;
    const first = pageAnswer(productionSample('page-browse-default'));
    const answer = pageAnswer(productionSample('page-browse-default-continuation-1'));
    expect(first.nextCursor).toBeTruthy();
    const labels = frameLabels('page-browse-default-continuation-1')
      .map(label => label === 'frame-routes' ? 'page-browse-default-zone-continuation' : label);
    const { requests, gaps, model } = await visitRoute(browse, labels, 'page-browse-default-continuation-1', 'frame-address');
    expect(gaps).toEqual([]);
    expectRecordedPage(model, answer);
    const actor = expectSiteGraph(requests, browse, 'frame-address');
    expect(requests.find(request => request.path.endsWith('/routes'))?.query).toEqual({
      path: 'browse', cursor: first.nextCursor!, ...(actor ? { actingSubject: actor } : {}),
    });
    expectSameCursor(requests.filter(request => request.path.endsWith('/modules/browse')).at(-1)?.query.cursor, first.nextCursor);
    expect(answer.nextCursor).toBeNull();
    expect(answer.matches).toEqual({ value: 23, kind: 'exact' });
  });

  for (const page of pages) {
    test(`${who} production route ${page} reads the recorded catalogue through the supplied client`, async () => {
      persona = who;
      const answer = pageAnswer(productionSample(page));
      const { requests, gaps, model } = await visitInjected(page);
      expect(gaps).toEqual([]);
      expectRecordedPage(model, answer);
      const browseCalls = requests.filter(request => request.path.endsWith('/modules/browse'));
      expect(browseCalls.length).toBeGreaterThan(0);
      expect(browseCalls.every(request => request.authorization === null
        && request.query.limit === undefined && request.query.language === undefined)).toBe(true);
      expect(browseCalls.at(-1)?.query).toEqual(searchFrom(page));
      expect(requests.some(request => request.path.endsWith('/routes'))).toBe(false);
    });
  }
}

const paginationPages = [
  ['page-search-newest', 'frame-routes'],
  ['page-search-newest-continuation-1', 'site-search-newest-route'],
] as const;

for (const who of personas) {
  for (const [page, route] of paginationPages) {
    test(`${who} production site ${page} follows the recorded catalogue`, async () => {
      persona = who;
      const answer = pageAnswer(sampleOf(pagination, who, page));
      const labels = ['site-address', 'frame-presentation', route, 'frame-realm-header', 'frame-facets', page,
        ...(who === 'visitor' ? [] : ['frame-session-agent', 'frame-person-preferences', 'frame-joining',
          'frame-member-ban', 'frame-follow', 'frame-platform-access', ...followStateLabel(pagination)])];
      const { requests, gaps, model } = await visitRoute(pagination, labels, page, 'site-address');
      expect(gaps).toEqual([]);
      expectRecordedPage(model, answer);
      expectSiteGraph(requests, pagination, 'site-address');
      const requested = new URL(sampleOf(pagination, who, page).path, 'https://recorded.invalid').searchParams.get('cursor');
      const routed = requests.find(request => request.path.endsWith('/routes'));
      expect(routed?.query.path).toBe('browse');
      expect(routed?.query.actingSubject ?? null).toBe(actingSubject(pagination) ?? null);
      expect(routed?.query.cursor ?? null).toBe(requested);
      expect(requests.filter(request => request.path.endsWith('/modules/browse')).at(-1)?.query)
        .toEqual(searchFromRecord(pagination, page));
      if (requested) {
        expectSameCursor(requested, pageAnswer(sampleOf(pagination, who, 'page-search-newest')).nextCursor);
        expect(answer.items).toHaveLength(3);
        expect(answer.matches).toEqual({ value: 23, kind: 'exact' });
        expect(answer.nextCursor).toBeNull();
      }
    });
  }
}

async function visitInjectedSite(record: AnswerRecord, labels: string[], page: string, spaceLabel: string) {
  const seen = replay(labels, record);
  const actor = actingSubject(record);
  const main = api.mainApiWithToken(undefined, { fetcher });
  const rendered = await ZoneSiteRoute({
    params: Promise.resolve({ locale: 'en', space: addressKey(record, spaceLabel), path: ['browse'] }),
    searchParams: Promise.resolve(searchFromRecord(record, page)),
  }, {
    main,
    personal: actor ? api.mainApiWithToken(`recorded-${persona}`, { fetcher }) : main,
    actingSubject: actor,
    signedIn: persona !== 'visitor',
  });
  return { ...seen, model: findBrowse(rendered) };
}

for (const who of personas) {
  test(`${who} site route follows the recorded next page with the supplied client`, async () => {
    persona = who;
    const first = pageAnswer(productionSample('page-browse-default'));
    const answer = pageAnswer(productionSample('page-browse-default-continuation-1'));
    const labels = frameLabels('page-browse-default-continuation-1')
      .map(label => label === 'frame-routes' ? 'page-browse-default-zone-continuation' : label);
    const { requests, gaps, model } = await visitInjectedSite(browse, labels, 'page-browse-default-continuation-1', 'frame-address');
    expect(gaps).toEqual([]);
    expectRecordedPage(model, answer);
    expectSiteGraph(requests, browse, 'frame-address');
    expectSameCursor(requests.find(request => request.path.endsWith('/routes'))?.query.cursor, first.nextCursor);
  });

  test(`${who} site route follows the recorded search continuation with the supplied client`, async () => {
    persona = who;
    const page = 'page-search-newest-continuation-1';
    const answer = pageAnswer(sampleOf(pagination, who, page));
    const labels = ['site-address', 'frame-presentation', 'site-search-newest-route', 'frame-realm-header', 'frame-facets', page,
      ...(who === 'visitor' ? [] : ['frame-session-agent', 'frame-person-preferences', 'frame-joining',
        'frame-member-ban', 'frame-follow', 'frame-platform-access', ...followStateLabel(pagination)])];
    const { requests, gaps, model } = await visitInjectedSite(pagination, labels, page, 'site-address');
    expect(gaps).toEqual([]);
    expectRecordedPage(model, answer);
    expectSiteGraph(requests, pagination, 'site-address');
    expectSameCursor(requests.find(request => request.path.endsWith('/routes'))?.query.cursor,
      pageAnswer(sampleOf(pagination, who, 'page-search-newest')).nextCursor);
  });
}

async function visitInjected(page: string) {
  const key = new URL(productionSample('frame-address').path, 'https://recorded.invalid').searchParams.get('key');
  if (!key) throw new Error('Recorded address has no site key');
  const seen = replay(routeLabels(page));
  const actor = persona === 'visitor' ? undefined : (productionSample('frame-session-agent').answer as {
    sessionAgent: { actingSubject: string };
  }).sessionAgent.actingSubject;
  const main = api.mainApiWithToken(undefined, { fetcher });
  const rendered = await RealmBrowseRoute({
    params: Promise.resolve({ locale: 'en', realm: key }),
    searchParams: Promise.resolve(searchFrom(page)),
  }, undefined, {
    main,
    personal: actor ? api.mainApiWithToken(`recorded-${persona}`, { fetcher }) : main,
    actingSubject: actor,
    signedIn: persona !== 'visitor',
  });
  return { ...seen, model: findBrowse(rendered) };
}

test('both Recipe records keep the header follow-state refresh for a null level', () => {
  for (const record of [browse, pagination]) {
    for (const who of personas) {
      persona = who;
      const follow = record.personas[who].find(sample => sample.label === 'frame-follow');
      const state = record.personas[who].find(sample => sample.label === 'frame-follow-state');
      const fields = follow?.answer as { following: boolean | null; level: string | null } | undefined;
      const needs = who !== 'visitor' && !!fields && (fields.following === null || fields.level === null);
      expect(state !== undefined).toBe(needs);
      if (!state) continue;
      const url = new URL(state.path, 'https://recorded.invalid');
      expect(state.method).toBe('GET');
      expect(state.status).toBe(200);
      expect(state.operationId).toBe('getV1MeFollow-state');
      expect(state.body).toBeUndefined();
      expect(url.pathname).toBe('/v1/me/follow-state');
      expect([...url.searchParams.keys()]).toEqual(['actingSubject', 'target']);
      expect(url.searchParams.get('actingSubject')).toBe(actingSubject(record));
      expect(url.searchParams.get('target')).toBe((sampleOf(record, who, 'frame-realm-header').answer as { id: string }).id);
    }
  }
});
