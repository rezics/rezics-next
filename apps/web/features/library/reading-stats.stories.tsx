import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, within } from 'storybook/test';
import { ReadingStats } from './reading-stats.tsx';
import { messages } from './messages.ts';
import zhHans from './messages/zh-Hans.ts';

const stats = { ok: true as const, data: { detailsAvailability: 'complete' as const, year: 2026, books: 8, chapters: 34,
  averageRating: 4.2, ratedBooks: 5, knownChapters: 41, booksWithChapters: 3,
  topConcepts: [{ name: 'Science fiction', count: 3 }], titleLanguages: [{ language: 'en', count: 8 }],
  months: Array.from({ length: 12 }, (_, index) => ({ month: index + 1,
    books: index === 0 ? 2 : index === 5 ? 6 : 0, chapters: index === 0 ? 10 : index === 5 ? 24 : 0 })) } };
const meta = { title: 'Library/Reading stats', component: ReadingStats,
  args: { stats, locale: 'en', messages } } satisfies Meta<typeof ReadingStats>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Year: Story = { async play({ canvasElement }) {
  const canvas = within(canvasElement);
  await expect(canvas.getByRole('heading', { name: 'Reading in 2026' })).toBeVisible();
  await expect(canvas.getByText('8 books finished')).toBeVisible();
  await expect(canvas.getByText('34 chapters completed')).toBeVisible();
  await expect(canvas.getByText('Average rating given: 4.2 / 5 (5 rated)')).toBeVisible();
  await expect(within(canvas.getByRole('list', { name: 'Reading in 2026' })).getAllByRole('listitem'))
    .toHaveLength(12);
} };

export const Chinese: Story = { args: { locale: 'zh-Hans', messages: { ...messages, ...zhHans } },
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole('heading', { name: '2026 年阅读统计' })).toBeVisible();
    await expect(canvas.getByText('读完 8 本')).toBeVisible();
  } };

/** A title with no recorded language is not labeled `und`. Recorded languages stay. */
export const UnrecordedTitleLanguage: Story = {
  args: { stats: { ok: true, data: { ...stats.data, titleLanguages: [{ language: 'und', count: 2 },
    { language: 'en', count: 3 }] } } },
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await expect(canvas.queryByText('und · 2')).toBeNull();
    await expect(canvas.getByText('en · 3')).toBeVisible();
  },
};

/** When every finished title is unrecorded, the language list is absent. */
export const OnlyUnrecordedTitleLanguage: Story = {
  args: { stats: { ok: true, data: { ...stats.data, titleLanguages: [{ language: 'und', count: 2 }] } } },
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await expect(canvas.queryByText('und · 2')).toBeNull();
    await expect(canvas.queryByRole('heading', { name: 'Recorded title languages' })).toBeNull();
    await expect(canvas.getByRole('heading', { name: 'Reading in 2026' })).toBeVisible();
  },
};

export const TotalsWithoutDetails: Story = { args: { stats: { ok: true, data: {
  ...stats.data, detailsAvailability: 'unavailable', books: 1_000,
  months: stats.data.months.map(month => ({ ...month, books: month.books * 125 })),
  averageRating: null, ratedBooks: null, knownChapters: null, booksWithChapters: null,
  topConcepts: null, titleLanguages: null } } }, async play({ canvasElement }) {
  const canvas = within(canvasElement);
  await expect(canvas.getByText('1,000 books finished')).toBeVisible();
  await expect(canvas.getByText('34 chapters completed')).toBeVisible();
  await expect(canvas.queryByText(/Average rating given/)).toBeNull();
  await expect(within(canvas.getByRole('list', { name: 'Reading in 2026' })).getAllByRole('listitem'))
    .toHaveLength(12);
} };
