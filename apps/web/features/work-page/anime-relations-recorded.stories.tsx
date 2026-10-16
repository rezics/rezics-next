import { useEffect, useState } from 'react';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, waitFor, within } from 'storybook/test';
import type { AnswerPersona, AnswerRecord } from '../../../../scripts/api/answer-record.ts';
import answers from '../../../../tests/qa/fixtures/outcomes/anime/anime-manga-and-vn-hub-parts-wholes-and-relations.json';
import type { UiLocale } from '../../i18n/define.ts';
import { localizedPath } from '../../i18n/locale.ts';
import { BFF_PREFIX, browserMainApi } from '../api/browser.ts';
import { seedTypes, type TypeRegistry } from '../catalogue/types.ts';
import type { MainClient } from '../discover/types.ts';
import { recordedFetch } from '../stories/recorded-fetch.ts';
import { messages as relationshipMessages } from '../relationships/messages.ts';
import { copyOf } from '../work-levels/messages.ts';
import { connectionsHref } from '../work-levels/route.ts';
import { AnimeRelationsRecordedPage, type AnimeRelationsView } from './anime-relations-recorded-page.client.tsx';
import { recordedAnimeRelationsVisit } from './anime-relations-recorded-page.ts';
import { messages } from './messages.ts';
import type { WorkHeader } from './types.ts';
import { workHref } from './route.ts';

const record = answers as AnswerRecord;
interface Args { persona: AnswerPersona; entry: number; view: AnimeRelationsView; loading: boolean; locale: UiLocale }
function RecordedVisit({ persona, entry, view, loading, locale }: Args) {
  const [client, setClient] = useState<{ main: MainClient; fetcher: typeof fetch; actingSubject?: string; id: string } | null>(null);
  const [fault, setFault] = useState<string | null>(null);
  useEffect(() => {
    let mounted = true;
    setClient(null);
    setFault(null);
    const visit = recordedAnimeRelationsVisit(record, persona, entry, loading);
    // The locale layout seeds this same served registry before its frame renders.
    const registry = record.personas[persona].find(sample => sample.label.startsWith(`visit-${entry}-`) && sample.path === '/v1/types');
    if (!registry) throw new Error('The visit lacks its served type registry');
    seedTypes(registry.answer as TypeRegistry);
    const replay = recordedFetch(record, persona, visit.selections, { pathPrefix: BFF_PREFIX });
    const fetcher = (async (...args: Parameters<typeof fetch>) => {
      try { return await replay.fetcher(...args); }
      catch (error) {
        if (mounted && !(error instanceof DOMException && error.name === 'AbortError')) setFault(String(error));
        throw error;
      }
    }) as typeof fetch;
    setClient({ main: browserMainApi('http://record.invalid', { anonymous: persona === 'visitor', fetcher }),
      fetcher, actingSubject: visit.actingSubject, id: visit.id });
    return () => { mounted = false; replay.dispose(); };
  }, [persona, entry, loading]);
  const selected = recordedAnimeRelationsVisit(record, persona, entry);
  return <div lang={locale} className="min-w-0">
    <p className="break-all px-4 py-3 text-muted-foreground text-sm">{persona} · {selected.actingSubject ?? 'none'}</p>
    {fault ? <pre role="alert" className="whitespace-pre-wrap break-words">{fault}</pre> : null}
    {client ? <AnimeRelationsRecordedPage {...client} view={view} locale={locale} /> : null}
  </div>;
}
const meta = {
  title: 'Work/Recorded Anime parts wholes and relations',
  component: RecordedVisit,
  parameters: { layout: 'fullscreen' },
  args: { persona: 'visitor', entry: 1, view: 'connections', loading: false, locale: 'en' },
} satisfies Meta<typeof RecordedVisit>;
export default meta;
type Story = StoryObj<typeof meta>;

const visit: Story['play'] = async ({ canvasElement, args }) => {
  const canvas = within(canvasElement);
  const selected = recordedAnimeRelationsVisit(record, args.persona, args.entry);
  await expect(canvas.getByText(`${args.persona} · ${selected.actingSubject ?? 'none'}`)).toBeVisible();
  if (args.loading) {
    await expect(canvas.findByRole('status', { name: messages[args.locale].loading })).resolves.toHaveAttribute('aria-busy', 'true');
    await expect(canvas.queryByRole('heading', { level: 1 })).not.toBeInTheDocument();
  } else if (selected.header.status === 404) {
    await expect(canvas.findByRole('heading', { level: 1, name: messages[args.locale].notFoundTitle })).resolves.toBeVisible();
    await expect(canvas.queryByText(/Private seed omnibus/)).not.toBeInTheDocument();
    await expect(canvas.queryByText(/Private seed journey/)).not.toBeInTheDocument();
    await expect(canvas.getByRole('link', { name: messages[args.locale].searchWorks })).toBeVisible();
  } else {
    const header = selected.header.answer as WorkHeader;
    await expect(canvas.findByRole('heading', { level: 1, name: header.title.value })).resolves.toBeVisible();
    await expect(canvas.findAllByText('Outcome owner', { exact: true })).resolves.not.toHaveLength(0);
    if (args.entry <= 3) {
      const type = ['TV series', 'Book', 'Game'][args.entry - 1]!;
      await expect(canvas.getByText(`${type} · English`, { exact: true })).toBeVisible();
      if (args.view === 'contents') {
        await expect(canvas.findByRole('link', { name: /Part 2/ })).resolves.toBeVisible();
        await expect(canvas.findByRole('link', { name: /Part 3/ })).resolves.toBeVisible();
        await expect(canvas.queryByRole('link', { name: /^Part 1\b/ }) !== null).toBe(args.persona === 'owner');
      } else {
        await expect(canvas.findAllByText(/First seed journey/)).resolves.not.toHaveLength(0);
        await expect(canvas.findAllByText(/Second seed journey/)).resolves.not.toHaveLength(0);
        await expect(canvas.queryAllByText(/Private seed journey/).length > 0).toBe(args.persona === 'owner');
      }
    }
    if (args.entry === 4) {
      for (const title of ['Animated seed islands', 'Seed islands manga', 'Seed islands visual novel'])
        await expect(canvas.findAllByText(new RegExp(title))).resolves.not.toHaveLength(0);
      await expect(canvas.queryAllByText(/Private seed omnibus/).length > 0).toBe(args.persona === 'owner');
    }
    if (args.entry === 5) {
      await expect(canvas.findAllByText('Part 1', { exact: true })).resolves.not.toHaveLength(0);
      await expect(canvas.findAllByRole('link', { name: /First seed journey/ })).resolves.not.toHaveLength(0);
      await expect(canvas.findByText(relationshipMessages[args.locale].unavailable)).resolves.toBeVisible();
    }
  }
  await waitFor(() => expect(canvasElement.scrollWidth).toBeLessThanOrEqual(canvasElement.clientWidth + 1));
  await expect(canvas.queryByText(/Unmatched recorded request|Missing.*recorded|This visit needs/)).not.toBeInTheDocument();
  if (!args.loading && selected.header.status === 200 && selected.actingSubject && args.view === 'connections') {
    canvas.getByRole('heading', { name: copyOf(args.locale).parts }).scrollIntoView();
  }
};
function page(persona: AnswerPersona, entry: number, viewport: 'desktop' | 'phone',
  view: AnimeRelationsView = 'connections', loading = false): Story {
  const selected = recordedAnimeRelationsVisit(record, persona, entry);
  return { args: { persona, entry, view, loading }, globals: { viewport: { value: viewport } },
    parameters: { route: { pathname: localizedPath(view === 'connections'
      ? connectionsHref(selected.id) : workHref(selected.id, view), 'en') } }, play: visit };
}
export const VisitorAnimeDesktop: Story = page('visitor', 1, 'desktop');
export const VisitorAnimePhone: Story = page('visitor', 1, 'phone');
export const VisitorMangaDesktop: Story = page('visitor', 2, 'desktop');
export const VisitorMangaPhone: Story = page('visitor', 2, 'phone');
export const VisitorVNDesktop: Story = page('visitor', 3, 'desktop');
export const VisitorVNPhone: Story = page('visitor', 3, 'phone');
export const VisitorWholesDesktop: Story = page('visitor', 4, 'desktop');
export const VisitorWholesPhone: Story = page('visitor', 4, 'phone');
export const VisitorPrivateDesktop: Story = page('visitor', 5, 'desktop');
export const VisitorPrivatePhone: Story = page('visitor', 5, 'phone');
export const StrangerAnimeDesktop: Story = page('stranger', 1, 'desktop');
export const StrangerAnimePhone: Story = page('stranger', 1, 'phone');
export const StrangerMangaDesktop: Story = page('stranger', 2, 'desktop');
export const StrangerMangaPhone: Story = page('stranger', 2, 'phone');
export const StrangerVNDesktop: Story = page('stranger', 3, 'desktop');
export const StrangerVNPhone: Story = page('stranger', 3, 'phone');
export const StrangerWholesDesktop: Story = page('stranger', 4, 'desktop');
export const StrangerWholesPhone: Story = page('stranger', 4, 'phone');
export const StrangerPrivateDesktop: Story = page('stranger', 5, 'desktop');
export const StrangerPrivatePhone: Story = page('stranger', 5, 'phone');
export const MemberAnimeDesktop: Story = page('member', 1, 'desktop');
export const MemberAnimePhone: Story = page('member', 1, 'phone');
export const MemberMangaDesktop: Story = page('member', 2, 'desktop');
export const MemberMangaPhone: Story = page('member', 2, 'phone');
export const MemberVNDesktop: Story = page('member', 3, 'desktop');
export const MemberVNPhone: Story = page('member', 3, 'phone');
export const MemberWholesDesktop: Story = page('member', 4, 'desktop');
export const MemberWholesPhone: Story = page('member', 4, 'phone');
export const MemberPrivateDesktop: Story = page('member', 5, 'desktop');
export const MemberPrivatePhone: Story = page('member', 5, 'phone');
export const OwnerAnimeDesktop: Story = page('owner', 1, 'desktop');
export const OwnerAnimePhone: Story = page('owner', 1, 'phone');
export const OwnerMangaDesktop: Story = page('owner', 2, 'desktop');
export const OwnerMangaPhone: Story = page('owner', 2, 'phone');
export const OwnerVNDesktop: Story = page('owner', 3, 'desktop');
export const OwnerVNPhone: Story = page('owner', 3, 'phone');
export const OwnerWholesDesktop: Story = page('owner', 4, 'desktop');
export const OwnerWholesPhone: Story = page('owner', 4, 'phone');
export const OwnerPrivateDesktop: Story = page('owner', 5, 'desktop');
export const OwnerPrivatePhone: Story = page('owner', 5, 'phone');
export const ModeratorAnimeDesktop: Story = page('moderator', 1, 'desktop');
export const ModeratorAnimePhone: Story = page('moderator', 1, 'phone');
export const ModeratorMangaDesktop: Story = page('moderator', 2, 'desktop');
export const ModeratorMangaPhone: Story = page('moderator', 2, 'phone');
export const ModeratorVNDesktop: Story = page('moderator', 3, 'desktop');
export const ModeratorVNPhone: Story = page('moderator', 3, 'phone');
export const ModeratorWholesDesktop: Story = page('moderator', 4, 'desktop');
export const ModeratorWholesPhone: Story = page('moderator', 4, 'phone');
export const ModeratorPrivateDesktop: Story = page('moderator', 5, 'desktop');
export const ModeratorPrivatePhone: Story = page('moderator', 5, 'phone');
export const OperatorAnimeDesktop: Story = page('operator', 1, 'desktop');
export const OperatorAnimePhone: Story = page('operator', 1, 'phone');
export const OperatorMangaDesktop: Story = page('operator', 2, 'desktop');
export const OperatorMangaPhone: Story = page('operator', 2, 'phone');
export const OperatorVNDesktop: Story = page('operator', 3, 'desktop');
export const OperatorVNPhone: Story = page('operator', 3, 'phone');
export const OperatorWholesDesktop: Story = page('operator', 4, 'desktop');
export const OperatorWholesPhone: Story = page('operator', 4, 'phone');
export const OperatorPrivateDesktop: Story = page('operator', 5, 'desktop');
export const OperatorPrivatePhone: Story = page('operator', 5, 'phone');
export const VisitorContentsDesktop: Story = page('visitor', 1, 'desktop', 'contents');
export const VisitorContentsPhone: Story = page('visitor', 1, 'phone', 'contents');
export const VisitorOverviewDesktop: Story = page('visitor', 1, 'desktop', 'overview');
export const VisitorOverviewPhone: Story = page('visitor', 1, 'phone', 'overview');
export const OwnerContentsDesktop: Story = page('owner', 1, 'desktop', 'contents');
export const OwnerContentsPhone: Story = page('owner', 1, 'phone', 'contents');
export const OwnerOverviewDesktop: Story = page('owner', 1, 'desktop', 'overview');
export const OwnerOverviewPhone: Story = page('owner', 1, 'phone', 'overview');
export const LoadingDesktop: Story = page('visitor', 1, 'desktop', 'connections', true);
export const LoadingPhone: Story = page('visitor', 1, 'phone', 'connections', true);
