import type { CanonicalAddress } from '@rezics/model/address';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { materializeData } from 'native-i18n';
import { expect, within } from 'storybook/test';
import type { AnswerRecord } from '../../../../scripts/api/answer-record.ts';
import manga from '../../../../tests/qa/fixtures/outcomes/manga/catalogue-browse-and-search-in-its-zone.json';
import type { UiLocale } from '../../i18n/define.ts';
import { localizedPath } from '../../i18n/locale.ts';
import { spaceHref } from '../address/path.ts';
import type { ZoneBrowsePage } from '../realm/types.ts';
import { messages as realmMessages } from '../realm/messages.ts';
import { messages as shellMessages } from '../shell/messages.ts';
import { messages } from './messages.ts';
import { MangaBrowseRecordedPage } from './manga-browse-recorded-page.tsx';
import { recordedSample } from './manga-browse-recorded-page.ts';

const record = manga as AnswerRecord;
const persona = 'owner' as const;
const locale = 'en' as const;

function answer(label: string): ZoneBrowsePage {
  return recordedSample(record, persona, label).answer as ZoneBrowsePage;
}

function sitePath(): string {
  const address = (recordedSample(record, persona, 'zone-presentation').answer as { address: CanonicalAddress }).address;
  return localizedPath(spaceHref(address, 'site', ['browse']), locale);
}

function realmName(): string {
  return (recordedSample(record, persona, 'realm-context').answer as { name: { value: string } }).name.value;
}

const resultText = (label: string) => {
  const matches = answer(label).matches;
  const t = materializeData(messages, { locale });
  return matches.kind === 'exact' ? t.results(matches.value) : t.resultsAtLeast({ count: String(matches.value) });
};

const meta = {
  title: 'Zones/Recorded manga browse',
  component: MangaBrowseRecordedPage,
  args: { record, persona, label: 'browse-newest', state: 'populated' as const, locale },
  parameters: { route: { pathname: sitePath() } },
  render: (args, { globals }) => (
    <MangaBrowseRecordedPage {...args} locale={(globals.locale as UiLocale | undefined) ?? args.locale} />
  ),
} satisfies Meta<typeof MangaBrowseRecordedPage>;
export default meta;
type Story = StoryObj<typeof meta>;

async function populatedPlay({ canvasElement }: { canvasElement: HTMLElement }) {
  const canvas = within(canvasElement);
  const page = answer('browse-newest');
  const credit = page.items[0]?.primaryCredits.find(item => item.displayName)?.displayName;
  if (!credit) throw new Error('Recorded browse card has no credit');
  await expect(canvas.findByRole('heading', { level: 1, name: realmName() })).resolves.toBeVisible();
  await expect(canvas.findByRole('link', { name: page.items[0]!.title.value })).resolves.toBeVisible();
  const credited = page.items.filter(item => item.primaryCredits.some(creditItem => creditItem.displayName === credit));
  // The name sits in the byline link. The generated cover paints the same string in a hidden paragraph.
  const bylines = [...new Set(canvas.getAllByText(credit).flatMap(element => {
    const byline = element.closest('p.truncate');
    return byline instanceof HTMLElement ? [byline] : [];
  }))];
  await expect(bylines).toHaveLength(credited.length);
  await expect(bylines[0]).toBeVisible();
  await expect(canvas.getByRole('status')).toHaveTextContent(resultText('browse-newest'));
  const sorts = within(canvas.getByRole('navigation', { name: messages.sortLabel }));
  await expect(sorts.getByRole('link', { name: messages.sortNewest })).toHaveAttribute('aria-current', 'true');
  await expect(sorts.getByRole('link', { name: messages.sortUpdated })).toBeVisible();
  const next = canvas.getByRole('link', { name: messages.next });
  await expect(next).toBeVisible();
  await expect(new URL(next.getAttribute('href')!, 'https://recorded.invalid').searchParams.get('cursor'))
    .toBe(page.nextCursor);
}

async function searchPlay({ canvasElement }: { canvasElement: HTMLElement }) {
  const canvas = within(canvasElement);
  const page = answer('search-newest');
  await expect(canvas.findByRole('link', { name: page.items[0]!.title.value })).resolves.toBeVisible();
  await expect(canvas.getByRole('status')).toHaveTextContent(resultText('search-newest'));
  await expect(canvas.getByRole('searchbox')).toHaveValue(page.query.text);
  const sorts = within(canvas.getByRole('navigation', { name: messages.sortLabel }));
  for (const name of [messages.sortRelevance, messages.sortNewest, messages.sortUpdated])
    await expect(sorts.getByRole('link', { name })).toBeVisible();
  await expect(sorts.getByRole('link', { name: messages.sortNewest })).toHaveAttribute('aria-current', 'true');
}

async function continuationPlay({ canvasElement }: { canvasElement: HTMLElement }) {
  const canvas = within(canvasElement);
  const page = answer('browse-newest-continuation');
  const first = answer('browse-newest');
  await expect(canvas.findByRole('link', { name: page.items[0]!.title.value })).resolves.toBeVisible();
  await expect(canvas.queryByRole('link', { name: first.items[0]!.title.value })).toBeNull();
  await expect(canvas.getByRole('status')).toHaveTextContent(resultText('browse-newest-continuation'));
  await expect(canvas.getByRole('link', { name: messages.previous })).toBeVisible();
  if (page.nextCursor) {
    const next = canvas.getByRole('link', { name: messages.next });
    await expect(new URL(next.getAttribute('href')!, 'https://recorded.invalid').searchParams.get('cursor'))
      .toBe(page.nextCursor);
  }
}

async function emptyPlay({ canvasElement }: { canvasElement: HTMLElement }) {
  const canvas = within(canvasElement);
  const page = answer('search-no-match');
  await expect(canvas.findByRole('heading', { name: messages.browseEmptyTitle })).resolves.toBeVisible();
  await expect(canvas.getByText(messages.browseEmptyBody)).toBeVisible();
  await expect(canvas.getByRole('status')).toHaveTextContent(resultText('search-no-match'));
  await expect(canvas.getByRole('searchbox')).toHaveValue(page.query.text);
  await expect(canvas.queryByRole('link', { name: messages.next })).toBeNull();
}

async function refusalPlay({ canvasElement }: { canvasElement: HTMLElement }) {
  const canvas = within(canvasElement);
  await expect(canvas.findByRole('heading', { name: realmMessages.movedTitle })).resolves.toBeVisible();
  await expect(canvas.getByText(realmMessages.movedBody)).toBeVisible();
  await expect(canvas.getByRole('button', { name: realmMessages.retry })).toBeVisible();
  await expect(canvas.queryByText(messages.browseEmptyTitle)).toBeNull();
}

async function loadingPlay({ canvasElement }: { canvasElement: HTMLElement }) {
  const canvas = within(canvasElement);
  await expect(canvas.findByRole('heading', { level: 1, name: realmName() })).resolves.toBeVisible();
  await expect(canvas.getByRole('status')).toHaveTextContent(shellMessages.loading);
  await expect(canvas.getByRole('status')).toHaveAttribute('aria-busy', 'true');
  await expect(canvas.queryByRole('link', { name: answer('browse-newest').items[0]!.title.value })).toBeNull();
}

const populated = { args: { label: 'browse-newest', state: 'populated' as const }, play: populatedPlay } satisfies Story;
const search = { args: { label: 'search-newest', state: 'populated' as const }, play: searchPlay } satisfies Story;
const continuation = {
  args: { label: 'browse-newest-continuation', state: 'populated' as const }, play: continuationPlay,
} satisfies Story;
const empty = { args: { label: 'search-no-match', state: 'empty' as const }, play: emptyPlay } satisfies Story;
const refusal = { args: { label: 'unsupported-query-shape', state: 'error' as const }, play: refusalPlay } satisfies Story;
const loading = { args: { label: 'browse-newest', state: 'loading' as const }, play: loadingPlay } satisfies Story;

function at(story: Story, viewport: 'phone' | 'desktop'): Story {
  return { ...story, globals: { locale, viewport: { value: viewport } } };
}

export const PopulatedOwnerPhone: Story = at(populated, 'phone');
export const PopulatedOwnerDesktop: Story = at(populated, 'desktop');
export const SearchOwnerPhone: Story = at(search, 'phone');
export const SearchOwnerDesktop: Story = at(search, 'desktop');
export const ContinuationOwnerPhone: Story = at(continuation, 'phone');
export const ContinuationOwnerDesktop: Story = at(continuation, 'desktop');
export const EmptyOwnerPhone: Story = at(empty, 'phone');
export const EmptyOwnerDesktop: Story = at(empty, 'desktop');
export const RefusalOwnerPhone: Story = at(refusal, 'phone');
export const RefusalOwnerDesktop: Story = at(refusal, 'desktop');
export const LoadingOwnerPhone: Story = at(loading, 'phone');
export const LoadingOwnerDesktop: Story = at(loading, 'desktop');
