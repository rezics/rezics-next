import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, fn, userEvent, within } from 'storybook/test';
import { useState } from 'react';
import { RealmParticipationView } from '../community/realm-participation';
import { refreshRealmMembership } from '../community/realm-membership-queries';
import type { MemberState } from '../community/space';
import { FollowControl } from '../library/follow-control';
import { m } from '../paraglide/messages.js';
import { PatternStory } from './page';

const meta = {
  title: 'Community/Realm Participation',
  id: 'patterns-realm-participation',
  component: RealmParticipationView,
  tags: ['autodocs'],
  parameters: {
    docs: {
      description: {
        component:
          'The Space home reuses this membership region. Acceptance remains pending until current members/me and participation reads settle. Four reads exhaust into Check membership, which never resends a command. Browser membership and Board callers bind standing to the current session-cache revision; CSRF/readiness or account changes withhold old actions until a current standing read completes. A retry keeps its original action, key and CSRF token. Protected self-join is unavailable; owners use direct add-member. Space following uses the shared Library control independently. These deterministic behavior fixtures are not native workflow proof. Review the same IDs at phone 390 and desktop 1280 using locale and theme globals.',
      },
    },
  },
  args: { state: 'none', visibility: 'public', onChange: fn(), onRetry: fn() },
  decorators: [
    (Story) => (
      <PatternStory>
        <div className="max-w-2xl space-y-4 p-4">
          <Story />
        </div>
      </PatternStory>
    ),
  ],
} satisfies Meta<typeof RealmParticipationView>;
export default meta;
type Story = StoryObj<typeof meta>;

function Journey({ delayed = false, unavailable = false }: { delayed?: boolean; unavailable?: boolean }) {
  const [state, setState] = useState<MemberState>('none');
  const [refresh, setRefresh] = useState<'checking' | 'pending' | 'unavailable' | null>(null);
  const [target, setTarget] = useState<'member' | 'none'>('member');
  async function check(next: 'member' | 'none', retry = false) {
    setRefresh('checking');
    const result = await refreshRealmMembership(
      async () => {
        if (unavailable) throw new Error('Current read unavailable');
        return { state: delayed && !retry ? 'none' : next, idempotencyKey: 'fixture-key' };
      },
      next,
      { pause: async () => {} },
    );
    if (result.kind === 'settled') {
      setState(result.viewer.state);
      setRefresh(null);
    } else if (result.kind === 'pending' || result.kind === 'unavailable') setRefresh(result.kind);
  }
  return (
    <RealmParticipationView
      state={state}
      visibility="public"
      refresh={refresh}
      onChange={(action) => {
        const next = action === 'join' ? 'member' : 'none';
        setTarget(next);
        setState('pending');
        void check(next);
      }}
      onRetry={() => void check(target, true)}
    />
  );
}

export const JoinAndLeave: Story = {
  render: () => <Journey />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const join = canvas.getByRole('button', { name: m.realm_join() });
    join.focus();
    await userEvent.keyboard('{Enter}');
    const leave = await canvas.findByRole('button', { name: m.realm_leave() });
    await expect(canvas.getByText(m.realm_state_member(), { exact: true })).toBeVisible();
    await userEvent.click(leave);
    await expect(await canvas.findByRole('button', { name: m.realm_join() })).toBeVisible();
  },
};
export const StillPending: Story = {
  render: () => <Journey delayed />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole('button', { name: m.realm_join() }));
    await expect(await canvas.findByText(m.realm_membership_still_pending())).toBeVisible();
    await expect(canvas.getByRole('button', { name: m.realm_membership_retry() })).toBeEnabled();
  },
};
export const ManualRetry: Story = {
  render: () => <Journey delayed />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole('button', { name: m.realm_join() }));
    await userEvent.click(await canvas.findByRole('button', { name: m.realm_membership_retry() }));
    await expect(await canvas.findByRole('button', { name: m.realm_leave() })).toBeVisible();
  },
};
export const ReadUnavailable: Story = {
  render: () => <Journey unavailable />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole('button', { name: m.realm_join() }));
    await expect(await canvas.findByText(m.realm_membership_pending_unavailable())).toBeVisible();
    await userEvent.click(canvas.getByRole('button', { name: m.realm_membership_retry() }));
    await expect(await canvas.findByText(m.realm_membership_pending_unavailable())).toBeVisible();
    await expect(canvas.queryByRole('button', { name: m.realm_leave() })).not.toBeInTheDocument();
  },
};
export const Loading: Story = { args: { state: 'loading' } };
export const Checking: Story = { args: { state: 'pending', refresh: 'checking' } };
export const Unavailable: Story = { args: { state: 'unavailable' } };
export const Member: Story = { args: { state: 'member' } };
export const Protected: Story = {
  args: { visibility: 'protected' },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.queryByRole('button', { name: m.realm_join() })).not.toBeInTheDocument();
    await expect(canvas.getByText(m.realm_protected_admission())).toBeVisible();
  },
};
export const Banned: Story = { args: { state: 'banned' } };
export const NativeDenial: Story = {
  args: { state: 'member', problem: { outcome: 'refused', detail: 'Forbidden: internal Access decision' } },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole('alert')).toHaveTextContent(m.realm_change_failed());
    await expect(canvas.getByRole('alert')).not.toHaveTextContent('Forbidden');
    await expect(canvas.queryByText(m.realm_state_member(), { exact: true })).not.toBeInTheDocument();
    await expect(canvas.queryByRole('button', { name: m.realm_leave() })).not.toBeInTheDocument();
    await expect(canvas.getByRole('button', { name: m.realm_membership_retry() })).toBeEnabled();
  },
};
export const Closed: Story = {
  args: { problem: { outcome: 'closed' } },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole('alert')).toHaveTextContent(m.realm_change_closed());
    await expect(canvas.queryByRole('button', { name: m.realm_join() })).not.toBeInTheDocument();
  },
};
export const IndependentUnfollow: Story = {
  render: () => (
    <>
      <Journey />
      <section aria-label={m.space_follow_label()}>
        <FollowControl
          targetId="space-fixture"
          initial={{ state: 'ready', following: true }}
          ready
          canFollow
          canRemove
          write={async (input) => ({ ok: true, following: input.following })}
        />
      </section>
    </>
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole('button', { name: m.library_follow_unfollow() }));
    await userEvent.click(canvas.getByRole('button', { name: m.realm_join() }));
    await userEvent.click(await canvas.findByRole('button', { name: m.realm_leave() }));
    await userEvent.click(await canvas.findByRole('button', { name: m.realm_join() }));
    await expect(await canvas.findByRole('button', { name: m.realm_leave() })).toBeVisible();
    await expect(canvas.getByRole('button', { name: m.library_follow() })).toBeVisible();
  },
};

// Additional presentation observations; the existing journeys and their oracles stay unchanged.
export const SectionHierarchy: Story = {
  args: { state: 'member', memberLabel: 'A community reading and discussing translated fiction together · '.repeat(6) },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const region = canvas.getByRole('region', { name: m.realm_membership_label() });
    await expect(within(region).getByRole('heading', { level: 2, name: m.realm_membership_label() })).toBeVisible();
    const leave = within(region).getByRole('button', { name: m.realm_leave() });
    await expect(leave).toHaveClass('min-h-11', 'h-auto', 'whitespace-normal');
    leave.focus();
    await expect(leave).toHaveFocus();
    await expect(region.querySelector('details')).toBeNull();
  },
};
