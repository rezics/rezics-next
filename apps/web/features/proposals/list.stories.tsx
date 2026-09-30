import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, within } from 'storybook/test';
import { ids, listApi, listNames, listPage } from './fixtures.ts';
import { messages } from './messages.ts';
import { ProposalList } from './proposal-list.tsx';

const meta = {
  title: 'Proposals/List',
  component: ProposalList,
  parameters: { route: { pathname: '/en/proposals' } },
  args: { view: 'mine', initial: { ok: true, data: listPage }, names: listNames, actingSubject: ids.member,
    locale: 'en', messages, api: listApi },
  render: args => <div className="mx-auto w-full max-w-3xl px-4 py-6 sm:px-6"><ProposalList {...args} /></div>,
} satisfies Meta<typeof ProposalList>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Mine: Story = {
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole('link', { name: 'Mine' })).toHaveAttribute('aria-current', 'page');
    await expect(canvas.getByRole('link', { name: /雨夜书店/ })).toHaveAttribute('href', `/en/proposals/${ids.proposal}`);
  },
};

export const ReviewRequested: Story = {
  args: { view: 'review-requested' },
  async play({ canvasElement }) {
    await expect(within(canvasElement).getByRole('link', { name: 'Review requested' })).toHaveAttribute('aria-current', 'page');
  },
};

export const Empty: Story = {
  args: { initial: { ok: true, data: { items: [], nextCursor: null } } },
  async play({ canvasElement }) {
    await expect(within(canvasElement).getByRole('heading', { name: 'You haven’t proposed a correction' })).toBeVisible();
  },
};

export const Failed: Story = {
  args: { initial: { ok: false, failure: 'unavailable' } },
  async play({ canvasElement }) {
    await expect(within(canvasElement).getByRole('alert')).toBeVisible();
  },
};

export const DarkPhone: Story = {
  globals: { theme: 'dark', viewport: { value: 'phone' } },
  async play() {
    await expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(window.innerWidth);
  },
};
