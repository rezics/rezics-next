import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, screen, userEvent, waitFor, within } from 'storybook/test';
import { works as discoveryWorks } from '../discover/fixtures.ts';
import { memoryFollowActions } from '../profile/fixtures.ts';
import { Providers } from '../shell/providers.tsx';
import { ConceptMalformed, ConceptPage, ConceptUnavailable } from './concept-page.tsx';
import { conceptFacet, conceptUuid, failed, fantasy, follow, localConcept, localRealm, memorySearch, ok,
  state, works, worksLoader, worksPage } from './fixtures.ts';
import { facetLabel } from './facets.ts';
import { messages } from './messages.ts';
import zhHans from './messages/zh-Hans.ts';

const zh = { ...messages, ...zhHans };
const page = `/en/concepts/${conceptUuid(1)}`;
const signedOut = { signedIn: false };

const meta = {
  title: 'Concept/Page', component: ConceptPage,
  args: { concept: fantasy, facet: facetLabel(conceptFacet, 'en'), state: state(), realms: {},
    works: ok(worksPage(state(), works)), follow: ok(follow(12)), reader: signedOut, loadWorks: worksLoader([]),
    searchConcepts: memorySearch, locale: 'en', messages },
  decorators: [Story => <Providers><Story /></Providers>],
  parameters: { route: { pathname: page } },
  globals: { viewport: { value: 'desktop' } },
} satisfies Meta<typeof ConceptPage>;
export default meta;
type Story = StoryObj<typeof meta>;

const noOverflow = async () => {
  await expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(window.innerWidth);
};

/**
 * Fantasy as a tag page was: its Facet's label, what it is and where it sits,
 * Follow, and the Works that carry it, with a Condition bar to narrow them.
 */
export const Concept: Story = {
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole('heading', { level: 1, name: 'Fantasy' })).toBeVisible();
    await expect(canvas.getByText('Tags')).toBeVisible();
    await expect(canvas.getByText(/Stories built on the impossible/)).toBeVisible();
    await expect(canvas.getByRole('link', { name: 'Fiction' })).toHaveAttribute('href', `/en/concepts/${conceptUuid(5)}`);
    await expect(canvas.getByRole('link', { name: 'High fantasy' })).toHaveAttribute('href',
      `/en/concepts/${conceptUuid(6)}`);
    await expect(canvas.getByText('and more')).toBeVisible();
    // Signed out, Follow leads to sign-in and back; the count is everyone's.
    await expect(canvas.getByText('12 followers')).toBeVisible();
    await expect(canvas.getByRole('link', { name: /^Follow/ })).toHaveAttribute('href',
      `/auth/start?next=${encodeURIComponent(page)}`);
    const bar = within(canvas.getByRole('region', { name: 'Conditions' }));
    await expect(bar.getByText('Fantasy, this page’s Concept')).toBeInTheDocument();
    // Concepts the listed Works also carry are one step from included or excluded.
    await expect(bar.getByRole('link', { name: 'Include Dragons' })).toHaveAttribute('href',
      `/en/concepts/${conceptUuid(1)}?include=${conceptUuid(8)}`);
    await expect(bar.getByRole('link', { name: 'Exclude Romance' })).toHaveAttribute('href',
      `/en/concepts/${conceptUuid(1)}?exclude=${conceptUuid(3)}`);
    const list = within(canvas.getByRole('region', { name: 'Works' }));
    await expect(list.getByText('5 works')).toBeVisible();
    await expect(list.getAllByRole('heading', { level: 3 })).toHaveLength(5);
    // A phrase search narrows by the Concept on the search page.
    const search = within(canvas.getByRole('search', { name: 'Search within Fantasy' }));
    await expect(search.getByRole('searchbox', { name: 'Search within Fantasy' })).toBeVisible();
  },
};

/** Include a second value and exclude a third: all of the included, none of the excluded. */
export const IncludeAndExclude: Story = {
  args: (() => {
    const filtered = state({ include: [conceptUuid(8)], exclude: [conceptUuid(3)] });
    return { state: filtered, works: ok(worksPage(filtered, [works[0]!, works[2]!])) };
  })(),
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    const bar = within(canvas.getByRole('region', { name: 'Conditions' }));
    await expect(bar.getByText('Included: Dragons')).toBeInTheDocument();
    await expect(bar.getByText('Excluded: Romance')).toBeInTheDocument();
    await expect(bar.getByRole('link', { name: 'Remove Dragons' })).toHaveAttribute('href',
      `/en/concepts/${conceptUuid(1)}?exclude=${conceptUuid(3)}`);
    await expect(bar.getByRole('link', { name: 'Remove Romance' })).toHaveAttribute('href',
      `/en/concepts/${conceptUuid(1)}?include=${conceptUuid(8)}`);
    const match = within(bar.getByRole('group', { name: 'Match' }));
    await expect(match.getByRole('link', { name: /^All/ })).toHaveAttribute('aria-current', 'true');
    await expect(match.getByRole('link', { name: /^Any/ })).toHaveAttribute('href',
      `/en/concepts/${conceptUuid(1)}?include=${conceptUuid(8)}&exclude=${conceptUuid(3)}&match=any`);
    await expect(bar.getByRole('link', { name: 'Clear' })).toHaveAttribute('href', `/en/concepts/${conceptUuid(1)}`);
    await expect(within(canvas.getByRole('region', { name: 'Works' })).getAllByRole('heading', { level: 3 }))
      .toHaveLength(2);
  },
};

/** Add a value by name: Concept search offers it, to include or exclude. */
export const AddByName: Story = {
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    const bar = within(canvas.getByRole('region', { name: 'Conditions' }));
    await userEvent.click(bar.getByRole('radio', { name: 'Exclude' }));
    const input = bar.getByRole('combobox', { name: 'Add a Concept' });
    await userEvent.type(input, 'dr');
    await waitFor(() => expect(screen.getByRole('option', { name: 'Dragons' })).toBeVisible());
    await userEvent.clear(input);
    await userEvent.type(input, 'zz');
    await waitFor(() => expect(screen.getByText('No Concepts match')).toBeVisible());
  },
};

/** Following shows at once and the count moves with it; unfollowing takes it back. */
export const Follow: Story = {
  args: { reader: { signedIn: true, actingSubject: 'https://rezics.com/id/00000077-7c1d-4e2f-9a3b-5c6d7e8f9a0b' },
    follow: ok(follow(12, false)), followActions: memoryFollowActions() },
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole('button', { name: 'Follow · Fantasy' }));
    await expect(canvas.getByRole('button', { name: 'Following · Unfollow Fantasy' })).toBeVisible();
    await expect(canvas.getByText('13 followers')).toBeVisible();
    await waitFor(() => expect(canvas.getByRole('button', { name: /^Following/ })).not.toHaveAttribute('aria-disabled',
      'true'));
    await userEvent.click(canvas.getByRole('button', { name: /^Following/ }));
    await expect(canvas.getByRole('button', { name: 'Follow · Fantasy' })).toBeVisible();
    await expect(canvas.getByText('12 followers')).toBeVisible();
  },
};

/** More Works than a page: "Show more" reads the next through the BFF. */
export const ShowMore: Story = {
  args: { works: ok(worksPage(state(), works.slice(0, 4), true)),
    loadWorks: worksLoader([{ ...discoveryWorks.pride, classifications: [] }]) },
  async play({ canvasElement }) {
    const list = within(within(canvasElement).getByRole('region', { name: 'Works' }));
    await expect(list.getByText('4+ works')).toBeVisible();
    await userEvent.click(list.getByRole('button', { name: 'Show more' }));
    await waitFor(() => expect(list.getAllByRole('heading', { level: 3 })).toHaveLength(5));
    await expect(list.getByRole('link', { name: discoveryWorks.pride.title.value })).toBeVisible();
    await expect(list.queryByRole('button', { name: 'Show more' })).toBeNull();
  },
};

export const NoMatches: Story = {
  args: (() => {
    const filtered = state({ include: [conceptUuid(4)], exclude: [conceptUuid(3)] });
    return { state: filtered, works: ok(worksPage(filtered, [])) };
  })(),
  async play({ canvasElement }) {
    const list = within(within(canvasElement).getByRole('region', { name: 'Works' }));
    await expect(list.getByText('No works match these Conditions')).toBeVisible();
    await expect(list.getByRole('link', { name: 'Show all works with Fantasy' })).toHaveAttribute('href',
      `/en/concepts/${conceptUuid(1)}`);
  },
};

export const NoWorksYet: Story = {
  args: { works: ok(worksPage(state(), [])) },
  async play({ canvasElement }) {
    await expect(within(canvasElement).getByText('No works with Fantasy yet')).toBeVisible();
  },
};

/** A newer decision than the list: its matches wait for the refresh rather than show out of date. */
export const Updating: Story = {
  args: { works: ok(worksPage(state(), [], false, { stale: true })) },
  async play({ canvasElement }) {
    await expect(within(canvasElement).getByText('Works are being updated')).toBeVisible();
  },
};

/** A value in the link is no longer public: say so and offer the Concept's own Works. */
export const ValueMissing: Story = {
  args: { state: state({ include: [conceptUuid(99)] }), works: failed('missing') },
  async play({ canvasElement }) {
    const list = within(within(canvasElement).getByRole('region', { name: 'Works' }));
    await expect(list.getByText('A Concept in this link isn’t available')).toBeVisible();
    await expect(list.getByRole('link', { name: 'Show all works with Fantasy' })).toBeVisible();
  },
};

/** A community's Concept, opened from its page: its Works as that community accepted them. */
export const CommunityConcept: Story = {
  args: (() => {
    const scoped = state({ concept: localConcept.id.slice(-36), scope: { kind: 'realm', realm: localRealm } });
    return { concept: localConcept, state: scoped, works: failed('unbuilt'),
      realms: { [localRealm]: { value: 'Tidewater Readers', language: 'en', direction: 'ltr', basis: 'requested' } } };
  })(),
  parameters: { route: { pathname: `/en/concepts/${localConcept.id.slice(-36)}` } },
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await expect(canvas.getByText('From Tidewater Readers')).toBeVisible();
    const scope = within(canvas.getByRole('navigation', { name: 'Accepted by' }));
    await expect(scope.getByRole('link', { name: 'In Tidewater Readers' })).toHaveAttribute('aria-current', 'true');
    await expect(scope.getByRole('link', { name: 'Everyone' })).toHaveAttribute('href',
      `/en/concepts/${localConcept.id.slice(-36)}`);
    await expect(canvas.getByText('Works aren’t ready here yet')).toBeVisible();
    await expect(canvas.getByRole('link', { name: 'See everyone’s works' })).toBeVisible();
  },
};

export const Failed: Story = {
  args: { works: failed('unavailable'), follow: failed('unavailable') },
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole('alert')).toHaveTextContent('Couldn’t load works');
    await expect(canvas.getByRole('button', { name: 'Retry' })).toBeVisible();
    await expect(canvas.queryByText(/followers?$/)).toBeNull();
  },
};

export const ChineseDark: Story = {
  args: { locale: 'zh-Hans', messages: zh, facet: facetLabel(conceptFacet, 'zh-Hans'),
    state: state({ include: [conceptUuid(2)] }),
    works: ok(worksPage(state({ include: [conceptUuid(2)] }), [works[2]!])) },
  globals: { locale: 'zh-Hans', theme: 'dark' },
  parameters: { route: { pathname: `/zh-Hans/concepts/${conceptUuid(1)}` } },
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await expect(canvas.getByText('标签')).toBeVisible();
    await expect(canvas.getByRole('region', { name: '条件' })).toHaveTextContent('作品包含');
    await expect(canvas.getByText('已包含：Magic schools')).toBeInTheDocument();
    await expect(within(canvas.getByRole('region', { name: '作品' })).getByText('1 部作品')).toBeVisible();
  },
};

export const Phone: Story = {
  args: (() => {
    const filtered = state({ include: [conceptUuid(8)], exclude: [conceptUuid(3)] });
    return { state: filtered, works: ok(worksPage(filtered, works)) };
  })(),
  globals: { viewport: { value: 'phone' } },
  play: noOverflow,
};

export const PhoneChineseDark: Story = {
  args: { ...Phone.args, locale: 'zh-Hans', messages: zh, facet: facetLabel(conceptFacet, 'zh-Hans') },
  globals: { viewport: { value: 'phone' }, locale: 'zh-Hans', theme: 'dark' },
  play: noOverflow,
};

/** A link whose Conditions repeat or contradict themselves is said so, never silently widened. */
export const MalformedLink: Story = {
  render: args => <ConceptMalformed concept={conceptUuid(1)} locale={args.locale} messages={args.messages} />,
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole('heading', { level: 1, name: 'This link’s Conditions aren’t valid' })).toBeVisible();
    await expect(canvas.getByRole('link', { name: 'Works' })).toHaveAttribute('href', `/en/concepts/${conceptUuid(1)}`);
  },
};

export const Unavailable: Story = {
  render: args => <ConceptUnavailable state={args.state} locale={args.locale} messages={args.messages} />,
  async play({ canvasElement }) {
    await expect(within(canvasElement).getByRole('alert')).toHaveTextContent('This Concept can’t be shown right now');
  },
};

