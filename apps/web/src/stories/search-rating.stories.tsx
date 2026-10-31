import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, within } from 'storybook/test';
import { m } from '../paraglide/messages.js';
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

export const MixedCards: Story = {
  render: () => <PageStory visitor="Signed Out" path="/search?q=Mira" />,
  play: async (context) => {
    await pageReady(context);
    const main = within(context.canvasElement).getByRole('main');
    await within(main).findByText('Mira Reading Room');
    await expect(main.querySelectorAll('[data-slot="discovery-results"] > li')).toHaveLength(4);
    const canvas = within(context.canvasElement);
    if (window.matchMedia('(max-width: 767px)').matches)
      await userEvent.click(canvas.getByRole('button', { name: m.search_label() }));
    else await userEvent.click(canvas.getByRole('combobox', { name: m.search_label() }));
    const input = canvas.getByRole('combobox', { name: m.search_label() });
    await userEvent.clear(input);
    await userEvent.type(input, 'Mira unavailable{Enter}');
    await expect(await canvas.findByText(m.search_failed())).toBeVisible();
  },
};
export const MixedUnavailable: Story = {
  render: () => <PageStory visitor="Signed Out" path="/search?q=Mira%20unavailable" />,
  play: async (context) => {
    await pageReady(context);
    await expect(await within(context.canvasElement).findByText(m.search_failed())).toBeVisible();
  },
};
export const MixedPreparing: Story = {
  render: () => <PageStory visitor="Signed Out" path="/search?q=Mira%20preparing" />,
  play: async (context) => {
    await pageReady(context);
    await expect(await within(context.canvasElement).findByText(m.discovery_not_ready())).toBeVisible();
  },
};

export const FactualUnknownKind: Story = {
  render: () => <PageStory visitor="Signed Out" path="/search?q=Mira%20facts" />,
  play: async (context) => {
    await pageReady(context);
    const main = within(context.canvasElement).getByRole('main');
    await within(main).findByText('An atlas of nearby stars.');
    await expect(within(main).getByText('Maps of Mira')).toBeVisible();
    await expect(main.querySelector('[data-slot="public-rating-figure"]')).toHaveTextContent(
      m.rating_public_mean({ mean: '8', maximum: '10' }),
    );
  },
};
export const RestartRequired: Story = {
  render: () => <PageStory visitor="Signed Out" path="/search?q=Mira%20restart&cursor=old%2B%2F%3D" />,
  play: async (context) => {
    await pageReady(context);
    const main = within(context.canvasElement).getByRole('main');
    const restart = await within(main).findByRole('link', { name: m.discovery_restart_action() });
    await expect(restart).toHaveAttribute('href', expect.stringContaining('q=Mira+restart'));
    await expect(restart).not.toHaveAttribute('href', expect.stringContaining('cursor='));
  },
};
export const ContinuedResults: Story = {
  render: () => <PageStory visitor="Signed Out" path="/search?q=Mira%20continued&cursor=opaque-hits-page%2B%2F%3D" />,
  play: async (context) => {
    await pageReady(context);
    const main = within(context.canvasElement).getByRole('main');
    await within(main).findByText('Mira Reading Room');
    await expect(main.querySelectorAll('[data-slot="discovery-results"] > li')).toHaveLength(3);
    await expect(within(main).queryByRole('link', { name: m.search_more() })).toBeNull();
  },
};

export const MoreKindMetadata: Story = {
  render: () => <PageStory visitor="Signed Out" path="/search?q=Mira%20facts" />,
  play: async (context) => {
    await pageReady(context);
    const canvas = within(context.canvasElement);
    await canvas.findByText('An atlas of nearby stars.');
    // Open the existing header search/filter interaction on either viewport.
    if (window.matchMedia('(max-width: 767px)').matches)
      await userEvent.click(canvas.getByRole('button', { name: m.search_label() }));
    else await userEvent.click(canvas.getByRole('combobox', { name: m.search_label() }));
    await userEvent.click(canvas.getByRole('button', { name: m.search_filters() }));
    const page = within(context.canvasElement.ownerDocument.body);
    await userEvent.click(page.getByRole('button', { name: m.discovery_more_kinds() }));
    await expect(await page.findByRole('checkbox', { name: /Atlas/ })).toBeEnabled();
    await expect(context.canvasElement.querySelectorAll('[data-slot="discovery-results"] > li')).toHaveLength(5);
  },
};
