import { afterEach, expect, test } from 'bun:test';
import type { AnswerPersona, AnswerRecord, AnswerSample } from '../../../../scripts/api/answer-record.ts';
import games from '../../../../tests/qa/fixtures/outcomes/games/catalogue-browse-and-search-in-its-zone.json';
import { isValidElement, type ComponentProps, type ReactElement, type ReactNode } from 'react';
import { materializeData } from 'native-i18n';
import { uiLocales, type UiLocale } from '../../i18n/define.ts';
import { RealmBrowseRoute } from '../realm/routes.tsx';
import { RealmMembership } from '../realm/membership.tsx';
import { mainRelationships } from '../relationships/api.ts';
import { buildBrowsePage } from '../realm/browse-page.ts';
import { ZoneBrowse } from './browse.tsx';
import type { BrowseModel } from './browse-view.ts';
import { catalogueBrowseQuery } from './catalogue-browse.tsx';
import { parseBrowseState } from './browse-state.ts';
import { gamesBrowseActor, gamesBrowseLabels, gamesBrowsePersonas, gamesBrowseSample,
  gamesBrowseSearch, gamesBrowseSiteKey } from './games-browse-recorded-page.ts';
import { zoneMessagesFor } from './fixtures.ts';
import { mainApiWithToken } from '../api/main.ts';
import { seedServedTypes } from '../catalogue/type-fixtures.ts';
import { readFacets, readZoneBrowse, type RealmReadClient } from '../realm/read.ts';
import type { FacetList, ZoneBrowsePage, ZoneBrowseQuery } from '../realm/types.ts';
import { recordedFetch } from '../stories/recorded-fetch.ts';

const record = games as AnswerRecord;
seedServedTypes();
const personas: AnswerPersona[] = ['visitor', 'stranger', 'member', 'owner', 'moderator', 'operator'];
const disposals: (() => void)[] = [];
afterEach(() => { for (const dispose of disposals.splice(0)) dispose(); });

/** Reader coverage of the original API requests; these are not route-reachable story states. */
function requestOf(sample: AnswerSample): { realm: string; query: ZoneBrowseQuery } {
  const url = new URL(sample.path, 'https://recorded.invalid');
  const params = url.searchParams;
  const sort = params.get('sort');
  if (sort !== null && sort !== 'newest' && sort !== 'updated' && sort !== 'relevance') {
    throw new Error(`Unexpected recorded Games sort: ${sort}`);
  }
  const realm = url.pathname.split('/')[3];
  if (!realm) throw new Error('Recorded Games request has no Realm');
  return { realm, query: {
    ...(sort ? { sort } : {}),
    ...(params.has('limit') ? { limit: Number(params.get('limit')) } : {}),
    ...(params.has('q') ? { q: params.get('q')! } : {}),
    ...(params.has('cursor') ? { cursor: params.get('cursor')! } : {}),
    ...(params.has('actingSubject') ? { actingSubject: params.get('actingSubject')! } : {}),
    type: params.getAll('type'),
  } };
}

for (const persona of personas) {
  test(`${persona}: the production reader consumes unchanged Games browse, search, sort, empty and continuation answers`, async () => {
    const before = JSON.stringify(record.personas[persona]);
    const samples = record.personas[persona].filter(sample =>
      sample.operationId === 'getV1RealmsByRealmModulesBrowse' && sample.status === 200);
    expect(samples.length).toBeGreaterThan(10);
    for (const sample of samples) {
      const replay = recordedFetch(record, persona, [{ label: sample.label, state: 'populated' }]);
      disposals.push(replay.dispose);
      const main = mainApiWithToken(undefined, { fetcher: replay.fetcher });
      const { realm, query } = requestOf(sample);
      // Equality includes titles and language, Work/revision identity, native credits,
      // source position, exact/lower-bound counts and the complete opaque cursor.
      expect(await readZoneBrowse(realm, 'en', query, main)).toEqual({ ok: true, data: sample.answer });
    }
    expect(JSON.stringify(record.personas[persona])).toBe(before);
  });

  test(`${persona}: the recorded unsupported-query refusal remains a failed read`, async () => {
    const sample = record.personas[persona].find(item => item.label === 'unsupported-query-shape');
    if (!sample) throw new Error(`Missing Games refusal for ${persona}`);
    expect(sample.status).toBe(400);
    expect(sample.answer).toMatchObject({ title: 'Relevance needs text', code: 'unsupported_query_shape' });
    const replay = recordedFetch(record, persona, [{ label: sample.label, state: 'error' },
      { label: 'frame-facets', state: 'populated' }]);
    disposals.push(replay.dispose);
    const { realm, query } = requestOf(sample);
    const client = mainApiWithToken(undefined, { fetcher: replay.fetcher });
    const page = await readZoneBrowse(realm, 'en', query, client);
    expect(page).toEqual({ ok: false, failure: 'invalid', status: sample.status, problem: sample.answer });
    const mapped = buildBrowsePage({ page, facets: await readFacets(client), base: '/en/z/games/browse',
      zoneName: 'Games', state: parseBrowseState({ sort: 'relevance' }),
      context: { realm, ref: realm, locale: 'en' }, locale: 'en', messages: zoneMessagesFor('en') });
    expect(mapped).toBe(page);
  });
}

test('the production reader waits while a recorded Games browse request is held unanswered', async () => {
  const sample = record.personas.visitor.find(item => item.label === 'populated');
  if (!sample) throw new Error('Missing visitor Games browse');
  const replay = recordedFetch(record, 'visitor', [{ label: sample.label, state: 'loading' }]);
  disposals.push(replay.dispose);
  let requested = false;
  const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
    requested = true;
    return replay.fetcher(input, init);
  }) as typeof fetch;
  const { realm, query } = requestOf(sample);
  let settled = false;
  const page = readZoneBrowse(realm, 'en', query, mainApiWithToken(undefined, { fetcher }))
    .finally(() => { settled = true; });
  await Bun.sleep(10);
  expect(requested).toBe(true);
  expect(settled).toBe(false);
  replay.dispose();
  await page;
});

function findBrowse(node: ReactNode): BrowseModel | null {
  if (Array.isArray(node)) return node.map(findBrowse).find(Boolean) ?? null;
  if (!isValidElement<{ children?: ReactNode; model?: BrowseModel }>(node)) return null;
  return node.type === ZoneBrowse ? node.props.model ?? null : findBrowse(node.props.children);
}

function findMembership(node: ReactNode): ComponentProps<typeof RealmMembership> | null {
  if (Array.isArray(node)) return node.map(findMembership).find(Boolean) ?? null;
  if (!isValidElement<{ children?: ReactNode }>(node)) return null;
  return node.type === RealmMembership
    ? (node as ReactElement<ComponentProps<typeof RealmMembership>>).props
    : Object.values(node.props).map(findMembership).find(Boolean) ?? null;
}

async function visit(persona: AnswerPersona, label: string, locale: UiLocale = 'en',
  search: Record<string, string | string[] | undefined> = gamesBrowseSearch(record, persona, label)) {
  const replay = recordedFetch(record, persona, gamesBrowseLabels(record, persona, label).map(item => ({
    label: item, state: gamesBrowseSample(record, persona, item).status >= 400 ? 'error' : 'populated',
  })));
  const requests: { path: string; authorization: string | null }[] = [], gaps: string[] = [];
  const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input instanceof Request ? input : new URL(String(input), 'https://recorded.invalid'), init);
    const url = new URL(request.url);
    requests.push({ path: url.pathname + url.search, authorization: request.headers.get('authorization') });
    try { return await replay.fetcher(input, init); }
    catch (error) { gaps.push(String(error)); throw error; }
  }) as typeof fetch;
  const main = mainApiWithToken(undefined, { fetcher });
  const client: RealmReadClient & { fetch: typeof fetch } = {
    main, personal: persona === 'visitor' ? main : mainApiWithToken(`recorded-${persona}`, { fetcher }),
    actingSubject: gamesBrowseActor(record, persona), signedIn: persona !== 'visitor', fetch: fetcher,
  };
  try {
    const rendered = await RealmBrowseRoute({ params: Promise.resolve({ locale, realm: gamesBrowseSiteKey(record) }),
      searchParams: Promise.resolve(search) }, undefined, client);
    const membership = findMembership(rendered);
    expect(membership?.transport?.fetch).toBe(fetcher);
    if (membership?.signedIn && membership.actingSubject
      && (!membership.initial || membership.initial.following === null || membership.initial.level == null)) {
      const follow = await mainRelationships(membership.actingSubject, membership.transport).state(membership.realm, 'realm');
      expect(follow.following).not.toBeNull();
    }
    expect(gaps).toEqual([]);
    const model = findBrowse(rendered);
    expect(model).not.toBeNull();
    if (!model) throw new Error('The production route did not render its recorded Games catalogue');
    return { model, requests };
  } finally { replay.dispose(); }
}

for (const persona of gamesBrowsePersonas) {
  test(`${persona}: every production browse/search page replays with zero missing requests and unchanged answers`, async () => {
    const before = JSON.stringify(record.personas[persona]);
    const pages = record.personas[persona].filter(sample => sample.label.startsWith('page-'));
    for (const sample of pages) {
      const answer = sample.answer as ZoneBrowsePage;
      const { model, requests } = await visit(persona, sample.label);
      expect(model.items.map(item => item.id)).toEqual(answer.items.map(item => item.id));
      expect(model.items.map(item => item.title?.value)).toEqual(answer.items.map(item => item.title.value));
      expect(model.items.map(item => item.title?.lang)).toEqual(answer.items.map(item => item.title.language));
      expect(model.items.map(item => item.author?.value ?? null)).toEqual(answer.items.map(item =>
        item.primaryCredits.find(credit => credit.displayName)?.displayName ?? null));
      expect(model.basis).toEqual({ sourcePosition: answer.sourcePosition,
        matches: answer.matches, tags: answer.tags, window: answer.window });
      const t = materializeData(zoneMessagesFor('en'), { locale: 'en' });
      expect(model.results).toBe(answer.matches.kind === 'exact' ? t.results(answer.matches.value)
        : t.resultsAtLeast({ count: String(answer.matches.value) }));
      expect(model.state.text).toBe(answer.query.text);
      const original = new URL(sample.path, 'https://recorded.invalid');
      if (answer.nextCursor) {
        const next = new URL(model.next!, 'https://recorded.invalid');
        expect(next.searchParams.get('cursor')).toBe(answer.nextCursor);
        const resumed = catalogueBrowseQuery(Object.fromEntries(next.searchParams));
        const query = catalogueBrowseQuery(gamesBrowseSearch(record, persona, sample.label));
        expect(resumed).toEqual({ ...query, cursor: answer.nextCursor });
      } else expect(model.next).toBeNull();
      expect(Boolean(model.first)).toBe(original.searchParams.has('cursor'));
      const browse = requests.filter(request => new URL(request.path, original).pathname.endsWith('/modules/browse'));
      expect(browse).toHaveLength(1);
      expect(new URL(browse[0]!.path, original).searchParams).toEqual(original.searchParams);
      expect(browse[0]!.authorization).toBeNull();
      expect(original.searchParams.has('limit')).toBe(false);
      expect(original.searchParams.has('language')).toBe(false);
      for (const request of requests.filter(request => request.path.includes('/presentation'))) {
        expect(request.authorization).toBe(persona === 'visitor' ? null : `Bearer recorded-${persona}`);
        expect(new URL(request.path, original).searchParams.get('actingSubject')).toBe(gamesBrowseActor(record, persona) ?? null);
      }

    }
    expect(JSON.stringify(record.personas[persona])).toBe(before);
  });

  test(`${persona}: every public Work remains reachable and bare relevance uses the production default`, async () => {
    const expected = record.personas.visitor.filter(sample => /^page-browse-default(?:-continuation-\d+)?$/.test(sample.label))
      .flatMap(sample => (sample.answer as ZoneBrowsePage).items.map(item => item.id));
    const pages = record.personas[persona].filter(sample => /^page-browse-default(?:-continuation-\d+)?$/.test(sample.label));
    const actual = pages.flatMap(sample => (sample.answer as ZoneBrowsePage).items.map(item => item.id));
    expect(actual).toHaveLength(persona === 'moderator' ? 23 : 22);
    expect(new Set(actual).size).toBe(actual.length);
    if (persona === 'moderator') expect(actual).toEqual(expect.arrayContaining(expected));
    else expect(actual.slice().sort()).toEqual(expected.slice().sort());
    for (const [index, sample] of pages.entries()) {
      const answer = sample.answer as ZoneBrowsePage;
      expect(answer.matches.kind).toBe(index === pages.length - 1 ? 'exact' : 'lower-bound');
      if (index) expect(new URL(sample.path, 'https://recorded.invalid').searchParams.get('cursor'))
        .toBe((pages[index - 1]!.answer as ZoneBrowsePage).nextCursor);
    }
    const { model } = await visit(persona, 'page-browse-default', 'en', { sort: 'relevance', q: '',
      type: [], concept: [], status: [], exclude: [] });
    expect(model.sorts.find(sort => sort.current)?.sort).toBe('newest');
  });
}

test('the actual frame and catalogue preserve all eight UI locales and the recorded source language', async () => {
  const facets = gamesBrowseSample(record, 'owner', 'frame-facets').answer as FacetList;
  const type = facets.facets.find(facet => facet.name === 'type' && facet.current)!;
  for (const locale of uiLocales) {
    const { model } = await visit('owner', 'page-browse-default', locale);
    expect(model.groups.find(group => group.facet === 'type')?.label).toBe(type.labels[locale]);
    expect(model.items.every(item => item.title?.lang === 'en')).toBe(true);
  }
});
