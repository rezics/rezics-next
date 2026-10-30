import type { Meta, StoryObj } from '@storybook/react-vite';
import { SpacePage } from '../community/space-page';
import { RealmAppearanceSettings } from '../community/realm-presentation-settings';
import { available, configured, fixtureAdapter, readFixtureAppearance } from './patterns/realm-presentation/fixtures';
import { PatternStory } from './page';
import space from '../kernel/recorded/space.json';

const meta = { title: 'Pages/Community/Realm Appearance', parameters: { layout: 'fullscreen' } } satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;
export const Management: Story = {
  loaders: [async () => ({ initial: await readFixtureAppearance() })],
  render: (_, context) => (
    <PatternStory visitor="Signed In" path={`/realms/${configured.realmId}`}>
      <SpacePage
        page={{
          space: { id: space.space.spaceId, title: space.space.title, summary: space.space.summary },
          realm: {
            id: configured.realmId,
            title: configured.title,
            summary: '',
            visibility: 'public',
            boards: [],
            published: [],
            viewer: null,
          },
        }}
        realmAppearance={
          <RealmAppearanceSettings
            realmId={configured.realmId}
            initial={context.loaded.initial}
            adapter={fixtureAdapter(available)}
          />
        }
      />
    </PatternStory>
  ),
};
