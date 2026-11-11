import type { Meta, StoryObj } from '@storybook/react-vite';
import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Button } from '@rezics/ui/shadcn/button';
import { ManagedAccountDetail } from '../../settings/managed-account-detail';
import { sessionQuery } from '../../session/query';
import { AppShell } from '../../shell/shell';
import { expect, within, userEvent } from 'storybook/test';
import { automation, human, organization, selectManagementStory } from '../../accounts/management/story-api';
import { m } from '../../paraglide/messages.js';
import { PageStory, PatternStory, pageReady } from '../page';
import { settingsContent } from '../../settings/adapters/presentation';

const meta = {
  title: 'Account/Settings managed account detail',
  id: 'pages-account-settings-managed-account-detail',
  parameters: { layout: 'fullscreen' },
} satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;

function Example({
  member = false,
  mode = 'populated',
  accountId = organization.id,
}: {
  member?: boolean;
  mode?: Parameters<typeof selectManagementStory>[0];
  accountId?: string;
}) {
  selectManagementStory(member ? 'member' : mode);
  return <PageStory visitor="Signed In" path={`/settings?managedAccount=${accountId}&view=accounts#account`} />;
}

export const Manager: Story = {
  render: () => <Example />,
  play: async (context) => {
    await pageReady(context);
    const canvas = within(context.canvasElement);
    await canvas.findByText(m.managed_current());
    await expect(canvas.getByText(m.managed_reconciling())).toBeVisible();
    const back = canvas.getByRole('link', { name: m.managed_back() });
    await expect(back.getAttribute('href')).toMatch(/\/settings\?view=accounts#account$/);
    await expect(canvas.getByRole('heading', { name: m.settings_heading(), level: 1 })).toBeVisible();
    for (const name of [human.displayName, automation.displayName]) {
      const row = canvas.getByRole('heading', { level: 4, name }).closest('li')!;
      await expect(row).toHaveRole('listitem');
      await expect(within(row).queryByRole('link')).toBeNull();
      await expect(row.querySelector('[data-content-item-slot="title"]')).toHaveTextContent(name);
    }
  },
};

export const MemberRestricted: Story = {
  render: () => <Example member />,
  play: async (context) => {
    await pageReady(context);
    const canvas = within(context.canvasElement);
    await canvas.findByText(m.managed_holders_denied());
    await expect(canvas.getByText(m.settings_managed_responsibilities_unavailable())).toBeVisible();
    await expect(canvas.queryByText(m.managed_no_responsibilities())).toBeNull();
    await expect(canvas.queryByRole('heading', { level: 4 })).toBeNull();
  },
};

function RecoveringDetail() {
  const client = useQueryClient();
  const [original] = useState(() => {
    selectManagementStory('populated');
    const session = { state: 'signed-in' as const, subject: human.id, csrfToken: 'story-csrf-token' };
    client.setQueryData(sessionQuery.queryKey, session);
    return session;
  });
  return (
    <AppShell>
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
        <Button onClick={() => client.setQueryData(sessionQuery.queryKey, original)}>Restore session</Button>
      </div>
      <ManagedAccountDetail
        accountId={organization.id}
        backHref="/settings#account"
        initials={settingsContent.initials}
        mediaFailure={settingsContent.mediaFailure}
      />
    </AppShell>
  );
}

/** The current management GET and action catalogue are reread after recovery; no old feed is reused. UNRUN. */
export const SessionRecovery: Story = {
  render: () => (
    <PatternStory visitor="Signed In" path={`/settings?managedAccount=${organization.id}#account`}>
      <RecoveringDetail />
    </PatternStory>
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await canvas.findByText(organization.displayName);
    await canvas.findByText(m.managed_current());
    await userEvent.click(canvas.getByRole('button', { name: 'Session unavailable' }));
    await expect(canvas.queryByText(organization.displayName)).toBeNull();
    await expect(canvas.queryByText(m.managed_current())).toBeNull();
    await userEvent.click(canvas.getByRole('button', { name: 'Restore session' }));
    await canvas.findByText(organization.displayName);
    await canvas.findByText(m.managed_current());
  },
};

// Connected settings examples retain the actual read boundary and independently owned action catalogue.
export const LongIdentity: Story = {
  render: () => <Example mode="long" />,
  globals: { locale: 'de' },
  play: async (context) => {
    await pageReady(context);
    const canvas = within(context.canvasElement);
    const target = await canvas.findByRole('region', { name: m.managed_target_title() });
    const details = target.querySelector('details')!;
    await expect(details.open).toBe(false);
    const summary = within(target).getByText(m.lifecycle_identity_details());
    summary.focus();
    await expect(summary).toHaveFocus();
    await userEvent.keyboard('{Enter}');
    await expect(details.open).toBe(true);
    await expect(within(target).getByText(organization.id)).toBeVisible();
    const card = canvasElementCard(context.canvasElement);
    await expect(card.scrollWidth).toBeLessThanOrEqual(card.clientWidth + 1);
    const back = canvas.getByRole('link', { name: m.managed_back() });
    await expect(back.getBoundingClientRect().height).toBeGreaterThanOrEqual(44);
    await userEvent.click(back);
    await canvas.findByRole('link', { name: /^The International Association/ });
  },
};

function canvasElementCard(canvasElement: HTMLElement) {
  return canvasElement
    .querySelector<HTMLElement>('#settings-account-heading')!
    .closest<HTMLElement>('[data-slot="card"]')!;
}

export const UnnamedAccount: Story = {
  render: () => <Example mode="handleless" />,
  play: async (context) => {
    await pageReady(context);
    const target = within(await within(context.canvasElement).findByRole('region', { name: m.managed_target_title() }));
    await expect(target.getByText(m.managed_unnamed())).toBeVisible();
    await expect(target.queryByRole('heading', { name: organization.id })).toBeNull();
  },
};

export const OperatedAccount: Story = {
  render: () => <Example accountId={automation.id} />,
  play: async (context) => {
    await pageReady(context);
    const target = within(await within(context.canvasElement).findByRole('region', { name: m.managed_target_title() }));
    await expect(target.getByText(automation.displayName)).toBeVisible();
    await expect(target.getByText(organization.displayName)).toBeVisible();
    await expect(target.getByText(m.managed_operator_title())).toBeVisible();
  },
};

export const InitialReadRecovery: Story = {
  render: () => <Example mode="unavailable" />,
  globals: { locale: 'fr' },
  play: async (context) => {
    await pageReady(context);
    const canvas = within(context.canvasElement);
    await canvas.findByRole('alert');
    selectManagementStory('populated');
    const retry = canvas.getByRole('button', { name: m.settings_retry() });
    retry.focus();
    await expect(retry).toHaveFocus();
    await userEvent.keyboard('{Enter}');
    await canvas.findByText(organization.displayName);
    await expect(canvas.queryByRole('alert')).toBeNull();
  },
};
