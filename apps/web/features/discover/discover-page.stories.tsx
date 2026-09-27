import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, screen, userEvent, waitFor, within } from 'storybook/test';
import { memoryReaderActions } from '../catalogue/fixtures.ts';
import { Providers } from '../shell/providers.tsx';
import { DiscoverView, type LoadedShelf } from './discover-view.tsx';
import { failed, loader, ok, page, works } from './fixtures.ts';
import { messages } from './messages.ts';
import { type DiscoverState, discoveryQuery, type ShelfSpec, shelvesFor, termShelf } from './state.ts';
import type { DiscoveryItem, DiscoveryPage, Loaded } from './types.ts';

const realm = '3f0e1c2d-4b5a-4c6d-8e7f-9a0b1c2d3e4f';
const context = '5a6b7c8d-9e0f-4a1b-8c2d-3e4f5a6b7c8d';
const adventure = '0b1c2d3e-4f5a-4b6c-8d7e-8f9a0b1c2d3e';
const global: DiscoverState = { scope: { kind: 'global' }, context: null, type: null, term: null };
const genre = { value: 'Adventure', language: 'en', direction: 'ltr' as const, basis: 'requested' as const };

function loaded(state: DiscoverState, spec: ShelfSpec, initial: Loaded<DiscoveryPage>, name?: typeof genre): LoadedShelf {
  const overview = state.scope.kind !== 'mine' && !state.type && !state.term;
  return { spec, initial, ...(name ? { genre: name } : {}),
    query: discoveryQuery(state, spec, { limit: overview ? 10 : 12, language: 'en', context }) };
}

/** The shelves a state shows, each with the first page `pages` gives for its key. */
function shelves(state: DiscoverState, pages: (key: string) => Loaded<DiscoveryPage>): LoadedShelf[] {
  return shelvesFor(state, true).map(spec => loaded(state, spec, pages(spec.key)));
}

const books: DiscoveryItem[] = [works.pride, works.chamber, works.journey, works.jane, works.frankenstein,
  works.fallback, works.serial];
const overviewPages = (key: string) => ({
  'favorites-book': ok(page(books)),
  'recent-book': ok(page([works.serial, works.frankenstein, works.jane, works.fallback])),
  'recent-document': ok(page([works.bun, works.react])),
  'recent-recipe': ok(page([works.dumplings, works.pancakes, works.tea])),
}[key] ?? ok(page([])));
const [favorites, ...rest] = shelves(global, overviewPages);
const overview = [favorites!, loaded(global, termShelf(adventure, 'book', true),
  ok(page([works.journey, works.fallback, works.frankenstein])), genre), ...rest];

const meta = {
  title: 'Discover/Page', component: DiscoverView,
  args: { state: global, realm: null, shelves: overview, signedIn: false, signInHref: '/auth/start?next=%2Fen%2Fdiscover',
    load: loader([works.frankenstein, works.chamber]), locale: 'en', messages: messages.en },
  decorators: [Story => <Providers><Story /></Providers>],
  parameters: { route: { pathname: '/en/discover' } },
  globals: { viewport: { value: 'desktop' } },
} satisfies Meta<typeof DiscoverView>;
export default meta;
type Story = StoryObj<typeof meta>;

export const GlobalOverview: Story = {
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole('heading', { level: 1, name: 'Discover' })).toBeVisible();
    await expect(canvas.getByRole('navigation', { name: 'Whose picks' }).querySelector('[aria-current="page"]'))
      .toHaveTextContent('Everyone');
    const favorites = canvas.getByRole('region', { name: 'Readers’ favorites' });
    await expect(within(favorites).getByRole('link', { name: 'Pride and Prejudice' }))
      .toHaveAttribute('href', '/en/w/00000001-3855-42be-84bb-88da77a5b247');
    await expect(within(favorites).getByText('Average rating 4.4 out of 5, 12 ratings')).toBeInTheDocument();
    await expect(within(favorites).getByRole('link', { name: 'See all' })).toHaveAttribute('href', '/en/discover?type=book');
    await expect(canvas.getByRole('region', { name: 'Popular in Adventure' })).toBeVisible();
    for (const shelf of ['Recently added', 'Guides and references', 'Recipes to try']) {
      await expect(canvas.getByRole('region', { name: shelf })).toBeVisible();
    }
    // Scope and counts are the model's words, not a reader's: neither is on the page.
    await expect(canvas.queryByText(/Global|works$/)).toBeNull();
  },
};

const books12: DiscoveryItem[] = [...books, works.chamber, works.jane].map((item, index) => ({ ...item,
  id: item.id.replace(/^(https:\/\/rezics\.com\/id\/)\d{8}/, `$1${String(index + 60).padStart(8, '0')}`) }));
const bookState: DiscoverState = { ...global, type: 'book' };
export const AllBooks: Story = {
  args: { state: bookState, shelves: shelves(bookState, key => key === 'recent-book'
    ? ok(page(books12, { next: true })) : ok(page(books))) },
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole('link', { name: 'Books' })).toHaveAttribute('aria-current', 'page');
    const recent = canvas.getByRole('region', { name: 'Recently added' });
    await userEvent.click(within(recent).getByRole('button', { name: 'Show more' }));
    await waitFor(() => expect(within(recent).getAllByRole('link', { name: 'Frankenstein; or, The Modern Prometheus' })
      .at(-1)).toHaveFocus());
    await expect(within(recent).queryByRole('button', { name: 'Show more' })).toBeNull();
  },
};

const genreState: DiscoverState = { ...global, term: adventure };
export const Genre: Story = {
  args: { state: genreState, shelves: shelvesFor(genreState, true).map(spec => loaded(genreState, spec,
    ok(page([works.journey, works.fallback, works.frankenstein])), genre)) },
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole('region', { name: 'Popular in Adventure' })).toBeVisible();
    await expect(canvas.getByRole('region', { name: 'New in Adventure' })).toBeVisible();
    await expect(canvas.getByRole('link', { name: 'Remove Genre: Adventure' })).toHaveAttribute('href', '/en/discover');
  },
};

const realmState: DiscoverState = { scope: { kind: 'realm', realm }, context: null, type: null, term: null };
const realmName = { value: 'Classic Literature · 经典文学', language: 'en', direction: 'ltr' as const, basis: 'requested' as const };
export const Community: Story = {
  args: { state: realmState, realm: { id: realm, name: realmName },
    shelves: shelves(realmState, key => key === 'favorites-book' ? ok(page([
      { ...works.chamber, rating: { ...works.chamber.rating!, mean: 9.2, scale: { min: 1, max: 10 } } },
      { ...works.pride, rating: { ...works.pride.rating!, mean: 8.1, scale: { min: 1, max: 10 } } }])) : overviewPages(key)) },
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole('heading', { level: 1, name: 'Discover in Classic Literature · 经典文学' })).toBeVisible();
    const community = canvas.getByRole('navigation', { name: 'Whose picks' });
    await expect(within(community).getByRole('link', { name: 'Classic Literature · 经典文学' }))
      .toHaveAttribute('aria-current', 'page');
    await expect(within(community).getByRole('link', { name: 'Everyone' })).toHaveAttribute('href', '/en/discover');
    // A ten-point community scale keeps its /10.
    await expect(canvas.getByText('Average rating 9.2 out of 10, 40 ratings')).toBeInTheDocument();
  },
};

export const Preparing: Story = {
  args: { shelves: shelves(global, key => key === 'recent-recipe' ? overviewPages(key) : failed('unbuilt')) },
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    const favorites = canvas.getByRole('region', { name: 'Readers’ favorites' });
    await expect(within(favorites).getByText('This list is being prepared')).toBeVisible();
    await expect(canvas.getByRole('region', { name: 'Recipes to try' })).toBeVisible();
  },
};

export const ShelfFailures: Story = {
  args: { shelves: shelves(global, key => key === 'favorites-book' ? failed('unavailable')
    : key === 'recent-book' ? failed('budget') : overviewPages(key)) },
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole('alert')).toHaveTextContent('Couldn’t load Readers’ favorites');
    await expect(canvas.getByRole('button', { name: 'Try again' })).toBeVisible();
    await expect(canvas.getByText('This list is too large to show right now')).toBeVisible();
    await expect(canvas.getByRole('region', { name: 'Recipes to try' })).toBeVisible();
  },
};

const emptyRealm: DiscoverState = { ...realmState, type: 'recipe' };
export const EmptyCommunityOffersEveryone: Story = {
  args: { state: emptyRealm, realm: { id: realm, name: null }, shelves: shelves(emptyRealm, () => ok(page([]))) },
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole('heading', { level: 1, name: 'Discover in Community 3f0e1c2d' })).toBeVisible();
    await expect(canvas.getAllByRole('heading', { name: 'Nothing here yet' })).toHaveLength(2);
    await expect(canvas.getAllByRole('link', { name: 'See everyone’s picks' })[0])
      .toHaveAttribute('href', '/en/discover?type=recipe');
  },
};

const mine: DiscoverState = { scope: { kind: 'mine' }, context: null, type: null, term: null };
export const MineSignedOut: Story = {
  args: { state: mine, shelves: shelves(mine, () => failed('sign-in')) },
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole('heading', { level: 1, name: 'Your ratings' })).toBeVisible();
    await expect(canvas.getByRole('link', { name: 'Sign in' })).toHaveAttribute('href', '/auth/start?next=%2Fen%2Fdiscover');
  },
};

export const MineSignedIn: Story = {
  args: { state: mine, signedIn: true, shelves: shelves(mine, () => ok(page([works.chamber, works.pride, works.jane]))) },
  async play({ canvasElement }) {
    const rated = within(within(canvasElement).getByRole('region', { name: 'Works you rated' }));
    await expect(rated.getByText('Your rating: 4.9 out of 5')).toBeInTheDocument();
    await expect(rated.queryByText(/40 ratings/)).toBeNull();
  },
};

export const MineWithoutRatingQuestion: Story = {
  args: { state: mine, shelves: [] },
  async play({ canvasElement }) {
    await expect(within(canvasElement).getByRole('heading', { name: 'Ratings aren’t open here yet' })).toBeVisible();
  },
};

export const ListChangedOnShowMore: Story = {
  args: { state: bookState, shelves: shelves(bookState, () => ok(page(books, { next: true }))), load: loader('moved') },
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    const recent = canvas.getByRole('region', { name: 'Recently added' });
    await userEvent.click(within(recent).getByRole('button', { name: 'Show more' }));
    await expect(await within(recent).findByText('This list changed while you were browsing')).toBeVisible();
    await expect(within(recent).getByRole('button', { name: 'Start over' })).toBeVisible();
    // The pages already shown stay; nothing is silently replaced.
    await expect(within(recent).getByRole('link', { name: 'Pride and Prejudice' })).toBeVisible();
  },
};

/** Signed in with Main's reader state (G-285): shelve from a cover's corner. */
export const ShelvingFromDiscover: Story = {
  args: { signedIn: true, readerActions: memoryReaderActions() },
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    const favorites = canvas.getByRole('region', { name: 'Readers’ favorites' });
    await userEvent.click(within(favorites).getByRole('button', { name: 'Shelve “Pride and Prejudice”' }));
    await userEvent.click(await screen.findByRole('menuitemradio', { name: 'Want to read' }));
    await waitFor(() => expect(within(favorites).getByRole('button', { name: 'Shelve “Pride and Prejudice” · Want to read' }))
      .toBeVisible());
  },
};

export const MalformedLink: Story = {
  args: { state: null, shelves: [] },
  async play({ canvasElement }) {
    await expect(within(canvasElement).getByRole('heading', { name: 'This link doesn’t lead anywhere' })).toBeVisible();
  },
};

export const CommunityMissing: Story = {
  args: { state: realmState, realm: { id: realm, name: null }, realmMissing: true, shelves: [] },
  async play({ canvasElement }) {
    await expect(within(canvasElement).getByRole('heading', { name: 'This community isn’t public or doesn’t exist' }))
      .toBeVisible();
  },
};

export const ChineseDark: Story = {
  args: { locale: 'zh-Hans', messages: messages['zh-Hans'] },
  globals: { locale: 'zh-Hans', theme: 'dark' },
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole('heading', { level: 1, name: '发现' })).toBeVisible();
    await expect(canvas.getByRole('region', { name: '读者最爱' })).toBeVisible();
    await expect(canvas.getByRole('region', { name: 'Adventure热门' })).toBeVisible();
  },
};

export const Phone: Story = {
  globals: { viewport: { value: 'phone' } },
  async play() {
    await expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(window.innerWidth);
  },
};

export const PhoneChineseDark: Story = {
  args: { locale: 'zh-Hans', messages: messages['zh-Hans'] },
  globals: { viewport: { value: 'phone' }, locale: 'zh-Hans', theme: 'dark' },
  async play() {
    await expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(window.innerWidth);
  },
};
