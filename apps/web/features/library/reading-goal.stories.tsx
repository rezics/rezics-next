import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, within } from 'storybook/test';
import { ReadingGoal } from './reading-goal.tsx';
import { messages } from './messages.ts';
import zhHans from './messages/zh-Hans.ts';

const agent = 'https://rezics.com/id/0194f314-9280-767f-89a6-cc1234567890';
const initial = { ok: true as const, data: { year: 2026, target: 12, completed: 3, version: 1,
  changedAt: '2026-06-01T00:00:00Z' } };
const meta = { title: 'Library/Reading goal', component: ReadingGoal,
  args: { agent, initial, locale: 'en', messages, save: async (_agent, year, target, expectedVersion) => ({
    ok: true as const, data: { year, target, completed: 3, version: expectedVersion + 1,
      changedAt: '2026-06-02T00:00:00Z' } }) } } satisfies Meta<typeof ReadingGoal>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Edit: Story = { async play({ canvasElement }) {
  const canvas = within(canvasElement);
  await expect(canvas.getByRole('progressbar', { name: '2026 reading goal' })).toHaveAttribute('aria-valuenow', '3');
  await userEvent.click(canvas.getByRole('button', { name: 'Edit goal' }));
  await userEvent.clear(canvas.getByLabelText('Books to read'));
  await userEvent.type(canvas.getByLabelText('Books to read'), '20');
  await userEvent.click(canvas.getByRole('button', { name: 'Save' }));
  await expect(await canvas.findByText('3 of 20 books')).toBeVisible();
} };

export const Chinese: Story = { args: { locale: 'zh-Hans', messages: { ...messages, ...zhHans } },
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole('heading', { name: '2026 年阅读目标' })).toBeVisible();
    await expect(canvas.getByText('已读完 3 / 12 本')).toBeVisible();
  } };
