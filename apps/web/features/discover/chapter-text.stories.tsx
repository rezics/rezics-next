import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, fn, userEvent, waitFor, within } from 'storybook/test';
import { uiLocales } from '../../i18n/define.ts';
import { direction } from '@rezics/main/language';
import { localizedPath } from '../../i18n/locale.ts';
import { chapterHref, workHref } from '../work-page/route.ts';
import type { SearchContinuation, SearchLoaded, SearchResultPage } from '../search/types.ts';
import type { SearchLoader } from '../search/query.ts';
import { Providers } from '../shell/providers.tsx';
import { attributed, creditedOnly, unassessed } from '../rights-mark/fixtures.ts';
import { chapterSearchState } from './chapter-text-read.ts';
import { ChapterTextResults } from './chapter-text.tsx';
import { chapterTextMessages } from './chapter-text-messages.ts';
import { DiscoverView } from './discover-view.tsx';
import { emptyBrowse } from './browse-state.ts';
import { fixtureTopicLoader } from './browse-fixtures.ts';

const book = 'https://rezics.com/id/00000000-0000-4000-8000-000000000001';
const post = '00000000-0000-4000-8000-000000000002';
const chapter = chapterHref(book, post, 'en');
const read: Extract<SearchLoaded, { ok: true }> = { ok: true, page: { total: 1, sequence: '1', indexGeneration: 'index',
  next: null, titles: true, hits: [{ matchUnit: 'unit', work: book, mainVersion: book, types: ['https://schema.org/Book'],
    title: { value: 'The Lantern Road', language: 'en', direction: direction('en', 'The Lantern Road'), basis: 'requested' },
    cover: null, authors: [], rating: null, tagline: null, completion: null,
    reasons: { language: 'en', field: 'body', matchedText: null, matchedLanguage: null,
      chapter: { title: 'At the harbour', href: chapter }, realm: null, classification: null } }],
} };
const state = chapterSearchState({ ...emptyBrowse, q: 'lanternroad' });
const meta = { title: 'Discover/Chapter text matches', component: ChapterTextResults,
  args: { read, state, locale: 'en' }, decorators: [Story => <Providers><div className="mx-auto max-w-5xl p-4"><Story /></div></Providers>],
} satisfies Meta<typeof ChapterTextResults>;
export default meta;
type Story = StoryObj<typeof meta>;

export const BookAndChapter: Story = { async play({ canvasElement }) {
  const canvas = within(canvasElement);
  await expect(canvas.getByRole('region', { name: 'Found in chapter text' })).toBeVisible();
  await expect(canvas.getByRole('link', { name: 'The Lantern Road' })).toHaveAttribute('href', localizedPath(workHref(book), 'en'));
  await expect(canvas.getByRole('link', { name: 'At the harbour' })).toHaveAttribute('href', localizedPath(chapter, 'en'));
} };
export const TraditionalChinesePhone: Story = { args: { locale: 'zh-Hant' },
  globals: { locale: 'zh-Hant', theme: 'dark', viewport: { value: 'phone' } },
  async play({ canvasElement }) {
    await expect(within(canvasElement).getByRole('region', { name: chapterTextMessages['zh-Hant'].title })).toBeVisible();
    await expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(innerWidth);
  } };
export const NoChapterHitsLeaveNoTrace: Story = { args: { read: { ok: true, page: { ...read.page,
  hits: read.page.hits.map(hit => ({ ...hit, reasons: { ...hit.reasons, chapter: null } })) } } },
  async play({ canvasElement }) { await expect(within(canvasElement).queryByRole('region')).toBeNull(); } };
export const AllEightLabels: Story = { render: () => <div className="grid gap-8">
  {uiLocales.map(locale => <ChapterTextResults key={locale} read={read} state={state} locale={locale} />)}
</div>, async play({ canvasElement }) {
  const canvas = within(canvasElement);
  for (const locale of uiLocales) {
    const region = canvas.getByRole('region', { name: chapterTextMessages[locale].title });
    await expect(region).toBeVisible();
    await expect(within(region).getByRole('link', { name: 'The Lantern Road' })).toBeVisible();
    await expect(within(region).getByRole('link', { name: 'At the harbour' })).toBeVisible();
  }
} };
export const IndependentOfResourceCount: Story = { render: () => <DiscoverView state={{ ...emptyBrowse, q: 'lanternroad' }}
  locale="en" topics={[]} sections={null} chapterText={read} topicLoad={fixtureTopicLoader()}
  results={{ ok: true, data: { items: [], nextCursor: null, complete: true, count: { value: 0, kind: 'exact' } } }} />,
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole('link', { name: 'At the harbour' })).toBeVisible();
    await expect(canvas.getByRole('status')).toHaveTextContent('0 results');
    await expect(canvas.queryByRole('link', { name: 'Show more' })).toBeNull();
  } };

const token = (nextOffset: number): SearchContinuation => ({ queryDigest: 'a'.repeat(64), resultDigest: 'b'.repeat(64),
  sourcePosition: { datasetId: 'product', dataEpoch: 'story', sequence: '1' }, indexGeneration: 'index',
  nextOffset, expiresAt: 9999999999999 });
const second = { ...read.page.hits[0]!, matchUnit: 'second', reasons: { ...read.page.hits[0]!.reasons,
  chapter: { title: 'The last lantern', href: chapterHref(book, '00000000-0000-4000-8000-000000000003', 'en') } } };
const firstPage = { ...read.page, total: 2, next: token(1) };
const pagesLoader = (first: SearchResultPage, later: readonly SearchResultPage[]): SearchLoader => async continuation => {
  if (!continuation) return { ok: true, page: first };
  const index = [first, ...later].findIndex(page => JSON.stringify(page.next) === JSON.stringify(continuation));
  const page = later[index];
  if (!page) throw new Error('Unexpected chapter continuation');
  return { ok: true, page };
};
const finalPage = { ...read.page, total: 2, hits: [read.page.hits[0]!, second] };
const continueLoad = fn(pagesLoader(firstPage, [finalPage]));

export const ContinueToTheLastChapter: Story = {
  args: { read: { ok: true, page: firstPage }, load: continueLoad },
  beforeEach() { continueLoad.mockClear(); },
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole('button', { name: 'Show more chapter matches' }));
    await expect(await canvas.findByRole('link', { name: 'The last lantern' })).toHaveFocus();
    await expect(continueLoad).toHaveBeenCalledWith(firstPage.next);
    await expect(canvas.getAllByRole('link', { name: 'At the harbour' })).toHaveLength(1);
    await expect(canvas.getByText('Showing all 2 chapter matches')).toBeVisible();
    await expect(canvas.queryByRole('button', { name: 'Show more chapter matches' })).toBeNull();
  },
};

const emptyPage = (offset: number): SearchResultPage => ({ ...read.page, hits: [], total: 1, next: token(offset) });
const sparseFirst = emptyPage(1);
const sparseLoad = fn(pagesLoader(sparseFirst, [emptyPage(2), emptyPage(3), emptyPage(4), emptyPage(5), read.page]));
export const BoundedSparseScan: Story = {
  args: { read: { ok: true, page: sparseFirst }, load: sparseLoad },
  globals: { viewport: { value: 'phone' }, theme: 'dark' },
  beforeEach() { sparseLoad.mockClear(); },
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole('button', { name: 'Check more results' }));
    await waitFor(() => expect(sparseLoad).toHaveBeenCalledTimes(4));
    await waitFor(() => expect(canvas.getByRole('button', { name: 'Check more results' })).toBeEnabled());
    await expect(canvas.getByText(/No chapter matches yet/)).toBeVisible();
    await userEvent.click(canvas.getByRole('button', { name: 'Check more results' }));
    await expect(await canvas.findByRole('link', { name: 'At the harbour' })).toBeVisible();
    await expect(canvas.getByText('Showing the only chapter match')).toBeVisible();
    await expect(sparseLoad).toHaveBeenCalledTimes(5);
  },
};

const unavailableLoad = fn<SearchLoader>();
export const RetryPreservesChapters: Story = {
  args: { read: { ok: true, page: firstPage }, load: unavailableLoad },
  beforeEach() { unavailableLoad.mockReset().mockResolvedValueOnce({ ok: false, failure: 'unavailable' })
    .mockResolvedValue({ ok: true, page: finalPage }); },
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    canvas.getByRole('button', { name: 'Show more chapter matches' }).focus();
    await userEvent.keyboard('{Enter}');
    await expect(await canvas.findByRole('alert')).toBeVisible();
    await expect(canvas.getByRole('link', { name: 'At the harbour' })).toBeVisible();
    canvas.getByRole('button', { name: 'Try again' }).focus();
    await userEvent.keyboard('{Enter}');
    await expect(await canvas.findByRole('link', { name: 'The last lantern' })).toHaveFocus();
    await expect(unavailableLoad).toHaveBeenNthCalledWith(2, firstPage.next);
    await expect(canvas.getAllByRole('link', { name: 'At the harbour' })).toHaveLength(1);
  },
};

const emptyRetry = fn<SearchLoader>();
export const RetryFocusesExhaustedStatus: Story = {
  args: { read: { ok: true, page: firstPage }, load: emptyRetry },
  beforeEach() { emptyRetry.mockReset().mockResolvedValueOnce({ ok: false, failure: 'unavailable' })
    .mockResolvedValue({ ok: true, page: read.page }); },
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole('button', { name: 'Show more chapter matches' }));
    const retry = await canvas.findByRole('button', { name: 'Try again' });
    retry.focus(); await userEvent.keyboard('{Enter}');
    await expect(await canvas.findByText('Showing the only chapter match')).toHaveFocus();
    await expect(canvas.getAllByRole('link', { name: 'At the harbour' })).toHaveLength(1);
    await expect(emptyRetry).toHaveBeenNthCalledWith(2, firstPage.next);
  },
};

const restartLoad = fn<SearchLoader>();
export const RestartFocusesFirstUsefulChapter: Story = {
  args: { read: { ok: true, page: firstPage }, load: restartLoad },
  beforeEach() { restartLoad.mockReset().mockResolvedValueOnce({ ok: false, failure: 'restart' })
    .mockResolvedValue({ ok: true, page: read.page }); },
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole('button', { name: 'Show more chapter matches' }));
    const restart = await canvas.findByRole('button', { name: 'Search again' });
    restart.focus(); await userEvent.keyboard('{Enter}');
    await waitFor(() => expect(canvas.queryByRole('button', { name: 'Search again' })).toBeNull());
    await expect(canvas.getByRole('link', { name: 'At the harbour' })).toHaveFocus();
    await expect(restartLoad).toHaveBeenNthCalledWith(2, undefined);
    await expect(canvas.getAllByRole('link', { name: 'At the harbour' })).toHaveLength(1);
  },
};

const repeatedLoad = fn<SearchLoader>();
export const RepeatedChapterCursor: Story = {
  args: { read: { ok: true, page: firstPage }, load: repeatedLoad },
  beforeEach() { repeatedLoad.mockReset().mockResolvedValue({ ok: true, page: { ...firstPage, hits: [] } }); },
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole('button', { name: 'Show more chapter matches' }));
    await expect(await canvas.findByText('Results changed since the first page')).toBeVisible();
    await expect(repeatedLoad).toHaveBeenCalledTimes(1);
    await expect(canvas.getAllByRole('link', { name: 'At the harbour' })).toHaveLength(1);
    await expect(canvas.queryByRole('button', { name: 'Show more chapter matches' })).toBeNull();
  },
};

const actionCycleLoad = fn<SearchLoader>();
export const ChapterCycleAfterBoundedAction: Story = {
  args: { read: { ok: true, page: firstPage }, load: actionCycleLoad },
  globals: { viewport: { value: 'phone' }, theme: 'dark' },
  beforeEach() {
    actionCycleLoad.mockReset();
    for (let offset = 2; offset <= 5; offset += 1) actionCycleLoad.mockResolvedValueOnce({ ok: true, page: emptyPage(offset) });
    actionCycleLoad.mockResolvedValue({ ok: true, page: emptyPage(1) });
  },
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole('button', { name: 'Show more chapter matches' }));
    await waitFor(() => expect(actionCycleLoad).toHaveBeenCalledTimes(4));
    await waitFor(() => expect(canvas.getByRole('button', { name: 'Show more chapter matches' })).toBeEnabled());
    await userEvent.click(canvas.getByRole('button', { name: 'Show more chapter matches' }));
    await expect(await canvas.findByText('Results changed since the first page')).toBeVisible();
    await expect(actionCycleLoad).toHaveBeenCalledTimes(5);
    await expect(canvas.getAllByRole('link', { name: 'At the harbour' })).toHaveLength(1);
  },
};

const rightsFirst = { ...firstPage, hits: firstPage.hits.map(hit => ({ ...hit, factObligations: attributed })) };
const rightsFinal = { ...finalPage, hits: [{ ...second, factObligations: creditedOnly }] };
export const SuppliedFactObligations: Story = {
  args: { read: { ok: true, page: rightsFirst }, load: pagesLoader(rightsFirst, [rightsFinal]) },
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    const first = within(canvas.getByRole('link', { name: 'At the harbour' }).closest('li')!);
    await expect(first.getByRole('link', { name: 'Example' })).toHaveAttribute('href', 'https://example.test/records/1');
    await expect(first.getByRole('link', { name: 'CC BY-SA 3.0' }))
      .toHaveAttribute('href', 'https://creativecommons.org/licenses/by-sa/3.0/');
    await expect(first.getByText('Adaptations stay under the same terms.')).toBeVisible();
    await userEvent.click(canvas.getByRole('button', { name: 'Show more chapter matches' }));
    const last = within((await canvas.findByRole('link', { name: 'The last lantern' })).closest('li')!);
    await expect(last.getByRole('link', { name: 'Archive' })).toHaveAttribute('href', 'https://archive.example/works/2');
    await expect(last.getByRole('link', { name: 'CC BY 4.0' }))
      .toHaveAttribute('href', 'https://creativecommons.org/licenses/by/4.0/');
    await expect(first.getByRole('link', { name: 'Example' })).toBeVisible();
  },
};

export const UnassessedFactsStayUnassessed: Story = {
  args: { read: { ok: true, page: { ...read.page, hits: read.page.hits.map(hit => ({ ...hit, factObligations: unassessed })) } } },
  async play({ canvasElement }) {
    await expect(within(canvasElement).getByRole('link', { name: 'At the harbour' })).toBeVisible();
    await expect(canvasElement.querySelector('[data-rights-mark]')).toBeNull();
  },
};

export const UnsupportedSelection: Story = { args: { read: { ok: false, failure: 'unsupported' } } };
export const NoMatchesAfterTheLastPage: Story = {
  args: { read: { ok: true, page: sparseFirst }, load: async () => ({ ok: true, page: { ...read.page, hits: [], total: 0 } }) },
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole('button', { name: 'Check more results' }));
    await expect(await canvas.findByText('No chapter text matches “lanternroad”.')).toHaveFocus();
    await expect(canvas.queryByRole('button', { name: 'Check more results' })).toBeNull();
  },
};
