import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, waitFor, within } from 'storybook/test';
import type { UiLocale } from '../../i18n/define.ts';
import { memoryReaderActions } from '../catalogue/fixtures.ts';
import { everyKind, memoryFeed, NOW, page, post, realms, storyId, suggestion } from '../feed/fixtures.ts';
import { messages as feed } from '../feed/messages.ts';
import feedZhHans from '../feed/messages/zh-Hans.ts';
import { type FeedDefaults, type FeedState, feedQuery } from '../feed/state.ts';
import type { FeedPage, Loaded } from '../feed/types.ts';
import { continueItems, followedCommunities, officialZones, railData, suggestions } from './fixtures.ts';
import { HomePage, type HomePageProps, HomePosts } from './home-page.tsx';
import { messages as home } from './messages.ts';
import homeZhHans from './messages/zh-Hans.ts';
import { Rail } from './rail.tsx';

// Home as each kind of visitor meets it, over an in-memory Main. The feed's
// own rules are in Feed/Posts; these stories carry the frame: signed out,
// a new person's first Home, a returning reader, and filters that name why a
// view is empty and never switch to another view on their own.

const kinds = { books: 'Books & web novels', software: 'Mods & software', ai: 'AI skills & prompts',
  recipes: 'Recipes', media: 'Film & media', discussions: 'Discussions' };
const reader = storyId(801, 'bbbb');
const name = (value: string) => ({ value, language: 'en', direction: 'ltr' as const, basis: 'requested' as const });
const signInHref = '/auth/start?next=%2Fen';
const following: FeedDefaults = { tab: 'following', sort: 'best' };
const state = (change: Partial<FeedState> = {}): FeedState =>
  ({ tab: 'following', sort: 'best', window: 'week', kind: null, languages: [], realms: [], ...change });

type Args = HomePageProps & { withRail?: boolean };

/** A Home over the in-memory Main; `page` and `personalRefused` shape the posts, as the route's read does. */
function props(options: { signedIn?: boolean; state?: FeedState; page?: Loaded<FeedPage>; locale?: UiLocale;
  personalRefused?: boolean } & Partial<Args> = {}): Args {
  const { signedIn = true, locale = 'en', page: shown, personalRefused, ...rest } = options;
  const view = options.state ?? state(signedIn ? {} : { tab: 'all' });
  const zh = locale === 'zh-Hans';
  const messages = { home: zh ? { ...home, ...homeZhHans } : home, feed: zh ? { ...feed, ...feedZhHans } : feed };
  const defaults: FeedDefaults = signedIn ? following : { tab: 'all', sort: 'best' };
  return {
    locale, now: NOW, signedIn, actingSubject: signedIn ? reader : null, avatarQuery: '', messages,
    state: view, defaults,
    posts: <HomePosts locale={locale} messages={messages.feed} signedIn={signedIn} actingSubject={signedIn ? reader : null}
      signInHref={signInHref} state={view} defaults={defaults} personalRefused={personalRefused}
      query={feedQuery(view, { language: locale, ...(signedIn ? { actingSubject: reader } : {}) })}
      page={shown ?? { ok: true, data: page(signedIn ? [everyKind[0]!, suggestion, ...everyKind.slice(1, 4)]
        : everyKind.slice(2, 6), { scope: view.tab }) }}
      readerActions={signedIn ? memoryReaderActions({}) : undefined} />,
    newPerson: false, followed: signedIn ? followedCommunities : null, continueItems: null, official: officialZones,
    interests: { kinds: [], languages: [locale] }, pickerSkipped: false, welcomeDismissed: false,
    signInHref, signUpHref: `${signInHref}&create=1`, api: memoryFeed({ suggestions }),
    ...rest,
  };
}

const meta = {
  title: 'Home/Page',
  component: HomePage,
  render: ({ withRail = true, ...args }: Args) => <HomePage {...args} rail={withRail
    ? <Rail data={args.signedIn ? railData : { ...railData, moderated: [], trending: { ...railData.trending, scope: 'global' } }}
      signedIn={args.signedIn} locale={args.locale} messages={args.messages.home} kinds={kinds} /> : undefined} />,
  parameters: { route: { pathname: '/en' } },
  globals: { viewport: { value: 'desktop' } },
} satisfies Meta<Args>;
export default meta;
type Story = StoryObj<typeof meta>;

/** Signed out: the official Zones, why to join, and All · Best with its sort in view. */
export const SignedOut: Story = {
  args: props({ signedIn: false }),
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole('heading', { level: 1, name: 'Home' })).toBeInTheDocument();
    const zones = canvas.getByRole('region', { name: /Official Zones/ });
    await expect(within(zones).getByRole('link', { name: 'Fiction · 小说' })).toHaveAttribute('href', '/en/r/fiction');
    await expect(canvas.getByRole('link', { name: 'Join REZICS' })).toHaveAttribute('href', `${signInHref}&create=1`);
    // There is no Following without an account; the sort is never hidden.
    await expect(canvas.queryByRole('navigation', { name: 'Feed' })).toBeNull();
    const sort = canvas.getByRole('navigation', { name: 'Sort' });
    await expect(within(sort).getByRole('link', { name: 'Best' })).toHaveAttribute('aria-current', 'page');
    await expect(within(sort).getByRole('link', { name: 'Top' })).toHaveAttribute('href', '/en?sort=top');
    const rail = canvas.getByRole('complementary', { name: 'More on REZICS' });
    await expect(within(rail).getByRole('region', { name: 'Popular Realms' })).toBeVisible();
    await expect(within(rail).getByRole('region', { name: 'Trending this week' })).toBeVisible();
    await userEvent.click(canvas.getByRole('button', { name: 'Dismiss' }));
    await expect(canvas.queryByRole('link', { name: 'Join REZICS' })).toBeNull();
    await expect(document.cookie).toContain('rezics_home_welcome=dismissed');
  },
};

/** A returning reader: Continue first, then Following, with the queue and trending beside it. */
export const ReturningReader: Story = {
  args: props({ continueItems }),
  async play({ canvasElement, args }) {
    const canvas = within(canvasElement);
    const strip = canvas.getByRole('region', { name: 'Continue reading' });
    const next = within(strip).getByRole('link', { name: 'Continue “雨夜书店”' });
    await expect(next).toHaveAttribute('href', expect.stringMatching(/^\/en\/w\/.+\/read\//));
    await expect(next).toHaveTextContent('3 new');
    await expect(next).toHaveTextContent('Next: 第三章 最后一班车');
    await expect(within(strip).getByRole('link', { name: 'Continue “The Last Lantern”' })).toHaveTextContent('20+ new');

    await userEvent.click(within(strip).getByRole('button', { name: 'Hide “Middlemarch” from Continue' }));
    await expect(within(strip).getByRole('status')).toHaveTextContent('“Middlemarch” is hidden from Continue.');
    await expect(within(strip).queryByRole('link', { name: 'Continue “Middlemarch”' })).toBeNull();
    await userEvent.click(within(strip).getByRole('button', { name: 'Undo' }));
    await waitFor(() => expect(within(strip).getByRole('link', { name: 'Continue “Middlemarch”' })).toBeVisible());
    await expect((args.api as ReturnType<typeof memoryFeed>).calls.filter(call => call.startsWith('continue')))
      .toEqual([`continue:${storyId(63, 'cccc').slice(-4)}:true`, `continue:${storyId(63, 'cccc').slice(-4)}:false`]);

    const tabs = canvas.getByRole('navigation', { name: 'Feed' });
    await expect(within(tabs).getByRole('link', { name: 'Following' })).toHaveAttribute('aria-current', 'page');
    // Top ranks across REZICS, so Following offers Best and New.
    await expect(within(canvas.getByRole('navigation', { name: 'Sort' })).queryByRole('link', { name: 'Top' })).toBeNull();
    const queue = canvas.getByRole('region', { name: 'Your moderation queue' });
    await expect(queue).toHaveTextContent('20+ waiting');
    await expect(within(canvas.getByRole('region', { name: 'Trending in your Realms' })).getAllByRole('listitem'))
      .toHaveLength(4);
    await userEvent.click(canvas.getByText('How Home works'));
    await expect(canvas.getByText(/fading over about 24 hours/)).toBeVisible();
    await expect(canvas.getByText('No Realm fills more than 3 of any 10 posts in a row.')).toBeVisible();
  },
};

/**
 * Follow state is one fact wherever it shows: a Realm followed through its
 * Zone offers no Join on its posts, and following from the rail takes Join
 * off that Realm's posts at once, without a reload.
 */
export const FollowStateEverywhere: Story = {
  args: props({ state: state({ tab: 'all' }),
    followed: { realms: [], complete: true, zones: [{ id: storyId(957, 'aaaa'), kind: 'zone', realm: realms.kitchen.id,
      name: 'Kitchen · 厨房', language: 'en', icon: null, href: '/r/kitchen', activity: 'none' }] },
    page: { ok: true, data: page([
      post(40, { realm: realms.kitchen, reason: { kind: 'recommended', basis: 'all' }, target: { title: name('Ginger lemon tea') } }),
      post(41, { realm: realms.mods, reason: { kind: 'recommended', basis: 'all' }, target: { title: name('Fence planner') } }),
    ], { scope: 'all' }) } }),
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    const tea = canvas.getByRole('article', { name: 'Ginger lemon tea' });
    const fences = canvas.getByRole('article', { name: 'Fence planner' });
    await expect(within(tea).queryByRole('button', { name: /^Join/ })).toBeNull();
    await expect(within(fences).getByRole('button', { name: 'Join Stardew Mods' })).toBeVisible();
    const rail = canvas.getByRole('region', { name: 'Realms to follow' });
    await userEvent.click(within(rail).getByRole('button', { name: 'Follow Stardew Mods' }));
    await waitFor(() => expect(within(fences).queryByRole('button', { name: /^Join/ })).toBeNull());
    await expect(within(rail).getAllByText('Following')).toHaveLength(1);
  },
};

/** A Realm that is an official Zone links by the Zone's segment, as the navigation does. */
export const ZoneAddresses: Story = {
  args: props({ state: state({ tab: 'all' }),
    official: [{ id: storyId(958, 'aaaa'), kind: 'zone', realm: realms.kitchen.id, name: 'Kitchen · 厨房', language: 'en',
      icon: null, href: '/r/kitchen', activity: 'unknown' }],
    page: { ok: true, data: page([post(42, { realm: realms.kitchen, target: { title: name('Scallion pancakes') } })],
      { scope: 'all' }) } }),
  async play({ canvasElement }) {
    const post = within(canvasElement).getByRole('article', { name: 'Scallion pancakes' });
    await expect(within(post).getByRole('link', { name: realms.kitchen.name.value })).toHaveAttribute('href', '/en/r/kitchen');
  },
};

/** A new person picks kinds and languages, then follows the suggested communities in one step. */
export const NewPerson: Story = {
  args: props({ newPerson: true, followed: { realms: [], zones: [], complete: true },
    state: state({ tab: 'all' }), page: { ok: true, data: page(everyKind.slice(2, 5), { scope: 'all' }) } }),
  async play({ canvasElement, args }) {
    const canvas = within(canvasElement);
    const picker = canvas.getByRole('region', { name: 'What do you come to REZICS for?' });
    await expect(picker).toHaveTextContent('Step 1 of 3');
    await userEvent.click(within(picker).getByRole('button', { name: 'Mods & software' }));
    await expect(within(picker).getByRole('button', { name: 'Mods & software' })).toHaveAttribute('aria-pressed', 'true');
    await userEvent.click(within(picker).getByRole('button', { name: 'Next' }));
    const languages = canvas.getByRole('region', { name: 'Which languages do you read?' });
    await expect(within(languages).getByRole('button', { name: /English/ })).toHaveAttribute('aria-pressed', 'true');
    await userEvent.click(within(languages).getByRole('button', { name: /日本語/ }));
    await userEvent.click(within(languages).getByRole('button', { name: 'Next' }));
    const communities = canvas.getByRole('region', { name: 'Follow a few communities' });
    // Every suggestion starts ticked, with its reason; the reader unticks what they do not want.
    const classics = await within(communities).findByRole('checkbox', { name: /Classic Literature/ });
    await expect(within(communities).getByText(/For Mods & software · 12,480 members/)).toBeVisible();
    await expect(within(communities).getByText(/Official Zone · About 48,000 members/)).toBeVisible();
    await userEvent.click(classics);
    await userEvent.click(within(communities).getByRole('button', { name: 'Follow 2 and continue' }));
    await waitFor(() => expect((args.api as ReturnType<typeof memoryFeed>).calls).toContain('batch:2'));
  },
};

/** Skipped once, the picker waits as a slim card rather than returning in full. */
export const PickerSkipped: Story = {
  args: props({ newPerson: true, pickerSkipped: true, followed: { realms: [], zones: [], complete: true },
    state: state({ tab: 'all' }) }),
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole('button', { name: 'Pick interests' }));
    await expect(canvas.getByRole('region', { name: 'What do you come to REZICS for?' })).toBeVisible();
  },
};

/**
 * Filters survive the simple choices: tabs and sorts keep them. An empty
 * result names its cause and offers fixes; it never quietly widens the view.
 */
export const FiltersKeptAndEmpty: Story = {
  args: props({ state: state({ sort: 'new', languages: ['ja'], realms: [realms.fiction.id] }),
    page: { ok: true, data: page([]) } }),
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    const realm = encodeURIComponent(realms.fiction.id);
    await expect(within(canvas.getByRole('navigation', { name: 'Feed' })).getByRole('link', { name: 'All' }))
      .toHaveAttribute('href', `/en?tab=all&sort=new&lang=ja&realm=${realm}`);
    await expect(within(canvas.getByRole('navigation', { name: 'Sort' })).getByRole('link', { name: 'Best' }))
      .toHaveAttribute('href', `/en?lang=ja&realm=${realm}`);
    await expect(canvas.getByRole('button', { name: /2 filters on/ })).toBeVisible();
    await expect(canvas.getByRole('heading', { name: 'No posts match these filters' })).toBeVisible();
    await expect(canvas.getByText('Nothing in Japanese here yet.')).toBeVisible();
    await expect(canvas.getByRole('link', { name: 'Include every language' }))
      .toHaveAttribute('href', `/en?sort=new&realm=${realm}`);
    await expect(canvas.getByRole('link', { name: 'Include every Realm' })).toHaveAttribute('href', '/en?sort=new&lang=ja');
  },
};

/** The Filters sheet: languages and followed Realms, submitted as the same view's URL. */
export const FiltersSheet: Story = {
  args: props({ state: state({ sort: 'new' }) }),
  async play({ canvasElement }) {
    await userEvent.click(within(canvasElement).getByRole('button', { name: 'Filters' }));
    const sheet = within(await within(document.body).findByRole('dialog', { name: 'Filter your feed' }));
    const form = sheet.getByRole('button', { name: 'Show posts' }).closest('form')!;
    await expect(form).toHaveAttribute('action', '/en');
    await expect(form.querySelector('input[type="hidden"][name="sort"]')).toHaveValue('new');
    await expect(sheet.getByRole('checkbox', { name: 'Japanese' })).not.toBeChecked();
    await expect(sheet.getByRole('checkbox', { name: realms.kitchen.name.value })).toBeInTheDocument();
    await userEvent.keyboard('{Escape}');
  },
};

/** Following is empty: say so and offer All, without switching to it. */
export const EmptyFollowing: Story = {
  args: props({ page: { ok: true, data: page([]) } }),
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole('heading', { name: 'Nothing from your communities yet' })).toBeVisible();
    await expect(canvas.getByRole('link', { name: 'Browse All' })).toHaveAttribute('href', '/en?tab=all');
  },
};

/** Main could not serve the personal read: the public feed shows, and says so. */
export const PersonalFeedRefused: Story = {
  args: props({ personalRefused: true, page: { ok: true, data: page(everyKind.slice(2, 5), { scope: 'all' }) } }),
  async play({ canvasElement }) {
    await expect(within(canvasElement).getByRole('status')).toHaveTextContent('Your personal feed couldn’t load');
  },
};

export const Chinese: Story = {
  args: props({ locale: 'zh-Hans', continueItems }),
  globals: { locale: 'zh-Hans' },
  parameters: { route: { pathname: '/zh-Hans' } },
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole('region', { name: '继续阅读' })).toBeVisible();
    await expect(within(canvas.getByRole('navigation', { name: '动态' })).getByRole('link', { name: '关注' }))
      .toHaveAttribute('aria-current', 'page');
    await expect(canvas.getByRole('region', { name: '你的审核队列' })).toBeVisible();
  },
};

export const SignedOutChinese: Story = {
  args: props({ locale: 'zh-Hans', signedIn: false }),
  globals: { locale: 'zh-Hans' },
  parameters: { route: { pathname: '/zh-Hans' } },
};

export const Dark: Story = { args: props({ continueItems }), globals: { theme: 'dark' } };

export const Phone: Story = {
  args: props({ continueItems }),
  globals: { viewport: { value: 'phone' } },
  async play({ canvasElement }) {
    // The rail's modules are for wide screens; the feed and Continue come first.
    await expect(within(canvasElement).queryByRole('complementary', { name: 'More on REZICS' })).toBeNull();
    await expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(window.innerWidth);
  },
};

export const PhoneSignedOutDark: Story = {
  args: props({ signedIn: false }),
  globals: { viewport: { value: 'phone' }, theme: 'dark' },
  async play() {
    await expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(window.innerWidth);
  },
};
