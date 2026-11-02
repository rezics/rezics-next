import { useMemo } from 'react';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, within } from 'storybook/test';
import { RealmClaimControls } from '../community/realm-claim-controls';
import type { RealmClaimAdapter, RealmClaimRead } from '../community/realm-claim';
import type { RealmClaimStatus } from '../community/realm-claim-status';
import { localizeHref } from '../paraglide/runtime.js';
import { m } from '../paraglide/messages.js';
import { SpacePage } from '../community/space-page';
import { AppShell } from '../shell/shell';
import { PatternStory } from './page';
import { claimExampleAdapter, eligible, orphan, receipt } from './patterns/realm-claim/example';
import { claimJourney } from './patterns/realm-claim/realm-claim.stories';
import space from '../kernel/recorded/space.json';
import realm from '../kernel/recorded/realm.json';
import boards from '../kernel/recorded/realm-boards.json';

const meta = {
  title: 'Pages/Community/Realm Claim',
  parameters: {
    layout: 'fullscreen',
    docs: {
      description: {
        story:
          'Uses the supplied Realm recording and injected response fixtures for presentation. These examples do not prove native approval or backend acceptance.',
      },
    },
    viewport: {
      options: {
        phone390: { name: 'Phone 390', styles: { width: '390px', height: '844px' } },
        desktop1280: { name: 'Desktop 1280', styles: { width: '1280px', height: '900px' } },
      },
    },
  },
} satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;

function ClaimPanelPage({
  initial = eligible,
  adapter,
  ready = true,
  load = false,
  path = `/spaces/quiet-novel-club`,
}: {
  initial?: RealmClaimRead;
  adapter: RealmClaimAdapter;
  ready?: boolean;
  load?: boolean;
  path?: string;
}) {
  return (
    <PatternStory visitor="Signed In" path={path}>
      <main className="mx-auto w-full min-w-0 max-w-2xl p-4">
        <RealmClaimControls
          realmId={orphan.realmId}
          initial={initial}
          adapter={adapter}
          returnTo="/spaces/quiet-novel-club"
          ready={ready}
          load={load}
        />
      </main>
    </PatternStory>
  );
}

function ClaimScenario({
  scenario = 'journey',
  initial = eligible,
  ready = true,
  load = false,
  path,
}: {
  scenario?: 'journey' | 'uncertain' | 'refused';
  initial?: RealmClaimRead;
  ready?: boolean;
  load?: boolean;
  path?: string;
}) {
  const adapter = useMemo(() => claimExampleAdapter(scenario), [scenario]);
  return (
    <ClaimPanelPage
      initial={initial}
      adapter={adapter}
      ready={ready}
      load={load}
      {...(path === undefined ? {} : { path })}
    />
  );
}

const approvedReceipt: RealmClaimStatus = {
  realmId: receipt.realmId,
  requestId: receipt.requestId,
  state: 'approved',
  orphanedAt: receipt.orphanedAt,
  requestedAt: receipt.requestedAt,
  approvedAt: '2026-10-31T12:34:56.000Z',
  currentEpisode: true,
};

function ApprovedReceiptPage() {
  const adapter = useMemo<RealmClaimAdapter>(
    () => ({
      read: async () => eligible,
      mine: async () => ({ kind: 'ready', source: orphan, claimRequest: approvedReceipt }),
      request: async () => ({ kind: 'unavailable' }),
    }),
    [],
  );
  return <ClaimPanelPage adapter={adapter} load />;
}

function ConflictReviewPage() {
  const adapter = useMemo<RealmClaimAdapter>(
    () => ({
      read: async () => eligible,
      request: async () => ({ kind: 'conflict' }),
    }),
    [],
  );
  return <ClaimPanelPage adapter={adapter} />;
}

function JourneyPage() {
  const adapter = useMemo(() => claimExampleAdapter(), []);
  return (
    <PatternStory visitor="Signed In" path="/spaces/quiet-novel-club">
      <AppShell>
        <SpacePage
          page={{
            space: { id: space.space.spaceId, title: space.space.title, summary: space.space.summary },
            realm: {
              id: orphan.realmId,
              title: realm.realm.title,
              summary: realm.realm.summary,
              visibility: 'public',
              continuity: orphan,
              viewer: null,
              published: [],
              boards: boards.items.map((board) => ({
                id: board.id,
                title: board.title,
                purpose: 'discussion',
                visibility: 'published',
              })),
            },
          }}
          realmClaimAdapter={adapter}
        />
      </AppShell>
    </PatternStory>
  );
}
export const Journey: Story = { render: () => <JourneyPage />, play: claimJourney };

export const Orphaned: Story = {
  render: () => <ClaimScenario />,
  play: async ({ canvasElement }) => {
    const view = within(canvasElement);
    await view.findByRole('heading', { level: 2, name: m.realm_claim_heading() });
    const dates = [...canvasElement.querySelectorAll('time')].map((item) => item.getAttribute('datetime'));
    await expect(dates).toEqual([orphan.orphanedAt, orphan.claimEligibleAt]);
  },
};

export const PendingReceipt: Story = {
  render: () => <ClaimScenario />,
  play: async ({ canvasElement }) => {
    const view = within(canvasElement);
    await userEvent.click(await view.findByRole('button', { name: m.realm_claim_request() }));
    await view.findByText(m.realm_claim_pending());
    await userEvent.click(view.getByText(m.community_management_details_claim_summary()));
    await expect(view.getByText(receipt.requestId)).toBeVisible();
    await expect(view.getByRole('button', { name: m.realm_claim_copy() })).toBeVisible();
    const status = view.getByRole('link', { name: m.realm_claim_status_open() });
    await expect(status).toHaveAttribute(
      'href',
      localizeHref(`/realms/${orphan.realmId}/claim-requests/${receipt.requestId}`),
    );
  },
};

export const ApprovedReceipt: Story = {
  render: () => <ApprovedReceiptPage />,
  play: async ({ canvasElement }) => {
    const view = within(canvasElement);
    await expect(await view.findByText(m.realm_claim_status_approved())).toBeVisible();
    await expect(view.getByRole('link', { name: m.realm_claim_status_open() })).toHaveAttribute(
      'href',
      localizeHref(`/realms/${orphan.realmId}/claim-requests/${receipt.requestId}`),
    );
  },
};

export const UncertainExactRetry: Story = {
  render: () => <ClaimScenario scenario="uncertain" />,
  play: async ({ canvasElement }) => {
    const view = within(canvasElement);
    await userEvent.click(await view.findByRole('button', { name: m.realm_claim_request() }));
    await view.findByRole('alert');
    await expect(view.queryByText(m.realm_claim_pending())).toBeNull();
    await userEvent.click(view.getByRole('button', { name: m.realm_claim_retry() }));
    await view.findByText(m.realm_claim_pending());
  },
};

export const Refused: Story = {
  render: () => <ClaimScenario scenario="refused" />,
  play: async ({ canvasElement }) => {
    const view = within(canvasElement);
    await userEvent.click(await view.findByRole('button', { name: m.realm_claim_request() }));
    await view.findByText(m.realm_claim_refused());
    await expect(view.queryByText(m.realm_claim_pending())).toBeNull();
  },
};

export const ConflictNeedsReview: Story = {
  render: () => <ConflictReviewPage />,
  play: async ({ canvasElement }) => {
    const view = within(canvasElement);
    await userEvent.click(await view.findByRole('button', { name: m.realm_claim_request() }));
    await view.findByRole('alert');
    await userEvent.click(view.getByRole('button', { name: m.realm_claim_refresh() }));
    await userEvent.click(await view.findByRole('button', { name: m.realm_claim_review_current() }));
    await expect(view.getByRole('button', { name: m.realm_claim_request() })).toBeVisible();
  },
};

export const MissingCurrentAdmission: Story = {
  render: () => <ClaimScenario initial={{ kind: 'ready', snapshot: orphan, admission: 'unavailable' }} />,
  play: async ({ canvasElement }) => {
    const view = within(canvasElement);
    await view.findByText(m.realm_claim_admission_unavailable());
    await expect(view.queryByRole('button', { name: m.realm_claim_request() })).toBeNull();
  },
};

export const SignedInWithoutAdmission: Story = {
  render: () => <ClaimScenario initial={{ kind: 'ready', snapshot: orphan, admission: 'denied' }} />,
  play: async ({ canvasElement }) => {
    const view = within(canvasElement);
    await view.findByText(m.realm_claim_refused());
    await expect(view.queryByRole('button', { name: m.realm_claim_request() })).toBeNull();
  },
};
