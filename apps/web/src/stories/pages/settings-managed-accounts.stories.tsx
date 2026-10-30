import type { Meta, StoryObj } from '@storybook/react-vite';
import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { expect, within } from 'storybook/test';
import { m } from '../../paraglide/messages.js';
import { sessionQuery } from '../../session/query';
import { SettingsPageView } from '../../settings/settings-page';
import { AppShell } from '../../shell/shell';
import { PatternStory } from '../page';
import { managedAccountsIO, managedViewer } from '../patterns/managed-accounts.fixtures';

function SettingsExample() {
  const client = useQueryClient();
  const [io] = useState(() => {
    // This page's illustrative inventory and browser session share one immutable viewer.
    client.setQueryData(sessionQuery.queryKey, {
      state: 'signed-in',
      csrfToken: 'story-csrf-token',
      subject: managedViewer,
    });
    return managedAccountsIO();
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
