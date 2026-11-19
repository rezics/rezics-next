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
const approvedAt = '2026-10-31T12:34:56.000Z';
const laterEpisode = {
  ...orphan,
  orphanedAt: '2026-11-01T00:00:00.000Z',
  claimEligibleAt: '2026-12-01T00:00:00.000Z',
};

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
      ...(scenario === 'approved' ? { state: 'approved', approvedAt } : {}),
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
          ? laterEpisode
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
  title: 'Community/Realm Claims/Realm Claim Status Page',
  id: 'pages-community-realm-claim-status',
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

async function expectDates(canvas: HTMLElement, expected: (readonly [label: string, date: string])[]) {
  const dates = Array.from(canvas.querySelectorAll('time'));
  await expect(dates.map((date) => [date.closest('dd')?.previousElementSibling?.textContent, date.dateTime])).toEqual(
    expected,
  );
  for (const date of dates) {
    await expect(date).toBeVisible();
    await expect(date).toHaveTextContent(date.dateTime);
    await expect(date).toHaveTextContent('UTC');
    await expect(date.closest('details')).toBeNull();
  }
}

async function expectWithheld(canvas: HTMLElement) {
  await expect(canvas.querySelector('details, time')).toBeNull();
  await expect(canvas).not.toHaveTextContent(receipt.requestId);
}

async function observeReferenceDetails({ canvasElement, args }: Parameters<NonNullable<Story['play']>>[0]) {
  const view = within(canvasElement);
  const summary = view.getByText(m.community_management_details_claim_summary(), { selector: 'summary' });
  const details = summary.closest('details')!;
  const reference = within(details).getByText(receipt.requestId);
  await expect(details.open).toBe(false);
  await expect(reference).not.toBeVisible();
  await expectDates(canvasElement, [
    [m.realm_claim_orphaned_at(), receipt.orphanedAt],
    ...(args.scenario === 'pending' ? [[m.realm_claim_eligible_at(), orphan.claimEligibleAt!] as const] : []),
    [m.realm_claim_requested_at(), receipt.requestedAt],
    ...(args.scenario === 'approved' ? [[m.realm_claim_status_approved_at(), approvedAt] as const] : []),
  ]);
  if (args.scenario === 'obsolete') {
    await expect(view.getByText(m.realm_claim_status_old_episode())).toBeVisible();
  }
  if (args.scenario === 'approved') {
    await expect(view.getByText(m.realm_claim_status_approved_help())).toBeVisible();
  }

  const back = view.getByRole('link', { name: m.realm_claim_status_back() });
  const check = view.getByRole('button', { name: m.realm_claim_status_check_again() });
  await expect(check).toBeEnabled();
  summary.focus();
  await userEvent.tab({ shift: true });
  await expect(back).toHaveFocus();
  await userEvent.tab();
  await expect(summary).toHaveFocus();
  await expect(summary.matches(':focus-visible')).toBe(true);
  await userEvent.click(summary);
  await expect(reference).toBeVisible();
  await expect(summary).toHaveFocus();
  await userEvent.tab();
  await expect(check).toHaveFocus();

  if (matchMedia('(max-width: 767px), (pointer: coarse)').matches) {
    for (const control of [back, summary, check]) {
      control.scrollIntoView({ block: 'center' });
      const bounds = control.getBoundingClientRect();
      const centerX = (bounds.left + bounds.right) / 2;
      const centerY = (bounds.top + bounds.bottom) / 2;
      await expect(bounds.height).toBeLessThan(44);
      await expect(bounds.width).toBeGreaterThanOrEqual(44);
      for (const y of [centerY - 21.5, centerY + 21.5]) {
        await expect(control.contains(control.ownerDocument.elementFromPoint(centerX, y))).toBe(true);
      }
    }
  }
  const page = back.closest('article')!;
  await expect(page.scrollWidth).toBeLessThanOrEqual(page.clientWidth + 1);
}

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
export const Approved: Story = { args: { scenario: 'approved' }, play: observeReferenceDetails };
export const Unrelated: Story = {
  args: { scenario: 'unrelated' },
  play: ({ canvasElement }) => expectWithheld(canvasElement),
};
export const Unavailable: Story = {
  args: { scenario: 'unavailable' },
  play: ({ canvasElement }) => expectWithheld(canvasElement),
};
export const Reload: Story = {
  args: { scenario: 'reload' },
  play: async ({ canvasElement }) => {
    const view = within(canvasElement);
    await expect(await view.findByRole('heading', { name: m.realm_claim_pending() })).toBeVisible();
    await expect(view.queryByRole('button', { name: m.realm_claim_request() })).toBeNull();
  },
};
export const ObsoleteEpisode: Story = { args: { scenario: 'obsolete' }, play: observeReferenceDetails };
export const SessionWithheld: Story = {
  args: { scenario: 'withheld' },
  play: async ({ canvasElement }) => {
    const view = within(canvasElement);
    await expect(view.getByRole('heading', { name: m.realm_claim_status_heading() })).toBeVisible();
    await expectWithheld(canvasElement);
  },
};
export const ReferenceDetails = {
  args: { scenario: 'pending' },
  play: observeReferenceDetails,
} satisfies Story;
export const Wrapping390: Story = {
  args: { scenario: 'pending' },
  globals: { locale: 'de', viewport: { value: 'phone390', isRotated: false } },
  play: ReferenceDetails.play,
};
export const Wrapping1280: Story = {
  args: { scenario: 'approved' },
  globals: { locale: 'de', viewport: { value: 'desktop1280', isRotated: false } },
  play: observeReferenceDetails,
};
export const RightToLeft: Story = {
  args: { scenario: 'obsolete' },
  globals: {},
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
    await expectWithheld(canvasElement);
  },
};
