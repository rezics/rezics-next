import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, within } from 'storybook/test';
import { ReadingStats } from './reading-stats.tsx';
import { messages } from './messages.ts';
import zhHans from './messages/zh-Hans.ts';

const stats = { ok: true as const, data: { year: 2026, books: 8, chapters: 34,
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
  await expect(canvas.getAllByRole('listitem')).toHaveLength(12);
} };

export const Chinese: Story = { args: { locale: 'zh-Hans', messages: { ...messages, ...zhHans } },
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole('heading', { name: '2026 年阅读统计' })).toBeVisible();
    await expect(canvas.getByText('读完 8 本')).toBeVisible();
  } };
