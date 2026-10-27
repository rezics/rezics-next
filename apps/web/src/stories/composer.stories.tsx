import type { Meta, StoryObj } from '@storybook/react-vite';
import { PageStory, pagePaths, editReady, newThreadReady, replyReady } from './page';

const meta = { title: 'Pages/Post Editor', parameters: { layout: 'fullscreen' } } satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;
export const NewThread: Story = {
  name: 'New Thread',
  play: newThreadReady,
  render: () => <PageStory visitor="Signed In" path={pagePaths['board-new']} />,
};
export const Reply: Story = {
  name: 'Reply',
  play: replyReady,
  render: () => <PageStory visitor="Signed In" path={pagePaths['thread']} />,
};
export const Edit: Story = {
  name: 'Edit',
  play: editReady,
  render: () => <PageStory visitor="Signed In" path={pagePaths['thread-owned']} />,
};
