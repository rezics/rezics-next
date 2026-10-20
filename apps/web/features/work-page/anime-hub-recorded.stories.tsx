import { useEffect, useState } from 'react';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, waitFor, within } from 'storybook/test';
import type { AnswerRecord } from '../../../../scripts/api/answer-record.ts';
import hub from '../../../../tests/qa/fixtures/outcomes/anime/work-hub-and-edition-choice.json';
import type { UiLocale } from '../../i18n/define.ts';
import { BFF_PREFIX, browserMainApi } from '../api/browser.ts';
import type { MainClient } from '../discover/types.ts';
import { copyOf as entityCopy } from '../entity-page/messages.ts';
import type { StatementPage } from '../entity-page/types.ts';
import { recordedFetch, type RecordedSelection } from '../stories/recorded-fetch.ts';
import { chooseOption } from '../stories/choose-option.ts';
import { releaseChoiceName } from '../tracking/display.ts';
import { copyOf } from '../tracking/messages.ts';
import type { Release } from '../tracking/types.ts';
import { AnimeHubRecordedPage } from './anime-hub-recorded-page.tsx';
import { publicationLexicals } from './anime-hub-recorded-page.ts';
import { messages } from './messages.ts';
import type { WorkHeader } from './types.ts';

const record = hub as AnswerRecord;
type Persona = 'visitor' | 'stranger' | 'member' | 'owner' | 'moderator' | 'operator';
type Kind = 'dated' | 'undated' | 'loading';
type Mode = 'visit' | 'conflict' | 'replay' | 'saved';
interface Args { persona: Persona; kind: Kind; mode: Mode; locale: UiLocale }
const sample = (persona: Persona, label: string) => {
  const found = record.personas[persona].find(item => item.label === label);
  if (!found) throw new Error(`Missing Anime answer: ${persona}/${label}`);
  return found;
};
const subjectOf = (persona: Persona, label: string) =>
  new URL(sample(persona, label).path, 'https://recorded.invalid').searchParams.get('actingSubject') ?? undefined;
const idOfPath = (persona: Persona, label: string) =>
  new URL(sample(persona, label).path, 'https://recorded.invalid').pathname.split('/').at(-1)!;

function selectionsFor(persona: Persona, kind: Kind, mode: Mode): RecordedSelection[] {
  if (kind === 'loading') return [{ label: 'hub-work-header', state: 'loading' }];
  if (kind === 'undated') return [
    { label: 'undated-work-header', state: 'populated' },
    { label: 'undated-work-publication-date', state: 'populated' },
    { label: 'hub-undated-releases-empty', state: 'populated' },
  ];
  const selections: RecordedSelection[] = [
    { label: 'hub-work-header', state: 'populated' }, { label: 'hub-resource-page', state: 'populated' },
    { label: 'hub-facts', state: 'populated' }, { label: 'hub-agent-credits', state: 'populated' },
    { label: 'hub-work-credits', state: 'populated' }, { label: 'hub-realizations', state: 'populated' },
    { label: 'hub-releases', state: 'populated' }, { label: 'hub-availability-parts', state: 'populated' },
  ];
  if (persona === 'visitor') return selections;
  selections.push({ label: 'hub-reader-state', state: 'populated' },
    { label: mode === 'saved' ? 'hub-status-preference' : 'edition-preference-empty', state: mode === 'saved' ? 'populated' : 'empty' });
  if (mode === 'visit' || mode === 'saved') selections.push({ label: 'hub-status-progress', state: 'populated' });
  if (mode === 'visit') return selections;
  if (mode === 'saved') {
    const preference = sample(persona, 'hub-status-preference').answer as { edition: { resource: string } };
    const detail = ['broadcast-edition', 'restored-edition'].find(label =>
      (sample(persona, label).answer as { id: string }).id === preference.edition.resource)!;
    selections.push({ label: detail, state: 'populated' });
    return selections;
  }
  const winner = ['broadcast-edition-choice', 'restored-edition-choice'].find(label => sample(persona, label).status === 200)!;
  const release = (sample(persona, winner).body as { edition: { resource: string } }).edition.resource;
  const detail = ['broadcast-edition', 'restored-edition'].find(label =>
    (sample(persona, label).answer as { id: string }).id === release)!;
  selections.push({ label: detail, state: 'populated' }, { label: 'chosen-edition-progress', state: 'populated' });
  if (mode === 'replay') selections.push({ label: 'edition-choice-replay', state: 'populated' });
  else selections.push(
    { label: 'broadcast-edition-choice', state: sample(persona, 'broadcast-edition-choice').status === 200 ? 'populated' : 'error' },
    { label: 'restored-edition-choice', state: sample(persona, 'restored-edition-choice').status === 200 ? 'populated' : 'error' },
  );
  return selections;
}

function RecordedAnimeHub({ persona, kind, mode, locale }: Args) {
  const [client, setClient] = useState<{ main: MainClient; actingSubject?: string; workId: string; factsHref?: string } | null>(null);
  const [fault, setFault] = useState<string | null>(null);
  useEffect(() => {
    setClient(null);
    setFault(null);
    const headerLabel = kind === 'undated' ? 'undated-work-header' : 'hub-work-header';
    const replay = recordedFetch(record, persona, selectionsFor(persona, kind, mode), { pathPrefix: BFF_PREFIX });
    let mounted = true;
    const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
      try { return await replay.fetcher(input, init); }
      catch (error) {
        if (mounted && !(error instanceof DOMException && error.name === 'AbortError')) setFault(String(error));
        throw error;
      }
    }) as typeof fetch;
    const actingSubject = kind === 'loading' ? subjectOf(persona, headerLabel) : subjectOf(persona, headerLabel);
    setClient({
      main: browserMainApi(window.location.origin, { anonymous: persona === 'visitor', fetcher }),
      actingSubject, workId: idOfPath(persona, headerLabel),
      factsHref: kind === 'undated' ? new URL(sample(persona, 'undated-work-publication-date').path, 'https://recorded.invalid').pathname : undefined,
    });
    return () => { mounted = false; replay.dispose(); };
  }, [persona, kind, mode, locale]);
  if (fault) return <pre role="alert" className="whitespace-pre-wrap break-words p-6">{fault}</pre>;
  if (!client) return <p role="status" aria-busy="true" className="p-6">{messages[locale].loading}</p>;
  return <AnimeHubRecordedPage persona={persona} locale={locale} kind={kind} {...client} />;
}

const meta = { title: 'Work page/Anime hub recorded', component: RecordedAnimeHub,
  args: { persona: 'visitor', kind: 'dated', mode: 'visit', locale: 'en' },
  globals: { viewport: { value: 'desktop' } }, parameters: { controls: { disable: true } },
} satisfies Meta<typeof RecordedAnimeHub>;
export default meta;
type Story = StoryObj<typeof meta>;

async function fits(canvasElement: HTMLElement) {
  await document.fonts.ready;
  await expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(window.innerWidth);
  const value = canvasElement.querySelector<HTMLElement>('[data-part=value-text]');
  if (value) await expect(value.scrollWidth).toBeLessThanOrEqual(value.clientWidth + 1);
}

async function showHub(canvasElement: HTMLElement, args: Args) {
  const canvas = within(canvasElement);
  const headerLabel = args.kind === 'undated' ? 'undated-work-header' : 'hub-work-header';
  const header = sample(args.persona, headerLabel).answer as WorkHeader;
  await expect(canvas.findByRole('heading', { level: 1, name: header.title.value })).resolves.toBeVisible();
  await expect(canvas.getByText(`${args.persona} · ${subjectOf(args.persona, headerLabel) ?? 'none'}`)).toBeVisible();
  const factsLabel = args.kind === 'undated' ? 'undated-work-publication-date' : 'hub-facts';
  const facts = entityCopy(args.locale);
  const lexicals = publicationLexicals(sample(args.persona, factsLabel).answer as StatementPage);
  if (lexicals.length) {
    await expect(canvas.getByRole('heading', { name: facts.otherFacts })).toBeVisible();
    for (const lexical of lexicals) await expect(canvas.getByText(lexical)).toBeVisible();
  } else {
    await expect(canvas.getByText(facts.noStatements)).toBeVisible();
    await expect(canvas.getByText(facts.noStatementsBody)).toBeVisible();
  }
  if (args.kind === 'dated') {
    await expect(canvas.getByRole('link', { name: 'Outcome owner' })).toBeVisible();
    const releases = sample(args.persona, 'hub-releases').answer as { items: Release[] };
    for (const release of releases.items) {
      const link = canvas.getByRole('link', { name: release.title.value });
      await expect(link).toBeVisible();
      if (release.publicationYear) await expect(link.closest('li')).toHaveTextContent(String(release.publicationYear));
    }
    const tracking = copyOf(args.locale);
    if (args.persona === 'visitor') {
      await expect(canvas.getByRole('link', { name: messages[args.locale].signInForEdition })).toBeVisible();
      await expect(canvas.queryByRole('button', { name: tracking.savePreference })).not.toBeInTheDocument();
    } else {
      const chooser = await canvas.findByRole('combobox', { name: tracking.edition });
      await waitFor(() => expect(chooser).toBeEnabled());
      await userEvent.click(chooser);
      for (const release of releases.items) {
        const name = releaseChoiceName(release, args.locale, tracking);
        await waitFor(async () => {
          const options = canvas.getAllByRole('option', { name, hidden: true }).filter(item => !item.closest('select'));
          await expect(options).toHaveLength(1);
          await expect(options[0]).toBeVisible();
        });
      }
      await userEvent.keyboard('{Escape}');
    }
  }
  await fits(canvasElement);
  return canvas;
}

async function pickRelease(canvas: ReturnType<typeof within>, persona: Persona, locale: UiLocale, resource: string) {
  const releases = sample(persona, 'hub-releases').answer as { items: Release[] };
  const release = releases.items.find(item => item.id === resource)!;
  const tracking = copyOf(locale);
  await userEvent.click(await canvas.findByRole('combobox', { name: tracking.edition }));
  await chooseOption(canvas, releaseChoiceName(release, locale, tracking));
  return releaseChoiceName(release, locale, tracking);
}

async function saveChoice(canvas: ReturnType<typeof within>, canvasElement: HTMLElement, args: Args, resource: string) {
  const tracking = copyOf(args.locale);
  const name = await pickRelease(canvas, args.persona, args.locale, resource);
  await userEvent.click(canvas.getByRole('button', { name: tracking.savePreference }));
  // A status role takes its accessible name from the author, not from this sentence.
  const saved = await canvas.findByText(tracking.preferenceSaved);
  await expect(saved).toHaveAttribute('role', 'status');
  await expect(saved).toBeVisible();
  await waitFor(() => expect(canvas.getByRole('list', { name: messages[args.locale].yourEdition })).toHaveTextContent(name));
  await waitFor(() => expect(within(canvasElement.querySelector<HTMLElement>('[data-work-identity]')!)
    .queryByRole('link', { name: messages[args.locale].chooseRelease })).not.toBeInTheDocument());
  await fits(canvasElement);
}

const winnerResource = (persona: Persona, mode: Mode) => {
  const label = mode === 'replay' ? 'edition-choice-replay'
    : ['broadcast-edition-choice', 'restored-edition-choice'].find(item => sample(persona, item).status === 200)!;
  return (sample(persona, label).body as { edition: { resource: string } }).edition.resource;
};
const loserResource = (persona: Persona) => {
  const label = ['broadcast-edition-choice', 'restored-edition-choice'].find(item => sample(persona, item).status === 409)!;
  return (sample(persona, label).body as { edition: { resource: string } }).edition.resource;
};

function view(persona: Persona, kind: Kind = 'dated', mode: Mode = 'visit', viewport: 'desktop' | 'phone' = 'desktop',
  locale: UiLocale = 'en', play?: Story['play']): Story {
  return { args: { persona, kind, mode, locale }, globals: { viewport: { value: viewport },
    ...locale === 'en' ? {} : { locale } }, play };
}

const visit: Story['play'] = async ({ canvasElement, args }) => { await showHub(canvasElement, args); };
const conflict: Story['play'] = async ({ canvasElement, args }) => {
  const canvas = await showHub(canvasElement, args);
  const tracking = copyOf(args.locale);
  await pickRelease(canvas, args.persona, args.locale, loserResource(args.persona));
  await userEvent.click(canvas.getByRole('button', { name: tracking.savePreference }));
  await expect(canvas.findByRole('alert')).resolves.toHaveTextContent(tracking.preferenceStale);
  await expect(canvas.queryByText(tracking.preferenceSaved)).not.toBeInTheDocument();
  await saveChoice(canvas, canvasElement, args, winnerResource(args.persona, 'conflict'));
};
const replay: Story['play'] = async ({ canvasElement, args }) => {
  const canvas = await showHub(canvasElement, args);
  await saveChoice(canvas, canvasElement, args, winnerResource(args.persona, 'replay'));
};

export const Visitor: Story = view('visitor', 'dated', 'visit', 'desktop', 'en', visit);
export const VisitorPhone: Story = view('visitor', 'dated', 'visit', 'phone', 'en', visit);
export const VisitorChinesePhone: Story = view('visitor', 'dated', 'visit', 'phone', 'zh-Hans', visit);
export const Stranger: Story = view('stranger', 'dated', 'visit', 'desktop', 'en', visit);
export const StrangerPhone: Story = view('stranger', 'dated', 'visit', 'phone', 'en', visit);
export const Member: Story = view('member', 'dated', 'visit', 'desktop', 'en', visit);
export const MemberPhone: Story = view('member', 'dated', 'visit', 'phone', 'en', visit);
const saved: Story['play'] = async ({ canvasElement, args }) => {
  const canvas = await showHub(canvasElement, args);
  const preference = sample(args.persona, 'hub-status-preference').answer as { edition: { resource: string } };
  const release = (sample(args.persona, 'hub-releases').answer as { items: Release[] }).items
    .find(item => item.id === preference.edition.resource)!;
  await waitFor(() => expect(canvas.getByRole('list', { name: messages[args.locale].yourEdition }))
    .toHaveTextContent(releaseChoiceName(release, args.locale, copyOf(args.locale))));
  await expect(within(canvasElement.querySelector<HTMLElement>('[data-work-identity]')!)
    .queryByRole('link', { name: messages[args.locale].chooseRelease })).not.toBeInTheDocument();
};
export const MemberSavedEdition: Story = view('member', 'dated', 'saved', 'desktop', 'en', saved);
export const MemberSavedEditionPhone: Story = view('member', 'dated', 'saved', 'phone', 'en', saved);
export const Owner: Story = view('owner', 'dated', 'visit', 'desktop', 'en', visit);
export const OwnerPhone: Story = view('owner', 'dated', 'visit', 'phone', 'en', visit);
export const Moderator: Story = view('moderator', 'dated', 'visit', 'desktop', 'en', visit);
export const ModeratorPhone: Story = view('moderator', 'dated', 'visit', 'phone', 'en', visit);
export const Operator: Story = view('operator', 'dated', 'visit', 'desktop', 'en', visit);
export const OperatorPhone: Story = view('operator', 'dated', 'visit', 'phone', 'en', visit);

export const UndatedVisitor: Story = view('visitor', 'undated', 'visit', 'desktop', 'en', visit);
export const UndatedVisitorPhone: Story = view('visitor', 'undated', 'visit', 'phone', 'en', visit);
export const UndatedStranger: Story = view('stranger', 'undated', 'visit', 'desktop', 'en', visit);
export const UndatedStrangerPhone: Story = view('stranger', 'undated', 'visit', 'phone', 'en', visit);
export const UndatedMember: Story = view('member', 'undated', 'visit', 'desktop', 'en', visit);
export const UndatedMemberPhone: Story = view('member', 'undated', 'visit', 'phone', 'en', visit);
export const UndatedOwner: Story = view('owner', 'undated', 'visit', 'desktop', 'en', visit);
export const UndatedOwnerPhone: Story = view('owner', 'undated', 'visit', 'phone', 'en', visit);
export const UndatedModerator: Story = view('moderator', 'undated', 'visit', 'desktop', 'en', visit);
export const UndatedModeratorPhone: Story = view('moderator', 'undated', 'visit', 'phone', 'en', visit);
export const UndatedOperator: Story = view('operator', 'undated', 'visit', 'desktop', 'en', visit);
export const UndatedOperatorPhone: Story = view('operator', 'undated', 'visit', 'phone', 'en', visit);
export const UndatedVisitorChinesePhone: Story = view('visitor', 'undated', 'visit', 'phone', 'zh-Hans', visit);

export const Loading: Story = view('visitor', 'loading', 'visit', 'desktop', 'en', async ({ canvasElement }) => {
  await expect(within(canvasElement).findByRole('status')).resolves.toHaveTextContent(messages.en.loading);
});
export const LoadingPhone: Story = { ...Loading, globals: { viewport: { value: 'phone' } } };

export const StrangerConflict: Story = view('stranger', 'dated', 'conflict', 'desktop', 'en', conflict);
export const StrangerConflictPhone: Story = view('stranger', 'dated', 'conflict', 'phone', 'en', conflict);
export const MemberConflict: Story = view('member', 'dated', 'conflict', 'desktop', 'en', conflict);
export const MemberConflictPhone: Story = view('member', 'dated', 'conflict', 'phone', 'en', conflict);
export const OwnerConflict: Story = view('owner', 'dated', 'conflict', 'desktop', 'en', conflict);
export const OwnerConflictPhone: Story = view('owner', 'dated', 'conflict', 'phone', 'en', conflict);
export const ModeratorConflict: Story = view('moderator', 'dated', 'conflict', 'desktop', 'en', conflict);
export const ModeratorConflictPhone: Story = view('moderator', 'dated', 'conflict', 'phone', 'en', conflict);
export const OperatorConflict: Story = view('operator', 'dated', 'conflict', 'desktop', 'en', conflict);
export const OperatorConflictPhone: Story = view('operator', 'dated', 'conflict', 'phone', 'en', conflict);

export const StrangerReplay: Story = view('stranger', 'dated', 'replay', 'desktop', 'en', replay);
export const StrangerReplayPhone: Story = view('stranger', 'dated', 'replay', 'phone', 'en', replay);
export const MemberReplay: Story = view('member', 'dated', 'replay', 'desktop', 'en', replay);
export const MemberReplayPhone: Story = view('member', 'dated', 'replay', 'phone', 'en', replay);
export const OwnerReplay: Story = view('owner', 'dated', 'replay', 'desktop', 'en', replay);
export const OwnerReplayPhone: Story = view('owner', 'dated', 'replay', 'phone', 'en', replay);
export const ModeratorReplay: Story = view('moderator', 'dated', 'replay', 'desktop', 'en', replay);
export const ModeratorReplayPhone: Story = view('moderator', 'dated', 'replay', 'phone', 'en', replay);
export const OperatorReplay: Story = view('operator', 'dated', 'replay', 'desktop', 'en', replay);
export const OperatorReplayPhone: Story = view('operator', 'dated', 'replay', 'phone', 'en', replay);
