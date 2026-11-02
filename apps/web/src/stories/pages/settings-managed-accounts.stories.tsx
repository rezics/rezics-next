import type { Meta, StoryObj } from '@storybook/react-vite';
import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Button } from '@rezics/ui/shadcn/button';
import { expect, within, userEvent, waitFor } from 'storybook/test';
import { m } from '../../paraglide/messages.js';
import { sessionQuery } from '../../session/query';
import { SettingsPageView } from '../../settings/settings-page';
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
    await expect(account.getByRole('link', { name: 'Independent Reading Group' })).toHaveAttribute(
      'href',
      expect.stringContaining('managedAccount=019a0000-0000-7000-8000-000000000003'),
    );
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
    await canvas.findByRole('link', { name: 'Independent Reading Group' });
    await userEvent.click(canvas.getByRole('button', { name: 'Session unavailable' }));
    await expect(canvas.queryByRole('link', { name: 'Independent Reading Group' })).toBeNull();
    await userEvent.click(canvas.getByRole('button', { name: 'Restore session' }));
    await canvas.findByRole('link', { name: 'Independent Reading Group' });
  },
};

/** Connected, shell-integrated locale/recovery examples. Plays and geometry are authored, UNRUN. */
const connectedLongRecoveryPlay: NonNullable<Story['play']> = async ({ canvasElement }) => {
  const canvas = within(canvasElement);
  const account = within(await canvas.findByRole('region', { name: m.settings_account_heading() }));
  await account.findByRole('link', { name: longName });
  const organizations = within(account.getByRole('list', { name: m.managed_organizations_title() }).parentElement!);
  const responsibilities = within(account.getByRole('list', { name: m.managed_operated_title() }).parentElement!);
  await userEvent.click(organizations.getByRole('button', { name: m.settings_managed_load_more() }));
  await organizations.findByRole('alert');
  const restart = organizations.getByRole('button', { name: m.settings_managed_restart_list() });
  await expect(restart).toBeDisabled();
  await expect(responsibilities.getByRole('button', { name: m.settings_managed_load_more() })).toBeEnabled();
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
  await expect(responsibilities.getByRole('link', { name: 'Atlas Indexer' })).toBeVisible();
  await userEvent.click(canvas.getByRole('button', { name: 'Session unavailable' }));
  await expect(canvas.queryByRole('link', { name: longName })).toBeNull();
  await expect(canvasElement.querySelector('[data-slot="managed-accounts"]')).toBeNull();
  await userEvent.click(canvas.getByRole('button', { name: 'Restore session' }));
  await canvas.findByRole('link', { name: longName });
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
