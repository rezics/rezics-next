import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, fn, userEvent, within } from 'storybook/test';
import type { RealmDiscoveryState } from '../community/realm-discovery';
import { m } from '../paraglide/messages.js';
import { getLocale } from '../paraglide/runtime.js';
import { SearchPage } from '../search/search';
import { searchLoaderDeps } from '../search/search-params';
import type { RealmDiscoveryReader } from '../search/realm-discovery-loader';
import { AppShell } from '../shell/shell';
import { PageStory, PatternStory, pageReady } from './page';

const firstCursor = 'native+/= first';
const nextCursor = 'native+/= second';
const sparseRead = fn<RealmDiscoveryReader>(async ({ data }) => ({
  kind: 'ready',
  realms: [],
  next: data.cursor === firstCursor ? nextCursor : null,
}));
const retryRead = fn<RealmDiscoveryReader>(async () => ({ kind: 'unavailable' }));
const meta = {
  title: 'Pages/Discovery/Search Realm Discovery',
  parameters: {
    layout: 'fullscreen',
    docs: {
      description: {
        component:
          'The existing Search page and sole Content section. EmptyQuery uses the installed producer. Continuation fixtures exercise only empty typed pages and transport failure; they do not certify native ranking or presentation readiness.',
      },
    },
  },
  beforeEach: () => {
    sparseRead.mockClear();
    retryRead.mockReset();
    retryRead
      .mockResolvedValueOnce({ kind: 'unavailable' })
      .mockResolvedValue({ kind: 'ready', realms: [], next: null });
  },
} satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;

function FixturePage({ initial, read }: { initial: RealmDiscoveryState; read: RealmDiscoveryReader }) {
  return (
    <PatternStory path="/search">
      <AppShell>
        <SearchPage
          query=""
          data={{
            queryState: searchLoaderDeps({}),
            hitTypes: {},
            yearProperties: [],
            typeChoices: [],
            groups: [],
            selectedFacets: {},
            selectedFacetLabels: {},
            facetsAvailable: false,
            facetRetry: false,
            facetIndexNotReady: false,
            staleCursorRestarted: false,
            sort: 'relevance',
          }}
          realmDiscovery={initial}
          realmDiscoveryRead={read}
        />
      </AppShell>
    </PatternStory>
  );
}

export const EmptyQuery: Story = {
  render: () => <PageStory visitor="Signed Out" path="/search" />,
  play: async (context) => {
    await pageReady(context);
    const main = within(within(context.canvasElement).getByRole('main'));
    await expect(await main.findByRole('heading', { name: m.header_search_popular_realms() })).toBeVisible();
  },
};

export const SparseContinuation: Story = {
  render: () => <FixturePage initial={{ kind: 'ready', realms: [], next: firstCursor }} read={sparseRead} />,
  play: async ({ canvasElement }) => {
    await pageReady({ canvasElement });
    const canvas = within(within(canvasElement).getByRole('main'));
    const more = await canvas.findByRole('button', { name: m.realm_discovery_continue() });
    await expect(sparseRead).not.toHaveBeenCalled();
    await userEvent.click(more);
    await expect(more).toBeEnabled();
    await expect(sparseRead).toHaveBeenCalledTimes(1);
    await expect(sparseRead.mock.calls[0]?.[0].data).toEqual({
      locale: getLocale(),
      sort: 'popular',
      cursor: firstCursor,
    });
    await userEvent.click(more);
    await expect(canvas.queryByRole('button', { name: m.realm_discovery_continue() })).toBeNull();
    await expect(sparseRead).toHaveBeenCalledTimes(2);
    await expect(sparseRead.mock.calls[1]?.[0].data.cursor).toBe(nextCursor);
  },
};

export const UnavailableRetry: Story = {
  render: () => <FixturePage initial={{ kind: 'unavailable' }} read={retryRead} />,
  play: async ({ canvasElement }) => {
    await pageReady({ canvasElement });
    const canvas = within(within(canvasElement).getByRole('main'));
    await userEvent.click(await canvas.findByRole('button', { name: m.realm_discovery_retry() }));
    await userEvent.click(await canvas.findByRole('button', { name: m.realm_discovery_retry() }));
    await expect(retryRead).toHaveBeenCalledTimes(2);
    await expect(retryRead.mock.calls.map(([call]) => call.data)).toEqual([
      { locale: getLocale(), sort: 'popular' },
      { locale: getLocale(), sort: 'popular' },
    ]);
    await expect(canvas.queryByRole('button', { name: m.realm_discovery_retry() })).toBeNull();
  },
};

export const ContinuationRetry: Story = {
  render: () => <FixturePage initial={{ kind: 'ready', realms: [], next: firstCursor }} read={retryRead} />,
  play: async ({ canvasElement }) => {
    await pageReady({ canvasElement });
    const canvas = within(within(canvasElement).getByRole('main'));
    await userEvent.click(await canvas.findByRole('button', { name: m.realm_discovery_continue() }));
    await userEvent.click(await canvas.findByRole('button', { name: m.search_facet_retry() }));
    await expect(retryRead).toHaveBeenCalledTimes(2);
    await expect(retryRead.mock.calls.map(([call]) => call.data.cursor)).toEqual([firstCursor, firstCursor]);
    await expect(canvas.queryByRole('button', { name: m.search_facet_retry() })).toBeNull();
    await expect(canvas.queryByRole('button', { name: m.realm_discovery_continue() })).toBeNull();
  },
};
