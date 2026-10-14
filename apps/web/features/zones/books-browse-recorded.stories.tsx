import type { Meta, StoryObj } from '@storybook/react-vite';
import { materializeData } from 'native-i18n';
import { useEffect, useState, type ReactNode } from 'react';
import { expect, within } from 'storybook/test';
import type { AnswerRecord } from '../../../../scripts/api/answer-record.ts';
import browseFixture from '../../../../tests/qa/fixtures/outcomes/books/catalogue-browse-and-search-in-its-zone.json';
import { localizedPath } from '../../i18n/locale.ts';
import { spaceHref } from '../address/path.ts';
import { mainApiWithToken } from '../api/main.ts';
import type { RealmReadClient } from '../realm/read.ts';
import { RealmBrowseRoute } from '../realm/routes.tsx';
import type { ZoneBrowsePage } from '../realm/types.ts';
import { messages as shellMessages } from '../shell/messages.ts';
import { PageContainer } from '../shell/page.tsx';
import { recordedFetch, type RecordedSelection, type RecordedState } from '../stories/recorded-fetch.ts';
import { zoneMessagesFor } from './fixtures.ts';

const locale = 'en';
const messages = zoneMessagesFor(locale);
const browseRecord = browseFixture as AnswerRecord;
const personas = ['visitor', 'stranger', 'member', 'owner', 'moderator', 'operator'] as const;
type Persona = typeof personas[number];

function browseSample(persona: Persona, label: string) {
  const found = browseRecord.personas[persona].find(answer => answer.label === label);
  if (!found) throw new Error(`Missing recorded Books answer: ${persona}/${label}`);
  return found;
}

function pageOf(persona: Persona, label: string) {
  return browseSample(persona, label).answer as ZoneBrowsePage;
}

function headerName(persona: Persona) {
  return (browseSample(persona, 'frame-realm-header').answer as { name: { value: string } }).name.value;
}

/** The visitor has no acting Person. A signed-in reader keeps the recorded session's Person. */
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
    'frame-session-agent', 'frame-person-preferences', 'frame-joining', 'frame-member-ban', 'frame-follow', 'frame-platform-access',
  ];
  return [...frame, ...signedIn].map(item => ({
    label: item,
    state: item === label ? state : browseSample(persona, item).status >= 400 ? 'error' : 'populated',
  }));
}

function resultText(answer: ZoneBrowsePage) {
  const t = materializeData(messages, { locale });
  return answer.matches.kind === 'exact'
    ? t.results(answer.matches.value)
    : t.resultsAtLeast({ count: String(answer.matches.value) });
}

function creditOf(answer: ZoneBrowsePage) {
  const name = answer.items[0]?.primaryCredits.find(item => item.displayName)?.displayName;
  if (!name) throw new Error('Recorded book has no credited name');
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
 * A later page's routes read belongs to the site route; these stories open the catalogue the route renders.
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

const meta = {
  title: 'Zones/Books catalogue browse',
  component: ProductionBrowse,
  args: { persona: 'visitor' as Persona, label: 'page-browse-default', state: 'populated' as RecordedState },
  parameters: { route: { pathname: browsePath } },
  globals: { locale },
} satisfies Meta<typeof ProductionBrowse>;
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

const playContinuation: Play = async ({ canvasElement, args }) => {
  const canvas = within(canvasElement);
  const persona = args.persona ?? 'visitor';
  const answer = pageOf(persona, 'page-browse-default-continuation-1');
  await expect(await canvas.findByRole('heading', { level: 1, name: headerName(persona) })).toBeVisible();
  await expect(await canvas.findByRole('link', { name: answer.items[0]!.title.value })).toBeVisible();
  await expect(shownCredit(canvas, creditOf(answer))).toBeVisible();
  await expect(canvas.getByText(resultText(answer))).toBeVisible();
  await expect(canvas.getByRole('searchbox')).toHaveValue('');
  const sorts = within(canvas.getByRole('navigation', { name: messages.sortLabel }));
  await expect(sorts.getByRole('link', { name: messages.sortNewest })).toHaveAttribute('aria-current', 'true');
  await expect(canvas.getByRole('link', { name: messages.previous })).toBeVisible();
  await expect(canvas.queryByRole('link', { name: messages.next })).toBeNull();
};

const playLoading: Play = async ({ canvasElement }) => {
  const canvas = within(canvasElement);
  await expect(await canvas.findByRole('status')).toHaveTextContent(shellMessages.loading);
  await expect(canvas.getByRole('status')).toHaveAttribute('aria-busy', 'true');
  await expect(canvas.queryByRole('heading', { level: 1 })).toBeNull();
  await expect(canvas.queryByText(pageOf('visitor', 'page-browse-default').items[0]!.title.value)).toBeNull();
};

function productionStory(persona: Persona, label: string, state: RecordedState, play: Play): Story {
  return {
    args: { persona, label, state },
    parameters: { route: { pathname: browsePath } },
    play,
  };
}

const populated = (persona: Persona) => productionStory(persona, 'page-browse-default', 'populated', playPopulated);
const search = (persona: Persona) => productionStory(persona, 'page-search-default', 'populated', playSearch);
const empty = (persona: Persona) => productionStory(persona, 'page-search-no-match', 'empty', playEmpty);
const continuation = (persona: Persona) => productionStory(persona, 'page-browse-default-continuation-1', 'populated', playContinuation);
const loading = productionStory('visitor', 'page-browse-default', 'loading', playLoading);

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
export const ContinuationVisitorPhone: Story = at(continuation('visitor'), 'phone');
export const ContinuationVisitorDesktop: Story = at(continuation('visitor'), 'desktop');
export const ContinuationStrangerPhone: Story = at(continuation('stranger'), 'phone');
export const ContinuationStrangerDesktop: Story = at(continuation('stranger'), 'desktop');
export const ContinuationMemberPhone: Story = at(continuation('member'), 'phone');
export const ContinuationMemberDesktop: Story = at(continuation('member'), 'desktop');
export const ContinuationOwnerPhone: Story = at(continuation('owner'), 'phone');
export const ContinuationOwnerDesktop: Story = at(continuation('owner'), 'desktop');
export const ContinuationModeratorPhone: Story = at(continuation('moderator'), 'phone');
export const ContinuationModeratorDesktop: Story = at(continuation('moderator'), 'desktop');
export const ContinuationOperatorPhone: Story = at(continuation('operator'), 'phone');
export const ContinuationOperatorDesktop: Story = at(continuation('operator'), 'desktop');
export const LoadingVisitorPhone: Story = at(loading, 'phone');
export const LoadingVisitorDesktop: Story = at(loading, 'desktop');
