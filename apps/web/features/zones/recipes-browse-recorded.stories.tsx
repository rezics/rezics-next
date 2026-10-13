import type { ZoneContext } from '@rezics/zone-sdk';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { materializeData } from 'native-i18n';
import { useEffect, useState } from 'react';
import { expect, within } from 'storybook/test';
import type { AnswerRecord } from '../../../../scripts/api/answer-record.ts';
import browseFixture from '../../../../tests/qa/fixtures/outcomes/recipes/catalogue-browse-and-search-in-its-zone.json';
import paginationFixture from '../../../../tests/qa/fixtures/outcomes/recipes/catalogue-pagination-in-its-zone.json';
import { localizedPath } from '../../i18n/locale.ts';
import { spaceHref } from '../address/path.ts';
import { BFF_PREFIX, browserMainApi } from '../api/browser.ts';
import { zoneImage, zoneText } from '../realm/adapt.ts';
import { buildBrowsePage } from '../realm/browse-page.ts';
import { readBrowseAnswer, readFacetAnswer } from '../realm/browse-page-read.ts';
import { realmHref, siteHref } from '../realm/route.ts';
import { RealmUnavailable } from '../realm/states.tsx';
import { realmMessagesFor, RealmPageStory } from '../realm/story-page.tsx';
import type { Loaded, RealmHeader, ZoneBrowsePage } from '../realm/types.ts';
import { messages as shellMessages } from '../shell/messages.ts';
import { PageContainer } from '../shell/page.tsx';
import { recordedFetch, type RecordedState } from '../stories/recorded-fetch.ts';
import { ZoneBrowse } from './browse.tsx';
import type { BrowseModel } from './browse-view.ts';
import { zoneMessagesFor } from './fixtures.ts';
import { recordedBrowseRequest } from './recipes-browse-recorded-page.ts';
import { cardRenderer } from './zone-home.tsx';

// Frame reads are recorded for the owner. Other personas have catalogue answers only.
const persona = 'owner';
const locale = 'en';
const messages = zoneMessagesFor(locale);
const realmMessages = realmMessagesFor(locale);
const records = {
  browse: browseFixture as AnswerRecord,
  pagination: paginationFixture as AnswerRecord,
};
type Source = keyof typeof records;

function sample(source: Source, label: string) {
  const found = records[source].personas[persona].find(answer => answer.label === label);
  if (!found) throw new Error(`Missing recorded Recipes answer: ${source}/${persona}/${label}`);
  return found;
}

function recordedPage(source: Source, label: string) {
  return sample(source, label).answer as ZoneBrowsePage;
}

function resultText(source: Source, label: string) {
  const matches = recordedPage(source, label).matches;
  const t = materializeData(messages, { locale });
  return matches.kind === 'exact' ? t.results(matches.value) : t.resultsAtLeast({ count: String(matches.value) });
}

function creditOf(source: Source, label: string) {
  const name = recordedPage(source, label).items[0]?.primaryCredits.find(item => item.displayName)?.displayName;
  if (!name) throw new Error(`Recorded recipe has no credited name: ${label}`);
  return name;
}

/** The generated cover keeps its author hidden below 7rem. The card byline is the credit a visitor reads. */
function shownCredit(canvas: ReturnType<typeof within>, name: string) {
  const shown = canvas.getAllByText(name).find(element => {
    const style = getComputedStyle(element);
    return style.display !== 'none' && style.visibility !== 'hidden';
  });
  if (!shown) throw new Error(`Recorded credit is not shown: ${name}`);
  return shown;
}

function routeOf(source: Source) {
  const presentation = sample(source, 'zone-presentation').answer as { address: { prefix: string; key: string } };
  if (presentation.address.prefix !== '/z/') throw new Error('Recorded presentation address is not a site address');
  return localizedPath(spaceHref(presentation.address.key, 'site', ['browse']), locale);
}

function RecordedRecipesBrowse({ source, label, state }: { source: Source; label: string; state: RecordedState }) {
  const [shown, setShown] = useState<{ zone: ZoneContext; page: Loaded<BrowseModel> | null } | null>(null);
  const [error, setError] = useState<Error | null>(null);
  useEffect(() => {
    let active = true;
    const record = records[source];
    const replay = recordedFetch(record, persona, [
      { label, state }, { label: 'facet-labels', state: 'populated' },
      { label: 'realm-context', state: 'populated' }, { label: 'zone-presentation', state: 'populated' },
    ], { pathPrefix: BFF_PREFIX });
    const main = browserMainApi('https://recorded.invalid', { anonymous: true, fetcher: replay.fetcher });
    const request = recordedBrowseRequest(sample(source, label).path);
    const zoneId = new URL(sample(source, 'zone-presentation').path, 'https://recorded.invalid').pathname.split('/')[3]!;
    // The recorded realm and presentation reads carry the acting person.
    const recordedSubject = new URL(sample(source, 'realm-context').path, 'https://recorded.invalid')
      .searchParams.get('actingSubject');
    if (!recordedSubject) throw new Error('Recorded realm context has no acting subject');
    const actingSubject = recordedSubject;
    async function load() {
      const [header, presentation] = await Promise.all([
        main.v1.realms({ realm: request.realm }).get({ query: { actingSubject } }),
        main.v1.zones({ id: zoneId }).presentation.get({ query: { actingSubject } }),
      ]);
      if (header.error || !header.data || presentation.error || !presentation.data) throw new Error('Recorded browse frame failed');
      if (presentation.data.address.prefix !== '/z/') throw new Error('Recorded presentation address is not a site address');
      const ref = presentation.data.address.key;
      const zone: ZoneContext = { slug: presentation.data.official, realm: header.data.id,
        name: zoneText(header.data.name), description: zoneText(header.data.description),
        icon: zoneImage(header.data.icon), hero: zoneImage(header.data.banner),
        tokens: presentation.data.presentation.tokens, locale,
        links: { home: siteHref(locale, ref, []), browse: siteHref(locale, ref, ['browse']),
          works: siteHref(locale, ref, ['browse']), discussions: realmHref(locale, ref, 'discussions'),
          decisions: realmHref(locale, ref, 'decisions'), about: realmHref(locale, ref, 'about') } };
      if (active) setShown({ zone, page: null });
      const [page, facets] = await Promise.all([
        readBrowseAnswer(main, request.realm, request.query), readFacetAnswer(main),
      ]);
      const built = buildBrowsePage({ page, facets, base: zone.links.browse, zoneName: zone.name.value,
        state: request.state, context: { realm: request.realm, ref, locale }, locale, messages });
      if (active) setShown({ zone, page: built });
    }
    void load().catch((reason: unknown) => { if (active) setError(reason instanceof Error ? reason : new Error(String(reason))); });
    return () => { active = false; replay.dispose(); };
  }, [source, label, state]);
  if (error) throw error;
  const loading = <PageContainer><p role="status" aria-busy="true">{shellMessages.loading}</p></PageContainer>;
  if (!shown) return loading;
  return <RealmPageStory zone={shown.zone} locale={locale} site>
    {!shown.page ? loading : shown.page.ok
      ? <ZoneBrowse model={shown.page.data} messages={messages} card={cardRenderer(shown.zone, null, locale, messages)} />
      : <RealmUnavailable messages={realmMessages} failure={shown.page.failure} reference={shown.page.reference} />}
  </RealmPageStory>;
}

const meta = { title: 'Zones/Recipes catalogue browse', component: RecordedRecipesBrowse,
  args: { source: 'browse', label: 'browse-newest-0', state: 'populated' },
  parameters: { route: { pathname: routeOf('browse') } },
  globals: { locale },
} satisfies Meta<typeof RecordedRecipesBrowse>;
export default meta;
type Story = StoryObj<typeof meta>;
type Play = NonNullable<Story['play']>;

function story(source: Source, label: string, state: RecordedState, play: Play): Story {
  return { args: { source, label, state }, parameters: { route: { pathname: routeOf(source) } }, play };
}

function at(base: Story, viewport: 'phone' | 'desktop'): Story {
  return { ...base, globals: { viewport: { value: viewport }, locale } };
}

const playPopulated: Play = async ({ canvasElement }) => {
  const canvas = within(canvasElement);
  const answer = recordedPage('browse', 'browse-newest-0');
  await expect(await canvas.findByRole('link', { name: answer.items[0]!.title.value })).toBeVisible();
  await expect(shownCredit(canvas, creditOf('browse', 'browse-newest-0'))).toBeVisible();
  await expect(canvas.getByRole('status')).toHaveTextContent(resultText('browse', 'browse-newest-0'));
  const sorts = within(canvas.getByRole('navigation', { name: messages.sortLabel }));
  await expect(sorts.getByRole('link', { name: messages.sortNewest })).toHaveAttribute('aria-current', 'true');
  await expect(sorts.getByRole('link', { name: messages.sortUpdated })).toBeVisible();
  const next = canvas.getByRole('link', { name: messages.next });
  await expect(next).toBeVisible();
  await expect(new URL(next.getAttribute('href')!, 'https://recorded.invalid').searchParams.get('cursor'))
    .toBe(answer.nextCursor);
  await expect(canvas.queryByRole('link', { name: messages.previous })).toBeNull();
};

const playSearch: Play = async ({ canvasElement }) => {
  const canvas = within(canvasElement);
  const answer = recordedPage('browse', 'search-relevance-0');
  await expect(await canvas.findByRole('link', { name: answer.items[0]!.title.value })).toBeVisible();
  await expect(shownCredit(canvas, creditOf('browse', 'search-relevance-0'))).toBeVisible();
  await expect(canvas.getByRole('status')).toHaveTextContent(resultText('browse', 'search-relevance-0'));
  await expect(canvas.getByRole('searchbox')).toHaveValue(answer.query.text);
  const sorts = within(canvas.getByRole('navigation', { name: messages.sortLabel }));
  for (const name of [messages.sortRelevance, messages.sortNewest, messages.sortUpdated])
    await expect(sorts.getByRole('link', { name })).toBeVisible();
  await expect(sorts.getByRole('link', { name: messages.sortRelevance })).toHaveAttribute('aria-current', 'true');
};

const playEmpty: Play = async ({ canvasElement }) => {
  const canvas = within(canvasElement);
  const answer = recordedPage('browse', 'search-no-match');
  await expect(await canvas.findByRole('heading', { name: messages.browseEmptyTitle })).toBeVisible();
  await expect(canvas.getByText(messages.browseEmptyBody)).toBeVisible();
  await expect(canvas.getByRole('status')).toHaveTextContent(resultText('browse', 'search-no-match'));
  await expect(canvas.getByRole('searchbox')).toHaveValue(answer.query.text);
  await expect(canvas.queryByRole('link', { name: messages.next })).toBeNull();
  await expect(canvas.queryByRole('link', { name: messages.previous })).toBeNull();
};

const playRefusal: Play = async ({ canvasElement }) => {
  const canvas = within(canvasElement);
  await expect(await canvas.findByRole('heading', { name: realmMessages.movedTitle })).toBeVisible();
  await expect(canvas.getByText(realmMessages.movedBody)).toBeVisible();
  await expect(canvas.getByRole('button', { name: realmMessages.retry })).toBeVisible();
  await expect(canvas.queryByText(messages.browseEmptyTitle)).toBeNull();
};

const playLoading: Play = async ({ canvasElement }) => {
  const canvas = within(canvasElement);
  // The frame has answered before this assertion; the selected browse call remains held.
  await expect(await canvas.findByRole('heading', { name: (sample('browse', 'realm-context').answer as RealmHeader).name.value }))
    .toBeVisible();
  await expect(canvas.getByRole('status')).toHaveTextContent(shellMessages.loading);
  await expect(canvas.getByRole('status')).toHaveAttribute('aria-busy', 'true');
  await expect(canvas.queryByText(recordedPage('browse', 'browse-newest-0').items[0]!.title.value)).toBeNull();
};

const playNext: Play = async ({ canvasElement }) => {
  const canvas = within(canvasElement);
  const answer = recordedPage('browse', 'browse-newest-1');
  await expect(await canvas.findByRole('link', { name: answer.items[0]!.title.value })).toBeVisible();
  await expect(shownCredit(canvas, creditOf('browse', 'browse-newest-1'))).toBeVisible();
  await expect(canvas.getByRole('status')).toHaveTextContent(resultText('browse', 'browse-newest-1'));
  await expect(canvas.getByRole('link', { name: messages.previous })).toBeVisible();
  await expect(canvas.queryByRole('link', { name: messages.next })).toBeNull();
};

const playFiltered: Play = async ({ canvasElement }) => {
  const canvas = within(canvasElement);
  const answer = recordedPage('pagination', 'browse-newest-first');
  await expect(await canvas.findByRole('link', { name: answer.items[0]!.title.value })).toBeVisible();
  await expect(shownCredit(canvas, creditOf('pagination', 'browse-newest-first'))).toBeVisible();
  await expect(canvas.getByRole('status')).toHaveTextContent(resultText('pagination', 'browse-newest-first'));
  await expect(canvas.getByRole('searchbox')).toHaveValue(answer.query.text);
  const sorts = within(canvas.getByRole('navigation', { name: messages.sortLabel }));
  await expect(sorts.getByRole('link', { name: messages.sortNewest })).toHaveAttribute('aria-current', 'true');
  const next = canvas.getByRole('link', { name: messages.next });
  await expect(new URL(next.getAttribute('href')!, 'https://recorded.invalid').searchParams.get('cursor'))
    .toBe(answer.nextCursor);
  await expect(canvas.queryByRole('link', { name: messages.previous })).toBeNull();
};

const playContinuation: Play = async ({ canvasElement }) => {
  const canvas = within(canvasElement);
  const answer = recordedPage('pagination', 'browse-newest-continuation');
  await expect(await canvas.findByRole('link', { name: answer.items[0]!.title.value })).toBeVisible();
  await expect(shownCredit(canvas, creditOf('pagination', 'browse-newest-continuation'))).toBeVisible();
  await expect(canvas.getByRole('status')).toHaveTextContent(resultText('pagination', 'browse-newest-continuation'));
  await expect(canvas.getByRole('searchbox')).toHaveValue(answer.query.text);
  await expect(canvas.getByRole('link', { name: messages.previous })).toBeVisible();
  await expect(canvas.queryByRole('link', { name: messages.next })).toBeNull();
};

const playCursorRefusal: Play = async ({ canvasElement }) => {
  const canvas = within(canvasElement);
  await expect(await canvas.findByRole('heading', { name: realmMessages.movedTitle })).toBeVisible();
  await expect(canvas.getByText(realmMessages.movedBody)).toBeVisible();
  await expect(canvas.getByRole('button', { name: realmMessages.retry })).toBeVisible();
  await expect(canvas.queryByText(messages.browseEmptyTitle)).toBeNull();
  await expect(canvas.queryByText(recordedPage('pagination', 'browse-newest-continuation').items[0]!.title.value)).toBeNull();
};

const populated = story('browse', 'browse-newest-0', 'populated', playPopulated);
const search = story('browse', 'search-relevance-0', 'populated', playSearch);
const empty = story('browse', 'search-no-match', 'empty', playEmpty);
const refusal = story('browse', 'unsupported-query-shape', 'error', playRefusal);
const loading = story('browse', 'browse-newest-0', 'loading', playLoading);
const next = story('browse', 'browse-newest-1', 'populated', playNext);
const filtered = story('pagination', 'browse-newest-first', 'populated', playFiltered);
const continuation = story('pagination', 'browse-newest-continuation', 'populated', playContinuation);
const cursorRefusal = story('pagination', 'cursor-newest-q-refused', 'error', playCursorRefusal);

export const PopulatedOwnerPhone: Story = at(populated, 'phone');
export const PopulatedOwnerDesktop: Story = at(populated, 'desktop');
export const SearchOwnerPhone: Story = at(search, 'phone');
export const SearchOwnerDesktop: Story = at(search, 'desktop');
export const EmptyOwnerPhone: Story = at(empty, 'phone');
export const EmptyOwnerDesktop: Story = at(empty, 'desktop');
export const RefusalOwnerPhone: Story = at(refusal, 'phone');
export const RefusalOwnerDesktop: Story = at(refusal, 'desktop');
export const LoadingOwnerPhone: Story = at(loading, 'phone');
export const LoadingOwnerDesktop: Story = at(loading, 'desktop');
export const NextPageOwnerPhone: Story = at(next, 'phone');
export const NextPageOwnerDesktop: Story = at(next, 'desktop');
export const FilteredFirstOwnerPhone: Story = at(filtered, 'phone');
export const FilteredFirstOwnerDesktop: Story = at(filtered, 'desktop');
export const ContinuationOwnerPhone: Story = at(continuation, 'phone');
export const ContinuationOwnerDesktop: Story = at(continuation, 'desktop');
export const CursorRefusalOwnerPhone: Story = at(cursorRefusal, 'phone');
export const CursorRefusalOwnerDesktop: Story = at(cursorRefusal, 'desktop');
