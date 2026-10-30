import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, within } from 'storybook/test';
import {
  PageStory,
  pagePaths,
  pageReady,
  searchEmptyReady,
  searchRatingReady,
  searchReady,
  searchTypedReady,
} from './page';

const meta = { title: 'Pages/Discovery/Search', parameters: { layout: 'fullscreen' } } satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;

export const SignedOut: Story = {
  name: 'Signed out',
  play: searchReady,
  render: () => <PageStory visitor="Signed Out" path={pagePaths.search} />,
};

export const SignedIn: Story = {
  name: 'Member',
  play: searchReady,
  render: () => <PageStory visitor="Signed In" path={pagePaths.search} />,
};

export const Typed: Story = {
  name: 'Typed query',
  play: searchTypedReady,
  render: () => <PageStory visitor="Signed Out" path={pagePaths['search-typed']} />,
};

export const EmptyQuery: Story = {
  name: 'Empty query',
  play: async (context) => {
    await pageReady(context);
    const view = within(context.canvasElement).getByRole('main');
    await expect(within(view).getByRole('textbox')).toHaveValue('');
  },
  render: () => <PageStory visitor="Signed Out" path={pagePaths['search-empty-query']} />,
};

export const NoResults: Story = {
  name: 'No results',
  play: searchEmptyReady,
  render: () => <PageStory visitor="Signed Out" path={pagePaths['search-no-results']} />,
};

export const Facets: Story = {
  name: 'Results with facets',
  play: searchTypedReady,
  render: () => <PageStory visitor="Signed Out" path={pagePaths['search-facets']} />,
};

export const ActiveFacet: Story = {
  name: 'Fable facet selected',
  play: async (context) => {
    await searchTypedReady(context);
    await expect(within(context.canvasElement).getByRole('checkbox', { name: 'Fable' })).toBeChecked();
  },
  render: () => <PageStory visitor="Signed Out" path={pagePaths['search-facet-active']} />,
};

export const TopRated: Story = {
  name: 'Sorted by rating',
  play: searchRatingReady,
  render: () => <PageStory visitor="Signed Out" path={pagePaths['search-rating']} />,
};
