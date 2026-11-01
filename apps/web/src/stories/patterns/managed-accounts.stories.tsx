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
  | 'invalid-cursor'
  | 'stale-cursor'
  | 'restart-unavailable'
  | 'restart-denied'
  | 'denied';

/** Illustrative current native failures for component review; no native outcome is claimed. */
function exampleIO(scenario: Scenario): ManagedAccountsIO {
  if (scenario === 'independent' || scenario === 'preparing' || scenario === 'reconciling')
    return managedAccountsIO(scenario);
  if (
    scenario === 'invalid-cursor' ||
    scenario === 'stale-cursor' ||
    scenario === 'restart-unavailable' ||
    scenario === 'restart-denied'
  ) {
    let firstPages = 0;
    const feed = scenario === 'stale-cursor' ? 'responsibilities' : 'organizations';
    return async (cursors) => {
      const page = managedAccountsExample();
      const cursor = feed === 'organizations' ? cursors.organizationsCursor : cursors.operatorsCursor;
      if (cursor !== undefined)
        return managedAccountsFailure(
          scenario === 'stale-cursor' ? 409 : 400,
          { code: scenario === 'stale-cursor' ? 'stale_cursor' : 'invalid_cursor' },
          scenario === 'invalid-cursor' ? { 'Retry-After': '1' } : undefined,
        );
      if (cursors.organizationsCursor || cursors.operatorsCursor) {
        const sibling = feed === 'organizations' ? 'responsibilities' : 'organizations';
        page[sibling].items = [];
        page[sibling].next = null;
        return { ok: true, page };
      }
      if (++firstPages === 1) return { ok: true, page };
      if (scenario === 'restart-denied') return managedAccountsFailure(403, { code: 'forbidden' });
      if (scenario === 'restart-unavailable' && firstPages === 2)
        return managedAccountsFailure(503, { code: 'dependency_unavailable' }, { 'Retry-After': '1' });
      await new Promise((resolve) => setTimeout(resolve, 400));
      page[feed].items = [];
      page[feed].next = null;
      if (scenario === 'restart-unavailable') page.organizations.state = 'preparing';
      return { ok: true, page };
    };
  }
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
    await expect(canvas.getAllByRole('heading', { level: 4 }).map((heading) => heading.textContent)).toEqual([
      'Avery Reader',
      'Atlas Editors',
      'Independent Reading Group',
      'Atlas Indexer',
      m.settings_managed_identity_unavailable(),
    ]);
    for (const [name, id] of [
      ['Avery Reader', managedViewer],
      ['Atlas Editors', '019a0000-0000-7000-8000-000000000002'],
      ['Independent Reading Group', '019a0000-0000-7000-8000-000000000003'],
      ['Atlas Indexer', '019a0000-0000-7000-8000-000000000005'],
    ] as const) {
      const heading = canvas.getByRole('heading', { name, level: 4 });
      await expect(heading).toBeVisible();
      const row = within(heading.closest('li')!);
      await expect(row.getAllByRole('heading')).toHaveLength(1);
      await expect(row.getAllByRole('link')).toHaveLength(1);
      await expect(row.getByRole('link', { name })).toHaveAttribute(
        'href',
        `/${getLocale()}/settings?panel=compact&managedAccount=${id}#account`,
      );
    }
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
    const unavailableHeading = canvas.getByRole('heading', {
      name: m.settings_managed_identity_unavailable(),
      level: 4,
    });
    await expect(unavailableHeading).toBeVisible();
    const unavailableElement = unavailableHeading.closest('li')!;
    const unavailable = within(unavailableElement);
    await expect(unavailable.getAllByRole('heading')).toHaveLength(1);
    await expect(unavailable.queryByRole('link')).toBeNull();
    await expect(unavailableElement.querySelector('[data-slot="avatar"]')).toBeNull();
    await expect(unavailable.getByText(m.managed_reconciling())).toBeVisible();
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

export const InvalidCursorFirstPageRecovery: Story = {
  args: { scenario: 'invalid-cursor' },
  globals: { viewport: { value: 'phone390' } },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await canvas.findByRole('list', { name: m.managed_your_account() });
    const organizations = within(canvas.getByRole('list', { name: m.managed_organizations_title() }).parentElement!);
    await userEvent.click(organizations.getByRole('button', { name: m.settings_managed_load_more() }));
    await organizations.findByRole('alert');
    const retry = organizations.getByRole('button', { name: m.settings_retry() });
    const firstPage = organizations.getByRole('button', { name: m.settings_managed_restart_list() });
    await expect(retry).toBeDisabled();
    await expect(firstPage).toBeDisabled();
    await expect(organizations.getByRole('status')).toHaveTextContent(m.settings_managed_organizations_retry_wait());
    await waitFor(() => expect(firstPage).toBeEnabled(), { timeout: 3000 });
    await expect(retry).toBeEnabled();
    await expect(organizations.getByRole('alert')).toBeVisible();
    await userEvent.click(firstPage);
    await expect(firstPage).toBeDisabled();
    await expect(retry).toBeDisabled();
    await expect(organizations.getByRole('link', { name: 'Atlas Editors' })).toBeVisible();
    await organizations.findByText(m.managed_no_organizations());
    await expect(organizations.queryByRole('button')).toBeNull();
    await expect(organizations.queryByRole('link')).toBeNull();
    await expect(canvas.getByRole('link', { name: 'Atlas Indexer' })).toBeVisible();
  },
};

export const StaleCursorIndependentRecovery: Story = {
  args: { scenario: 'stale-cursor' },
  globals: { viewport: { value: 'desktop1280' } },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await canvas.findByRole('list', { name: m.managed_your_account() });
    const organizations = within(canvas.getByRole('list', { name: m.managed_organizations_title() }).parentElement!);
    const responsibilities = within(canvas.getByRole('list', { name: m.managed_operated_title() }).parentElement!);
    await userEvent.click(responsibilities.getByRole('button', { name: m.settings_managed_load_more() }));
    await responsibilities.findByRole('alert');
    await userEvent.click(organizations.getByRole('button', { name: m.settings_managed_load_more() }));
    await waitFor(() => expect(organizations.queryByRole('button')).toBeNull());
    await userEvent.click(responsibilities.getByRole('button', { name: m.settings_managed_restart_list() }));
    await responsibilities.findByText(m.managed_no_responsibilities());
    await expect(responsibilities.queryByRole('link')).toBeNull();
    await expect(organizations.getByRole('link', { name: 'Atlas Editors' })).toBeVisible();
    await expect(organizations.queryByRole('button')).toBeNull();
  },
};

export const FailedFirstPageRecovery: Story = {
  args: { scenario: 'restart-unavailable' },
  globals: { viewport: { value: 'phone390' } },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await canvas.findByRole('list', { name: m.managed_your_account() });
    const organizations = within(canvas.getByRole('list', { name: m.managed_organizations_title() }).parentElement!);
    await userEvent.click(organizations.getByRole('button', { name: m.settings_managed_load_more() }));
    await organizations.findByRole('alert');
    await userEvent.click(organizations.getByRole('button', { name: m.settings_managed_restart_list() }));
    const firstPage = organizations.getByRole('button', { name: m.settings_managed_restart_list() });
    await expect(firstPage).toBeDisabled();
    await expect(organizations.getByRole('button', { name: m.settings_retry() })).toBeDisabled();
    await expect(organizations.getByRole('link', { name: 'Atlas Editors' })).toBeVisible();
    await expect(organizations.queryByText(m.managed_no_organizations())).toBeNull();
    await waitFor(() => expect(firstPage).toBeEnabled(), { timeout: 3000 });
    await expect(organizations.getByRole('alert')).toBeVisible();
    await userEvent.click(firstPage);
    await organizations.findByText(m.managed_preparing_text());
    await expect(organizations.queryByRole('alert')).toBeNull();
    await expect(organizations.queryByRole('button', { name: m.settings_managed_restart_list() })).toBeNull();
    await expect(canvas.getByRole('link', { name: 'Atlas Indexer' })).toBeVisible();
  },
};

export const DeniedFirstPageClearsInventory: Story = {
  args: { scenario: 'restart-denied' },
  globals: { viewport: { value: 'desktop1280' } },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await canvas.findByRole('list', { name: m.managed_your_account() });
    const organizations = within(canvas.getByRole('list', { name: m.managed_organizations_title() }).parentElement!);
    await userEvent.click(organizations.getByRole('button', { name: m.settings_managed_load_more() }));
    await organizations.findByRole('alert');
    await userEvent.click(organizations.getByRole('button', { name: m.settings_managed_restart_list() }));
    await canvas.findByText(m.managed_denied_text());
    await expect(canvas.queryAllByRole('list')).toHaveLength(0);
    await expect(canvas.queryByRole('link', { name: 'Atlas Indexer' })).toBeNull();
    await expect(canvas.queryByRole('button', { name: m.settings_managed_restart_list() })).toBeNull();
    await expect(canvas.getByRole('button', { name: m.settings_retry() })).toBeEnabled();
  },
};
