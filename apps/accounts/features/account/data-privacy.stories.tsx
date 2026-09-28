import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, within } from 'storybook/test';
import { DataPrivacy } from './data-privacy.tsx';
import { AccountFrame } from '../../.storybook/account-frame.tsx';
import { chinese, dark, phone } from '../../.storybook/variants.ts';

const meta = {
  title: 'Accounts/Account centre/Data and privacy', component: DataPrivacy,
  args: { apps: 2 },
  decorators: [Story => <AccountFrame section="data-privacy"><Story /></AccountFrame>],
} satisfies Meta<typeof DataPrivacy>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Overview: Story = {
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await expect(await canvas.findByRole('heading', { level: 1, name: 'Data & privacy' })).toBeVisible();
    await expect(canvas.getByRole('link', { name: /Download your data/ })).toHaveAttribute('href', '/data-privacy/download');
    await expect(canvas.getByRole('link', { name: /Delete your account/ })).toHaveAttribute('href', '/data-privacy/delete-account');
    await expect(canvas.getByText('Sign-in methods and their dates, without secrets or backup codes')).toBeVisible();
  },
};

export const AppsUnavailable: Story = { args: { apps: null } };
export const Dark: Story = { ...Overview, globals: dark };
export const Phone: Story = { ...Overview, globals: phone };
export const Chinese: Story = {
  globals: chinese,
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await expect(await canvas.findByRole('heading', { level: 1, name: '数据和隐私' })).toBeVisible();
    await expect(canvas.getByRole('link', { name: /下载您的数据/ })).toHaveAttribute('href', '/data-privacy/download');
  },
};
