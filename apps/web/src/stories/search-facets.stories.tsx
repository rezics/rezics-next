import type { Meta, StoryObj } from '@storybook/react-vite';
import { useEffect } from 'react';
import { expect, within } from 'storybook/test';
import { PageStory, pagePaths, pageReady, searchEmptyReady, searchTypedReady } from './page';

const meta = { title: 'Pages/Search Facets', parameters: { layout: 'fullscreen' } } satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;

export const ResultsWithFacets: Story = {
  name: 'Results with facets',
  play: searchTypedReady,
  render: () => <PageStory visitor="Signed Out" path={pagePaths['search-facets']} />,
};

export const ActiveFacet: Story = {
  name: 'Active facet',
  play: async (context) => {
    await searchTypedReady(context);
    await expect(within(context.canvasElement).getByRole('checkbox', { name: 'Fantasy' })).toBeChecked();
  },
  render: () => <PageStory visitor="Signed Out" path={pagePaths['search-facet-active']} />,
};

export const NoResults: Story = {
  name: 'No results',
  play: searchEmptyReady,
  render: () => <PageStory visitor="Signed Out" path={pagePaths['search-no-results']} />,
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

export const PhoneFilterSheetOpen: Story = {
  name: 'Phone filter sheet open',
  play: async (context) => {
    await searchTypedReady(context);
    const view = within(context.canvasElement);
    const trigger = view.queryByRole('button', { name: /Filters/ });
    const dialog = within(document.body).queryByRole('dialog');
    if (trigger && !dialog && getComputedStyle(trigger).display !== 'none') await trigger.click();
    if (window.innerWidth < 1024) await expect(within(document.body).getByRole('dialog')).toBeVisible();
  },
  render: () => <PhoneFilterSheetStory />,
};

function PhoneFilterSheetStory() {
  useEffect(() => {
    if (window.innerWidth >= 1024) return;
    const open = () => {
      const trigger = document.querySelector<HTMLButtonElement>('main button[aria-label^="Filters"]');
      if (!trigger) return false;
      trigger.click();
      return true;
    };
    if (open()) return;
    const observer = new MutationObserver(() => {
      if (open()) observer.disconnect();
    });
    observer.observe(document.body, { childList: true, subtree: true });
    const timeout = window.setTimeout(() => observer.disconnect(), 10_000);
    return () => {
      observer.disconnect();
      window.clearTimeout(timeout);
    };
  }, []);
  return <PageStory visitor="Signed Out" path={pagePaths['search-facets']} />;
}
