import { expect, test } from 'bun:test';
import { isValidElement, type ReactNode } from 'react';
import { materializeData } from 'native-i18n';
import type { AnswerPersona, AnswerRecord } from '../../../../scripts/api/answer-record.ts';
import anime from '../../../../tests/qa/fixtures/outcomes/anime/catalogue-browse-and-search-in-its-zone.json';
import { uiLocales, type UiLocale } from '../../i18n/define.ts';
import { mainApiWithToken } from '../api/main.ts';
import { RealmBrowseRoute } from '../realm/routes.tsx';
import type { FacetList, ZoneBrowsePage } from '../realm/types.ts';
import { recordedFetch } from '../stories/recorded-fetch.ts';
import { ZoneBrowse } from './browse.tsx';
import type { BrowseModel } from './browse-view.ts';
import { catalogueBrowseQuery } from './catalogue-browse.tsx';
import { animeBrowseActor, animeBrowseLabels, animeBrowsePersonas, animeBrowseSample,
  animeBrowseSearch, animeBrowseSiteKey } from './anime-browse-recorded-page.ts';
import { zoneMessagesFor } from './fixtures.ts';

const record = anime as AnswerRecord;

function findBrowse(node: ReactNode): BrowseModel | null {
  if (Array.isArray(node)) return node.map(findBrowse).find(Boolean) ?? null;
  if (!isValidElement<{ children?: ReactNode; model?: BrowseModel }>(node)) return null;
  return node.type === ZoneBrowse ? node.props.model ?? null : findBrowse(node.props.children);
}

async function visit(persona: AnswerPersona, label: string, locale: UiLocale = 'en',
  search = animeBrowseSearch(record, persona, label)) {
  const replay = recordedFetch(record, persona, animeBrowseLabels(record, persona, label).map(item => ({
    label: item, state: animeBrowseSample(record, persona, item).status >= 400 ? 'error' : 'populated',
  })));
  const requests: { path: string; authorization: string | null }[] = [], gaps: string[] = [];
  const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init), url = new URL(request.url);
    requests.push({ path: url.pathname + url.search, authorization: request.headers.get('authorization') });
    try { return await replay.fetcher(input, init); }
    catch (error) { gaps.push(String(error)); throw error; }
  }) as typeof fetch;
  const main = mainApiWithToken(undefined, { fetcher });
  try {
    const rendered = await RealmBrowseRoute({ params: Promise.resolve({ locale, realm: animeBrowseSiteKey(record) }),
      searchParams: Promise.resolve(search) }, undefined, {
      main, personal: persona === 'visitor' ? main : mainApiWithToken(`recorded-${persona}`, { fetcher }),
      actingSubject: animeBrowseActor(record, persona), signedIn: persona !== 'visitor',
    });
    expect(gaps).toEqual([]);
    const model = findBrowse(rendered);
    expect(model).not.toBeNull();
    if (!model) throw new Error('The production route did not render its recorded Anime catalogue');
    return { model, requests };
  } finally { replay.dispose(); }
}

for (const persona of animeBrowsePersonas) {
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
        const query = catalogueBrowseQuery(animeBrowseSearch(record, persona, sample.label));
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
        expect(new URL(request.path, original).searchParams.get('actingSubject')).toBe(animeBrowseActor(record, persona) ?? null);
      }
      if (sample.label === 'page-combined') {
        expect(catalogueBrowseQuery(animeBrowseSearch(record, persona, sample.label))).toMatchObject({
          sort: 'updated', publicationYear: '2004', status: ['completed'], q: answer.query.text,
        });
        expect(model.kept).toContainEqual({ name: 'year', value: '2004' });
        for (const sort of model.sorts) expect(new URL(sort.href, original).searchParams.get('year')).toBe('2004');
      }
    }
    expect(JSON.stringify(record.personas[persona])).toBe(before);
  });

  test(`${persona}: every public Work remains reachable and bare relevance uses the production default`, async () => {
    const expected = record.personas.visitor.filter(sample => /^page-browse-default(?:-continuation-\d+)?$/.test(sample.label))
      .flatMap(sample => (sample.answer as ZoneBrowsePage).items.map(item => item.id));
    const pages = record.personas[persona].filter(sample => /^page-browse-default(?:-continuation-\d+)?$/.test(sample.label));
    const actual = pages.flatMap(sample => (sample.answer as ZoneBrowsePage).items.map(item => item.id));
    expect(actual).toHaveLength(65);
    expect(new Set(actual).size).toBe(65);
    expect(actual.slice().sort()).toEqual(expected.slice().sort());
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
  const facets = animeBrowseSample(record, 'owner', 'frame-facets').answer as FacetList;
  const concept = facets.facets.find(facet => facet.name === 'concept' && facet.current)!;
  for (const locale of uiLocales) {
    const { model } = await visit('owner', 'page-combined', locale);
    expect(model.groups.find(group => group.facet === 'concept')?.label).toBe(concept.labels[locale]);
    expect(model.items.every(item => item.title?.lang === 'en')).toBe(true);
  }
});
