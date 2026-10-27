import type { Meta, StoryObj } from '@storybook/react-vite';
import { PageStory, pageReady } from './page';

const meta = { title: 'Pages/Agent', parameters: { layout: 'fullscreen' } } satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;

/** A novelist verified as a catalogue person: the account presents itself, the graph supplies works and roles. */
export const VerifiedPerson: Story = {
  name: 'Verified person',
  play: pageReady,
  render: () => <PageStory visitor="Signed Out" path="/@haruka" />,
};
/** A reader's account: its own agent node, a placeholder avatar and only the activity views. */
export const Reader: Story = {
  name: 'Reader',
  play: pageReady,
  render: () => <PageStory visitor="Signed Out" path="/@mira" />,
};
