import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, within } from 'storybook/test';
import { InboxPageView } from '../inbox/inbox-page';
import { inboxContent } from '../inbox/adapters/presentation';
import { readyInboxPage, type InboxPage, type InboxPageQuery, type ResolvedInboxPage } from '../inbox/inbox-read';
import { m } from '../paraglide/messages.js';
import { getLocale } from '../paraglide/runtime.js';
import { AppShell } from '../shell/shell';
import { PageStory, PatternStory } from './page';

const meta = {
  title: 'Pages/Account/Inbox watch updates',
  parameters: {
    layout: 'fullscreen',
    docs: {
      description: {
        component:
          'Installed Inbox page with a recorded native thread_watch notice, withheld actor context and system moderation. Root approves screenshots using the locale, theme and viewport globals. Native, runtime and visual proof remain separate.',
      },
    },
  },
} satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;

const watchThread = '01a17a3b-0884-721b-91ef-d7ffd7bb58f1';
const watchPost = '01a17a3b-0884-721b-91ef-d7ffd7bb58f2';
const watchHref = inboxContent.threadHref(getLocale(), {
  id: watchThread,
  title: 'Reading together',
  postId: watchPost,
});

function InboxStory({ fixture }: { fixture: string }) {
  return <PageStory visitor="Signed In" path={`/inbox?fixture=${fixture}`} />;
}

function withheldItems(): ResolvedInboxPage['items'] {
  const base = {
    createdAt: '2026-11-04T10:00:00.000Z',
    unread: true,
    actorId: null,
    actor: {
      state: 'withheld' as const,
      displayName: 'Former or unavailable account' as const,
      handle: null,
      avatar: null,
      avatarUrl: null,
    },
    threadId: null,
    postId: null,
    decisionId: null,
    reportId: null,
    unavailable: true,
    text: '',
  };
  return [
    { ...base, id: 'thread-watch-hidden', kind: 'thread_watch' },
    { ...base, id: 'board-watch-hidden', kind: 'board_activity' },
  ];
}

async function mixedWatchPlay({ canvasElement }: { canvasElement: HTMLElement }) {
  const view = within(canvasElement);
  const list = await view.findByRole('list', { name: m.inbox_heading() });
  const rows = within(list).getAllByRole('listitem');
  await expect(rows).toHaveLength(4);
  await expect(within(list).getByText(m.inbox_kind_thread_activity())).toBeVisible();
  await expect(within(list).getByText(m.inbox_kind_board_activity())).toBeVisible();
  await expect(within(list).getByText(m.inbox_actor_unknown())).toBeVisible();
  await expect(within(list).getByText(m.inbox_actor_moderation())).toBeVisible();
  await expect(within(list).getByRole('link', { name: 'A new post on a thread you watch' })).toHaveAttribute(
    'href',
    watchHref,
  );
  await expect(view.getByRole('link', { name: m.inbox_notification_preferences() })).toHaveAttribute(
    'href',
    `/${getLocale()}/settings#notifications`,
  );
}

export const MixedWatch: Story = {
  name: 'Installed thread watch notice',
  globals: { viewport: { value: 'desktop1280', isRotated: false } },
  render: () => <InboxStory fixture="thread-watch" />,
  play: mixedWatchPlay,
};

export const MixedWatchPhone: Story = {
  name: 'Installed thread watch notice on phone',
  globals: { viewport: { value: 'phone390', isRotated: false } },
  render: () => <InboxStory fixture="thread-watch" />,
  play: mixedWatchPlay,
};

function Example({ state }: { state: 'inaccessible' | 'failed' }) {
  const loadPage = async (query: InboxPageQuery): Promise<InboxPage> => {
    if (state === 'failed') return { signedIn: true, state: 'unavailable', failure: { status: 503, retryable: true } };
    return readyInboxPage(withheldItems(), null, 'alice', query.selection);
  };
  return (
    <PatternStory visitor="Signed In" path="/inbox?fixture=thread-watch">
      <AppShell>
        <InboxPageView loadPage={loadPage} content={inboxContent} />
      </AppShell>
    </PatternStory>
  );
}

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
