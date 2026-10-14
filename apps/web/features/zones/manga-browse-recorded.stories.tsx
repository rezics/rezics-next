import type { Meta, StoryObj } from '@storybook/react-vite';
import { materializeData } from 'native-i18n';
import { expect, within } from 'storybook/test';
import type { AnswerRecord } from '../../../../scripts/api/answer-record.ts';
import manga from '../../../../tests/qa/fixtures/outcomes/manga/catalogue-browse-and-search-in-its-zone.json';
import { localizedPath } from '../../i18n/locale.ts';
import { spaceHref } from '../address/path.ts';
import type { ZoneBrowsePage } from '../realm/types.ts';
import { messages as shellMessages } from '../shell/messages.ts';
import { messages } from './messages.ts';
import { MangaBrowseRecordedPage } from './manga-browse-recorded-page.tsx';
import { mangaBrowsePersonas, recordedSample, recordedSiteKey } from './manga-browse-recorded-page.ts';

const record = manga as AnswerRecord;
const locale = 'en' as const;
type Persona = (typeof mangaBrowsePersonas)[number];

function answer(persona: Persona, label: string): ZoneBrowsePage {
  return recordedSample(record, persona, label).answer as ZoneBrowsePage;
}

function realmName(persona: Persona): string {
  return (recordedSample(record, persona, 'frame-realm-header').answer as { name: { value: string } }).name.value;
}

function resultText(persona: Persona, label: string): string {
  const matches = answer(persona, label).matches;
  const t = materializeData(messages, { locale });
  return matches.kind === 'exact' ? t.results(matches.value) : t.resultsAtLeast({ count: String(matches.value) });
}

function creditOf(persona: Persona, label: string): string {
  const name = answer(persona, label).items[0]?.primaryCredits.find(item => item.displayName)?.displayName;
  if (!name) throw new Error('Recorded manga card has no credit');
  return name;
}

const browsePath = localizedPath(spaceHref(recordedSiteKey(record), 'site', ['browse']), locale);

const meta = {
  title: 'Zones/Recorded manga browse',
  component: MangaBrowseRecordedPage,
  args: { persona: 'visitor' as const, label: 'page-browse-default', state: 'populated' as const },
  parameters: { route: { pathname: browsePath } },
  globals: { locale },
} satisfies Meta<typeof MangaBrowseRecordedPage>;
export default meta;
type Story = StoryObj<typeof meta>;
type Play = NonNullable<Story['play']>;

function at(story: Story, viewport: 'phone' | 'desktop'): Story {
  return { ...story, globals: { locale, viewport: { value: viewport } } };
}

/** The generated cover repeats the credit in a hidden paragraph. The byline is the name a reader sees. */
function bylines(canvas: ReturnType<typeof within>, name: string): HTMLElement[] {
  const found: HTMLElement[] = [];
  for (const element of canvas.getAllByText(name) as HTMLElement[]) {
    const byline = element.closest('p.truncate');
    if (byline instanceof HTMLElement && !found.includes(byline)) found.push(byline);
  }
  return found;
}

const playPopulated: Play = async ({ canvasElement, args }) => {
  const canvas = within(canvasElement);
  const persona = (args.persona ?? 'visitor') as Persona;
  const page = answer(persona, 'page-browse-default');
  const first = page.items[0]!;
  const last = page.items.at(-1)!;
  const credit = creditOf(persona, 'page-browse-default');
  await expect(canvas.findByRole('heading', { level: 1, name: realmName(persona) })).resolves.toBeVisible();
  await expect(canvas.findByRole('link', { name: first.title.value })).resolves.toBeVisible();
  await expect(canvas.getByRole('link', { name: last.title.value })).toBeVisible();
  const credited = bylines(canvas, credit);
  await expect(credited).toHaveLength(page.items.filter(item =>
    item.primaryCredits.some(entry => entry.displayName === credit)).length);
  await expect(credited[0]).toBeVisible();
  await expect(canvas.getByRole('status')).toHaveTextContent(resultText(persona, 'page-browse-default'));
  await expect(canvas.getByRole('searchbox')).toHaveValue('');
  const sorts = within(canvas.getByRole('navigation', { name: messages.sortLabel }));
  await expect(sorts.getByRole('link', { name: messages.sortNewest })).toHaveAttribute('aria-current', 'true');
  await expect(sorts.getByRole('link', { name: messages.sortUpdated })).toBeVisible();
  await expect(sorts.queryByRole('link', { name: messages.sortRelevance })).toBeNull();
  await expect(canvas.queryByRole('link', { name: messages.next })).toBeNull();
  await expect(canvas.queryByRole('link', { name: messages.previous })).toBeNull();
};

const playSearch: Play = async ({ canvasElement, args }) => {
  const canvas = within(canvasElement);
  const persona = (args.persona ?? 'visitor') as Persona;
  const page = answer(persona, 'page-search-default');
  const first = page.items[0]!;
  const last = page.items.at(-1)!;
  await expect(canvas.findByRole('heading', { level: 1, name: realmName(persona) })).resolves.toBeVisible();
  await expect(canvas.findByRole('link', { name: first.title.value })).resolves.toBeVisible();
  await expect(canvas.getByRole('link', { name: last.title.value })).toBeVisible();
  await expect(bylines(canvas, creditOf(persona, 'page-search-default'))[0]).toBeVisible();
  await expect(canvas.getByRole('status')).toHaveTextContent(resultText(persona, 'page-search-default'));
  await expect(canvas.getByRole('searchbox')).toHaveValue(page.query.text);
  const sorts = within(canvas.getByRole('navigation', { name: messages.sortLabel }));
  for (const name of [messages.sortRelevance, messages.sortNewest, messages.sortUpdated])
    await expect(sorts.getByRole('link', { name })).toBeVisible();
  await expect(sorts.getByRole('link', { name: messages.sortRelevance })).toHaveAttribute('aria-current', 'true');
  await expect(canvas.queryByRole('link', { name: messages.next })).toBeNull();
};

const playEmpty: Play = async ({ canvasElement, args }) => {
  const canvas = within(canvasElement);
  const persona = (args.persona ?? 'visitor') as Persona;
  const page = answer(persona, 'page-search-no-match');
  await expect(canvas.findByRole('heading', { level: 1, name: realmName(persona) })).resolves.toBeVisible();
  await expect(canvas.findByRole('heading', { name: messages.browseEmptyTitle })).resolves.toBeVisible();
  await expect(canvas.getByText(messages.browseEmptyBody)).toBeVisible();
  await expect(canvas.getByRole('status')).toHaveTextContent(resultText(persona, 'page-search-no-match'));
  await expect(canvas.getByRole('searchbox')).toHaveValue(page.query.text);
  const sorts = within(canvas.getByRole('navigation', { name: messages.sortLabel }));
  await expect(sorts.getByRole('link', { name: messages.sortRelevance })).toHaveAttribute('aria-current', 'true');
  await expect(canvas.queryByRole('link', { name: messages.next })).toBeNull();
  await expect(canvas.queryByRole('link', { name: messages.previous })).toBeNull();
};

const playLoading: Play = async ({ canvasElement }) => {
  const canvas = within(canvasElement);
  await expect(canvas.findByRole('status')).resolves.toHaveTextContent(shellMessages.loading);
  await expect(canvas.getByRole('status')).toHaveAttribute('aria-busy', 'true');
  await expect(canvas.queryByRole('heading', { level: 1 })).toBeNull();
  await expect(canvas.queryByRole('link', { name: answer('visitor', 'page-browse-default').items[0]!.title.value }))
    .toBeNull();
};

function story(persona: Persona, label: string, state: 'populated' | 'empty' | 'loading', play: Play): Story {
  return { args: { persona, label, state }, parameters: { route: { pathname: browsePath } }, play };
}

const populated = (persona: Persona) => story(persona, 'page-browse-default', 'populated', playPopulated);
const search = (persona: Persona) => story(persona, 'page-search-default', 'populated', playSearch);
const empty = (persona: Persona) => story(persona, 'page-search-no-match', 'empty', playEmpty);
const loading = story('visitor', 'page-browse-default', 'loading', playLoading);

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
