import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, fn, screen, userEvent, waitFor, within } from 'storybook/test';
import { type ConnectedApp, ConnectedApps } from './connected-apps.tsx';
import { AccountFrame } from '../../.storybook/account-frame.tsx';
import { chinese, dark, phone } from '../../.storybook/variants.ts';
import { ReadStatePanel } from '../shell/state-panel.tsx';

const apps: ConnectedApp[] = [
  { consentId: 'c1', name: 'Reader', logo: null, uri: 'https://reader.example', since: 'Sep 27, 2026',
    scopes: ['openid', 'profile', 'work:read', 'offline_access'] },
  { consentId: 'c2', name: null, logo: null, uri: null, since: 'Aug 2, 2026', scopes: ['openid', 'realm:adopt'] },
];

const meta = {
  title: 'Accounts/Account centre/Connected apps', component: ConnectedApps, args: { apps },
  decorators: [Story => <AccountFrame section="connected-apps"><Story /></AccountFrame>],
} satisfies Meta<typeof ConnectedApps>;
export default meta;
type Story = StoryObj<typeof meta>;

const removed = fn(async () => ({ ok: true as const, data: undefined }));
const refreshed = fn();
export const Apps: Story = {
  parameters: { account: { refresh: refreshed, api: { removeAppAccess: removed } } },
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await expect(await canvas.findByRole('heading', { level: 2, name: 'Reader' })).toBeVisible();
    await expect(canvas.getByRole('heading', { level: 2, name: 'An app' })).toBeVisible();
    await expect(canvas.getByText('Access given Sep 27, 2026')).toBeVisible();
    await userEvent.click(canvas.getAllByRole('button', { name: 'Remove access' })[0]!);
    const dialog = await screen.findByRole('alertdialog');
    await waitFor(() => expect(within(dialog).getByText('Remove access for Reader?')).toBeVisible());
    await userEvent.click(within(dialog).getByRole('button', { name: 'Remove' }));
    await expect(removed).toHaveBeenCalledWith('c1');
    await expect(refreshed).toHaveBeenCalled();
    await expect(await canvas.findByText('Access removed')).toBeVisible();
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

export const Dark: Story = { ...Empty, globals: dark };
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
    await expect(canvas.getByRole('heading', { level: 2, name: '某个应用' })).toBeVisible();
  },
};
