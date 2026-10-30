import type { Meta, StoryObj } from '@storybook/react-vite';
import { useSuspenseQuery } from '@tanstack/react-query';
import { Suspense } from 'react';
import { expect, userEvent, waitFor, within } from 'storybook/test';
import recording from '../../kernel/recorded/search.json';
import { searchFacetStoryPaths } from '../../kernel/fake/search-facets';
import { getLocale } from '../../paraglide/runtime.js';
import { m } from '../../paraglide/messages.js';
import { HeaderSearch, type HeaderSearchProps } from '../../search/header-search/header-search';
import { HeaderSearchFilterProvider } from '../../search/header-search/filter-region';
import type { HeaderSuggestionLoader } from '../../search/header-search/suggestions';
import { SearchPage } from '../../search/search';
import { searchQueryOptions } from '../../search/search-queries';
import { searchLoaderDeps } from '../../search/search-params';
import { PatternStory } from '../page';

const suggestions = { subjects: recording.subjects, types: { 'schema:Book': { en: 'Book', 'zh-Hans': '图书' } } };
const ready: HeaderSuggestionLoader = async () => suggestions;
const empty: HeaderSuggestionLoader = async () => ({ ...suggestions, subjects: [] });
const failed: HeaderSuggestionLoader = async () => {
  throw new globalThis.Error('Suggestion boundary unavailable');
};
const pending: HeaderSuggestionLoader = (_query, _locale, signal) =>
  new Promise((_resolve, reject) => {
    signal.addEventListener('abort', () => reject(signal.reason), { once: true });
  });
const scope = { kind: 'Collection', id: 'reading', name: 'Reading list' } as const;
const filterParams = searchLoaderDeps({
  q: 'Prince',
  type: 'schema:Book',
  'f.schema:genre': '01a17dfd-5da5-76da-bc50-a1fb5dbc87d2',
});

function CurrentFilters() {
  const { data } = useSuspenseQuery(searchQueryOptions(getLocale(), filterParams));
  return <SearchPage query={filterParams.query} data={data} filtersOnly />;
}

function Example({ filters = false, ...props }: Partial<HeaderSearchProps> & { filters?: boolean }) {
  return (
    <PatternStory path={searchFacetStoryPaths.active}>
      <HeaderSearchFilterProvider>
        <div className="min-h-96 p-4">
          <div className="relative mx-auto w-full max-w-xl">
            <HeaderSearch locale={getLocale()} loadSuggestions={ready} onNavigate={() => undefined} {...props} />
          </div>
          <button type="button" className="mt-16 text-sm">
            Outside the search
          </button>
          {filters && (
            <Suspense fallback={null}>
              <div className="mt-6">
                <CurrentFilters />
              </div>
            </Suspense>
          )}
        </div>
      </HeaderSearchFilterProvider>
    </PatternStory>
  );
}

const meta = {
  title: 'Patterns/Header Search',
  component: HeaderSearch,
  args: { locale: 'en' },
  parameters: {
    layout: 'fullscreen',
    viewport: {
      options: {
        phone390: { name: 'Phone 390', styles: { width: '390px', height: '844px' } },
        desktop1280: { name: 'Desktop 1280', styles: { width: '1280px', height: '900px' } },
      },
    },
  },
  render: () => <Example />,
} satisfies Meta<typeof HeaderSearch>;
export default meta;
type Story = StoryObj<typeof meta>;

async function expand({ canvasElement }: { canvasElement: HTMLElement }) {
  const canvas = within(canvasElement);
  if (window.matchMedia('(max-width: 767px)').matches)
    await userEvent.click(await canvas.findByRole('button', { name: m.search_label(), exact: true }));
  else await userEvent.click(await canvas.findByRole('combobox', { name: m.search_label() }));
  const input = await canvas.findByRole('combobox', { name: m.search_label() });
  await expect(input).toHaveAttribute('aria-expanded', 'true');
  await expect(canvasElement.querySelectorAll('input[role="combobox"]')).toHaveLength(1);
  return { canvas, input };
}

export const Rest: Story = {
  play: async (context) => {
    await expand(context);
    await userEvent.keyboard('{Escape}');
    await expect(context.canvasElement.querySelector('input[role="combobox"]')).toHaveAttribute(
      'aria-expanded',
      'false',
    );
  },
};
export const ScopeChip: Story = {
  render: () => <Example scope={scope} />,
  play: async (context) => {
    const { canvas } = await expand(context);
    await expect(
      canvas.getByRole('button', { name: m.header_search_remove_scope({ scope: scope.name }) }),
    ).toBeVisible();
    await userEvent.keyboard('{Escape}');
  },
};
export const Expanded: Story = {
  play: async (context) => {
    const { canvas } = await expand(context);
    await expect(canvas.getByRole('button', { name: m.search_submit(), exact: true })).toBeDisabled();
  },
};
export const Typing: Story = {
  render: () => <Example loadSuggestions={pending} />,
  play: async (context) => {
    const { input } = await expand(context);
    await userEvent.type(input, 'The');
    await expect(input).toHaveValue('The');
  },
};
export const ScopeRemoved: Story = {
  render: () => <Example scope={scope} />,
  play: async (context) => {
    const { canvas, input } = await expand(context);
    await userEvent.keyboard('{Backspace}');
    await expect(
      canvas.queryByRole('button', { name: m.header_search_remove_scope({ scope: scope.name }) }),
    ).toBeNull();
    await expect(input).toHaveAttribute('placeholder', m.header_search_global());
  },
};
export const FiltersOpen: Story = {
  render: () => <Example filters />,
  play: async (context) => {
    const { canvas } = await expand(context);
    const footer = context.canvasElement.querySelector<HTMLElement>('[data-header-search]')!;
    const action = within(footer).getByRole('button', { name: new RegExp(m.search_filters()) });
    await waitFor(() => expect(action).toBeEnabled());
    await userEvent.click(action);
    const view = window.matchMedia('(min-width: 1024px)').matches
      ? canvas
      : within(await within(document.body).findByRole('dialog'));
    const fable = getLocale() === 'zh-Hans' || getLocale() === 'zh-Hant' ? '寓言' : 'Fable';
    await expect(await view.findByRole('checkbox', { name: fable })).toBeChecked();
  },
};
export const Suggestions: Story = {
  play: async (context) => {
    const { canvas, input } = await expand(context);
    await userEvent.type(input, 'The');
    await waitFor(() => expect(canvas.getAllByRole('option')).toHaveLength(suggestions.subjects.length));
    await userEvent.keyboard('{ArrowDown}');
    await expect(input).toHaveAttribute('aria-activedescendant');
  },
};
export const NoResults: Story = {
  render: () => <Example loadSuggestions={empty} />,
  play: async (context) => {
    const { canvas, input } = await expand(context);
    await userEvent.type(input, 'Unknown');
    await canvas.findByText(m.search_no_suggestions());
  },
};
export const Loading: Story = {
  render: () => <Example loadSuggestions={pending} />,
  play: async (context) => {
    const { canvas, input } = await expand(context);
    await userEvent.type(input, 'Prince');
    await canvas.findByText(m.header_search_loading());
  },
};
export const Error: Story = {
  render: () => <Example loadSuggestions={failed} />,
  play: async (context) => {
    const { canvas, input } = await expand(context);
    await userEvent.type(input, 'Prince');
    await canvas.findByText(m.search_suggestions_failed());
  },
};
export const PhoneSheet: Story = {
  render: () => <Example presentation="sheet" />,
  play: async (context) => {
    const { canvas, input } = await expand(context);
    await expect(canvas.getByRole('dialog', { name: m.search_label() })).toBeVisible();
    await userEvent.keyboard('{Shift>}{Tab}{/Shift}');
    await expect(canvas.getByRole('button', { name: m.header_search_close() })).toHaveFocus();
    await userEvent.keyboard('{Tab}');
    await expect(input).toHaveFocus();
  },
};
