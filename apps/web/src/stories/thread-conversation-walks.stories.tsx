import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, waitFor, within } from 'storybook/test';
import {
  conversationBoardCursor,
  conversationBoardId,
  conversationBoardTitle,
  conversationDiscussion,
  conversationDiscussionReplies,
  conversationFailure,
  conversationQuestionId,
  conversationReview,
  conversationSparseCursor,
  resetConversationExamples,
} from '../kernel/fake/board-conversation';
import { m } from '../paraglide/messages.js';
import { getLocale } from '../paraglide/runtime.js';
import { boardRowAnchor } from '../threads/board-navigation';
import { threadHref } from '../threads/thread-href';
import { PageStory } from './page';

const boardPath = `/boards/${conversationBoardId}?sort=hot&cursor=${encodeURIComponent(conversationBoardCursor)}`;
const meta = {
  title: 'Community/Conversation walks',
  id: 'walks-community-board-thread',
  component: PageStory,
  beforeEach: resetConversationExamples,
  parameters: { layout: 'fullscreen' },
  args: { visitor: 'Signed In', credentialMode: 'session', path: boardPath },
} satisfies Meta<typeof PageStory>;
export default meta;
type Story = StoryObj<typeof meta>;

export const BoardBranchReplyReturn: Story = {
  play: async ({ canvasElement }) => {
    const view = within(canvasElement);
    await view.findByRole('heading', { level: 1, name: conversationBoardTitle });
    const rowAnchor = boardRowAnchor(conversationDiscussion.id, { section: 'ordinary', index: 0 });
    const row = canvasElement.querySelector<HTMLElement>(`#${rowAnchor}`)!;
    const link = within(row).getByRole('link', { name: conversationDiscussion.title! });
    const origin = new URL(link.getAttribute('href')!, 'https://story.test').searchParams.get('boardReturn')!;
    const returnUrl = new URL(origin, 'https://story.test');
    await expect(returnUrl.pathname).toBe(`/${getLocale()}/boards/${conversationBoardId}`);
    await expect(returnUrl.searchParams.get('sort')).toBe('hot');
    await expect(returnUrl.searchParams.get('cursor')).toBe(conversationBoardCursor);
    await expect(returnUrl.hash).toBe(`#${rowAnchor}`);
    await userEvent.click(link);
    await view.findByRole('heading', { level: 1, name: conversationDiscussion.title! });

    const branch = canvasElement.querySelector<HTMLElement>('[data-conversation-row="3"]')!;
    await userEvent.click(within(branch).getByText(m.conversation_reply_path(), { exact: true }));
    const parent = conversationDiscussionReplies[1]!;
    const parentLink = branch.querySelector<HTMLAnchorElement>(`a[href="#post-${parent.id}"]`)!;
    await userEvent.click(parentLink);
    await waitFor(() => expect(canvasElement.querySelector(`#post-${parent.id}`)).toHaveFocus());
    await userEvent.click(view.getByRole('button', { name: m.thread_branch_return({ position: 4 }) }));
    const selected = conversationDiscussionReplies[2]!;
    const post = canvasElement.querySelector<HTMLElement>(`#post-${selected.id}`)!;
    await userEvent.click(within(post).getByRole('button', { name: m.thread_reply_to_post() }));

    const editor = await view.findByRole('textbox', { name: m.thread_reply_label() });
    const response = 'The pause makes room for another reader. I noticed it in our translation too.';
    await userEvent.click(editor);
    await userEvent.keyboard(response);
    await userEvent.click(view.getByRole('button', { name: m.thread_write_send() }));
    await view.findByText(response, { exact: true });
    const back = view.getByRole('link', { name: m.board_reading_return() });
    await expect(back).toHaveAttribute('href', origin);
    await userEvent.click(back);
    await view.findByRole('heading', { level: 1, name: conversationBoardTitle });
    await waitFor(() => expect(canvasElement.querySelector(`#${rowAnchor}`)).toHaveFocus());
  },
};

export const LongDraftStaysLocal: Story = {
  args: { path: threadHref(conversationDiscussion) },
  play: async ({ canvasElement }) => {
    const view = within(canvasElement);
    await view.findByRole('heading', { level: 1, name: conversationDiscussion.title! });
    const editor = await view.findByRole('textbox', { name: m.thread_reply_label() });
    const key = canvasElement.querySelector<HTMLInputElement>('input[name="idempotency_key"]')!;
    const initialKey = key.value;
    const response = 'A translation can preserve an event and still change the time we spend with it. '.repeat(12);
    await userEvent.click(editor);
    await userEvent.keyboard(response);
    const opening = canvasElement.querySelector<HTMLElement>('[data-conversation-row="0"]')!;
    await userEvent.click(within(opening).getByRole('button', { name: m.thread_branch_collapse({ count: 3 }) }));
    await expect(editor).toHaveTextContent(response.trim());
    await userEvent.click(within(opening).getByRole('button', { name: m.thread_branch_expand({ count: 3 }) }));
    await expect(editor).toHaveTextContent(response.trim());
    await expect(key.value).toBe(initialKey);
    await expect(view.getByRole('button', { name: m.thread_write_send() })).toBeEnabled();
    await expect(canvasElement.querySelectorAll('[data-slot="post-reading-frame"]')).toHaveLength(6);
  },
};

export const ReplyFailureThenExactRetry: Story = {
  args: { path: threadHref(conversationFailure) },
  play: async ({ canvasElement }) => {
    const view = within(canvasElement);
    await view.findByRole('heading', { level: 1, name: conversationFailure.title! });
    const editor = await view.findByRole('textbox', { name: m.thread_reply_label() });
    const response = 'The illustration can wait; the supplied text is enough for my response.';
    await userEvent.click(editor);
    await userEvent.keyboard(response);
    const key = canvasElement.querySelector<HTMLInputElement>('input[name="idempotency_key"]')!;
    const sentKey = key.value;
    await userEvent.click(view.getByRole('button', { name: m.thread_write_send() }));
    const retry = await view.findByRole('button', { name: m.thread_write_retry() });
    await expect(editor).toHaveTextContent(response);
    await expect(key.value).toBe(sentKey);
    await expect(view.getByText('The written description gives us enough to continue the conversation.')).toBeVisible();
    await userEvent.click(retry);
    await waitFor(() => expect(canvasElement.querySelectorAll('[data-slot="post-reading-frame"]')).toHaveLength(3));
    await expect(view.getAllByText(response, { exact: true })).toHaveLength(1);
    await expect(view.getByRole('textbox', { name: m.thread_reply_label() })).toHaveTextContent('');
  },
};

export const InspectExactReviewCitation: Story = {
  args: { path: threadHref(conversationReview) },
  play: async ({ canvasElement }) => {
    const view = within(canvasElement);
    await view.findByRole('heading', { level: 1, name: conversationReview.title! });
    const citation = canvasElement.querySelector<HTMLElement>('[data-thread-review-context]')!;
    await expect(citation.querySelector('[data-cited-value="0"]')).toBeVisible();
    const identifier = within(citation).getByText(conversationQuestionId, { exact: true });
    await expect(identifier).not.toBeVisible();
    await userEvent.click(within(citation).getByText(m.conversation_inspect_citation(), { exact: true }));
    await expect(identifier).toBeVisible();
    const opening = conversationReview.firstPost;
    await expect(citation.querySelector('a[href*="/revisions/"]')).toHaveAttribute(
      'href',
      `/${getLocale()}/posts/${opening.id}/revisions/${opening.availability === 'available' ? opening.revisionId : ''}`,
    );
  },
};

export const FollowSparseBoardContinuation: Story = {
  args: { path: `/boards/${conversationBoardId}?sort=hot&cursor=${encodeURIComponent(conversationSparseCursor)}` },
  play: async ({ canvasElement }) => {
    const view = within(canvasElement);
    await view.findByRole('heading', { level: 1, name: conversationBoardTitle });
    await expect(canvasElement.querySelectorAll('[data-thread-id]')).toHaveLength(0);
    const next = canvasElement.querySelector<HTMLAnchorElement>(
      `a[href*="cursor=${encodeURIComponent(conversationBoardCursor)}"]`,
    )!;
    await expect(next).toBeVisible();
    await userEvent.click(next);
    await view.findByRole('link', { name: conversationDiscussion.title! });
    await expect(canvasElement.querySelectorAll('[data-thread-id]')).toHaveLength(1);
  },
};
