import type { Meta, StoryObj } from '@storybook/react-vite';
import { PageStory, pagePaths, threadReady } from './page';

const meta = { title: 'Pages/Thread', parameters: { layout: 'fullscreen' } } satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;
export const SignedIn: Story = {
  name: 'Signed In',
  play: threadReady,
  render: () => <PageStory visitor="Signed In" path={pagePaths.thread} />,
};
export const SignedOut: Story = {
  name: 'Signed Out',
  play: threadReady,
  render: () => <PageStory visitor="Signed Out" path={pagePaths.thread} />,
};
