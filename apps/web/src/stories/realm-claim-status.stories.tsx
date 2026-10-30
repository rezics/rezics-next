import { useMemo } from 'react';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, within } from 'storybook/test';
import { AppShell } from '../shell/shell';
import { PatternStory } from './page';
import { RealmClaimStatusView } from '../community/realm-claim-status-page';
import { RealmClaimControls } from '../community/realm-claim-controls';
import type { RealmClaimStatus, RealmClaimStatusRead } from '../community/realm-claim-status';
import { orphan, receipt, eligible } from './patterns/realm-claim/example';
import { m } from '../paraglide/messages.js';

export type StatusScenario = 'pending' | 'approved' | 'unrelated' | 'unavailable' | 'reload' | 'obsolete';
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
    />
  );
}
const reloading: RealmClaimStatusRead = { kind: 'unavailable' };

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
  parameters: { layout: 'fullscreen' },
  includeStories: ['Pending', 'Approved', 'Unrelated', 'Unavailable', 'Reload', 'ObsoleteEpisode'],
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
