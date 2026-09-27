import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, fn, userEvent, within } from 'storybook/test';
import { type DeviceView, SecurityOverview } from './security.tsx';
import { AccountFrame } from '../../.storybook/account-frame.tsx';
import { chinese, dark, phone } from '../../.storybook/variants.ts';

const devices: DeviceView[] = [
  { id: 's1', token: 't1', current: true, kind: 'computer', title: 'Chrome on macOS', activity: 'Active now' },
  { id: 's2', token: 't2', current: false, kind: 'phone', title: 'Safari on iOS', activity: 'Last active 3 hours ago' },
  { id: 's3', token: 't3', current: false, kind: 'unknown', title: 'Unknown device', activity: 'Last active 2 weeks ago' },
];

const meta = {
  title: 'Accounts/Account centre/Security', component: SecurityOverview,
  args: { hasPassword: true, devices: { status: 'ok', items: devices } },
  decorators: [Story => <AccountFrame section="security"><Story /></AccountFrame>],
} satisfies Meta<typeof SecurityOverview>;
export default meta;
type Story = StoryObj<typeof meta>;

const revoke = fn(async () => ({ ok: true as const, data: undefined }));
const refreshed = fn();
export const Devices: Story = {
  parameters: { account: { refresh: refreshed, api: { revokeSession: revoke } } },
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await expect(await canvas.findByRole('heading', { level: 1, name: 'Security' })).toBeVisible();
    await expect(canvas.getByText('This device')).toBeVisible();
    await expect(canvas.getAllByText('Coming soon')).toHaveLength(3);
    await userEvent.click(canvas.getByRole('button', { name: 'Sign out · Safari on iOS' }));
    await expect(revoke).toHaveBeenCalledWith('t2');
    await expect(refreshed).toHaveBeenCalled();
    await expect(canvas.getByRole('button', { name: 'Sign out of all other devices' })).toBeVisible();
  },
};

export const OnlyThisDevice: Story = {
  args: { devices: { status: 'ok', items: devices.slice(0, 1) } },
  async play({ canvasElement }) {
    await expect(await within(canvasElement).findByText('You’re not signed in anywhere else.')).toBeVisible();
  },
};

const changed = fn(async () => ({ ok: false as const, kind: 'invalid-credentials' as const, status: 400 }));
export const ChangePassword: Story = {
  parameters: { account: { api: { changePassword: changed } } },
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await userEvent.click(await canvas.findByRole('button', { name: 'Change password' }));
    await userEvent.type(canvas.getByLabelText('Current password'), 'old pass phrase');
    await userEvent.type(canvas.getByLabelText('New password'), 'new pass phrase');
    await userEvent.type(canvas.getByLabelText('Confirm new password'), 'new pass phrase');
    await expect(canvas.getByRole('checkbox', { name: 'Sign out of your other devices' })).toBeChecked();
    await userEvent.click(canvas.getByRole('button', { name: 'Change password' }));
    await expect(changed).toHaveBeenCalledWith({ currentPassword: 'old pass phrase',
      newPassword: 'new pass phrase', signOutOthers: true });
    await expect(await canvas.findByText('Your current password is incorrect')).toBeVisible();
  },
};

export const ConfirmItsYou: Story = {
  args: { devices: { status: 'stale' } },
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await expect(await canvas.findByText('For your security, sign in again to see this page.')).toBeVisible();
    await expect(canvas.getByRole('link', { name: 'Continue' }))
      .toHaveAttribute('href', '/sign-in?next=%2Fsecurity&reauth=1');
  },
};

export const Unavailable: Story = {
  args: { hasPassword: null, devices: { status: 'unavailable' } },
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await expect(await canvas.findByText(/We could not reach the REZICS Account service/)).toBeVisible();
    await expect(canvas.getByRole('button', { name: 'Try again' })).toBeVisible();
  },
};

export const Dark: Story = { ...Devices, parameters: {}, play: OnlyThisDevice.play,
  args: { ...OnlyThisDevice.args }, globals: dark };
export const Phone: Story = { globals: phone,
  async play({ canvasElement }) {
    await expect(await within(canvasElement).findByRole('heading', { level: 1, name: 'Security' })).toBeVisible();
  },
};
export const Chinese: Story = {
  globals: chinese,
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await expect(await canvas.findByRole('heading', { level: 1, name: '安全' })).toBeVisible();
    await expect(canvas.getByText('当前设备')).toBeVisible();
    await expect(canvas.getByRole('button', { name: '在所有其他设备上退出登录' })).toBeVisible();
  },
};
