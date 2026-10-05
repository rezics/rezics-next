import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, within } from 'storybook/test';
import { uiLocales } from '../../i18n/define.ts';
import { direction } from '@rezics/main/language';
import { localizedPath } from '../../i18n/locale.ts';
import { chapterHref, workHref } from '../work-page/route.ts';
import type { SearchLoaded } from '../search/types.ts';
import { ChapterTextResults } from './chapter-text.tsx';
import { chapterTextMessages } from './chapter-text-messages.ts';
import { DiscoverView } from './discover-view.tsx';
import { emptyBrowse } from './browse-state.ts';
import { fixtureTopicLoader } from './browse-fixtures.ts';

const book = 'https://rezics.com/id/00000000-0000-4000-8000-000000000001';
const post = '00000000-0000-4000-8000-000000000002';
const chapter = chapterHref(book, post, 'en');
const read: Extract<SearchLoaded, { ok: true }> = { ok: true, page: { total: 1, population: 1, sequence: '1', indexGeneration: 'index',
  next: null, titles: true, hits: [{ matchUnit: 'unit', work: book, mainVersion: book, types: ['https://schema.org/Book'],
    title: { value: 'The Lantern Road', language: 'en', direction: direction('en', 'The Lantern Road'), basis: 'requested' },
    cover: null, authors: [], rating: null, tagline: null, completion: null,
    reasons: { language: 'en', field: 'body', matchedText: null, matchedLanguage: null,
      chapter: { title: 'At the harbour', href: chapter }, realm: null, classification: null } }],
} };
const meta = { title: 'Discover/Chapter text matches', component: ChapterTextResults,
  args: { read, locale: 'en' }, decorators: [Story => <div className="mx-auto max-w-5xl p-4"><Story /></div>],
} satisfies Meta<typeof ChapterTextResults>;
export default meta;
type Story = StoryObj<typeof meta>;

export const BookAndChapter: Story = { async play({ canvasElement }) {
  const canvas = within(canvasElement);
  await expect(canvas.getByRole('region', { name: 'Found in chapter text' })).toBeVisible();
  await expect(canvas.getByRole('link', { name: 'The Lantern Road' })).toHaveAttribute('href', localizedPath(workHref(book), 'en'));
  await expect(canvas.getByRole('link', { name: 'At the harbour' })).toHaveAttribute('href', localizedPath(chapter, 'en'));
} };
export const TraditionalChinesePhone: Story = { args: { locale: 'zh-Hant' },
  globals: { locale: 'zh-Hant', theme: 'dark', viewport: { value: 'phone' } },
  async play({ canvasElement }) {
    await expect(within(canvasElement).getByRole('region', { name: chapterTextMessages['zh-Hant'].title })).toBeVisible();
    await expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(innerWidth);
  } };
export const NoChapterHitsLeaveNoTrace: Story = { args: { read: { ok: true, page: { ...read.page,
  hits: read.page.hits.map(hit => ({ ...hit, reasons: { ...hit.reasons, chapter: null } })) } } },
  async play({ canvasElement }) { await expect(within(canvasElement).queryByRole('region')).toBeNull(); } };
export const AllEightLabels: Story = { render: () => <div className="grid gap-8">
  {uiLocales.map(locale => <ChapterTextResults key={locale} read={read} locale={locale} />)}
</div>, async play({ canvasElement }) {
  const canvas = within(canvasElement);
  for (const locale of uiLocales) {
    const region = canvas.getByRole('region', { name: chapterTextMessages[locale].title });
    await expect(region).toBeVisible();
    await expect(within(region).getByRole('link', { name: 'The Lantern Road' })).toBeVisible();
    await expect(within(region).getByRole('link', { name: 'At the harbour' })).toBeVisible();
  }
} };
export const IndependentOfResourceCount: Story = { render: () => <DiscoverView state={{ ...emptyBrowse, q: 'lanternroad' }}
  locale="en" topics={[]} sections={null} chapterText={read} topicLoad={fixtureTopicLoader()}
  results={{ ok: true, data: { items: [], nextCursor: null, complete: true, count: { value: 0, kind: 'exact' } } }} />,
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole('link', { name: 'At the harbour' })).toBeVisible();
    await expect(canvas.getByRole('status')).toHaveTextContent('0 results');
    await expect(canvas.queryByRole('link', { name: 'Show more' })).toBeNull();
  } };
