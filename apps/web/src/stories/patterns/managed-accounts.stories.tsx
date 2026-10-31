import type { Meta, StoryObj } from '@storybook/react-vite';
import { useState } from 'react';
import { expect, userEvent, waitFor, within } from 'storybook/test';
import { m } from '../../paraglide/messages.js';
import { getLocale } from '../../paraglide/runtime.js';
import { ManagedAccounts } from '../../settings/managed-accounts';
import { managedAccountsFailure, type ManagedAccountsIO } from '../../settings/managed-accounts-read';
import { managedAccountsExample, managedAccountsIO, managedViewer } from './managed-accounts.fixtures';

type Scenario =
  | 'independent'
  | 'preparing'
  | 'reconciling'
  | 'initial-delay'
  | 'initial-unavailable'
  | 'feed-delays'
  | 'denied';

/** Illustrative current native failures for component review; no native outcome is claimed. */
function exampleIO(scenario: Scenario): ManagedAccountsIO {
  if (scenario === 'independent' || scenario === 'preparing' || scenario === 'reconciling')
    return managedAccountsIO(scenario);
  const failed = new Set<string>();
  return async (cursors) => {
    const feed = cursors.organizationsCursor
      ? 'organizations'
      : cursors.operatorsCursor
        ? 'responsibilities'
        : 'inventory';
    if (scenario === 'denied' && feed === 'organizations')
      return managedAccountsFailure(403, { code: 'forbidden', retryable: false, request_id: 'illustrative-denial' });
    if (
      !failed.has(feed) &&
      ((feed === 'inventory' && (scenario === 'initial-delay' || scenario === 'initial-unavailable')) ||
        (feed !== 'inventory' && scenario === 'feed-delays'))
    ) {
      failed.add(feed);
      const status = feed === 'responsibilities' || scenario === 'initial-unavailable' ? 503 : 429;
      return managedAccountsFailure(
        status,
        {
          code: status === 429 ? 'rate_limited' : 'dependency_unavailable',
          retryable: true,
          request_id: `illustrative-${feed}`,
        },
        scenario === 'initial-unavailable'
          ? undefined
          : {
              'Retry-After': feed === 'responsibilities' ? new Date(Date.now() + 5000).toUTCString() : '1',
            },
      );
    }
    const page = managedAccountsExample();
    if (feed === 'organizations') page.organizations = { state: 'ready', items: [], next: null };
    if (feed === 'responsibilities') page.responsibilities = { items: [], next: null };
    return { ok: true, page };
  };
}

function Example({ scenario = 'independent' }: { scenario?: Scenario }) {
  const [io] = useState(() => exampleIO(scenario));
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

export const InitialRetryDelay: Story = {
  args: { scenario: 'initial-delay' },
  globals: { viewport: { value: 'phone390' } },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const alert = await canvas.findByRole('alert');
    const retry = within(alert).getByRole('button', { name: m.settings_retry() });
    await expect(within(alert).getByRole('status')).toHaveTextContent(m.settings_managed_inventory_retry_wait());
    await expect(retry).toBeDisabled();
    await userEvent.click(retry);
    await expect(canvas.queryByRole('list')).toBeNull();
    await waitFor(() => expect(retry).toBeEnabled(), { timeout: 3000 });
    await expect(alert).toBeVisible();
    await expect(within(alert).queryByRole('status')).toBeNull();
    await userEvent.click(retry);
    await canvas.findByRole('list', { name: m.managed_your_account() });
  },
};

export const InitialUnavailable: Story = {
  args: { scenario: 'initial-unavailable' },
  globals: { viewport: { value: 'desktop1280' } },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const alert = within(await canvas.findByRole('alert'));
    const retry = alert.getByRole('button', { name: m.settings_retry() });
    await expect(retry).toBeEnabled();
    await expect(alert.queryByRole('status')).toBeNull();
    await expect(canvas.queryByRole('list')).toBeNull();
    await userEvent.click(retry);
    await canvas.findByRole('list', { name: m.managed_your_account() });
  },
};

export const IndependentRetryDelays: Story = {
  args: { scenario: 'feed-delays' },
  globals: { viewport: { value: 'desktop1280' } },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await canvas.findByRole('list', { name: m.managed_your_account() });
    const organizations = within(canvas.getByRole('list', { name: m.managed_organizations_title() }).parentElement!);
    const responsibilities = within(canvas.getByRole('list', { name: m.managed_operated_title() }).parentElement!);
    await userEvent.click(organizations.getByRole('button', { name: m.settings_managed_load_more() }));
    await organizations.findByRole('alert');
    await userEvent.click(responsibilities.getByRole('button', { name: m.settings_managed_load_more() }));
    await responsibilities.findByRole('alert');
    const organizationRetry = organizations.getByRole('button', { name: m.settings_retry() });
    const responsibilityRetry = responsibilities.getByRole('button', { name: m.settings_retry() });
    await expect(organizations.getByRole('status')).toHaveTextContent(m.settings_managed_organizations_retry_wait());
    await expect(responsibilities.getByRole('status')).toHaveTextContent(
      m.settings_managed_responsibilities_retry_wait(),
    );
    await expect(organizationRetry).toBeDisabled();
    await expect(responsibilityRetry).toBeDisabled();
    await expect(organizations.getByRole('link', { name: 'Atlas Editors' })).toBeVisible();
    await expect(responsibilities.getByText(m.managed_reconciling())).toBeVisible();
    await waitFor(() => expect(organizationRetry).toBeEnabled(), { timeout: 3000 });
    await expect(responsibilityRetry).toBeDisabled();
    await expect(organizations.getByRole('alert')).toBeVisible();
    await userEvent.click(organizationRetry);
    await waitFor(() => expect(organizations.queryByRole('alert')).toBeNull());
    await expect(responsibilities.getByRole('alert')).toBeVisible();
    await waitFor(() => expect(responsibilityRetry).toBeEnabled(), { timeout: 6500 });
    await expect(responsibilities.getByRole('alert')).toBeVisible();
    await userEvent.click(responsibilityRetry);
    await waitFor(() => expect(responsibilities.queryByRole('alert')).toBeNull());
    await expect(responsibilities.getByText(m.managed_reconciling())).toBeVisible();
  },
};

export const DenialClearsInventory: Story = {
  args: { scenario: 'denied' },
  globals: { viewport: { value: 'phone390' } },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await canvas.findByRole('list', { name: m.managed_your_account() });
    const organizations = within(canvas.getByRole('list', { name: m.managed_organizations_title() }).parentElement!);
    await userEvent.click(organizations.getByRole('button', { name: m.settings_managed_load_more() }));
    await canvas.findByText(m.managed_denied_text());
    await expect(canvas.queryAllByRole('list')).toHaveLength(0);
    await expect(canvas.queryByRole('link', { name: 'Atlas Indexer' })).toBeNull();
    await expect(canvas.getByRole('button', { name: m.settings_retry() })).toBeEnabled();
  },
};
