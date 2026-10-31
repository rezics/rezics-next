import type { Meta, StoryObj } from '@storybook/react-vite';
import { SpacePage } from '../community/space-page';
import type { SpacePageData } from '../community/space';
import { AppShell } from '../shell/shell';
import space from '../kernel/recorded/space.json';
import realm from '../kernel/recorded/realm.json';
import boards from '../kernel/recorded/realm-boards.json';
import { PatternStory } from './page';
import { RealmBansExample } from './realm-bans/example';
import { banAndUnban } from './realm-bans/realm-bans.stories';
import { communityCurrentClaim, communityCurrentClaimStory } from './community-current-claim';

const meta = { title: 'Pages/Community/Realm bans', parameters: { layout: 'fullscreen' } } satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;
const page: SpacePageData = {
  space: { id: space.space.spaceId, title: space.space.title, summary: space.space.summary },
  realm: {
    id: realm.realm.realmId,
    title: realm.realm.title,
    summary: realm.realm.summary,
    visibility: 'public',
    continuity: communityCurrentClaim,
    viewer: null,
    published: [],
    boards: boards.items.map((board) => ({
      id: board.id,
      title: board.title,
      purpose: 'discussion',
      visibility: 'published',
    })),
  },
};

export const ManagementJourney: Story = {
  beforeEach: communityCurrentClaimStory,
  render: () => (
    <PatternStory visitor="Signed In" path="/spaces/quiet-novel-club">
      <AppShell>
        <SpacePage page={page} realmManagement={<RealmBansExample scenario="empty" />} />
      </AppShell>
    </PatternStory>
  ),
  play: banAndUnban,
};
