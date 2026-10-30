import { useMemo } from 'react';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { SpacePage } from '../community/space-page';
import type { SpacePageData } from '../community/space';
import { AppShell } from '../shell/shell';
import space from '../kernel/recorded/space.json';
import realm from '../kernel/recorded/realm.json';
import boards from '../kernel/recorded/realm-boards.json';
import { PatternStory } from './page';
import { lifecycleExampleAdapter } from './patterns/community-lifecycle/example';
import { removeAndRestore } from './patterns/community-lifecycle/community-lifecycle.stories';

const page: SpacePageData = {
  space: { id: space.space.spaceId, title: space.space.title, summary: space.space.summary },
  realm: {
    id: realm.realm.realmId,
    title: realm.realm.title,
    summary: realm.realm.summary,
    visibility: 'public',
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
function Example() {
  const adapter = useMemo(() => lifecycleExampleAdapter('active'), []);
  return (
    <PatternStory visitor="Signed In" path="/spaces/quiet-novel-club">
      <AppShell>
        <SpacePage page={page} lifecycleAdapter={adapter} />
      </AppShell>
    </PatternStory>
  );
}
const meta = {
  title: 'Pages/Community/Container lifecycle',
  parameters: {
    layout: 'fullscreen',
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
export const ManagementJourney: Story = { render: () => <Example />, play: removeAndRestore };
