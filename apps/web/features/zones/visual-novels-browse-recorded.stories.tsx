import type { Meta, StoryObj } from '@storybook/react-vite';
import { materializeData } from 'native-i18n';
import { expect, within } from 'storybook/test';
import type { AnswerPersona, AnswerRecord } from '../../../../scripts/api/answer-record.ts';
import visualNovels from '../../../../tests/qa/fixtures/outcomes/visual-novels/catalogue-browse-and-search-in-its-zone.json';
import type { UiLocale } from '../../i18n/define.ts';
import { realmMessagesFor } from '../realm/story-page.tsx';
import type { ZoneBrowsePage } from '../realm/types.ts';
import { messages as shellMessages } from '../shell/messages.ts';
import { zoneMessagesFor } from './fixtures.ts';
import {
  recordedBrowseSample, recordedBrowseZone, visualNovelsBrowseSamples,
} from './visual-novels-browse-recorded-page.ts';
import { VisualNovelsBrowseRecordedPage } from './visual-novels-browse-recorded-page.tsx';

const record = visualNovels as AnswerRecord;
const locale = 'en' as const;
const messages = zoneMessagesFor(locale);
const realmMessages = realmMessagesFor(locale);

function page(persona: AnswerPersona, label: string): ZoneBrowsePage {
  return recordedBrowseSample(record, persona, label).answer as ZoneBrowsePage;
}

function resultText(persona: AnswerPersona, label: string): string {
  const matches = page(persona, label).matches;
  const t = materializeData(messages, { locale });
  return matches.kind === 'exact' ? t.results(matches.value) : t.resultsAtLeast({ count: String(matches.value) });
}

function zoneName(persona: AnswerPersona): string {
  return recordedBrowseZone(record, persona, locale).zone.name.value;
}

const meta = {
  title: 'Zones/Visual novels browse',
  component: VisualNovelsBrowseRecordedPage,
  args: { record, persona: 'visitor' as const, label: visualNovelsBrowseSamples.newest, state: 'populated' as const, locale },
  parameters: { route: { pathname: recordedBrowseZone(record, 'visitor', locale).zone.links.browse } },
  render: (args, { globals }) => (
    <VisualNovelsBrowseRecordedPage {...args} locale={(globals.locale as UiLocale | undefined) ?? args.locale} />
  ),
} satisfies Meta<typeof VisualNovelsBrowseRecordedPage>;
export default meta;
type Story = StoryObj<typeof meta>;

async function fits(phone: boolean) {
  if (phone) await expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(window.innerWidth);
}

function populatedPlay(phone: boolean): NonNullable<Story['play']> {
  return async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const answer = page('visitor', visualNovelsBrowseSamples.newest);
    const author = answer.items[0]?.primaryCredits?.find(credit => credit.displayName)?.displayName;
    if (!author) throw new Error('Recorded visual novel has no author credit');
    await expect(await canvas.findByRole('link', { name: answer.items[0]!.title.value })).toBeVisible();
    await expect(canvas.getAllByRole('link', { name: author })).toHaveLength(answer.items.length);
    await expect(canvas.getByRole('status')).toHaveTextContent(resultText('visitor', visualNovelsBrowseSamples.newest));
    const sorts = within(canvas.getByRole('navigation', { name: messages.sortLabel }));
    await expect(sorts.getByRole('link', { name: messages.sortNewest })).toHaveAttribute('aria-current', 'true');
    await expect(sorts.getByRole('link', { name: messages.sortUpdated })).toBeVisible();
    const next = canvas.getByRole('link', { name: messages.next });
    await expect(next).toBeVisible();
    await expect(new URL(next.getAttribute('href')!, 'https://recorded.invalid').searchParams.get('cursor')).toBe(answer.nextCursor);
    await fits(phone);
  };
}

function searchPlay(label: typeof visualNovelsBrowseSamples.relevance | typeof visualNovelsBrowseSamples.updated,
  current: string, phone: boolean): NonNullable<Story['play']> {
  return async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const answer = page('visitor', label);
    await expect(await canvas.findByRole('link', { name: answer.items[0]!.title.value })).toBeVisible();
    await expect(canvas.getByRole('status')).toHaveTextContent(resultText('visitor', label));
    if (typeof answer.query.text !== 'string') throw new Error('Recorded search has no text');
    await expect(canvas.getByRole('searchbox')).toHaveValue(answer.query.text);
    const sorts = within(canvas.getByRole('navigation', { name: messages.sortLabel }));
    for (const name of [messages.sortRelevance, messages.sortNewest, messages.sortUpdated])
      await expect(sorts.getByRole('link', { name })).toBeVisible();
    await expect(sorts.getByRole('link', { name: current })).toHaveAttribute('aria-current', 'true');
    await fits(phone);
  };
}

function continuationPlay(phone: boolean): NonNullable<Story['play']> {
  return async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const answer = page('visitor', visualNovelsBrowseSamples.continuation);
    await expect(await canvas.findByRole('link', { name: answer.items[0]!.title.value })).toBeVisible();
    await expect(canvas.getByRole('status')).toHaveTextContent(resultText('visitor', visualNovelsBrowseSamples.continuation));
    await expect(canvas.queryByRole('link', { name: messages.next })).toBeNull();
    const previous = canvas.getByRole('link', { name: messages.previous });
    await expect(previous).toBeVisible();
    await expect(new URL(previous.getAttribute('href')!, 'https://recorded.invalid').searchParams.has('cursor')).toBe(false);
    await fits(phone);
  };
}

function emptyPlay(phone: boolean): NonNullable<Story['play']> {
  return async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(await canvas.findByRole('heading', { name: messages.browseEmptyTitle })).toBeVisible();
    await expect(canvas.getByText(messages.browseEmptyBody)).toBeVisible();
    await expect(canvas.getByRole('status')).toHaveTextContent(resultText('member', visualNovelsBrowseSamples.empty));
    const text = page('member', visualNovelsBrowseSamples.empty).query.text;
    if (typeof text !== 'string') throw new Error('Recorded empty search has no text');
    await expect(canvas.getByRole('searchbox')).toHaveValue(text);
    await expect(canvas.queryByRole('link', { name: messages.next })).toBeNull();
    await fits(phone);
  };
}

function refusalPlay(phone: boolean): NonNullable<Story['play']> {
  return async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(await canvas.findByRole('heading', { name: realmMessages.movedTitle })).toBeVisible();
    await expect(canvas.getByText(realmMessages.movedBody)).toBeVisible();
    await expect(canvas.getByRole('button', { name: realmMessages.retry })).toBeVisible();
    await expect(canvas.queryByText(messages.browseEmptyTitle)).toBeNull();
    await expect(canvas.queryByText(page('visitor', visualNovelsBrowseSamples.newest).items[0]!.title.value)).toBeNull();
    await fits(phone);
  };
}

function loadingPlay(phone: boolean): NonNullable<Story['play']> {
  return async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(await canvas.findByRole('heading', { level: 1, name: zoneName('visitor') })).toBeVisible();
    await expect(canvas.getByRole('status')).toHaveTextContent(shellMessages.loading);
    await expect(canvas.getByRole('status')).toHaveAttribute('aria-busy', 'true');
    await expect(canvas.queryByText(page('visitor', visualNovelsBrowseSamples.newest).items[0]!.title.value)).toBeNull();
    await fits(phone);
  };
}

function at(story: Story, viewport: 'phone' | 'desktop'): Story {
  return { ...story, globals: { locale, viewport: { value: viewport } } };
}

const populated = { play: populatedPlay(false) } satisfies Story;
export const VisitorPopulatedPhone: Story = at({ ...populated, play: populatedPlay(true) }, 'phone');
export const VisitorPopulatedDesktop: Story = at(populated, 'desktop');

const relevance = {
  args: { label: visualNovelsBrowseSamples.relevance },
  play: searchPlay(visualNovelsBrowseSamples.relevance, messages.sortRelevance, false),
} satisfies Story;
export const VisitorSearchPhone: Story = at({ ...relevance, play: searchPlay(visualNovelsBrowseSamples.relevance, messages.sortRelevance, true) }, 'phone');
export const VisitorSearchDesktop: Story = at(relevance, 'desktop');

const updated = {
  args: { label: visualNovelsBrowseSamples.updated },
  play: searchPlay(visualNovelsBrowseSamples.updated, messages.sortUpdated, false),
} satisfies Story;
export const VisitorUpdatedPhone: Story = at({ ...updated, play: searchPlay(visualNovelsBrowseSamples.updated, messages.sortUpdated, true) }, 'phone');
export const VisitorUpdatedDesktop: Story = at(updated, 'desktop');

const continuation = {
  args: { label: visualNovelsBrowseSamples.continuation },
  play: continuationPlay(false),
} satisfies Story;
export const VisitorContinuationPhone: Story = at({ ...continuation, play: continuationPlay(true) }, 'phone');
export const VisitorContinuationDesktop: Story = at(continuation, 'desktop');

const empty = {
  args: { persona: 'member' as const, label: visualNovelsBrowseSamples.empty, state: 'empty' as const },
  parameters: { route: { pathname: recordedBrowseZone(record, 'member', locale).zone.links.browse } },
  play: emptyPlay(false),
} satisfies Story;
export const MemberEmptyPhone: Story = at({ ...empty, play: emptyPlay(true) }, 'phone');
export const MemberEmptyDesktop: Story = at(empty, 'desktop');

const refusal = {
  args: { label: visualNovelsBrowseSamples.refusal, state: 'error' as const },
  play: refusalPlay(false),
} satisfies Story;
export const VisitorRefusalPhone: Story = at({ ...refusal, play: refusalPlay(true) }, 'phone');
export const VisitorRefusalDesktop: Story = at(refusal, 'desktop');

const loading = {
  args: { state: 'loading' as const },
  play: loadingPlay(false),
} satisfies Story;
export const VisitorLoadingPhone: Story = at({ ...loading, play: loadingPlay(true) }, 'phone');
export const VisitorLoadingDesktop: Story = at(loading, 'desktop');
