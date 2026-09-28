import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, waitFor, within } from 'storybook/test';
import { Providers } from '../shell/providers.tsx';
import { messages } from './messages.ts';
import type { SearchLoader } from './query.ts';
import type { TypeaheadLoader } from './typeahead.tsx';
import { SearchPage } from './search-page.tsx';
import type { SearchState } from './state.ts';
import type { SearchFailure, SearchHit, SearchLoaded, SearchResultPage } from './types.ts';

const id = (n: number) => `https://rezics.com/id/${String(n).padStart(8, '0')}-4b5a-4c6d-8e7f-9a0b1c2d3e4f`;
const realm = '3f0e1c2d-4b5a-4c6d-8e7f-9a0b1c2d3e4f';

function hit(n: number, title: string | null, language: string, reasons: Partial<SearchHit['reasons']> = {},
  card: Partial<Pick<SearchHit, 'authors' | 'rating' | 'tagline' | 'completion'>> = {}): SearchHit {
  return { matchUnit: id(n + 500), work: id(n), mainVersion: id(n + 100),
    types: ['https://schema.org/Book'],
    title: title === null ? null : { value: title, language, direction: 'ltr', basis: 'requested' },
    cover: { kind: 'fallback', policy: 'avatar-fallback-v1', key: `work-${n}`, resourceType: 'work' },
    authors: [], rating: null, tagline: null, completion: null, ...card,
    reasons: { language, field: 'body', matchedText: null, matchedLanguage: null, realm: null, classification: null,
      ...reasons } };
}

const name = (value: string, language = 'en') => ({ value, language, direction: 'ltr' as const, basis: 'requested' as const });

// Title matches rank first, then credited names, then text.
const pride = [
  hit(1, 'Pride and Prejudice', 'en', { field: 'title', matchedText: 'Pride and Prejudice', matchedLanguage: 'en' },
    { authors: ['Jane Austen'], rating: { mean: 4.29, count: 41_900, max: 5 }, completion: 'completed',
      tagline: name('Elizabeth Bennet meets a proud stranger, and first impressions begin to unravel.') }),
  hit(3, '傲慢与偏见 · 中文译读', 'zh-Hans', { field: 'title', matchedText: 'Pride and Prejudice: a reading',
    matchedLanguage: 'en' }, { authors: ['简·奥斯汀'] }),
  hit(2, 'Letters on Prejudice', 'en', { field: 'credit', matchedText: 'Pride Reading Circle', matchedLanguage: 'en' },
    { authors: ['Pride Reading Circle'] }),
];

function results(hits: SearchHit[], options: Partial<SearchResultPage> = {}): SearchLoaded {
  return { ok: true, page: { total: hits.length, population: 42, sequence: '47',
    indexGeneration: 'urn:rezics:text-index-generation:story', next: null, titles: true, hits, ...options } };
}
const failed = (failure: SearchFailure): SearchLoaded => ({ ok: false, failure });
const more = (second: SearchHit[] | SearchFailure): SearchLoader => async () => typeof second === 'string'
  ? failed(second) : results(second, { total: 5 });

const state = (phrase: string, extra: Partial<SearchState> = {}): { ok: true; state: SearchState } =>
  ({ ok: true, state: { phrase, scope: { kind: 'global' }, language: null, term: null, ...extra } });

const meta = {
  title: 'Search/Page', component: SearchPage,
  args: { parsed: state('Pride'), realm: null, initial: results(pride, { total: 5, next: { queryDigest: 'a'.repeat(64),
    resultDigest: 'b'.repeat(64), sourcePosition: { datasetId: 'product', dataEpoch: 'story', sequence: '47' },
    indexGeneration: 'urn:rezics:text-index-generation:story', nextOffset: 3, expiresAt: 0 } }),
  signedIn: false, load: more([hit(4, 'Pride and Prejudice — Chapter 3', 'en'), hit(5, null, 'en')]),
  locale: 'en', messages: messages.en },
  decorators: [Story => <Providers><Story /></Providers>],
  parameters: { route: { pathname: '/en/search', search: '?q=Pride' } },
  globals: { viewport: { value: 'desktop' } },
} satisfies Meta<typeof SearchPage>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Populated: Story = {
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole('combobox', { name: 'Search phrase' })).toHaveValue('Pride');
    await expect(canvas.getByRole('combobox', { name: 'Search in' })).toHaveValue('global');
    await expect(canvas.getByText('Results for “Pride”')).toBeVisible();
    const completeness = canvas.getByTestId('search-completeness');
    await expect(within(completeness).getByText('5 works')).toBeVisible();
    // What was searched is one click away rather than in the reader's way.
    await expect(within(completeness).getByText('Searched 42 published texts in All of REZICS')).not.toBeVisible();
    await userEvent.click(within(completeness).getByText('About these results'));
    await expect(within(completeness).getByText('Searched 42 published texts in All of REZICS')).toBeVisible();
    await expect(completeness).toHaveTextContent('Search index as of change 47');
    await expect(canvas.getByRole('link', { name: 'Pride and Prejudice' }))
      .toHaveAttribute('href', '/en/w/00000001-4b5a-4c6d-8e7f-9a0b1c2d3e4f');
    // Each card names its author and says where the phrase was found.
    const reasons = canvas.getAllByRole('list', { name: 'Why this matched' });
    await expect(reasons[0]).toHaveTextContent('Title matches');
    await expect(canvas.getAllByRole('article')[0]).toHaveTextContent('Jane Austen');
    await expect(reasons[1]).toHaveTextContent('Also titled Pride and Prejudice: a reading');
    await expect(reasons[2]).toHaveTextContent('By Pride Reading Circle');
    await userEvent.click(canvas.getByRole('button', { name: 'Show more' }));
    await waitFor(() => expect(canvas.getByRole('link', { name: 'Pride and Prejudice — Chapter 3' })).toHaveFocus());
    await expect(canvas.getByRole('link', { name: 'Work 00000005' })).toBeVisible();
  },
};

export const FacetedTypes: Story = {
  args: { parsed: state('Pride', { includeTypes: ['book'] }), initial: results(pride, {
    facets: { populationBasis: 'all-filters', resultGrain: 'work',
      languages: { precision: 'exact', values: [{ value: 'en', count: 2 },
        { value: 'zh-Hans', count: 1 }] },
      terms: { precision: 'lower-bound', values: [] },
      types: { precision: 'exact', values: [
        { value: 'https://schema.org/Book', count: 3 },
        { value: 'https://schema.org/DigitalDocument', count: 1 },
        { value: 'https://schema.org/Recipe', count: 0 }] } },
  }) },
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await expect(canvas.getAllByRole('link', { name: 'Include Books' })[0]).toHaveAttribute('aria-current', 'true');
    await expect(canvas.getAllByRole('link', { name: 'Exclude Guides' })[0]).toHaveAttribute('href',
      '/en/search?q=Pride&include=book&exclude=document');
    // A kind or language with no matches would only narrow to nothing, so it is not offered.
    await expect(canvas.queryByRole('link', { name: 'Exclude Recipes' })).toBeNull();
    await expect(canvas.queryByRole('link', { name: /^Japanese/ })).toBeNull();
    await expect(canvas.getAllByRole('link', { name: /^Simplified Chinese/ })[0]).toHaveTextContent('1');
    await expect(canvas.getByRole('link', { name: 'Pride and Prejudice' })).toBeVisible();
  },
};

export const RealmClassified: Story = {
  args: { parsed: state('西游记', { scope: { kind: 'realm', realm }, term: '5a6b7c8d-9e0f-4a1b-8c2d-3e4f5a6b7c8d',
    language: 'zh-Hans' }), realm: { id: realm, label: 'Classic Literature · 经典文学' },
  initial: results([hit(6, '西游记', 'zh-Hans', { realm: 'realm-adoption', classification: { concept: id(700),
    source: 'local', conceptName: { value: '神魔小说', language: 'zh-Hans', direction: 'ltr', basis: 'requested' } } }),
  hit(7, '西游记 · 第二回 悟彻菩提真妙理', 'zh-Hans', { realm: 'main-fallback', classification: { concept: id(700),
    source: 'global', conceptName: null } })]), signedIn: true },
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole('combobox', { name: 'Search in' })).toHaveValue('realm');
    const reasons = canvas.getAllByRole('list', { name: 'Why this matched' });
    await expect(canvas.getByText('Results for “西游记” in Classic Literature · 经典文学')).toBeVisible();
    await expect(reasons[0]).toHaveTextContent('The version Classic Literature · 经典文学 chose');
    await expect(reasons[0]).toHaveTextContent('神魔小说, as Classic Literature · 经典文学 classifies it');
    await expect(reasons[1]).toHaveTextContent('hasn’t chosen a version, so the main one is shown');
    await expect(reasons[1]).toHaveTextContent('Genre: this genre');
    const completeness = canvas.getByTestId('search-completeness');
    await expect(completeness).toHaveTextContent('Only Simplified Chinese text');
    await expect(completeness).toHaveTextContent('Only this genre');
    await expect(completeness).toHaveTextContent('Works you muted are left out');
    await expect(canvas.getAllByRole('link', { name: 'Remove filter: Only this genre' })[0])
      .toHaveAttribute('href', `/en/search?q=${encodeURIComponent('西游记')}&scope=realm&realm=${realm}&lang=zh-Hans`);
  },
};

export const EmptyOffersWiderSearch: Story = {
  args: { parsed: state('river', { scope: { kind: 'realm', realm }, language: 'ja' }),
    realm: { id: realm, label: 'Classic Literature · 经典文学' }, initial: results([]) },
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole('heading', { name: 'Nothing in Classic Literature · 经典文学 matches “river”' }))
      .toBeVisible();
    await expect(canvas.getByRole('link', { name: 'Search all of REZICS' })).toHaveAttribute('href', '/en/search?q=river&lang=ja');
    await expect(canvas.getByRole('link', { name: 'Search any language' })).toHaveAttribute('href',
      `/en/search?q=river&scope=realm&realm=${realm}`);
    await expect(canvas.getByText('Try another spelling or fewer words, or search for a title or an author.')).toBeVisible();
    // No wall of zeros: the filters that are on can still be removed, and nothing else is offered.
    await expect(canvas.queryByRole('link', { name: /^English/ })).toBeNull();
    await expect(canvas.queryByTestId('search-completeness')).toBeNull();
  },
};

const suggestion = (n: number, title: string, field: 'title' | 'credit' = 'title', matched = title) => ({
  work: id(n), mainVersion: id(n + 100), title: name(title),
  cover: { kind: 'fallback' as const, policy: 'avatar-fallback-v1', key: `work-${n}`, resourceType: 'work' },
  matchedField: field, matchedText: matched, matchedLanguage: 'en' });

export const EmptySuggestsCloseTitles: Story = {
  args: { parsed: state('prejudise'), initial: results([]), fallback: {
    suggestions: [{ kind: 'work', item: suggestion(1, 'Pride and Prejudice') },
      { kind: 'name', name: 'Jane Austen', language: 'en' }],
    popular: [11, 12, 13, 14, 15, 16].map(n => ({ id: id(n), href: `/w/${id(n).slice(-36)}`, title: name(['Emma',
      'The Night Ferry Library', 'Salt and Starlight', 'The Cartographer of Tides', 'Weekend buttermilk pancakes',
      'Letters from the Lighthouse'][n - 11]!), cover: null, kind: 'book' as const, authors: n === 11 ? ['Jane Austen'] : [],
    rating: { mean: 5 - n / 10, count: 10 * n, max: 5 } })) } },
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole('heading', { name: 'Nothing matches “prejudise”' })).toBeVisible();
    await expect(canvas.getByText(/Did you mean/)).toBeVisible();
    await expect(canvas.getByRole('link', { name: 'Pride and Prejudice' })).toHaveAttribute('href',
      '/en/w/00000001-4b5a-4c6d-8e7f-9a0b1c2d3e4f');
    await expect(canvas.getByRole('link', { name: 'Jane Austen' })).toHaveAttribute('href', '/en/search?q=Jane+Austen');
    await expect(canvas.getByRole('heading', { name: 'Popular on REZICS' })).toBeVisible();
    await expect(canvas.getByRole('link', { name: 'Salt and Starlight' })).toBeVisible();
  },
};

const suggestions: TypeaheadLoader = async prefix => prefix.toLowerCase().startsWith('pri') ? [
  suggestion(1, 'Pride and Prejudice'), suggestion(3, '傲慢与偏见', 'title', 'Pride and Prejudice (Chinese reading)'),
  suggestion(2, 'Letters on Prejudice', 'credit', 'Pride Reading Circle')] : [];

export const TypeaheadSuggestsTitles: Story = {
  args: { parsed: state(''), initial: null, suggest: suggestions },
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    const box = canvas.getByRole('combobox', { name: 'Search phrase' });
    await userEvent.type(box, 'pri');
    const list = await canvas.findByRole('listbox', { name: 'Suggested works' });
    await expect(box).toHaveAttribute('aria-expanded', 'true');
    await expect(within(list).getAllByRole('option')).toHaveLength(3);
    await expect(within(list).getByText('by Pride Reading Circle')).toBeVisible();
    await expect(within(list).getByText('Also titled Pride and Prejudice (Chinese reading)')).toBeVisible();
    await userEvent.keyboard('{ArrowDown}{ArrowDown}');
    const second = within(list).getAllByRole('option')[1]!;
    await expect(second).toHaveAttribute('aria-selected', 'true');
    await expect(box).toHaveAttribute('aria-activedescendant', second.id);
    await userEvent.keyboard('{ArrowUp}{ArrowUp}');
    await expect(within(list).getAllByRole('option')[2]).toHaveAttribute('aria-selected', 'true');
    await userEvent.keyboard('{Escape}');
    await expect(canvas.queryByRole('listbox')).toBeNull();
    await expect(box).toHaveAttribute('aria-expanded', 'false');
  },
};

export const TypeaheadWaitsForComposition: Story = {
  args: { parsed: state(''), initial: null, suggest: async prefix => prefix === '西' ? [suggestion(6, '西游记')] : [] },
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    const box = canvas.getByRole<HTMLInputElement>('combobox', { name: 'Search phrase' });
    box.focus();
    // While pinyin is being composed nothing is asked; the committed character is.
    box.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
    box.value = 'xi';
    box.dispatchEvent(new InputEvent('input', { bubbles: true, isComposing: true }));
    await new Promise(resolve => setTimeout(resolve, 300));
    await expect(canvas.queryByRole('listbox')).toBeNull();
    box.value = '西';
    box.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: '西' }));
    const list = await canvas.findByRole('listbox', { name: 'Suggested works' });
    await expect(within(list).getByRole('option', { name: '西游记' })).toBeVisible();
  },
};

export const Idle: Story = {
  args: { parsed: state(''), initial: null },
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole('heading', { name: 'Search published works' })).toBeVisible();
    await expect(canvas.getByText('Enter at least two characters to search.')).toBeVisible();
  },
};

export const RestartWhenResultsMove: Story = {
  // The continuation no longer follows on; page one read again reflects the newer index.
  args: { load: async continuation => continuation ? failed('restart')
    : results([...pride, hit(8, 'Pride and Prejudice — Chapter 4', 'en')], { sequence: '48' }) },
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole('button', { name: 'Show more' }));
    await expect(await canvas.findByText('Results changed since the first page')).toBeVisible();
    // The pages already shown stay until the reader restarts.
    await expect(canvas.getByRole('link', { name: 'Pride and Prejudice' })).toBeVisible();
    await userEvent.click(canvas.getByRole('button', { name: 'Search again' }));
    const completeness = canvas.getByTestId('search-completeness');
    await waitFor(() => expect(completeness).toHaveTextContent('4 works'));
    await expect(completeness).toHaveTextContent('Search index as of change 48');
    await expect(canvas.getByRole('link', { name: 'Pride and Prejudice — Chapter 4' })).toBeVisible();
    await expect(canvas.queryByText('Results changed since the first page')).toBeNull();
  },
};

export const TooManyToRank: Story = {
  args: { parsed: state('the'), initial: failed('budget') },
  async play({ canvasElement }) {
    await expect(within(canvasElement).getByText('This phrase matches too many texts to rank')).toBeVisible();
  },
};

export const Unavailable: Story = {
  args: { initial: failed('unavailable') },
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole('alert')).toHaveTextContent('Search is unavailable');
    await expect(canvas.getByRole('button', { name: 'Try again' })).toBeVisible();
  },
};

export const TitlesUnavailable: Story = {
  args: { initial: results([hit(1, null, 'en'), hit(2, null, 'en')], { titles: false }) },
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await expect(canvas.getByText('Titles couldn’t be loaded, so some results show a short ID.')).toBeVisible();
    await expect(canvas.getByRole('link', { name: 'Work 00000001' })).toBeVisible();
  },
};

export const MineIsNotSearchable: Story = {
  args: { parsed: { ok: false, reason: 'mine', phrase: 'Pride' }, initial: null },
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole('heading', { name: 'Your ratings cannot be searched' })).toBeVisible();
    await expect(canvas.getByRole('link', { name: 'Search all of REZICS' })).toHaveAttribute('href', '/en/search?q=Pride');
  },
};

export const MalformedLink: Story = {
  args: { parsed: { ok: false, reason: 'malformed', phrase: 'Pride' }, initial: null },
  async play({ canvasElement }) {
    await expect(within(canvasElement).getByRole('heading', { name: 'This search link is malformed' })).toBeVisible();
  },
};

export const ImeCompositionDoesNotSubmit: Story = {
  async play({ canvasElement }) {
    const box = within(canvasElement).getByRole('combobox', { name: 'Search phrase' });
    box.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
    const committing = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true, isComposing: true });
    box.dispatchEvent(committing);
    await expect(committing.defaultPrevented).toBe(true);
    box.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true }));
    const plain = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true });
    box.dispatchEvent(plain);
    await expect(plain.defaultPrevented).toBe(false);
  },
};

export const ChineseDark: Story = {
  args: { parsed: state('《西游记》'), locale: 'zh-Hans', messages: messages['zh-Hans'],
    initial: results([hit(6, '西游记', 'zh-Hans'), hit(7, '西游记 · 第二回 悟彻菩提真妙理', 'zh-Hans')]) },
  globals: { locale: 'zh-Hans', theme: 'dark' },
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole('heading', { level: 1, name: '搜索作品' })).toBeVisible();
    await expect(canvas.getByTestId('search-completeness')).toHaveTextContent('2 部作品');
  },
};

export const PhoneFilters: Story = {
  globals: { viewport: { value: 'phone' } },
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByText('Filter results'));
    await expect(canvas.getAllByRole('link', { name: 'Any language' }).at(-1)).toHaveAttribute('aria-current', 'true');
    await expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(window.innerWidth);
  },
};

export const PhoneChinese: Story = {
  args: { parsed: state('《西游记》'), locale: 'zh-Hans', messages: messages['zh-Hans'],
    initial: results([hit(6, '西游记', 'zh-Hans'), hit(9, '雨夜书店 · 连载小说：一部关于深夜书店、未寄出的信和最后一班车的长篇连载',
      'zh-Hans')]) },
  globals: { viewport: { value: 'phone' }, locale: 'zh-Hans' },
  async play() {
    await expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(window.innerWidth);
  },
};
