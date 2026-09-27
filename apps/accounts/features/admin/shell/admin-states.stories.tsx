import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, within } from 'storybook/test';
import { AdminGate } from './admin-states.tsx';
import { chinese, dark } from '../../../.storybook/variants.ts';

const meta = {
  title: 'Accounts/Admin/Access', component: AdminGate, args: { status: 'forbidden', next: '/admin/users' },
} satisfies Meta<typeof AdminGate>;
export default meta;
type Story = StoryObj<typeof meta>;

/** Signed in, but not an operator: say so and lead back to the account. */
export const NotStaff: Story = {
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await expect(await canvas.findByRole('heading', { level: 1, name: 'This area is for REZICS staff' })).toBeVisible();
    await expect(canvas.getByRole('link', { name: 'Your account' })).toHaveAttribute('href', '/');
  },
};

export const SignedOut: Story = {
  args: { status: 'signed-out' },
  async play({ canvasElement }) {
    await expect(await within(canvasElement).findByRole('link', { name: 'Sign in' }))
      .toHaveAttribute('href', '/sign-in?next=%2Fadmin%2Fusers');
  },
};

export const Unavailable: Story = {
  args: { status: 'unavailable' },
  async play({ canvasElement }) {
    await expect(await within(canvasElement).findByRole('button', { name: 'Try again' })).toBeVisible();
  },
};

export const Dark: Story = { ...NotStaff, globals: dark };
export const Chinese: Story = {
  globals: chinese,
  async play({ canvasElement }) {
    await expect(await within(canvasElement).findByRole('heading', { level: 1, name: '此区域仅供 REZICS 员工使用' })).toBeVisible();
  },
};
