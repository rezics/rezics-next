import type { Meta, StoryObj } from '@storybook/react-vite';
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
