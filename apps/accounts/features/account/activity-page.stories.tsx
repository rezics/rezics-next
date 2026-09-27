import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, fn, userEvent, within } from 'storybook/test';
import type { ActivityView } from './activity-list.tsx';
import { SecurityActivityPage } from './activity-page.tsx';
import { SecureAccount } from './secure-account.tsx';
import { AccountFrame } from '../../.storybook/account-frame.tsx';
import { chinese, dark, phone } from '../../.storybook/variants.ts';

const entry = (id: string, kind: ActivityView['kind'], when: string, extra: Partial<ActivityView> = {}): ActivityView =>
  ({ id, kind, when, occurredAt: '2026-09-27T09:00:00Z', count: 1, method: null, browser: null, platform: null,
    network: null, ...extra });
const entries: ActivityView[] = [
  entry('a1', 'sign-in-failed', '5 minutes ago', { count: 4 }),
  entry('a2', 'signed-in', '3 hours ago', { method: 'password', browser: 'Firefox', platform: 'Linux',
    network: '203.0.113.0/24' }),
  entry('a3', 'device-signed-out', 'yesterday', { count: 2 }),
  entry('a4', 'email-changed', '2 days ago'),
  entry('a5', 'app-removed', '1 week ago'),
  entry('a6', 'administrator', '1 month ago'),
];

const meta = {
  title: 'Accounts/Account centre/Security activity', component: SecurityActivityPage,
  args: { activity: { status: 'ok', entries, failed: { count: 4, capped: false }, older: 'cursor-2', paged: false } },
  decorators: [Story => <AccountFrame section="security"><Story /></AccountFrame>],
} satisfies Meta<typeof SecurityActivityPage>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Activity: Story = {
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await expect(await canvas.findByRole('heading', { level: 1, name: 'Recent security activity' })).toBeVisible();
    await expect(canvas.getByText('4 failed sign-in attempts in the last 24 hours')).toBeVisible();
    await expect(canvas.getByRole('link', { name: 'Secure your account' })).toHaveAttribute('href', '/security/secure-account');
    await expect(canvas.getByText('Signed in with your password')).toBeVisible();
    await expect(canvas.getByText(/Firefox on Linux/)).toHaveTextContent('3 hours ago · Firefox on Linux · Network 203.0.113.0/24');
    await expect(canvas.getByText('2 devices were signed out')).toBeVisible();
    await expect(canvas.getByText('A REZICS administrator changed your account')).toBeVisible();
    // Only changes someone else could have made offer "Wasn't you?".
    await expect(canvas.getAllByRole('link', { name: 'Wasn’t you?' })).toHaveLength(3);
    await expect(canvas.getByRole('link', { name: 'Show earlier activity' }))
      .toHaveAttribute('href', '/security/activity?cursor=cursor-2');
  },
};

export const LastPage: Story = {
  args: { activity: { status: 'ok', entries: entries.slice(3), failed: { count: 0, capped: false }, older: null, paged: true } },
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await expect(await canvas.findByText('That’s everything from the last 90 days.')).toBeVisible();
    await expect(canvas.getByRole('link', { name: 'Back to the newest' })).toHaveAttribute('href', '/security/activity');
    await expect(canvas.queryByRole('link', { name: 'Secure your account' })).toBeNull();
  },
};

export const Empty: Story = {
  args: { activity: { status: 'ok', entries: [], failed: { count: 0, capped: false }, older: null, paged: false } },
  async play({ canvasElement }) {
    await expect(await within(canvasElement).findByText('No security activity in the last 90 days.')).toBeVisible();
  },
};

export const Unavailable: Story = {
  args: { activity: { status: 'unavailable' } },
  async play({ canvasElement }) {
    await expect(await within(canvasElement).findByRole('heading', { name: 'Your account is unavailable right now' }))
      .toBeVisible();
  },
};

const signedOut = fn(async () => ({ ok: true as const, data: undefined }));
export const SecureYourAccount: Story = {
  parameters: { account: { api: { revokeOtherSessions: signedOut } } },
  render: () => <SecureAccount twoStep={false} />,
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await expect(await canvas.findByRole('heading', { level: 1, name: 'Secure your account' })).toBeVisible();
    await expect(canvas.getAllByRole('listitem')).toHaveLength(6);
    await expect(canvas.getByRole('link', { name: 'Change password' })).toHaveAttribute('href', '/security#password');
    await expect(canvas.getByRole('link', { name: 'Turn on' })).toHaveAttribute('href', '/security/two-step-verification');
    await userEvent.click(canvas.getByRole('button', { name: 'Sign out of all other devices' }));
    await expect(signedOut).toHaveBeenCalled();
    await expect(await canvas.findByRole('status')).toHaveTextContent('Signed out.');
  },
};

export const Dark: Story = { ...Activity, globals: dark };
export const Phone: Story = { ...Activity, globals: phone };
export const Chinese: Story = {
  globals: chinese,
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await expect(await canvas.findByRole('heading', { level: 1, name: '近期安全活动' })).toBeVisible();
    await expect(canvas.getByText('使用密码登录')).toBeVisible();
    await expect(canvas.getAllByRole('link', { name: '不是您？' })[0]).toBeVisible();
  },
};
