import type { Meta, StoryObj } from '@storybook/react-vite';
import subjectRecording from '../kernel/recorded/subject.json';
import { PageStory, pageReady } from './page';

const meta = { title: 'Pages/Subject Relations', parameters: { layout: 'fullscreen' } } satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;

const path = `/subjects/${subjectRecording.subject.id}/relations`;

export const SignedIn: Story = {
  name: 'Signed In',
  play: pageReady,
  render: () => <PageStory visitor="Signed In" path={path} />,
};
export const SignedOut: Story = {
  name: 'Signed Out',
  play: pageReady,
  render: () => <PageStory visitor="Signed Out" path={path} />,
};
