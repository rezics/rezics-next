import { useEffect, useState } from 'react';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, within } from 'storybook/test';
import { materializeData } from 'native-i18n';
import type { AnswerPersona, AnswerRecord } from '../../../../scripts/api/answer-record.ts';
import collectionRecord from '../../../../tests/qa/fixtures/outcomes/anime/collection-tracking-and-progress.json';
import { messages as catalogueMessages } from '../catalogue/messages.ts';
import { BFF_PREFIX, browserMainApi } from '../api/browser.ts';
import type { MainClient } from '../discover/types.ts';
import { messages as libraryMessages } from '../library/messages.ts';
import { recordedFetch, type RecordedSelection } from '../stories/recorded-fetch.ts';
import { messages as workMessages } from '../work-page/messages.ts';
import { AnimeCollectionRecordedPage, librarySignInHref, workSignInHref } from './anime-collection-recorded-page.tsx';
import { copyOf } from './messages.ts';

const record = collectionRecord as unknown as AnswerRecord;
type Persona = 'visitor' | 'stranger' | 'member' | 'owner' | 'moderator' | 'operator';
type Mode = 'tracking' | 'watched' | 'loading';
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

function selectionsFor(persona: Persona, mode: Mode): RecordedSelection[] {
  if (mode === 'loading') return [{ label: 'episode-opening-page', state: 'loading' }];
  if (persona === 'visitor') return [{ label: 'episode-opening-page', state: 'populated' }];
  const selections: RecordedSelection[] = [
    { label: 'episode-opening-page', state: 'populated' },
    { label: 'collection-reader-seed', state: 'populated' },
    { label: 'collection-custom-shelves', state: 'populated' },
    { label: 'collection-attempts', state: 'populated' },
    { label: 'collection-realizations', state: 'populated' },
    { label: 'collection-releases', state: 'populated' },
    { label: 'collection-edition-preference', state: 'empty' },
    { label: 'collection-relations', state: 'populated' },
    { label: 'collection-equivalence-definition', state: 'error' },
    { label: 'collection-series-progress', state: 'populated' },
    { label: 'episode-structure', state: 'populated' },
    { label: 'episode-structure-page', state: 'populated' },
    { label: mode === 'watched' ? 'resume-watching' : 'episode-resume-before-watching', state: 'populated' },
    { label: 'reader-state-before-watching', state: 'populated' },
    { label: 'start-watching', state: 'populated' },
  ];
  if (mode === 'tracking') selections.push({ label: 'episode-progress-before-completion', state: 'populated' });
  return selections;
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
  return <AnimeCollectionRecordedPage persona={persona} locale="en" mode={mode} {...client} />;
}

const meta = {
  title: 'Tracking/Anime collection recorded',
  component: RecordedAnimeCollection,
  args: { persona: 'visitor' as const, mode: 'tracking' as const },
  parameters: { controls: { disable: true } },
} satisfies Meta<typeof RecordedAnimeCollection>;
export default meta;
type Story = StoryObj<typeof meta>;

const phone = { viewport: { value: 'phone' } } as const;
const desktop = { viewport: { value: 'desktop' } } as const;
const tracking = copyOf('en');
const catalogue = materializeData(catalogueMessages.en, { locale: 'en' });
const workPage = materializeData(workMessages.en, { locale: 'en' });

function episodeLabel(persona: Persona) {
  const answer = sample(persona, 'episode-structure-page').answer as {
    occurrences: { role: string; qualifier?: { type?: string; displayLabel?: string } }[];
  };
  const label = answer.occurrences.find(item => item.role === 'part' && item.qualifier?.type === 'work-part')?.qualifier?.displayLabel;
  if (!label) throw new Error(`recorded inventory names no episode for ${persona}`);
  return label;
}

async function fits(canvasElement: HTMLElement) {
  await document.fonts.ready;
  await expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(window.innerWidth);
  for (const value of canvasElement.querySelectorAll<HTMLElement>('.break-all')) {
    await expect(value.scrollWidth).toBeLessThanOrEqual(value.clientWidth + 1);
  }
}

async function expectIdentity(canvas: ReturnType<typeof within>, persona: Persona) {
  await expect(canvas.findByText(`${persona} · ${subjectOf(persona) ?? 'none'}`)).resolves.toBeVisible();
  await expect(canvas.findByText(workOf(persona))).resolves.toBeVisible();
}

async function expectTracking(canvasElement: HTMLElement, persona: Persona, mode: Mode) {
  const canvas = within(canvasElement);
  await expectIdentity(canvas, persona);
  if (mode === 'loading') {
    await expect(canvas.findByRole('status')).resolves.toHaveTextContent(workPage.loading);
    await expect(canvas.queryByRole('button', { name: new RegExp(catalogue.reading) })).toBeNull();
    await expect(canvas.queryByRole('link', { name: libraryMessages.title })).toBeNull();
    await fits(canvasElement);
    return;
  }
  if (persona === 'visitor') {
    const link = await canvas.findByRole('link', { name: new RegExp(catalogue.wantToRead) });
    await expect(link).toHaveAttribute('href', workSignInHref(workOf(persona).slice(-36), 'en'));
    await expect(canvas.getByRole('link', { name: libraryMessages.title })).toHaveAttribute('href', librarySignInHref('en'));
    await expect(canvas.queryByRole('button', { name: new RegExp(catalogue.reading) })).toBeNull();
    await fits(canvasElement);
    return;
  }
  await expect(canvas.findByRole('button', { name: new RegExp(catalogue.reading) })).resolves.toBeVisible();
  if (mode === 'watched') {
    const place = (sample(persona, 'resume-watching').answer as { items: { displayLabel?: string }[] }).items[0]?.displayLabel;
    if (!place) throw new Error(`recorded resume names no episode for ${persona}`);
    await expect(canvas.findByText(tracking.lastWatched({ place }))).resolves.toBeVisible();
    await expect(canvas.queryByText(tracking.notWatched)).toBeNull();
  } else {
    // "Unknown" is also the inventory's pending line, before the jump field exists.
    await expect(canvas.findByRole('textbox', { name: tracking.jumpTo })).resolves.toBeVisible();
    await expect(canvas.getByText(tracking.unknown)).toBeVisible();
    await userEvent.type(canvas.getByRole('textbox', { name: tracking.jumpTo }), '1');
    await userEvent.click(canvas.getByRole('button', { name: tracking.jumpGo }));
    const open = await canvas.findByText((_content, element) => element?.getAttribute('data-state') === 'open');
    await expect(open).toHaveTextContent(tracking.notWatched);
    await expect(open.closest('[data-selected]')).toHaveTextContent(episodeLabel(persona));
    const progress = sample(persona, 'episode-progress-before-completion').answer as { completed: boolean; position: null };
    await expect(progress.completed).toBe(false);
    await expect(progress.position).toBeNull();
  }
  const status = sample(persona, 'start-watching').answer as { status: string; version: number; replayed: boolean };
  await expect(status.status).toBe('reading');
  await expect(status.version).toBe(1);
  await expect(status.replayed).toBe(false);
  await fits(canvasElement);
}

function story(persona: Persona, mode: Mode, viewport: 'phone' | 'desktop'): Story {
  return {
    args: { persona, mode },
    globals: viewport === 'phone' ? phone : desktop,
    play: async ({ canvasElement }) => { await expectTracking(canvasElement, persona, mode); },
  };
}

export const VisitorPhone: Story = story('visitor', 'tracking', 'phone');
export const VisitorDesktop: Story = story('visitor', 'tracking', 'desktop');
export const VisitorLoadingPhone: Story = story('visitor', 'loading', 'phone');
export const VisitorLoadingDesktop: Story = story('visitor', 'loading', 'desktop');

export const StrangerTrackedPhone: Story = story('stranger', 'tracking', 'phone');
export const StrangerTrackedDesktop: Story = story('stranger', 'tracking', 'desktop');
export const StrangerWatchedPhone: Story = story('stranger', 'watched', 'phone');
export const StrangerWatchedDesktop: Story = story('stranger', 'watched', 'desktop');
export const StrangerLoadingPhone: Story = story('stranger', 'loading', 'phone');
export const StrangerLoadingDesktop: Story = story('stranger', 'loading', 'desktop');

export const MemberTrackedPhone: Story = story('member', 'tracking', 'phone');
export const MemberTrackedDesktop: Story = story('member', 'tracking', 'desktop');
export const MemberWatchedPhone: Story = story('member', 'watched', 'phone');
export const MemberWatchedDesktop: Story = story('member', 'watched', 'desktop');
export const MemberLoadingPhone: Story = story('member', 'loading', 'phone');
export const MemberLoadingDesktop: Story = story('member', 'loading', 'desktop');

export const OwnerTrackedPhone: Story = story('owner', 'tracking', 'phone');
export const OwnerTrackedDesktop: Story = story('owner', 'tracking', 'desktop');
export const OwnerWatchedPhone: Story = story('owner', 'watched', 'phone');
export const OwnerWatchedDesktop: Story = story('owner', 'watched', 'desktop');
export const OwnerLoadingPhone: Story = story('owner', 'loading', 'phone');
export const OwnerLoadingDesktop: Story = story('owner', 'loading', 'desktop');

export const ModeratorTrackedPhone: Story = story('moderator', 'tracking', 'phone');
export const ModeratorTrackedDesktop: Story = story('moderator', 'tracking', 'desktop');
export const ModeratorWatchedPhone: Story = story('moderator', 'watched', 'phone');
export const ModeratorWatchedDesktop: Story = story('moderator', 'watched', 'desktop');
export const ModeratorLoadingPhone: Story = story('moderator', 'loading', 'phone');
export const ModeratorLoadingDesktop: Story = story('moderator', 'loading', 'desktop');

export const OperatorTrackedPhone: Story = story('operator', 'tracking', 'phone');
export const OperatorTrackedDesktop: Story = story('operator', 'tracking', 'desktop');
export const OperatorWatchedPhone: Story = story('operator', 'watched', 'phone');
export const OperatorWatchedDesktop: Story = story('operator', 'watched', 'desktop');
export const OperatorLoadingPhone: Story = story('operator', 'loading', 'phone');
export const OperatorLoadingDesktop: Story = story('operator', 'loading', 'desktop');
