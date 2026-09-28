import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, screen, userEvent, waitFor, within } from 'storybook/test';
import type { UiLocale } from '../../i18n/define.ts';
import { memoryReaderActions } from '../catalogue/fixtures.ts';
import { everyKind, memoryFeed, NOW, page, post, realms, storyId, suggestion } from '../feed/fixtures.ts';
import { messages as feed } from '../feed/messages.ts';
import feedZhHans from '../feed/messages/zh-Hans.ts';
import { type FeedDefaults, type FeedState, feedQuery } from '../feed/state.ts';
import type { FeedPage, Loaded } from '../feed/types.ts';
import { memorySavedFilters, noFilters, readerFilters, topics } from '../saved-filter/fixtures.ts';
import type { SavedFilter, SavedFilters } from '../saved-filter/types.ts';
import { continueItems, followedCommunities, officialZones, railData, suggestions } from './fixtures.ts';
import { HomePage, type HomePageProps, HomePosts } from './home-page.tsx';
import { messages as home } from './messages.ts';
import homeZhHans from './messages/zh-Hans.ts';
import { Rail } from './rail.tsx';

// Home as each kind of visitor meets it, over an in-memory Main. The feed's
// own rules are in Feed/Posts; these stories carry the frame: signed out,
// a new person's first Home, a returning reader with pinned tabs, and filters
// that name why a view is empty and never switch to another view on their own.

const reader = storyId(801, 'bbbb');
const name = (value: string) => ({ value, language: 'en', direction: 'ltr' as const, basis: 'requested' as const });
const signInHref = '/auth/start?next=%2Fen';
const following: FeedDefaults = { tab: 'following', sort: 'best' };
const state = (change: Partial<FeedState> = {}): FeedState =>
  ({ tab: 'following', filter: null, sort: 'best', window: 'week', languages: [], realms: [], ...change });
const fantasy = readerFilters.pinned[0]!;
const pinnedState = (filter: SavedFilter = fantasy) => state({ tab: 'pinned', filter: filter.id });

type Args = HomePageProps & { withRail?: boolean };

/** A Home over the in-memory Main; `page` and `personalRefused` shape the posts, as the route's read does. */
function props(options: { signedIn?: boolean; state?: FeedState; page?: Loaded<FeedPage>; locale?: UiLocale;
  personalRefused?: boolean; filters?: SavedFilters; recommendations?: boolean | null } & Partial<Args> = {}): Args {
  const { signedIn = true, locale = 'en', page: shown, personalRefused, filters = readerFilters,
    recommendations = null, ...rest } = options;
  const view = options.state ?? state(signedIn ? {} : { tab: 'all' });
  const zh = locale === 'zh-Hans';
  const messages = { home: zh ? { ...home, ...homeZhHans } : home, feed: zh ? { ...feed, ...feedZhHans } : feed };
  const defaults: FeedDefaults = signedIn ? following : { tab: 'all', sort: 'best' };
  const pinned = view.tab === 'pinned' ? [...filters.pinned, ...filters.unpinned].find(item => item.id === view.filter)
    ?? null : null;
  return {
    locale, now: NOW, signedIn, actingSubject: signedIn ? reader : null, avatarQuery: '', messages,
    state: view, defaults,
    posts: <HomePosts locale={locale} messages={messages} signedIn={signedIn} actingSubject={signedIn ? reader : null}
      signInHref={signInHref} state={view} defaults={defaults} personalRefused={personalRefused} pinned={pinned}
      recommendations={recommendations} saveRecommendations={async () => true}
      query={feedQuery(view, { language: locale, ...(signedIn ? { actingSubject: reader } : {}) })}
      page={shown ?? { ok: true, data: page(signedIn ? [everyKind[0]!, suggestion, ...everyKind.slice(1, 4)]
        : everyKind.slice(2, 6), { scope: view.tab === 'following' ? 'following' : 'all' }) }}
      readerActions={signedIn ? memoryReaderActions({}) : undefined} />,
    newPerson: false, followed: signedIn ? followedCommunities : null, continueItems: null, official: officialZones,
    savedFilters: signedIn ? filters : null, setupHref: '/en/welcome?next=%2Fen', setupLater: false,
    welcomeDismissed: false, signInHref, signUpHref: `${signInHref}&create=1`, api: memoryFeed({ suggestions }),
    filtersApi: memorySavedFilters(filters),
    ...rest,
  };
}

const meta = {
  title: 'Home/Page',
  component: HomePage,
  render: ({ withRail = true, ...args }: Args) => <HomePage {...args} rail={withRail
    ? <Rail data={args.signedIn ? railData : { ...railData, moderated: [], trending: { ...railData.trending, scope: 'global' } }}
      signedIn={args.signedIn} locale={args.locale} messages={args.messages.home} /> : undefined} />,
  parameters: { route: { pathname: '/en' } },
  globals: { viewport: { value: 'desktop' } },
} satisfies Meta<Args>;
export default meta;
type Story = StoryObj<typeof meta>;

/** Signed out: why to join, and All · Best under one control line. The official Zones are in the navigation. */
export const SignedOut: Story = {
  args: props({ signedIn: false }),
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole('heading', { level: 1, name: 'Home' })).toBeInTheDocument();
    await expect(canvas.queryByRole('region', { name: /Official Zones/ })).toBeNull();
    await expect(canvas.getByRole('link', { name: 'Join REZICS' })).toHaveAttribute('href', `${signInHref}&create=1`);
    // There is no Following without an account; the sort is one menu, never hidden.
    await expect(canvas.queryByRole('navigation', { name: 'Feed' })).toBeNull();
    await userEvent.click(canvas.getByRole('button', { name: 'Sort: Best' }));
    await expect(await screen.findByRole('menuitemradio', { name: /^Best/ })).toBeChecked();
    await waitFor(() => expect(screen.getByRole('menuitemradio', { name: /^Top/ })).toBeVisible());
    await userEvent.keyboard('{Escape}');
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
    await userEvent.click(canvas.getByRole('button', { name: 'Sort: Best' }));
    await waitFor(() => expect(screen.getByRole('menuitemradio', { name: /^New/ })).toBeVisible());
    await expect(screen.queryByRole('menuitemradio', { name: /^Top/ })).toBeNull();
    await userEvent.keyboard('{Escape}');
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

/** A new person is invited to the first-minute setup; All · Best stays below, and `+` pins a topic any time. */
export const NewPerson: Story = {
  args: props({ newPerson: true, followed: { realms: [], zones: [], complete: true }, filters: noFilters,
    state: state({ tab: 'all' }), page: { ok: true, data: page(everyKind.slice(2, 5), { scope: 'all' }) } }),
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    const invite = canvas.getByRole('region', { name: 'Make Home yours' });
    await expect(within(invite).getByRole('link', { name: 'Choose topics' })).toHaveAttribute('href', '/en/welcome?next=%2Fen');
    // With no pinned tab yet, `+` says what it does.
    const tabs = canvas.getByRole('navigation', { name: 'Feed' });
    await expect(within(tabs).getByRole('button', { name: 'Pin a topic' })).toBeVisible();
    await expect(within(tabs).getByRole('link', { name: 'All' })).toHaveAttribute('aria-current', 'page');
    await expect(canvas.getAllByRole('article').length).toBeGreaterThan(0);
    await userEvent.click(within(invite).getByRole('button', { name: 'Not now' }));
    await expect(document.cookie).toContain('rezics_home_picker=skipped');
    await expect(canvas.getByRole('region', { name: 'Make Home yours' })).toHaveTextContent('Pin topics as tabs');
  },
};

/** Put off once, the invitation waits as a slim line rather than returning in full. */
export const SetupPutOff: Story = {
  args: props({ newPerson: true, setupLater: true, followed: { realms: [], zones: [], complete: true },
    filters: noFilters, state: state({ tab: 'all' }) }),
  async play({ canvasElement }) {
    const invite = within(canvasElement).getByRole('region', { name: 'Make Home yours' });
    await expect(within(invite).queryByRole('button', { name: 'Not now' })).toBeNull();
    await expect(within(invite).getByRole('link', { name: 'Choose topics' })).toBeVisible();
  },
};

/** Pinned topics and filters are tabs after Following and All, each with its own address. */
export const PinnedTabs: Story = {
  args: props(),
  async play({ canvasElement }) {
    const tabs = within(canvasElement).getByRole('navigation', { name: 'Feed' });
    await expect(within(tabs).getAllByRole('link').map(link => link.textContent))
      .toEqual(['Following', 'All', 'Fantasy', 'English & Japanese', '仙侠']);
    await expect(within(tabs).getByRole('link', { name: 'Fantasy' })).toHaveAttribute('href', `/en?tab=${fantasy.id}`);
    await expect(within(tabs).getByRole('link', { name: '仙侠' })).toHaveAttribute('lang', 'zh-Hans');
    await expect(within(tabs).getByRole('button', { name: 'Pin a topic or filter' })).toBeVisible();
  },
};

/** A pinned tab reads All through its filter with the same Best/New/Top line; the tab is its own filter. */
export const PinnedTab: Story = {
  args: props({ state: pinnedState(), page: { ok: true, data: page(everyKind.slice(0, 3), { scope: 'all' }) } }),
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    const tabs = canvas.getByRole('navigation', { name: 'Feed' });
    await expect(within(tabs).getByRole('link', { name: 'Fantasy' })).toHaveAttribute('aria-current', 'page');
    await expect(canvas.queryByRole('button', { name: /^Filters/ })).toBeNull();
    await userEvent.click(canvas.getByRole('button', { name: 'Sort: Best' }));
    await waitFor(() => expect(screen.getByRole('menuitemradio', { name: /^Top/ })).toBeVisible());
    await userEvent.keyboard('{Escape}');
  },
};

/** An empty pinned tab names its topic and leads to the topic's page, never widening on its own. */
export const PinnedTabEmpty: Story = {
  args: props({ state: pinnedState(), page: { ok: true, data: page([], { scope: 'all' }) } }),
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole('heading', { name: 'Nothing about Fantasy yet' })).toBeVisible();
    await expect(canvas.getByRole('link', { name: 'Open Fantasy' }))
      .toHaveAttribute('href', `/en/concepts/${topics.fantasy.id.slice(-36)}`);
    await expect(canvas.getByRole('link', { name: 'Browse All' })).toHaveAttribute('href', '/en?tab=all');
  },
};

/** A tab's menu moves it with the keyboard, renames it and takes it off Home; a topic's tab unfollows it. */
export const TabMenu: Story = {
  args: props({ state: pinnedState() }),
  async play({ canvasElement, args }) {
    const api = args.filtersApi as ReturnType<typeof memorySavedFilters>;
    const canvas = within(canvasElement);
    // Each choice is made with the keyboard, as a reader without a mouse moves a tab.
    const choose = async (item: string) => {
      await userEvent.click(canvas.getByRole('button', { name: 'Options for Fantasy' }));
      await waitFor(() => expect(screen.getByRole('menuitem', { name: item })).toBeVisible());
      for (let step = 0; step < 6 && !screen.getByRole('menuitem', { name: item }).hasAttribute('data-highlighted'); step++) {
        await userEvent.keyboard('{ArrowDown}');
      }
      await userEvent.keyboard('{Enter}');
      await waitFor(() => expect(screen.queryByRole('menu')).toBeNull());
    };
    await userEvent.click(canvas.getByRole('button', { name: 'Options for Fantasy' }));
    await waitFor(() => expect(screen.getByRole('menuitem', { name: 'Unfollow Fantasy' })).toBeVisible());
    await expect(screen.queryByRole('menuitem', { name: 'Move left' })).toBeNull();
    await userEvent.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('menu')).toBeNull());

    await choose('Move right');
    await waitFor(() => expect(api.calls).toContain('reorder:03,01,02'));
    // The new order shows at once, before Main's list returns.
    const tabs = canvas.getByRole('navigation', { name: 'Feed' });
    await expect(within(tabs).getAllByRole('link').slice(2).map(link => link.textContent))
      .toEqual(['English & Japanese', 'Fantasy', '仙侠']);

    await choose('Rename');
    const dialog = await screen.findByRole('dialog', { name: 'Rename tab' });
    const field = within(dialog).getByRole('textbox', { name: 'Name' });
    await userEvent.clear(field);
    await userEvent.type(field, 'Magic');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(api.calls).toContain('update:01:{"name":"Magic"}'));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Rename tab' })).toBeNull());

    await choose('Remove from Home');
    await waitFor(() => expect(api.calls).toContain('update:01:{"pinned":false}'));
  },
};

/** `+` searches topics in the reader's language, refines through broader and narrower ones, and pins one. */
export const PinATopic: Story = {
  args: props(),
  async play({ canvasElement, args }) {
    const api = args.filtersApi as ReturnType<typeof memorySavedFilters>;
    await userEvent.click(within(canvasElement).getByRole('button', { name: 'Pin a topic or filter' }));
    const dialog = within(await screen.findByRole('dialog', { name: 'Pin to Home' }));
    // Before searching: the reader's unpinned topics and popular ones.
    await expect(dialog.getByRole('region', { name: 'Your topics' })).toHaveTextContent('Mystery');
    await waitFor(() => expect(dialog.getByRole('button', { name: 'Cozy games' })).toBeVisible());
    await userEvent.type(dialog.getByRole('searchbox', { name: 'Search topics' }), 'fan');
    await userEvent.click(await dialog.findByRole('button', { name: 'Fantasy' }));
    await expect(await dialog.findByRole('heading', { name: 'Fantasy' })).toBeVisible();
    await expect(dialog.getByRole('region', { name: 'Broader' })).toHaveTextContent('Fiction');
    await userEvent.click(within(dialog.getByRole('region', { name: 'Narrower' })).getByRole('button', { name: '仙侠' }));
    await expect(await dialog.findByRole('heading', { name: '仙侠' })).toBeVisible();
    await userEvent.click(dialog.getByRole('button', { name: 'Back' }));
    await userEvent.clear(dialog.getByRole('searchbox', { name: 'Search topics' }));
    await userEvent.click(await dialog.findByRole('button', { name: 'Cozy games' }));
    await userEvent.click(await dialog.findByRole('button', { name: 'Pin “Cozy games”' }));
    await waitFor(() => expect(api.calls).toContain(`follow:${topics.cozy.id.slice(-12)}:true`));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Pin to Home' })).toBeNull());
  },
};

/** The Filters Home shows now become one named tab. */
export const SaveFiltersAsTab: Story = {
  args: props({ state: state({ tab: 'all', languages: ['ja'], realms: [realms.fiction.id] }) }),
  async play({ canvasElement, args }) {
    const api = args.filtersApi as ReturnType<typeof memorySavedFilters>;
    await userEvent.click(within(canvasElement).getByRole('button', { name: 'Pin a topic or filter' }));
    const dialog = within(await screen.findByRole('dialog', { name: 'Pin to Home' }));
    const form = within(dialog.getByRole('form', { name: 'Save these filters as a tab' }));
    await expect(form.getByRole('textbox', { name: 'Name' })).toHaveValue(`Japanese · ${realms.fiction.name.value}`);
    await userEvent.clear(form.getByRole('textbox', { name: 'Name' }));
    await userEvent.type(form.getByRole('textbox', { name: 'Name' }), 'Japanese fiction');
    await userEvent.click(form.getByRole('button', { name: 'Save as tab' }));
    await waitFor(() => expect(api.calls).toContain('create:Japanese fiction'));
  },
};

/** Eight tabs fill Home: `+` says so instead of failing a pin. */
export const TabsFull: Story = {
  args: props({ filters: { revision: readerFilters.revision, unpinned: [], pinned: Array.from({ length: 8 },
    (_, index) => ({ ...readerFilters.pinned[1]!, id: `00000000-0000-4000-8000-0000000007${index}0`,
      name: `Tab ${index + 1}`, position: index })) } }),
  async play({ canvasElement }) {
    await userEvent.click(within(canvasElement).getByRole('button', { name: 'Pin a topic or filter' }));
    const dialog = within(await screen.findByRole('dialog', { name: 'Pin to Home' }));
    await expect(dialog.getByRole('status')).toHaveTextContent('Home has room for eight tabs');
  },
};

/** A quiet Following fills with labelled suggestions, which the reader can turn off. */
export const SuggestionsInFollowing: Story = {
  args: props({ recommendations: true }),
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await expect(canvas.getByText('Suggested posts fill in while your communities are quiet.')).toBeVisible();
    await expect(canvas.getByRole('button', { name: 'Turn off' })).toBeVisible();
  },
};

/** Turned off, Following says so and offers them back. */
export const SuggestionsOff: Story = {
  args: props({ recommendations: false, page: { ok: true, data: page(everyKind.slice(0, 2)) } }),
  async play({ canvasElement }) {
    await expect(within(canvasElement).getByRole('button', { name: 'Turn on' })).toBeVisible();
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
    // Each active filter is a chip on the control line that removes only itself.
    await expect(canvas.getByRole('link', { name: 'Remove filter: Japanese' }))
      .toHaveAttribute('href', `/en?sort=new&realm=${realm}`);
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
  args: props({ continueItems, state: pinnedState(readerFilters.pinned[2]) }),
  globals: { viewport: { value: 'phone' } },
  async play({ canvasElement }) {
    // The rail's modules are for wide screens; the feed and Continue come first.
    await expect(within(canvasElement).queryByRole('complementary', { name: 'More on REZICS' })).toBeNull();
    // Tabs scroll sideways inside their strip; the page never does, and `+` stays in reach.
    await expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(window.innerWidth);
    const tabs = within(canvasElement).getByRole('navigation', { name: 'Feed' });
    await expect(within(tabs).getByRole('button', { name: 'Pin a topic or filter' })).toBeVisible();
    await waitFor(() => expect(within(tabs).getByRole('link', { name: '仙侠' })).toBeVisible());
  },
};

export const PhoneSignedOutDark: Story = {
  args: props({ signedIn: false }),
  globals: { viewport: { value: 'phone' }, theme: 'dark' },
  async play() {
    await expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(window.innerWidth);
  },
};
