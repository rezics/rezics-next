import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, fn, userEvent, within } from 'storybook/test';
import { DataPrivacy } from './data-privacy.tsx';
import { AccountFrame } from '../../.storybook/account-frame.tsx';
import { chinese, dark, phone } from '../../.storybook/variants.ts';

const meta = {
  title: 'Accounts/Account centre/Data and privacy', component: DataPrivacy,
  decorators: [Story => <AccountFrame section="data-privacy"><Story /></AccountFrame>],
} satisfies Meta<typeof DataPrivacy>;
export default meta;
type Story = StoryObj<typeof meta>;

async function confirm(canvasElement: HTMLElement, phrase = 'delete my account') {
  const canvas = within(canvasElement);
  const button = await canvas.findByRole('button', { name: 'Delete account' });
  await expect(button).toBeDisabled();
  await userEvent.type(canvas.getByLabelText('Enter your password'), 'pass phrase');
  await userEvent.type(canvas.getByRole('textbox', { name: 'Type “delete my account” to confirm' }), phrase);
  return canvas;
}

const deleted = fn();
export const DeleteAccount: Story = {
  parameters: { account: { navigate: deleted } },
  async play({ canvasElement }) {
    const canvas = await confirm(canvasElement);
    await expect(canvas.getByText('What you published on REZICS isn’t removed by deleting your account.')).toBeVisible();
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

export const NotAvailable: Story = {
  parameters: { account: { api: { deleteAccount: async () => ({ ok: false, kind: 'not-enabled', status: 404 }) } } },
  async play({ canvasElement }) {
    const canvas = await confirm(canvasElement);
    await userEvent.click(canvas.getByRole('button', { name: 'Delete account' }));
    await expect(await canvas.findByRole('alert')).toHaveTextContent('Account deletion isn’t available on this server yet.');
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

export const Dark: Story = { ...StillHasDuties, globals: dark };
export const Phone: Story = { ...DeleteAccount, parameters: {}, play: async ({ canvasElement }) => {
  await confirm(canvasElement);
  await expect(within(canvasElement).getByRole('button', { name: 'Delete account' })).toBeEnabled();
}, globals: phone };
export const Chinese: Story = {
  globals: chinese,
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await expect(await canvas.findByRole('heading', { level: 1, name: '数据和隐私' })).toBeVisible();
    await userEvent.type(canvas.getByLabelText('输入您的密码'), 'pass phrase');
    await userEvent.type(canvas.getByRole('textbox', { name: '输入“删除我的账号”以确认' }), '删除我的账号');
    await expect(canvas.getByRole('button', { name: '删除账号' })).toBeEnabled();
  },
};
