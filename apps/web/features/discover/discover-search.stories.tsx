import type { Meta, StoryObj } from '@storybook/react-vite';
import { useState } from 'react';
import { expect, userEvent, waitFor, within } from 'storybook/test';
import { StoryRouteContext } from '../../.storybook/next-navigation.ts';
import { Providers } from '../shell/providers.tsx';
import { SearchField } from '../shell/search-field.tsx';
import { browseConcepts, browseResources, fixturePage, fixtureTopicLoader } from './browse-fixtures.ts';
import { browseHref, emptyBrowse, parseBrowseState, type BrowseState } from './browse-state.ts';
import { DiscoverView, type DiscoverPageProps } from './discover-view.tsx';

const state: BrowseState = { ...emptyBrowse, q: 'night library', tab: 'works', language: 'ja',
  includeTypes: ['https://schema.org/Book'], conditions: { include: [browseConcepts[0]!.id.slice(-36)],
    exclude: [], match: 'all' } };
const topicLoad = fixtureTopicLoader();
const meta = {
  title: 'Discover/Search task', component: DiscoverView,
  args: { state, locale: 'en', topics: browseConcepts.slice(0, 2), sections: null,
    results: { ok: true, data: fixturePage(browseResources.filter(item => item.kind === 'work'), 0, 6) },
    topicLoad },
  decorators: [Story => <Providers><Story /></Providers>],
  globals: { viewport: { value: 'desktop1440' } },
} satisfies Meta<typeof DiscoverView>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Filtered: Story = {
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole('heading', { name: 'Results for “night library”', level: 1 })).toBeVisible();
    await expect(canvas.getByRole('heading', { name: 'Found in titles and names', level: 2 })).toBeVisible();
    const language = canvas.getByRole('link', { name: 'Remove filter: Only Japanese text' });
    await expect(language).toBeVisible();
    const removed = new URL(language.getAttribute('href')!, 'https://example.test');
    await expect(removed.searchParams.has('lang')).toBe(false);
    await expect(removed.searchParams.get('include')).toBe('https://schema.org/Book');
    await expect(removed.searchParams.get('ci')).toBe(state.conditions.include[0]);
    await expect(canvas.getByText('宇宙 · Space')).toBeVisible();
    await userEvent.click(canvas.getByText('Edit filters'));
    await expect(canvas.getByRole('textbox')).toHaveValue('ja');
  },
};

export const SimplifiedChinesePhone: Story = { args: { locale: 'zh-Hans' },
  globals: { locale: 'zh-Hans', theme: 'dark', viewport: { value: 'phone' } },
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole('heading', { name: '“night library”的搜索结果', level: 1 })).toBeVisible();
    await expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(innerWidth);
  },
};

export const DirectLastDestination: Story = { args: { state: { ...emptyBrowse, tab: 'topics' } },
  globals: { viewport: { value: 'phone' } },
  async play({ canvasElement }) {
    const nav = within(canvasElement).getByRole('navigation', { name: 'Type' });
    const active = within(nav).getByRole('link', { name: 'Topics' });
    await waitFor(() => {
      const item = active.getBoundingClientRect(), container = nav.getBoundingClientRect();
      expect(item.left).toBeGreaterThanOrEqual(container.left - 1);
      expect(item.right).toBeLessThanOrEqual(container.right + 1);
    });
    await expect(active).toHaveAttribute('aria-current', 'page');
    await expect(within(canvasElement).getByRole('heading', { name: 'Topics', level: 2 })).toBeVisible();
  },
};

export const EmptyScanRetainsSelection: Story = {
  args: { checkedPages: 4, results: { ok: true, data: { items: [], complete: false,
    nextCursor: 'opaque:+/%?=&雪', count: { kind: 'at-least', value: 0 } } } },
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await expect(canvas.getByText(/No matches yet/)).toHaveAttribute('role', 'status');
    await expect(canvas.queryByText('No matches.')).toBeNull();
    const next = new URL(canvas.getByRole('link', { name: 'Check more results' }).getAttribute('href')!, 'https://example.test');
    await expect(next.searchParams.get('cursor')).toBe('opaque:+/%?=&雪');
    await expect(next.searchParams.get('q')).toBe(state.q);
    await expect(next.searchParams.get('ci')).toBe(state.conditions.include[0]);
    await expect(next.searchParams.get('lang')).toBe('ja');
  },
};
export const ExhaustedEmpty: Story = { args: { results: { ok: true, data: fixturePage([]) } },
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await expect(canvas.getByText('No matches.')).toBeVisible();
    await expect(canvas.queryByRole('link', { name: 'Check more results' })).toBeNull();
  },
};
export const UnsupportedKeepsTheTask: Story = { args: { results: { ok: false, moved: false,
  status: 400, failure: 'unsupported', problem: { code: 'unsupported_query_shape' } } },
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole('heading', { name: 'Found in titles and names' })).toBeVisible();
    await expect(canvas.getByRole('alert')).toHaveTextContent('These Conditions cannot be combined here');
    await expect(canvas.getByRole('link', { name: 'Remove filter: Only Japanese text' })).toBeVisible();
    await expect(canvas.queryByText('No matches.')).toBeNull();
  },
};

function HistoryTask(props: DiscoverPageProps) {
  const [history, setHistory] = useState([state]);
  const [index, setIndex] = useState(0);
  const current = history[index]!;
  const push = (href: string) => {
    const next = parseBrowseState(Object.fromEntries(new URL(href, 'https://example.test').searchParams));
    if (!next) throw new Error('Invalid story navigation');
    setHistory([...history.slice(0, index + 1), next]); setIndex(index + 1);
  };
  return <StoryRouteContext value={{ pathname: '/en/discover', search: new URL(browseHref(current), 'https://example.test').search,
    onPush: push }}>
    <div className="mx-auto grid max-w-7xl gap-3 px-4 pt-4" onSubmitCapture={event => {
      if (!(event.target instanceof HTMLFormElement) || event.target.getAttribute('role') !== 'search') return;
      event.preventDefault();
      push('/discover?' + new URLSearchParams([...new FormData(event.target)].map(([key, value]) => [key, String(value)])));
    }}><SearchField /></div>
    <DiscoverView {...props} state={current} />
    <div className="flex gap-3 p-4">
      <button type="button" onClick={() => setIndex(index - 1)} disabled={!index}>Back in story</button>
      <button type="button" onClick={() => setIndex(index + 1)} disabled={index === history.length - 1}>Forward in story</button>
    </div>
  </StoryRouteContext>;
}
export const QueryEditAndHistoryRestore: Story = { render: props => <HistoryTask {...props} />,
  async play({ canvasElement }) {
    const canvas = within(canvasElement), input = canvas.getByRole('searchbox');
    await userEvent.clear(input); await userEvent.type(input, 'lantern night'); await userEvent.keyboard('{Enter}');
    await expect(await canvas.findByRole('heading', { name: 'Results for “lantern night”' })).toBeVisible();
    await expect(canvas.getByRole('link', { name: 'Remove filter: Only Japanese text' })).toBeVisible();
    await userEvent.click(canvas.getByRole('button', { name: 'Back in story' }));
    await expect(canvas.getByRole('searchbox')).toHaveValue('night library');
    await userEvent.click(canvas.getByRole('button', { name: 'Forward in story' }));
    await expect(canvas.getByRole('searchbox')).toHaveValue('lantern night');
    await expect(canvas.getByText('宇宙 · Space')).toBeVisible();
  },
};
