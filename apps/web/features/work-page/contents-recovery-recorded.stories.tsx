import { useEffect, useState } from 'react';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, within } from 'storybook/test';
import type { AnswerRecord } from '../../../../scripts/api/answer-record.ts';
import books from '../../../../tests/qa/fixtures/outcomes/books/navigate-a-thousand-chapter-inventory-thousand-chapters.json';
import anime from '../../../../tests/qa/fixtures/outcomes/anime/navigate-a-thousand-episode-inventory-thousand-chapters.json';
import { BFF_PREFIX, browserMainApi } from '../api/browser.ts';
import { recordedFetch } from '../stories/recorded-fetch.ts';
import { BooksContentsRecordedPage, booksContentsInventoryQueryFromPath, mapBooksContentsRecordedPage,
  type BooksContentsRecordedView } from './books-contents-recorded-page.tsx';
import { messages } from './messages.ts';
import { iriOf } from './route.ts';

type Medium = 'books' | 'anime';
type State = 'empty' | 'cursor-refused' | 'private-denied';
function RecordedContentsRecovery({ medium, state }: { medium: Medium; state: State }) {
  const [view, setView] = useState<BooksContentsRecordedView>({ kind: 'loading' });
  const [fault, setFault] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    setView({ kind: 'loading' }); setFault(null);
    const record = (medium === 'books' ? books : anime) as unknown as AnswerRecord;
    const label = state === 'empty' ? medium === 'books' ? 'chapter-search-no-match' : 'inventory-search-empty'
      : state === 'cursor-refused' ? medium === 'books' ? 'cursor-query-refusal' : 'cursor-query-refused'
        : medium === 'books' ? 'private-inventory' : 'private-inventory-refused';
    const persona = medium === 'books' && state === 'empty' ? 'member' : 'visitor';
    const sample = record.personas[persona].find(item => item.label === label);
    if (!sample) { setFault(`Missing ${medium}/visitor/${label}`); return; }
    const replay = recordedFetch(record, persona, [{ label, state: state === 'empty' ? 'empty' : 'error' }], { pathPrefix: BFF_PREFIX });
    const { work, query } = booksContentsInventoryQueryFromPath(sample.path);
    const main = browserMainApi(window.location.origin, { anonymous: !query.actingSubject, fetcher: replay.fetcher });
    void main.v1['reading-positions']({ work }).get({ query }).then(answer => {
      if (live) setView(mapBooksContentsRecordedPage(answer, { workRef: work, workIri: iriOf(work), locale: 'en',
        language: query.language, q: query.q, limit: query.limit, cursor: query.cursor }));
    }).catch(error => { if (live) setFault(String(error)); });
    return () => { live = false; replay.dispose(); };
  }, [medium, state]);
  return <main className="mx-auto grid min-w-0 max-w-4xl gap-6 p-4 sm:p-8">
    {fault ? <p role="alert">{fault}</p> : <BooksContentsRecordedPage view={view} locale="en" messages={messages.en} />}
  </main>;
}
const meta = { title: 'Work page/Contents recovery recorded', component: RecordedContentsRecovery,
  args: { medium: 'books', state: 'empty' }, globals: { viewport: { value: 'desktop' } },
  parameters: { controls: { disable: true } },
} satisfies Meta<typeof RecordedContentsRecovery>;
export default meta;
type Story = StoryObj<typeof meta>;
export const BooksEmpty: Story = { async play({ canvasElement }) {
  await expect(within(canvasElement).findByRole('heading', { name: messages.en.noContents })).resolves.toBeVisible();
} };
export const BooksEmptyPhone: Story = { ...BooksEmpty, globals: { viewport: { value: 'phone' } } };
export const BooksCursorRefused: Story = { args: { state: 'cursor-refused' }, async play({ canvasElement }) {
  await expect(within(canvasElement).findByRole('alert')).resolves.toBeVisible();
  await expect(within(canvasElement).getByRole('link', { name: messages.en.firstPage })).toBeVisible();
} };
export const BooksCursorRefusedPhone: Story = { ...BooksCursorRefused, globals: { viewport: { value: 'phone' } } };
export const BooksPrivateDenied: Story = { args: { state: 'private-denied' }, async play({ canvasElement }) {
  await expect(within(canvasElement).findByRole('alert')).resolves.toBeVisible();
  await expect(within(canvasElement).queryByRole('list')).not.toBeInTheDocument();
} };
export const BooksPrivateDeniedPhone: Story = { ...BooksPrivateDenied, globals: { viewport: { value: 'phone' } } };
export const AnimeEmpty: Story = { args: { medium: 'anime' }, async play({ canvasElement }) {
  const canvas = within(canvasElement);
  await expect(canvas.findByRole('link', { name: messages.en.nextPage })).resolves.toBeVisible();
  await expect(canvas.queryByRole('heading', { name: messages.en.noContents })).not.toBeInTheDocument();
} };
export const AnimeEmptyPhone: Story = { ...AnimeEmpty, globals: { viewport: { value: 'phone' } } };
export const AnimeCursorRefused: Story = { ...BooksCursorRefused, args: { medium: 'anime', state: 'cursor-refused' } };
export const AnimeCursorRefusedPhone: Story = { ...AnimeCursorRefused, globals: { viewport: { value: 'phone' } } };
export const AnimePrivateDenied: Story = { ...BooksPrivateDenied, args: { medium: 'anime', state: 'private-denied' } };
export const AnimePrivateDeniedPhone: Story = { ...AnimePrivateDenied, globals: { viewport: { value: 'phone' } } };
