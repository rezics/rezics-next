import type { Meta, StoryObj } from '@storybook/react-vite';
import { MessagesSquareIcon } from 'lucide-react';
import { expect, screen, userEvent, waitFor, within } from 'storybook/test';
import type { UiLocale } from '../../i18n/define.ts';
import { localizedPath } from '../../i18n/locale.ts';
import { threadHref } from '../address/path.ts';
import { FeedProvider } from '../feed/feed-context.tsx';
import { memoryFeed } from '../feed/fixtures.ts';
import { messages } from '../feed/messages.ts';
import zhHans from '../feed/messages/zh-Hans.ts';
import { storyRealm, storyReply, storyThreads, THREAD_NOW } from '../feed/thread-fixtures.ts';
import type { ThreadSort, ThreadSummary, ThreadWindow } from '../feed/thread.ts';
import { EmptyState } from '../shell/empty-state.tsx';
import { communityZone } from '../zones/fixtures.ts';
import { DiscussionList } from './discussion-list.tsx';
import { RealmPageStory } from './story-page.tsx';
import { DiscussionColumns } from './thread-rail.tsx';

// A Realm's Discussions tab, as a subreddit lists its posts, over story data.

interface Args { items: ThreadSummary[]; sort: ThreadSort; window: ThreadWindow; next: boolean; locale: UiLocale }

const base = `/en${storyRealm.path}/discussions`;
const hrefs = {
  sorts: { best: base, new: `${base}?sort=new`, top: `${base}?sort=top` },
  windows: { week: `${base}?sort=top`, month: `${base}?sort=top&t=month`, all: `${base}?sort=top&t=all` },
};

function Tab({ items, sort, window, next, locale }: Args) {
  const t = locale === 'zh-Hans' ? { ...messages, ...zhHans } : messages;
  return <RealmPageStory zone={communityZone(locale)} locale={locale} members="10 members">
    <FeedProvider locale={locale} messages={t} now={THREAD_NOW} signedIn actingSubject={null} signInHref="/auth/start"
      avatarQuery="" tab="all" followedRealms={null} api={memoryFeed()}>
      <DiscussionColumns rail={null}>
        <DiscussionList items={items} realmPath={storyRealm.path} sort={sort} window={window} hrefs={hrefs}
          next={next ? `${base}?cursor=next` : null} first={null}
          empty={<EmptyState icon={MessagesSquareIcon} headingLevel={3} title={t.emptyDiscussions}
            description={t.emptyDiscussionsBody} />} />
      </DiscussionColumns>
    </FeedProvider>
  </RealmPageStory>;
}

const meta = {
  title: 'Realm/Discussions',
  component: Tab,
  args: { items: storyThreads, sort: 'best', window: 'week', next: true, locale: 'en' },
  parameters: { route: { pathname: base } },
  globals: { viewport: { value: 'desktop' } },
  render: (args, { globals }) => <Tab {...args} locale={(globals.locale as UiLocale | undefined) ?? args.locale} />,
} satisfies Meta<typeof Tab>;
export default meta;
type Story = StoryObj<typeof meta>;

/** Each thread is a post titled by its first line, leading to its page, with its own reply count. */
export const Threads: Story = {
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    const feed = canvas.getByRole('feed', { name: 'Discussions' });
    await expect(within(feed).getAllByRole('article')).toHaveLength(storyThreads.length);
    const readAlong = canvas.getByRole('article', { name: 'October read-along: Pride and Prejudice, chapters 1–12' });
    await expect(within(readAlong).getByRole('link', { name: 'October read-along: Pride and Prejudice, chapters 1–12' }))
      .toHaveAttribute('href', localizedPath(threadHref(storyRealm.path, storyReply(1)), 'en'));
    await expect(within(readAlong).getByRole('link', { name: '11 comments' })).toBeVisible();
    // Where the page is the Realm's own, the meta line names the person, not the Realm again.
    await expect(within(readAlong).queryByRole('button', { name: 'Join' })).toBeNull();
    const spoiler = canvas.getByRole('article', { name: /Spoilers \(chapter 35\)/ });
    await expect(within(spoiler).getByText('Spoiler')).toBeVisible();
    await expect(within(spoiler).queryByText(/rereads it/)).toBeNull();
    const unmarked = canvas.getByRole('article', { name: 'Spoilers: a review of spoiler culture' });
    await expect(within(unmarked).getByText(/The title names the subject/)).toBeVisible();
    await expect(within(unmarked).queryByText('Spoiler')).toBeNull();
    await expect(canvas.getByRole('link', { name: 'More discussions' })).toHaveAttribute('href', `${base}?cursor=next`);
    await userEvent.click(canvas.getByRole('button', { name: 'Sort: Best' }));
    await waitFor(() => expect(screen.getByRole('menuitemradio', { name: /^Top/ })).toBeVisible());
    await userEvent.keyboard('{Escape}');
  },
};

/** Top adds its period on the same line. */
export const TopThisMonth: Story = {
  args: { sort: 'top', window: 'month' },
  async play({ canvasElement }) {
    await expect(within(canvasElement).getByRole('button', { name: 'Period: This month' })).toBeVisible();
  },
};

export const Empty: Story = {
  args: { items: [], next: false },
  async play({ canvasElement }) {
    await expect(within(canvasElement).getByRole('heading', { name: 'No discussions yet' })).toBeVisible();
  },
};

export const Chinese: Story = { args: { locale: 'zh-Hans' }, globals: { locale: 'zh-Hans' } };

export const Dark: Story = { globals: { theme: 'dark' } };

export const Phone: Story = {
  globals: { viewport: { value: 'phone' } },
  async play() {
    await expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(window.innerWidth);
  },
};
