import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, within } from 'storybook/test';
import { m } from '../paraglide/messages.js';
import { RealmBansControl } from '../community/realm-bans-control';
import type { BanReadState } from '../community/realm-bans';
import { PatternStory } from './page';
import { AppShell } from '../shell/shell';
import { communityCurrentClaimStory } from './community-current-claim';

const realmId = '01a17a3b-70ea-712a-9ff7-81fc6a9381b6';
const page: BanReadState = {
  state: 'ready',
  page: {
    items: [
      {
        accountId: '01a17a3b-70ea-712a-9ff7-81fc6a9381b7',
        actor: null,
        reason:
          'Repeated disruption after several direct requests to stop. This operational record remains visible after the moderator account is erased.',
        at: '2026-11-02T14:05:00Z',
      },
    ],
    next: null,
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
        story: 'Illustrative installed ban-list shape with an erased moderator; no profile or per-row read is used.',
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

/** Injected observation seam; these fixtures do not publish a native client contract. */
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
            ban: {
              accountId: input.accountId,
              actor: null,
              reason: 'Exact selected episode',
              at: '2026-11-02T14:05:00Z',
            },
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
    const actions = canvas.getAllByRole('button', { name: m.realm_bans_unban(), exact: true });
    await userEvent.click(actions[0]!);
    await expect(canvas.getByRole('group', { name: m.realm_bans_unban_confirm() })).toBeVisible();
    await expect(canvas.getByRole('button', { name: m.realm_bans_confirm(), exact: true })).toBeEnabled();
  },
};
