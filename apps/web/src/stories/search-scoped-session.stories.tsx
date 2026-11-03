import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, within } from 'storybook/test';
import { AppShell } from '../shell/shell';
import { discoveryExample } from '../kernel/fake/search-discovery';
import { getLocale } from '../paraglide/runtime.js';
import { SearchPage } from '../search/search';
import { searchUnavailablePage } from '../search/search-recovery';
import { discoverySearchHref, searchLoaderDeps } from '../search/search-params';
import type { RealmRatingReadiness } from '../search/rating-population';
import { PageStory, pageReady, PatternStory } from './page';

const realmId = '5a522c45-d94f-4d36-8b2a-3af80d988cff';
const collectionId = '438cb7b1-e7a2-4a40-831e-a90b1b143264';
const ratingPopulationId = '00000000-0000-4000-8000-000000000123';
const collectionFilter = JSON.stringify({ collection: { id: collectionId } });
const realmFilter = JSON.stringify({ realm: { id: realmId } });
const protectedPath = (filter: string, population = ratingPopulationId) => {
  const params = new URLSearchParams({ q: 'Mira', sort: 'rating', ratingPopulation: population, filter });
  return `/search?${params}`;
};

const meta = {
  title: 'Pages/Discovery/Search/Scoped session',
  parameters: {
    layout: 'fullscreen',
    viewport: {
      options: {
        phone390: { name: 'Phone 390', styles: { width: '390px', height: '844px' } },
        desktop1280: { name: 'Desktop 1280', styles: { width: '1280px', height: '900px' } },
      },
    },
    docs: {
      description: {
        component:
          'Page wiring stories use the existing recorded public Search response. The scoped rows and typed Realm rating outcomes are constructed examples, not native authorization or complete-order evidence. The selected Realm order remains unavailable in the running route until its Content adapter is installed.',
      },
    },
  },
} satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;

export const CollectionMembershipWithGlobalRating: Story = {
  name: 'Signed-in Collection results and native Global rating',
  render: () => <PageStory visitor="Signed In" path={`/search?q=Mira&sort=rating&filter=${encodeURIComponent(collectionFilter)}`} />,
  play: async ({ canvasElement }) => {
    await pageReady({ canvasElement });
    await expect(await within(canvasElement).findByText('Mira Reading Room')).toBeVisible();
    const more = within(canvasElement).queryByRole('link', { name: /More results/ });
    if (more) await expect(new URL(more.getAttribute('href')!, 'https://example.test').searchParams.get('filter')).toBe(collectionFilter);
  },
};

export const RealmRatingUnavailable: Story = {
  name: 'Selected Realm rating stays unavailable',
  render: () => <PageStory visitor="Signed In" path={protectedPath(collectionFilter)} />,
  play: async ({ canvasElement }) => {
    await pageReady({ canvasElement });
    const main = within(canvasElement).getByRole('main');
    await expect(await within(main).findByText(/Realm rating order is unavailable/)).toBeVisible();
    const retry = within(main).getByRole('link', { name: /Retry this Realm search/ });
    const url = new URL(retry.getAttribute('href')!, 'https://example.test');
    await expect(url.searchParams.get('ratingPopulation')).toBe(ratingPopulationId);
    await expect(url.searchParams.get('filter')).toBe(collectionFilter);
    await expect(url.searchParams.has('cursor')).toBe(false);
  },
};

export const SignedOutScopedReturn: Story = {
  name: 'Signed-out scope retains its return URL',
  render: () => <PageStory visitor="Signed Out" path={protectedPath(realmFilter)} />,
  play: async ({ canvasElement }) => {
    await pageReady({ canvasElement });
    const main = within(canvasElement).getByRole('main');
    const signIn = await within(main).findByRole('link', { name: /Sign in/ });
    const returnTo = new URL(new URL(signIn.getAttribute('href')!, 'https://example.test').searchParams.get('return_to')!, 'https://example.test');
    await expect(returnTo.searchParams.get('ratingPopulation')).toBe(ratingPopulationId);
    await expect(returnTo.searchParams.get('filter')).toBe(realmFilter);
  },
};

export const MalformedResourceRemainsCorrectable: Story = {
  name: 'Malformed Realm scope remains correctable',
  render: () => <PageStory visitor="Signed In" path={`/search?q=Mira&filter=${encodeURIComponent('{"realm":{"id":"bad"}}')}`} />,
  play: async ({ canvasElement }) => {
    await pageReady({ canvasElement });
    const input = within(canvasElement).getByRole('textbox');
    await expect(input).toHaveValue('{"realm":{"id":"bad"}}');
  },
};

export const MalformedPopulationRemainsCorrectable: Story = {
  name: 'Malformed rating population remains correctable',
  render: () => <PageStory visitor="Signed In" path="/search?q=Mira&ratingPopulation=not-a-realm-id" />,
  play: async ({ canvasElement }) => {
    await pageReady({ canvasElement });
    const input = within(canvasElement).getByRole('textbox');
    await expect(input).toHaveValue('not-a-realm-id');
  },
};

function ConstructedRatingOutcome({ readiness }: { readiness: RealmRatingReadiness }) {
  const state = searchLoaderDeps({
    q: 'Mira',
    filter: collectionFilter,
    sort: 'rating',
    ratingPopulation: ratingPopulationId,
    cursor: 'opaque-rating-cursor',
  });
  const data = {
    ...searchUnavailablePage(state),
    recovery: { status: 'ready' as const },
    discovery: { status: 'ready' as const, page: discoveryExample },
    ratingPopulation: state.ratingPopulation,
    ratingReadiness: readiness,
  };
  return (
    <PatternStory path={discoverySearchHref(getLocale(), state)}>
      <AppShell>
        <SearchPage query={state.query} data={data} locale={getLocale()} session='["signed-in","story-reader"]' />
      </AppShell>
    </PatternStory>
  );
}

export const ConstructedPreparingOrder: Story = {
  name: 'Constructed native preparing state',
  render: () => <ConstructedRatingOutcome readiness={{ status: 'preparing' }} />,
};

export const ConstructedRefusedOrder: Story = {
  name: 'Constructed native refused state',
  render: () => <ConstructedRatingOutcome readiness={{ status: 'refused' }} />,
};

export const ConstructedRestartOrder: Story = {
  name: 'Constructed native generation restart',
  render: () => <ConstructedRatingOutcome readiness={{ status: 'generation-change' }} />,
};
