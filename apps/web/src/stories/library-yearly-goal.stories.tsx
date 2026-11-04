import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, within } from 'storybook/test';
import { YearlyGoalPage } from '../library/yearly-goal-page';
import { m } from '../paraglide/messages.js';

const meta = {
  title: 'Pages/Library/Yearly completion goal',
  component: YearlyGoalPage,
  parameters: { layout: 'fullscreen' },
  args: { year: 2026, sessionState: 'signed-in' },
} satisfies Meta<typeof YearlyGoalPage>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Unavailable: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole('status')).toHaveTextContent(m.library_yearly_goal_unavailable());
    await expect(canvas.queryByRole('progressbar')).toBeNull();
    await expect(canvas.getByRole('link', { name: m.library_diary_nav() })).toHaveAttribute(
      'href',
      expect.stringContaining('/library/history?year=2026'),
    );
  },
};
export const SignedOut: Story = {
  args: { sessionState: 'signed-out' },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole('status')).toHaveTextContent(m.library_yearly_goal_signed_out());
    await expect(canvas.getByRole('link', { name: m.account_sign_in() })).toHaveAttribute(
      'href',
      expect.stringContaining(encodeURIComponent('/library/goals?year=2026')),
    );
  },
};
export const CheckingAccount: Story = { args: { sessionState: 'unknown' } };
export const AccountUnavailable: Story = { args: { sessionState: 'unavailable' } };
