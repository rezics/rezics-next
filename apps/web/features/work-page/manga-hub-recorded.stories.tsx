import { useEffect, useState } from 'react';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, within } from 'storybook/test';
import { materializeData } from 'native-i18n';
import type { AnswerPersona, AnswerRecord } from '../../../../scripts/api/answer-record.ts';
import recorded from '../../../../tests/qa/fixtures/outcomes/manga/work-hub-and-edition-choice.json';
import type { UiLocale } from '../../i18n/define.ts';
import { BFF_PREFIX, browserMainApi } from '../api/browser.ts';
import { ReaderActionsProvider } from '../catalogue/reader-actions.tsx';
import { recordedFetch, type RecordedSelection } from '../stories/recorded-fetch.ts';
import { releaseChoiceName } from '../tracking/display.ts';
import { copyOf } from '../tracking/messages.ts';
import type { EditionPreference, Release } from '../tracking/types.ts';
import { booksEditionReads, readBooksEditionStatus } from './books-edition-page.read.ts';
import { messages } from './messages.ts';
import { IdentityStatus } from './primary-action.tsx';
import { Region } from './region.tsx';
import type { WorkHeader } from './types.ts';
import { YourEdition } from './your-edition.tsx';

const record = recorded as AnswerRecord;
type Persona = AnswerPersona;
type SignedIn = Exclude<Persona, 'visitor'>;
interface Props { persona: Persona; state: 'populated' | 'loading'; saved: boolean; locale: UiLocale }
interface View {
  header: WorkHeader;
  status: Awaited<ReturnType<typeof readBooksEditionStatus>>;
}

function sample(persona: Persona, label: string) {
  const found = record.personas[persona].find(item => item.label === label);
  if (!found) throw new Error(`Missing Manga answer: ${persona}/${label}`);
  return found;
}

function ownReleaseLabel(persona: SignedIn): string {
  const preference = sample(persona, 'edition-preference').answer as EditionPreference;
  const resource = preference.edition?.kind === 'release' ? preference.edition.resource : null;
  const label = (['release-0', 'release-1'] as const).find(item =>
    (sample(persona, item).answer as { id: string }).id === resource);
  if (!label || !resource) throw new Error(`${persona} preference does not name a recorded release`);
  return label;
}

/**
 * The same edition readers as the Work page. The release list stays out of this frame: the
 * production read asks for `limit=20`, and this row recorded the list without that parameter.
 */
function RecordedMangaHub({ persona, state, saved, locale }: Props) {
  const [view, setView] = useState<View | null>(null);
  const [fault, setFault] = useState<string | null>(null);
  useEffect(() => {
    setView(null);
    setFault(null);
    const headerSample = sample(persona, 'work');
    const actingSubject = new URL(headerSample.path, 'https://recorded.invalid').searchParams.get('actingSubject') ?? undefined;
    const id = new URL(headerSample.path, 'https://recorded.invalid').pathname.split('/').at(-1)!;
    const selections: RecordedSelection[] = [
      { label: 'work', state: state === 'loading' ? 'loading' : 'populated' },
    ];
    if (state !== 'loading' && persona !== 'visitor') {
      selections.push({ label: saved ? 'edition-preference' : 'edition-preference-empty', state: saved ? 'populated' : 'empty' });
      if (saved) selections.push(
        { label: ownReleaseLabel(persona), state: 'populated' },
        { label: 'progress-summary', state: 'populated' },
      );
      else if (persona === 'owner') selections.push({ label: 'progress-summary-empty', state: 'populated' });
    }
    const replay = recordedFetch(record, persona, selections, { pathPrefix: BFF_PREFIX });
    let mounted = true;
    const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
      try { return await replay.fetcher(input, init); }
      catch (error) {
        if (mounted && !(error instanceof DOMException && error.name === 'AbortError')) setFault(String(error));
        throw error;
      }
    }) as typeof fetch;
    const main = browserMainApi(window.location.origin, { anonymous: persona === 'visitor', fetcher });
    const reads = booksEditionReads({ main, actingSubject });
    void reads.readWorkHeader(id).then(async header => {
      if (!mounted) return;
      if (!header.ok) { setFault(`Work header: ${header.failure}`); return; }
      const status = await readBooksEditionStatus(reads, id, locale);
      if (!mounted) return;
      setView({ header: header.data, status });
    });
    return () => { mounted = false; replay.dispose(); };
  }, [persona, state, saved, locale]);
  const t = materializeData(messages[locale], { locale });
  if (fault) return <pre role="alert" className="whitespace-pre-wrap break-words p-6">{fault}</pre>;
  if (!view) return <p role="status" aria-busy="true" className="p-6">{t.loading}</p>;
  return <ReaderActionsProvider signedIn={persona !== 'visitor'} signInHref="/auth/start">
    <main className="mx-auto grid min-w-0 max-w-3xl grid-cols-1 gap-6 px-4 py-6" lang={locale}>
      <h1 className="break-words font-semibold text-2xl" lang={view.header.title.language}>{view.header.title.value}</h1>
      <IdentityStatus {...view.status} locale={locale} messages={messages[locale]} />
      {persona === 'visitor' ? <Region id="work-availability" title={t.sectionAvailability} className="grid-cols-1">
        <YourEdition work={view.header.id} signInHref="/auth/start" locale={locale} messages={messages[locale]} />
      </Region> : null}
    </main>
  </ReaderActionsProvider>;
}

const meta = { title: 'Work page/Manga hub recorded', component: RecordedMangaHub,
  args: { persona: 'member', state: 'populated', saved: true, locale: 'en' },
  globals: { viewport: { value: 'desktop' } }, parameters: { controls: { disable: true } },
} satisfies Meta<typeof RecordedMangaHub>;
export default meta;
type Story = StoryObj<typeof meta>;

async function shownWork(canvasElement: HTMLElement, persona: Persona) {
  const canvas = within(canvasElement);
  const header = sample(persona, 'work').answer as WorkHeader;
  await expect(canvas.findByRole('heading', { level: 1, name: header.title.value })).resolves.toBeVisible();
  await document.fonts.ready;
  await expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(window.innerWidth);
  return canvas;
}

function chosenName(persona: SignedIn, locale: UiLocale): { name: string; other: string } {
  const label = ownReleaseLabel(persona);
  const release = sample(persona, label).answer as Release;
  const otherLabel = label === 'release-0' ? 'release-1' : 'release-0';
  const other = sample(persona, otherLabel).answer as Release;
  return { name: releaseChoiceName(release, locale, copyOf(locale)), other: other.title.value };
}

export const Loading: Story = { args: { state: 'loading', saved: false }, async play({ canvasElement }) {
  await expect(within(canvasElement).getByRole('status')).toHaveTextContent(messages.en.loading);
} };
export const LoadingPhone: Story = { ...Loading, globals: { viewport: { value: 'phone' } } };

export const Visitor: Story = { args: { persona: 'visitor', saved: false }, async play({ canvasElement }) {
  const canvas = await shownWork(canvasElement, 'visitor');
  await expect(canvas.getByRole('link', { name: messages.en.signInForEdition })).toBeVisible();
  await expect(canvas.queryByRole('list', { name: messages.en.yourEdition })).not.toBeInTheDocument();
} };
export const VisitorPhone: Story = { ...Visitor, globals: { viewport: { value: 'phone' } } };

async function ownEdition(canvasElement: HTMLElement, persona: SignedIn, locale: UiLocale) {
  const canvas = await shownWork(canvasElement, persona);
  const { name, other } = chosenName(persona, locale);
  const status = canvas.getByRole('list', { name: messages[locale].yourEdition });
  await expect(status).toHaveTextContent(name);
  await expect(status).not.toHaveTextContent(other);
  await expect(canvas.queryByRole('link', { name: messages[locale].signInForEdition })).not.toBeInTheDocument();
}

export const Member: Story = { async play({ canvasElement, args }) {
  await ownEdition(canvasElement, 'member', args.locale);
} };
export const MemberPhone: Story = { ...Member, globals: { viewport: { value: 'phone' } } };
export const MemberChinesePhone: Story = { ...Member, args: { locale: 'zh-Hans' },
  globals: { locale: 'zh-Hans', viewport: { value: 'phone' } } };

export const Stranger: Story = { args: { persona: 'stranger' }, async play({ canvasElement, args }) {
  await ownEdition(canvasElement, 'stranger', args.locale);
} };
export const StrangerPhone: Story = { ...Stranger, globals: { viewport: { value: 'phone' } } };

export const OwnerEmpty: Story = { args: { persona: 'owner', saved: false }, async play({ canvasElement }) {
  const canvas = await shownWork(canvasElement, 'owner');
  await expect(canvas.queryByRole('list', { name: messages.en.yourEdition })).not.toBeInTheDocument();
  await expect(canvas.queryByRole('link', { name: messages.en.signInForEdition })).not.toBeInTheDocument();
} };
export const OwnerEmptyPhone: Story = { ...OwnerEmpty, globals: { viewport: { value: 'phone' } } };
