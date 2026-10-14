import { useEffect, useState } from 'react';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, waitFor, within } from 'storybook/test';
import type { AnswerPersona, AnswerRecord } from '../../../../scripts/api/answer-record.ts';
import recorded from '../../../../tests/qa/fixtures/outcomes/manga/work-hub-and-edition-choice.json';
import type { UiLocale } from '../../i18n/define.ts';
import { BFF_PREFIX, browserMainApi } from '../api/browser.ts';
import { ReaderActionsProvider, type ReaderActions } from '../catalogue/reader-actions.tsx';
import { createReaderStore } from '../catalogue/reader-store.ts';
import { chooseOption } from '../stories/choose-option.ts';
import { recordedFetch, type RecordedSelection } from '../stories/recorded-fetch.ts';
import { languageName, releaseChoiceName } from '../tracking/display.ts';
import { copyOf } from '../tracking/messages.ts';
import { EDITION_SAVED } from '../tracking/series-progress-panel.tsx';
import type { EditionPreference, Release } from '../tracking/types.ts';
import { booksEditionReads, readBooksEditionPage, readBooksEditionStatus, type BooksReleasePage } from './books-edition-page.read.ts';
import { BooksEditionPage } from './books-edition-page.tsx';
import { messages } from './messages.ts';
import { IdentityStatus } from './primary-action.tsx';
import type { WorkHeader } from './types.ts';
import { editionsHref, releaseHref } from '../work-levels/route.ts';

const record = recorded as AnswerRecord;
type Persona = AnswerPersona;
type SignedIn = Exclude<Persona, 'visitor'>;
interface Props { persona: Persona; state: 'populated' | 'loading'; saved: boolean; locale: UiLocale; save: boolean }
type View = Awaited<ReturnType<typeof readBooksEditionPage>> & { actions?: ReaderActions };

/**
 * The Books edition seam replayed from this row. The list is the production
 * `limit=20` read. A signed-in reader sees and saves only their own preference.
 * A replayed key, a lost race, an invalid language, an unavailable Work and
 * another person's choice are recorded commands this page does not send.
 */
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

function RecordedMangaHub({ persona, state, saved, locale, save }: Props) {
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
      { label: 'visit-releases', state: 'populated' },
    ];
    if (persona !== 'visitor') {
      if (saved) selections.push(
        { label: 'edition-preference', state: 'populated' },
        { label: 'progress-summary', state: 'populated' },
        { label: ownReleaseLabel(persona), state: 'populated' },
        { label: 'visit-realizations', state: 'populated' },
      );
      else {
        selections.push(
          { label: 'edition-preference-empty', state: 'empty' },
          { label: 'visit-status-progress', state: 'populated' },
        );
        if (state !== 'loading') selections.push({ label: 'visit-realizations', state: 'populated' });
        if (save) selections.push(
          { label: 'preference-save-release-0', state: 'populated' },
          { label: 'progress-summary', state: 'populated' },
          { label: ownReleaseLabel(persona), state: 'populated' },
        );
      }
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
    const actions = actingSubject ? createReaderStore({ actingSubject, main: () => main }) : undefined;
    void readBooksEditionPage(reads, id, locale).then(page => {
      if (!mounted) return;
      if (!page.header.ok) { setFault(`Work header: ${page.header.failure}`); return; }
      setView({ ...page, actions });
    });
    const refresh = (event: Event) => {
      const detail = (event as CustomEvent<{ work: string; preference: EditionPreference | null }>).detail;
      if (detail.work.slice(-36) !== id || !actions?.tracking) return;
      void readBooksEditionStatus({ ...reads,
        readProgressSummary: (resource, language) => actions.tracking!.series(resource, language),
      }, id, locale, { ok: true, data: detail.preference }).then(status => {
        if (mounted) setView(current => current ? { ...current, status } : current);
      });
    };
    window.addEventListener(EDITION_SAVED, refresh);
    return () => { mounted = false; window.removeEventListener(EDITION_SAVED, refresh); replay.dispose(); };
  }, [persona, state, saved, locale, save]);
  const t = messages[locale];
  if (fault) return <pre role="alert" className="whitespace-pre-wrap break-words p-6">{fault}</pre>;
  if (!view) return <p role="status" aria-busy="true" className="p-6">{t.loading}</p>;
  if (!view.header.ok) return null;
  return <ReaderActionsProvider signedIn={persona !== 'visitor'} signInHref="/auth/start" actions={view.actions}>
    <main className="mx-auto grid min-w-0 max-w-3xl grid-cols-1 gap-6 px-4 py-6" lang={locale}>
      <h1 className="break-words font-semibold text-2xl" lang={view.header.data.title.language}>{view.header.data.title.value}</h1>
      <IdentityStatus {...view.status} locale={locale} messages={t} />
      <BooksEditionPage work={view.header.data.id} releases={view.releases} signInHref="/auth/start"
        editionsHref={editionsHref(view.header.data.id.slice(-36))} locale={locale} messages={t} />
    </main>
  </ReaderActionsProvider>;
}

const meta = { title: 'Work page/Manga hub recorded', component: RecordedMangaHub,
  args: { persona: 'member', state: 'populated', saved: true, locale: 'en', save: false },
  globals: { viewport: { value: 'desktop' } }, parameters: { controls: { disable: true } },
} satisfies Meta<typeof RecordedMangaHub>;
export default meta;
type Story = StoryObj<typeof meta>;

async function compare(canvasElement: HTMLElement, persona: Persona) {
  const canvas = within(canvasElement);
  const header = sample(persona, 'work').answer as WorkHeader;
  await expect(canvas.findByRole('heading', { level: 1, name: header.title.value })).resolves.toBeVisible();
  await document.fonts.ready;
  const releases = sample(persona, 'visit-releases').answer as BooksReleasePage;
  for (const release of releases.items) {
    const link = canvas.getAllByRole('link', { name: release.title.value })
      .find(item => item.getAttribute('href')?.endsWith(releaseHref(release.id)));
    await expect(link).toBeVisible();
    await expect(link!.closest('article')!).toHaveTextContent(release.publisher!);
  }
  await expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(window.innerWidth);
  return canvas;
}

function chosenName(persona: SignedIn, locale: UiLocale): { name: string; other: string } {
  const label = ownReleaseLabel(persona);
  const release = sample(persona, label).answer as Release;
  const other = (sample(persona, label === 'release-0' ? 'release-1' : 'release-0').answer as Release).title.value;
  return { name: releaseChoiceName(release, locale, copyOf(locale)), other };
}

export const Loading: Story = { args: { state: 'loading', saved: false }, async play({ canvasElement }) {
  await expect(within(canvasElement).getByRole('status')).toHaveTextContent(messages.en.loading);
} };
export const LoadingPhone: Story = { ...Loading, globals: { viewport: { value: 'phone' } } };

export const Visitor: Story = { args: { persona: 'visitor', saved: false }, async play({ canvasElement }) {
  const canvas = await compare(canvasElement, 'visitor');
  await expect(canvas.getByRole('link', { name: messages.en.signInForEdition })).toBeVisible();
  await expect(canvas.queryByRole('button', { name: copyOf('en').savePreference })).not.toBeInTheDocument();
  await expect(canvas.queryByRole('list', { name: messages.en.yourEdition })).not.toBeInTheDocument();
} };
export const VisitorPhone: Story = { ...Visitor, globals: { viewport: { value: 'phone' } } };

async function ownEdition(canvasElement: HTMLElement, persona: SignedIn, locale: UiLocale) {
  const canvas = await compare(canvasElement, persona);
  const { name, other } = chosenName(persona, locale);
  const status = canvas.getByRole('list', { name: messages[locale].yourEdition });
  await expect(status).toHaveTextContent(name);
  await expect(status).not.toHaveTextContent(other);
  await expect(canvas.getByRole('combobox', { name: copyOf(locale).edition })).toHaveTextContent(name);
  await expect(canvas.queryByRole('link', { name: messages[locale].signInForEdition })).not.toBeInTheDocument();
}

export const Member: Story = { async play({ canvasElement, args }) {
  await ownEdition(canvasElement, 'member', args.locale);
} };
export const MemberPhone: Story = { ...Member, globals: { viewport: { value: 'phone' } } };
export const MemberChinesePhone: Story = { ...Member, args: { locale: 'zh-Hans' },
  globals: { locale: 'zh-Hans', viewport: { value: 'phone' } } };

export const OwnerEmpty: Story = { args: { persona: 'owner', saved: false }, async play({ canvasElement }) {
  const canvas = await compare(canvasElement, 'owner');
  const t = copyOf('en');
  await expect(canvas.queryByRole('list', { name: messages.en.yourEdition })).not.toBeInTheDocument();
  await expect(canvas.queryByRole('link', { name: messages.en.signInForEdition })).not.toBeInTheDocument();
  await expect(canvas.getByRole('combobox', { name: t.edition })).toHaveTextContent(t.anyEdition);
  await expect(canvas.getByRole('button', { name: t.savePreference })).toBeVisible();
} };
export const OwnerEmptyPhone: Story = { ...OwnerEmpty, globals: { viewport: { value: 'phone' } } };

export const MemberSave: Story = { args: { saved: false, save: true }, async play({ canvasElement }) {
  const canvas = await compare(canvasElement, 'member');
  const t = copyOf('en');
  const saved = sample('member', 'preference-save-release-0').body as { edition: { resource: string } };
  const releases = sample('member', 'visit-releases').answer as BooksReleasePage;
  const release = releases.items.find(item => item.id === saved.edition.resource)!;
  const other = releases.items.find(item => item.id !== saved.edition.resource)!.title.value;
  const name = releaseChoiceName(release as Release, 'en', t);
  await userEvent.click(canvas.getByRole('combobox', { name: t.language }));
  await chooseOption(canvas, languageName('ja', 'en'));
  await userEvent.click(canvas.getByRole('combobox', { name: t.edition }));
  await chooseOption(canvas, name);
  await userEvent.click(canvas.getByRole('button', { name: t.savePreference }));
  await expect(canvas.findByRole('status')).resolves.toHaveTextContent(t.preferenceSaved);
  await waitFor(() => expect(canvas.getByRole('list', { name: messages.en.yourEdition })).toHaveTextContent(name));
  await expect(canvas.getByRole('list', { name: messages.en.yourEdition })).not.toHaveTextContent(other);
  await expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(window.innerWidth);
} };
export const MemberSavePhone: Story = { ...MemberSave, globals: { viewport: { value: 'phone' } } };
