import { useEffect, useState } from 'react';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, waitFor, within } from 'storybook/test';
import { materializeData } from 'native-i18n';
import type { AnswerPersona, AnswerRecord } from '../../../../scripts/api/answer-record.ts';
import collectionRecord from '../../../../tests/qa/fixtures/outcomes/anime/collection-tracking-and-progress.json';
import { BFF_PREFIX, browserMainApi } from '../api/browser.ts';
import { messages as catalogueMessages } from '../catalogue/messages.ts';
import type { MainClient } from '../discover/types.ts';
import { messages as libraryMessages } from '../library/messages.ts';
import { recordedFetch, type RecordedSelection } from '../stories/recorded-fetch.ts';
import { messages as workMessages } from '../work-page/messages.ts';
import { AnimeCollectionRecordedPage, librarySignInHref, workSignInHref } from './anime-collection-recorded-page.tsx';
import { copyOf } from './messages.ts';

const record = collectionRecord as unknown as AnswerRecord;
type Persona = 'visitor' | 'stranger' | 'member' | 'owner' | 'moderator' | 'operator';
type Mode = 'page' | 'watched' | 'clear' | 'library' | 'loading';
interface Args { persona: Persona; mode: Mode }
const signedIn = ['stranger', 'member', 'owner', 'moderator', 'operator'] as const;

function sample(persona: AnswerPersona, label: string) {
  const found = record.personas[persona].find(item => item.label === label);
  if (!found) throw new Error(`missing recorded sample ${persona}/${label}`);
  return found;
}

function workOf(persona: Persona) {
  const work = (sample(persona, 'episode-opening-page').answer as { work?: string }).work;
  if (!work) throw new Error(`recorded opening names no Work for ${persona}`);
  return work;
}

function subjectOf(persona: Persona) {
  if (persona === 'visitor') return undefined;
  return new URL(sample(persona, 'episode-opening-page').path, 'https://recorded.invalid').searchParams.get('actingSubject')
    ?? undefined;
}

function titleOf(persona: Persona) {
  const title = (sample(persona, 'work-header').answer as { title?: { value?: string } }).title?.value;
  if (!title) throw new Error(`recorded Work names no title for ${persona}`);
  return title;
}

function creditOf(persona: Persona) {
  const items = (sample(persona, 'work-agent-credits').answer as { items?: { role?: string; displayName?: string }[] }).items ?? [];
  const name = items.find(item => item.role === 'author')?.displayName;
  if (!name) throw new Error(`recorded credit names no author for ${persona}`);
  return name;
}

function resumeLabel(persona: Persona, label: string) {
  const place = (sample(persona, label).answer as { items?: { displayLabel?: string }[] }).items?.[0]?.displayLabel;
  if (!place) throw new Error(`recorded resume names no episode for ${persona}/${label}`);
  return place;
}

function episodeNumber(persona: Persona, label: string) {
  const position = (sample(persona, label).body as { position?: string }).position;
  const number = position ? /^episode:(\d+)$/.exec(position)?.[1] : undefined;
  if (!number) throw new Error(`recorded progress names no episode for ${persona}/${label}`);
  return number;
}

function shelfTitle(persona: Persona) {
  const title = (sample(persona, 'library-watching-shelf').answer as { items?: { card?: { title?: { value?: string } } }[] })
    .items?.[0]?.card?.title?.value;
  if (!title) throw new Error(`recorded shelf names no Work for ${persona}`);
  return title;
}

function workSelections(persona: Persona, mode: Mode): RecordedSelection[] {
  const resume = mode === 'watched' ? 'watched-episode-resume'
    : mode === 'clear' ? 'cleared-episode-resume' : 'work-episode-resume';
  const selections: RecordedSelection[] = [
    { label: 'work-header', state: 'populated' },
    { label: 'work-reader-state', state: 'populated' },
    { label: 'work-agent-credits', state: 'populated' },
    { label: 'work-credits-query', state: 'populated' },
    { label: 'work-episode-structure', state: 'populated' },
    { label: 'work-episode-page', state: 'populated' },
    { label: resume, state: 'populated' },
    { label: 'panel-edition-preference', state: 'empty' },
    { label: 'panel-realizations', state: 'populated' },
    { label: 'panel-releases', state: 'populated' },
    { label: 'panel-relations', state: 'populated' },
    { label: 'panel-equivalence-definition', state: 'error' },
    { label: 'panel-series-progress', state: 'populated' },
  ];
  if (mode === 'page') selections.push(
    { label: 'status-control-write', state: 'populated' },
    { label: 'episode-watched-before-write', state: 'populated' },
    { label: 'episode-watched-write', state: 'populated' },
  );
  if (mode === 'clear') selections.push(
    { label: 'episode-cleared-before-write', state: 'populated' },
    { label: 'episode-cleared-write', state: 'populated' },
  );
  return selections;
}

function selectionsFor(persona: Persona, mode: Mode): RecordedSelection[] {
  if (mode === 'loading') return [{ label: persona === 'visitor' ? 'episode-opening-page' : 'work-header', state: 'loading' }];
  if (persona === 'visitor') return [{ label: 'episode-opening-page', state: 'populated' }];
  if (mode === 'library') return [
    { label: 'library-production-custom-shelves', state: 'populated' },
    { label: 'library-visibility', state: 'populated' },
    { label: 'library-rating-context', state: 'populated' },
    { label: 'library-yearly-goal', state: 'populated' },
    { label: 'library-reading-year', state: 'populated' },
    { label: 'library-watching-shelf', state: 'populated' },
    { label: 'library-work-states', state: 'populated' },
    { label: 'library-work-1-continue', state: 'populated' },
  ];
  return workSelections(persona, mode);
}

function RecordedAnimeCollection({ persona, mode }: Args) {
  const [client, setClient] = useState<{ main: MainClient; actingSubject?: string; work: string } | null>(null);
  const [fault, setFault] = useState<string | null>(null);
  useEffect(() => {
    setClient(null);
    setFault(null);
    const replay = recordedFetch(record, persona, selectionsFor(persona, mode), { pathPrefix: BFF_PREFIX });
    let mounted = true;
    const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
      try { return await replay.fetcher(input, init); }
      catch (error) {
        if (mounted && !(error instanceof DOMException && error.name === 'AbortError')) setFault(String(error));
        throw error;
      }
    }) as typeof fetch;
    setClient({
      main: browserMainApi(window.location.origin, { anonymous: persona === 'visitor', fetcher }),
      actingSubject: subjectOf(persona),
      work: workOf(persona),
    });
    return () => { mounted = false; replay.dispose(); };
  }, [persona, mode]);
  if (fault) return <pre role="alert" className="whitespace-pre-wrap break-words p-6">{fault}</pre>;
  if (!client) return <p role="status" aria-busy="true" className="p-6">{materializeData(workMessages.en, { locale: 'en' }).loading}</p>;
  const surface = mode === 'library' ? 'library' : mode === 'loading' ? 'loading' : 'page';
  return <AnimeCollectionRecordedPage persona={persona} locale="en" mode={surface} {...client} />;
}

const meta = {
  title: 'Tracking/Anime collection recorded',
  component: RecordedAnimeCollection,
  args: { persona: 'visitor' as const, mode: 'page' as const },
  parameters: { controls: { disable: true } },
} satisfies Meta<typeof RecordedAnimeCollection>;
export default meta;
type Story = StoryObj<typeof meta>;

const phone = { viewport: { value: 'phone' } } as const;
const desktop = { viewport: { value: 'desktop' } } as const;
const tracking = copyOf('en');
const catalogue = materializeData(catalogueMessages.en, { locale: 'en' });
const workPage = materializeData(workMessages.en, { locale: 'en' });

async function fits(canvasElement: HTMLElement) {
  await document.fonts.ready;
  await expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(window.innerWidth);
}

async function choose(name: string | RegExp) {
  const item = await within(document.body).findByRole('menuitemradio', { name });
  await waitFor(() => expect(item.closest('[data-part=content]')).toHaveFocus());
  for (let step = 0; step < 8 && !item.hasAttribute('data-highlighted'); step++) await userEvent.keyboard('{ArrowDown}');
  await expect(item).toHaveAttribute('data-highlighted');
  await userEvent.keyboard('{Enter}');
}

async function expectTracking(canvasElement: HTMLElement, persona: Persona, mode: Mode) {
  const canvas = within(canvasElement);
  await expect(canvas.findByText(`${persona} · ${subjectOf(persona) ?? 'none'}`)).resolves.toBeVisible();
  if (mode === 'loading') {
    await expect(canvas.findByRole('status')).resolves.toHaveTextContent(workPage.loading);
    await expect(canvas.queryByRole('heading', { level: 1 })).toBeNull();
    await fits(canvasElement);
    return;
  }
  if (persona === 'visitor') {
    await expect(canvas.findByText(workOf(persona))).resolves.toBeVisible();
    const link = await canvas.findByRole('link', { name: new RegExp(catalogue.wantToRead) });
    await expect(link).toHaveAttribute('href', workSignInHref(workOf(persona).slice(-36), 'en'));
    await expect(canvas.getByRole('link', { name: libraryMessages.title })).toHaveAttribute('href', librarySignInHref('en'));
    await expect(canvas.queryByRole('button', { name: new RegExp(catalogue.reading) })).toBeNull();
    await fits(canvasElement);
    return;
  }
  if (mode === 'library') {
    await expect(canvas.findByRole('heading', { level: 1, name: libraryMessages.title })).resolves.toBeVisible();
    await expect(canvas.findByRole('link', { name: shelfTitle(persona) })).resolves.toBeVisible();
    await expect(canvas.queryByRole('alert')).toBeNull();
    await fits(canvasElement);
    return;
  }
  await expect(canvas.findByRole('heading', { level: 1, name: titleOf(persona) })).resolves.toBeVisible();
  await expect(canvas.findByText(creditOf(persona))).resolves.toBeVisible();
  const resume = mode === 'watched' ? 'watched-episode-resume' : mode === 'clear' ? 'cleared-episode-resume' : 'work-episode-resume';
  await expect(canvas.findByText(tracking.lastWatched({ place: resumeLabel(persona, resume) }))).resolves.toBeVisible();
  if (mode === 'watched') {
    await expect(canvas.queryByRole('alert')).toBeNull();
    await fits(canvasElement);
    return;
  }
  if (mode === 'page') {
    await userEvent.click(await canvas.findByRole('button', { name: new RegExp(catalogue.reading) }));
    await choose(catalogue.wantToRead);
    await expect(canvas.findByRole('button', { name: new RegExp(catalogue.wantToRead) })).resolves.toBeVisible();
  }
  const number = episodeNumber(persona, mode === 'clear' ? 'episode-cleared-write' : 'episode-watched-write');
  await userEvent.type(await canvas.findByRole('textbox', { name: tracking.jumpTo }), number);
  await userEvent.click(canvas.getByRole('button', { name: tracking.jumpGo }));
  const mark = mode === 'clear' ? tracking.markNotWatched : tracking.markWatched;
  await userEvent.click(await canvas.findByRole('button', { name: mark }));
  const saved = mode === 'clear' ? tracking.markWatched : tracking.markNotWatched;
  await expect(canvas.findByRole('button', { name: saved })).resolves.toBeEnabled();
  await expect(canvas.queryByRole('alert')).toBeNull();
  await expect(canvas.queryByText(tracking.saveFailed)).toBeNull();
  await fits(canvasElement);
}

function story(persona: Persona, mode: Mode, viewport: 'phone' | 'desktop'): Story {
  return {
    args: { persona, mode },
    globals: viewport === 'phone' ? phone : desktop,
    play: async ({ canvasElement }) => { await expectTracking(canvasElement, persona, mode); },
  };
}

export const VisitorPhone: Story = story('visitor', 'page', 'phone');
export const VisitorDesktop: Story = story('visitor', 'page', 'desktop');
export const VisitorLoadingPhone: Story = story('visitor', 'loading', 'phone');
export const VisitorLoadingDesktop: Story = story('visitor', 'loading', 'desktop');

export const StrangerPagePhone: Story = story('stranger', 'page', 'phone');
export const StrangerPageDesktop: Story = story('stranger', 'page', 'desktop');
export const StrangerWatchedPhone: Story = story('stranger', 'watched', 'phone');
export const StrangerWatchedDesktop: Story = story('stranger', 'watched', 'desktop');
export const StrangerClearPhone: Story = story('stranger', 'clear', 'phone');
export const StrangerClearDesktop: Story = story('stranger', 'clear', 'desktop');
export const StrangerLibraryPhone: Story = story('stranger', 'library', 'phone');
export const StrangerLibraryDesktop: Story = story('stranger', 'library', 'desktop');
export const StrangerLoadingPhone: Story = story('stranger', 'loading', 'phone');
export const StrangerLoadingDesktop: Story = story('stranger', 'loading', 'desktop');

export const MemberPagePhone: Story = story('member', 'page', 'phone');
export const MemberPageDesktop: Story = story('member', 'page', 'desktop');
export const MemberWatchedPhone: Story = story('member', 'watched', 'phone');
export const MemberWatchedDesktop: Story = story('member', 'watched', 'desktop');
export const MemberClearPhone: Story = story('member', 'clear', 'phone');
export const MemberClearDesktop: Story = story('member', 'clear', 'desktop');
export const MemberLibraryPhone: Story = story('member', 'library', 'phone');
export const MemberLibraryDesktop: Story = story('member', 'library', 'desktop');
export const MemberLoadingPhone: Story = story('member', 'loading', 'phone');
export const MemberLoadingDesktop: Story = story('member', 'loading', 'desktop');

export const OwnerPagePhone: Story = story('owner', 'page', 'phone');
export const OwnerPageDesktop: Story = story('owner', 'page', 'desktop');
export const OwnerWatchedPhone: Story = story('owner', 'watched', 'phone');
export const OwnerWatchedDesktop: Story = story('owner', 'watched', 'desktop');
export const OwnerClearPhone: Story = story('owner', 'clear', 'phone');
export const OwnerClearDesktop: Story = story('owner', 'clear', 'desktop');
export const OwnerLibraryPhone: Story = story('owner', 'library', 'phone');
export const OwnerLibraryDesktop: Story = story('owner', 'library', 'desktop');
export const OwnerLoadingPhone: Story = story('owner', 'loading', 'phone');
export const OwnerLoadingDesktop: Story = story('owner', 'loading', 'desktop');

export const ModeratorPagePhone: Story = story('moderator', 'page', 'phone');
export const ModeratorPageDesktop: Story = story('moderator', 'page', 'desktop');
export const ModeratorWatchedPhone: Story = story('moderator', 'watched', 'phone');
export const ModeratorWatchedDesktop: Story = story('moderator', 'watched', 'desktop');
export const ModeratorClearPhone: Story = story('moderator', 'clear', 'phone');
export const ModeratorClearDesktop: Story = story('moderator', 'clear', 'desktop');
export const ModeratorLibraryPhone: Story = story('moderator', 'library', 'phone');
export const ModeratorLibraryDesktop: Story = story('moderator', 'library', 'desktop');
export const ModeratorLoadingPhone: Story = story('moderator', 'loading', 'phone');
export const ModeratorLoadingDesktop: Story = story('moderator', 'loading', 'desktop');

export const OperatorPagePhone: Story = story('operator', 'page', 'phone');
export const OperatorPageDesktop: Story = story('operator', 'page', 'desktop');
export const OperatorWatchedPhone: Story = story('operator', 'watched', 'phone');
export const OperatorWatchedDesktop: Story = story('operator', 'watched', 'desktop');
export const OperatorClearPhone: Story = story('operator', 'clear', 'phone');
export const OperatorClearDesktop: Story = story('operator', 'clear', 'desktop');
export const OperatorLibraryPhone: Story = story('operator', 'library', 'phone');
export const OperatorLibraryDesktop: Story = story('operator', 'library', 'desktop');
export const OperatorLoadingPhone: Story = story('operator', 'loading', 'phone');
export const OperatorLoadingDesktop: Story = story('operator', 'loading', 'desktop');
