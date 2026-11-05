import type { Meta, StoryObj } from '@storybook/react-vite';
import { PageStory } from '../../page';
import { communityCurrentClaimStory } from '../../community-current-claim';
import { chooseSubject, openPicker } from './realm-publication.stories';

const meta = {
  title: 'Pages/Community/Realm Publication',
  parameters: { layout: 'fullscreen' },
  render: () => <PageStory visitor="Signed In" path="/spaces/atlas-member" />,
} satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;

export const Selection: Story = { beforeEach: communityCurrentClaimStory, play: openPicker };
export const Chosen: Story = { beforeEach: communityCurrentClaimStory, play: chooseSubject };
