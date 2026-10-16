import { localizedPath } from '../../i18n/locale.ts';
import { workHref } from '../work-page/route.ts';
import { Suspense, useEffect, useState, type ReactNode } from 'react';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, within } from 'storybook/test';
import { materializeData } from 'native-i18n';
import type { AnswerPersona, AnswerRecord } from '../../../../scripts/api/answer-record.ts';
import answers from '../../../../tests/qa/fixtures/outcomes/manga/collection-tracking-and-progress.json';
import { BFF_PREFIX, browserMainApi } from '../api/browser.ts';
import { seedServedTypes } from '../catalogue/type-fixtures.ts';
import type { MainClient } from '../discover/types.ts';
import { recordedFetch } from '../stories/recorded-fetch.ts';
import { chooseMenuItem } from '../stories/choose-option.ts';
import { messages as libraryMessages } from '../library/messages.ts';
import { messages as catalogueMessages } from '../catalogue/messages.ts';
import { MangaCollectionRecordedPage } from './manga-collection-recorded-page.tsx';
import { mangaCollectionSample, mangaCollectionSelections, type MangaLibraryPersona } from './manga-collection-recorded-page.ts';
import { mangaWorkVisit } from './manga-collection-recorded-page.work.tsx';
import { mainRelationships } from '../relationships/api.ts';
import { mangaWorkSelections, type MangaWorkSurface } from './manga-collection-recorded-page.ts';
import { copyOf } from './messages.ts';

const record = answers as AnswerRecord;
seedServedTypes();
interface Args { persona: AnswerPersona; loading: boolean; surface: 'library' | MangaWorkSurface }
const title = (persona: AnswerPersona) => (mangaCollectionSample(record, persona, 'work-header-1').answer as {
  title: { value: string };
}).title.value;
const subject = (persona: AnswerPersona) => new URL(mangaCollectionSample(record, persona, 'work-header-1').path,
  'https://recorded.invalid').searchParams.get('actingSubject')!;

function RecordedMangaCollection({ persona, loading }: { persona: MangaLibraryPersona; loading: boolean }) {
  const [visit, setVisit] = useState<{ main: MainClient; anonymous: MainClient; persona: MangaLibraryPersona; loading: boolean } | null>(null);
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
    setVisit({ main: browserMainApi(window.location.origin, { fetcher }),
      anonymous: browserMainApi(window.location.origin, { anonymous: true, fetcher }), persona, loading });
    return () => { mounted = false; replay.dispose(); };
  }, [persona, loading]);
  if (fault) return <pre role="alert" className="whitespace-pre-wrap break-words p-6">{fault}</pre>;
  if (!visit || visit.persona !== persona || visit.loading !== loading) return null;
  return <MangaCollectionRecordedPage main={visit.main} anonymous={visit.anonymous} persona={persona}
    actingSubject={subject(persona)} year={2026} />;
}

function RecordedMangaWork({ persona, surface }: { persona: AnswerPersona; surface: MangaWorkSurface }) {
  const [visit, setVisit] = useState<{ persona: AnswerPersona; surface: MangaWorkSurface; page: ReactNode } | null>(null);
  const [fault, setFault] = useState<string | null>(null);
  useEffect(() => {
    let mounted = true;
    setFault(null);
    const replay = recordedFetch(record, persona, mangaWorkSelections(record, persona, surface), {
      pathPrefix: BFF_PREFIX, sequence: true,
    });
    const fetcher = (async (input, init) => {
      try { return await replay.fetcher(input, init); }
      catch (error) {
        if (mounted && !(error instanceof DOMException && error.name === 'AbortError')) setFault(String(error));
        throw error;
      }
    }) as typeof fetch;
    const main = browserMainApi(window.location.origin, { fetcher, anonymous: persona === 'visitor' });
    const anonymous = browserMainApi(window.location.origin, { fetcher, anonymous: true });
    const actor = subject(persona) ?? undefined;
    const sample = mangaCollectionSample(record, persona, `${surface}-1`);
    const id = new URL(sample.path, 'https://recorded.invalid').pathname.split('/').at(-1)!;
    void mangaWorkVisit({ main, anonymous, actingSubject: actor, signedIn: persona !== 'visitor',
      avatarQuery: actor ? `?actingSubject=${encodeURIComponent(actor)}` : '', publicFetch: fetcher,
      pageUrl: new URL(localizedPath(workHref(id, surface === 'work-overview' ? 'overview' : 'contents'), 'en'), 'https://rezics.com').href }, id,
    surface === 'work-overview' ? 'overview' : 'contents', 'en', actor ? mainRelationships(actor, {
      origin: `${window.location.origin}${BFF_PREFIX}`, fetch: fetcher,
    }) : undefined).then(result => {
      if (!mounted) return;
      if (result.ok) setVisit({ persona, surface, page: result.page });
      else setFault(JSON.stringify(result));
    }).catch(error => { if (mounted) setFault(String(error)); });
    return () => { mounted = false; replay.dispose(); };
  }, [persona, surface]);
  if (fault) return <pre role="alert" className="whitespace-pre-wrap break-words p-6">{fault}</pre>;
  return <><p className="break-all p-4 text-sm">{persona}{subject(persona) ? ` · ${subject(persona)}` : ''}</p>
    <Suspense fallback={null}>{visit?.persona === persona && visit.surface === surface ? visit.page : null}</Suspense></>;
}

function RecordedMangaSurface(args: Args) {
  return args.surface === 'library'
    ? args.persona === 'visitor' ? null : <RecordedMangaCollection persona={args.persona} loading={args.loading} />
    : <RecordedMangaWork persona={args.persona} surface={args.surface} />;
}

const meta = {
  title: 'Tracking/Manga collection recorded', component: RecordedMangaSurface,
  args: { persona: 'stranger', loading: false, surface: 'library' },
  globals: { viewport: { value: 'desktop' } },
  parameters: { layout: 'fullscreen', controls: { disable: true }, route: { pathname: '/en/library', query: { shelf: 'reading', view: 'grid' } } },
} satisfies Meta<typeof RecordedMangaSurface>;
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
  canvas.getByRole('heading', { level: 3, name: title(persona) }).scrollIntoView({ block: 'center' });
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

/** Controls and the selected panel must stay inside the Library card, not merely the viewport. */
async function contained(canvasElement: HTMLElement) {
  const progress = canvasElement.querySelector('[data-chapter-progress]')!;
  const card = progress.closest('details')!.getBoundingClientRect();
  for (const control of progress.querySelectorAll('button, input, [data-selected]')) {
    const box = control.getBoundingClientRect();
    await expect(box.width).toBeGreaterThan(0);
    await expect(box.left).toBeGreaterThanOrEqual(card.left);
    await expect(box.right).toBeLessThanOrEqual(card.right);
  }
}

/** Library opens the production Manga control, marks a chapter in volume two, then clears it. */
async function chapters(canvasElement: HTMLElement, persona: MangaLibraryPersona) {
  const canvas = await library(canvasElement, persona);
  const t = copyOf('en');
  const disclosure = canvas.getAllByText(t.workProgress, { exact: false, selector: 'summary' })
    .find(summary => summary.textContent?.includes(title(persona)));
  await expect(disclosure).toBeDefined();
  await userEvent.click(disclosure!);
  await expect(await canvas.findByText(t.lastRead({ place: 'Volume 1, chapter 2' }))).toBeVisible();
  for (const name of ['Volume 1, chapter 1', 'Volume 1, chapter 2', 'Volume 2, chapter 1', 'Volume 2, chapter 2']) {
    await expect(canvas.getByRole('button', { name })).toBeVisible();
  }
  await contained(canvasElement);
  await userEvent.click(canvas.getByRole('button', { name: 'Volume 2, chapter 1' }));
  await userEvent.click(await canvas.findByRole('button', { name: t.markChapterRead }));
  await expect(await canvas.findByText(t.lastRead({ place: 'Volume 2, chapter 1' }))).toBeVisible();
  await userEvent.click(await canvas.findByRole('button', { name: t.markChapterUnread }));
  await expect(await canvas.findByText(t.lastRead({ place: 'Volume 1, chapter 2' }))).toBeVisible();
  await expect(canvas.getByRole('button', { name: t.markChapterRead })).toBeVisible();
  await contained(canvasElement);
  await expect(canvas.queryByRole('alert')).toBeNull();
  await expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(window.innerWidth);
}
export const ChaptersAcrossVolumes: Story = { play: async ({ canvasElement }) => { await chapters(canvasElement, 'stranger'); } };
export const ChaptersAcrossVolumesPhone: Story = { ...ChaptersAcrossVolumes, ...phone };
export const MemberChapters: Story = { args: { persona: 'member' }, play: async ({ canvasElement }) => { await chapters(canvasElement, 'member'); } };
export const MemberChaptersPhone: Story = { ...MemberChapters, ...phone };
export const OwnerChapters: Story = { args: { persona: 'owner' }, play: async ({ canvasElement }) => { await chapters(canvasElement, 'owner'); } };
export const OwnerChaptersPhone: Story = { ...OwnerChapters, ...phone };
export const ModeratorChapters: Story = { args: { persona: 'moderator' }, play: async ({ canvasElement }) => { await chapters(canvasElement, 'moderator'); } };
export const ModeratorChaptersPhone: Story = { ...ModeratorChapters, ...phone };
export const OperatorChapters: Story = { args: { persona: 'operator' }, play: async ({ canvasElement }) => { await chapters(canvasElement, 'operator'); } };
export const OperatorChaptersPhone: Story = { ...OperatorChapters, ...phone };

/** The production shelf control confirms a reader's own status before the route refresh completes. */
async function statusChange(canvasElement: HTMLElement, persona: MangaLibraryPersona) {
  const canvas = await library(canvasElement, persona);
  const t = materializeData(catalogueMessages.en, { locale: 'en' });
  const libraryCopy = materializeData(libraryMessages, { locale: 'en' });
  await userEvent.click(canvas.getByRole('button', { name: `${t.shelve({ title: title(persona) })} · ${t.reading}` }));
  await chooseMenuItem(within(document.body), 'menuitemradio', t.read);
  await expect(await canvas.findByRole('button', { name: `${t.shelve({ title: title(persona) })} · ${t.read}` })).toBeVisible();
  await expect(await canvas.findByText(libraryCopy.movedOne({ title: title(persona), shelf: libraryCopy.read }))).toBeVisible();
  await expect(canvas.queryByRole('alert')).toBeNull();
}
export const StrangerStatus: Story = { play: async ({ canvasElement }) => { await statusChange(canvasElement, 'stranger'); } };
export const StrangerStatusPhone: Story = { ...StrangerStatus, ...phone };
export const MemberStatus: Story = { args: { persona: 'member' }, play: async ({ canvasElement }) => { await statusChange(canvasElement, 'member'); } };
export const MemberStatusPhone: Story = { ...MemberStatus, ...phone };
export const OwnerStatus: Story = { args: { persona: 'owner' }, play: async ({ canvasElement }) => { await statusChange(canvasElement, 'owner'); } };
export const OwnerStatusPhone: Story = { ...OwnerStatus, ...phone };
export const ModeratorStatus: Story = { args: { persona: 'moderator' }, play: async ({ canvasElement }) => { await statusChange(canvasElement, 'moderator'); } };
export const ModeratorStatusPhone: Story = { ...ModeratorStatus, ...phone };
export const OperatorStatus: Story = { args: { persona: 'operator' }, play: async ({ canvasElement }) => { await statusChange(canvasElement, 'operator'); } };
export const OperatorStatusPhone: Story = { ...OperatorStatus, ...phone };

/** The actual overview and frame use the persona client, including streamed credit and supporting reads. */
async function workOverview(canvasElement: HTMLElement, persona: AnswerPersona) {
  const canvas = within(canvasElement);
  await expect(await canvas.findByRole('heading', { level: 1, name: title(persona) })).toBeVisible();
  await expect(canvas.getByText(persona === 'visitor' ? persona : `${persona} · ${subject(persona)}`, { exact: true })).toBeVisible();
  const credits = mangaCollectionSample(record, persona, 'work-agent-credits-1').answer as { items: { displayName: string }[] };
  for (const credit of credits.items) {
    await expect((await canvas.findAllByRole('link', { name: credit.displayName }))[0]).toBeVisible();
  }
  await expect(await canvas.findByRole('heading', { name: 'About' })).toBeVisible();
  const copy = materializeData(catalogueMessages.en, { locale: 'en' });
  if (persona === 'visitor') {
    const refusal = canvas.getByRole('link', { name: `${copy.wantToRead} — ${copy.signInToShelve}` });
    await expect(refusal).toHaveAttribute('href', expect.stringContaining('/auth/start'));
  } else {
    await expect(canvas.getByRole('button', { name: `${copy.reading} — ${copy.shelve({ title: title(persona) })}` })).toBeVisible();
    await expect(await canvas.findByText(copyOf('en').lastRead({ place: 'Volume 1, chapter 2' }))).toBeVisible();
  }
  await document.fonts.ready;
  await expect(canvas.queryByRole('alert')).toBeNull();
  await expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(window.innerWidth);
  canvas.getByRole('heading', { level: 1, name: title(persona) }).scrollIntoView({ block: 'start' });
}
const overview = (persona: AnswerPersona): Story => ({ args: { persona, surface: 'work-overview' },
  play: async ({ canvasElement }) => { await workOverview(canvasElement, persona); } });
export const VisitorWork = overview('visitor');
export const VisitorWorkPhone: Story = { ...VisitorWork, ...phone };
export const StrangerWork = overview('stranger');
export const StrangerWorkPhone: Story = { ...StrangerWork, ...phone };
export const MemberWork = overview('member');
export const MemberWorkPhone: Story = { ...MemberWork, ...phone };
export const OwnerWork = overview('owner');
export const OwnerWorkPhone: Story = { ...OwnerWork, ...phone };
export const ModeratorWork = overview('moderator');
export const ModeratorWorkPhone: Story = { ...ModeratorWork, ...phone };
export const OperatorWork = overview('operator');
export const OperatorWorkPhone: Story = { ...OperatorWork, ...phone };

async function inventory(canvasElement: HTMLElement, surface: MangaWorkSurface) {
  const canvas = within(canvasElement);
  const header = mangaCollectionSample(record, 'visitor', `${surface}-1`).answer as { title: { value: string } };
  await expect(await canvas.findByRole('heading', { level: 1, name: header.title.value })).toBeVisible();
  const sample = record.personas.visitor.find(item => item.label.startsWith(`${surface}-`) &&
    new URL(item.path, 'https://recorded.invalid').pathname.endsWith('/contents'))!;
  const contents = sample.answer as { items: { label: { value: string } | null; displayLabel?: string; number: string | null }[] };
  for (const item of contents.items) {
    const name = item.label?.value ?? item.displayLabel ?? `Chapter ${item.number}`;
    await expect(canvas.getByRole('link', { name })).toBeVisible();
  }
  const copy = materializeData(catalogueMessages.en, { locale: 'en' });
  await expect(canvas.getByRole('link', { name: `${copy.wantToRead} — ${copy.signInToShelve}` }))
    .toHaveAttribute('href', expect.stringContaining('/auth/start'));
  await expect(canvas.queryByRole('alert')).toBeNull();
  await document.fonts.ready;
  await expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(window.innerWidth);
}
const publicInventory = (surface: MangaWorkSurface): Story => ({ args: { persona: 'visitor', surface },
  play: async ({ canvasElement }) => { await inventory(canvasElement, surface); } });
export const VisitorVolumes = publicInventory('inventory-series');
export const VisitorVolumesPhone: Story = { ...VisitorVolumes, ...phone };
export const VisitorVolumeOneChapters = publicInventory('inventory-volume1');
export const VisitorVolumeOneChaptersPhone: Story = { ...VisitorVolumeOneChapters, ...phone };
export const VisitorVolumeTwoChapters = publicInventory('inventory-volume2');
export const VisitorVolumeTwoChaptersPhone: Story = { ...VisitorVolumeTwoChapters, ...phone };
