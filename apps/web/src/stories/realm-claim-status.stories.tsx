import { useMemo } from 'react';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, within } from 'storybook/test';
import { AppShell } from '../shell/shell';
import { PatternStory } from './page';
import { RealmClaimStatusView } from '../community/realm-claim-status-page';
import { RealmClaimControls } from '../community/realm-claim-controls';
import type { RealmClaimStatus, RealmClaimStatusAdapter, RealmClaimStatusRead } from '../community/realm-claim-status';
import { orphan, receipt, eligible } from './patterns/realm-claim/example';
import { m } from '../paraglide/messages.js';

export type StatusScenario = 'pending' | 'approved' | 'unrelated' | 'unavailable' | 'reload' | 'obsolete' | 'withheld';
export function RealmClaimStatusExample({
  scenario = 'pending',
  receiptRecovery = false,
}: {
  scenario?: StatusScenario;
  receiptRecovery?: boolean;
}) {
  const fixture = useMemo(() => {
    // Declared response examples, not native recordings or proof of approval.
    const claimRequest: RealmClaimStatus = {
      realmId: receipt.realmId,
      requestId: receipt.requestId,
      orphanedAt: receipt.orphanedAt,
      requestedAt: receipt.requestedAt,
      approvedAt: null,
      currentEpisode: true,
      state: 'pending',
      ...(scenario === 'approved' ? { state: 'approved', approvedAt: '2026-10-31T12:34:56.000Z' } : {}),
      ...(scenario === 'obsolete' ? { currentEpisode: false } : {}),
    };
    const source =
      scenario === 'approved'
        ? {
            ...orphan,
            ownershipState: 'owned' as const,
            governanceReadOnly: false,
            orphanedAt: null,
            claimEligibleAt: null,
          }
        : scenario === 'obsolete'
          ? { ...orphan, orphanedAt: '2026-10-30T00:00:00.000Z', claimEligibleAt: '2026-11-29T00:00:00.000Z' }
          : orphan;
    const read: RealmClaimStatusRead =
      scenario === 'unrelated'
        ? { kind: 'denied' }
        : scenario === 'unavailable'
          ? { kind: 'unavailable' }
          : { kind: 'ready', claimRequest, source };
    return {
      read,
      adapter: { read: async () => read },
      claimAdapter: {
        read: async () => eligible,
        mine: async () => read,
        request: async () => {
          throw new Error('Reload recovery must never submit a claim');
        },
      },
    };
  }, [scenario]);
  return scenario === 'reload' && receiptRecovery ? (
    <RealmClaimControls
      realmId={orphan.realmId}
      initial={eligible}
      returnTo={`/realms/${orphan.realmId}`}
      adapter={fixture.claimAdapter}
      load
    />
  ) : (
    <RealmClaimStatusView
      realmId={orphan.realmId}
      requestId={receipt.requestId}
      initial={scenario === 'reload' ? reloading : fixture.read}
      adapter={fixture.adapter}
      load={scenario === 'reload'}
      ready={scenario !== 'withheld'}
    />
  );
}
const reloading: RealmClaimStatusRead = { kind: 'unavailable' };

// Illustrative held foreground read, not a native recording or an automatic retry.
const refreshingAdapter: RealmClaimStatusAdapter = { read: () => new Promise(() => {}) };
export function RealmClaimStatusRefreshExample() {
  return (
    <RealmClaimStatusView
      realmId={orphan.realmId}
      requestId={receipt.requestId}
      initial={reloading}
      adapter={refreshingAdapter}
      load
    />
  );
}

function StatusPage({ scenario = 'pending' }: { scenario?: StatusScenario }) {
  return (
    <PatternStory visitor="Signed In" path={`/realms/${orphan.realmId}/claim-requests/${receipt.requestId}`}>
      <AppShell>
        <RealmClaimStatusExample scenario={scenario} />
      </AppShell>
    </PatternStory>
  );
}
const meta = {
  title: 'Pages/Community/Realm Claim Status',
  component: StatusPage,
  parameters: {
    layout: 'fullscreen',
    docs: {
      description: {
        component:
          'Illustrative supplied receipt states using the actual view and controller; no native approval or browser acceptance is claimed.',
      },
    },
  },
  includeStories: [
    'Pending',
    'Approved',
    'Unrelated',
    'Unavailable',
    'Reload',
    'ObsoleteEpisode',
    'SessionWithheld',
    'ReferenceDetails',
    'Wrapping390',
    'Wrapping1280',
    'RightToLeft',
    'RefreshBusy',
  ],
} satisfies Meta<typeof StatusPage>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Pending: Story = {
  args: { scenario: 'pending' },
  play: async ({ canvasElement }) => {
    const view = within(canvasElement);
    await expect(view.getAllByRole('main')).toHaveLength(1);
    await expect(view.getByRole('heading', { name: m.realm_claim_pending() })).toBeVisible();
    await expect(view.getByRole('link', { name: m.realm_claim_status_back() })).toHaveAttribute(
      'href',
      expect.stringContaining(`/realms/${orphan.realmId}`),
    );
  },
};
export const Approved: Story = { args: { scenario: 'approved' } };
export const Unrelated: Story = { args: { scenario: 'unrelated' } };
export const Unavailable: Story = { args: { scenario: 'unavailable' } };
export const Reload: Story = {
  args: { scenario: 'reload' },
  play: async ({ canvasElement }) => {
    const view = within(canvasElement);
    await expect(await view.findByRole('heading', { name: m.realm_claim_pending() })).toBeVisible();
    await expect(view.queryByRole('button', { name: m.realm_claim_request() })).toBeNull();
  },
};
export const ObsoleteEpisode: Story = { args: { scenario: 'obsolete' } };
export const SessionWithheld: Story = {
  args: { scenario: 'withheld' },
  play: async ({ canvasElement }) => {
    const view = within(canvasElement);
    await expect(view.getByRole('heading', { name: m.realm_claim_status_heading() })).toBeVisible();
    await expect(view.queryByText(receipt.requestId)).toBeNull();
    await expect(view.queryByText('2026-10-31T10:00:00.000Z')).toBeNull();
  },
};
export const ReferenceDetails = {
  args: { scenario: 'pending' },
  play: async ({ canvasElement }) => {
    const view = within(canvasElement);
    const summary = view.getByText(m.realm_status_details_reference());
    await expect(view.getByText(receipt.requestId)).not.toBeVisible();
    await expect(canvasElement.querySelectorAll('time')).toHaveLength(2);
    await userEvent.click(summary);
    await expect(view.getByText(receipt.requestId)).toBeVisible();
    await expect(view.getByRole('button', { name: m.realm_claim_status_check_again() })).toBeEnabled();
    await expect(view.getByRole('link', { name: m.realm_claim_status_back() })).toBeVisible();
  },
} satisfies Story;
export const Wrapping390: Story = {
  args: { scenario: 'pending' },
  globals: { locale: 'de', viewport: { value: 'phone390', isRotated: false } },
  play: ReferenceDetails.play,
};
export const Wrapping1280: Story = {
  args: { scenario: 'approved' },
  globals: { locale: 'de', viewport: { value: 'desktop1280', isRotated: false } },
  play: async ({ canvasElement }) => {
    const view = within(canvasElement);
    await userEvent.click(view.getByText(m.realm_status_details_reference()));
    await expect(view.getByText(receipt.requestId)).toBeVisible();
    await expect(canvasElement.querySelectorAll('time')).toHaveLength(3);
    await expect(view.getByText(m.realm_claim_status_approved_help())).toBeVisible();
  },
};
export const RightToLeft: Story = {
  args: { scenario: 'obsolete' },
  globals: { viewport: { value: 'phone390', isRotated: false } },
  render: (args) => (
    <div dir="rtl">
      <StatusPage {...args} />
    </div>
  ),
  play: ReferenceDetails.play,
};
export const RefreshBusy: Story = {
  render: () => (
    <PatternStory visitor="Signed In" path={`/realms/${orphan.realmId}/claim-requests/${receipt.requestId}`}>
      <AppShell>
        <RealmClaimStatusRefreshExample />
      </AppShell>
    </PatternStory>
  ),
  play: async ({ canvasElement }) => {
    const view = within(canvasElement);
    await expect(await view.findByRole('button', { name: m.realm_claim_status_checking() })).toBeDisabled();
    await expect(view.getByRole('link', { name: m.realm_claim_status_back() })).toBeVisible();
    await expect(view.queryByText(receipt.requestId)).toBeNull();
    await expect(canvasElement.querySelectorAll('time, details')).toHaveLength(0);
  },
};
