import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, within } from 'storybook/test';
import { m } from '../paraglide/messages.js';
import { RealmBansControl } from '../community/realm-bans-control';
import type { BanReadState, InstalledRealmBanPage } from '../community/realm-bans';
import { PatternStory } from './page';
import { AppShell } from '../shell/shell';
import { communityCurrentClaimStory } from './community-current-claim';

const realmId = '01a17a3b-70ea-712a-9ff7-81fc6a9381b6';
const accountId = '01a17a3b-70ea-712a-9ff7-81fc6a9381b7';
const moderatorId = '01a17a3b-70ea-712a-9ff7-81fc6a9381b8';
const identity = (id: string, handle: string): InstalledRealmBanPage['items'][number]['account'] => ({
  state: 'available',
  accountId: id,
  displayName: handle,
  handle,
  label: handle,
  destination: `/@${handle}`,
});
const episode = (id: string, erased = false): InstalledRealmBanPage['items'][number] => ({
  accountId: id,
  actor: erased ? null : moderatorId,
  reason: 'Exact selected episode',
  at: '2026-11-02T14:05:00Z',
  account: erased ? { state: 'concealed', accountId: id, label: 'Account', destination: null } : identity(id, 'river'),
  moderator: erased ? null : identity(moderatorId, 'moderator'),
  unban: { state: 'permitted', realmId, accountId: id, observedAt: '2026-11-02T14:05:00Z', membershipRestored: false },
  removal: { state: 'unavailable' },
});
const page: BanReadState = {
  state: 'ready',
  page: {
    items: [episode(accountId), episode('01a17a3b-70ea-712a-9ff7-81fc6a9381b9', true)],
    next: null,
    context: { state: 'available', spaceId: realmId, spaceTitle: 'Quiet Novel Club', realmTitle: 'Reading Realm' },
    viewer: {
      accountId: moderatorId,
      clientId: 'web',
      requestedBy: null,
      authnEpoch: 1,
      unban: {
        state: 'permitted',
        operationId: 'realm.unban',
        action: 'realm:ban',
        resource: { route: 1, id: realmId },
        reauthorizes: true,
      },
    },
    selected: { state: 'not-requested' },
  },
};

const read = async () => page;
const write = async () => ({ ok: false as const, reason: 'unavailable' as const });
const meta = {
  title: 'Patterns/Community/Realm bans/current identity fallback',
  parameters: {
    layout: 'fullscreen',
    docs: {
      description: {
        story:
          'Composed current bans disclose supported identities and destinations while retaining concealed and erased rows. Native advice is an observation; commands reauthorize.',
      },
    },
  },
  beforeEach: communityCurrentClaimStory,
} satisfies Meta;

export default meta;
type Story = StoryObj<typeof meta>;

export const ErasedModeratorKeepsBanVisible: Story = {
  render: () => (
    <PatternStory visitor="Signed In" path="/spaces/quiet-novel-club">
      <AppShell>
        <RealmBansControl realmId={realmId} initial={page} ready read={read} write={write} />
      </AppShell>
    </PatternStory>
  ),
};

export const UnavailableInspection: Story = {
  ...ErasedModeratorKeepsBanVisible,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.type(
      canvas.getByRole('textbox', { name: m.realm_bans_inspect_account() }),
      '01a17a3b-70ea-712a-9ff7-81fc6a938199',
    );
    await userEvent.click(canvas.getByRole('button', { name: m.realm_bans_inspect_action() }));
    await expect(canvas.getByText(m.realm_bans_inspect_unavailable())).toBeVisible();
    await expect(canvas.getByRole('button', { name: m.realm_bans_inspect_retry() })).toBeEnabled();
  },
};

export const DeniedInspection: Story = {
  render: () => (
    <PatternStory visitor="Signed In" path="/spaces/quiet-novel-club">
      <AppShell>
        <RealmBansControl
          realmId={realmId}
          initial={page}
          ready
          read={read}
          write={write}
          inspect={async () => ({ state: 'forbidden' })}
        />
      </AppShell>
    </PatternStory>
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.type(
      canvas.getByRole('textbox', { name: m.realm_bans_inspect_account() }),
      '01a17a3b-70ea-712a-9ff7-81fc6a938199',
    );
    await userEvent.click(canvas.getByRole('button', { name: m.realm_bans_inspect_action() }));
    await expect(canvas.getByText(m.realm_bans_forbidden())).toBeVisible();
    await expect(canvas.getByRole('button', { name: m.realm_bans_inspect_retry() })).toBeEnabled();
  },
};

/** Composed observations use the installed client shape; transport verification remains separate. */
export const CurrentSelectedEpisode: Story = {
  render: () => (
    <PatternStory visitor="Signed In" path="/spaces/quiet-novel-club">
      <AppShell>
        <RealmBansControl
          realmId={realmId}
          initial={page}
          ready
          read={read}
          write={write}
          inspect={async (input) => ({
            state: 'current',
            input,
            ban: episode(input.accountId),
          })}
        />
      </AppShell>
    </PatternStory>
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.type(
      canvas.getByRole('textbox', { name: m.realm_bans_inspect_account() }),
      '01a17a3b-70ea-712a-9ff7-81fc6a938199',
    );
    await userEvent.click(canvas.getByRole('button', { name: m.realm_bans_inspect_action() }));
  },
};

export const SelectedAccountAbsent: Story = {
  render: () => (
    <PatternStory visitor="Signed In" path="/spaces/quiet-novel-club">
      <AppShell>
        <RealmBansControl
          realmId={realmId}
          initial={page}
          ready
          read={read}
          write={write}
          inspect={async (input) => ({ state: 'absent', input })}
        />
      </AppShell>
    </PatternStory>
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.type(
      canvas.getByRole('textbox', { name: m.realm_bans_inspect_account() }),
      '01a17a3b-70ea-712a-9ff7-81fc6a938199',
    );
    await userEvent.click(canvas.getByRole('button', { name: m.realm_bans_inspect_action() }));
  },
};

export const SelectedEpisodeUnbanReview: Story = {
  ...CurrentSelectedEpisode,
  play: async (context) => {
    await CurrentSelectedEpisode.play!(context);
    const canvas = within(context.canvasElement);
    const actions = canvas.getAllByRole('button', { name: m.realm_bans_unban() });
    await userEvent.click(actions[0]!);
    await expect(canvas.getByRole('group', { name: m.realm_bans_unban_confirm() })).toBeVisible();
    await expect(canvas.getByRole('button', { name: m.realm_bans_confirm() })).toBeEnabled();
  },
};

const windowRead = async (cursor?: string): Promise<BanReadState> => ({
  ...page,
  page: {
    ...page.page,
    next: cursor ? null : 'native-opaque-next',
    items: page.page.items.map((ban) => ({ ...ban, reason: cursor ? 'Later window episode' : 'First window episode' })),
  },
});

export const LaterWindowReview: Story = {
  render: () => (
    <PatternStory visitor="Signed In" path="/spaces/quiet-novel-club">
      <AppShell>
        <RealmBansControl
          realmId={realmId}
          initial={{ ...page, page: { ...page.page, next: 'native-opaque-next' } }}
          ready
          read={windowRead}
          write={write}
        />
      </AppShell>
    </PatternStory>
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole('button', { name: m.realm_bans_next() }));
    await userEvent.click(canvas.getByRole('button', { name: m.realm_bans_refresh() }));
    await expect(canvas.getByRole('button', { name: m.realm_bans_previous() })).toBeEnabled();
    await expect(canvas.getAllByText('Later window episode')[0]!).toBeVisible();
  },
};
