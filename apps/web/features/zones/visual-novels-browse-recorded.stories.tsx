import type { Meta, StoryObj } from '@storybook/react-vite';
import { materializeData } from 'native-i18n';
import { expect, within } from 'storybook/test';
import type { AnswerPersona, AnswerRecord } from '../../../../scripts/api/answer-record.ts';
import visualNovels from '../../../../tests/qa/fixtures/outcomes/visual-novels/catalogue-browse-and-search-in-its-zone.json';
import type { UiLocale } from '../../i18n/define.ts';
import { siteHref } from '../realm/route.ts';
import type { ZoneBrowsePage } from '../realm/types.ts';
import { messages as shellMessages } from '../shell/messages.ts';
import { zoneMessagesFor } from './fixtures.ts';
import {
  recordedBrowseSample, recordedHeaderName, recordedSiteKey, visualNovelsBrowseSamples,
} from './visual-novels-browse-recorded-page.ts';
import { VisualNovelsBrowseRecordedPage } from './visual-novels-browse-recorded-page.tsx';

const record = visualNovels as AnswerRecord;
const locale = 'en' as const;
const messages = zoneMessagesFor(locale);
const browsePath = siteHref(locale, recordedSiteKey(record), ['browse']);

/**
 * The recorded 400 (`primary-get-realms-modules-browse-0`) asks for relevance with a limit and a type and no text.
 * The production page never sends that query, so the refusal is not drawn. The mapping unit reads the sample.
 */

function page(persona: AnswerPersona, label: string): ZoneBrowsePage {
  return recordedBrowseSample(record, persona, label).answer as ZoneBrowsePage;
}

function resultText(persona: AnswerPersona, label: string): string {
  const matches = page(persona, label).matches;
  const t = materializeData(messages, { locale });
  return matches.kind === 'exact' ? t.results(matches.value) : t.resultsAtLeast({ count: String(matches.value) });
}

const meta = {
  title: 'Zones/Visual novels browse',
  component: VisualNovelsBrowseRecordedPage,
  args: { record, persona: 'visitor' as const, label: visualNovelsBrowseSamples.newest, state: 'populated' as const, locale },
  parameters: { route: { pathname: browsePath } },
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
    await expect(await canvas.findByRole('heading', { level: 1, name: recordedHeaderName(record, 'visitor') })).toBeVisible();
    await expect(await canvas.findByRole('link', { name: answer.items[0]!.title.value })).toBeVisible();
    await expect(canvas.getAllByRole('link', { name: author })).toHaveLength(answer.items.length);
    await expect(canvas.getByText(resultText('visitor', visualNovelsBrowseSamples.newest))).toBeVisible();
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
    await expect(await canvas.findByRole('heading', { level: 1, name: recordedHeaderName(record, 'visitor') })).toBeVisible();
    await expect(await canvas.findByRole('link', { name: answer.items[0]!.title.value })).toBeVisible();
    await expect(canvas.getByText(resultText('visitor', label))).toBeVisible();
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
    await expect(await canvas.findByRole('heading', { level: 1, name: recordedHeaderName(record, 'visitor') })).toBeVisible();
    await expect(await canvas.findByRole('link', { name: answer.items[0]!.title.value })).toBeVisible();
    await expect(canvas.getByText(resultText('visitor', visualNovelsBrowseSamples.continuation))).toBeVisible();
    await expect(canvas.queryByRole('link', { name: messages.next })).toBeNull();
    const previous = canvas.getByRole('link', { name: messages.previous });
    await expect(previous).toBeVisible();
    const href = new URL(previous.getAttribute('href')!, 'https://recorded.invalid');
    await expect(href.searchParams.has('cursor')).toBe(false);
    await expect(href.searchParams.get('sort')).toBe('newest');
    await fits(phone);
  };
}

function emptyPlay(persona: 'visitor' | 'member', phone: boolean): NonNullable<Story['play']> {
  return async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(await canvas.findByRole('heading', { level: 1, name: recordedHeaderName(record, persona) })).toBeVisible();
    await expect(canvas.getByRole('heading', { name: messages.browseEmptyTitle })).toBeVisible();
    await expect(canvas.getByText(messages.browseEmptyBody)).toBeVisible();
    await expect(canvas.getByText(resultText(persona, visualNovelsBrowseSamples.empty))).toBeVisible();
    const text = page(persona, visualNovelsBrowseSamples.empty).query.text;
    if (typeof text !== 'string') throw new Error('Recorded empty search has no text');
    await expect(canvas.getByRole('searchbox')).toHaveValue(text);
    await expect(canvas.queryByRole('link', { name: messages.next })).toBeNull();
    await fits(phone);
  };
}

function loadingPlay(phone: boolean): NonNullable<Story['play']> {
  return async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(await canvas.findByRole('status')).toHaveTextContent(shellMessages.loading);
    await expect(canvas.getByRole('status')).toHaveAttribute('aria-busy', 'true');
    await expect(canvas.queryByRole('heading', { level: 1 })).toBeNull();
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

const visitorEmpty = {
  args: { label: visualNovelsBrowseSamples.empty, state: 'empty' as const },
  play: emptyPlay('visitor', false),
} satisfies Story;
export const VisitorEmptyPhone: Story = at({ ...visitorEmpty, play: emptyPlay('visitor', true) }, 'phone');
export const VisitorEmptyDesktop: Story = at(visitorEmpty, 'desktop');

const empty = {
  args: { persona: 'member' as const, label: visualNovelsBrowseSamples.empty, state: 'empty' as const },
  play: emptyPlay('member', false),
} satisfies Story;
export const MemberEmptyPhone: Story = at({ ...empty, play: emptyPlay('member', true) }, 'phone');
export const MemberEmptyDesktop: Story = at(empty, 'desktop');

const loading = {
  args: { state: 'loading' as const },
  play: loadingPlay(false),
} satisfies Story;
export const VisitorLoadingPhone: Story = at({ ...loading, play: loadingPlay(true) }, 'phone');
export const VisitorLoadingDesktop: Story = at(loading, 'desktop');
