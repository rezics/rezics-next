import { useEffect, useState } from 'react';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, within } from 'storybook/test';
import type { AnswerRecord } from '../../../../scripts/api/answer-record.ts';
import answers from '../../../../tests/qa/fixtures/outcomes/manga/collection-tracking-and-progress.json';
import { BFF_PREFIX, browserMainApi } from '../api/browser.ts';
import { seedServedTypes } from '../catalogue/type-fixtures.ts';
import type { MainClient } from '../discover/types.ts';
import { recordedFetch } from '../stories/recorded-fetch.ts';
import { MangaCollectionRecordedPage } from './manga-collection-recorded-page.tsx';
import { mangaCollectionSample, mangaCollectionSelections, type MangaLibraryPersona } from './manga-collection-recorded-page.ts';
import { copyOf } from './messages.ts';

const record = answers as AnswerRecord;
seedServedTypes();
interface Args { persona: MangaLibraryPersona; loading: boolean }
const title = (persona: MangaLibraryPersona) => (mangaCollectionSample(record, persona, 'work-header-1').answer as {
  title: { value: string };
}).title.value;
const subject = (persona: MangaLibraryPersona) => new URL(mangaCollectionSample(record, persona, 'work-header-1').path,
  'https://recorded.invalid').searchParams.get('actingSubject')!;

function RecordedMangaCollection({ persona, loading }: Args) {
  const [visit, setVisit] = useState<{ main: MainClient; persona: MangaLibraryPersona; loading: boolean } | null>(null);
  const [fault, setFault] = useState<string | null>(null);
  useEffect(() => {
    setFault(null);
    let mounted = true;
    const replay = recordedFetch(record, persona, mangaCollectionSelections(record, persona, loading), {
      pathPrefix: BFF_PREFIX, sequence: true,
    });
    const fetcher = (async (input, init) => {
      try { return await replay.fetcher(input, init); }
      catch (error) {
        if (mounted && !(error instanceof DOMException && error.name === 'AbortError')) setFault(String(error));
        throw error;
      }
    }) as typeof fetch;
    setVisit({ main: browserMainApi(window.location.origin, { fetcher }), persona, loading });
    return () => { mounted = false; replay.dispose(); };
  }, [persona, loading]);
  if (fault) return <pre role="alert" className="whitespace-pre-wrap break-words p-6">{fault}</pre>;
  if (!visit || visit.persona !== persona || visit.loading !== loading) return null;
  return <MangaCollectionRecordedPage main={visit.main} persona={persona} actingSubject={subject(persona)} year={2026} />;
}

const meta = {
  title: 'Tracking/Manga collection recorded', component: RecordedMangaCollection,
  args: { persona: 'stranger', loading: false },
  globals: { viewport: { value: 'desktop' } },
  parameters: { layout: 'fullscreen', controls: { disable: true }, route: { pathname: '/en/library', query: { shelf: 'reading', view: 'grid' } } },
} satisfies Meta<typeof RecordedMangaCollection>;
export default meta;
type Story = StoryObj<typeof meta>;
const phone = { globals: { viewport: { value: 'phone' as const } } };

async function library(canvasElement: HTMLElement, persona: MangaLibraryPersona) {
  const canvas = within(canvasElement);
  await expect(await canvas.findByRole('heading', { level: 1, name: 'Library' })).toBeVisible();
  await expect(canvas.getByText(`${persona} · ${subject(persona)}`)).toBeVisible();
  await expect(canvas.getByRole('heading', { level: 3, name: title(persona) })).toBeVisible();
  const shelf = mangaCollectionSample(record, persona, 'library-9').answer as { items: { card: { title: { value: string } } }[] };
  for (const item of shelf.items) await expect(canvas.getByRole('heading', { level: 3, name: item.card.title.value })).toBeVisible();
  const navigation = within(canvas.getByRole('navigation', { name: 'Shelves' }));
  await expect(navigation.getByRole('link', { name: `Currently reading ${shelf.items.length}` })).toBeVisible();
  await expect(canvas.getByText('2 chapters completed')).toBeVisible();
  await document.fonts.ready;
  await expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(window.innerWidth);
  return canvas;
}

export const StrangerLibrary: Story = { play: async ({ canvasElement }) => { await library(canvasElement, 'stranger'); } };
export const StrangerLibraryPhone: Story = { ...StrangerLibrary, ...phone };
export const MemberLibrary: Story = { args: { persona: 'member' }, play: async ({ canvasElement }) => { await library(canvasElement, 'member'); } };
export const MemberLibraryPhone: Story = { ...MemberLibrary, ...phone };
export const OwnerLibrary: Story = { args: { persona: 'owner' }, play: async ({ canvasElement }) => { await library(canvasElement, 'owner'); } };
export const OwnerLibraryPhone: Story = { ...OwnerLibrary, ...phone };
export const ModeratorLibrary: Story = { args: { persona: 'moderator' }, play: async ({ canvasElement }) => { await library(canvasElement, 'moderator'); } };
export const ModeratorLibraryPhone: Story = { ...ModeratorLibrary, ...phone };
export const OperatorLibrary: Story = { args: { persona: 'operator' }, play: async ({ canvasElement }) => { await library(canvasElement, 'operator'); } };
export const OperatorLibraryPhone: Story = { ...OperatorLibrary, ...phone };

/** The shelf request remains unanswered; no empty library is inferred from it. */
export const Loading: Story = { args: { loading: true }, play: async ({ canvasElement }) => {
  const canvas = within(canvasElement);
  await expect(await canvas.findByRole('status')).toHaveTextContent('Loading');
  await expect(canvas.queryByRole('heading', { name: 'Library' })).toBeNull();
} };
export const LoadingPhone: Story = { ...Loading, ...phone };

/** Library opens the production Manga control, marks a chapter in volume two, then clears it. */
export const ChaptersAcrossVolumes: Story = { play: async ({ canvasElement }) => {
  const canvas = await library(canvasElement, 'stranger');
  const t = copyOf('en');
  await userEvent.click(canvas.getByText(t.workProgress, { exact: false, selector: 'summary' }));
  await expect(await canvas.findByText(t.lastRead({ place: 'Volume 1, chapter 2' }))).toBeVisible();
  for (const name of ['Volume 1, chapter 1', 'Volume 1, chapter 2', 'Volume 2, chapter 1', 'Volume 2, chapter 2']) {
    await expect(canvas.getByRole('button', { name })).toBeVisible();
  }
  await userEvent.click(canvas.getByRole('button', { name: 'Volume 2, chapter 1' }));
  await userEvent.click(await canvas.findByRole('button', { name: t.markChapterRead }));
  await expect(await canvas.findByText(t.lastRead({ place: 'Volume 2, chapter 1' }))).toBeVisible();
  await userEvent.click(await canvas.findByRole('button', { name: t.markChapterUnread }));
  await expect(await canvas.findByText(t.lastRead({ place: 'Volume 1, chapter 2' }))).toBeVisible();
  await expect(canvas.getByRole('button', { name: t.markChapterRead })).toBeVisible();
  await expect(canvas.queryByRole('alert')).toBeNull();
  await expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(window.innerWidth);
} };
export const ChaptersAcrossVolumesPhone: Story = { ...ChaptersAcrossVolumes, ...phone };
