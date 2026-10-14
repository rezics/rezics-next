import { useEffect, useState } from 'react';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, within } from 'storybook/test';
import type { AnswerPersona } from '../../../../scripts/api/answer-record.ts';
import type { UiLocale } from '../../i18n/define.ts';
import { BFF_PREFIX, browserMainApi } from '../api/browser.ts';
import { parts as partFixture, wholes as wholeFixture, relations as relationFixture, summary } from '../work-levels/fixtures.ts';
import { copyOf } from '../work-levels/messages.ts';
import { PartsPreviewView, ConnectionsPreviewView } from '../work-levels/previews.tsx';
import type { Names } from '../work-levels/types.ts';
import { readAnimeAgentCredits, readWorkParts, readWorkWholes, readWorkRelations } from './anime-hub-recorded-page.ts';
import { WorkCredits } from './credits.tsx';
import { agentCredits, noCredits, work } from './fixtures.ts';
import { messages } from './messages.ts';
import { RegionSkeleton } from './region.tsx';
import { WorkHeader } from './work-header.tsx';

const id = work.id.slice(-36);
const subjects: Record<AnswerPersona, string | undefined> = { visitor: undefined,
  stranger: 'https://rezics.com/id/00000000-0000-4000-8000-000000000020',
  member: 'https://rezics.com/id/00000000-0000-4000-8000-000000000021',
  owner: 'https://rezics.com/id/00000000-0000-4000-8000-000000000022',
  moderator: 'https://rezics.com/id/00000000-0000-4000-8000-000000000023',
  operator: 'https://rezics.com/id/00000000-0000-4000-8000-000000000024' };
if (!partFixture.ok || !wholeFixture.ok || !relationFixture.ok || !agentCredits.ok) throw new Error('Contract fixture missing');
const first = partFixture.data.parts[0]!;
const partPage = { ...partFixture.data, resource: work.id, parts: [first,
  { ...first, occurrence: partFixture.data.parts[1]!.occurrence, displayLabel: 'Second appearance' }], next: 'parts-continuation' };
const wholePage = { ...wholeFixture.data, resource: work.id };
const relations = { ...relationFixture.data, resource: work.id,
  items: relationFixture.data.items.map(item => ({ ...item,
    counterparts: item.counterparts.map((target, index) => target.status === 'available'
      ? { ...target, name: { ...target.name, value: `Seed counterpart ${index + 1}` } } : target) })) };
const names: Names = new Map([first.work!, ...wholePage.wholes.map(item => item.work)]
  .map((reference, index) => [reference, summary(reference, index ? 'Seed omnibus' : 'Repeated seed episode')]));
type Read = { parts: Awaited<ReturnType<typeof readWorkParts>>; wholes: Awaited<ReturnType<typeof readWorkWholes>>;
  relations: Awaited<ReturnType<typeof readWorkRelations>>; credits: Awaited<ReturnType<typeof readAnimeAgentCredits>> };
type State = 'populated' | 'empty' | 'error' | 'loading';
type Kind = 'anime' | 'manga' | 'visual-novel';

export const missingHubRelationStates = (Object.keys(subjects) as AnswerPersona[]).flatMap(persona =>
  ['parts', 'wholes', 'relations'].map(path => {
    const limit = path === 'parts' ? 7 : path === 'wholes' ? 3 : 20;
    const query = new URLSearchParams({ ...(subjects[persona] ? { actingSubject: subjects[persona]! } : {}), limit: String(limit) });
    const populated = path === 'parts' ? partPage : path === 'wholes' ? wholePage : relations;
    return { persona, request: `GET /v1/resources/${id}/${path}?${query}`,
      row: 'anime/anime-manga-and-vn-hub-parts-wholes-and-relations',
      states: { populated: { status: 200, body: populated }, empty: { status: 200,
        body: { ...populated, [path === 'relations' ? 'items' : path]: [], next: null } },
      error: { status: 503, body: { status: 503, code: 'read_unavailable', title: 'Read unavailable',
        detail: 'Contract state, not a captured answer' } } } };
  }));

/** Unrecorded contract states, using the bounded production hub readers and previews. No permission is inferred from a persona name. */
function RelatedWorkHub({ persona, kind, locale, state }: { persona: AnswerPersona; kind: Kind; locale: UiLocale; state: State }) {
  const [view, setView] = useState<Read | null>(null);
  const [fault, setFault] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    setView(null); setFault(null);
    if (state === 'loading') return;
    const actingSubject = subjects[persona];
    const fetcher = (async (input: RequestInfo | URL) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      const path = url.pathname.replace(BFF_PREFIX, '');
      if (url.searchParams.get('actingSubject') !== (actingSubject ?? null)) throw new Error('Wrong hub reader identity');
      if (path.endsWith('/agent-credits')) return Response.json(agentCredits.ok ? agentCredits.data : null);
      if (state === 'error') return Response.json({ status: 503, code: 'read_unavailable', title: 'Read unavailable',
        detail: 'Contract state, not a captured answer' }, { status: 503 });
      if (path.endsWith('/parts') && url.searchParams.get('limit') === '7') return Response.json(state === 'empty'
        ? { ...partPage, parts: [], next: null } : partPage);
      if (path.endsWith('/wholes') && url.searchParams.get('limit') === '3') return Response.json(state === 'empty'
        ? { ...wholePage, wholes: [], next: null } : wholePage);
      if (path.endsWith('/relations') && url.searchParams.get('limit') === '20') return Response.json(state === 'empty'
        ? { ...relations, items: [], next: null } : relations);
      throw new Error(`Unlisted hub contract request ${path}`);
    }) as typeof fetch;
    const main = browserMainApi(window.location.origin, { anonymous: !actingSubject, fetcher });
    void Promise.all([readWorkParts(main, actingSubject, id, { limit: 7 }), readWorkWholes(main, actingSubject, id, { limit: 3 }),
      readWorkRelations(main, actingSubject, id, { limit: 20 }), readAnimeAgentCredits(main, actingSubject, id)])
      .then(([parts, wholes, relations, credits]) => { if (live) setView({ parts, wholes, relations, credits }); })
      .catch(error => { if (live) setFault(String(error)); });
    return () => { live = false; };
  }, [persona, state]);
  const type = kind === 'anime' ? 'https://schema.org/TVSeries' : kind === 'manga' ? 'https://schema.org/Book' : 'https://schema.org/VideoGame';
  const shown = { ...work, chapterCount: null, wordCount: null, completionStatus: null, lastUpdatedAt: null, types: [type], title: { ...work.title, value: `Seed islands ${kind}` } };
  const t = messages[locale];
  return <main className="mx-auto grid min-w-0 max-w-4xl gap-6 p-4 sm:p-8" lang={locale}>
    <p className="text-muted-foreground text-sm">Unrecorded contract state · {persona}</p>
    <WorkHeader work={shown} locale={locale} messages={t} credits={view
      ? <WorkCredits agentCredits={view.credits} credits={noCredits} locale={locale} messages={t} /> : null} />
    {fault ? <p role="alert">{fault}</p> : view ? <>
      <PartsPreviewView parts={view.parts} wholes={view.wholes} names={names} workRef={id} pageMessages={t} t={copyOf(locale)} />
      <ConnectionsPreviewView relations={view.relations} workRef={id} locale={locale} pageMessages={t} t={copyOf(locale)} />
    </> : <RegionSkeleton id="related-hub-loading" title={t.sectionParts} label={t.loadingRegion} />}
  </main>;
}
const meta = { title: 'Work page/Related production hubs contract (unrecorded)', component: RelatedWorkHub,
  args: { persona: 'visitor', kind: 'anime', locale: 'en', state: 'populated' },
  globals: { viewport: { value: 'desktop' } }, excludeStories: ['missingHubRelationStates'], parameters: { controls: { disable: true }, missingRecordedStates: missingHubRelationStates },
} satisfies Meta<typeof RelatedWorkHub>;
export default meta;
type Story = StoryObj<typeof meta>;
const populated: NonNullable<Story['play']> = async ({ canvasElement }) => {
  const canvas = within(canvasElement);
  await expect(canvas.findAllByText('Repeated seed episode')).resolves.toHaveLength(2);
  await expect(canvas.getByText('Seed omnibus')).toBeVisible();
  await expect(canvas.getByRole('link', { name: copyOf('en').allParts })).toBeVisible();
  await expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(window.innerWidth);
};
export const Anime: Story = { play: populated };
export const AnimePhone: Story = { ...Anime, globals: { viewport: { value: 'phone' } } };
export const Manga: Story = { args: { kind: 'manga' }, play: populated };
export const MangaPhone: Story = { ...Manga, globals: { viewport: { value: 'phone' } } };
export const VisualNovel: Story = { args: { kind: 'visual-novel' }, play: populated };
export const VisualNovelPhone: Story = { ...VisualNovel, globals: { viewport: { value: 'phone' } } };
export const Loading: Story = { args: { state: 'loading' } };
export const LoadingPhone: Story = { ...Loading, globals: { viewport: { value: 'phone' } } };
export const Empty: Story = { args: { state: 'empty' }, async play({ canvasElement }) {
  await within(canvasElement).findByRole('heading', { level: 1 });
  await expect(within(canvasElement).queryByRole('alert')).not.toBeInTheDocument();
} };
export const EmptyPhone: Story = { ...Empty, globals: { viewport: { value: 'phone' } } };
export const Unavailable: Story = { args: { state: 'error' }, async play({ canvasElement }) {
  await expect(within(canvasElement).findAllByRole('alert')).resolves.toHaveLength(3);
} };
export const UnavailablePhone: Story = { ...Unavailable, globals: { viewport: { value: 'phone' } } };
