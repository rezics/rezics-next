import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, waitFor, within } from 'storybook/test';
import type { UiLocale } from '../../i18n/define.ts';
import { FeedProvider } from '../feed/feed-context.tsx';
import { memoryFeed } from '../feed/fixtures.ts';
import { messages } from '../feed/messages.ts';
import zhHans from '../feed/messages/zh-Hans.ts';
import type { ReplyMode } from '../feed/reply-composer.tsx';
import { memoryThreads, type MemoryThreads, storyBranch, storyQuietThread, storyRealm, storyReply,
  storySpoilerThread, storyThread, THREAD_NOW } from '../feed/thread-fixtures.ts';
import type { ThreadRead } from '../feed/thread.ts';
import { communityZone } from '../zones/fixtures.ts';
import { RealmPageStory } from './story-page.tsx';
import { DiscussionColumns, ThreadRail } from './thread-rail.tsx';
import { ThreadView } from './thread-view.tsx';

// A Realm thread in its Zone frame, over an in-memory Main (feed/thread-fixtures.ts).
// These stories carry the thread's rules: replies nest under their parents
// with fold lines, the opener is marked OP, a reply the community voted down
// starts folded, a deep branch continues on its own page, and replying is
// offered only where the Realm would place the reply.

interface Args { read: ThreadRead; mode: ReplyMode; signedIn: boolean; locale: UiLocale; api?: MemoryThreads }

const rules = [
  { id: 'schedule', title: 'Stay within the week’s chapters', lang: 'en',
    body: 'The weekly thread covers the week’s chapters. Later chapters get a thread marked “Spoilers”.' },
  { id: 'edition', title: 'Name your edition', lang: 'en', body: 'Say which edition or translation you read when you quote.' },
];

function ThreadPage({ read, mode, signedIn, locale, api = memoryThreads() }: Args) {
  const zone = communityZone(locale);
  const here = `/${locale}${storyRealm.path}/discussions/${read.focus.slice(-36)}`;
  return <RealmPageStory zone={zone} locale={locale} members={locale === 'zh-Hans' ? '10 位成员' : '10 members'}>
    <FeedProvider locale={locale} messages={locale === 'zh-Hans' ? { ...messages, ...zhHans } : messages} now={THREAD_NOW}
      signedIn={signedIn} actingSubject={signedIn ? 'https://rezics.com/id/00000802-bbbb-7a6f-8c2d-3e7b5c1a9f40' : null}
      signInHref={`/auth/start?next=${encodeURIComponent(here)}`} avatarQuery="" tab="all" followedRealms={null}
      api={memoryFeed()}>
      <DiscussionColumns rail={<ThreadRail name={{ value: zone.name.value, lang: zone.name.lang }}
        description={zone.description ? { value: zone.description.value, lang: zone.description.lang } : null}
        members={locale === 'zh-Hans' ? '10 位成员' : '10 members'} aboutHref={zone.links.about} rules={rules}
        labels={{ about: locale === 'zh-Hans' ? zhHans.aboutCommunity : messages.aboutCommunity,
          rules: locale === 'zh-Hans' ? zhHans.communityRules : messages.communityRules,
          more: locale === 'zh-Hans' ? zhHans.moreAboutCommunity : messages.moreAboutCommunity }} />}>
        <ThreadView read={read} sort="best" replyMode={mode} threadApi={api}
          realm={storyRealm} sortHrefs={{ best: here, top: `${here}?sort=top`, new: `${here}?sort=new` }} />
      </DiscussionColumns>
    </FeedProvider>
  </RealmPageStory>;
}

const meta = {
  title: 'Realm/Thread',
  component: ThreadPage,
  args: { read: storyThread, mode: 'open', signedIn: true, locale: 'en' },
  parameters: { route: { pathname: `/en${storyRealm.path}/discussions/${storyReply(1).slice(-36)}` } },
  globals: { viewport: { value: 'desktop' } },
  render: (args, { globals }) => <ThreadPage {...args} locale={(globals.locale as UiLocale | undefined) ?? args.locale} />,
} satisfies Meta<typeof ThreadPage>;
export default meta;
type Story = StoryObj<typeof meta>;

const reply = (canvas: ReturnType<typeof within>, name: RegExp) => canvas.getAllByRole('article', { name })[0]!;

/** The opening post, then replies nested under their parents, the opener marked, the rail beside them. */
export const Thread: Story = {
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole('heading', { level: 1,
      name: 'October read-along: Pride and Prejudice, chapters 1–12' })).toBeVisible();
    await expect(canvas.getByRole('link', { name: /Pride and Prejudice/ })).toHaveAttribute('href',
      expect.stringMatching(/^\/en\/w\//));
    await expect(canvas.getByRole('link', { name: '11 comments' })).toHaveAttribute('href', '#comments');
    // Priya opened the discussion, so her reply is marked OP.
    await expect(within(reply(canvas, /Priya Raman/)).getByTitle('Started this discussion')).toHaveTextContent('OP');
    // A reply whose author keeps a private profile shows without a name.
    await expect(canvas.getAllByText('A member').length).toBeGreaterThan(0);
    // Six levels down, a branch continues on the reply's own page.
    await expect(canvas.getByRole('link', { name: 'Continue this thread' })).toHaveAttribute('href',
      `/en${storyRealm.path}/discussions/${storyReply(7).slice(-36)}`);
    // The community voted this reply down, so it starts folded; one tap opens it.
    const folded = canvas.getByRole('button', { name: 'Show the reply by Leo Sun 孙乐' });
    await expect(folded).toHaveAttribute('aria-expanded', 'false');
    await userEvent.click(folded);
    await expect(canvas.getByText('Honestly this book is boring, just watch the movie.')).toBeVisible();
    // A reply Home's projection takes no vote on yet shows its score without arrows.
    const notOpen = canvas.getByText(/第一次读英文原版/).closest('article')!;
    await expect(within(notOpen).getByTitle('Voting isn’t open on this yet')).toBeVisible();
    // Folding a branch hides its replies and says how many.
    await userEvent.click(canvas.getByRole('button', { name: 'Hide the reply by Aria Wang 王雅' }));
    await expect(canvas.getByText('2 replies hidden')).toBeVisible();
    const rail = canvas.getByRole('complementary', { name: 'About this community' });
    await userEvent.click(within(rail).getByText('Name your edition'));
    await expect(within(rail).getByText(/which edition or translation/)).toBeVisible();
  },
};

/** A blocked author's words stay withheld even after the reader opens the collapsed branch. */
export const BlockedReply: Story = {
  args: { read: { ...storyThread, items: storyThread.items.map(item => item.reply === storyReply(2)
    ? { ...item, author: null, body: '', blocked: true } : item) } },
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    const branch = canvas.getByRole('button', { name: 'Show the reply by Blocked user' });
    await expect(branch).toHaveAttribute('aria-expanded', 'false');
    await userEvent.click(branch);
    const blocked = within(branch.closest('article')!);
    await expect(blocked.getAllByText('Blocked user').length).toBeGreaterThan(0);
    const byline = branch.closest('article')!.querySelector('p[id]');
    await expect(byline).toHaveTextContent('Blocked user');
    await expect(byline).not.toHaveTextContent('Daniel Chen 陈丹尼');
  },
};

export const FormattedReply: Story = {
  args: { read: { ...storyThread, items: storyThread.items.map(item => item.reply === storyReply(2)
    ? { ...item, body: '**A thought** with [a link](https://example.org) and >!a secret!<.' } : item) } },
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await expect(canvas.getByText('A thought')).toHaveProperty('tagName', 'STRONG');
    await expect(canvas.getByRole('link', { name: 'a link' })).toHaveAttribute('href', 'https://example.org/');
    await expect(canvas.queryByText('a secret')).toBeNull();
    await userEvent.click(canvas.getByRole('button', { name: 'Show spoiler' }));
    await expect(canvas.getByText('a secret')).toBeVisible();
  },
};

/** Replying inline: the words go to Main through its four reply steps, and the thread reads again. */
export const ReplyInline: Story = {
  args: { api: memoryThreads() },
  async play({ canvasElement, args }) {
    const canvas = within(canvasElement);
    const daniel = reply(canvas, /Daniel Chen 陈丹尼/);
    await userEvent.click(within(daniel).getAllByRole('button', { name: 'Reply' })[0]!);
    const box = within(daniel).getByRole('textbox', { name: 'Reply to Daniel Chen 陈丹尼' });
    await userEvent.type(box, 'Mr. Bennet is funnier on a second read.');
    await userEvent.click(within(box.closest('form')!).getByRole('button', { name: 'Reply' }));
    await waitFor(() => expect(args.api!.calls).toEqual([
      `reply:${storyReply(2).slice(-12)}:Mr. Bennet is funnier on a second read.`]));
    await expect(within(daniel).queryByRole('textbox')).toBeNull();
  },
};

/** A Realm that refuses the reply says so, and nothing is left posted. */
export const ReplyRefused: Story = {
  args: { api: memoryThreads('refused') },
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await userEvent.type(canvas.getByRole('textbox', { name: 'Add a comment' }), 'A thought on chapter three.');
    await userEvent.click(canvas.getByRole('button', { name: 'Comment' }));
    await expect(await canvas.findByRole('alert')).toHaveTextContent('didn’t accept the reply');
  },
};

/** A reply that failed on the way keeps its words, as sent, for Try again; it never posts twice. */
export const ReplyFailed: Story = {
  args: { api: memoryThreads('failed') },
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    const box = canvas.getByRole('textbox', { name: 'Add a comment' });
    await userEvent.type(box, 'Lost on the way');
    await userEvent.click(canvas.getByRole('button', { name: 'Comment' }));
    await expect(await canvas.findByRole('alert')).toHaveTextContent('it won’t post twice');
    await expect(box).toHaveAttribute('readonly');
  },
};

/** Signed out, replying leads to sign-in; the thread reads the same. */
export const SignedOut: Story = {
  args: { signedIn: false, mode: 'sign-in' },
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole('link', { name: 'Sign in to reply' })).toHaveAttribute('href',
      expect.stringContaining('/auth/start?next='));
    await expect(canvas.getAllByRole('link', { name: /^Upvote/ }).length).toBeGreaterThan(0);
  },
};

/** A member-only Realm asks the reader to join before replying. */
export const JoinToReply: Story = {
  args: { mode: 'join' },
  async play({ canvasElement }) {
    await expect(within(canvasElement).getByText('Join this community to reply.')).toBeVisible();
  },
};

/** A Realm that reviews every reply has no queue for them yet, so it takes no words it cannot publish. */
export const RepliesReviewed: Story = {
  args: { mode: 'reviewed' },
  async play({ canvasElement }) {
    await expect(within(canvasElement).getByText(/reviews every reply before it appears/)).toBeVisible();
  },
};

/** One reply's own page: its discussion and parent for context, then its branch. */
export const ReplyPage: Story = {
  args: { read: storyBranch },
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole('link', { name: 'View the whole discussion' })).toHaveAttribute('href',
      `/en${storyRealm.path}/discussions/${storyReply(1).slice(-36)}`);
    await expect(canvas.getByText('In reply to')).toBeVisible();
    await expect(canvas.getByText(/joke turns out to cost his daughters/)).toBeVisible();
  },
};

/** No replies yet: the empty state invites the first. */
export const NoComments: Story = {
  args: { read: storyQuietThread },
  async play({ canvasElement }) {
    await expect(within(canvasElement).getByRole('heading', { name: 'No comments yet' })).toBeVisible();
  },
};

/** The author announced spoilers in the title: the words stay veiled until asked for. */
export const Spoiler: Story = {
  args: { read: storySpoilerThread },
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await expect(canvas.queryByText(/rereads it until she has to admit/)).toBeNull();
    await userEvent.click(canvas.getByRole('button', { name: 'Show spoiler' }));
    await expect(canvas.getByText(/rereads it until she has to admit/)).toBeVisible();
  },
};

export const Chinese: Story = {
  args: { locale: 'zh-Hans' },
  globals: { locale: 'zh-Hans' },
  async play({ canvasElement }) {
    await expect(within(canvasElement).getByRole('heading', { name: '评论' })).toBeVisible();
  },
};

export const Dark: Story = { globals: { theme: 'dark' } };

export const Phone: Story = {
  globals: { viewport: { value: 'phone' } },
  async play() {
    await expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(window.innerWidth);
  },
};
