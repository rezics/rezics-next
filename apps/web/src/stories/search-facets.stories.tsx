import type { Meta, StoryObj } from '@storybook/react-vite';
import { useSuspenseQuery } from '@tanstack/react-query';
import { Suspense } from 'react';
import { expect, within } from 'storybook/test';
import { searchFacetStoryPaths } from '../kernel/fake/search-facets';
import { getLocale } from '../paraglide/runtime.js';
import { m } from '../paraglide/messages.js';
import { SearchPage } from '../search/search';
import { searchQueryOptions } from '../search/search-queries';
import { searchLoaderDeps } from '../search/search-params';
import { PatternStory } from './page';

const viewports = {
  phone: { name: 'Phone', styles: { width: '390px', height: '844px' } },
  desktop: { name: 'Desktop', styles: { width: '1280px', height: '900px' } },
};

const meta = {
  title: 'Patterns/Discovery/Search filters',
  parameters: { viewport: { options: viewports } },
} satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;

const filterStoryParams = searchLoaderDeps({
  q: 'Prince',
  type: 'schema:Book',
  'f.schema:genre': '01a17dfd-5da5-76da-bc50-a1fb5dbc87d2',
});

function SearchFilterPattern() {
  const { data } = useSuspenseQuery(searchQueryOptions(getLocale(), filterStoryParams));
  return <SearchPage query={filterStoryParams.query} data={data} filtersOnly initiallyOpen />;
}

export const FilterSheetOpen: Story = {
  name: 'Filter sheet open',
  globals: { viewport: { value: 'phone' } },
  play: async ({ canvasElement }) => {
    const view = within(canvasElement);
    await expect(view.queryByRole('banner')).toBeNull();
    await expect(view.queryByRole('navigation')).toBeNull();

    const dialog = await within(document.body).findByRole('dialog');
    await expect(dialog).toBeVisible();
    await within(dialog).getByText(m.search_filters(), { exact: false });
    const fableLabel = getLocale() === 'zh-Hans' || getLocale() === 'zh-Hant' ? '寓言' : 'Fable';
    const fable = within(dialog).getByRole('checkbox', { name: fableLabel });
    await expect(fable).toBeChecked();
    await expect(fable).toBeEnabled();
  },
  render: () => (
    <PatternStory path={searchFacetStoryPaths.active}>
      <Suspense fallback={null}>
        <div className="w-full max-w-xs p-4">
          <SearchFilterPattern />
        </div>
      </Suspense>
    </PatternStory>
  ),
};
