import { afterEach, expect, test } from 'bun:test';
import { materializeData } from 'native-i18n';
import type { AnswerPersona, AnswerRecord } from '../../../../scripts/api/answer-record.ts';
import manga from '../../../../tests/qa/fixtures/outcomes/manga/catalogue-browse-and-search-in-its-zone.json';
import { uiLocales } from '../../i18n/define.ts';
import { BFF_PREFIX, browserMainApi } from '../api/browser.ts';
import { buildBrowsePage } from '../realm/browse-page.ts';
import { readBrowseAnswer, readFacetAnswer } from '../realm/browse-page-read.ts';
import type { FacetList, Loaded, ZoneBrowsePage } from '../realm/types.ts';
import { recordedFetch, type RecordedSelection } from '../stories/recorded-fetch.ts';
import { messages } from './messages.ts';
import { recordedActingSubject, recordedBrowseCall, recordedSample } from './manga-browse-recorded-page.ts';

const record = manga as AnswerRecord;
const personas = Object.keys(record.personas) as AnswerPersona[];
const disposals: (() => void)[] = [];
afterEach(() => { for (const dispose of disposals.splice(0)) dispose(); });

const recordedRealmName = () => {
  const answer = recordedSample(record, 'owner', 'realm-context').answer as { name: { value: string } };
  return answer.name.value;
};

function resultText(matches: ZoneBrowsePage['matches']) {
  const t = materializeData(messages, { locale: 'en' });
  return matches.kind === 'exact' ? t.results(matches.value) : t.resultsAtLeast({ count: String(matches.value) });
}

async function pageFrom(persona: AnswerPersona, label: string) {
  const sample = recordedSample(record, persona, label);
  const selections: RecordedSelection[] = [
    { label, state: sample.status === 200 ? 'populated' : 'error' },
  ];
  if (record.personas[persona].some(item => item.label === 'facet-labels')) {
    selections.push({ label: 'facet-labels', state: 'populated' });
  }
  const replay = recordedFetch(record, persona, selections, { pathPrefix: BFF_PREFIX });
  disposals.push(replay.dispose);
  const main = browserMainApi('https://recorded.invalid', { fetcher: replay.fetcher });
  const request = recordedBrowseCall(sample.path);
  const [page, facets] = await Promise.all([
    readBrowseAnswer(main, request.realm, request.query),
    selections.some(item => item.label === 'facet-labels')
      ? readFacetAnswer(main)
      : Promise.resolve({ ok: false, failure: 'unavailable' } satisfies Loaded<FacetList>),
  ]);
  const result = buildBrowsePage({
    page, facets, base: '/z/recorded/browse', zoneName: recordedRealmName(), state: request.state,
    context: { realm: request.realm, ref: request.realm, locale: 'en' }, locale: 'en', messages,
  });
  return { result, page, facets, sample, request };
}

test('recorded browse keeps titles, credit, lower-bound count, sorts and the opaque continuation', async () => {
  for (const persona of personas) {
    const { result, facets, sample } = await pageFrom(persona, 'browse-newest');
    const answer = sample.answer as ZoneBrowsePage;
    expect(sample.status).toBe(200);
    expect(facets.ok).toBe(persona === 'owner');
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(`${persona} browse did not build`);
    expect(result.data.items.map(item => item.title?.value)).toEqual(answer.items.map(item => item.title.value));
    expect(result.data.items.map(item => item.id)).toEqual(answer.items.map(item => item.id));
    expect(result.data.items[0]?.title?.lang).toBe(answer.items[0]?.title.language);
    const credit = answer.items[0]?.primaryCredits.find(item => item.displayName)?.displayName;
    if (!credit) throw new Error(`${persona} browse card has no credit`);
    expect(result.data.items[0]?.author?.value).toBe(credit);
    expect(result.data.results).toBe(resultText(answer.matches));
    expect(answer.matches.kind).toBe('lower-bound');
    expect(result.data.sorts.map(item => [item.sort, item.current])).toEqual([['newest', true], ['updated', false]]);
    const next = new URL(result.data.next!, 'https://recorded.invalid');
    expect(next.searchParams.get('cursor')).toBe(answer.nextCursor);
    expect(next.searchParams.get('sort')).toBe('newest');
    expect(next.searchParams.get('type')).toBeNull();
    expect(next.searchParams.get('q')).toBeNull();
    expect(result.data.first).toBeNull();
    const concepts = answer.facets.concept.map(item => {
      const name = item.name?.value;
      if (!name) throw new Error(`${persona} concept facet has no recorded name`);
      return [name, item.count];
    });
    expect(result.data.groups.find(group => group.facet === 'concept')?.values.map(item => [item.label.value, item.count]))
      .toEqual(concepts);
  }
});

test('recorded continuation is that page’s answer, not a local slice of the first page', async () => {
  for (const persona of personas) {
    const first = await pageFrom(persona, 'browse-newest');
    const next = await pageFrom(persona, 'browse-newest-continuation');
    const firstAnswer = first.sample.answer as ZoneBrowsePage;
    const answer = next.sample.answer as ZoneBrowsePage;
    expect(new URL(next.sample.path, 'https://recorded.invalid').searchParams.get('cursor')).toBe(firstAnswer.nextCursor);
    expect(next.result.ok).toBe(true);
    if (!next.result.ok || !first.result.ok) throw new Error(`${persona} continuation did not build`);
    expect(next.result.data.items.map(item => item.title?.value)).toEqual(answer.items.map(item => item.title.value));
    expect(next.result.data.items.map(item => item.id)).toEqual(answer.items.map(item => item.id));
    expect(next.result.data.items.map(item => item.id))
      .not.toEqual(first.result.data.items.map(item => item.id));
    expect(next.result.data.results).toBe(resultText(answer.matches));
    expect(next.result.data.first).toBeTruthy();
    expect(new URL(next.result.data.first!, 'https://recorded.invalid').searchParams.get('cursor')).toBeNull();
    if (answer.nextCursor) {
      expect(new URL(next.result.data.next!, 'https://recorded.invalid').searchParams.get('cursor')).toBe(answer.nextCursor);
    } else {
      expect(next.result.data.next).toBeNull();
    }
  }
});

test('recorded search keeps the query text, titles and match bound', async () => {
  for (const persona of personas) {
    const { result, sample } = await pageFrom(persona, 'search-newest');
    const answer = sample.answer as ZoneBrowsePage;
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(`${persona} search did not build`);
    expect(result.data.state.text).toBe(answer.query.text);
    expect(result.data.items.map(item => item.title?.value)).toEqual(answer.items.map(item => item.title.value));
    expect(result.data.items).toHaveLength(answer.items.length);
    expect(result.data.results).toBe(resultText(answer.matches));
    expect(result.data.sorts.map(item => [item.sort, item.current])).toEqual([
      ['relevance', false], ['newest', true], ['updated', false],
    ]);
  }
});

test('recorded search with no match stays an empty catalogue and an exact zero', async () => {
  for (const persona of personas) {
    const { result, sample } = await pageFrom(persona, 'search-no-match');
    const answer = sample.answer as ZoneBrowsePage;
    expect(sample.status).toBe(200);
    expect(answer.items).toEqual([]);
    expect(answer.matches).toEqual({ value: 0, kind: 'exact' });
    expect(answer.nextCursor).toBeNull();
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(`${persona} empty search did not build`);
    expect(result.data.items).toEqual([]);
    expect(result.data.results).toBe(resultText(answer.matches));
    expect(result.data.state.text).toBe(answer.query.text);
    expect(result.data.next).toBeNull();
  }
});

test('the recorded unsupported query refusal stays a failure rather than an empty catalogue', async () => {
  for (const persona of personas) {
    const { result, page, sample } = await pageFrom(persona, 'unsupported-query-shape');
    expect(sample.status).toBe(400);
    expect(sample.answer).toMatchObject({ code: 'unsupported_query_shape', title: 'Relevance needs text' });
    expect(page).toEqual({ ok: false, failure: 'invalid' });
    expect(result).toBe(page as typeof result);
  }
});

test('the owner’s recorded facet labels are the headings in every interface locale', async () => {
  const { facets } = await pageFrom('owner', 'browse-newest');
  expect(facets.ok).toBe(true);
  if (!facets.ok) throw new Error('The recorded facet list did not load');
  const concept = facets.data.facets.find(item => item.name === 'concept' && item.current);
  if (!concept) throw new Error('The recorded facet list has no current concept facet');
  for (const locale of uiLocales) {
    const replay = recordedFetch(record, 'owner', [
      { label: 'browse-newest', state: 'populated' },
      { label: 'facet-labels', state: 'populated' },
    ], { pathPrefix: BFF_PREFIX });
    disposals.push(replay.dispose);
    const main = browserMainApi('https://recorded.invalid', { fetcher: replay.fetcher });
    const sample = recordedSample(record, 'owner', 'browse-newest');
    const request = recordedBrowseCall(sample.path);
    const [page, labels] = await Promise.all([
      readBrowseAnswer(main, request.realm, request.query),
      readFacetAnswer(main),
    ]);
    const built = buildBrowsePage({
      page, facets: labels, base: '/z/recorded/browse', zoneName: recordedRealmName(), state: request.state,
      context: { realm: request.realm, ref: request.realm, locale }, locale, messages,
    });
    expect(labels.ok).toBe(true);
    if (!built.ok) throw new Error(`Browse did not build in ${locale}`);
    expect(built.data.groups.find(group => group.facet === 'concept')?.label).toBe(concept.labels[locale]);
  }
});

test('the owner’s recorded realm header and zone presentation stay readable', async () => {
  const headerSample = recordedSample(record, 'owner', 'realm-context');
  const presentationSample = recordedSample(record, 'owner', 'zone-presentation');
  const headerActor = recordedActingSubject(headerSample.path);
  const presentationActor = recordedActingSubject(presentationSample.path);
  const realm = new URL(headerSample.path, 'https://recorded.invalid').pathname.split('/')[3]!;
  const zoneId = new URL(presentationSample.path, 'https://recorded.invalid').pathname.split('/')[3]!;
  const replay = recordedFetch(record, 'owner', [
    { label: 'realm-context', state: 'populated' },
    { label: 'zone-presentation', state: 'populated' },
  ], { pathPrefix: BFF_PREFIX });
  disposals.push(replay.dispose);
  const main = browserMainApi('https://recorded.invalid', { anonymous: true, fetcher: replay.fetcher });
  const [header, presentation] = await Promise.all([
    main.v1.realms({ realm }).get(headerActor ? { query: { actingSubject: headerActor } } : {}),
    main.v1.zones({ id: zoneId }).presentation.get(presentationActor ? { query: { actingSubject: presentationActor } } : {}),
  ]);
  expect(header.error).toBeNull();
  expect(presentation.error).toBeNull();
  const recordedHeader = headerSample.answer as { name: { value: string; language: string; direction: string } };
  const recordedPresentation = presentationSample.answer as {
    name: string; official: string | null; address: { prefix: string; key: string; suffixSource: string };
  };
  const direction = recordedHeader.name.direction;
  if (direction !== 'ltr' && direction !== 'rtl') throw new Error(`Recorded realm name direction is ${direction}`);
  expect(header.data?.name.value).toBe(recordedHeader.name.value);
  expect(header.data?.name.language).toBe(recordedHeader.name.language);
  expect(header.data?.name.direction).toBe(direction);
  expect(presentation.data?.name).toBe(recordedPresentation.name);
  expect(presentation.data?.official).toBe(recordedPresentation.official);
  expect(presentation.data?.address).toEqual(recordedPresentation.address);
});
