import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, fn, screen, userEvent, waitFor, within } from 'storybook/test';
import { type PasskeyView, Passkeys } from './passkeys.tsx';
import { AccountFrame } from '../../.storybook/account-frame.tsx';
import { chinese, dark, phone } from '../../.storybook/variants.ts';

const passkeys: PasskeyView[] = [
  { id: 'p1', name: 'Google Password Manager', provider: 'Google Password Manager', synced: true,
    created: 'Aug 2, 2026', lastUsed: '3 hours ago' },
  { id: 'p2', name: 'Work laptop', provider: 'Windows Hello', synced: false, created: 'Sep 20, 2026', lastUsed: null },
];

const meta = {
  title: 'Accounts/Account centre/Passkeys', component: Passkeys, args: { passkeys, hasPassword: true },
  decorators: [Story => <AccountFrame section="security"><Story /></AccountFrame>],
} satisfies Meta<typeof Passkeys>;
export default meta;
type Story = StoryObj<typeof meta>;

const added = fn(async () => ({ ok: true as const, data: undefined }));
const refreshed = fn();
export const List: Story = {
  parameters: { account: { refresh: refreshed, api: { addPasskey: added } } },
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await expect(await canvas.findByRole('heading', { level: 1, name: 'Passkeys' })).toBeVisible();
    await expect(within(canvas.getByRole('main')).getByRole('link', { name: 'Security & sign-in' }))
      .toHaveAttribute('href', '/security');
    await expect(canvas.getByText('Synced to your devices')).toBeVisible();
    await expect(canvas.getByText(/On one device · Windows Hello/)).toBeVisible();
    await expect(canvas.getByText('Created Aug 2, 2026 · Last used 3 hours ago')).toBeVisible();
    await expect(canvas.getByText('Created Sep 20, 2026 · Not used yet')).toBeVisible();
    await userEvent.click(canvas.getByRole('button', { name: 'Create a passkey' }));
    await expect(added).toHaveBeenCalled();
    await expect(refreshed).toHaveBeenCalled();
    await expect(await canvas.findByText('Passkey created. You can use it the next time you sign in.')).toBeVisible();
  },
};

const renamed = fn(async () => ({ ok: true as const, data: undefined }));
export const Rename: Story = {
  parameters: { account: { api: { renamePasskey: renamed } } },
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await userEvent.click(await canvas.findByRole('button', { name: 'Rename · Work laptop' }));
    const dialog = await screen.findByRole('dialog', { name: 'Rename passkey' });
    const field = within(dialog).getByRole('textbox', { name: 'Name' });
    await userEvent.clear(field);
    await userEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
    await expect(within(dialog).getByText('Enter a name')).toBeVisible();
    await userEvent.type(field, 'Office laptop');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
    await expect(renamed).toHaveBeenCalledWith('p2', 'Office laptop');
  },
};

const removed = fn(async () => ({ ok: false as const, kind: 'last-method' as const, status: 409 }));
export const RemoveRefused: Story = {
  parameters: { account: { api: { removePasskey: removed } } },
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await userEvent.click(await canvas.findByRole('button', { name: 'Remove · Google Password Manager' }));
    const dialog = await screen.findByRole('alertdialog');
    await waitFor(() => expect(within(dialog).getByText('Remove “Google Password Manager”?')).toBeVisible());
    await userEvent.click(within(dialog).getByRole('button', { name: 'Remove' }));
    await expect(removed).toHaveBeenCalledWith('p1');
    await expect(await canvas.findByRole('alert')).toHaveTextContent('This is your only way to sign in');
  },
};

export const OnlyWayToSignIn: Story = {
  args: { passkeys: passkeys.slice(0, 1), hasPassword: false },
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await expect(await canvas.findByRole('button', { name: 'Remove · Google Password Manager' })).toBeDisabled();
    await expect(canvas.getByText(/This passkey is your only way to sign in/)).toBeVisible();
  },
};

export const Empty: Story = {
  args: { passkeys: [] },
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await expect(await canvas.findByRole('heading', { name: 'No passkeys yet' })).toBeVisible();
    await expect(canvas.getByRole('button', { name: 'Create a passkey' })).toBeEnabled();
  },
};

export const AlreadyOnThisDevice: Story = {
  parameters: { account: { api: { addPasskey: async () => ({ ok: false, kind: 'conflict', status: 0 }) } } },
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await userEvent.click(await canvas.findByRole('button', { name: 'Create a passkey' }));
    await expect(await canvas.findByRole('alert')).toHaveTextContent('This device already has a passkey for your account.');
  },
};

export const Dark: Story = { ...Empty, globals: dark };
export const Phone: Story = { ...OnlyWayToSignIn, globals: phone };
export const Chinese: Story = {
  globals: chinese,
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await expect(await canvas.findByRole('heading', { level: 1, name: '通行密钥' })).toBeVisible();
    await expect(canvas.getByText('创建于 Aug 2, 2026 · 上次使用：3 hours ago')).toBeVisible();
    await expect(canvas.getByRole('button', { name: '创建通行密钥' })).toBeVisible();
  },
};
