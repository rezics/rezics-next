import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, fn, screen, userEvent, waitFor, within } from 'storybook/test';
import { type ConnectedAppView, ConnectedApps } from './connected-apps.tsx';
import { AccountFrame } from '../../.storybook/account-frame.tsx';
import { chinese, dark, phone } from '../../.storybook/variants.ts';
import { ReadStatePanel } from '../shell/state-panel.tsx';

const apps: ConnectedAppView[] = [
  { clientId: 'reader', name: 'Reader', icon: null, uri: 'https://reader.example', trusted: false, withdrawn: false,
    granted: 'Sep 27, 2026', lastUsed: '3 hours ago',
    permissions: ['Identify your REZICS account', 'Read works', 'Keep access while you are signed out, until you revoke it'] },
  { clientId: 'rezics-web', name: 'REZICS', icon: null, uri: null, trusted: true, withdrawn: false,
    granted: 'Aug 2, 2026', lastUsed: null, permissions: ['Identify your REZICS account', 'Create works'] },
  { clientId: 'old-tool', name: 'Old tool', icon: null, uri: null, trusted: false, withdrawn: true,
    granted: 'Jan 5, 2026', lastUsed: '8 months ago', permissions: ['Read works'] },
];

const meta = {
  title: 'Accounts/Account centre/Connected apps', component: ConnectedApps, args: { apps },
  decorators: [Story => <AccountFrame section="connected-apps"><Story /></AccountFrame>],
} satisfies Meta<typeof ConnectedApps>;
export default meta;
type Story = StoryObj<typeof meta>;

const revoked = fn(async (): Promise<{ ok: true; data: undefined } | { ok: false; kind: 'step-up-required'; status: number }> =>
  revoked.mock.calls.length === 1 ? { ok: false, kind: 'step-up-required', status: 403 } : { ok: true, data: undefined });
const refreshed = fn();
export const Apps: Story = {
  parameters: { account: { refresh: refreshed, api: { revokeApp: revoked } } },
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await expect(await canvas.findByRole('heading', { level: 2, name: 'Reader' })).toBeVisible();
    await expect(canvas.getByText('Access given Sep 27, 2026 · Last used 3 hours ago')).toBeVisible();
    await expect(canvas.getByText('Keep access while you are signed out, until you revoke it')).toBeVisible();
    await expect(canvas.getByText('REZICS app')).toBeVisible();
    await expect(canvas.getByText(/REZICS apps don’t ask first/)).toBeVisible();
    await expect(canvas.getByText('No longer available')).toBeVisible();
    await userEvent.click(canvas.getAllByRole('button', { name: 'Remove access' })[0]!);
    const dialog = await screen.findByRole('alertdialog');
    await waitFor(() => expect(within(dialog).getByText('Remove access for Reader?')).toBeVisible());
    await userEvent.click(within(dialog).getByRole('button', { name: 'Remove' }));
    const confirm = await screen.findByRole('dialog', { name: 'Confirm it’s you' });
    await userEvent.type(within(confirm).getByLabelText('Enter your password'), 'correct horse battery');
    await userEvent.click(within(confirm).getByRole('button', { name: 'Confirm' }));
    await waitFor(() => expect(revoked).toHaveBeenCalledTimes(2));
    await expect(revoked).toHaveBeenLastCalledWith('reader');
    await expect(refreshed).toHaveBeenCalled();
    await expect(await canvas.findByText('Access removed')).toBeVisible();
  },
};

export const TrustedApp: Story = {
  args: { apps: apps.slice(1, 2) },
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await userEvent.click((await canvas.findAllByRole('button', { name: 'Remove access' }))[0]!);
    const dialog = await screen.findByRole('alertdialog');
    await waitFor(() => expect(within(dialog).getByText(/gets access again the next time you sign in to it/)).toBeVisible());
  },
};

export const Empty: Story = {
  args: { apps: [] },
  async play({ canvasElement }) {
    await expect(await within(canvasElement).findByRole('heading', { name: 'No apps have access' })).toBeVisible();
  },
};

export const Unavailable: Story = {
  render: () => <ReadStatePanel status="unavailable" next="/connected-apps" />,
  async play({ canvasElement }) {
    await expect(await within(canvasElement).findByRole('heading', { name: 'Your account is unavailable right now' }))
      .toBeVisible();
  },
};

export const Dark: Story = { globals: dark };
export const Phone: Story = { globals: phone,
  async play({ canvasElement }) {
    await expect(await within(canvasElement).findByRole('heading', { level: 2, name: 'Reader' })).toBeVisible();
  },
};
export const Chinese: Story = {
  globals: chinese,
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await expect(await canvas.findByRole('heading', { level: 1, name: '已关联的应用' })).toBeVisible();
    await expect(canvas.getByText('REZICS 应用')).toBeVisible();
  },
};
