import type { Meta, StoryObj } from '@storybook/react-vite';
import { materializeData } from 'native-i18n';
import { useEffect, useState, type ReactNode } from 'react';
import { expect, within } from 'storybook/test';
import type { AnswerRecord } from '../../../../scripts/api/answer-record.ts';
import browseFixture from '../../../../tests/qa/fixtures/outcomes/recipes/catalogue-browse-and-search-in-its-zone.json';
import paginationFixture from '../../../../tests/qa/fixtures/outcomes/recipes/catalogue-pagination-in-its-zone.json';
import { localizedPath } from '../../i18n/locale.ts';
import { spaceHref } from '../address/path.ts';
import { mainApiWithToken } from '../api/main.ts';
import type { RealmReadClient } from '../realm/read.ts';
import type { ZoneBrowsePage } from '../realm/types.ts';
import { messages as shellMessages } from '../shell/messages.ts';
import { PageContainer } from '../shell/page.tsx';
import { recordedFetch, type RecordedSelection, type RecordedState } from '../stories/recorded-fetch.ts';
import { zoneMessagesFor } from './fixtures.ts';
import { ZoneSiteRoute } from './site-route.tsx';

const locale = 'en';
const messages = zoneMessagesFor(locale);
const browseRecord = browseFixture as AnswerRecord;
const paginationRecord = paginationFixture as AnswerRecord;
const personas = ['visitor', 'stranger', 'member', 'owner', 'moderator', 'operator'] as const;
type Persona = typeof personas[number];
type Source = 'browse' | 'pagination';

function recordOf(source: Source) {
  return source === 'pagination' ? paginationRecord : browseRecord;
}

function sampleOf(record: AnswerRecord, persona: Persona, label: string) {
  const found = record.personas[persona].find(answer => answer.label === label);
  if (!found) throw new Error(`Missing recorded Recipes answer: ${record.row}/${persona}/${label}`);
  return found;
}

function pageOf(record: AnswerRecord, persona: Persona, label: string) {
  return sampleOf(record, persona, label).answer as ZoneBrowsePage;
}

function headerName(record: AnswerRecord, persona: Persona) {
  return (sampleOf(record, persona, 'frame-realm-header').answer as { name: { value: string } }).name.value;
}

function actingSubjectOf(record: AnswerRecord, persona: Persona) {
  if (persona === 'visitor') return undefined;
  return (sampleOf(record, persona, 'frame-session-agent').answer as {
    sessionAgent: { actingSubject: string };
  }).sessionAgent.actingSubject;
}

function addressKey(record: AnswerRecord, persona: Persona, label: string) {
  const key = new URL(sampleOf(record, persona, label).path, 'https://recorded.invalid').searchParams.get('key');
  if (!key) throw new Error('Recorded address has no site key');
  return key;
}

const browsePath = localizedPath(spaceHref(addressKey(browseRecord, 'visitor', 'frame-address'), 'site', ['browse']), locale);
const paginationPath = localizedPath(spaceHref(addressKey(paginationRecord, 'visitor', 'site-address'), 'site', ['browse']), locale);

/** The production page's query, taken from the recorded `page-*` request. */
function searchOf(record: AnswerRecord, persona: Persona, label: string): Record<string, string> {
  return Object.fromEntries(new URL(sampleOf(record, persona, label).path, 'https://recorded.invalid').searchParams);
}

function selections(record: AnswerRecord, persona: Persona, label: string, routeLabel: string, addressLabel: string,
  state: RecordedState): RecordedSelection[] {
  const frame = [addressLabel, 'frame-presentation', routeLabel, 'frame-realm-header', 'frame-facets', label];
  const signedIn = persona === 'visitor' ? [] : [
    'frame-session-agent', 'frame-person-preferences', 'frame-joining', 'frame-member-ban', 'frame-follow', 'frame-platform-access',
  ];
  return [...new Set([...frame, ...signedIn])].map(item => ({ label: item,
    state: item === label ? state : sampleOf(record, persona, item).status >= 400 ? 'error' : 'populated' }));
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
 * Browse, search and the next page through `ZoneSiteRoute`.
 * `cursor-newest-q-refused` stays in the mapping test: the page never sends that query, so it is not drawn.
 */
function ProductionVisit({ source, persona, label, routeLabel, state }: {
  source: Source; persona: Persona; label: string; routeLabel: string; state: RecordedState;
}) {
  const [node, setNode] = useState<ReactNode>(null);
  const [error, setError] = useState<Error | null>(null);
  useEffect(() => {
    let active = true;
    const record = recordOf(source);
    const addressLabel = source === 'pagination' ? 'site-address' : 'frame-address';
    const replay = recordedFetch(record, persona, selections(record, persona, label, routeLabel, addressLabel, state));
    const main = mainApiWithToken(undefined, { fetcher: replay.fetcher });
    const client: RealmReadClient = {
      main,
      personal: persona === 'visitor' ? main : mainApiWithToken(`recorded-${persona}`, { fetcher: replay.fetcher }),
      actingSubject: actingSubjectOf(record, persona),
      signedIn: persona !== 'visitor',
    };
    void ZoneSiteRoute({
      params: Promise.resolve({ locale, space: addressKey(record, persona, addressLabel), path: ['browse'] }),
      searchParams: Promise.resolve(searchOf(record, persona, label)),
    }, client).then(rendered => {
      if (active) setNode(rendered);
    }).catch((reason: unknown) => {
      if (!active) return;
      setError(reason instanceof Error ? reason : new Error(String(reason)));
    });
    return () => {
      active = false;
      replay.dispose();
    };
  }, [source, persona, label, routeLabel, state]);
  if (error) throw error;
  if (!node) return pending;
  return node;
}

function RecipesCatalogueBrowse({ source, persona, label, routeLabel, state }: {
  source: Source; persona: Persona; label: string; routeLabel: string; state: RecordedState;
}) {
  return <ProductionVisit source={source} persona={persona} label={label} routeLabel={routeLabel} state={state} />;
}

const meta = {
  title: 'Zones/Recipes catalogue browse',
  component: RecipesCatalogueBrowse,
  args: { source: 'browse', persona: 'visitor', label: 'page-browse-default', routeLabel: 'frame-routes', state: 'populated' },
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
  const answer = pageOf(browseRecord, persona, 'page-browse-default');
  const first = answer.items[0]!;
  const last = answer.items.at(-1)!;
  await expect(await canvas.findByRole('heading', { level: 1, name: headerName(browseRecord, persona) })).toBeVisible();
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
  const answer = pageOf(browseRecord, persona, 'page-search-default');
  const first = answer.items[0]!;
  const last = answer.items.at(-1)!;
  await expect(await canvas.findByRole('heading', { level: 1, name: headerName(browseRecord, persona) })).toBeVisible();
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
  const answer = pageOf(browseRecord, persona, 'page-search-no-match');
  await expect(await canvas.findByRole('heading', { level: 1, name: headerName(browseRecord, persona) })).toBeVisible();
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
  await expect(canvas.queryByText(pageOf(browseRecord, 'visitor', 'page-browse-default').items[0]!.title.value)).toBeNull();
};

const sortLabel = { relevance: messages.sortRelevance, newest: messages.sortNewest, updated: messages.sortUpdated };

/** Visible catalogue for one recorded page the site route reaches, including its continuation. */
const playReached: Play = async ({ canvasElement, args }) => {
  const canvas = within(canvasElement);
  const source = args.source ?? 'browse';
  const persona = args.persona ?? 'visitor';
  const label = args.label ?? 'page-browse-default';
  const record = recordOf(source);
  const sample = sampleOf(record, persona, label);
  const answer = sample.answer as ZoneBrowsePage;
  const first = answer.items[0]!;
  const last = answer.items.at(-1)!;
  await expect(await canvas.findByRole('heading', { level: 1, name: headerName(record, persona) })).toBeVisible();
  await expect(await canvas.findByRole('link', { name: first.title.value })).toBeVisible();
  await expect(canvas.getByRole('link', { name: last.title.value })).toBeVisible();
  await expect(shownCredit(canvas, creditOf(answer))).toBeVisible();
  await expect(canvas.getByText(resultText(answer))).toBeVisible();
  await expect(canvas.getByRole('searchbox')).toHaveValue(answer.query.text ?? '');
  const sorts = within(canvas.getByRole('navigation', { name: messages.sortLabel }));
  const shown = answer.query.text
    ? [messages.sortRelevance, messages.sortNewest, messages.sortUpdated]
    : [messages.sortNewest, messages.sortUpdated];
  for (const name of shown) await expect(sorts.getByRole('link', { name })).toBeVisible();
  if (!answer.query.text) await expect(sorts.queryByRole('link', { name: messages.sortRelevance })).toBeNull();
  const current = answer.query.text ? (answer.query.sort ?? 'relevance') : (answer.query.sort ?? 'newest');
  const currentLabel = current === 'relevance' ? sortLabel.relevance
    : current === 'updated' ? sortLabel.updated : sortLabel.newest;
  if (current !== 'relevance' && current !== 'newest' && current !== 'updated')
    throw new Error(`Recorded sort is not shown: ${current}`);
  await expect(sorts.getByRole('link', { name: currentLabel })).toHaveAttribute('aria-current', 'true');
  const requested = new URL(sample.path, 'https://recorded.invalid').searchParams.get('cursor');
  if (answer.nextCursor) {
    const next = canvas.getByRole('link', { name: messages.next });
    await expect(new URL(next.getAttribute('href')!, 'https://recorded.invalid').searchParams.get('cursor'))
      .toBe(answer.nextCursor);
  } else await expect(canvas.queryByRole('link', { name: messages.next })).toBeNull();
  if (requested) await expect(canvas.getByRole('link', { name: messages.previous })).toBeVisible();
  else await expect(canvas.queryByRole('link', { name: messages.previous })).toBeNull();
};

function productionStory(persona: Persona, label: string, state: RecordedState, play: Play,
  routeLabel = 'frame-routes'): Story {
  return {
    args: { source: 'browse', persona, label, routeLabel, state },
    parameters: { route: { pathname: browsePath } },
    play,
  };
}

function paginationStory(persona: Persona, label: string, routeLabel: string, play: Play): Story {
  return {
    args: { source: 'pagination', persona, label, routeLabel, state: 'populated' },
    parameters: { route: { pathname: paginationPath } },
    play,
  };
}

const populated = (persona: Persona) => productionStory(persona, 'page-browse-default', 'populated', playPopulated);
const search = (persona: Persona) => productionStory(persona, 'page-search-default', 'populated', playSearch);
const empty = (persona: Persona) => productionStory(persona, 'page-search-no-match', 'empty', playEmpty);
const loading = productionStory('visitor', 'page-browse-default', 'loading', playLoading);
const browseContinuation = (persona: Persona) => productionStory(persona, 'page-browse-default-continuation-1', 'populated',
  playReached, 'page-browse-default-zone-continuation');
const searchPage = (persona: Persona) => paginationStory(persona, 'page-search-newest', 'frame-routes', playReached);
const searchContinuation = (persona: Persona) => paginationStory(persona, 'page-search-newest-continuation-1',
  'site-search-newest-route', playReached);

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
export const BrowseContinuationVisitorPhone: Story = at(browseContinuation('visitor'), 'phone');
export const BrowseContinuationVisitorDesktop: Story = at(browseContinuation('visitor'), 'desktop');
export const BrowseContinuationStrangerPhone: Story = at(browseContinuation('stranger'), 'phone');
export const BrowseContinuationStrangerDesktop: Story = at(browseContinuation('stranger'), 'desktop');
export const BrowseContinuationMemberPhone: Story = at(browseContinuation('member'), 'phone');
export const BrowseContinuationMemberDesktop: Story = at(browseContinuation('member'), 'desktop');
export const BrowseContinuationOwnerPhone: Story = at(browseContinuation('owner'), 'phone');
export const BrowseContinuationOwnerDesktop: Story = at(browseContinuation('owner'), 'desktop');
export const BrowseContinuationModeratorPhone: Story = at(browseContinuation('moderator'), 'phone');
export const BrowseContinuationModeratorDesktop: Story = at(browseContinuation('moderator'), 'desktop');
export const BrowseContinuationOperatorPhone: Story = at(browseContinuation('operator'), 'phone');
export const BrowseContinuationOperatorDesktop: Story = at(browseContinuation('operator'), 'desktop');
export const SearchNextVisitorPhone: Story = at(searchPage('visitor'), 'phone');
export const SearchNextVisitorDesktop: Story = at(searchPage('visitor'), 'desktop');
export const SearchNextStrangerPhone: Story = at(searchPage('stranger'), 'phone');
export const SearchNextStrangerDesktop: Story = at(searchPage('stranger'), 'desktop');
export const SearchNextMemberPhone: Story = at(searchPage('member'), 'phone');
export const SearchNextMemberDesktop: Story = at(searchPage('member'), 'desktop');
export const SearchNextOwnerPhone: Story = at(searchPage('owner'), 'phone');
export const SearchNextOwnerDesktop: Story = at(searchPage('owner'), 'desktop');
export const SearchNextModeratorPhone: Story = at(searchPage('moderator'), 'phone');
export const SearchNextModeratorDesktop: Story = at(searchPage('moderator'), 'desktop');
export const SearchNextOperatorPhone: Story = at(searchPage('operator'), 'phone');
export const SearchNextOperatorDesktop: Story = at(searchPage('operator'), 'desktop');
export const SearchContinuationVisitorPhone: Story = at(searchContinuation('visitor'), 'phone');
export const SearchContinuationVisitorDesktop: Story = at(searchContinuation('visitor'), 'desktop');
export const SearchContinuationStrangerPhone: Story = at(searchContinuation('stranger'), 'phone');
export const SearchContinuationStrangerDesktop: Story = at(searchContinuation('stranger'), 'desktop');
export const SearchContinuationMemberPhone: Story = at(searchContinuation('member'), 'phone');
export const SearchContinuationMemberDesktop: Story = at(searchContinuation('member'), 'desktop');
export const SearchContinuationOwnerPhone: Story = at(searchContinuation('owner'), 'phone');
export const SearchContinuationOwnerDesktop: Story = at(searchContinuation('owner'), 'desktop');
export const SearchContinuationModeratorPhone: Story = at(searchContinuation('moderator'), 'phone');
export const SearchContinuationModeratorDesktop: Story = at(searchContinuation('moderator'), 'desktop');
export const SearchContinuationOperatorPhone: Story = at(searchContinuation('operator'), 'phone');
export const SearchContinuationOperatorDesktop: Story = at(searchContinuation('operator'), 'desktop');
