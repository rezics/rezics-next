import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, fn, userEvent, within } from 'storybook/test';
import { DownloadData } from './download-data.tsx';
import { AccountFrame } from '../../.storybook/account-frame.tsx';
import { chinese, dark, phone } from '../../.storybook/variants.ts';

const meta = {
  title: 'Accounts/Account centre/Download data', component: DownloadData,
  decorators: [Story => <AccountFrame section="data-privacy"><Story /></AccountFrame>],
} satisfies Meta<typeof DownloadData>;
export default meta;
type Story = StoryObj<typeof meta>;

const download = fn();
export const Ready: Story = {
  parameters: { account: { download } },
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await expect(await canvas.findByRole('heading', { level: 1, name: 'Download your data' })).toBeVisible();
    await userEvent.click(canvas.getByRole('button', { name: 'Download file' }));
    await expect(download).toHaveBeenCalled();
    await expect(await canvas.findByRole('status')).toHaveTextContent('Downloading rezics-account');
  },
};
export const RateLimited: Story = {
  parameters: { account: { api: { exportData: async () => ({ ok: false, kind: 'rate-limited', status: 429 }) } } },
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await userEvent.click(await canvas.findByRole('button', { name: 'Download file' }));
    await expect(await canvas.findByRole('alert')).toHaveTextContent('You have downloaded your data recently');
  },
};
export const Dark: Story = { ...RateLimited, globals: dark };
export const Phone: Story = { ...Ready, globals: phone };
export const Chinese: Story = { globals: chinese, async play({ canvasElement }) {
  await expect(await within(canvasElement).findByRole('heading', { level: 1, name: '下载您的数据' })).toBeVisible();
} };
