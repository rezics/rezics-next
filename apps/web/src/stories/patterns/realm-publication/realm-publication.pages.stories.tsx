import type { Meta, StoryObj } from '@storybook/react-vite';
import { PageStory } from '../../page';
import { chooseSubject, openPicker } from './realm-publication.stories';

const meta = {
  title: 'Pages/Community/Realm Publication',
  parameters: { layout: 'fullscreen' },
  render: () => <PageStory visitor="Signed In" path="/spaces/atlas-member" />,
} satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;

export const Selection: Story = { play: openPicker };
export const Chosen: Story = { play: chooseSubject };
