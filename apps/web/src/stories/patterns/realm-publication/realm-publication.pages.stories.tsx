import type { Meta, StoryObj } from '@storybook/react-vite';
import { PageStory } from '../../page';
import { publicationSpaceAddress } from './realm-publication';
import { chooseSubject, openPicker } from './realm-publication.stories';

const meta = {
  title: 'Community/Realm Publication/Realm Publication Page',
  id: 'pages-community-realm-publication',
  parameters: { layout: 'fullscreen' },
  render: () => <PageStory visitor="Signed In" path={`/spaces/${publicationSpaceAddress}`} />,
} satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;

export const Selection: Story = { play: openPicker };
export const Chosen: Story = { play: chooseSubject };
