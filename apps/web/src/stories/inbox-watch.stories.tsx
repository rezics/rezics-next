import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, within } from 'storybook/test';
import { InboxPageView } from '../inbox/inbox-page';
import type { InboxPage, ResolvedInboxPage } from '../inbox/inbox-read';
import { m } from '../paraglide/messages.js';
import { getLocale } from '../paraglide/runtime.js';
import { AppShell } from '../shell/shell';
import { PatternStory } from './page';

const meta = {
  title: 'Pages/Account/Inbox watch updates',
  parameters: {
    layout: 'fullscreen',
    docs: {
      description: {
        component:
          'Illustrative local watch consumer states in the actual Inbox page and AppShell. Watch categories are presentation data; no native watch kind or DTO binding exists on this base. Root approves screenshots using the locale, theme and viewport globals.',
      },
    },
  },
} satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;

function items(): ResolvedInboxPage['items'] {
  const base = {
    createdAt: '2026-11-03T10:00:00.000Z',
    unread: true,
    actorId: 'member',
    actorName: 'Momo',
    threadId: 'thread',
    postId: 'post',
    decisionId: null,
    reportId: null,
    unavailable: false,
    text: 'A current discussion',
    href: `/${getLocale()}/threads/thread?post=post#post-post`,
  };
  return [
    { ...base, id: 'thread-watch-example', kind: 'illustrative-watch', watch: 'thread' },
    {
      ...base,
      id: 'board-watch-example',
      kind: 'illustrative-watch',
      watch: 'board',
      text: 'A newly published discussion',
      postId: null,
      href: `/${getLocale()}/threads/new-thread`,
    },
    { ...base, id: 'reply-example', kind: 'reply' },
    { ...base, id: 'mention-example', kind: 'mention', unread: false },
    {
      ...base,
      id: 'moderation-example',
      kind: 'moderation_decision',
      actorId: null,
      actorName: m.inbox_actor_moderation(),
      threadId: null,
      postId: null,
      decisionId: 'decision',
      text: 'Your moderation outcome',
      href: '/moderation/decisions/decision',
    },
  ];
}

function Example({ state }: { state: 'mixed' | 'inaccessible' | 'failed' }) {
  const loadPage = async (): Promise<InboxPage> =>
    state === 'failed'
      ? { signedIn: true, state: 'unavailable', failure: { status: 503, retryable: true } }
      : {
          signedIn: true,
          state: 'ready',
          next: null,
          items:
            state === 'mixed'
              ? items()
              : items()
                  .slice(0, 2)
                  .map(({ href: _href, actorName: _actorName, ...item }) => ({
                    ...item,
                    actorId: null,
                    text: '',
                    unavailable: true,
                  })),
        };
  return (
    <PatternStory visitor="Signed In" path="/inbox?fixture=mixed">
      <AppShell>
        <InboxPageView loadPage={loadPage} />
      </AppShell>
    </PatternStory>
  );
}

export const MixedWatch: Story = {
  name: 'Mixed watch updates',
  render: () => <Example state="mixed" />,
  play: async ({ canvasElement }) => {
    const view = within(canvasElement);
    const list = await view.findByRole('list', { name: m.inbox_heading() });
    await expect(within(list).getAllByRole('listitem')).toHaveLength(5);
    await expect(within(list).getByText(m.inbox_kind_thread_activity())).toBeVisible();
    await expect(within(list).getByText(m.inbox_kind_board_activity())).toBeVisible();
    await expect(view.getByRole('link', { name: m.inbox_notification_preferences() })).toHaveAttribute(
      'href',
      `/${getLocale()}/settings#notifications`,
    );
  },
};
export const InaccessibleTarget: Story = {
  name: 'Inaccessible watch targets',
  render: () => <Example state="inaccessible" />,
  play: async ({ canvasElement }) => {
    const list = within(await within(canvasElement).findByRole('list', { name: m.inbox_heading() }));
    await expect(list.getAllByText(m.inbox_unavailable_item())).toHaveLength(2);
    await expect(list.queryAllByRole('link')).toHaveLength(0);
    await expect(list.queryByText('Momo')).toBeNull();
  },
};
export const ReadFailure: Story = {
  name: 'Watch page read failure',
  render: () => <Example state="failed" />,
  play: async ({ canvasElement }) => {
    const view = within(canvasElement);
    await view.findByText(m.inbox_unavailable());
    await expect(view.queryByRole('list', { name: m.inbox_heading() })).toBeNull();
    await expect(view.queryByRole('button', { name: m.inbox_triage_mark() })).toBeNull();
  },
};
