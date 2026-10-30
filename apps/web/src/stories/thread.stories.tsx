import type { Meta, StoryObj } from '@storybook/react-vite';
import { PageStory, pagePaths, pageReady, threadHistoryReady, threadPolishReady, threadReady } from './page';

const meta = { title: 'Pages/Community/Thread', parameters: { layout: 'fullscreen' } } satisfies Meta;
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

export const EditedAndUneditedPosts: Story = {
  name: 'Edited and unedited posts',
  play: threadPolishReady,
  render: () => <PageStory visitor="Signed Out" path={pagePaths.thread} />,
};

/** The post history is replayed from current native thread, revision, board and account API responses. */
export const RevisionHistory: Story = {
  name: 'Revision history',
  play: threadHistoryReady,
  render: () => <PageStory visitor="Signed Out" path={pagePaths['thread-history']} />,
};

/** A thread whose author is a deleted organization: the byline names no one and keeps the neutral avatar. */
export const DeletedOrganization: Story = {
  name: 'Deleted Organization',
  play: pageReady,
  render: () => <PageStory visitor="Signed Out" path={pagePaths['thread-deleted-organization']} />,
};
