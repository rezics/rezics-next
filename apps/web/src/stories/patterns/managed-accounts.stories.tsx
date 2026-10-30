import type { Meta, StoryObj } from '@storybook/react-vite';
import { useState } from 'react';
import { expect, userEvent, within } from 'storybook/test';
import { m } from '../../paraglide/messages.js';
import { getLocale } from '../../paraglide/runtime.js';
import { ManagedAccounts } from '../../settings/managed-accounts';
import { managedAccountsIO, managedViewer } from './managed-accounts.fixtures';

function Example({ scenario = 'independent' }: { scenario?: 'independent' | 'preparing' | 'reconciling' }) {
  const [io] = useState(() => managedAccountsIO(scenario));
  return (
    <div className="mx-auto max-w-2xl p-4">
      <ManagedAccounts
        viewerId={managedViewer}
        settingsHref={`/${getLocale()}/settings?panel=compact#account`}
        io={io}
      />
    </div>
  );
}
const meta = {
  title: 'Patterns/Account/Managed accounts',
  component: Example,
  parameters: {
    layout: 'padded',
    docs: {
      description: {
        component:
          'The actual settings inventory with illustrative bounded native-shaped IO. Review at the shared phone390 and desktop1280 globals. Native acceptance and visual review remain deferred.',
      },
    },
  },
} satisfies Meta<typeof Example>;
export default meta;
type Story = StoryObj<typeof meta>;

export const IndependentCursors: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await canvas.findByRole('list', { name: m.managed_your_account() });
    const organizations = within(canvas.getByRole('list', { name: m.managed_organizations_title() }).parentElement!);
    const responsibilities = within(canvas.getByRole('list', { name: m.managed_operated_title() }).parentElement!);
    await userEvent.click(organizations.getByRole('button', { name: m.settings_managed_load_more() }));
    await organizations.findByRole('alert');
    await expect(organizations.getByRole('link', { name: 'Atlas Editors' })).toBeVisible();
    await userEvent.click(responsibilities.getByRole('button', { name: m.settings_managed_load_more() }));
    await expect(responsibilities.queryByRole('button')).toBeNull();
    await userEvent.click(organizations.getByRole('button', { name: m.settings_retry() }));
    await organizations.findByRole('button', { name: m.settings_managed_load_more() });
    await expect(responsibilities.queryByRole('button')).toBeNull();
  },
};
export const PartialPreparing: Story = {
  args: { scenario: 'preparing' },
  globals: { viewport: { value: 'phone390' } },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await canvas.findByText(m.managed_preparing_text());
    await expect(canvas.getByRole('link', { name: 'Atlas Indexer' })).toBeVisible();
    await userEvent.click(canvas.getByRole('button', { name: m.settings_managed_load_more() }));
    await expect(canvas.getByText(m.managed_preparing_text())).toBeVisible();
  },
};
export const ReconcilingAndUnavailableIdentity: Story = {
  args: { scenario: 'reconciling' },
  globals: { viewport: { value: 'desktop1280' } },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await canvas.findByText(m.settings_managed_identity_unavailable());
    await expect(canvas.queryByText(m.managed_current())).toBeNull();
    await expect(canvas.getAllByText(m.managed_reconciling())).toHaveLength(2);
    const href = canvas.getByRole('link', { name: 'Atlas Indexer' }).getAttribute('href')!;
    await expect(href).toContain('managedAccount=019a0000-0000-7000-8000-000000000005');
    await expect(href).toContain('panel=compact');
    await expect(href).toContain('#account');
  },
};
