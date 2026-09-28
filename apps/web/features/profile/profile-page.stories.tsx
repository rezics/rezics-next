import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, waitFor, within } from 'storybook/test';
import { memoryReaderActions } from '../catalogue/fixtures.ts';
import { authorWorks, followState, memoryFollowActions, noWorks, organizationWorks, publicLibrary, shelfCards,
  storyId, storyProfile } from './fixtures.ts';
import { messages } from './messages.ts';
import zhHans from './messages/zh-Hans.ts';
import { ProfilePage, ProfileShelfPage, ProfileUnavailable, ProfileWorksPage } from './profile-page.tsx';

const zh = { ...messages, ...zhHans };
/** A Work row's credit line as read aloud: its names are links, so the line is matched whole. */
const creditLine = (text: string) => (_: string, element: Element | null) =>
  element?.matches('p.text-muted-foreground') === true && element.textContent === text;
const signedOut = { signedIn: false };
const signedIn = { signedIn: true, actingSubject: storyId(77), seed: {} };

const meta = {
  title: 'Profile/Page', component: ProfilePage,
  args: { profile: storyProfile(), works: { ok: true, data: authorWorks }, follow: { ok: true, data: followState(128) },
    library: publicLibrary(), reader: signedOut, locale: 'en', messages },
  parameters: { route: { pathname: '/en/@lin_mei' } },
  globals: { viewport: { value: 'desktop' } },
} satisfies Meta<typeof ProfilePage>;
export default meta;
type Story = StoryObj<typeof meta>;

/** An author who also reads in public: works first, as Goodreads leads an author page with their books. */
export const Author: Story = {
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole('heading', { level: 1, name: 'Lin Mei 林梅' })).toBeVisible();
    await expect(canvas.getByText('Author', { selector: 'p' })).toBeVisible();
    await expect(canvas.getByText('@lin_mei')).toBeVisible();
    await expect(canvas.getByText('128 followers')).toBeVisible();
    await expect(canvas.getByRole('tab', { name: 'Overview' })).toHaveAttribute('aria-selected', 'true');
    // Signed out, Follow leads to sign-in and comes back to this profile.
    await expect(canvas.getByRole('link', { name: /^Follow/ }))
      .toHaveAttribute('href', `/auth/start?next=${encodeURIComponent('/en/@lin_mei')}`);
    const works = within(canvas.getByRole('region', { name: 'Works by Lin Mei 林梅' }));
    await expect(works.getByText('5 works')).toBeVisible();
    await expect(works.getByText('186 ratings')).toBeVisible();
    await expect(works.getAllByRole('heading', { level: 3 })).toHaveLength(5);
    await expect(works.getByRole('link', { name: '雨夜书店 · 连载小说' }))
      .toHaveAttribute('href', `/en/w/${storyId(101).slice(-36)}`);
    await expect(works.getByText('Ongoing serial')).toBeVisible();
    // Generated covers print the credit too; the row's line is the one read out.
    await expect(works.getByText(creditLine('Lin Mei 林梅 (Translator)'))).toBeVisible();
    // Shelves: every status with its count, and the Works on each.
    const summary = within(canvas.getByRole('navigation', { name: 'Bookshelves' }));
    await expect(summary.getByRole('link', { name: 'Read 48' })).toHaveAttribute('href', '/en/@lin_mei/shelves/read');
    await expect(canvas.getByRole('heading', { level: 2, name: 'Currently reading 2' })).toBeVisible();
  },
};

export const PostsAndComments: Story = {
  args: { contributionsRead: async kind => ({ items: kind === 'posts' ? [{ reply: storyId(901),
    realm: storyId(902), parent: null, time: '2026-09-28T10:00:00Z', title: 'A first post',
    excerpt: 'What should I read next?' }] : [{ reply: storyId(903), realm: storyId(902),
    parent: storyId(901), time: '2026-09-28T09:00:00Z', title: null,
    excerpt: 'A **great** recommendation.' }], nextCursor: null }) },
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole('tab', { name: 'Posts' }));
    await expect(await canvas.findByRole('link', { name: 'A first post' })).toBeVisible();
    await userEvent.click(canvas.getByRole('tab', { name: 'Comments' }));
    await expect(await canvas.findByText('great')).toHaveProperty('tagName', 'STRONG');
    await userEvent.click(canvas.getByRole('tab', { name: 'Overview' }));
    await expect(canvas.getByRole('heading', { name: 'Works by Lin Mei 林梅' })).toBeVisible();
  },
};

/** The bio is folded to a few lines, as Goodreads folds an author's. */
export const LongBio: Story = {
  globals: { viewport: { value: 'phone' } },
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    const toggle = await canvas.findByRole('button', { name: 'Show more' });
    await userEvent.click(toggle);
    await expect(canvas.getByRole('button', { name: 'Show less' })).toHaveAttribute('aria-expanded', 'true');
  },
};

/** Following shows at once and the count moves with it; pressing again stops following. */
export const Follow: Story = {
  args: { reader: signedIn, follow: { ok: true, data: followState(128, false) }, followActions: memoryFollowActions(),
    readerActions: memoryReaderActions() },
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole('button', { name: 'Follow · Lin Mei 林梅' }));
    await expect(canvas.getByRole('button', { name: 'Following · Unfollow Lin Mei 林梅' })).toBeVisible();
    await expect(canvas.getByText('129 followers')).toBeVisible();
    await waitFor(() => expect(canvas.getByRole('button', { name: /^Following/ })).not.toHaveAttribute('aria-disabled', 'true'));
    await userEvent.click(canvas.getByRole('button', { name: /^Following/ }));
    await expect(canvas.getByRole('button', { name: 'Follow · Lin Mei 林梅' })).toBeVisible();
    await expect(canvas.getByText('128 followers')).toBeVisible();
  },
};

/** Another tab changed the follow first: the control reads it again and applies the press once more. */
export const FollowAfterAnotherTab: Story = {
  args: { reader: signedIn, follow: { ok: true, data: followState(128, false) },
    followActions: memoryFollowActions({ stale: true }), readerActions: memoryReaderActions() },
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole('button', { name: 'Follow · Lin Mei 林梅' }));
    await waitFor(() => expect(canvas.getByRole('button', { name: /^Following/ })).not.toHaveAttribute('aria-disabled', 'true'));
    await expect(canvas.queryByText('Couldn’t update. Try again.')).toBeNull();
  },
};

/** Main refused: the press is taken back and the page says so. */
export const FollowFails: Story = {
  args: { reader: signedIn, follow: { ok: true, data: followState(128, false) },
    followActions: memoryFollowActions({ fail: true }), readerActions: memoryReaderActions() },
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole('button', { name: 'Follow · Lin Mei 林梅' }));
    await expect(await canvas.findByText('Couldn’t update. Try again.')).toBeVisible();
    await expect(canvas.getByRole('button', { name: 'Follow · Lin Mei 林梅' })).toBeVisible();
    await expect(canvas.getByText('128 followers')).toBeVisible();
  },
};

/** A reader without credits: the page leads with their shelves. */
export const Reader: Story = {
  args: { profile: storyProfile({ displayName: 'Daniel Chen 陈丹尼', handle: 'daniel_chen', bio: null }),
    works: { ok: true, data: noWorks }, follow: { ok: true, data: followState(3, null) } },
  parameters: { route: { pathname: '/en/@daniel_chen' } },
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await expect(canvas.getByText('Reader', { selector: 'p' })).toBeVisible();
    await expect(canvas.queryByRole('region', { name: /^Works by/ })).toBeNull();
    await expect(canvas.getByRole('heading', { level: 2, name: 'Daniel Chen 陈丹尼’s bookshelves' })).toBeVisible();
    await expect(canvas.getAllByRole('link', { name: 'See all' })).toHaveLength(3);
  },
};

/** Shelves Main keeps private are named as private, never counted. */
export const PrivateShelves: Story = {
  args: { library: { kind: 'private', visibility: 'private' },
    profile: storyProfile({ library: { visibility: 'private', statusShelvesVisible: false } }) },
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await expect(canvas.getByText('Lin Mei 林梅 keeps their bookshelves private.')).toBeVisible();
    await expect(canvas.queryByRole('navigation', { name: 'Bookshelves' })).toBeNull();
  },
};

export const FollowersOnlyShelves: Story = {
  args: { works: { ok: true, data: noWorks }, library: { kind: 'private', visibility: 'followers' },
    profile: storyProfile({ bio: null, library: { visibility: 'followers', statusShelvesVisible: false } }) },
  async play({ canvasElement }) {
    await expect(within(canvasElement).getByText('Lin Mei 林梅 shares their bookshelves with followers only.'))
      .toBeVisible();
  },
};

/**
 * The owner sees their own non-public shelves, marked as visible only to them, and edits instead of following.
 * Their own Works carry no "Want to read".
 */
export const OwnProfile: Story = {
  args: { reader: { signedIn: true, actingSubject: storyId(1), seed: {} }, library: publicLibrary(true),
    readerActions: memoryReaderActions(),
    profile: storyProfile({ library: { visibility: 'private', statusShelvesVisible: true } }) },
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole('link', { name: 'Edit profile' })).toHaveAttribute('href', '/en/settings');
    await expect(canvas.queryByRole('button', { name: /^Follow/ })).toBeNull();
    await expect(canvas.getByText('Only you can see your bookshelves.')).toBeVisible();
    const works = within(canvas.getByRole('region', { name: 'Works by Lin Mei 林梅' }));
    await expect(works.queryByRole('button', { name: 'Want to read' })).toBeNull();
  },
};

/** On someone else's profile the shelf button is a quiet outline, so the Works lead, not five blue pills. */
export const ShelfButtonsAreQuiet: Story = {
  args: { reader: signedIn, readerActions: memoryReaderActions() },
  async play({ canvasElement }) {
    const works = within(within(canvasElement).getByRole('region', { name: 'Works by Lin Mei 林梅' }));
    const buttons = works.getAllByRole('button', { name: 'Want to read' });
    await expect(buttons).toHaveLength(5);
    for (const button of buttons) await expect(button).toHaveAttribute('data-variant', 'outline');
  },
};

/** An organization lists the Works it is credited on, with its role; more than one page links to all of them. */
export const Organization: Story = {
  args: { profile: storyProfile({ kind: 'organization', displayName: 'North Star Editions · 北辰出版',
    handle: 'northstar', bio: { language: 'en', text: 'North Star Editions edits public-domain classics for '
      + 'readers of English and Chinese, with notes on the text and its history.' } }),
  works: { ok: true, data: organizationWorks }, library: null, follow: { ok: true, data: followState(1000, null,
    'lower-bound') } },
  parameters: { route: { pathname: '/en/@northstar' } },
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await expect(canvas.getByText('Organization', { selector: 'p' })).toBeVisible();
    await expect(canvas.getByText('1,000+ followers')).toBeVisible();
    await expect(canvas.getByText('4+ works')).toBeVisible();
    await expect(canvas.getAllByText(creditLine('North Star Editions · 北辰出版 (Editor)')))
      .toHaveLength(4);
    await expect(canvas.getByRole('link', { name: 'All works' })).toHaveAttribute('href', '/en/@northstar/works');
  },
};

/** Nothing public yet: one quiet line about what will appear, instead of empty sections. */
export const NothingYet: Story = {
  args: { profile: storyProfile({ bio: null, displayName: 'Leo Sun 孙乐', handle: 'leo_sun' }),
    works: { ok: true, data: noWorks }, follow: { ok: true, data: followState(0) },
    library: { kind: 'shelves', own: false, shelves: [
      { status: 'reading', count: 0, works: { ok: true, data: [] } },
      { status: 'read', count: 0, works: { ok: true, data: [] } },
      { status: 'want-to-read', count: 0, works: { ok: true, data: [] } }] } },
  async play({ canvasElement }) {
    await expect(within(canvasElement).getByRole('heading', { name: 'Leo Sun 孙乐 hasn’t shared anything yet' }))
      .toBeVisible();
  },
};

/** Each region that could not load says so on its own, and the rest of the profile stays. */
export const RegionsUnavailable: Story = {
  args: { works: { ok: false, failure: 'unavailable' }, follow: { ok: false, failure: 'unavailable' },
    library: { kind: 'shelves', own: false, shelves: [
      { status: 'reading', count: 2, works: { ok: false, failure: 'unavailable' } },
      { status: 'read', count: 48, works: { ok: true, data: shelfCards.read } },
      { status: 'want-to-read', count: 0, works: { ok: true, data: [] } }] } },
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole('heading', { name: 'Couldn’t load works' })).toBeVisible();
    await expect(canvas.getByRole('heading', { name: 'Couldn’t load this shelf' })).toBeVisible();
    await expect(canvas.getByRole('heading', { level: 2, name: 'Read 48' })).toBeVisible();
    await expect(canvas.queryByText(/followers/)).toBeNull();
  },
};

export const Chinese: Story = {
  args: { locale: 'zh-Hans', messages: zh, profile: storyProfile({ bio: { language: 'zh-Hans',
    text: '月下书生是林梅的笔名。写志怪、旧梦和夜里的书店，偶尔重讲《聊斋》里的故事。' },
  displayName: '月下书生 · Moonlit Scribe', handle: 'moonlitscribe' }) },
  globals: { locale: 'zh-Hans' },
  parameters: { route: { pathname: '/zh-Hans/@moonlitscribe' } },
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await expect(canvas.getByText('作者', { selector: 'p' })).toBeVisible();
    await expect(canvas.getByRole('heading', { level: 2, name: '月下书生 · Moonlit Scribe的作品' })).toBeVisible();
    await expect(canvas.getByText('128 位关注者')).toBeVisible();
    await expect(canvas.getByRole('link', { name: '读过 48' }))
      .toHaveAttribute('href', '/zh-Hans/@moonlitscribe/shelves/read');
  },
};

export const Phone: Story = { globals: { viewport: { value: 'phone' } } };

export const Dark: Story = { globals: { theme: 'dark' } };

export const Unavailable: StoryObj<typeof ProfileUnavailable> = {
  render: () => <ProfileUnavailable handle="lin_mei" locale="en" messages={messages} />,
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole('heading', { level: 1, name: 'Couldn’t load this profile' })).toBeVisible();
    await expect(canvas.getByRole('link', { name: 'Retry' })).toHaveAttribute('href', '/en/@lin_mei');
  },
};

/** One shelf in full, twenty covers to a page. */
export const Shelf: StoryObj<typeof ProfileShelfPage> = {
  parameters: { route: { pathname: '/en/@lin_mei/shelves/read' } },
  render: () => <ProfileShelfPage profile={storyProfile()} status="read" cursor="page-2"
    shelf={{ ok: true, data: { count: 48, cards: shelfCards.read, nextCursor: 'page-3' } }} reader={signedOut}
    locale="en" messages={messages} />,
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole('heading', { level: 1, name: 'Read 48' })).toBeVisible();
    await expect(canvas.getByRole('link', { name: /Lin Mei 林梅/ })).toHaveAttribute('href', '/en/@lin_mei');
    await expect(canvas.getByRole('link', { name: 'First page' })).toHaveAttribute('href', '/en/@lin_mei/shelves/read');
    await expect(canvas.getByRole('link', { name: 'Next page' }))
      .toHaveAttribute('href', '/en/@lin_mei/shelves/read?cursor=page-3');
  },
};

/** A later page after the list changed: start again from the first page. */
export const ShelfMoved: StoryObj<typeof ProfileShelfPage> = {
  render: () => <ProfileShelfPage profile={storyProfile()} status="want-to-read" cursor="stale"
    shelf={{ ok: false, failure: 'moved' }} reader={signedOut} locale="en" messages={messages} />,
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole('heading', { name: 'This list changed while you were paging' })).toBeVisible();
    await expect(canvas.getAllByRole('link', { name: 'First page' })[0])
      .toHaveAttribute('href', '/en/@lin_mei/shelves/want-to-read');
  },
};

export const AllWorks: StoryObj<typeof ProfileWorksPage> = {
  render: () => <ProfileWorksPage profile={storyProfile({ kind: 'organization', displayName: 'North Star Editions',
    handle: 'northstar' })} works={{ ok: true, data: organizationWorks }} reader={signedOut} locale="en"
  messages={messages} />,
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole('heading', { level: 1, name: 'Works by North Star Editions' })).toBeVisible();
    await expect(canvas.getByRole('link', { name: 'Next page' }))
      .toHaveAttribute('href', '/en/@northstar/works?cursor=story-next');
  },
};
