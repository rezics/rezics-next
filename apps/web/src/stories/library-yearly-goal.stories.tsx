import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, within } from 'storybook/test';
import { YearlyGoalPage, type YearlyGoalPageApi, type YearlyGoalSnapshot } from '../library/yearly-goal-page';
import { m } from '../paraglide/messages.js';

const meta = {
  title: 'Pages/Library/Yearly completion goal',
  component: YearlyGoalPage,
  parameters: { layout: 'fullscreen' },
  args: { year: 2026, sessionState: 'signed-in' },
} satisfies Meta<typeof YearlyGoalPage>;
export default meta;
type Story = StoryObj<typeof meta>;

function snapshot(year: number, target: YearlyGoalSnapshot['target']): YearlyGoalSnapshot {
  return {
    year,
    viewer: {
      state: 'owner',
      actions: {
        editTarget: { allowed: true },
        clearTarget: target.state === 'set' ? { allowed: true } : { allowed: false, reason: 'no_target' },
        navigateYear: { allowed: true },
      },
    },
    target,
    progress: { state: 'unavailable', reason: 'summary_unavailable' },
  };
}

const progressUnavailableApi: YearlyGoalPageApi = {
  read: async (year) => ({ state: 'ready', value: snapshot(year, { state: 'set', target: 18, revision: '3' }) }),
  write: async () => ({ state: 'applied' }),
};

function uncertainApi(): YearlyGoalPageApi {
  let sent = false;
  return {
    read: async (year) => ({ state: 'ready', value: snapshot(year, { state: 'none', revision: null }) }),
    write: async () => {
      if (!sent) {
        sent = true;
        return { state: 'uncertain' };
      }
      return { state: 'applied' };
    },
  };
}

function staleApi(): YearlyGoalPageApi {
  let current: YearlyGoalSnapshot['target'] = { state: 'none', revision: null };
  let reads = 0;
  let stale = true;
  return {
    read: async (year) => {
      reads += 1;
      if (reads > 1) current = { state: 'set', target: 4, revision: '8' };
      return { state: 'ready', value: snapshot(year, current) };
    },
    write: async () => {
      if (stale) {
        stale = false;
        return { state: 'stale' };
      }
      return { state: 'applied' };
    },
  };
}

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

export const ProgressUnavailableTargetEditable: Story = {
  args: { viewerSubject: 'storybook-owner', api: progressUnavailableApi },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole('status')).toHaveTextContent(m.library_diary_year_unavailable());
    await expect(canvas.getByText('18')).toBeInTheDocument();
    await expect(canvas.getByRole('button', { name: m.library_yearly_goal_edit() })).toBeInTheDocument();
  },
};

export const UncertainDelivery: Story = {
  args: { viewerSubject: 'storybook-owner', api: uncertainApi() },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(await canvas.findByRole('button', { name: m.library_yearly_goal_edit() }));
    await userEvent.type(canvas.getByRole('textbox', { name: m.library_yearly_goal_target() }), '8');
    await userEvent.click(canvas.getByRole('button', { name: m.library_yearly_goal_save() }));
    await expect(await canvas.findByText(m.library_yearly_goal_uncertain())).toBeInTheDocument();
    await expect(canvas.getByRole('button', { name: m.library_yearly_goal_retry_exact() })).toBeInTheDocument();
  },
};

export const StaleRevisionReview: Story = {
  args: { viewerSubject: 'storybook-owner', api: staleApi() },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(await canvas.findByRole('button', { name: m.library_yearly_goal_edit() }));
    const input = canvas.getByRole('textbox', { name: m.library_yearly_goal_target() });
    await userEvent.type(input, '7');
    await userEvent.click(canvas.getByRole('button', { name: m.library_yearly_goal_save() }));
    await userEvent.click(await canvas.findByRole('button', { name: m.library_yearly_goal_refresh() }));
    await expect(canvas.getByRole('textbox', { name: m.library_yearly_goal_target() })).toHaveValue('7');
    await expect(await canvas.findByText(m.library_yearly_goal_review())).toBeInTheDocument();
  },
};
