import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, waitFor, within } from 'storybook/test';
import { messages as discover } from '../discover/messages.ts';
import { Providers } from '../shell/providers.tsx';
import { messages } from './messages.ts';
import type { SearchLoader } from './query.ts';
import { SearchPage } from './search-page.tsx';
import type { SearchState } from './state.ts';
import type { SearchFailure, SearchHit, SearchLoaded, SearchResultPage } from './types.ts';

const id = (n: number) => `https://rezics.com/id/${String(n).padStart(8, '0')}-4b5a-4c6d-8e7f-9a0b1c2d3e4f`;
const realm = '3f0e1c2d-4b5a-4c6d-8e7f-9a0b1c2d3e4f';

function hit(n: number, title: string | null, language: string, reasons: Partial<SearchHit['reasons']> = {}): SearchHit {
  return { matchUnit: id(n + 500), work: id(n), mainVersion: id(n + 100),
    title: title === null ? null : { value: title, language, direction: 'ltr', basis: 'requested' },
    cover: { kind: 'fallback', policy: 'avatar-fallback-v1', key: `work-${n}`, resourceType: 'work' },
    reasons: { language, realm: null, classification: null, ...reasons } };
}

const pride = [hit(1, 'Pride and Prejudice', 'en'), hit(2, 'Pride and Prejudice — Chapter 2', 'en'),
  hit(3, '傲慢与偏见 · 中文译读', 'zh-Hans')];

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
  locale: 'en', messages: messages.en, discoverMessages: discover.en },
  decorators: [Story => <Providers><Story /></Providers>],
  parameters: { route: { pathname: '/search', search: '?q=Pride' } },
  globals: { viewport: { value: 'desktop' } },
} satisfies Meta<typeof SearchPage>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Populated: Story = {
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole('searchbox', { name: 'Search phrase' })).toHaveValue('Pride');
    await expect(canvas.getByRole('combobox', { name: 'Search in' })).toHaveValue('global');
    await expect(canvas.getByText('Results for “Pride” in Global')).toBeVisible();
    const completeness = canvas.getByTestId('search-completeness');
    await expect(completeness).toHaveTextContent('Exactly 5 works match · searched 42 published texts in Global');
    await expect(completeness).toHaveTextContent('index current as of change 47');
    await expect(canvas.getByRole('link', { name: 'Pride and Prejudice' }))
      .toHaveAttribute('href', '/w/00000001-4b5a-4c6d-8e7f-9a0b1c2d3e4f');
    await expect(canvas.getAllByRole('list', { name: 'Why this matched' })[0])
      .toHaveTextContent('Phrase found in the published English text');
    await userEvent.click(canvas.getByRole('button', { name: 'Show more' }));
    await waitFor(() => expect(canvas.getByRole('link', { name: 'Pride and Prejudice — Chapter 3' })).toHaveFocus());
    await expect(canvas.getByRole('link', { name: 'Work 00000005' })).toBeVisible();
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
    await expect(reasons[0]).toHaveTextContent('The version Classic Literature · 经典文学 adopted');
    await expect(reasons[0]).toHaveTextContent('Classified as 神魔小说 by Classic Literature · 经典文学');
    await expect(reasons[1]).toHaveTextContent('has adopted no version, so its Main Version is shown');
    await expect(reasons[1]).toHaveTextContent('Classified as this term in Global');
    const completeness = canvas.getByTestId('search-completeness');
    await expect(completeness).toHaveTextContent('only Simplified Chinese text');
    await expect(completeness).toHaveTextContent('only this classification');
    await expect(completeness).toHaveTextContent('works hidden by your mutes are left out');
    await expect(canvas.getAllByRole('link', { name: 'Remove filter: Only works with this classification' })[0])
      .toHaveAttribute('href', `/search?q=${encodeURIComponent('西游记')}&scope=realm&realm=${realm}&lang=zh-Hans`);
  },
};

export const EmptyOffersWiderSearch: Story = {
  args: { parsed: state('river', { scope: { kind: 'realm', realm }, language: 'ja' }),
    realm: { id: realm, label: 'Classic Literature · 经典文学' }, initial: results([]) },
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole('heading', { name: 'No works in Classic Literature · 经典文学 match “river”' }))
      .toBeVisible();
    await expect(canvas.getByRole('link', { name: 'Search Global' })).toHaveAttribute('href', '/search?q=river&lang=ja');
    await expect(canvas.getByRole('link', { name: 'Search any language' })).toHaveAttribute('href',
      `/search?q=river&scope=realm&realm=${realm}`);
    await expect(canvas.getByTestId('search-completeness')).toHaveTextContent('Exactly 0 works match');
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
    await userEvent.click(canvas.getByRole('button', { name: 'Restart search' }));
    const completeness = canvas.getByTestId('search-completeness');
    await waitFor(() => expect(completeness).toHaveTextContent('Exactly 4 works match'));
    await expect(completeness).toHaveTextContent('index current as of change 48');
    await expect(canvas.getByRole('link', { name: 'Pride and Prejudice — Chapter 4' })).toBeVisible();
    await expect(canvas.queryByText('Results changed since the first page')).toBeNull();
  },
};

export const TooManyToRank: Story = {
  args: { parsed: state('the'), initial: failed('budget') },
  async play({ canvasElement }) {
    await expect(within(canvasElement).getByText('This phrase matches too many texts to rank completely')).toBeVisible();
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
    await expect(canvas.getByText('Titles could not be loaded, so results show Work IDs.')).toBeVisible();
    await expect(canvas.getByRole('link', { name: 'Work 00000001' })).toBeVisible();
  },
};

export const MineIsNotSearchable: Story = {
  args: { parsed: { ok: false, reason: 'mine', phrase: 'Pride' }, initial: null },
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole('heading', { name: 'Your ratings cannot be searched' })).toBeVisible();
    await expect(canvas.getByRole('link', { name: 'Search Global' })).toHaveAttribute('href', '/search?q=Pride');
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
    const box = within(canvasElement).getByRole('searchbox', { name: 'Search phrase' });
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
  args: { parsed: state('《西游记》'), locale: 'zh-CN', messages: messages['zh-CN'], discoverMessages: discover['zh-CN'],
    initial: results([hit(6, '西游记', 'zh-Hans'), hit(7, '西游记 · 第二回 悟彻菩提真妙理', 'zh-Hans')]) },
  globals: { locale: 'zh-CN', theme: 'dark' },
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole('heading', { level: 1, name: '搜索作品' })).toBeVisible();
    await expect(canvas.getByTestId('search-completeness')).toHaveTextContent('共 2 部作品匹配（精确计数）');
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
  args: { parsed: state('《西游记》'), locale: 'zh-CN', messages: messages['zh-CN'], discoverMessages: discover['zh-CN'],
    initial: results([hit(6, '西游记', 'zh-Hans'), hit(9, '雨夜书店 · 连载小说：一部关于深夜书店、未寄出的信和最后一班车的长篇连载',
      'zh-Hans')]) },
  globals: { viewport: { value: 'phone' }, locale: 'zh-CN' },
  async play() {
    await expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(window.innerWidth);
  },
};
