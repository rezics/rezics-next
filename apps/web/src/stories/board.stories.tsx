import type { Meta, StoryObj } from '@storybook/react-vite';
import { PageStory, boardReady, pagePaths } from './page';
import {
  conversationBoardId,
  conversationSparseCursor,
  resetConversationExamples,
} from '../kernel/fake/board-conversation';

const meta = {
  title: 'Community/Board',
  id: 'pages-community-board',
  parameters: { layout: 'fullscreen' },
} satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;
export const SignedIn: Story = {
  name: 'Signed In',
  play: boardReady,
  render: () => <PageStory visitor="Signed In" path={pagePaths.board} />,
};
export const SignedOut: Story = {
  name: 'Signed Out',
  play: boardReady,
  render: () => <PageStory visitor="Signed Out" path={pagePaths.board} />,
};

export const PresentationStates: Story = {
  name: 'Long and untitled thread rows',
  play: boardReady,
  render: () => <PageStory visitor="Signed Out" path={pagePaths.board} />,
};

/** Stable manual entries; interaction walks live under Community/Conversation walks. */
export const PopulatedConversations: Story = {
  beforeEach: resetConversationExamples,
  render: () => <PageStory visitor="Signed In" credentialMode="session" path={`/boards/${conversationBoardId}`} />,
};
export const SparseConversationPage: Story = {
  beforeEach: resetConversationExamples,
  render: () => (
    <PageStory
      visitor="Signed In"
      credentialMode="session"
      path={`/boards/${conversationBoardId}?sort=hot&cursor=${encodeURIComponent(conversationSparseCursor)}`}
    />
  ),
};
export const SignedOutConversations: Story = {
  beforeEach: resetConversationExamples,
  render: () => <PageStory visitor="Signed Out" path={`/boards/${conversationBoardId}`} />,
};
