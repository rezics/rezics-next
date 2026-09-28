import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, screen, userEvent, waitFor, within } from 'storybook/test';
import type { UiLocale } from '../../i18n/define.ts';
import { memoryReaderActions } from '../catalogue/fixtures.ts';
import { ReaderActionsProvider } from '../catalogue/reader-actions.tsx';
import { FeedProvider } from './feed-context.tsx';
import { FeedList } from './feed-list.tsx';
import { everyKind, memoryFeed, type MemoryFeed, NOW, page, post, realms, storyId, suggestion } from './fixtures.ts';
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
}

const signInHref = '/auth/start?next=%2Fen';

function Feed({ initial, query = { scope: 'following', sort: 'best' }, api = memoryFeed(), signedIn = true,
  tab = 'following', followedRealms = [realms.fiction.id], locale = 'en', headInterval }: Args) {
  return <FeedProvider locale={locale} messages={locale === 'zh-Hans' ? { ...messages, ...zhHans } : messages} now={NOW}
    signedIn={signedIn} actingSubject={signedIn ? storyId(801, 'bbbb') : null} signInHref={signInHref} avatarQuery=""
    tab={tab} followedRealms={followedRealms} api={api}>
    <ReaderActionsProvider signedIn={signedIn} signInHref={signInHref}
      actions={signedIn ? memoryReaderActions({}) : undefined}>
      <div className="mx-auto max-w-3xl py-6 sm:px-6">
        <section aria-label="Posts" className="border-border/60 border-y bg-card sm:rounded-2xl sm:border">
          <FeedList initial={initial} query={query} allHref="/en?tab=all" headInterval={headInterval}
            empty={<p>Nothing here</p>} />
        </section>
      </div>
    </ReaderActionsProvider>
  </FeedProvider>;
}

const meta = {
  title: 'Feed/Posts',
  component: Feed,
  args: { initial: { ok: true, data: page(everyKind) } },
  globals: { viewport: { value: 'desktop' } },
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

    // Three chapters from one day arrive as one post; its action opens the first of them.
    const serial = article(canvas, '雨夜书店');
    await expect(serial).toHaveTextContent('Chapters 212–214');
    await expect(within(serial).getByRole('heading', { name: '雨夜书店' })).toHaveAttribute('lang', 'zh-Hans');
    await expect(within(serial).getByRole('link', { name: 'Read chapter 212' })).toHaveAttribute('href',
      expect.stringMatching(/^\/en\/w\/.+\/read\//));
    await expect(within(serial).getByRole('link', { name: '41 comments' })).toBeVisible();

    // Past the reader's position, a chapter's text stays hidden.
    const behind = article(canvas, 'The Last Lantern');
    await expect(behind).toHaveTextContent('Chapter 58');
    await expect(behind).toHaveTextContent('Hidden until you catch up');

    // Counts Main cannot prove exactly say "at least"; big scores are compact.
    const novel = article(canvas, 'Middlemarch: A Study of Provincial Life');
    await expect(within(novel).getByRole('link', { name: '64+ comments' })).toBeVisible();
    await expect(within(novel).getByLabelText('1,830 points')).toHaveTextContent('1.8K');

    // Each kind's own action.
    await expect(within(article(canvas, 'Crop Planner for Stardew Valley')).getByRole('link', { name: 'Install' }))
      .toBeVisible();
    await expect(article(canvas, 'Crop Planner for Stardew Valley')).toHaveTextContent('Version 2.4.0');
    await expect(within(article(canvas, 'Bilingual book club discussion prompt')).getByRole('link', { name: 'Use prompt' }))
      .toBeVisible();
    await expect(within(novel).getByRole('button', { name: 'Want to read' })).toBeVisible();

    // A pick is the Realm's act: the curator is not named where the Work's author would be; the author is.
    // A card gives one reason, and the pick outranks the Work being new.
    const pick = article(canvas, 'Jane Eyre');
    await expect(pick).toHaveTextContent('Picked by Classic Literature');
    await expect(pick).not.toHaveTextContent('New work');
    await expect(within(pick).queryByText('Daniel Chen')).toBeNull();
    await expect(pick).toHaveTextContent('by Charlotte Brontë');
    await expect(article(canvas, 'Middlemarch: A Study of Provincial Life')).toHaveTextContent('by George Eliot');

    // An import is added to REZICS, not a new work by whoever added it.
    const alice = article(canvas, 'Alice’s Adventures in Wonderland');
    await expect(alice).toHaveTextContent('Added to REZICS');
    await expect(alice).toHaveTextContent('by Lewis Carroll');
    await expect(alice).not.toHaveTextContent('New work');
    // An author on REZICS links to their profile.
    await expect(within(article(canvas, '雨夜书店 · 番外')).getByRole('link', { name: 'Lin Mei 林梅' }))
      .toHaveAttribute('href', '/en/@lin_mei');

    // A review: the reader's stars and opening lines, leading to the review on the Work page.
    const review = article(canvas, 'Persuasion');
    await expect(review).toHaveTextContent('Rated 4 out of 5');
    await expect(review).toHaveTextContent('Anne Elliot has already lost once');
    await expect(review).toHaveTextContent('12 found this helpful');
    await expect(within(review).getByRole('link', { name: 'Read review' })).toHaveAttribute('href',
      expect.stringMatching(/^\/en\/w\/.+#review-/));
    const spoiler = article(canvas, '长夜将明');
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
    await expect(within(list).queryByRole('link', { name: 'Autumn reading: slow novels' })).toBeNull();
    await expect(within(list).queryByRole('link', { name: /comment/ })).toBeNull();
    const inList = within(list).getByRole('list', { name: 'In this list' });
    await expect(within(inList).getAllByRole('link').map(link => link.getAttribute('aria-label')))
      .toEqual(['Middlemarch', '雨夜书店', 'Ginger lemon tea']);
    await expect(inList.querySelectorAll('[data-slot="work-cover"][data-kind="recipe"]')).toHaveLength(1);
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
    const post = article(within(canvasElement), '雨夜书店');
    const up = within(post).getByRole('button', { name: 'Upvote' });
    await userEvent.click(up);
    await waitFor(() => expect(up).toHaveAttribute('aria-pressed', 'true'));
    await expect(within(post).getByLabelText('249 points')).toBeVisible();
    await userEvent.click(up);
    await waitFor(() => expect(up).toHaveAttribute('aria-pressed', 'false'));
    await expect(args.api!.calls.filter(call => !call.startsWith('watermark'))).toEqual(['vote:9f40:1', 'vote:9f40:0']);
  },
};

/** Main refused the vote: it goes back to what Main had, and says so. */
export const VoteRefused: Story = {
  args: { api: memoryFeed({ refuse: 'moved' }) },
  async play({ canvasElement }) {
    const post = article(within(canvasElement), '雨夜书店');
    await userEvent.click(within(post).getByRole('button', { name: 'Downvote' }));
    await waitFor(() => expect(within(post).getByRole('status')).toHaveTextContent('Couldn’t save your vote'));
    await expect(within(post).getByRole('button', { name: 'Downvote' })).toHaveAttribute('aria-pressed', 'false');
    await expect(within(post).getByLabelText('248 points')).toBeVisible();
  },
};

/** Hiding a post leaves one line that says so, with Undo. */
export const HideAndUndo: Story = {
  args: { api: memoryFeed() },
  async play({ canvasElement, args }) {
    const canvas = within(canvasElement);
    await userEvent.click(within(article(canvas, 'Jane Eyre')).getByRole('button', { name: 'More options' }));
    await userEvent.click(await screen.findByRole('menuitem', { name: 'Hide' }));
    const status = await canvas.findByText('Post hidden. You won’t see it again.');
    await expect(canvas.queryByRole('article', { name: 'Jane Eyre' })).toBeNull();
    await userEvent.click(within(status.closest('[role="status"]') as HTMLElement).getByRole('button', { name: 'Undo' }));
    await waitFor(() => expect(article(canvas, 'Jane Eyre')).toBeVisible());
    await expect(args.api!.calls.filter(call => !call.startsWith('watermark'))).toEqual(['feedback:activity:hide', 'feedback:activity:clear']);
  },
};

/** In All, a Realm the reader does not follow offers Join; joined, it says so. */
export const JoinFromAll: Story = {
  args: { tab: 'all', followedRealms: [], api: memoryFeed(), query: { scope: 'all', sort: 'best' },
    initial: { ok: true, data: page([post(30, { realm: realms.kitchen, reason: { kind: 'recommended', basis: 'all' },
      target: { title: { value: 'Ginger lemon tea', language: 'en', direction: 'ltr', basis: 'requested' } } })],
    { scope: 'all' }) } },
  async play({ canvasElement, args }) {
    const post = article(within(canvasElement), 'Ginger lemon tea');
    // In All every post is REZICS-wide, so no "Suggested" label repeats on each.
    await expect(post).not.toHaveTextContent('Suggested');
    await userEvent.click(within(post).getByRole('button', { name: 'Join Home Cooking · 家常菜' }));
    await waitFor(() => expect(post).toHaveTextContent('Joined'));
    await expect(args.api!.calls.filter(call => !call.startsWith('watermark'))).toEqual([`follow:${realms.kitchen.id.slice(-4)}:true`]);
  },
};

/** Inside Following, a suggestion is the exception, so it is labelled with why. */
export const SuggestionInFollowing: Story = {
  args: { initial: { ok: true, data: page([everyKind[0]!, suggestion]) } },
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await expect(within(article(canvas, 'Weekend buttermilk pancakes')).getByText('Suggested'))
      .toHaveAttribute('title', 'Suggested while your communities are quiet');
    await expect(article(canvas, '雨夜书店')).not.toHaveTextContent('Suggested');
  },
};

/** Signed out, taking part leads to sign-in and there is nothing to hide or mute. */
export const SignedOut: Story = {
  args: { signedIn: false, tab: 'all', followedRealms: null },
  async play({ canvasElement }) {
    const post = article(within(canvasElement), '雨夜书店');
    await expect(within(post).getByRole('link', { name: 'Upvote — Sign in to vote, join and save' }))
      .toHaveAttribute('href', signInHref);
    await expect(within(post).getByRole('link', { name: /^Join .+ — Sign in/ })).toHaveAttribute('href', signInHref);
    await expect(within(post).queryByRole('button', { name: 'More options' })).toBeNull();
  },
};

/** Following · New ends, and says the reader has seen everything, then offers All. */
export const CaughtUp: Story = {
  args: { query: { scope: 'following', sort: 'new' },
    initial: { ok: true, data: page(everyKind.slice(0, 2), { sort: 'new',
      caughtUp: { asOf: new Date(NOW).toISOString(), lastVisitedAt: new Date(NOW - 3 * 3_600_000).toISOString(),
        state: 'caught-up' } }) } },
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    const end = canvas.getByRole('region', { name: 'You’re all caught up' });
    await expect(end).toHaveTextContent('You last looked 3 hours ago.');
    await expect(within(end).getByRole('link', { name: 'Keep browsing All' })).toHaveAttribute('href', '/en?tab=all');
  },
};

/** Main is still adding recent activity: the end says more is coming rather than "caught up". */
export const StillArriving: Story = {
  args: { initial: { ok: true, data: page(everyKind.slice(0, 1), { sort: 'new',
    caughtUp: { asOf: new Date(NOW).toISOString(), lastVisitedAt: null, state: 'projecting' } }) } },
  async play({ canvasElement }) {
    await expect(within(canvasElement).getByRole('status')).toHaveTextContent('More posts are on their way');
  },
};

/** The next page loads by itself near the end; "Show more posts" stays for keyboards. */
export const LoadMore: Story = {
  args: { api: memoryFeed({ pages: { c1: { ok: true, data: page(everyKind.slice(3, 5)) } } }),
    initial: { ok: true, data: page(everyKind.slice(0, 3), { nextCursor: 'c1' }) } },
  async play({ canvasElement, args }) {
    const canvas = within(canvasElement);
    await waitFor(() => expect(canvas.getAllByRole('article')).toHaveLength(5));
    await expect(args.api!.calls.filter(call => call.startsWith('page:'))).toEqual(['page:c1']);
    await expect(canvas.getAllByRole('article').at(-1)).toHaveAttribute('aria-setsize', '5');
  },
};

/** The feed moved under the cursor: the reader is asked to refresh; the URL and its filters stay. */
export const CursorMoved: Story = {
  args: { api: memoryFeed({ pages: { c1: { ok: false, failure: 'moved' } } }),
    initial: { ok: true, data: page(everyKind.slice(0, 2), { nextCursor: 'c1' }) } },
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
  args: { headInterval: 50, api: memoryFeed({ head: { profile: 'home-feed-head-v1', scope: 'following',
    afterSequence: '40', newPosts: { value: 3, kind: 'exact' }, state: 'current',
    projection: { sequence: '43', reviewSequence: '7', dataEpoch: 'story' } } }) },
  async play({ canvasElement }) {
    await expect(await within(canvasElement).findByRole('button', { name: '3 new posts' })).toBeVisible();
    await expect(within(canvasElement).getAllByRole('article')).toHaveLength(everyKind.length);
  },
};

export const Chinese: Story = {
  args: { locale: 'zh-Hans' },
  globals: { locale: 'zh-Hans' },
  async play({ canvasElement }) {
    const serial = article(within(canvasElement), '雨夜书店');
    await expect(serial).toHaveTextContent('第 212–214 章');
    await expect(within(serial).getByRole('link', { name: '阅读第 212 章' })).toBeVisible();
    await expect(article(within(canvasElement), 'The Last Lantern')).toHaveTextContent('读到这里前先隐藏');
  },
};

export const Dark: Story = { globals: { theme: 'dark' } };

export const Phone: Story = {
  globals: { viewport: { value: 'phone' } },
  async play({ canvasElement }) {
    await expect(within(canvasElement).getAllByRole('article').length).toBeGreaterThan(0);
    await expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(window.innerWidth);
  },
};
