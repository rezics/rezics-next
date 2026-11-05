import type { Meta, StoryObj } from '@storybook/react-vite';
import agentPageRecording from '../kernel/recorded/agent-page.json';
import agentPageReaderRecording from '../kernel/recorded/agent-page-reader.json';
import { PageStory, pageReady } from './page';

const meta = { title: 'Pages/Community/Agent', parameters: { layout: 'fullscreen' } } satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;

/** A novelist verified as a catalogue person: the account presents itself, the graph supplies works and roles. */
export const VerifiedPerson: Story = {
  name: 'Verified person',
  play: pageReady,
  render: () => <PageStory visitor="Signed Out" path={`/@${agentPageRecording.handle}`} />,
};
export const VerifiedPersonSignedIn: Story = {
  name: 'Verified person, signed in',
  play: pageReady,
  render: () => <PageStory visitor="Signed In" path={`/@${agentPageRecording.handle}`} />,
};
/** Automated software with its operator linked from the account's public identity. */
export const Automated: Story = {
  name: 'Automated agent',
  play: pageReady,
  render: () => <PageStory visitor="Signed Out" path="/@helper" />,
};
/** A reader's account: its own agent node, a placeholder avatar and only the activity views. */
export const Reader: Story = {
  name: 'Reader',
  play: pageReady,
  render: () => <PageStory visitor="Signed Out" path={`/@${agentPageReaderRecording.handle}`} />,
};
export const ReaderSignedIn: Story = {
  name: 'Reader, signed in',
  play: pageReady,
  render: () => <PageStory visitor="Signed In" path={`/@${agentPageReaderRecording.handle}`} />,
};
