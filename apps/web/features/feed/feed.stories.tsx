import { profileHref } from '../profile/route.ts';
import { localizedPath } from '../../i18n/locale.ts';
import { spaceHref, threadHref } from '../address/path.ts';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, screen, userEvent, waitFor, within } from 'storybook/test';
import type { UiLocale } from '../../i18n/define.ts';
import { fixtureFollow, memoryRelationships } from '../relationships/fixtures.ts';
import { relationshipStoryFetch } from '../relationships/story-fetch.ts';
import { memoryReaderActions } from '../catalogue/fixtures.ts';
import { ReaderActionsProvider } from '../catalogue/reader-actions.tsx';
import { FeedProvider } from './feed-context.tsx';
import { FeedList } from './feed-list.tsx';
import {
  everyKind,
  memoryFeed,
  type MemoryFeed,
  NOW,
  page,
  people,
  post,
  realms,
  storyId,
  suggestion,
} from './fixtures.ts';
import { messages } from './messages.ts';
import zhHans from './messages/zh-Hans.ts';
import type { FeedTab } from './state.ts';
import type { FeedPage, FeedQuery, Loaded } from './types.ts';

// Posts and the list around them, with an in-memory Main (fixtures.ts). These
// stories carry the feed's rules: one anatomy for every kind, grouped updates,
// spoiler-safe chapters, reasons only where they are exceptions, honest
// lower-bound counts, and a changed cursor that asks for a refresh without
// losing the view's filters.

interface Args {
  initial: Loaded<FeedPage>;
  query?: FeedQuery;
  api?: MemoryFeed;
  signedIn?: boolean;
  tab?: FeedTab;
  followedRealms?: string[] | null;
  locale?: UiLocale;
  headInterval?: number;
  relationships?: ReturnType<typeof memoryRelationships>;
}

const signInHref = '/auth/start?next=%2Fen';

function Feed({
  initial,
  query = { scope: 'following', sort: 'best' },
  api = memoryFeed(),
  signedIn = true,
  tab = 'following',
  followedRealms = [realms.fiction.id],
  locale = 'en',
  headInterval,
}: Args) {
  return (
    <FeedProvider
      locale={locale}
      messages={locale === 'zh-Hans' ? { ...messages, ...zhHans } : messages}
      now={NOW}
      signedIn={signedIn}
      actingSubject={signedIn ? storyId(801, 'bbbb') : null}
      signInHref={signInHref}
      avatarQuery=""
      tab={tab}
      followedRealms={followedRealms}
      api={api}
    >
      <ReaderActionsProvider
        signedIn={signedIn}
        signInHref={signInHref}
        actions={signedIn ? memoryReaderActions({}) : undefined}
      >
        {/* Home's centre column: posts are divided rows with no frame around them. */}
        <div className="mx-auto max-w-[46rem] py-6 sm:px-6">
          <section aria-label="Posts">
            <FeedList
              initial={initial}
              query={query}
              allHref="/en?tab=all"
              headInterval={headInterval}
              empty={<p>Nothing here</p>}
            />
          </section>
        </div>
      </ReaderActionsProvider>
    </FeedProvider>
  );
}

const meta = {
  title: 'Feed/Posts',
  component: Feed,
  args: { initial: { ok: true, data: page(everyKind) } },
  globals: { viewport: { value: 'desktop' } },
  beforeEach({ args }) {
    const memory = args.relationships ?? memoryRelationships((args.followedRealms ?? [realms.fiction.id])
      .map((id, index) => ({ ...fixtureFollow(index + 1, 'realm'), id, realm: id })));
    const original = window.fetch;
    window.fetch = relationshipStoryFetch(memory.api, original);
    return () => { window.fetch = original; };
  },
} satisfies Meta<typeof Feed>;
export default meta;
type Story = StoryObj<typeof meta>;

const article = (canvas: ReturnType<typeof within>, title: string | RegExp) =>
  canvas.getByRole('article', { name: title });

/** Every kind of post shares one anatomy: where and who, what happened, the content, then the bar. */
export const EveryKind: Story = {
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    const feed = canvas.getByRole('feed', { name: 'Posts' });
    await expect(within(feed).getAllByRole('article')).toHaveLength(everyKind.length);

    // Three chapters from one day arrive as one post titled by the range; its action opens the first of them.
    // The Work is attached, as a link post names its source.
    const serial = article(canvas, 'Chapters 212–214');
    await expect(within(serial).getByRole('link', { name: /^雨夜书店/ })).toHaveAttribute(
      'href',
      expect.stringMatching(/^\/en\/w\//),
    );
    await expect(within(serial).getByRole('link', { name: 'Read chapter 212' })).toHaveAttribute(
      'href',
      expect.stringMatching(/^\/en\/w\/.+\/read\//),
    );
    await expect(within(serial).getByRole('link', { name: '41 comments' })).toBeVisible();

    // Past the reader's position, a chapter's text stays hidden.
    const behind = article(canvas, 'Chapter 58');
    await expect(behind).toHaveTextContent('Hidden until you catch up');
    await expect(behind).toHaveTextContent('The Last Lantern');

    // Counts Main cannot prove exactly say "at least"; big scores are compact.
    const novel = article(canvas, 'Middlemarch: A Study of Provincial Life');
    await expect(within(novel).getByRole('link', { name: '64+ comments' })).toBeVisible();
    await expect(within(novel).getByLabelText('1,830 points')).toHaveTextContent('1.8K');

    // Each kind's own action.
    const release = article(canvas, 'Version 2.4.0');
    await expect(within(release).getByRole('link', { name: 'Install' })).toBeVisible();
    await expect(release).toHaveTextContent('Crop Planner for Stardew Valley');
    await expect(
      within(article(canvas, 'Bilingual book club discussion prompt')).getByRole('link', {
        name: 'Use prompt',
      }),
    ).toBeVisible();
    await expect(within(novel).getByRole('button', { name: 'Want to read' })).toBeVisible();

    // A pick is the Realm's act: the curator is not named where the Work's author would be; the author is.
    // A card gives one reason, and the pick outranks the Work being new.
    const pick = article(canvas, 'Jane Eyre');
    // The meta line names the Realm once, so its pick says only that it picked the Work.
    await expect(pick).toHaveTextContent('Classic Literature');
    await expect(pick).toHaveTextContent('Picked');
    await expect(pick).not.toHaveTextContent('New work');
    await expect(within(pick).queryByText('Daniel Chen')).toBeNull();
    await expect(pick).toHaveTextContent('by Charlotte Brontë');
    await expect(article(canvas, 'Middlemarch: A Study of Provincial Life')).toHaveTextContent(
      'by George Eliot',
    );

    // An import is added to REZICS, not a new work by whoever added it.
    const alice = article(canvas, 'Alice’s Adventures in Wonderland');
    await expect(alice).toHaveTextContent('Added to REZICS');
    await expect(alice).toHaveTextContent('by Lewis Carroll');
    await expect(alice).not.toHaveTextContent('New work');
    // An author on REZICS links to their profile, from the byline and from the meta line where they posted.
    const mine = within(article(canvas, '雨夜书店 · 番外')).getAllByRole('link', {
      name: 'Lin Mei 林梅',
    });
    await expect(mine).toHaveLength(2);
    for (const link of mine)
      await expect(link).toHaveAttribute('href', localizedPath(profileHref('lin_mei'), 'en'));

    // A review: the reader's stars and opening lines, leading to the review on the Work page.
    // A review is titled by its stars and opening line; the Work it reviews is attached.
    const review = article(canvas, /Austen’s quietest novel/);
    await expect(review).toHaveTextContent('Rated 4 out of 5');
    await expect(review).toHaveTextContent('Persuasion');
    await expect(review).toHaveTextContent('12 found this helpful');
    await expect(within(review).getByRole('link', { name: 'Read review' })).toHaveAttribute(
      'href',
      expect.stringMatching(/^\/en\/w\/.+#review-/),
    );
    const spoiler = article(canvas, /Rated 9 out of 10/);
    await expect(spoiler).toHaveTextContent('长夜将明');
    await expect(spoiler).toHaveTextContent('This review discusses the plot');
    await expect(spoiler).toHaveTextContent('+2 more reviews');
    await expect(spoiler).toHaveTextContent('9/10');

    // "New" lasts a few days; after that the Work was simply published.
    await expect(article(canvas, '雨夜书店 · 番外')).toHaveTextContent('New work');
    const older = article(canvas, 'North and South');
    await expect(older).toHaveTextContent('Published');
    await expect(older).not.toHaveTextContent('New work');

    // A list has no page yet, so its title is text, and it has no comments. It shows its first covers and its size.
    const list = article(canvas, 'Autumn reading: slow novels');
    await expect(
      within(list).queryByRole('link', { name: 'Autumn reading: slow novels' }),
    ).toBeNull();
    await expect(within(list).queryByRole('link', { name: /comment/ })).toBeNull();
    const inList = within(list).getByRole('list', { name: 'In this list' });
    await expect(
      within(inList)
        .getAllByRole('link')
        .map((link) => link.getAttribute('aria-label')),
    ).toEqual(['Middlemarch', '雨夜书店', 'Ginger lemon tea']);
    await expect(
      inList.querySelectorAll('[data-slot="work-cover"][data-kind="recipe"]'),
    ).toHaveLength(1);
    await expect(list).toHaveTextContent('12 works');

    // Model words never reach readers.
    await expect(feed).not.toHaveTextContent(/contribution|adoption|text version|lower-bound/i);
    await expect(canvas.getByText('You’ve reached the end for now')).toBeVisible();
  },
};

/** A vote shows at once and settles on Main's receipt; pressing it again takes it back. */
export const Voting: Story = {
  args: { api: memoryFeed() },
  async play({ canvasElement, args }) {
    const post = article(within(canvasElement), 'Chapters 212–214');
    const up = within(post).getByRole('button', { name: 'Upvote' });
    await userEvent.click(up);
    await waitFor(() => expect(up).toHaveAttribute('aria-pressed', 'true'));
    await expect(within(post).getByLabelText('249 points')).toBeVisible();
    await userEvent.click(up);
    await waitFor(() => expect(up).toHaveAttribute('aria-pressed', 'false'));
    await expect(args.api!.calls.filter((call) => !call.startsWith('watermark'))).toEqual([
      'vote:9f40:1',
      'vote:9f40:0',
    ]);
  },
};

/** Main refused the vote: it goes back to what Main had, and says so. */
export const VoteRefused: Story = {
  args: { api: memoryFeed({ refuse: 'moved' }) },
  async play({ canvasElement }) {
    const post = article(within(canvasElement), 'Chapters 212–214');
    await userEvent.click(within(post).getByRole('button', { name: 'Downvote' }));
    await expect(await within(post).findByText(/Couldn’t save your vote/)).toHaveAttribute('role', 'status');
    await expect(within(post).getByRole('button', { name: 'Downvote' })).toHaveAttribute(
      'aria-pressed',
      'false',
    );
    await expect(within(post).getByLabelText('248 points')).toBeVisible();
  },
};

/** Hiding a post leaves one line that says so, with Undo. */
/**
 * Discussions read as Reddit posts: the author's first line is the title and
 * leads to the thread, the Work it is about names its source, an announced
 * spoiler stays veiled until asked for, and a reply opens its place in the thread.
 */
export const Discussions: Story = {
  args: {
    initial: {
      ok: true,
      data: page(everyKind.filter((item) => item.kind === 'discussion' || item.kind === 'reply')),
    },
    api: memoryFeed(),
  },
  async play({ canvasElement, args }) {
    const canvas = within(canvasElement);
    const thread = localizedPath(
      threadHref(
        spaceHref(realms.classics.id.slice(-36), 'community'),
        storyId(7, 'dddd').slice(-36),
      ),
      'en',
    );
    const bennet = article(canvas, 'Is Mr. Bennet a good father?');
    await expect(
      within(bennet).getByRole('link', { name: 'Is Mr. Bennet a good father?' }),
    ).toHaveAttribute('href', thread);
    await expect(bennet).toHaveTextContent('Chapter 2 makes me think he enjoys');
    await expect(
      within(bennet).getByRole('link', { name: /^Pride and Prejudice/ }),
    ).toHaveAttribute('href', expect.stringMatching(/^\/en\/w\//));
    await expect(within(bennet).getByRole('link', { name: '17 comments' })).toHaveAttribute(
      'href',
      `${thread}#comments`,
    );
    await expect(within(bennet).getByRole('link', { name: 'Reply' })).toHaveAttribute(
      'href',
      `${thread}#reply`,
    );

    // The author announced a spoiler: the words stay out of the page until the reader asks.
    const spoiler = article(canvas, '【剧透】《雨夜书店》第二章：那张旧车票');
    await expect(spoiler).not.toHaveTextContent('二十年前的车票');
    await userEvent.click(within(spoiler).getByRole('button', { name: 'Show spoiler' }));
    await expect(spoiler).toHaveTextContent('二十年前的车票');
    await expect(
      within(spoiler).getByRole('link', { name: '2 more discussions about this work' }),
    ).toHaveAttribute(
      'href',
      localizedPath(spaceHref(realms.fiction.id.slice(-36), 'community', ['discussions']), 'en'),
    );

    const reply = article(canvas, 'A reply in a discussion');
    await expect(reply).toHaveTextContent('第一章很短');
    await expect(within(reply).getByRole('link', { name: 'View in thread' })).toHaveAttribute(
      'href',
      localizedPath(
        `${threadHref(spaceHref(realms.fiction.id.slice(-36), 'community'), storyId(16, 'dddd').slice(-36))}#reply`,
        'en',
      ),
    );

    await userEvent.click(within(bennet).getByRole('button', { name: 'Upvote' }));
    await waitFor(() => expect(args.api!.calls).toContain(`vote:${storyId(7).slice(-4)}:1`));
  },
};

/** Main's show-spoilers choice opens an announced discussion in Home. */
export const DiscussionsVeiled: Story = {
  args: {
    initial: {
      ok: true,
      data: page(
        everyKind.filter(
          (item) => item.kind === 'discussion' && item.post.title?.startsWith('【剧透】'),
        ),
      ),
    },
    api: memoryFeed(),
  },
};

/** Main's show-spoilers choice opens an announced discussion in Home. */
export const DiscussionsWithSpoilersShown: Story = {
  args: {
    initial: {
      ok: true,
      data: page(
        everyKind
          .filter((item) => item.kind === 'discussion' && item.post.title?.startsWith('【剧透】'))
          .map((item) => ({
            ...item,
            viewerState: {
              status: 'available' as const,
              shelf: null,
              progress: null,
              spoiler: { policy: 'show' as const, hidden: false },
            },
          })),
      ),
    },
    api: memoryFeed(),
  },
  async play({ canvasElement }) {
    const spoiler = article(within(canvasElement), '【剧透】《雨夜书店》第二章：那张旧车票');
    await expect(spoiler).toHaveTextContent('二十年前的车票');
    await expect(within(spoiler).queryByRole('button', { name: 'Show spoiler' })).toBeNull();
  },
};

export const HideAndUndo: Story = {
  args: { api: memoryFeed() },
  async play({ canvasElement, args }) {
    const canvas = within(canvasElement);
    await userEvent.click(
      within(article(canvas, 'Jane Eyre')).getByRole('button', { name: 'More options' }),
    );
    await userEvent.click(await screen.findByRole('menuitem', { name: 'Hide' }));
    const status = await canvas.findByText('Post hidden. You won’t see it again.');
    await expect(canvas.queryByRole('article', { name: 'Jane Eyre' })).toBeNull();
    await userEvent.click(
      within(status.closest('[role="status"]') as HTMLElement).getByRole('button', {
        name: 'Undo',
      }),
    );
    await waitFor(() => expect(article(canvas, 'Jane Eyre')).toBeVisible());
    await expect(args.api!.calls.filter((call) => !call.startsWith('watermark'))).toEqual([
      'feedback:activity:hide',
      'feedback:activity:clear',
    ]);
  },
};

/** In All, a Realm the reader does not follow offers Follow; afterwards it says Following. */
export const FollowFromAll: Story = {
  args: {
    tab: 'all',
    followedRealms: [],
    api: memoryFeed(),
    query: { scope: 'all', sort: 'best' },
    relationships: memoryRelationships(),
    initial: {
      ok: true,
      data: page(
        [
          post(30, {
            realm: realms.kitchen,
            reason: { kind: 'recommended', basis: 'all' },
            target: {
              title: {
                value: 'Ginger lemon tea',
                language: 'en',
                direction: 'ltr',
                basis: 'requested',
              },
            },
          }),
        ],
        { scope: 'all' },
      ),
    },
  },
  async play({ canvasElement, args }) {
    const post = article(within(canvasElement), 'Ginger lemon tea');
    // In All every post is REZICS-wide, so no "Suggested" label repeats on each.
    await expect(post).not.toHaveTextContent('Suggested');
    await expect(post).not.toHaveTextContent('Join');
    const follow = within(post).getByRole('button', { name: 'Follow Home Cooking · 家常菜' });
    await waitFor(() => expect(follow).toBeEnabled());
    await userEvent.click(follow);
    await waitFor(() => expect(post).toHaveTextContent('Following'));
    await expect(post).not.toHaveTextContent('Joined');
    const calls = args.relationships!.calls;
    await expect(calls).toHaveLength(1);
    await expect(calls[0]!.operation).toBe('follow');
    await expect(calls[0]!.body).toEqual({
      profile: 'follow-command-v1', actingSubject: storyId(801, 'bbbb'),
      target: realms.kitchen.id, kind: 'realm', following: true, expectedRevision: null,
    });
    await expect(calls[0]!.key).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    await expect(within(post).getByRole('button', { name: 'Notifications: Highlights' })).toBeVisible();
  },
};

/** Inside Following, a suggestion is the exception, so it is labelled with why. */
export const SuggestionInFollowing: Story = {
  args: { initial: { ok: true, data: page([everyKind[0]!, suggestion]) } },
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await expect(
      within(article(canvas, 'Weekend buttermilk pancakes')).getByText('Suggested'),
    ).toHaveAttribute('title', 'Suggested while your communities are quiet');
    await expect(article(canvas, 'Chapters 212–214')).not.toHaveTextContent('Suggested');
  },
};

const title = (value: string, language = 'en') => ({
  value,
  language,
  direction: 'ltr' as const,
  basis: 'requested' as const,
});
const mei = { id: storyId(801, 'bbbb'), name: 'Lin Mei 林梅', handle: 'lin_mei' };
/** An Open Library author's new Work and a REZICS author's new chapter, each in Following for its author. */
const authorNews = page([
  post(40, {
    kind: 'added',
    realm: null,
    reasons: [{ kind: 'added-to-rezics', actor: mei.id }],
    authors: [
      {
        id: storyId(40, '0a0a'),
        role: 'author',
        participantKind: 'external-reference',
        provider: 'open-library',
        key: '/authors/OL21594A',
        ordinal: 0,
        agent: null,
        displayName: 'Jane Austen',
        handle: null,
      },
    ],
    reason: { kind: 'followed', target: 'open-library:OL21594A', targetKind: 'external-author' },
    target: { title: title('Sanditon') },
  }),
  post(41, {
    kind: 'contribution',
    realm: realms.fiction,
    actor: mei,
    authors: [
      {
        id: storyId(41, '0b0b'),
        role: 'author',
        participantKind: 'agent',
        provider: null,
        key: null,
        ordinal: null,
        agent: mei.id,
        displayName: mei.name,
        handle: mei.handle,
      },
    ],
    reason: { kind: 'followed', target: mei.id, targetKind: 'agent' },
    card: {
      kind: 'chapter',
      occurrence: storyId(411, 'dddd'),
      parent: storyId(41, 'eeee'),
      number: 3,
    },
    target: { title: title('雨夜书店', 'zh-Hans'), language: 'zh-Hans' },
  }),
  post(42, { target: { title: title('The Last Lantern') } }),
]);

/** The first link in a post's meta line: who or where it leads with. */
const leading = (canvas: ReturnType<typeof within>, title: string) =>
  within(article(canvas, title)).getAllByRole('link')[0]!;

/**
 * In Following, an author's news says whose Work it is. A followed poster
 * needs no such note: the post leads with them. Nor does a followed community.
 */
export const BecauseYouFollow: Story = {
  args: { initial: { ok: true, data: authorNews } },
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await expect(article(canvas, 'Sanditon')).toHaveTextContent('Because you follow Jane Austen');
    await expect(article(canvas, 'Chapter 3')).not.toHaveTextContent('Because you follow');
    await expect(leading(canvas, 'Chapter 3')).toHaveTextContent('Lin Mei 林梅');
    await expect(article(canvas, 'The Last Lantern')).not.toHaveTextContent('Because you follow');
  },
};

const everyone = { kind: 'recommended', basis: 'all' } as const;
/** A followed person's post, a stranger's, one with no Realm, a pick by someone followed, and a followed author's news. */
const whoLeads = page([
  post(43, {
    realm: realms.classics,
    actor: people.leo,
    target: { title: title('Persuasion') },
    reason: { kind: 'followed', target: people.leo.id, targetKind: 'agent' },
  }),
  post(44, {
    realm: realms.classics,
    actor: people.daniel,
    reason: everyone,
    target: { title: title('Emma') },
  }),
  post(45, {
    realm: null,
    actor: people.aria,
    reason: everyone,
    target: { title: title('Mansfield Park') },
  }),
  post(46, {
    kind: 'adoption',
    realm: realms.classics,
    actor: people.daniel,
    target: { title: title('Northanger Abbey') },
    reasons: [{ kind: 'realm-pick', realm: realms.classics.id, curator: people.daniel.id }],
    reason: { kind: 'followed', target: people.daniel.id, targetKind: 'agent' },
  }),
  { ...authorNews.items[0]!, id: storyId(47) },
]);

/**
 * Who a post leads with (docs/plan/frontend.md, "Who a post leads with"): the
 * person is the speaker and the Realm the venue, so a post leads with the
 * person the reader follows, or the person when there is no Realm, and
 * otherwise with the Realm. Every name leads to its page.
 */
export const WhoLeads: Story = {
  args: {
    initial: { ok: true, data: whoLeads },
    tab: 'all',
    query: { scope: 'all', sort: 'best' },
  },
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await expect(leading(canvas, 'Persuasion')).toHaveTextContent('Leo Sun');
    await expect(leading(canvas, 'Persuasion')).toHaveAttribute(
      'href',
      localizedPath(profileHref('leo_sun'), 'en'),
    );
    // A stranger's name says nothing yet, so the Realm leads; the person is still one link away.
    await expect(leading(canvas, 'Emma')).toHaveTextContent('Classic Literature');
    await expect(
      within(article(canvas, 'Emma')).getByRole('link', { name: 'Daniel Chen' }),
    ).toHaveAttribute('href', localizedPath(profileHref('daniel_chen'), 'en'));
    await expect(leading(canvas, 'Mansfield Park')).toHaveTextContent('Aria Wang 王雅');
    // A pick is the Realm's act: it leads, and the curator stays unnamed even to a follower.
    await expect(leading(canvas, 'Northanger Abbey')).toHaveTextContent('Classic Literature');
    await expect(article(canvas, 'Northanger Abbey')).not.toHaveTextContent('Daniel Chen');
    // All is REZICS-wide, so no card there says why it is here.
    await expect(canvas.getByRole('feed', { name: 'Posts' })).not.toHaveTextContent(
      'Because you follow',
    );
  },
};

export const BecauseYouFollowChinese: Story = {
  args: { initial: { ok: true, data: authorNews }, locale: 'zh-Hans' },
  globals: { locale: 'zh-Hans', viewport: { value: 'phone' } },
  async play({ canvasElement }) {
    await expect(article(within(canvasElement), 'Sanditon')).toHaveTextContent(
      '因为你关注了Jane Austen',
    );
  },
};

/** Signed out, taking part leads to sign-in and there is nothing to hide or mute. */
export const SignedOut: Story = {
  args: { signedIn: false, tab: 'all', followedRealms: null },
  async play({ canvasElement }) {
    const post = article(within(canvasElement), 'Chapters 212–214');
    await expect(
      within(post).getByRole('link', { name: 'Upvote — Sign in to vote, follow and save' }),
    ).toHaveAttribute('href', signInHref);
    await expect(within(post).getByRole('link', { name: `Follow ${realms.fiction.name.value} · Sign in` })).toHaveAttribute(
      'href',
      signInHref,
    );
    await expect(within(post).queryByRole('button', { name: 'More options' })).toBeNull();
  },
};

/** Following · New ends, and says the reader has seen everything, then offers All. */
export const CaughtUp: Story = {
  args: {
    query: { scope: 'following', sort: 'new' },
    initial: {
      ok: true,
      data: page(everyKind.slice(0, 2), {
        sort: 'new',
        caughtUp: {
          asOf: new Date(NOW).toISOString(),
          lastVisitedAt: new Date(NOW - 3 * 3_600_000).toISOString(),
          state: 'caught-up',
        },
      }),
    },
  },
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    const end = canvas.getByRole('region', { name: 'You’re all caught up' });
    await expect(end).toHaveTextContent('You last looked 3 hours ago.');
    await expect(within(end).getByRole('link', { name: 'Keep browsing All' })).toHaveAttribute(
      'href',
      '/en?tab=all',
    );
  },
};

/** Main is still adding recent activity: the end says more is coming rather than "caught up". */
export const StillArriving: Story = {
  args: {
    initial: {
      ok: true,
      data: page(everyKind.slice(0, 1), {
        sort: 'new',
        caughtUp: { asOf: new Date(NOW).toISOString(), lastVisitedAt: null, state: 'projecting' },
      }),
    },
  },
  async play({ canvasElement }) {
    await expect(within(canvasElement).getByText('More posts are on their way').closest('[role="status"]')).toBeVisible();
  },
};

/** The next page loads by itself near the end; "Show more posts" stays for keyboards. */
export const LoadMore: Story = {
  args: {
    api: memoryFeed({ pages: { c1: { ok: true, data: page(everyKind.slice(3, 5)) } } }),
    initial: { ok: true, data: page(everyKind.slice(0, 3), { nextCursor: 'c1' }) },
  },
  async play({ canvasElement, args }) {
    const canvas = within(canvasElement);
    await waitFor(() => expect(canvas.getAllByRole('article')).toHaveLength(5));
    await expect(args.api!.calls.filter((call) => call.startsWith('page:'))).toEqual(['page:c1']);
    await expect(canvas.getAllByRole('article').at(-1)).toHaveAttribute('aria-setsize', '5');
  },
};

/** The feed moved under the cursor: the reader is asked to refresh; the URL and its filters stay. */
export const CursorMoved: Story = {
  args: {
    api: memoryFeed({ pages: { c1: { ok: false, failure: 'moved' } } }),
    initial: { ok: true, data: page(everyKind.slice(0, 2), { nextCursor: 'c1' }) },
  },
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    const alert = await canvas.findByRole('alert');
    await expect(alert).toHaveTextContent('The feed changed while you were reading');
    await expect(within(alert).getByRole('button', { name: 'Refresh' })).toBeVisible();
    await expect(canvas.getAllByRole('article')).toHaveLength(2);
  },
};

/** The first page failed: in words, with the one fix. */
export const Failed: Story = {
  args: { initial: { ok: false, failure: 'unavailable' } },
  async play({ canvasElement }) {
    const alert = within(canvasElement).getByRole('alert');
    await expect(alert).toHaveTextContent('Couldn’t load your feed');
    await expect(within(alert).getByRole('button', { name: 'Try again' })).toBeVisible();
  },
};

/** Newer posts never push the reader's place; a pill offers them. */
export const NewPosts: Story = {
  args: {
    headInterval: 50,
    api: memoryFeed({
      head: {
        profile: 'home-feed-head-v1',
        scope: 'following',
        afterSequence: '40',
        newPosts: { value: 3, kind: 'exact' },
        state: 'current',
        projection: { sequence: '43', reviewSequence: '7', dataEpoch: 'story' },
      },
    }),
  },
  async play({ canvasElement }) {
    await expect(
      await within(canvasElement).findByRole('button', { name: '3 new posts' }),
    ).toBeVisible();
    await expect(within(canvasElement).getAllByRole('article')).toHaveLength(everyKind.length);
  },
};

export const Chinese: Story = {
  args: { locale: 'zh-Hans' },
  globals: { locale: 'zh-Hans' },
  async play({ canvasElement }) {
    const serial = article(within(canvasElement), '第 212–214 章');
    await expect(within(serial).getByRole('link', { name: '阅读第 212 章' })).toBeVisible();
    await expect(article(within(canvasElement), '第 58 章')).toHaveTextContent('读到这里前先隐藏');
  },
};

export const Dark: Story = { globals: { theme: 'dark' } };

export const UnscoredReviews: Story = {
  args: {
    initial: {
      ok: true,
      data: page(
        everyKind
          .filter((item) => item.card.kind === 'review')
          .map((item) => ({ ...item, card: { ...item.card, rating: null } })),
      ),
    },
  },
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await expect(canvas.getAllByRole('article')).toHaveLength(2);
    await expect(article(canvas, /Austen’s quietest novel/)).toHaveTextContent('Persuasion');
    await expect(canvas.getByText('This review discusses the plot')).toBeVisible();
    for (const review of canvas.getAllByRole('article')) {
      await expect(review).not.toHaveTextContent(/Rated|null|0\/|9\//);
      await expect(within(review).getByRole('link', { name: 'Read review' })).toBeVisible();
    }
  },
};

/** The distance between the bottom of one element and the top of the next, in CSS pixels. */
const gap = (above: Element, below: Element) =>
  below.getBoundingClientRect().top - above.getBoundingClientRect().bottom;
const style = (element: Element) => getComputedStyle(element);

/**
 * Posts breathe as X's rows do (`postRhythm`, measured on X on 2026-09-28):
 * 12 px above and below and 16 px at the sides at every width, a 17/24 title,
 * 15/20 text with CJK at 1.8, then 12 px before the Work and before a 20 px
 * action bar. Home once shrank posts to 80–110 px; this keeps them from it.
 */
async function expectRhythm(canvasElement: HTMLElement) {
  const canvas = within(canvasElement);
  const bennet = article(canvas, 'Is Mr. Bennet a good father?');
  await expect(style(bennet).padding).toBe('12px 16px');
  const title = within(bennet).getByRole('heading', { name: 'Is Mr. Bennet a good father?' });
  await expect([style(title).fontSize, style(title).lineHeight]).toEqual(['17px', '24px']);
  const preview = title.nextElementSibling!;
  await expect([style(preview).fontSize, style(preview).lineHeight]).toEqual(['15px', '20px']);
  const work = within(bennet).getByRole('link', { name: /^Pride and Prejudice/ });
  const bar = within(bennet).getByRole('group', { name: 'Actions' }).parentElement!;
  await expect(gap(preview, work)).toBe(12);
  await expect(gap(work, bar)).toBe(12);
  await expect(bar.getBoundingClientRect().height).toBe(20);
  // The bottom padding, then the one-pixel divider.
  await expect(bennet.getBoundingClientRect().bottom - bar.getBoundingClientRect().bottom).toBe(13);
  // Chinese words in an English page keep the CJK line.
  const words = within(article(canvas, 'A reply in a discussion')).getByText(/第一章很短/);
  await expect(style(words).lineHeight).toBe('27px');
}

export const Rhythm: Story = {
  args: {
    initial: {
      ok: true,
      data: page(everyKind.filter((item) => item.kind === 'discussion' || item.kind === 'reply')),
    },
  },
  play: ({ canvasElement }) => expectRhythm(canvasElement),
};

/** Phones keep X's 16 px sides and the same rhythm. */
export const RhythmPhone: Story = {
  ...Rhythm,
  globals: { viewport: { value: 'phone' } },
};

export const Phone: Story = {
  globals: { viewport: { value: 'phone' } },
  async play({ canvasElement }) {
    await expect(within(canvasElement).getAllByRole('article').length).toBeGreaterThan(0);
    await expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(window.innerWidth);
  },
};
