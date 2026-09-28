import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, within } from 'storybook/test';
import { SecurityCheckup, type CheckupView } from './security-checkup.tsx';
import { AccountFrame } from '../../.storybook/account-frame.tsx';
import { chinese, dark, phone } from '../../.storybook/variants.ts';

const clear: CheckupView = {
  complete: true, issues: [], failedSignIns: 0,
  devices: { status: 'ok', items: [{ id: 's1', ids: [], count: 1, thisDevice: true, clientName: 'REZICS',
    browser: 'Chrome', platform: 'macOS', network: '192.0.2.0/24', signedIn: 'yesterday',
    lastActive: 'now', lastActiveAt: '2026-09-28T00:00:00Z' }] },
  activity: { status: 'ok', entries: [] },
  signIn: { email: 'ada@example.test', emailVerified: true, password: true, passwordChanged: 'Sep 1, 2026',
    passkeys: 2, twoStep: true },
  apps: { status: 'ok', items: [] },
};
const meta = {
  title: 'Accounts/Account centre/Security Checkup', component: SecurityCheckup,
  args: { checkup: clear },
  decorators: [Story => <AccountFrame section="security"><Story /></AccountFrame>],
} satisfies Meta<typeof SecurityCheckup>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Protected: Story = {
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await expect(await canvas.findByRole('heading', { level: 1, name: 'Security Checkup' })).toBeVisible();
    await expect(canvas.getByRole('heading', { name: 'Your account is protected' })).toBeVisible();
    await expect(canvas.getByRole('link', { name: 'Done for now' })).toHaveAttribute('href', '/');
  },
};
export const Recommendations: Story = {
  args: { checkup: { ...clear, issues: ['add-second-step', 'unused-apps'],
    signIn: { ...clear.signIn!, passkeys: 0, twoStep: false },
    apps: { status: 'ok', items: [{ clientId: 'old-app', name: 'Old app', lastUsed: '4 months ago', unused: true }] } } },
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await expect(await canvas.findByRole('heading', { name: '2 ways to make your account safer' })).toBeVisible();
    await expect(canvas.getByRole('link', { name: 'Review apps' })).toHaveAttribute('href', '/connected-apps');
  },
};
export const Incomplete: Story = {
  args: { checkup: { ...clear, complete: false, devices: { status: 'unavailable' }, apps: { status: 'unavailable' } } },
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await expect(await canvas.findByRole('heading', { name: 'Some checks are unavailable' })).toBeVisible();
    await expect(canvas.queryByRole('heading', { name: 'Your account is protected' })).toBeNull();
  },
};
export const Dark: Story = { ...Recommendations, globals: dark };
export const Phone: Story = { ...Recommendations, globals: phone };
export const Chinese: Story = { ...Protected, globals: chinese, play: async ({ canvasElement }) => {
  await expect(await within(canvasElement).findByRole('heading', { level: 1, name: '安全检查' })).toBeVisible();
} };
