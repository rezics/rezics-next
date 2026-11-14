import type { Meta, StoryObj } from '@storybook/react-vite';
import {
  conversationDiscussion,
  conversationFailure,
  conversationLong,
  conversationReview,
  conversationThreadCursor,
  resetConversationExamples,
} from '../kernel/fake/board-conversation';
import { threadHref } from '../threads/thread-href';
import { PageStory } from './page';

const meta = {
  title: 'Community/Conversation reading',
  id: 'pages-community-thread-conversation',
  component: PageStory,
  beforeEach: resetConversationExamples,
  parameters: {
    layout: 'fullscreen',
    docs: {
      description: {
        component:
          'Manual review entries use the generated application route tree and supplied native-shaped pages. Navigation, reply, watch and inspection are left to the reviewer. Automated interaction walks are under Community/Conversation walks. Runtime, native and visual acceptance is deferred to the verifier.',
      },
    },
  },
  args: { visitor: 'Signed In', credentialMode: 'session', path: threadHref(conversationDiscussion) },
} satisfies Meta<typeof PageStory>;
export default meta;
type Story = StoryObj<typeof meta>;

export const PopulatedDiscussion: Story = {};
export const ReviewCitation: Story = { args: { path: threadHref(conversationReview) } };
export const LongWriting: Story = { args: { path: threadHref(conversationLong) } };
export const SparseContinuation: Story = {
  args: { path: `${threadHref(conversationDiscussion)}?cursor=${encodeURIComponent(conversationThreadCursor)}` },
};
export const IndependentFailure: Story = { args: { path: threadHref(conversationFailure) } };
export const SignedOutDiscussion: Story = { args: { visitor: 'Signed Out', credentialMode: 'anonymous' } };
