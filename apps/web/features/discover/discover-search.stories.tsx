import type { Meta, StoryObj } from '@storybook/react-vite';
import { direction } from '@rezics/main/language';
import { useState } from 'react';
import { expect, fn, userEvent, waitFor, within } from 'storybook/test';
import { StoryRouteContext } from '../../.storybook/next-navigation.ts';
import { localizedPath } from '../../i18n/locale.ts';
import { Providers } from '../shell/providers.tsx';
import { SearchField } from '../shell/search-field.tsx';
import type { TypeaheadItem } from '../search/suggest.ts';
import { browseConcepts, browseResources, fixturePage, fixtureTopicLoader } from './browse-fixtures.ts';
import { browseHref, emptyBrowse, parseBrowseState, type BrowseState } from './browse-state.ts';
import { DiscoverView, type DiscoverPageProps } from './discover-view.tsx';
import { workHref } from './scope.ts';

const workSamples = browseResources.filter(item => item.kind === 'work');
const workResults = ['雨夜の図書館 · The Library on a Rainy Night', '星降る書庫 · The Starlit Archive',
  '月明かりの司書 · The Moonlit Librarian', '夜の本棚 · Shelves After Dark',
  '星を読む部屋 · Reading the Stars', '最後の夜行図書館 · The Last Night Library'].map((value, index) => ({
  ...workSamples[index]!, types: ['https://schema.org/Book'],
  name: { ...workSamples[index]!.name, value, language: 'ja', direction: direction('ja', value) },
}));
const topicSamples = browseResources.filter(item => item.kind === 'concept');
const topicResults = ['Space and astronomy', 'Libraries and archives', 'Japanese literature',
  'Illustration and comics', 'Games and interactive fiction', 'Film and animation'].map((value, index) => ({
  ...topicSamples[index]!, name: { ...topicSamples[index]!.name, value, language: 'en', direction: direction('en', value) },
}));

const state: BrowseState = { ...emptyBrowse, q: 'night library', tab: 'works', language: 'ja',
  includeTypes: ['https://schema.org/Book'], conditions: { include: [browseConcepts[0]!.id.slice(-36)],
    exclude: [], match: 'all' } };
const topicLoad = fixtureTopicLoader();
const meta = {
  title: 'Discover/Search task', component: DiscoverView,
  args: { state, locale: 'en', topics: browseConcepts.slice(0, 2), sections: null,
    results: { ok: true, data: fixturePage(workResults) },
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

export const DirectLastDestination: Story = { args: { state: { ...emptyBrowse, tab: 'topics' },
  results: { ok: true, data: fixturePage(topicResults) } },
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
    await expect(canvas.getByRole('alert')).toHaveTextContent('These Conditions cannot be combined in Search');
    await expect(canvas.getByRole('alert')).toHaveTextContent('Remove one Condition or change how its values match.');
    await expect(canvas.getByRole('link', { name: 'Remove filter: Only Japanese text' })).toBeVisible();
    await expect(canvas.queryByText('No matches.')).toBeNull();
    const results = within(canvas.getByRole('region', { name: 'Found in titles and names' }));
    await expect(results.getByRole('heading', { name: 'Found in titles and names', level: 2 })).toBeVisible();
    await expect(results.getByRole('alert')).toHaveTextContent('These Conditions cannot be combined in Search');
    await expect(canvas.queryByRole('region', { name: 'Recommendations' })).toBeNull();
  },
};
export const PreparingKeepsTheTask: Story = {
  args: { results: { ok: false, moved: false, pending: true, status: 202 } },
  globals: { viewport: { value: 'phone' } },
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    const results = within(canvas.getByRole('region', { name: 'Found in titles and names' }));
    await expect(results.getByRole('heading', { name: 'Found in titles and names', level: 2 })).toBeVisible();
    await expect(results.getByRole('status')).toHaveAttribute('aria-busy', 'true');
    await expect(canvas.getByRole('heading', { name: 'Results for “night library”', level: 1 })).toBeVisible();
    await expect(canvas.getByRole('link', { name: 'Remove filter: Only Japanese text' })).toBeVisible();
    await expect(canvas.queryByRole('region', { name: 'Recommendations' })).toBeNull();
  },
};

const alternative: TypeaheadItem = { work: browseResources[0]!.id, mainVersion: browseResources[0]!.id,
  title: { value: 'Pride and Prejudice', language: 'en', direction: direction('en', 'Pride and Prejudice'), basis: 'requested' },
  cover: browseResources[0]!.icon, types: ['https://schema.org/Book'], authors: [],
  matchedField: 'title', matchedText: 'Pride and Prejudice', matchedLanguage: 'en' };
export const ActionableAlternatives: Story = {
  args: { state: { ...state, q: 'prejudise' }, results: { ok: true, data: fixturePage([]) },
    suggestions: { ok: true, suggestions: [{ kind: 'work', item: alternative },
      { kind: 'name', name: 'Prejudice Reading Circle', language: 'en' }] } },
  globals: { viewport: { value: 'phone' } },
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    const recovery = within(canvas.getByRole('complementary', { name: 'Try a related title or name' }));
    await expect(recovery.getByText('These are possible alternatives, not matches for the current conditions.')).toBeVisible();
    await expect(recovery.getByRole('link', { name: 'Pride and Prejudice' }))
      .toHaveAttribute('href', localizedPath(workHref(alternative.work, state.scope), 'en'));
    const name = new URL(recovery.getByRole('link', { name: 'Prejudice Reading Circle' }).getAttribute('href')!, 'https://example.test');
    await expect(name.searchParams.get('q')).toBe('Prejudice Reading Circle');
    await expect(name.searchParams.get('lang')).toBe(state.language);
    await expect(name.searchParams.get('ci')).toBe(state.conditions.include[0]);
    await expect(name.searchParams.get('include')).toBe('https://schema.org/Book');
  },
};

export const UnsupportedAlternatives: Story = {
  args: { results: { ok: true, data: fixturePage([]) }, suggestions: { ok: false, failure: 'unsupported' } },
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await expect(canvas.getByText('Suggestions do not support this query. You can edit the query.')).toBeVisible();
    await expect(canvas.queryByRole('complementary')).toBeNull();
    await expect(canvas.getByRole('link', { name: 'Remove filter: Only Japanese text' })).toBeVisible();
  },
};

function HistoryTask(props: DiscoverPageProps) {
  const [history, setHistory] = useState([props.state ?? state]);
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

export const EditExactConditionsWithKeyboard: Story = {
  args: { state: { ...state, q: '"night library"', excludeTypes: ['https://schema.org/Recipe'],
    scope: { kind: 'realm', realm: '00000000-0000-4000-8000-000000000001' },
    conditions: { ...state.conditions, match: 'any', exclude: ['00000000-0000-4000-8000-000000000002'] } } },
  render: props => <HistoryTask {...props} />,
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByText('Edit filters'));
    const exact = canvas.getByRole('button', { name: 'Exact phrase' });
    await expect(exact).toHaveAttribute('aria-pressed', 'true');
    exact.focus(); await userEvent.keyboard('{Enter}');
    await expect(canvas.getByRole('searchbox')).toHaveValue('night library');
    await expect(canvas.queryByRole('link', { name: 'Remove filter: Exact phrase' })).toBeNull();
    const excluded = new URL(canvas.getByRole('link', { name: 'Remove filter: Exclude Recipe' }).getAttribute('href')!, 'https://example.test');
    await expect(excluded.searchParams.get('q')).toBe('night library');
    await expect(excluded.searchParams.get('lang')).toBe('ja');
    await expect(excluded.searchParams.get('scope')).toBe('realm');
    await expect(excluded.searchParams.get('cm')).toBe('any');
    await expect(excluded.searchParams.get('ce')).toBe('00000000-0000-4000-8000-000000000002');
    await expect(excluded.searchParams.has('exclude')).toBe(false);
    await userEvent.click(canvas.getByRole('button', { name: 'Back in story' }));
    await expect(canvas.getByRole('button', { name: 'Exact phrase' })).toHaveAttribute('aria-pressed', 'true');
    const language = canvas.getByRole('textbox', { name: 'Language' });
    await userEvent.clear(language); await userEvent.type(language, 'ko');
    await userEvent.click(within(language.closest('form')!).getByRole('button', { name: 'Search' }));
    await expect(canvas.getByRole('link', { name: 'Remove filter: Only Korean text' })).toBeVisible();
    await expect(canvas.getByRole('searchbox')).toHaveValue('"night library"');
    await expect(canvas.getByRole('link', { name: 'Remove filter: Exclude Recipe' })).toBeVisible();
  },
};

const exactPush = fn();
const exactState = (q: string): BrowseState => ({ ...state, q, excludeTypes: ['https://schema.org/Recipe'],
  scope: { kind: 'realm', realm: '00000000-0000-4000-8000-000000000001' },
  conditions: { ...state.conditions, match: 'any', exclude: ['00000000-0000-4000-8000-000000000002'] } });
function ExactBoundaryTask(props: DiscoverPageProps) {
  const selected = props.state ?? state;
  return <StoryRouteContext value={{ pathname: '/en/discover',
    search: new URL(browseHref(selected), 'https://example.test').search, onPush: exactPush }}>
    <div className="mx-auto max-w-7xl px-4 pt-4"><SearchField /></div>
    <DiscoverView {...props} state={selected} />
  </StoryRouteContext>;
}
async function rejectQuotedBoundary(canvasElement: HTMLElement, q: string) {
  const canvas = within(canvasElement);
  await userEvent.click(canvas.getByText('Edit filters'));
  const exact = canvas.getByRole('button', { name: 'Exact phrase' });
  exact.focus(); await userEvent.keyboard('{Enter}');
  await expect(exactPush).not.toHaveBeenCalled();
  const alert = await canvas.findByRole('alert');
  await expect(alert).toHaveTextContent('Shorten the query to 78 characters before adding quotation marks.');
  await expect(canvas.getByRole('searchbox')).toHaveValue(q);
  await expect(exact).toHaveFocus();
  const removeLanguage = new URL(canvas.getByRole('link', { name: 'Remove filter: Only Japanese text' })
    .getAttribute('href')!, 'https://example.test');
  const retained = exactState(q);
  delete retained.language;
  await expect(parseBrowseState(Object.fromEntries(removeLanguage.searchParams))).toEqual(retained);
  await expect(removeLanguage.searchParams.has('lang')).toBe(false);
  alert.scrollIntoView({ block: 'center' });
}
export const ExactPhrase78Unicode: Story = {
  args: { state: exactState('𠮷'.repeat(78)) }, render: props => <ExactBoundaryTask {...props} />,
  beforeEach() { exactPush.mockClear(); },
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByText('Edit filters'));
    const exact = canvas.getByRole('button', { name: 'Exact phrase' });
    exact.focus(); await userEvent.keyboard('{Enter}');
    await expect(exactPush).toHaveBeenCalledTimes(1);
    const next = new URL(exactPush.mock.calls[0]![0], 'https://example.test');
    await expect(parseBrowseState(Object.fromEntries(next.searchParams))).toEqual({
      ...exactState('𠮷'.repeat(78)), q: `"${'𠮷'.repeat(78)}"`,
    });
    await expect(canvas.queryByRole('alert')).toBeNull();
  },
};
export const ExactPhrase79Unicode: Story = {
  args: { state: exactState('界'.repeat(79)) }, render: props => <ExactBoundaryTask {...props} />,
  globals: { viewport: { value: 'phone' }, theme: 'dark' },
  beforeEach() { exactPush.mockClear(); },
  async play({ canvasElement }) { await rejectQuotedBoundary(canvasElement, '界'.repeat(79)); },
};
export const ExactPhrase80Unicode: Story = {
  args: { state: exactState('𠮷a'.repeat(40)) }, render: props => <ExactBoundaryTask {...props} />,
  beforeEach() { exactPush.mockClear(); },
  async play({ canvasElement }) { await rejectQuotedBoundary(canvasElement, '𠮷a'.repeat(40)); },
};
