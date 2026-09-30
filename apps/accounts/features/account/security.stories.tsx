import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, fn, screen, userEvent, waitFor, within } from 'storybook/test';
import type { ActivityView } from './activity-list.tsx';
import type { DeviceView } from './devices.tsx';
import { DevicesPage } from './devices-page.tsx';
import { SecurityOverview } from './security.tsx';
import { sessionViews } from './views.ts';
import { AccountFrame } from '../../.storybook/account-frame.tsx';
import { chinese, dark, phone } from '../../.storybook/variants.ts';
import type { DeviceSession } from '../api/account-data.ts';

const devices: DeviceView[] = [
  { id: 's1', ids: [], count: 1, thisDevice: true, clientName: 'REZICS', browser: 'Chrome', platform: 'macOS',
    network: '192.0.2.0/24', signedIn: '2 days ago', lastActive: 'this minute', lastActiveAt: '2026-09-27T12:00:00Z' },
  { id: 's2', ids: ['s2', 's4'], count: 2, thisDevice: false, clientName: 'REZICS', browser: 'Safari', platform: 'iOS',
    network: null, signedIn: '1 week ago', lastActive: '3 hours ago', lastActiveAt: '2026-09-27T09:00:00Z' },
  { id: 's3', ids: ['s3'], count: 1, thisDevice: false, clientName: null, browser: null, platform: null,
    network: null, signedIn: '2 weeks ago', lastActive: '2 weeks ago', lastActiveAt: '2026-09-13T12:00:00Z' },
];
const entry = (id: string, kind: ActivityView['kind'], when: string, extra: Partial<ActivityView> = {}): ActivityView =>
  ({ id, kind, when, occurredAt: '2026-09-27T09:00:00Z', count: 1, method: null, clientId: null, browser: null, platform: null,
    network: null, ...extra });
const activity: ActivityView[] = [
  entry('a1', 'signed-in', '3 hours ago', { method: 'passkey', browser: 'Chrome', platform: 'macOS', network: '192.0.2.0/24' }),
  entry('a2', 'sign-in-failed', 'yesterday', { count: 2 }),
  entry('a3', 'passkey-added', '2 days ago'),
  entry('a4', 'two-step-on', '1 week ago'),
];

const meta = {
  title: 'Accounts/Account centre/Security', component: SecurityOverview,
  args: { signIn: { password: true, passwordChanged: 'Sep 1, 2026', passkeys: 2, twoStep: true }, issues: [],
    failedSignIns: 0, unusedApps: 0, checkupComplete: true,
    devices: { status: 'ok', items: devices }, activity: { status: 'ok', entries: activity } },
  decorators: [(Story, { parameters }) => <AccountFrame section="security" stepUp={parameters.stepUp}><Story /></AccountFrame>],
} satisfies Meta<typeof SecurityOverview>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Overview: Story = {
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await expect(await canvas.findByRole('heading', { level: 1, name: 'Security & sign-in' })).toBeVisible();
    await expect(canvas.getByText('Last changed Sep 1, 2026')).toBeVisible();
    await expect(canvas.getByRole('link', { name: /Passkeys.*2 passkeys/ })).toHaveAttribute('href', '/security/passkeys');
    await expect(canvas.getByRole('link', { name: /2-Step Verification is on/ }))
      .toHaveAttribute('href', '/security/two-step-verification');
    await expect(canvas.getByText('This device')).toBeVisible();
    await expect(canvas.getByText('REZICS · Chrome on macOS')).toBeVisible();
    await expect(canvas.getByRole('link', { name: /Manage all devices/ })).toHaveAttribute('href', '/security/devices');
    await expect(canvas.getByText('Unknown device')).toBeVisible();
    await expect(canvas.getByText('Signed in with a passkey')).toBeVisible();
    await expect(canvas.getByText('2 failed sign-in attempts')).toBeVisible();
    await expect(canvas.getAllByRole('link', { name: 'Wasn’t you?' })[0]).toHaveAttribute('href', '/security/secure-account');
    await expect(canvas.getByRole('link', { name: 'Review security activity' })).toHaveAttribute('href', '/security/activity');
    await expect(canvas.getByRole('button', { name: 'Remove password' })).toBeVisible();
  },
};

const revoke = fn(async (): Promise<{ ok: true; data: undefined } | { ok: false; kind: 'step-up-required'; status: number }> =>
  revoke.mock.calls.length === 1 ? { ok: false, kind: 'step-up-required', status: 403 } : { ok: true, data: undefined });
const reauthenticated = fn(async () => ({ ok: true as const, data: undefined }));
const refreshed = fn();
export const SignOutADevice: Story = {
  render: () => <DevicesPage devices={{ status: 'ok', items: devices }} />,
  parameters: { account: { refresh: refreshed, api: { revokeSessions: revoke, reauthenticate: reauthenticated } } },
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await userEvent.click(await canvas.findByRole('button', { name: 'Sign out · REZICS · Safari on iOS' }));
    // The service wants the person to confirm first; the change runs again afterwards.
    const dialog = await screen.findByRole('dialog', { name: 'Confirm it’s you' });
    await userEvent.type(within(dialog).getByLabelText('Enter your password'), 'correct horse battery');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Confirm' }));
    await expect(reauthenticated).toHaveBeenCalledWith({ password: 'correct horse battery', totpCode: undefined });
    await waitFor(() => expect(revoke).toHaveBeenCalledTimes(2));
    await expect(revoke).toHaveBeenLastCalledWith(['s2', 's4']);
    await expect(refreshed).toHaveBeenCalled();
    await expect(await canvas.findByText(/Signed out\. Those devices need/)).toBeVisible();
  },
};

export const ProductSessions: Story = {
  render: () => <DevicesPage devices={{ status: 'ok', items: [devices[0]!, {
    ...devices[1]!, browser: 'Chrome', platform: 'Linux',
  }] }} />,
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await expect(await canvas.findByRole('heading', { name: 'Devices and sessions' })).toBeVisible();
    await expect(canvas.getByText('REZICS · Chrome on Linux')).toBeVisible();
    await expect(canvas.getByRole('button', { name: 'Sign out · REZICS · Chrome on Linux' })).toBeVisible();
  },
};
export const ProductSessionsPhone: Story = { ...ProductSessions, globals: phone };
export const ProductSessionsKorean: Story = {
  render: ProductSessions.render, globals: { locale: 'ko' },
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await expect(await canvas.findByRole('heading', { name: '기기 및 세션' })).toBeVisible();
    await expect(canvas.getByRole('button', { name: /로그아웃.*Chrome.*REZICS/ })).toBeVisible();
  },
};
export const ProductSessionsKoreanPhone: Story = { ...ProductSessionsKorean, globals: { ...phone, locale: 'ko' } };

export const LimitedSessionList: Story = {
  render: () => <DevicesPage devices={{ status: 'ok', items: devices, limited: true, older: 'next-page' }} />,
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await expect(await canvas.findByText(/Showing up to 100 sessions per page/)).toBeVisible();
    await expect(canvas.getByRole('link', { name: 'Show older sessions' }))
      .toHaveAttribute('href', '/security/devices?cursor=next-page');
    await userEvent.click(canvas.getByRole('button', { name: 'Sign out of all other devices' }));
    const dialog = await screen.findByRole('alertdialog', { name: 'Sign out of all other devices?' });
    await expect(within(dialog).getByText(/including sessions not listed here/)).toBeVisible();
    await userEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
  },
};

export const OlderSessionPage: Story = {
  render: () => {
    const sessions: DeviceSession[] = ['old-1', 'old-2'].map(id => ({ id,
      groupKey: 'same-device', createdAt: '2026-09-01T12:00:00Z', lastActiveAt: '2026-09-02T12:00:00Z',
      browser: 'Safari', platform: 'iOS', network: null, thisDevice: false }));
    return <DevicesPage devices={{ status: 'ok', items: sessionViews(sessions, new Date('2026-09-28T12:00:00Z'), 'en'),
      paged: true }} />;
  },
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await expect(await canvas.findAllByRole('button', { name: 'Sign out · Safari on iOS' })).toHaveLength(2);
    await expect(canvas.getByRole('link', { name: 'Back to the newest sessions' }))
      .toHaveAttribute('href', '/security/devices');
  },
};

export const ConfirmWithPasskeyAndCode: Story = {
  render: () => <DevicesPage devices={{ status: 'ok', items: devices }} />,
  parameters: { stepUp: { password: true, passkey: true, totp: true },
    account: { api: { revokeOtherSessions: async () => ({ ok: false, kind: 'step-up-required', status: 403 }),
      reauthenticateWithPasskey: async () => ({ ok: false, kind: 'invalid-credentials', status: 403 }) } } },
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await userEvent.click(await canvas.findByRole('button', { name: 'Sign out of all other devices' }));
    const confirmation = await screen.findByRole('alertdialog', { name: 'Sign out of all other devices?' });
    await userEvent.click(within(confirmation).getByRole('button', { name: 'Sign out everywhere else' }));
    const dialog = await screen.findByRole('dialog', { name: 'Confirm it’s you' });
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    await userEvent.click(within(dialog).getByRole('button', { name: 'Use your passkey' }));
    await expect(await within(dialog).findByRole('alert')).toHaveTextContent('That passkey couldn’t confirm it’s you.');
    await expect(within(dialog).getByRole('textbox', { name: 'Code from your authenticator app' })).toBeVisible();
    await userEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    // Dismissing the prompt is a choice, not an error.
    await expect(canvas.queryByRole('alert')).toBeNull();
  },
};

const changed = fn(async () => ({ ok: false as const, kind: 'invalid-credentials' as const, status: 400 }));
export const ChangePassword: Story = {
  parameters: { account: { api: { changePassword: changed } } },
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await userEvent.click(await canvas.findByRole('button', { name: 'Change password' }));
    await userEvent.type(canvas.getByLabelText('Current password'), 'old pass phrase');
    await userEvent.type(canvas.getByLabelText('New password'), 'short');
    await userEvent.type(canvas.getByLabelText('Confirm new password'), 'short');
    await userEvent.click(canvas.getByRole('button', { name: 'Change password' }));
    await expect(canvas.getByText('Use 12 characters or more for your password')).toBeVisible();
    await userEvent.clear(canvas.getByLabelText('New password'));
    await userEvent.clear(canvas.getByLabelText('Confirm new password'));
    await userEvent.type(canvas.getByLabelText('New password'), 'new long pass phrase');
    await userEvent.type(canvas.getByLabelText('Confirm new password'), 'new long pass phrase');
    await expect(canvas.getByText('Changing your password signs you out on your other devices.')).toBeVisible();
    await userEvent.click(canvas.getByRole('button', { name: 'Change password' }));
    await expect(changed).toHaveBeenCalledWith({ currentPassword: 'old pass phrase', newPassword: 'new long pass phrase' });
    await expect(await canvas.findByText('Your current password is incorrect')).toBeVisible();
  },
};

export const PasskeysOnly: Story = {
  args: { signIn: { password: false, passwordChanged: null, passkeys: 1, twoStep: false } },
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await expect(await canvas.findByText('Not set: you sign in with passkeys')).toBeVisible();
    await expect(canvas.getByRole('link', { name: 'Set a password' })).toHaveAttribute('href', '/forgot-password');
    await expect(canvas.getByText('2-Step Verification is off')).toBeVisible();
  },
};

export const Recommendations: Story = {
  args: { signIn: { password: true, passwordChanged: 'Sep 1, 2026', passkeys: 0, twoStep: false },
    issues: ['add-second-step'], activity: { status: 'ok', entries: [] }, devices: { status: 'ok', items: devices.slice(0, 1) } },
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await expect(await canvas.findByRole('heading', { name: 'One way to make your account safer' })).toBeVisible();
    await expect(canvas.getByText('No passkeys yet')).toBeVisible();
    await expect(canvas.getByText('You’re not signed in anywhere else.')).toBeVisible();
    await expect(canvas.getByText('No security activity in the last 90 days.')).toBeVisible();
  },
};

export const Unavailable: Story = {
  args: { signIn: null, checkupComplete: false, devices: { status: 'unavailable' }, activity: { status: 'unavailable' } },
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await expect((await canvas.findAllByText(/We could not reach the REZICS Account service/))[0]).toBeVisible();
    await expect(canvas.getAllByRole('button', { name: 'Try again' })).toHaveLength(2);
  },
};

export const Dark: Story = { ...Overview, globals: dark };
export const Phone: Story = { ...Overview, globals: phone };
export const Chinese: Story = {
  globals: chinese,
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await expect(await canvas.findByRole('heading', { level: 1, name: '安全与登录' })).toBeVisible();
    await expect(canvas.getByText('当前设备')).toBeVisible();
    await expect(canvas.getByText('使用通行密钥登录')).toBeVisible();
    await expect(canvas.getByRole('link', { name: '管理所有设备' })).toHaveAttribute('href', '/security/devices');
  },
};
