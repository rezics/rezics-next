import { type ComponentProps, useEffect, useState } from 'react';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, waitFor, within } from 'storybook/test';
import type { AnswerPersona, AnswerRecord } from '../../../../scripts/api/answer-record.ts';
import hub from '../../../../tests/qa/fixtures/outcomes/books/work-hub-and-edition-choice.json';
import ambiguous from '../../../../tests/qa/fixtures/outcomes/books/choose-among-ambiguous-editions-of-one-work-ambiguous-editions.json';
import formats from '../../../../tests/qa/fixtures/outcomes/books/choose-among-mixed-formats-mixed-formats.json';
import type { UiLocale } from '../../i18n/define.ts';
import { BFF_PREFIX, browserMainApi } from '../api/browser.ts';
import { ReaderActionsProvider, type ReaderActions } from '../catalogue/reader-actions.tsx';
import { createReaderStore } from '../catalogue/reader-store.ts';
import { recordedFetch, type RecordedSelection } from '../stories/recorded-fetch.ts';
import { chooseOption } from '../stories/choose-option.ts';
import { releaseChoiceName } from '../tracking/display.ts';
import { copyOf } from '../tracking/messages.ts';
import { EDITION_SAVED } from '../tracking/series-progress-panel.tsx';
import type { EditionPreference, Release } from '../tracking/types.ts';
import { booksEditionReads, type BooksReleasePage } from './books-edition-page.read.ts';
import { BooksEditionPage } from './books-edition-page.tsx';
import { EditionsSection } from './editions.tsx';
import { messages } from './messages.ts';
import { IdentityStatus } from './primary-action.tsx';
import { editionsHref, releaseHref } from '../work-levels/route.ts';
import type { Loaded, WorkHeader } from './types.ts';

type Row = 'hub' | 'ambiguous' | 'formats';
const records: Record<Row, AnswerRecord> = { hub: hub as AnswerRecord, ambiguous: ambiguous as AnswerRecord,
  formats: formats as AnswerRecord };
const sample = (row: Row, persona: AnswerPersona, label: string) => {
  const found = records[row].personas[persona].find(value => value.label === label);
  if (!found) throw new Error(`Missing Books answer: ${row}/${persona}/${label}`);
  return found;
};
interface Props { row: Row; persona: 'visitor' | 'member'; state: 'populated' | 'loading' | 'empty' | 'stale';
  saved: boolean; locale: UiLocale }
interface View { header: WorkHeader; releases: Loaded<BooksReleasePage>; actions?: ReaderActions;
  preference: Loaded<EditionPreference | null> | null; progress: ComponentProps<typeof IdentityStatus>['progress'] }

/** The frame reads through the same seam as read.ts; the chooser uses the real reader store and tracking API. */
function RecordedBooksEdition({ row, persona, state, saved, locale }: Props) {
  const [view, setView] = useState<View | null>(null);
  const [fault, setFault] = useState<string | null>(null);
  useEffect(() => {
    setView(null);
    setFault(null);
    const empty = state === 'empty';
    const headerLabel = empty ? 'work-without-editions' : 'work-header';
    const headerSample = sample(row, persona, headerLabel);
    const actingSubject = new URL(headerSample.path, 'https://recorded.invalid').searchParams.get('actingSubject') ?? undefined;
    const id = new URL(headerSample.path, 'https://recorded.invalid').pathname.split('/').at(-1)!;
    const releaseLabel = empty ? 'release-choices-empty' : row === 'hub' && persona === 'member'
      ? 'availability-releases' : 'release-choices';
    const preferenceLabel = saved ? row === 'ambiguous' ? 'own-preference-audiobook' : 'own-preference-ebook'
      : 'own-preference-before';
    const selections: RecordedSelection[] = [
      { label: headerLabel, state: state === 'loading' ? 'loading' : 'populated' },
      { label: releaseLabel, state: empty ? 'empty' : 'populated' },
    ];
    if (persona === 'member' && !empty) selections.push(
      { label: 'realization-choices', state: 'populated' },
      { label: preferenceLabel, state: saved ? 'populated' : 'empty' },
      { label: row === 'hub' ? 'release-detail-ebook' : 'selected-release-ebook', state: 'populated' },
      { label: state === 'stale' ? 'save-preference-stale' : 'save-preference-ebook',
        state: state === 'stale' ? 'error' : 'populated' },
    );
    if (row === 'hub' && persona === 'member' && !empty)
      selections.push({ label: 'own-progress-summary', state: 'populated' });
    if (row === 'ambiguous' && saved) selections.push({ label: 'selected-release-audiobook', state: 'populated' });
    const replay = recordedFetch(records[row], persona, selections, { pathPrefix: BFF_PREFIX });
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
    void Promise.all([reads.readWorkHeader(id), reads.readReleases(id),
      !empty && actingSubject ? reads.readEditionPreference(id) : Promise.resolve(null),
      saved && row === 'hub' ? reads.readProgressSummary(id) : Promise.resolve(null),
    ]).then(([header, releases, preference, progress]) => {
      if (!mounted) return;
      if (!header.ok) { setFault(`Work header: ${header.failure}`); return; }
      setView({ header: header.data, releases, actions, preference, progress });
    });
    const refresh = (event: Event) => {
      const detail = (event as CustomEvent<{ work: string; preference: EditionPreference | null }>).detail;
      if (detail.work.slice(-36) !== id || !actions?.tracking) return;
      const progress = row === 'hub' ? actions.tracking.series(detail.work) : Promise.resolve(null);
      void progress.then(answer => {
        if (mounted) setView(current => current ? { ...current,
          preference: { ok: true, data: detail.preference }, progress: answer } : current);
      });
    };
    window.addEventListener(EDITION_SAVED, refresh);
    return () => { mounted = false; window.removeEventListener(EDITION_SAVED, refresh); replay.dispose(); };
  }, [row, persona, state, saved]);
  const t = messages[locale];
  if (fault) return <pre role="alert" className="whitespace-pre-wrap break-words p-6">{fault}</pre>;
  if (!view) return <p role="status" aria-busy="true" className="p-6">{t.loading}</p>;
  const chosen = view.preference?.ok ? view.preference.data?.edition : null;
  const release = chosen && view.releases.ok ? view.releases.data.items.find(item => item.id === chosen.resource) : null;
  return <ReaderActionsProvider signedIn={persona === 'member'} signInHref="/auth/start" actions={view.actions}>
    <main className="mx-auto grid min-w-0 grid-cols-1 max-w-3xl gap-6 px-4 py-6" lang={locale}>
      <h1 className="break-words font-semibold text-2xl" lang={view.header.title.language}>{view.header.title.value}</h1>
      <IdentityStatus preference={view.preference} progress={view.progress}
        editionName={release ? releaseChoiceName(release, locale, copyOf(locale)) : null} locale={locale} messages={t} />
      {state === 'empty'
        ? <EditionsSection items={view.releases.ok ? view.releases.data.items : null}
          failure={view.releases.ok ? null : view.releases.failure} locale={locale} messages={t} />
        : <BooksEditionPage work={view.header.id} releases={view.releases} signInHref="/auth/start"
          editionsHref={editionsHref(view.header.id.slice(-36))} locale={locale} messages={t} />}
    </main>
  </ReaderActionsProvider>;
}

const meta = { title: 'Work page/Books editions recorded', component: RecordedBooksEdition,
  args: { row: 'hub', persona: 'member', state: 'populated', saved: false, locale: 'en' },
  globals: { viewport: { value: 'desktop' } }, parameters: { controls: { disable: true } },
} satisfies Meta<typeof RecordedBooksEdition>;
export default meta;
type Story = StoryObj<typeof meta>;

async function compare(canvasElement: HTMLElement, args: Props) {
  const canvas = within(canvasElement);
  const header = sample(args.row, args.persona, 'work-header').answer as WorkHeader;
  await expect(canvas.findByRole('heading', { level: 1, name: header.title.value })).resolves.toBeVisible();
  const label = args.row === 'hub' && args.persona === 'member' ? 'availability-releases' : 'release-choices';
  const releases = sample(args.row, args.persona, label).answer as BooksReleasePage;
  for (const release of releases.items) {
    const link = canvas.getAllByRole('link', { name: release.title.value })
      .find(item => item.getAttribute('href')?.endsWith(releaseHref(release.id)));
    await expect(link).toBeVisible();
    const article = link!.closest('article')!;
    await expect(article).toHaveTextContent(release.publisher!);
    await expect(article).toHaveTextContent(release.platform === 'ebook' ? copyOf(args.locale).formatEbook
      : release.platform === 'audiobook' ? copyOf(args.locale).formatAudiobook : release.platform!);
  }
  await expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(window.innerWidth);
}

async function chooseEbook(canvasElement: HTMLElement, args: Props) {
  await compare(canvasElement, args);
  const canvas = within(canvasElement);
  const t = copyOf(args.locale);
  const select = await canvas.findByRole('combobox', { name: t.edition });
  await userEvent.click(select);
  const options = canvas.getAllByRole('option');
  await expect(new Set(options.map(option => option.textContent)).size).toBe(options.length);
  const label = args.row === 'hub' ? 'availability-releases' : 'release-choices';
  const release = (sample(args.row, 'member', label).answer as BooksReleasePage).items.find(item => item.platform === 'ebook')!;
  await chooseOption(canvas, releaseChoiceName(release as Release, args.locale, t));
  await userEvent.click(canvas.getByRole('button', { name: t.savePreference }));
}

export const Visitor: Story = { args: { persona: 'visitor' }, async play({ canvasElement, args }) {
  await compare(canvasElement, args);
  await expect(within(canvasElement).getByRole('link', { name: messages.en.signInForEdition })).toBeVisible();
  await expect(within(canvasElement).queryByRole('button', { name: copyOf('en').savePreference })).not.toBeInTheDocument();
} };
export const VisitorPhone: Story = { ...Visitor, globals: { viewport: { value: 'phone' } } };
export const VisitorMixedFormats: Story = { ...Visitor, args: { row: 'formats', persona: 'visitor' } };
export const VisitorMixedFormatsPhone: Story = { ...VisitorMixedFormats, globals: { viewport: { value: 'phone' } } };

export const SameTitleSave: Story = { args: { row: 'ambiguous', saved: true }, async play({ canvasElement, args }) {
  await chooseEbook(canvasElement, args);
  await expect(within(canvasElement).findByRole('status')).resolves.toHaveTextContent(copyOf(args.locale).preferenceSaved);
  await expect(within(canvasElement).getByRole('combobox', { name: copyOf(args.locale).edition }))
    .toHaveTextContent(copyOf(args.locale).formatEbook);
  await expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(window.innerWidth);
  const value = within(canvasElement).getByRole('combobox', { name: copyOf(args.locale).edition })
    .querySelector<HTMLElement>('[data-part=value-text]')!;
  await expect(value.scrollWidth).toBeLessThanOrEqual(value.clientWidth);
} };
export const SameTitleSavePhone: Story = { ...SameTitleSave, globals: { viewport: { value: 'phone' } } };
export const MixedFormatsSave: Story = { ...SameTitleSave, args: { row: 'formats', saved: false } };
export const MixedFormatsSavePhone: Story = { ...MixedFormatsSave, globals: { viewport: { value: 'phone' } } };

export const SavedHubProgress: Story = { args: { saved: true }, async play({ canvasElement, args }) {
  await compare(canvasElement, args);
  const t = copyOf(args.locale);
  const status = within(canvasElement).getByRole('list', { name: messages[args.locale].yourEdition });
  await expect(status).toHaveTextContent(t.notStarted);
  await expect(status).toHaveTextContent(t.formatEbook);
  await expect(within(canvasElement).findByRole('combobox', { name: t.edition })).resolves.toHaveTextContent(t.formatEbook);
  await expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(window.innerWidth);
} };
export const HubSaveProgress: Story = { async play({ canvasElement, args }) {
  await chooseEbook(canvasElement, args);
  await waitFor(() => expect(within(canvasElement).getByRole('list', { name: messages.en.yourEdition }))
    .toHaveTextContent(copyOf('en').notStarted));
} };
export const SavedHubChinesePhone: Story = { ...SavedHubProgress, args: { saved: true, locale: 'zh-Hans' },
  globals: { locale: 'zh-Hans', viewport: { value: 'phone' } } };

export const Loading: Story = { args: { state: 'loading' }, async play({ canvasElement }) {
  await expect(within(canvasElement).getByRole('status')).toHaveTextContent(messages.en.loading);
} };
export const EmptyInventory: Story = { args: { state: 'empty' }, async play({ canvasElement }) {
  const header = sample('hub', 'member', 'work-without-editions').answer as WorkHeader;
  await expect(within(canvasElement).findByRole('heading', { level: 1, name: header.title.value })).resolves.toBeVisible();
  await expect(within(canvasElement).getByText('No release of this Work is on record yet.')).toBeVisible();
  await expect(within(canvasElement).queryByRole('combobox')).not.toBeInTheDocument();
} };
export const StaleRefusal: Story = { args: { state: 'stale' }, async play({ canvasElement, args }) {
  await chooseEbook(canvasElement, args);
  await expect(within(canvasElement).findByRole('alert')).resolves.toHaveTextContent(copyOf('en').preferenceStale);
  await expect(within(canvasElement).queryByText(copyOf('en').preferenceSaved)).not.toBeInTheDocument();
} };
