import { useEffect, useState } from 'react';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, within } from 'storybook/test';
import type { AnswerRecord } from '../../../../scripts/api/answer-record.ts';
import record from '../../../../tests/qa/fixtures/outcomes/anime/navigate-a-thousand-episode-inventory-thousand-chapters.json';
import { BFF_PREFIX, browserMainApi } from '../api/browser.ts';
import type { ReadingPositionPage } from '../wiki/position-picker.ts';
import { BooksContentsRecordedPage, readContentsInventory, type BooksContentsRecordedView } from './books-contents-recorded-page.tsx';
import { messages } from './messages.ts';

const baseline = (record as unknown as AnswerRecord).personas.visitor.find(item => item.label === 'inventory-start')!.answer as ReadingPositionPage;
const iri = (tail: string) => `https://rezics.com/id/00000000-0000-4000-8000-${tail.padStart(12, '0')}`;
const work = iri('100'), structure = iri('101'), revision = iri('102'), target = iri('103');
const q = 'Episode 1000 重逢';
function page(repeated: boolean): ReadingPositionPage {
  const item = { ...baseline.items[0]!, work, structure, revision, parent: structure,
    occurrence: iri('1000'), target, ordinal: 1000,
    segmentKey: baseline.items[1]!.segmentKey, orderKey: baseline.items[1]!.orderKey, displayLabel: q, labels: [{ value: q, language: 'en' }] };
  const items = repeated ? [{ ...item, occurrence: iri('999'), ordinal: 999,
    segmentKey: baseline.items[0]!.segmentKey, orderKey: baseline.items[0]!.orderKey, displayLabel: 'Episode 999 再会',
    labels: [{ value: 'Episode 999 再会', language: 'en' }] }, item] : [item];
  return { ...baseline, work, items, complete: true, next: null, nextCursor: null, visibility: 'visible',
    count: { value: items.length, kind: 'exact-page', total: null }, search: { status: 'current' } };
}
export const missingPopulatedContentsStates = [false, true].map(repeated => ({
  row: 'anime/navigate-a-thousand-episode-inventory-thousand-chapters', persona: 'visitor', status: 200,
  request: `/v1/reading-positions/${work.slice(-36)}?${new URLSearchParams({ position: 'start', language: 'en',
    q: repeated ? 'Episode' : q, limit: '100', ...(repeated ? { cursor: 'contract-previous-window' } : {}) })}`, state: page(repeated),
}));

/** Synthetic contract examples. Recorded episode search currently continues empty windows; it is not relabelled as populated. */
function PopulatedEpisodeContract({ repeated }: { repeated: boolean }) {
  const [view, setView] = useState<BooksContentsRecordedView>({ kind: 'loading' });
  const entered = repeated ? 'Episode' : q;
  useEffect(() => {
    let live = true;
    const fetcher = (async (input: RequestInfo | URL) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      if (url.pathname.replace(BFF_PREFIX, '') !== `/v1/reading-positions/${work.slice(-36)}`
        || url.searchParams.get('q') !== entered || url.searchParams.get('language') !== 'en'
        || url.searchParams.get('limit') !== '100' || url.searchParams.get('actingSubject')
        || url.searchParams.get('cursor') !== (repeated ? 'contract-previous-window' : null)) throw new Error('Wrong contract inventory request');
      return Response.json(page(repeated));
    }) as typeof fetch;
    const main = browserMainApi(window.location.origin, { anonymous: true, fetcher });
    void readContentsInventory({ main }, { workId: work.slice(-36), workRef: work.slice(-36), workIri: work,
      locale: 'en', language: 'en', q: entered, limit: 100,
      ...(repeated ? { cursor: 'contract-previous-window' } : {}) }).then(next => { if (live) setView(next); });
    return () => { live = false; };
  }, [repeated, entered]);
  return <main className="mx-auto grid min-w-0 max-w-4xl gap-6 p-4 sm:p-8">
    <p className="text-muted-foreground text-sm">Unrecorded populated inventory contract</p>
    <BooksContentsRecordedPage view={view} locale="en" messages={messages.en} />
  </main>;
}
const meta = { title: 'Work page/Populated episode contents contract (unrecorded)', component: PopulatedEpisodeContract,
  args: { repeated: false }, globals: { viewport: { value: 'desktop' } }, excludeStories: ['missingPopulatedContentsStates'],
  parameters: { controls: { disable: true }, missingRecordedStates: missingPopulatedContentsStates },
} satisfies Meta<typeof PopulatedEpisodeContract>;
export default meta;
type Story = StoryObj<typeof meta>;
export const DistantCjkEpisode: Story = { async play({ canvasElement }) {
  const canvas = within(canvasElement);
  await expect(canvas.findByRole('link', { name: q })).resolves.toBeVisible();
  await expect(canvas.queryByRole('link', { name: messages.en.startReading })).not.toBeInTheDocument();
  await expect(canvas.queryByRole('link', { name: messages.en.nextPage })).not.toBeInTheDocument();
} };
export const DistantCjkEpisodePhone: Story = { ...DistantCjkEpisode, globals: { viewport: { value: 'phone' } } };
export const RepeatedWorkOccurrences: Story = { args: { repeated: true }, async play({ canvasElement }) {
  await expect(within(canvasElement).findByRole('link', { name: 'Episode 999 再会' })).resolves.toBeVisible();
  await expect(within(canvasElement).getByRole('link', { name: q })).toBeVisible();
  const occurrences = [...canvasElement.querySelectorAll('[data-occurrence]')].map(item => item.getAttribute('data-occurrence'));
  await expect(new Set(occurrences).size).toBe(2);
} };
export const RepeatedWorkOccurrencesPhone: Story = { ...RepeatedWorkOccurrences, globals: { viewport: { value: 'phone' } } };
