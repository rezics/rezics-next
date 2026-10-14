import type { ZoneContext } from '@rezics/zone-sdk';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { materializeData } from 'native-i18n';
import { useEffect, useState, type ReactNode } from 'react';
import { expect, within } from 'storybook/test';
import type { AnswerRecord } from '../../../../scripts/api/answer-record.ts';
import browseFixture from '../../../../tests/qa/fixtures/outcomes/recipes/catalogue-browse-and-search-in-its-zone.json';
import paginationFixture from '../../../../tests/qa/fixtures/outcomes/recipes/catalogue-pagination-in-its-zone.json';
import { localizedPath } from '../../i18n/locale.ts';
import { spaceHref } from '../address/path.ts';
import { BFF_PREFIX, browserMainApi } from '../api/browser.ts';
import { mainApiWithToken } from '../api/main.ts';
import { zoneImage, zoneText } from '../realm/adapt.ts';
import { buildBrowsePage } from '../realm/browse-page.ts';
import { readBrowseAnswer, readFacetAnswer } from '../realm/browse-page-read.ts';
import type { RealmReadClient } from '../realm/read.ts';
import { realmHref, siteHref } from '../realm/route.ts';
import { RealmBrowseRoute } from '../realm/routes.tsx';
import { RealmUnavailable } from '../realm/states.tsx';
import { realmMessagesFor, RealmPageStory } from '../realm/story-page.tsx';
import type { Loaded, ZoneBrowsePage } from '../realm/types.ts';
import { messages as shellMessages } from '../shell/messages.ts';
import { PageContainer } from '../shell/page.tsx';
import { recordedFetch, type RecordedSelection, type RecordedState } from '../stories/recorded-fetch.ts';
import type { BrowseModel } from './browse-view.ts';
import { ZoneBrowse } from './browse.tsx';
import { zoneMessagesFor } from './fixtures.ts';
import { recordedBrowseRequest, recordedSitePrefix } from './recipes-browse-recorded-page.ts';
import { cardRenderer } from './zone-home.tsx';

const locale = 'en';
const messages = zoneMessagesFor(locale);
const realmMessages = realmMessagesFor(locale);
const browseRecord = browseFixture as AnswerRecord;
const paginationRecord = paginationFixture as AnswerRecord;
const personas = ['visitor', 'stranger', 'member', 'owner', 'moderator', 'operator'] as const;
type Persona = typeof personas[number];

function browseSample(persona: Persona, label: string) {
  const found = browseRecord.personas[persona].find(answer => answer.label === label);
  if (!found) throw new Error(`Missing recorded Recipes answer: ${persona}/${label}`);
  return found;
}

function pageOf(persona: Persona, label: string) {
  return browseSample(persona, label).answer as ZoneBrowsePage;
}

function headerName(persona: Persona) {
  return (browseSample(persona, 'frame-realm-header').answer as { name: { value: string } }).name.value;
}

function actingSubjectOf(persona: Persona) {
  if (persona === 'visitor') return undefined;
  return (browseSample(persona, 'frame-session-agent').answer as {
    sessionAgent: { actingSubject: string };
  }).sessionAgent.actingSubject;
}

function siteKey() {
  const key = new URL(browseSample('visitor', 'frame-address').path, 'https://recorded.invalid').searchParams.get('key');
  if (!key) throw new Error('Recorded address has no site key');
  return key;
}

const browsePath = localizedPath(spaceHref(siteKey(), 'site', ['browse']), locale);

/** The production page's query, taken from the recorded `page-*` request. */
function searchOf(persona: Persona, label: string): Record<string, string> {
  return Object.fromEntries(new URL(browseSample(persona, label).path, 'https://recorded.invalid').searchParams);
}

function selections(persona: Persona, label: string, state: RecordedState): RecordedSelection[] {
  const frame = ['frame-address', 'frame-presentation', 'frame-realm-header', 'frame-facets', label];
  const signedIn = persona === 'visitor' ? [] : [
    'frame-session-agent', 'frame-person-preferences', 'frame-joining', 'frame-follow', 'frame-platform-access',
  ];
  return [...frame, ...signedIn].map(item => ({ label: item, state: item === label ? state : 'populated' }));
}

function resultText(answer: ZoneBrowsePage) {
  const t = materializeData(messages, { locale });
  return answer.matches.kind === 'exact'
    ? t.results(answer.matches.value)
    : t.resultsAtLeast({ count: String(answer.matches.value) });
}

function creditOf(answer: ZoneBrowsePage) {
  const name = answer.items[0]?.primaryCredits.find(item => item.displayName)?.displayName;
  if (!name) throw new Error('Recorded recipe has no credited name');
  return name;
}

/** The generated cover keeps its author hidden below 7rem. The card byline is the credit a visitor reads. */
function shownCredit(canvas: ReturnType<typeof within>, name: string) {
  const shown = canvas.getAllByText(name).find((element: HTMLElement) => {
    const style = getComputedStyle(element);
    return style.display !== 'none' && style.visibility !== 'hidden';
  });
  if (!shown) throw new Error(`Recorded credit is not shown: ${name}`);
  return shown;
}

const pending = <PageContainer><p role="status" aria-busy="true">{shellMessages.loading}</p></PageContainer>;

/**
 * Browse and search through `RealmBrowseRoute` and the shared frame.
 * The site route also reads `routes?path=browse&cursor=` before a later page, and no sample records
 * that read, so the continuation is not drawn. The first page's next link is the recorded cursor.
 */
function ProductionBrowse({ persona, label, state }: { persona: Persona; label: string; state: RecordedState }) {
  const [node, setNode] = useState<ReactNode>(null);
  const [error, setError] = useState<Error | null>(null);
  useEffect(() => {
    let active = true;
    const replay = recordedFetch(browseRecord, persona, selections(persona, label, state));
    const main = mainApiWithToken(undefined, { fetcher: replay.fetcher });
    const client: RealmReadClient = {
      main,
      personal: persona === 'visitor' ? main : mainApiWithToken(`recorded-${persona}`, { fetcher: replay.fetcher }),
      actingSubject: actingSubjectOf(persona),
      signedIn: persona !== 'visitor',
    };
    void RealmBrowseRoute({
      params: Promise.resolve({ locale, realm: siteKey() }),
      searchParams: Promise.resolve(searchOf(persona, label)),
    }, undefined, client).then(rendered => {
      if (active) setNode(rendered);
    }).catch((reason: unknown) => {
      if (!active) return;
      setError(reason instanceof Error ? reason : new Error(String(reason)));
    });
    return () => {
      active = false;
      replay.dispose();
    };
  }, [persona, label, state]);
  if (error) throw error;
  if (!node) return pending;
  return node;
}

function paginationSample(label: string) {
  const found = paginationRecord.personas.owner.find(answer => answer.label === label);
  if (!found) throw new Error(`Missing recorded Recipes pagination answer: ${label}`);
  return found;
}

function paginationPage(label: string) {
  return paginationSample(label).answer as ZoneBrowsePage;
}

function paginationRoute() {
  const presentation = paginationSample('zone-presentation').answer as { address: { prefix: string; key: string } };
  if (presentation.address.prefix !== recordedSitePrefix) throw new Error('Recorded presentation address is not a site address');
  return localizedPath(spaceHref(presentation.address.key, 'site', ['browse']), locale);
}

/** Pagination stays on the installed reader until its production record is available. */
function RecordedPagination({ label, state }: { label: string; state: RecordedState }) {
  const [shown, setShown] = useState<{ zone: ZoneContext; page: Loaded<BrowseModel> | null } | null>(null);
  const [error, setError] = useState<Error | null>(null);
  useEffect(() => {
    let active = true;
    const replay = recordedFetch(paginationRecord, 'owner', [
      { label, state }, { label: 'facet-labels', state: 'populated' },
      { label: 'realm-context', state: 'populated' }, { label: 'zone-presentation', state: 'populated' },
    ], { pathPrefix: BFF_PREFIX });
    const main = browserMainApi('https://recorded.invalid', { anonymous: true, fetcher: replay.fetcher });
    const request = recordedBrowseRequest(paginationSample(label).path);
    const zoneId = new URL(paginationSample('zone-presentation').path, 'https://recorded.invalid').pathname.split('/')[3]!;
    const recordedSubject = new URL(paginationSample('realm-context').path, 'https://recorded.invalid')
      .searchParams.get('actingSubject');
    if (!recordedSubject) throw new Error('Recorded realm context has no acting subject');
    const actingSubject = recordedSubject;
    async function load() {
      const [header, presentation] = await Promise.all([
        main.v1.realms({ realm: request.realm }).get({ query: { actingSubject } }),
        main.v1.zones({ id: zoneId }).presentation.get({ query: { actingSubject } }),
      ]);
      if (header.error || !header.data || presentation.error || !presentation.data) throw new Error('Recorded browse frame failed');
      if (presentation.data.address.prefix !== recordedSitePrefix) throw new Error('Recorded presentation address is not a site address');
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
  }, [label, state]);
  if (error) throw error;
  if (!shown) return pending;
  return <RealmPageStory zone={shown.zone} locale={locale} site>
    {!shown.page ? pending : shown.page.ok
      ? <ZoneBrowse model={shown.page.data} messages={messages} card={cardRenderer(shown.zone, null, locale, messages)} />
      : <RealmUnavailable messages={realmMessages} failure={shown.page.failure} reference={shown.page.reference} />}
  </RealmPageStory>;
}

function RecipesCatalogueBrowse({ source, persona, label, state }: {
  source: 'browse' | 'pagination'; persona: Persona; label: string; state: RecordedState;
}) {
  return source === 'pagination'
    ? <RecordedPagination label={label} state={state} />
    : <ProductionBrowse persona={persona} label={label} state={state} />;
}

const meta = {
  title: 'Zones/Recipes catalogue browse',
  component: RecipesCatalogueBrowse,
  args: { source: 'browse', persona: 'visitor', label: 'page-browse-default', state: 'populated' },
  parameters: { route: { pathname: browsePath } },
  globals: { locale },
} satisfies Meta<typeof RecipesCatalogueBrowse>;
export default meta;
type Story = StoryObj<typeof meta>;
type Play = NonNullable<Story['play']>;

function at(base: Story, viewport: 'phone' | 'desktop'): Story {
  return { ...base, globals: { viewport: { value: viewport }, locale } };
}

const playPopulated: Play = async ({ canvasElement, args }) => {
  const canvas = within(canvasElement);
  const persona = args.persona ?? 'visitor';
  const answer = pageOf(persona, 'page-browse-default');
  const first = answer.items[0]!;
  const last = answer.items.at(-1)!;
  await expect(await canvas.findByRole('heading', { level: 1, name: headerName(persona) })).toBeVisible();
  await expect(await canvas.findByRole('link', { name: first.title.value })).toBeVisible();
  await expect(canvas.getByRole('link', { name: last.title.value })).toBeVisible();
  await expect(shownCredit(canvas, creditOf(answer))).toBeVisible();
  await expect(canvas.getByText(resultText(answer))).toBeVisible();
  await expect(canvas.getByRole('searchbox')).toHaveValue('');
  const sorts = within(canvas.getByRole('navigation', { name: messages.sortLabel }));
  await expect(sorts.getByRole('link', { name: messages.sortNewest })).toHaveAttribute('aria-current', 'true');
  await expect(sorts.getByRole('link', { name: messages.sortUpdated })).toBeVisible();
  await expect(sorts.queryByRole('link', { name: messages.sortRelevance })).toBeNull();
  const next = canvas.getByRole('link', { name: messages.next });
  await expect(new URL(next.getAttribute('href')!, 'https://recorded.invalid').searchParams.get('cursor'))
    .toBe(answer.nextCursor);
  await expect(canvas.queryByRole('link', { name: messages.previous })).toBeNull();
};

const playSearch: Play = async ({ canvasElement, args }) => {
  const canvas = within(canvasElement);
  const persona = args.persona ?? 'visitor';
  const answer = pageOf(persona, 'page-search-default');
  const first = answer.items[0]!;
  const last = answer.items.at(-1)!;
  await expect(await canvas.findByRole('heading', { level: 1, name: headerName(persona) })).toBeVisible();
  await expect(await canvas.findByRole('link', { name: first.title.value })).toBeVisible();
  await expect(canvas.getByRole('link', { name: last.title.value })).toBeVisible();
  await expect(shownCredit(canvas, creditOf(answer))).toBeVisible();
  await expect(canvas.getByText(resultText(answer))).toBeVisible();
  await expect(canvas.getByRole('searchbox')).toHaveValue(answer.query.text);
  const sorts = within(canvas.getByRole('navigation', { name: messages.sortLabel }));
  for (const name of [messages.sortRelevance, messages.sortNewest, messages.sortUpdated])
    await expect(sorts.getByRole('link', { name })).toBeVisible();
  await expect(sorts.getByRole('link', { name: messages.sortRelevance })).toHaveAttribute('aria-current', 'true');
  const next = canvas.getByRole('link', { name: messages.next });
  await expect(new URL(next.getAttribute('href')!, 'https://recorded.invalid').searchParams.get('cursor'))
    .toBe(answer.nextCursor);
};

const playEmpty: Play = async ({ canvasElement, args }) => {
  const canvas = within(canvasElement);
  const persona = args.persona ?? 'visitor';
  const answer = pageOf(persona, 'page-search-no-match');
  await expect(await canvas.findByRole('heading', { level: 1, name: headerName(persona) })).toBeVisible();
  await expect(canvas.getByRole('heading', { name: messages.browseEmptyTitle })).toBeVisible();
  await expect(canvas.getByText(messages.browseEmptyBody)).toBeVisible();
  await expect(canvas.getByText(resultText(answer))).toBeVisible();
  await expect(canvas.getByRole('searchbox')).toHaveValue(answer.query.text);
  const sorts = within(canvas.getByRole('navigation', { name: messages.sortLabel }));
  await expect(sorts.getByRole('link', { name: messages.sortRelevance })).toHaveAttribute('aria-current', 'true');
  await expect(canvas.queryByRole('link', { name: messages.next })).toBeNull();
  await expect(canvas.queryByRole('link', { name: messages.previous })).toBeNull();
};

const playLoading: Play = async ({ canvasElement }) => {
  const canvas = within(canvasElement);
  await expect(await canvas.findByRole('status')).toHaveTextContent(shellMessages.loading);
  await expect(canvas.getByRole('status')).toHaveAttribute('aria-busy', 'true');
  await expect(canvas.queryByRole('heading', { level: 1 })).toBeNull();
  await expect(canvas.queryByText(pageOf('visitor', 'page-browse-default').items[0]!.title.value)).toBeNull();
};

const playFiltered: Play = async ({ canvasElement }) => {
  const canvas = within(canvasElement);
  const answer = paginationPage('browse-newest-first');
  await expect(await canvas.findByRole('link', { name: answer.items[0]!.title.value })).toBeVisible();
  await expect(shownCredit(canvas, creditOf(answer))).toBeVisible();
  await expect(canvas.getByText(resultText(answer))).toBeVisible();
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
  const answer = paginationPage('browse-newest-continuation');
  await expect(await canvas.findByRole('link', { name: answer.items[0]!.title.value })).toBeVisible();
  await expect(shownCredit(canvas, creditOf(answer))).toBeVisible();
  await expect(canvas.getByText(resultText(answer))).toBeVisible();
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
  await expect(canvas.queryByText(paginationPage('browse-newest-continuation').items[0]!.title.value)).toBeNull();
};

function productionStory(persona: Persona, label: string, state: RecordedState, play: Play): Story {
  return {
    args: { source: 'browse', persona, label, state },
    parameters: { route: { pathname: browsePath } },
    play,
  };
}

function paginationStory(label: string, state: RecordedState, play: Play): Story {
  return {
    args: { source: 'pagination', persona: 'owner', label, state },
    parameters: { route: { pathname: paginationRoute() } },
    play,
  };
}

const populated = (persona: Persona) => productionStory(persona, 'page-browse-default', 'populated', playPopulated);
const search = (persona: Persona) => productionStory(persona, 'page-search-default', 'populated', playSearch);
const empty = (persona: Persona) => productionStory(persona, 'page-search-no-match', 'empty', playEmpty);
const loading = productionStory('visitor', 'page-browse-default', 'loading', playLoading);
const filtered = paginationStory('browse-newest-first', 'populated', playFiltered);
const continuation = paginationStory('browse-newest-continuation', 'populated', playContinuation);
const cursorRefusal = paginationStory('cursor-newest-q-refused', 'error', playCursorRefusal);

export const PopulatedVisitorPhone: Story = at(populated('visitor'), 'phone');
export const PopulatedVisitorDesktop: Story = at(populated('visitor'), 'desktop');
export const PopulatedStrangerPhone: Story = at(populated('stranger'), 'phone');
export const PopulatedStrangerDesktop: Story = at(populated('stranger'), 'desktop');
export const PopulatedMemberPhone: Story = at(populated('member'), 'phone');
export const PopulatedMemberDesktop: Story = at(populated('member'), 'desktop');
export const PopulatedOwnerPhone: Story = at(populated('owner'), 'phone');
export const PopulatedOwnerDesktop: Story = at(populated('owner'), 'desktop');
export const PopulatedModeratorPhone: Story = at(populated('moderator'), 'phone');
export const PopulatedModeratorDesktop: Story = at(populated('moderator'), 'desktop');
export const PopulatedOperatorPhone: Story = at(populated('operator'), 'phone');
export const PopulatedOperatorDesktop: Story = at(populated('operator'), 'desktop');
export const SearchVisitorPhone: Story = at(search('visitor'), 'phone');
export const SearchVisitorDesktop: Story = at(search('visitor'), 'desktop');
export const SearchStrangerPhone: Story = at(search('stranger'), 'phone');
export const SearchStrangerDesktop: Story = at(search('stranger'), 'desktop');
export const SearchMemberPhone: Story = at(search('member'), 'phone');
export const SearchMemberDesktop: Story = at(search('member'), 'desktop');
export const SearchOwnerPhone: Story = at(search('owner'), 'phone');
export const SearchOwnerDesktop: Story = at(search('owner'), 'desktop');
export const SearchModeratorPhone: Story = at(search('moderator'), 'phone');
export const SearchModeratorDesktop: Story = at(search('moderator'), 'desktop');
export const SearchOperatorPhone: Story = at(search('operator'), 'phone');
export const SearchOperatorDesktop: Story = at(search('operator'), 'desktop');
export const EmptyVisitorPhone: Story = at(empty('visitor'), 'phone');
export const EmptyVisitorDesktop: Story = at(empty('visitor'), 'desktop');
export const EmptyStrangerPhone: Story = at(empty('stranger'), 'phone');
export const EmptyStrangerDesktop: Story = at(empty('stranger'), 'desktop');
export const EmptyMemberPhone: Story = at(empty('member'), 'phone');
export const EmptyMemberDesktop: Story = at(empty('member'), 'desktop');
export const EmptyOwnerPhone: Story = at(empty('owner'), 'phone');
export const EmptyOwnerDesktop: Story = at(empty('owner'), 'desktop');
export const EmptyModeratorPhone: Story = at(empty('moderator'), 'phone');
export const EmptyModeratorDesktop: Story = at(empty('moderator'), 'desktop');
export const EmptyOperatorPhone: Story = at(empty('operator'), 'phone');
export const EmptyOperatorDesktop: Story = at(empty('operator'), 'desktop');
export const LoadingVisitorPhone: Story = at(loading, 'phone');
export const LoadingVisitorDesktop: Story = at(loading, 'desktop');
export const FilteredFirstOwnerPhone: Story = at(filtered, 'phone');
export const FilteredFirstOwnerDesktop: Story = at(filtered, 'desktop');
export const ContinuationOwnerPhone: Story = at(continuation, 'phone');
export const ContinuationOwnerDesktop: Story = at(continuation, 'desktop');
export const CursorRefusalOwnerPhone: Story = at(cursorRefusal, 'phone');
export const CursorRefusalOwnerDesktop: Story = at(cursorRefusal, 'desktop');
