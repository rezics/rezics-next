import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, waitFor, within } from 'storybook/test';
import { Providers } from '../shell/providers.tsx';
import { DiscoverPage, type LoadedShelf } from './discover-page.tsx';
import { classified, failed, loader, ok, page, works } from './fixtures.ts';
import { messages } from './messages.ts';
import { type DiscoverState, discoveryQuery, shelvesFor } from './state.ts';
import type { DiscoveryPage, Loaded } from './types.ts';

const realm = '3f0e1c2d-4b5a-4c6d-8e7f-9a0b1c2d3e4f';
const context = '5a6b7c8d-9e0f-4a1b-8c2d-3e4f5a6b7c8d';
const global: DiscoverState = { scope: { kind: 'global' }, context: null, type: null, term: null };

/** The shelves a state shows, each with the first page `pages` gives for it. */
function shelves(state: DiscoverState, pages: (key: string) => Loaded<DiscoveryPage>): LoadedShelf[] {
  const limit = state.type || state.term ? 12 : 6;
  return shelvesFor(state).map(spec => ({ spec, initial: pages(spec.key),
    query: discoveryQuery(state, spec, { limit, language: 'en' }) }));
}

const overview = (key: string) => ({
  recent: ok(page([works.pride, works.journey, works.bun, works.dumplings, works.jane, works.serial], { next: true })),
  'recent-book': ok(page([works.chamber, works.journey, works.frankenstein, works.fallback])),
  'recent-document': ok(page([works.bun, works.react])),
  'recent-recipe': ok(page([works.dumplings, works.pancakes, works.tea])),
}[key] ?? ok(page([])));

const meta = {
  title: 'Discover/Page', component: DiscoverPage,
  args: { state: global, realm: null, question: null, shelves: shelves(global, overview), signInHref: '/auth/start?next=%2Fen%2Fdiscover',
    load: loader([works.frankenstein, works.chamber]), locale: 'en', messages: messages.en },
  decorators: [Story => <Providers><Story /></Providers>],
  parameters: { route: { pathname: '/discover' } },
  globals: { viewport: { value: 'desktop' } },
} satisfies Meta<typeof DiscoverPage>;
export default meta;
type Story = StoryObj<typeof meta>;

export const GlobalOverview: Story = {
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole('heading', { level: 1, name: 'Discover works' })).toBeVisible();
    await expect(canvas.getByRole('link', { name: 'Global' })).toHaveAttribute('aria-current', 'page');
    const recent = canvas.getByRole('region', { name: 'Recently updated · Global' });
    await expect(within(recent).getByText('At least 6 works')).toBeVisible();
    await expect(within(recent).getByRole('link', { name: 'Pride and Prejudice' }))
      .toHaveAttribute('href', '/en/w/00000001-3855-42be-84bb-88da77a5b247');
    await expect(within(recent).getByText('Mean rating 4.4 of 5 from 12 in Global')).toBeInTheDocument();
    await userEvent.click(within(recent).getByRole('button', { name: 'Show more' }));
    await waitFor(() => expect(within(recent).getByText('8 works')).toBeVisible());
    await expect(within(recent).getByRole('link', { name: 'Frankenstein; or, The Modern Prometheus' })).toHaveFocus();
    await expect(within(recent).queryByRole('button', { name: 'Show more' })).toBeNull();
    await expect(canvas.getByRole('link', { name: 'See all Books' })).toHaveAttribute('href', '/en/discover?type=book');
  },
};

const realmState: DiscoverState = { scope: { kind: 'realm', realm }, context, type: null, term: null };
export const RealmTopRated: Story = {
  args: { state: realmState, question: { question: 'How well does it reward rereading?', max: 10 },
    realm: { id: realm, name: { value: 'Classic Literature · 经典文学', language: 'en', direction: 'ltr', basis: 'requested' } },
    shelves: shelves(realmState, key => key === 'top-rated'
      ? ok(page([classified('local', { ...works.chamber, rating: { ...works.chamber.rating!, mean: 9.2,
        scale: { min: 1, max: 10 } } }), classified('global', { ...works.pride, rating: { ...works.pride.rating!,
        mean: 8.1, scale: { min: 1, max: 10 } } })], { context: true }))
      : overview(key)) },
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    const top = canvas.getByRole('region', { name: 'Top rated · Classic Literature · 经典文学' });
    await expect(within(top).getByText('Ranked by the mean answer to “How well does it reward rereading?” (1–10).'))
      .toBeVisible();
    await expect(within(top).getByText('Classified by this Realm')).toBeVisible();
    await expect(within(top).getByText('Inherited from Global')).toBeVisible();
    await expect(canvas.getByRole('link', { name: 'Classic Literature · 经典文学' }))
      .toHaveAttribute('aria-current', 'page');
    await expect(canvas.getByRole('link', { name: 'Global' })).toHaveAttribute('href', '/en/discover');
    await expect(canvas.getByRole('link', { name: /Remove filter: Rating question/ }))
      .toHaveAttribute('href', `/en/discover?scope=realm&realm=${realm}`);
  },
};

export const NotBuilt: Story = {
  args: { shelves: shelves(global, () => failed('unbuilt')) },
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await expect(canvas.getAllByText('Not built for Global yet')).toHaveLength(4);
  },
};

const emptyRealm: DiscoverState = { scope: { kind: 'realm', realm }, context: null, type: 'recipe', term: null };
export const OutOfDate: Story = {
  args: { shelves: shelves(global, key => key === 'recent' ? failed('stale') : overview(key)) },
  async play({ canvasElement }) {
    const recent = within(within(canvasElement).getByRole('region', { name: 'Recently updated · Global' }));
    await expect(recent.getByText('The Global list is out of date')).toBeVisible();
    await expect(recent.getByRole('button', { name: 'Try again' })).toBeVisible();
    await expect(recent.queryByRole('button', { name: 'Start over' })).toBeNull();
  },
};

export const EmptyRealmOffersGlobal: Story = {
  args: { state: emptyRealm, realm: { id: realm, name: null }, shelves: shelves(emptyRealm, () => ok(page([]))) },
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole('heading', { name: 'No works in Realm 3f0e1c2d yet' })).toBeVisible();
    await expect(canvas.getByRole('link', { name: 'See Global' })).toHaveAttribute('href', '/en/discover?type=recipe');
    await expect(canvas.getByRole('link', { name: 'Recipes' })).toHaveAttribute('aria-current', 'page');
  },
};

const mine: DiscoverState = { scope: { kind: 'mine' }, context, type: null, term: null };
export const MineSignedOut: Story = {
  args: { state: mine, shelves: shelves(mine, () => failed('sign-in')), signInHref: '/auth/start?next=%2Fen%2Fdiscover' },
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await expect(canvas.getAllByRole('link', { name: 'Sign in' })[0]).toHaveAttribute('href', '/auth/start?next=%2Fen%2Fdiscover');
    await expect(canvas.getByText('Only public works you rated appear here, ranked by your own ratings.')).toBeVisible();
  },
};

export const MineSignedIn: Story = {
  args: { state: mine, question: { question: 'How much did you enjoy it?', max: 5 },
    shelves: shelves(mine, key => ok(page(key === 'top-rated' ? [works.chamber, works.pride] : [works.jane]))) },
  async play({ canvasElement }) {
    const top = within(within(canvasElement).getByRole('region', { name: 'Top rated · Rated by you' }));
    await expect(top.getByText('Your rating: 4.9 of 5')).toBeInTheDocument();
    await expect(top.queryByText('40 ratings')).toBeNull();
  },
};

const mineWithoutQuestion: DiscoverState = { ...mine, context: null };
export const MineNeedsQuestion: Story = {
  args: { state: mineWithoutQuestion, shelves: shelves(mineWithoutQuestion, overview) },
  async play({ canvasElement }) {
    await expect(within(canvasElement).getByRole('heading', { name: 'Choose a rating question' })).toBeVisible();
  },
};

export const ListChangedOnShowMore: Story = {
  args: { load: loader('moved') },
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    const recent = canvas.getByRole('region', { name: 'Recently updated · Global' });
    await userEvent.click(within(recent).getByRole('button', { name: 'Show more' }));
    await expect(await within(recent).findByText('This list changed while you were browsing')).toBeVisible();
    await expect(within(recent).getByRole('button', { name: 'Start over' })).toBeVisible();
    // The pages already shown stay; nothing is silently replaced.
    await expect(within(recent).getByRole('link', { name: 'Pride and Prejudice' })).toBeVisible();
  },
};

export const ShelfFailures: Story = {
  args: { shelves: shelves(global, key => key === 'recent' ? failed('unavailable')
    : key === 'recent-book' ? failed('budget') : overview(key)) },
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole('alert')).toHaveTextContent('This shelf could not be loaded');
    await expect(canvas.getByRole('button', { name: 'Try again' })).toBeVisible();
    await expect(canvas.getByText('This shelf is too large to read right now')).toBeVisible();
    await expect(canvas.getByRole('region', { name: 'Recipes · Global' })).toBeVisible();
  },
};

export const MalformedLink: Story = {
  args: { state: null, shelves: [] },
  async play({ canvasElement }) {
    await expect(within(canvasElement).getByRole('heading', { name: 'This discover link is malformed' })).toBeVisible();
  },
};

export const RealmMissing: Story = {
  args: { state: { ...realmState, context: null }, realm: { id: realm, name: null }, realmMissing: true,
    shelves: [] },
  async play({ canvasElement }) {
    await expect(within(canvasElement).getByRole('heading', { name: 'This Realm is not public or does not exist' }))
      .toBeVisible();
  },
};

export const ChineseDark: Story = {
  args: { locale: 'zh-Hans', messages: messages['zh-Hans'] },
  globals: { locale: 'zh-Hans', theme: 'dark' },
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole('heading', { level: 1, name: '发现作品' })).toBeVisible();
    await expect(canvas.getByRole('region', { name: '最近更新 · 全局' })).toBeVisible();
    await expect(canvas.getByText('至少 6 部作品')).toBeVisible();
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
