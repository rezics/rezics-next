import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, within } from 'storybook/test';
import { NotFoundState } from './not-found-state.tsx';
import { ReadStatePanel } from './state-panel.tsx';
import { chinese, dark, phone } from '../../.storybook/variants.ts';

const meta = {
  title: 'Accounts/States', component: ReadStatePanel, args: { status: 'signed-out', next: '/' },
  decorators: [Story => <div className="mx-auto max-w-2xl p-6"><Story /></div>],
} satisfies Meta<typeof ReadStatePanel>;
export default meta;
type Story = StoryObj<typeof meta>;

export const SignedOut: Story = {
  async play({ canvasElement }) {
    await expect(await within(canvasElement).findByRole('link', { name: 'Sign in' }))
      .toHaveAttribute('href', '/sign-in?next=%2F');
  },
};
export const ConfirmItsYou: Story = {
  args: { status: 'stale', next: '/security' },
  async play({ canvasElement }) {
    await expect(await within(canvasElement).findByRole('link', { name: 'Continue' }))
      .toHaveAttribute('href', '/sign-in?next=%2Fsecurity&reauth=1');
  },
};
export const NotAvailableYet: Story = {
  args: { status: 'missing' },
  async play({ canvasElement }) {
    await expect(await within(canvasElement).findByRole('heading', { name: 'Not available yet' })).toBeVisible();
  },
};
export const NotFound: Story = {
  render: () => <NotFoundState />,
  async play({ canvasElement }) {
    await expect(await within(canvasElement).findByRole('heading', { level: 1, name: 'This page does not exist' }))
      .toBeVisible();
  },
};
export const Dark: Story = { ...SignedOut, globals: dark };
export const Phone: Story = { ...NotFound, globals: phone };
export const Chinese: Story = {
  args: { status: 'unavailable' }, globals: chinese,
  async play({ canvasElement }) {
    await expect(await within(canvasElement).findByRole('heading', { name: '暂时无法访问您的账号' })).toBeVisible();
  },
};
