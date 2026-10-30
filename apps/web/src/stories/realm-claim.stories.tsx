import { useMemo } from 'react';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { SpacePage } from '../community/space-page';
import { AppShell } from '../shell/shell';
import { PatternStory } from './page';
import { claimExampleAdapter, orphan } from './patterns/realm-claim/example';
import { claimJourney } from './patterns/realm-claim/realm-claim.stories';
import space from '../kernel/recorded/space.json';
import realm from '../kernel/recorded/realm.json';
import boards from '../kernel/recorded/realm-boards.json';

const meta = { title: 'Pages/Community/Realm Claim', parameters: { layout: 'fullscreen' } } satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;
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
