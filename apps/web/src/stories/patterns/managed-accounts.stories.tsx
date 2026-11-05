import type { Meta, StoryObj } from '@storybook/react-vite';
import { useState } from 'react';
import { expect, userEvent, waitFor, within } from 'storybook/test';
import { m } from '../../paraglide/messages.js';
import { getLocale } from '../../paraglide/runtime.js';
import { ManagedAccounts } from '../../settings/managed-accounts';
import {
  managedAccountsFailure,
  type ManagedAccountsCursors,
  type ManagedAccountsIO,
  type ManagedAccountsResult,
} from '../../settings/managed-accounts-read';
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
    for (const name of ['Avery Reader', 'Atlas Editors', 'Independent Reading Group', 'Atlas Indexer']) {
      const heading = canvas.getByRole('heading', { name, level: 4 });
      await expect(heading).toBeVisible();
      const row = within(heading.closest('li')!);
      await expect(row.getAllByRole('heading')).toHaveLength(1);
      await expect(row.queryByRole('link')).toBeNull();
    }
    await userEvent.click(organizations.getByRole('button', { name: m.managed_next() }));
    await organizations.findByRole('alert');
    await expect(organizations.getByRole('heading', { level: 4, name: 'Atlas Editors' })).toBeVisible();
    await userEvent.click(responsibilities.getByRole('button', { name: m.managed_next() }));
    await expect(responsibilities.queryByRole('button')).toBeNull();
    await userEvent.click(organizations.getByRole('button', { name: m.settings_retry() }));
    await organizations.findByRole('button', { name: m.managed_next() });
    await expect(responsibilities.queryByRole('button')).toBeNull();
  },
};
export const PartialPreparing: Story = {
  args: { scenario: 'preparing' },
  globals: { viewport: { value: 'phone390' } },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await canvas.findByText(m.managed_preparing_text());
    await expect(canvas.getByRole('heading', { level: 4, name: 'Atlas Indexer' })).toBeVisible();
    await userEvent.click(canvas.getByRole('button', { name: m.managed_next() }));
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
    await expect(canvas.queryByRole('link')).toBeNull();
    await expect(canvas.getByText(m.settings_managed_navigation_unavailable())).toBeVisible();
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
    await userEvent.click(organizations.getByRole('button', { name: m.managed_next() }));
    await organizations.findByRole('alert');
    await userEvent.click(responsibilities.getByRole('button', { name: m.managed_next() }));
    await responsibilities.findByRole('alert');
    const organizationRetry = organizations.getByRole('button', { name: m.settings_retry() });
    const responsibilityRetry = responsibilities.getByRole('button', { name: m.settings_retry() });
    await expect(organizations.getByRole('status')).toHaveTextContent(m.settings_managed_organizations_retry_wait());
    await expect(responsibilities.getByRole('status')).toHaveTextContent(
      m.settings_managed_responsibilities_retry_wait(),
    );
    await expect(organizationRetry).toBeDisabled();
    await expect(responsibilityRetry).toBeDisabled();
    await expect(organizations.getByRole('heading', { level: 4, name: 'Atlas Editors' })).toBeVisible();
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
    await userEvent.click(organizations.getByRole('button', { name: m.managed_next() }));
    await canvas.findByText(m.managed_denied_text());
    await expect(canvas.queryAllByRole('list')).toHaveLength(0);
    await expect(canvas.queryByRole('heading', { level: 4, name: 'Atlas Indexer' })).toBeNull();
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
    await userEvent.click(organizations.getByRole('button', { name: m.managed_next() }));
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
    await expect(organizations.getByRole('heading', { level: 4, name: 'Atlas Editors' })).toBeVisible();
    await organizations.findByText(m.managed_no_organizations());
    await expect(organizations.getByRole('button', { name: m.prq_previous() })).toBeEnabled();
    await expect(organizations.getByRole('button', { name: m.settings_managed_restart_list() })).toBeEnabled();
    await expect(organizations.queryByRole('heading', { level: 4, name: 'Atlas Editors' })).toBeNull();
    await expect(canvas.getByRole('heading', { level: 4, name: 'Atlas Indexer' })).toBeVisible();
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
    await userEvent.click(responsibilities.getByRole('button', { name: m.managed_next() }));
    await responsibilities.findByRole('alert');
    await userEvent.click(organizations.getByRole('button', { name: m.managed_next() }));
    await waitFor(() => expect(organizations.queryByRole('button')).toBeNull());
    await userEvent.click(responsibilities.getByRole('button', { name: m.settings_managed_restart_list() }));
    await responsibilities.findByText(m.managed_no_responsibilities());
    await expect(responsibilities.queryByRole('link')).toBeNull();
    await expect(organizations.getByRole('heading', { level: 4, name: 'Atlas Editors' })).toBeVisible();
    await expect(organizations.getByRole('button', { name: m.prq_previous() })).toBeEnabled();
    await expect(organizations.getByRole('button', { name: m.settings_managed_restart_list() })).toBeEnabled();
  },
};

export const FailedFirstPageRecovery: Story = {
  args: { scenario: 'restart-unavailable' },
  globals: { viewport: { value: 'phone390' } },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await canvas.findByRole('list', { name: m.managed_your_account() });
    const organizations = within(canvas.getByRole('list', { name: m.managed_organizations_title() }).parentElement!);
    await userEvent.click(organizations.getByRole('button', { name: m.managed_next() }));
    await organizations.findByRole('alert');
    await userEvent.click(organizations.getByRole('button', { name: m.settings_managed_restart_list() }));
    const firstPage = organizations.getByRole('button', { name: m.settings_managed_restart_list() });
    await expect(firstPage).toBeDisabled();
    await expect(organizations.getByRole('button', { name: m.settings_retry() })).toBeDisabled();
    await expect(organizations.getByRole('heading', { level: 4, name: 'Atlas Editors' })).toBeVisible();
    await expect(organizations.queryByText(m.managed_no_organizations())).toBeNull();
    await waitFor(() => expect(firstPage).toBeEnabled(), { timeout: 3000 });
    await expect(organizations.getByRole('alert')).toBeVisible();
    await userEvent.click(firstPage);
    await organizations.findByText(m.managed_preparing_text());
    await expect(organizations.queryByRole('alert')).toBeNull();
    await expect(organizations.queryByRole('button', { name: m.settings_managed_restart_list() })).toBeNull();
    await expect(canvas.getByRole('heading', { level: 4, name: 'Atlas Indexer' })).toBeVisible();
  },
};

export const DeniedFirstPageClearsInventory: Story = {
  args: { scenario: 'restart-denied' },
  globals: { viewport: { value: 'desktop1280' } },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await canvas.findByRole('list', { name: m.managed_your_account() });
    const organizations = within(canvas.getByRole('list', { name: m.managed_organizations_title() }).parentElement!);
    await userEvent.click(organizations.getByRole('button', { name: m.managed_next() }));
    await organizations.findByRole('alert');
    await userEvent.click(organizations.getByRole('button', { name: m.settings_managed_restart_list() }));
    await canvas.findByText(m.managed_denied_text());
    await expect(canvas.queryAllByRole('list')).toHaveLength(0);
    await expect(canvas.queryByRole('heading', { level: 4, name: 'Atlas Indexer' })).toBeNull();
    await expect(canvas.queryByRole('button', { name: m.settings_managed_restart_list() })).toBeNull();
    await expect(canvas.getByRole('button', { name: m.settings_retry() })).toBeEnabled();
  },
};

const longIdentity = 'InternationaleLesegemeinschaftFürUnabhängigeVeröffentlichungen'.repeat(3);

/** Supplied bounded data only; these examples add no identity lookup or native evidence. UNRUN. */
function LongInventoryExample({ preparing = false, empty = false, waiting = false, rtl = false, busy = false }) {
  const [io] = useState<ManagedAccountsIO>(() => {
    let initial = true;
    const failed = new Set<string>();
    return async (cursors: ManagedAccountsCursors): Promise<ManagedAccountsResult> => {
      if (waiting && initial) {
        initial = false;
        return managedAccountsFailure(429, { code: 'rate_limited' }, { 'Retry-After': '1' });
      }
      const page = managedAccountsExample();
      page.account.displayName = longIdentity;
      page.account.handle = longIdentity.toLowerCase();
      page.organizations.items[0]!.account.displayName = `Organisation ${longIdentity}`;
      page.organizations.items[0]!.account.handle = longIdentity.toLowerCase();
      page.responsibilities.items[0]!.account!.displayName = `Betreiber ${longIdentity}`;
      if (preparing) page.organizations = { state: 'preparing', items: [], next: null };
      if (empty) {
        page.organizations = { state: 'ready', items: [], next: null };
        page.responsibilities = { items: [], next: null };
      }
      const feed = cursors.organizationsCursor ? 'organizations' : cursors.operatorsCursor ? 'responsibilities' : null;
      if (busy && feed) return new Promise<ManagedAccountsResult>(() => {});
      if (feed && !failed.has(feed)) {
        failed.add(feed);
        return managedAccountsFailure(
          feed === 'organizations' ? 400 : 409,
          {
            code: feed === 'organizations' ? 'invalid_cursor' : 'stale_cursor',
          },
          { 'Retry-After': '1' },
        );
      }
      if (!initial || feed) {
        // A deliberate first-page recovery replaces only the selected feed in the real reader.
        page.organizations = { state: 'ready', items: [], next: 'sparse organization +/=' };
        page.responsibilities = { items: [], next: 'sparse responsibility +/=' };
        if (feed) page[feed].next = null;
      }
      initial = false;
      return { ok: true, page };
    };
  });
  return (
    <div dir={rtl ? 'rtl' : 'ltr'} className="mx-auto min-w-0 max-w-2xl p-4">
      <ManagedAccounts
        viewerId={managedViewer}
        settingsHref={`/${getLocale()}/settings?panel=compact#account`}
        io={io}
      />
    </div>
  );
}

async function assertInventoryGeometry(canvasElement: HTMLElement) {
  const inventory = canvasElement.querySelector<HTMLElement>('[data-slot="managed-accounts"]')!;
  await expect(inventory.scrollWidth).toBeLessThanOrEqual(inventory.clientWidth + 1);
  for (const button of inventory.querySelectorAll<HTMLButtonElement>('button')) {
    const bounds = button.getBoundingClientRect();
    const style = getComputedStyle(button);
    await expect(bounds.height).toBeGreaterThanOrEqual(44);
    await expect(bounds.width).toBeGreaterThanOrEqual(44);
    await expect(style.whiteSpace).toBe('normal');
    await expect(button.scrollWidth).toBeLessThanOrEqual(button.clientWidth + 1);
  }
}

const longRecoveryPlay: NonNullable<Story['play']> = async ({ canvasElement }) => {
  const canvas = within(canvasElement);
  await canvas.findByRole('link', { name: longIdentity });
  const organizations = within(canvas.getByRole('list', { name: m.managed_organizations_title() }).parentElement!);
  const responsibilities = within(canvas.getByRole('list', { name: m.managed_operated_title() }).parentElement!);
  const missing = canvas
    .getByRole('heading', { name: m.settings_managed_identity_unavailable(), level: 4 })
    .closest('li')!;
  await expect(within(missing).queryByRole('link')).toBeNull();
  await expect(canvas.getByText(m.managed_current())).toBeVisible();
  await expect(canvas.getByText(m.managed_reconciling())).toBeVisible();
  await assertInventoryGeometry(canvasElement);
  const more = organizations.getByRole('button', { name: m.managed_next() });
  more.focus();
  await expect(more).toHaveFocus();
  await userEvent.keyboard('{Enter}');
  await organizations.findByRole('alert');
  const restart = organizations.getByRole('button', { name: m.settings_managed_restart_list() });
  await expect(restart).toBeDisabled();
  await userEvent.click(responsibilities.getByRole('button', { name: m.managed_next() }));
  await responsibilities.findByRole('alert');
  await assertInventoryGeometry(canvasElement);
  await waitFor(() => expect(restart).toBeEnabled(), { timeout: 3000 });
  restart.focus();
  await expect(restart).toHaveFocus();
  await userEvent.keyboard(' ');
  await organizations.findByText(m.managed_no_current_page());
  await expect(responsibilities.getByRole('alert')).toBeVisible();
  await waitFor(() => expect(responsibilities.getByRole('button', { name: m.settings_retry() })).toBeEnabled(), {
    timeout: 3000,
  });
  await userEvent.click(responsibilities.getByRole('button', { name: m.settings_retry() }));
  await waitFor(() => expect(responsibilities.queryByRole('alert')).toBeNull());
  await expect(responsibilities.getByText(m.managed_reconciling())).toBeVisible();
  await userEvent.click(organizations.getByRole('button', { name: m.managed_next() }));
  await organizations.findByText(m.managed_no_organizations());
  await expect(organizations.getByRole('button', { name: m.prq_previous() })).toBeEnabled();
  await expect(organizations.getByRole('button', { name: m.settings_managed_restart_list() })).toBeEnabled();
  await assertInventoryGeometry(canvasElement);
};

export const LongLocaleBoundedRecoveryPhone: Story = {
  globals: { locale: 'de', viewport: { value: 'phone390' } },
  render: () => <LongInventoryExample />,
  play: longRecoveryPlay,
};
export const LongLocaleBoundedRecoveryDesktop: Story = {
  ...LongLocaleBoundedRecoveryPhone,
  globals: { locale: 'fr', viewport: { value: 'desktop1280' } },
};
export const LongLocaleBoundedRecoveryRTL: Story = {
  ...LongLocaleBoundedRecoveryPhone,
  render: () => <LongInventoryExample rtl />,
};
export const LongLocalePreparing: Story = {
  globals: { locale: 'de', viewport: { value: 'phone390' } },
  render: () => <LongInventoryExample preparing />,
  play: async ({ canvasElement }) => {
    await within(canvasElement).findByText(m.managed_preparing_text());
    await assertInventoryGeometry(canvasElement);
  },
};
export const LongLocaleEmpty: Story = {
  globals: { locale: 'fr', viewport: { value: 'desktop1280' } },
  render: () => <LongInventoryExample empty />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await canvas.findByText(m.managed_no_organizations());
    await expect(canvas.getByText(m.managed_no_responsibilities())).toBeVisible();
    await expect(canvas.queryByRole('button')).toBeNull();
    await assertInventoryGeometry(canvasElement);
  },
};
export const LongLocaleInventoryWait: Story = {
  globals: { locale: 'de', viewport: { value: 'phone390' } },
  render: () => <LongInventoryExample waiting rtl />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await canvas.findByRole('alert');
    const retry = canvas.getByRole('button', { name: m.settings_retry() });
    await expect(retry).toBeDisabled();
    await expect(canvas.getByRole('status')).toHaveTextContent(m.settings_managed_inventory_retry_wait());
    await assertInventoryGeometry(canvasElement);
    await waitFor(() => expect(retry).toBeEnabled(), { timeout: 3000 });
    await expect(canvas.queryByRole('list')).toBeNull();
    await userEvent.click(retry);
    await canvas.findByRole('link', { name: longIdentity });
  },
};

export const LongLocaleBusy: Story = {
  globals: { locale: 'de', viewport: { value: 'phone390' } },
  render: () => <LongInventoryExample busy rtl />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await canvas.findByRole('list', { name: m.managed_your_account() });
    const organizations = within(canvas.getByRole('list', { name: m.managed_organizations_title() }).parentElement!);
    const responsibilities = within(canvas.getByRole('list', { name: m.managed_operated_title() }).parentElement!);
    await userEvent.click(organizations.getByRole('button', { name: m.managed_next() }));
    await expect(organizations.getByRole('button', { name: m.settings_managed_loading() })).toBeDisabled();
    await expect(responsibilities.getByRole('button', { name: m.managed_next() })).toBeEnabled();
    await assertInventoryGeometry(canvasElement);
  },
};
