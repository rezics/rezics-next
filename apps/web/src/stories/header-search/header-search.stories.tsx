import type { Meta, StoryObj } from '@storybook/react-vite';
import { useSuspenseQuery } from '@tanstack/react-query';
import { Suspense, useState } from 'react';
import { expect, fn, userEvent, waitFor, within } from 'storybook/test';
import recording from '../../kernel/recorded/search.json';
import { problem } from '../../media/kernel';
import { searchFacetStoryPaths } from '../../kernel/fake/search-facets';
import { getLocale } from '../../paraglide/runtime.js';
import { m } from '../../paraglide/messages.js';
import { HeaderSearch, type HeaderSearchProps } from '../../search/header-search/header-search';
import { HeaderSearchFilterProvider } from '../../search/header-search/filter-region';
import type { HeaderSuggestionLoader } from '../../search/header-search/suggestions';
import { rememberRecent, type RecentHistory } from '../../search/recent-history';
import type { SearchRealmDiscoveryLoader } from '../../search/realm-discovery-section';
import { trendingResponse, type TrendingPage } from '../../search/trending';
import { SearchPage } from '../../search/search';
import { searchQueryOptions } from '../../search/search-queries';
import { searchLoaderDeps } from '../../search/search-params';
import { PatternStory } from '../page';
import { discoveryRealm } from '../patterns/realm-discovery/fixtures';

// Illustrative component recordings, not evidence of native qualification or availability.
const trending: TrendingPage = {
  trendingSearches: [
    { query: '"Dune"', display: 'Dune' },
    { query: '"Earthsea"', display: 'Earthsea' },
  ],
  next: null,
};
const realms: SearchRealmDiscoveryLoader = async () => ({ kind: 'ready', realms: [discoveryRealm], next: null });
const unavailableRealms: SearchRealmDiscoveryLoader = async () => ({ kind: 'unavailable' });
const closedRealms: SearchRealmDiscoveryLoader = async () => ({ kind: 'closed' });

const suggestions = {
  as_of: recording.as_of,
  subjects: recording.subjects.map(({ id, type, labels, summary }) => ({
    id,
    type,
    labels,
    summary: summary ?? null,
  })),
  types: { 'schema:Book': { en: 'Book', 'zh-Hans': '图书' } },
};
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
  const [entries, setEntries] = useState(() =>
    rememberRecent(rememberRecent([], 'Kokoro', undefined, 1), 'The Little Prince', undefined, 2),
  );
  const history: RecentHistory = {
    entries,
    persistence: 'local',
    sync: 'local-only',
    remember: (query, scope) => setEntries((current) => rememberRecent(current, query, scope)),
    remove: (id) => setEntries((current) => current.filter((entry) => entry.id !== id)),
    clear: () => setEntries([]),
  };
  return (
    <PatternStory path={searchFacetStoryPaths.active}>
      <HeaderSearchFilterProvider>
        <div className="min-h-96 p-4">
          <div className="relative mx-auto w-full max-w-xl">
            <HeaderSearch
              locale={getLocale()}
              history={history}
              loadRealmDiscovery={realms}
              loadSuggestions={ready}
              onNavigate={() => undefined}
              {...props}
            />
          </div>
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
  beforeEach: ({ parameters }) => {
    const original = globalThis.fetch;
    globalThis.fetch = (async (input, init) => {
      const url = new URL(input instanceof Request ? input.url : String(input), window.location.href);
      if (url.pathname !== '/api/search/trending') return original(input, init);
      return trendingResponse(new Request(url, init), {}, async () => {
        if (parameters.trendingFailure) throw problem(503, parameters.trendingFailure, 'Unavailable');
        return trending;
      });
    }) as typeof fetch;
    return () => {
      globalThis.fetch = original;
    };
  },
} satisfies Meta<typeof HeaderSearch>;
export default meta;
type Story = StoryObj<typeof meta>;

/** Keeps scoped names, field purpose and shortcut help aligned in the real presenter. */
export const ScopedAccessibleNaming: Story = {
  globals: { viewport: { value: 'phone390' } },
  render: () => <Example scope={scope} keyboardShortcut />,
  play: async (context) => {
    const canvas = within(context.canvasElement);
    const owner = await waitFor(() => {
      const node = context.canvasElement.querySelector<HTMLElement>('[data-header-search]');
      if (!node?.querySelector('.header-search-trigger') || !node.querySelector('input[role="combobox"]'))
        throw new globalThis.Error('The scoped search naming surface is missing.');
      return node;
    });
    const trigger = owner.querySelector<HTMLButtonElement>('.header-search-trigger')!;
    const input = owner.querySelector<HTMLInputElement>('input[role="combobox"]')!;
    const help = owner.querySelector<HTMLElement>('[id$="-keyboard-help"]');
    if (!help) throw new globalThis.Error('The scoped search naming surface is missing.');

    const visibleName = trigger.innerText.replace(/\s+/gu, ' ').trim();
    await expect(trigger).toHaveAccessibleName(visibleName);
    await expect(trigger).toHaveAttribute('aria-label', visibleName);
    await expect(trigger).toHaveAccessibleDescription(m.header_search_keyboard_help());
    await expect(input).toHaveAttribute('aria-label', m.search_label());
    await expect(input).toHaveAttribute('placeholder', m.header_search_in_scope({ scope: scope.name }));

    await userEvent.click(trigger);
    const expandedInput = await canvas.findByRole('combobox', { name: m.search_label() });
    await expect(expandedInput).toHaveAccessibleName(m.search_label());
    await expect(expandedInput).toHaveAttribute('placeholder', m.header_search_in_scope({ scope: scope.name }));
    if (!input.getAttribute('aria-describedby')?.split(/\s+/u).includes(help.id)) {
      throw new globalThis.Error('The scoped search field lost its keyboard help description.');
    }

    await userEvent.type(expandedInput, 'Scoped draft');
    await userEvent.keyboard('{Escape}');
    await waitFor(() => expect(trigger).toBeVisible());
    const queryName = trigger.innerText.replace(/\s+/gu, ' ').trim();
    await expect(trigger).toHaveAccessibleName(queryName);
    await expect(trigger).toHaveAttribute('aria-label', queryName);
    await expect(trigger).toHaveAccessibleDescription(m.header_search_keyboard_help());
    await expect(canvas.getByRole('button', { name: queryName })).toBeVisible();
  },
};

async function expand({ canvasElement }: { canvasElement: HTMLElement }, triggerName = m.header_search_global()) {
  const canvas = within(canvasElement);
  if (window.matchMedia('(max-width: 1023px)').matches)
    await userEvent.click(await canvas.findByRole('button', { name: triggerName }));
  else await userEvent.click(await canvas.findByRole('combobox', { name: m.search_label() }));
  const input = await canvas.findByRole('combobox', { name: m.search_label() });
  await expect(input).toHaveAccessibleName(m.search_label());
  await expect(input).toHaveAttribute('aria-expanded', 'true');
  await expect(canvasElement.querySelectorAll('input[role="combobox"]')).toHaveLength(1);
  return { canvas, input };
}

async function populated(canvasElement: HTMLElement) {
  const canvas = within(canvasElement);
  const recentHeading = canvas.getByRole('heading', { name: m.header_search_recent() });
  await expect(recentHeading).toBeVisible();
  await expect(canvas.getByRole('button', { name: 'The Little Prince' })).toBeVisible();
  await expect(await canvas.findByRole('button', { name: 'Dune' })).toBeVisible();
  const trendingHeading = canvas.getByRole('heading', { name: m.header_search_trending_searches() });
  const communitiesHeading = await canvas.findByRole('heading', { name: m.realm_discovery_trending() });
  for (const heading of [trendingHeading, communitiesHeading]) {
    await expect(heading).toBeVisible();
    await expect(
      Math.abs(heading.getBoundingClientRect().left - recentHeading.getBoundingClientRect().left),
    ).toBeLessThan(1);
  }
  await expect(
    await canvas.findByRole('link', { name: `${discoveryRealm.name} ${discoveryRealm.description}` }),
  ).toBeVisible();
  const input = canvas.getByRole('combobox', { name: m.search_label() });
  const composer = input.closest('[data-search-composer]');
  if (!composer) throw new globalThis.Error('The input must share the composer surface.');
  await expect(input).toHaveFocus();
  await expect(getComputedStyle(composer).boxShadow).toBe('none');
  const history = canvas.getByRole('button', { name: m.header_search_history() });
  history.focus();
  await expect(history).toHaveFocus();
  await expect(getComputedStyle(composer).boxShadow).toBe('none');
  await userEvent.click(input);
  await userEvent.keyboard('{Tab}{Shift>}{Tab}{/Shift}');
  await expect(input).toHaveFocus();
  const style = getComputedStyle(input);
  await expect(style.boxShadow).toBe('none');
  await expect(style.borderTopWidth).toBe('0px');
  await expect(style.outlineStyle).toBe('solid');
  await expect(Number.parseFloat(style.outlineWidth)).toBeGreaterThanOrEqual(2);
  await expect(Number.parseFloat(style.paddingLeft)).toBeGreaterThan(0);
}

export const Rest: Story = {
  play: async (context) => {
    const { canvas, input } = await expand(context);
    await userEvent.keyboard('{Escape}');
    await expect(context.canvasElement.querySelector('input[role="combobox"]')).toHaveAttribute(
      'aria-expanded',
      'false',
    );
    const returnTarget = window.matchMedia('(max-width: 1023px)').matches
      ? canvas.getByRole('button', { name: m.header_search_global() })
      : input;
    await waitFor(() => expect(returnTarget).toHaveFocus());
    if (!window.matchMedia('(max-width: 1023px)').matches) {
      await expand(context);
      await userEvent.click(context.canvasElement);
      await expect(input).toHaveAttribute('aria-expanded', 'false');
    }
  },
};
export const ScopeChip: Story = {
  render: () => <Example scope={scope} />,
  play: async (context) => {
    const { canvas, input } = await expand(context, m.header_search_in_scope({ scope: scope.name }));
    await expect(input).toHaveAttribute('placeholder', m.header_search_in_scope({ scope: scope.name }));
    await expect(input).toHaveAccessibleName(m.search_label());
    await expect(
      canvas.getByRole('button', { name: m.header_search_remove_scope({ scope: scope.name }) }),
    ).toBeVisible();
    if (!window.matchMedia('(max-width: 1023px)').matches) await userEvent.keyboard('{Escape}');
  },
};
export const Expanded: Story = {
  play: async (context) => {
    const { canvas } = await expand(context);
    await expect(canvas.getByRole('button', { name: m.search_submit() })).toBeDisabled();
    await populated(context.canvasElement);
  },
};
export const Typing: Story = {
  render: () => <Example loadSuggestions={pending} />,
  play: async (context) => {
    const { input } = await expand(context);
    await userEvent.type(input, 'The');
    await expect(input).toHaveValue('The');
    await expect(input).toHaveAccessibleName(m.search_label());
  },
};
export const ScopeRemoved: Story = {
  render: () => <Example scope={scope} />,
  play: async (context) => {
    const { canvas, input } = await expand(context, m.header_search_in_scope({ scope: scope.name }));
    await userEvent.keyboard('{Backspace}');
    await expect(
      canvas.queryByRole('button', { name: m.header_search_remove_scope({ scope: scope.name }) }),
    ).toBeNull();
    await expect(input).toHaveAttribute('placeholder', m.header_search_global());
    await expect(input).toHaveAccessibleName(m.search_label());
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
export const TrendingPreparing: Story = {
  parameters: { trendingFailure: 'semantic_not_ready' },
  play: async (context) => {
    const { canvas } = await expand(context);
    await expect(await canvas.findByText(m.discovery_not_ready())).toBeVisible();
    await expect(await canvas.findByRole('heading', { name: discoveryRealm.name })).toBeVisible();
  },
};
export const TrendingUnavailable: Story = {
  parameters: { trendingFailure: 'dependency_unavailable' },
  play: async (context) => {
    const { canvas } = await expand(context);
    await expect(await canvas.findByText(m.trending_unavailable())).toBeVisible();
    await expect(await canvas.findByRole('heading', { name: discoveryRealm.name })).toBeVisible();
  },
};
export const CommunitiesUnavailable: Story = {
  render: () => <Example loadRealmDiscovery={unavailableRealms} />,
  play: async (context) => {
    const { canvas } = await expand(context);
    await expect(await canvas.findByText(m.realm_discovery_unavailable())).toBeVisible();
    await userEvent.click(canvas.getByRole('button', { name: m.realm_discovery_retry() }));
    await expect(await canvas.findByText(m.realm_discovery_unavailable())).toBeVisible();
    await expect(await canvas.findByRole('button', { name: 'Dune' })).toBeVisible();
  },
};
export const CommunitiesClosed: Story = {
  render: () => <Example loadRealmDiscovery={closedRealms} />,
  play: async (context) => {
    const { canvas } = await expand(context);
    await expect(await canvas.findByText(m.realm_discovery_closed())).toBeVisible();
    await expect(canvas.queryByRole('button', { name: m.realm_discovery_retry() })).toBeNull();
  },
};
export const PhoneSheet: Story = {
  globals: { viewport: { value: 'phone390' } },
  render: () => <Example presentation="sheet" />,
  play: async (context) => {
    const { canvas, input } = await expand(context);
    await expect(canvas.getByRole('dialog', { name: m.search_label() })).toBeVisible();
    await userEvent.keyboard('{Shift>}{Tab}{/Shift}');
    await expect(canvas.getByRole('button', { name: m.header_search_close() })).toHaveFocus();
    await userEvent.keyboard('{Tab}');
    await expect(input).toHaveFocus();
    await populated(context.canvasElement);
  },
};

export const PhoneSheetKeyboardSubmission: Story = {
  globals: { viewport: { value: 'phone390' } },
  args: { onNavigate: fn() },
  render: (args) => (
    <Example presentation="sheet" fields={[['type', 'schema:Book']]} onNavigate={(href) => args.onNavigate?.(href)} />
  ),
  play: async (context) => {
    const { canvas, input } = await expand(context);
    const dialog = canvas.getByRole('dialog', { name: m.search_label() });
    const form = within(dialog).getByRole('search', { name: m.search_label() });
    await expect(dialog.tagName).toBe('DIV');
    await expect(dialog).toHaveAttribute('aria-modal', 'true');
    await expect(form.tagName).toBe('FORM');
    await expect(form).not.toHaveAttribute('aria-modal');
    await expect(form).toHaveAttribute('method', 'get');
    await expect(form).toHaveAttribute('action', `/${getLocale()}/search`);
    await expect(within(form).getByRole('combobox', { name: m.search_label() })).toBe(input);

    await userEvent.keyboard('{Escape}');
    await expect(canvas.queryByRole('dialog')).toBeNull();
    const returnTarget = window.matchMedia('(max-width: 1023px)').matches
      ? canvas.getByRole('button', { name: m.header_search_global() })
      : input;
    await waitFor(() => expect(returnTarget).toHaveFocus());

    const reopened = await expand(context);
    await expect(reopened.input).toBe(input);
    await userEvent.type(input, 'Prince');
    await userEvent.keyboard('{Enter}');
    await expect(context.args.onNavigate).toHaveBeenCalledTimes(1);
    await expect(context.args.onNavigate).toHaveBeenCalledWith(`/${getLocale()}/search?type=schema%3ABook&q=Prince`);
    await expect(canvas.queryByRole('dialog')).toBeNull();
    await expect(input).toHaveAttribute('aria-expanded', 'false');
  },
};
