import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, fn, userEvent, within } from 'storybook/test';
import { DeleteAccount } from './delete-account.tsx';
import { AccountFrame } from '../../.storybook/account-frame.tsx';
import { chinese, dark, phone } from '../../.storybook/variants.ts';

const meta = {
  title: 'Accounts/Account centre/Delete account', component: DeleteAccount,
  decorators: [Story => <AccountFrame section="data-privacy"><Story /></AccountFrame>],
} satisfies Meta<typeof DeleteAccount>;
export default meta;
type Story = StoryObj<typeof meta>;

async function confirm(canvasElement: HTMLElement) {
  const canvas = within(canvasElement);
  await expect(await canvas.findByRole('button', { name: 'Delete account' })).toBeVisible();
  await userEvent.type(canvas.getByLabelText('Enter your password'), 'pass phrase');
  await userEvent.click(canvas.getByRole('checkbox', { name: /I understand what will be deleted/ }));
  return canvas;
}

const deleted = fn();
export const Guided: Story = {
  parameters: { account: { navigate: deleted } },
  async play({ canvasElement }) {
    const canvas = await confirm(canvasElement);
    await expect(canvas.getByText('What you published on REZICS isn’t removed by deleting your account.')).toBeVisible();
    await expect(canvas.getByRole('link', { name: 'Download your data' })).toHaveAttribute('href', '/data-privacy/download');
    await userEvent.click(canvas.getByRole('button', { name: 'Delete account' }));
    await expect(deleted).toHaveBeenCalledWith('/sign-in?deleted=1');
  },
};
export const StillHasDuties: Story = {
  parameters: { account: { api: { deleteAccount: async () => ({ ok: false, kind: 'conflict', status: 409 }) } } },
  async play({ canvasElement }) {
    const canvas = await confirm(canvasElement);
    await userEvent.click(canvas.getByRole('button', { name: 'Delete account' }));
    await expect(await canvas.findByRole('alert')).toHaveTextContent('This account still has duties');
  },
};
export const WrongPassword: Story = {
  parameters: { account: { api: { deleteAccount: async () => ({ ok: false, kind: 'invalid-credentials', status: 400 }) } } },
  async play({ canvasElement }) {
    const canvas = await confirm(canvasElement);
    await userEvent.click(canvas.getByRole('button', { name: 'Delete account' }));
    await expect(await canvas.findByText('Your current password is incorrect')).toBeVisible();
  },
};
export const PasskeyOnly: Story = {
  args: { hasPassword: false },
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await expect(await canvas.findByText('You will confirm with a passkey when you delete your account.')).toBeVisible();
    await expect(canvas.queryByLabelText('Enter your password')).toBeNull();
    await userEvent.click(canvas.getByRole('checkbox', { name: /I understand what will be deleted/ }));
  },
};
export const Dark: Story = { ...StillHasDuties, globals: dark };
export const Phone: Story = { ...Guided, globals: phone };
export const Chinese: Story = { globals: chinese, args: { hasPassword: false }, async play({ canvasElement }) {
  await expect(await within(canvasElement).findByRole('heading', { level: 1, name: '删除您的 REZICS 账号' })).toBeVisible();
} };
