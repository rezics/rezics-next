import type { Meta, StoryObj } from '@storybook/react-vite';
import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Button } from '@rezics/ui/shadcn/button';
import { expect, within, userEvent, waitFor } from 'storybook/test';
import { m } from '../../paraglide/messages.js';
import { sessionQuery } from '../../session/query';
import { SettingsPageView } from '../../settings/settings-page';
import { ManagedAccountsSection } from '../../settings/managed-accounts';
import { AppShell } from '../../shell/shell';
import { PatternStory } from '../page';
import { managedAccountsFailure, type ManagedAccountsIO } from '../../settings/managed-accounts-read';
import { managedAccountsExample, managedAccountsIO, managedViewer } from '../patterns/managed-accounts.fixtures';

const longName = 'Internationale unabhängige Lesegemeinschaft '.repeat(6).trim();

function longRecoveryIO(): ManagedAccountsIO {
  const failed = new Set<string>();
  let reads = 0;
  return async (cursors) => {
    const page = managedAccountsExample();
    page.account.displayName = longName;
    page.account.handle = 'ununterbrochenerÖffentlicherKontoname'.repeat(8);
    page.organizations.items[0]!.account.displayName = `Organisation ${longName}`;
    const feed = cursors.organizationsCursor ? 'organizations' : cursors.operatorsCursor ? 'responsibilities' : null;
    if (feed && !failed.has(feed)) {
      failed.add(feed);
      return managedAccountsFailure(409, { code: 'stale_cursor' }, { 'Retry-After': '1' });
    }
    if (feed || reads > 0) {
      page.organizations = { state: 'ready', items: [], next: null };
      page.responsibilities = { items: [], next: null };
    }
    reads++;
    return { ok: true, page };
  };
}

function SettingsExample({ recovery = false, longRecovery = false }: { recovery?: boolean; longRecovery?: boolean }) {
  const client = useQueryClient();
  const [io] = useState(() => {
    // This page's illustrative inventory and browser session share one immutable viewer.
    client.setQueryData(sessionQuery.queryKey, {
      state: 'signed-in',
      csrfToken: 'story-csrf-token',
      subject: managedViewer,
    });
    return longRecovery ? longRecoveryIO() : managedAccountsIO();
  });
  return (
    <AppShell>
      {recovery ? (
        <div className="flex gap-2">
          <Button
            onClick={() =>
              client
                .getQueryCache()
                .find({ queryKey: sessionQuery.queryKey, exact: true })
                ?.setState({ status: 'error', error: new Error('Session unavailable') })
            }
          >
            Session unavailable
          </Button>
          <Button
            onClick={() =>
              client.setQueryData(sessionQuery.queryKey, {
                state: 'signed-in',
                csrfToken: 'story-csrf-token',
                subject: managedViewer,
              })
            }
          >
            Restore session
          </Button>
        </div>
      ) : null}
      <SettingsPageView
        page={{
          signedIn: true,
          accountId: managedViewer,
          preferences: { spoilerLevel: 1, suitability: 'blur', version: 1 },
          notifications: { reply: true, mention: true },
          csrfToken: 'story-csrf-token',
          securityHref: 'https://auth.example.test/security',
        }}
        csrfToken="story-csrf-token"
        managedAccountsIO={io}
      />
    </AppShell>
  );
}
const meta = {
  title: 'Pages/Account/Settings managed accounts',
  parameters: {
    layout: 'fullscreen',
    docs: {
      description: {
        component:
          'Whole settings page in the existing app shell, using the actual inventory component with explicitly illustrative IO. Review using the shared phone390 and desktop1280 globals; native, browser and visual evidence is deferred.',
      },
    },
  },
} satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  render: () => (
    <PatternStory visitor="Signed In" path="/settings?panel=compact#account">
      <SettingsExample />
    </PatternStory>
  ),
  play: async ({ canvasElement }) => {
    const account = within(await within(canvasElement).findByRole('region', { name: m.settings_account_heading() }));
    await account.findByRole('list', { name: m.managed_your_account() });
    await expect(account.getByRole('link', { name: m.account_security_settings() })).toBeVisible();
    await expect(account.getByRole('heading', { level: 4, name: 'Independent Reading Group' })).toBeVisible();
    await expect(account.queryByRole('link', { name: 'Independent Reading Group' })).toBeNull();
    await expect(account.getByText(m.settings_managed_navigation_unavailable())).toBeVisible();
    await expect(account.getByText(m.managed_member())).toBeVisible();
    await expect(account.getByText(m.managed_reconciling())).toBeVisible();
  },
};

/** Recovery from a retained-data session error uses the actual connected inventory with illustrative IO. UNRUN. */
export const SessionRecovery: Story = {
  render: () => (
    <PatternStory visitor="Signed In" path="/settings?panel=compact#account">
      <SettingsExample recovery />
    </PatternStory>
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await canvas.findByRole('heading', { level: 4, name: 'Independent Reading Group' });
    await userEvent.click(canvas.getByRole('button', { name: 'Session unavailable' }));
    await expect(canvas.queryByRole('heading', { level: 4, name: 'Independent Reading Group' })).toBeNull();
    await userEvent.click(canvas.getByRole('button', { name: 'Restore session' }));
    await canvas.findByRole('heading', { level: 4, name: 'Independent Reading Group' });
  },
};

/** Connected, shell-integrated locale/recovery examples. Plays and geometry are authored, UNRUN. */
const connectedLongRecoveryPlay: NonNullable<Story['play']> = async ({ canvasElement }) => {
  const canvas = within(canvasElement);
  const account = within(await canvas.findByRole('region', { name: m.settings_account_heading() }));
  await account.findByRole('heading', { level: 4, name: longName });
  const organizations = within(account.getByRole('list', { name: m.managed_organizations_title() }).parentElement!);
  const responsibilities = within(account.getByRole('list', { name: m.managed_operated_title() }).parentElement!);
  await userEvent.click(organizations.getByRole('button', { name: m.managed_next() }));
  await organizations.findByRole('alert');
  const restart = organizations.getByRole('button', { name: m.settings_managed_restart_list() });
  await expect(restart).toBeDisabled();
  await expect(responsibilities.getByRole('button', { name: m.managed_next() })).toBeEnabled();
  for (const button of canvasElement.querySelectorAll<HTMLButtonElement>('[data-slot="managed-accounts"] button')) {
    await expect(button.getBoundingClientRect().height).toBeGreaterThanOrEqual(44);
    await expect(button.getBoundingClientRect().width).toBeGreaterThanOrEqual(44);
    await expect(getComputedStyle(button).whiteSpace).toBe('normal');
    await expect(button.scrollWidth).toBeLessThanOrEqual(button.clientWidth + 1);
  }
  const inventory = canvasElement.querySelector<HTMLElement>('[data-slot="managed-accounts"]')!;
  await expect(inventory.scrollWidth).toBeLessThanOrEqual(inventory.clientWidth + 1);
  await waitFor(() => expect(restart).toBeEnabled(), { timeout: 3000 });
  restart.focus();
  await expect(restart).toHaveFocus();
  await userEvent.keyboard('{Enter}');
  await organizations.findByText(m.managed_no_organizations());
  await expect(responsibilities.getByRole('heading', { level: 4, name: 'Atlas Indexer' })).toBeVisible();
  await userEvent.click(canvas.getByRole('button', { name: 'Session unavailable' }));
  await expect(canvas.queryByRole('heading', { level: 4, name: longName })).toBeNull();
  await expect(canvasElement.querySelector('[data-slot="managed-accounts"]')).toBeNull();
  await userEvent.click(canvas.getByRole('button', { name: 'Restore session' }));
  await canvas.findByRole('heading', { level: 4, name: longName });
};

export const LongLocaleBoundedRecoveryPhone: Story = {
  globals: { locale: 'de', viewport: { value: 'phone390' } },
  render: () => (
    <PatternStory visitor="Signed In" path="/settings?panel=compact#account">
      <SettingsExample recovery longRecovery />
    </PatternStory>
  ),
  play: connectedLongRecoveryPlay,
};
export const LongLocaleBoundedRecoveryDesktop: Story = {
  ...LongLocaleBoundedRecoveryPhone,
  globals: { locale: 'fr', viewport: { value: 'desktop1280' } },
};
export const LongLocaleBoundedRecoveryRTL: Story = {
  ...LongLocaleBoundedRecoveryPhone,
  render: () => (
    <PatternStory visitor="Signed In" path="/settings?panel=compact#account">
      <div dir="rtl">
        <SettingsExample recovery longRecovery />
      </div>
    </PatternStory>
  ),
};

// These supplied names and failure sequences are local contract-shaped examples: recorded routes do not
// provide the required long-name/recovery combinations. They establish no native or physical-growth evidence.
const longAccountName =
  'Independent Readers, Translators and Community Archivists — 読書会 — مجموعة القراءة — ' +
  'ReadingTogether'.repeat(10);
const longHandle = 'readers-and-translators-independent-reading-group';
function longInventory() {
  const page = managedAccountsExample();
  page.organizations.items = [page.organizations.items[0]!];
  page.organizations.items[0]!.account.displayName = longAccountName;
  page.organizations.items[0]!.account.handle = longHandle;
  page.responsibilities.items[0]!.account!.displayName = null;
  page.responsibilities.items[0]!.account!.handle = longHandle;
  return page;
}
type InventoryScenario = 'recovery' | 'preparing' | 'inventory';
function inventoryJourney(scenario: InventoryScenario): ManagedAccountsIO {
  let initialReads = 0;
  let organizations = 0;
  let responsibilities = 0;
  return async (cursors) => {
    const page = longInventory();
    if (scenario === 'preparing') {
      page.organizations =
        cursors.organizationsCursor !== undefined
          ? { state: 'ready', items: [], next: null }
          : initialReads++ === 0
            ? { state: 'preparing', items: [], next: null }
            : { state: 'ready', items: [], next: 'illustrative sparse organization +/=' };
      page.responsibilities = {
        items: [],
        next: cursors.operatorsCursor ? null : 'illustrative sparse responsibility +/=',
      };
      return { ok: true, page };
    }
    if (cursors.organizationsCursor) {
      organizations++;
      return managedAccountsFailure(
        organizations === 1 ? 409 : 400,
        { code: 'stale_cursor' },
        organizations === 1 ? { 'Retry-After': '1' } : undefined,
      );
    }
    if (cursors.operatorsCursor) {
      if (responsibilities++ === 0)
        return managedAccountsFailure(503, { code: 'dependency_unavailable' }, { 'Retry-After': '1' });
      page.responsibilities = { items: [], next: null };
      return { ok: true, page };
    }
    if (initialReads++ === 0 && scenario === 'inventory')
      return managedAccountsFailure(503, { code: 'dependency_unavailable' }, { 'Retry-After': '1' });
    if (initialReads > 1 || scenario === 'inventory') page.organizations.next = null;
    return { ok: true, page };
  };
}

function InventoryJourneyExample({ scenario, multiple = false }: { scenario: InventoryScenario; multiple?: boolean }) {
  const client = useQueryClient();
  const [sources] = useState(() => {
    client.setQueryData(sessionQuery.queryKey, {
      state: 'signed-in',
      csrfToken: 'story-csrf-token',
      subject: managedViewer,
    });
    return [inventoryJourney(scenario), inventoryJourney('recovery')] as const;
  });
  return (
    <AppShell>
      <SettingsPageView
        page={{
          signedIn: true,
          accountId: managedViewer,
          preferences: { spoilerLevel: 1, suitability: 'blur', version: 1 },
          notifications: { reply: true, mention: true },
          csrfToken: 'story-csrf-token',
          securityHref: 'https://auth.example.test/security',
        }}
        csrfToken="story-csrf-token"
        managedAccountsIO={sources[0]}
      />
      {multiple ? (
        <div dir="rtl">
          <ManagedAccountsSection io={sources[1]} />
        </div>
      ) : null}
    </AppShell>
  );
}

async function inventoryGeometry(inventory: HTMLElement) {
  const view = inventory.ownerDocument.defaultView!;
  for (const control of inventory.querySelectorAll<HTMLElement>('a, button')) {
    await expect(control.getBoundingClientRect().height).toBeGreaterThanOrEqual(44);
    await expect(view.getComputedStyle(control).whiteSpace).not.toBe('nowrap');
  }
  for (const heading of inventory.querySelectorAll<HTMLElement>('[data-content-item-slot="title"]')) {
    await expect(view.getComputedStyle(heading).getPropertyValue('-webkit-line-clamp')).not.toMatch(/^[12]$/);
    await expect(heading.scrollWidth).toBeLessThanOrEqual(heading.clientWidth + 1);
  }
  await expect(inventory.scrollWidth).toBeLessThanOrEqual(inventory.clientWidth + 1);
  const document = inventory.ownerDocument;
  await expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(document.documentElement.clientWidth + 1);
}

/** Keyboard and retained recovery through actual feed controls; shared phone390/desktop1280 globals. UNRUN. */
export const IndependentRecovery: Story = {
  render: () => (
    <PatternStory visitor="Signed In" path="/settings?panel=compact#account">
      <InventoryJourneyExample scenario="recovery" />
    </PatternStory>
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const organizations = await canvas.findByRole('region', { name: m.managed_organizations_title() });
    const responsibilities = canvas.getByRole('region', { name: m.managed_operated_title() });
    const org = within(organizations);
    const resp = within(responsibilities);
    const inventory = organizations.closest<HTMLElement>('[data-slot="managed-accounts"]')!;
    const identity = org.getByRole('heading', { level: 4, name: longAccountName });
    await expect(identity).toBeVisible();
    await expect(resp.getByRole('heading', { level: 4, name: `@${longHandle}` })).toBeVisible();
    const unavailable = resp.getByRole('heading', { name: m.settings_managed_identity_unavailable() }).closest('li')!;
    await expect(within(unavailable).queryByRole('link')).toBeNull();
    await inventoryGeometry(inventory);
    const more = org.getByRole('button', { name: m.managed_next() });
    more.focus();
    await expect(more).toHaveFocus();
    await expect(more.ownerDocument.defaultView!.getComputedStyle(more).boxShadow).not.toBe('none');
    await expect(more).toHaveAccessibleDescription(m.managed_organizations_title());
    await userEvent.keyboard('{Enter}');
    const retry = await org.findByRole('button', { name: m.settings_retry() });
    const firstPage = org.getByRole('button', { name: m.settings_managed_restart_list() });
    await expect(retry).toBeDisabled();
    await expect(firstPage).toBeDisabled();
    await expect(org.getByRole('status', { name: m.managed_organizations_title() })).toHaveTextContent(
      m.settings_managed_organizations_retry_wait(),
    );
    await expect(resp.queryByRole('alert')).toBeNull();
    await expect(org.getByRole('heading', { level: 4, name: longAccountName })).toBe(identity);
    await inventoryGeometry(inventory);
    await waitFor(() => expect(retry).toBeEnabled(), { timeout: 3000 });
    retry.focus();
    await userEvent.keyboard('{Enter}');
    await waitFor(() => expect(firstPage).toBeEnabled());
    retry.focus();
    await userEvent.tab();
    await expect(firstPage).toHaveFocus();
    await userEvent.keyboard('{Enter}');
    await waitFor(() => expect(org.queryByRole('alert')).toBeNull());
    await expect(org.queryByRole('button')).toBeNull();
    await expect(resp.getByRole('button', { name: m.managed_next() })).toBeEnabled();
    await userEvent.click(resp.getByRole('button', { name: m.managed_next() }));
    const responsibilityRetry = await resp.findByRole('button', { name: m.settings_retry() });
    await expect(responsibilityRetry).toBeDisabled();
    await expect(org.queryByRole('heading', { level: 4, name: longAccountName })).toBeNull();
    await expect(resp.getByRole('group', { name: m.managed_operated_title() })).toBeVisible();
    await expect(responsibilityRetry).toHaveAccessibleDescription(
      `${m.managed_operated_title()} ${m.managed_unavailable_text()} ${m.settings_managed_responsibilities_retry_wait()}`,
    );
    await waitFor(() => expect(responsibilityRetry).toBeEnabled(), { timeout: 3000 });
    responsibilityRetry.focus();
    await userEvent.keyboard('{Enter}');
    await waitFor(() => expect(resp.queryByRole('alert')).toBeNull());
    await expect(resp.queryByRole('button')).toBeNull();
    await expect(unavailable).toBeVisible();
    await inventoryGeometry(inventory);
  },
};

/** Preparing and empty-but-continuable pages use explicit, independent real controls. UNRUN. */
export const PreparingAndSparse: Story = {
  render: () => (
    <PatternStory visitor="Signed In" path="/settings?panel=compact#account">
      <InventoryJourneyExample scenario="preparing" />
    </PatternStory>
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const organizations = await canvas.findByRole('region', { name: m.managed_organizations_title() });
    const responsibilities = canvas.getByRole('region', { name: m.managed_operated_title() });
    const org = within(organizations);
    const resp = within(responsibilities);
    await expect(org.getByRole('status', { name: m.managed_organizations_title() })).toHaveTextContent(
      m.managed_preparing_text(),
    );
    await expect(resp.getByText(m.settings_managed_no_responsibilities_page())).toBeVisible();
    await userEvent.click(resp.getByRole('button', { name: m.managed_next() }));
    await resp.findByText(m.managed_no_responsibilities());
    await expect(org.getByRole('button', { name: m.settings_retry() })).toBeEnabled();
    await userEvent.click(org.getByRole('button', { name: m.settings_retry() }));
    await org.findByText(m.managed_no_current_page());
    const more = org.getByRole('button', { name: m.managed_next() });
    more.focus();
    await userEvent.keyboard('{Enter}');
    await org.findByText(m.managed_no_organizations());
    await expect(org.queryByRole('button')).toBeNull();
    await expect(resp.queryByRole('button')).toBeNull();
    await inventoryGeometry(organizations.closest<HTMLElement>('[data-slot="managed-accounts"]')!);
  },
};

/** Inventory retry has its own heading, cooldown and operation; it never claims an empty success. UNRUN. */
export const InventoryRecovery: Story = {
  render: () => (
    <PatternStory visitor="Signed In" path="/settings?panel=compact#account">
      <InventoryJourneyExample scenario="inventory" />
    </PatternStory>
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const viewer = within(await canvas.findByRole('region', { name: m.managed_your_account() }));
    const retry = await viewer.findByRole('button', { name: m.settings_retry() });
    await expect(retry).toBeDisabled();
    await expect(viewer.getByRole('status', { name: m.managed_your_account() })).toHaveTextContent(
      m.settings_managed_inventory_retry_wait(),
    );
    await expect(canvas.queryByRole('region', { name: m.managed_organizations_title() })).toBeNull();
    await waitFor(() => expect(retry).toBeEnabled(), { timeout: 3000 });
    retry.focus();
    await userEvent.keyboard('{Enter}');
    const organizations = await canvas.findByRole('region', { name: m.managed_organizations_title() });
    await expect(within(organizations).getByRole('heading', { level: 4, name: longAccountName })).toBeVisible();
    await inventoryGeometry(organizations.closest<HTMLElement>('[data-slot="managed-accounts"]')!);
  },
};

/** Two connected inventories, including RTL text flow, keep all heading/control references local. UNRUN. */
export const IndependentMounts: Story = {
  render: () => (
    <PatternStory visitor="Signed In" path="/settings?panel=compact#account">
      <InventoryJourneyExample scenario="recovery" multiple />
    </PatternStory>
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await waitFor(() => expect(canvas.getAllByRole('heading', { level: 4, name: longAccountName })).toHaveLength(2));
    const inventories = canvasElement.querySelectorAll<HTMLElement>('[data-slot="managed-accounts"]');
    await expect(inventories).toHaveLength(2);
    const ids = [...canvasElement.querySelectorAll('[id]')].map((node) => node.id);
    await expect(new Set(ids).size).toBe(ids.length);
    for (const inventory of inventories) {
      for (const name of [m.managed_your_account(), m.managed_organizations_title(), m.managed_operated_title()]) {
        const region = within(inventory).getByRole('region', { name });
        const heading = within(region).getByRole('heading', { level: 3, name });
        await expect(region).toHaveAttribute('aria-labelledby', heading.id);
        for (const group of within(region).queryAllByRole('group'))
          await expect(group).toHaveAttribute('aria-labelledby', heading.id);
      }
      await inventoryGeometry(inventory);
    }
    const rtl = inventories[1]!;
    await expect(rtl.ownerDocument.defaultView!.getComputedStyle(rtl).direction).toBe('rtl');
    const org = within(within(rtl).getByRole('region', { name: m.managed_organizations_title() }));
    await userEvent.click(org.getByRole('button', { name: m.managed_next() }));
    await org.findByRole('button', { name: m.settings_retry() });
    await expect(within(inventories[0]!).queryByRole('alert')).toBeNull();
    await expect(within(inventories[0]!).getByRole('heading', { level: 4, name: longAccountName })).toBeVisible();
    await inventoryGeometry(rtl);
  },
};
