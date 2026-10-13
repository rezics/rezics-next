import { useEffect, useState } from 'react';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, within } from 'storybook/test';
import { materializeData } from 'native-i18n';
import type { AnswerPersona, AnswerRecord } from '../../../../scripts/api/answer-record.ts';
import collectionRecord from '../../../../tests/qa/fixtures/outcomes/anime/collection-tracking-and-progress.json';
import { messages as catalogueMessages } from '../catalogue/messages.ts';
import { BFF_PREFIX, browserMainApi } from '../api/browser.ts';
import { PageContainer } from '../shell/page.tsx';
import { recordedFetch, type RecordedSelection } from '../stories/recorded-fetch.ts';
import { messages as workMessages } from '../work-page/messages.ts';
import { AnimeCollectionRecordedPage } from './anime-collection-recorded-page.tsx';
import {
  composeAnimeTracked, mapAnimeReaderStatus, putAnimeReaderStatus, readAnimeEpisodeProgress, readAnimeEpisodeResume,
  readerStatusBody, type AnimeCollectionView,
} from './anime-collection-recorded-page.ts';
import { copyOf } from './messages.ts';

const record = collectionRecord as unknown as AnswerRecord;
const signedIn = ['stranger', 'member', 'owner', 'moderator', 'operator'] as const;
type SignedIn = (typeof signedIn)[number];

function sample(persona: AnswerPersona, label: string) {
  const found = record.personas[persona].find(item => item.label === label);
  if (!found) throw new Error(`missing recorded sample ${persona}/${label}`);
  return found;
}

function resumeTarget(persona: SignedIn) {
  const url = new URL(sample(persona, 'resume-watching').path, 'https://recorded.invalid');
  const actingSubject = url.searchParams.get('actingSubject');
  const work = url.pathname.split('/').at(-1);
  if (!actingSubject || !work) throw new Error(`recorded resume names no reader for ${persona}`);
  return { actingSubject, work };
}

function progressTarget(persona: SignedIn) {
  const chosen = sample(persona, 'own-unstarted-episode');
  const url = new URL(chosen.path, 'https://recorded.invalid');
  const match = /\/compositions\/([^/]+)\/occurrences\/([^/]+)\/progress$/.exec(url.pathname);
  const actingSubject = url.searchParams.get('actingSubject');
  if (!match || !actingSubject) throw new Error(`recorded progress names no occurrence for ${persona}`);
  return { structure: match[1]!, occurrence: match[2]!, actingSubject };
}

function statusBody(persona: SignedIn) {
  const body = sample(persona, 'start-watching').body;
  if (!body || typeof body !== 'object') throw new Error(`recorded reader status has no body for ${persona}`);
  const value = body as Record<string, unknown>;
  if (value.status !== 'reading' && value.status !== 'want-to-read' && value.status !== 'read' && value.status !== null) {
    throw new Error(`recorded reader status is not the shelf write for ${persona}`);
  }
  if (typeof value.actingSubject !== 'string' || typeof value.expectedVersion !== 'number') {
    throw new Error(`recorded reader status names no reader for ${persona}`);
  }
  return readerStatusBody(value.actingSubject, value.expectedVersion, value.status);
}

function RecordedAnimeCollection({ persona, mode }: { persona: SignedIn; mode: 'tracked' | 'loading' }) {
  const { actingSubject, work } = resumeTarget(persona);
  const [view, setView] = useState<AnimeCollectionView>({ kind: 'loading', persona, actingPerson: actingSubject });
  useEffect(() => {
    const selections: RecordedSelection[] = mode === 'loading'
      ? [{ label: 'resume-watching', state: 'loading' }]
      : [
        { label: 'start-watching', state: 'populated' },
        { label: 'resume-watching', state: 'populated' },
        { label: 'own-unstarted-episode', state: 'populated' },
      ];
    const replay = recordedFetch(record, persona, selections, { pathPrefix: BFF_PREFIX });
    const main = browserMainApi(window.location.origin, { fetcher: replay.fetcher });
    let mounted = true;
    void (async () => {
      try {
        if (mode === 'loading') {
          await readAnimeEpisodeResume(main, actingSubject, work);
          return;
        }
        const body = statusBody(persona);
        if (body.actingSubject !== actingSubject) throw new Error(`recorded shelf write names another Person for ${persona}`);
        const episode = progressTarget(persona);
        if (episode.actingSubject !== actingSubject) throw new Error(`recorded progress names another Person for ${persona}`);
        const status = mapAnimeReaderStatus(await putAnimeReaderStatus(main, work, body, crypto.randomUUID()));
        const resume = await readAnimeEpisodeResume(main, actingSubject, work);
        const progress = await readAnimeEpisodeProgress(main, episode.actingSubject, episode);
        if (!mounted) return;
        const composed = composeAnimeTracked({ persona, actingPerson: actingSubject, status, resume, progress });
        if (composed.kind !== 'tracked') throw new Error(`recorded collection did not track ${persona}`);
        setView(composed);
      } catch (error: unknown) {
        if (!(error instanceof DOMException && error.name === 'AbortError')) throw error;
      }
    })();
    return () => { mounted = false; replay.dispose(); };
  }, [persona, mode, actingSubject, work]);
  return <PageContainer className="py-6">
    <AnimeCollectionRecordedPage view={view} locale="en" />
  </PageContainer>;
}

const meta = {
  title: 'Tracking/Anime collection recorded',
  component: RecordedAnimeCollection,
  args: { persona: 'member' as const, mode: 'tracked' as const },
  parameters: { controls: { disable: true } },
} satisfies Meta<typeof RecordedAnimeCollection>;
export default meta;
type Story = StoryObj<typeof meta>;

const phone = { viewport: { value: 'phone' } } as const;
const desktop = { viewport: { value: 'desktop' } } as const;
const tracking = copyOf('en');
const catalogue = materializeData(catalogueMessages.en, { locale: 'en' });
const workPage = materializeData(workMessages.en, { locale: 'en' });

function shelfPhrase(status: string) {
  if (status === 'reading') return catalogue.reading;
  if (status === 'want-to-read') return catalogue.wantToRead;
  if (status === 'read') return catalogue.read;
  throw new Error(`recorded status ${status} has no shelf label`);
}

async function expectTracked(canvasElement: HTMLElement, persona: SignedIn) {
  const canvas = within(canvasElement);
  const status = sample(persona, 'start-watching').answer as { status: string; version: number; replayed: boolean };
  const resume = sample(persona, 'resume-watching').answer as {
    work: string; items: { occurrence: string; displayLabel?: string }[];
  };
  const progress = sample(persona, 'own-unstarted-episode').answer as {
    occurrence: string; completed: boolean; version: number; position: string | null;
  };
  const place = resume.items[0]?.displayLabel;
  if (!place) throw new Error(`recorded resume names no episode for ${persona}`);
  await expect(canvas.findByRole('heading', { name: persona })).resolves.toBeVisible();
  await expect(canvas.findByText(resumeTarget(persona).actingSubject)).resolves.toBeVisible();
  await expect(canvas.findByText(shelfPhrase(status.status))).resolves.toBeVisible();
  await expect(canvas.findByText(String(status.version))).resolves.toBeVisible();
  await expect(canvas.findByText(tracking.lastWatched({ place }))).resolves.toBeVisible();
  await expect(canvas.findByText(resume.items[0]!.occurrence)).resolves.toBeVisible();
  await expect(canvas.findByText(resume.work)).resolves.toBeVisible();
  await expect(canvas.findByText(progress.completed ? tracking.watched : tracking.notWatched)).resolves.toBeVisible();
  await expect(canvas.findByText(progress.occurrence)).resolves.toBeVisible();
  await expect(canvas.findByText(String(progress.version))).resolves.toBeVisible();
  await expect(canvas.findByText(progress.position ?? tracking.notSet)).resolves.toBeVisible();
  expect(status.replayed).toBe(false);
  const root = canvasElement.ownerDocument.documentElement;
  await expect(root.scrollWidth).toBeLessThanOrEqual(root.clientWidth + 1);
}

async function expectLoading(canvasElement: HTMLElement, persona: SignedIn) {
  const canvas = within(canvasElement);
  const resume = sample(persona, 'resume-watching').answer as { items: { displayLabel?: string }[] };
  const place = resume.items[0]?.displayLabel;
  if (!place) throw new Error(`recorded resume names no episode for ${persona}`);
  await expect(canvas.findByRole('heading', { name: persona })).resolves.toBeVisible();
  await expect(canvas.findByText(resumeTarget(persona).actingSubject)).resolves.toBeVisible();
  await expect(canvas.findByRole('status')).resolves.toHaveTextContent(workPage.loadingRegion);
  await expect(canvas.queryByText(tracking.lastWatched({ place }))).toBeNull();
  await expect(canvas.queryByRole('heading', { name: tracking.episodes })).toBeNull();
}

function tracked(persona: SignedIn, viewport: 'phone' | 'desktop'): Story {
  return {
    args: { persona, mode: 'tracked' },
    globals: viewport === 'phone' ? phone : desktop,
    play: async ({ canvasElement }) => { await expectTracked(canvasElement, persona); },
  };
}

function loading(persona: SignedIn, viewport: 'phone' | 'desktop'): Story {
  return {
    args: { persona, mode: 'loading' },
    globals: viewport === 'phone' ? phone : desktop,
    play: async ({ canvasElement }) => { await expectLoading(canvasElement, persona); },
  };
}

export const StrangerTrackedPhone: Story = tracked('stranger', 'phone');
export const StrangerTrackedDesktop: Story = tracked('stranger', 'desktop');
export const StrangerLoadingPhone: Story = loading('stranger', 'phone');
export const StrangerLoadingDesktop: Story = loading('stranger', 'desktop');
export const MemberTrackedPhone: Story = tracked('member', 'phone');
export const MemberTrackedDesktop: Story = tracked('member', 'desktop');
export const MemberLoadingPhone: Story = loading('member', 'phone');
export const MemberLoadingDesktop: Story = loading('member', 'desktop');
export const OwnerTrackedPhone: Story = tracked('owner', 'phone');
export const OwnerTrackedDesktop: Story = tracked('owner', 'desktop');
export const OwnerLoadingPhone: Story = loading('owner', 'phone');
export const OwnerLoadingDesktop: Story = loading('owner', 'desktop');
export const ModeratorTrackedPhone: Story = tracked('moderator', 'phone');
export const ModeratorTrackedDesktop: Story = tracked('moderator', 'desktop');
export const ModeratorLoadingPhone: Story = loading('moderator', 'phone');
export const ModeratorLoadingDesktop: Story = loading('moderator', 'desktop');
export const OperatorTrackedPhone: Story = tracked('operator', 'phone');
export const OperatorTrackedDesktop: Story = tracked('operator', 'desktop');
export const OperatorLoadingPhone: Story = loading('operator', 'phone');
export const OperatorLoadingDesktop: Story = loading('operator', 'desktop');
