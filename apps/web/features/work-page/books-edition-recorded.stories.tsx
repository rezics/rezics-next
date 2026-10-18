import { useEffect, useState } from 'react';
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
import { booksEditionReads, readBooksEditionPage, readBooksEditionStatus, type BooksReleasePage } from './books-edition-page.read.ts';
import { BooksEditionPage } from './books-edition-page.tsx';
import { messages } from './messages.ts';
import { IdentityStatus } from './primary-action.tsx';
import { editionsHref, releaseHref } from '../work-levels/route.ts';
import { copyOf as levelsCopy } from '../work-levels/messages.ts';
import type { WorkHeader } from './types.ts';

type Row = 'hub' | 'ambiguous' | 'formats';
const records: Record<Row, AnswerRecord> = { hub: hub as AnswerRecord, ambiguous: ambiguous as AnswerRecord,
  formats: formats as AnswerRecord };
const sample = (row: Row, persona: AnswerPersona, label: string) => {
  const found = records[row].personas[persona].find(value => value.label === label);
  if (!found) throw new Error(`Missing Books answer: ${row}/${persona}/${label}`);
  return found;
};
interface Props { row: Row; persona: 'visitor' | 'member'; state: 'populated' | 'empty' | 'loading' | 'stale';
  saved: boolean; locale: UiLocale }
type View = Awaited<ReturnType<typeof readBooksEditionPage>> & { actions?: ReaderActions };

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
    const releaseLabel = empty ? 'release-choices-empty' : row === 'hub' ? 'availability-releases' : 'release-choices';
    const preferenceLabel = row === 'formats' && !empty && !saved && state !== 'stale' ? 'own-preference-paperback' : empty ? 'edition-preference-empty' : saved ? row === 'ambiguous' ? 'own-preference-audiobook'
      : row === 'hub' ? 'own-preference-paperback' : 'own-preference-ebook'
      : 'own-preference-before';
    const selections: RecordedSelection[] = [
      { label: headerLabel, state: state === 'loading' ? 'loading' : 'populated' },
      { label: releaseLabel, state: empty ? 'empty' : 'populated' },
    ];
    if (persona === 'member') selections.push(
      { label: empty ? 'realization-choices-empty' : 'realization-choices', state: empty ? 'empty' : 'populated' },
      { label: preferenceLabel, state: !empty && (saved || preferenceLabel === 'own-preference-paperback') ? 'populated' : 'empty' },
    );
    if (persona === 'member' && !empty) selections.push(
      { label: row === 'hub' ? 'release-detail-paperback' : 'selected-release-ebook', state: 'populated' },
      { label: state === 'stale' ? 'save-preference-stale'
        : row === 'hub' ? 'save-preference-paperback' : 'save-preference-ebook',
        state: state === 'stale' ? 'error' : 'populated' },
    );
    if (persona === 'member') selections.push({ label: empty ? 'progress-summary-empty' : 'progress-in-language',
      state: empty ? 'empty' : 'populated' });
    if (persona === 'member' && row === 'formats' && preferenceLabel === 'own-preference-paperback') selections.push({ label: 'selected-release-paperback', state: 'populated' });
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
  }, [row, persona, state, saved, locale]);
  const t = messages[locale];
  if (fault) return <pre role="alert" className="whitespace-pre-wrap break-words p-6">{fault}</pre>;
  if (!view) return <p role="status" aria-busy="true" className="p-6">{t.loading}</p>;
  if (!view.header.ok) return null;
  return <ReaderActionsProvider signedIn={persona === 'member'} signInHref="/auth/start" actions={view.actions}>
    <main className="mx-auto grid min-w-0 grid-cols-1 max-w-3xl gap-6 px-4 py-6" lang={locale}>
      <h1 className="break-words font-semibold text-2xl" lang={view.header.data.title.language}>{view.header.data.title.value}</h1>
      <IdentityStatus {...view.status} locale={locale} messages={t} />
      <BooksEditionPage work={view.header.data.id} releases={view.releases} signInHref="/auth/start"
        editionsHref={editionsHref(view.header.data.id.slice(-36))} locale={locale} messages={t} />
    </main>
  </ReaderActionsProvider>;
}

const meta = { title: 'Work page/Books editions recorded', component: RecordedBooksEdition,
  args: { row: 'hub', persona: 'member', state: 'populated', saved: false, locale: 'en' },
  globals: { viewport: { value: 'desktop' } }, parameters: { controls: { disable: true },
    viewport: { options: { desktop: { name: 'Desktop (1440 × 900)', styles: { width: '1440px', height: '900px' }, type: 'desktop' } } } },
} satisfies Meta<typeof RecordedBooksEdition>;
export default meta;
type Story = StoryObj<typeof meta>;

async function compare(canvasElement: HTMLElement, args: Props) {
  const canvas = within(canvasElement);
  const header = sample(args.row, args.persona, args.state === 'empty' ? 'work-without-editions' : 'work-header').answer as WorkHeader;
  await expect(canvas.findByRole('heading', { level: 1, name: header.title.value })).resolves.toBeVisible();
  await document.fonts.ready;
  const label = args.state === 'empty' ? 'release-choices-empty' : args.row === 'hub' ? 'availability-releases' : 'release-choices';
  const releases = sample(args.row, args.persona, label).answer as BooksReleasePage;
  for (const release of releases.items) {
    const link = canvas.getAllByRole('link', { name: release.title.value })
      .find(item => item.getAttribute('href')?.endsWith(releaseHref(release.id)));
    await expect(link).toBeVisible();
    const heading = link!.closest('h3')!;
    await expect(heading.scrollWidth).toBeLessThanOrEqual(heading.clientWidth);
    const article = link!.closest('article')!;
    await expect(article).toHaveTextContent(release.publisher!);
    await expect(article).toHaveTextContent(release.platform === 'ebook' ? copyOf(args.locale).formatEbook
      : release.platform === 'audiobook' ? copyOf(args.locale).formatAudiobook : release.platform!);
  }
  await expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(window.innerWidth);
}

async function chooseRecordedEdition(canvasElement: HTMLElement, args: Props) {
  await compare(canvasElement, args);
  const canvas = within(canvasElement);
  const t = copyOf(args.locale);
  const select = await canvas.findByRole('combobox', { name: t.edition });
  await userEvent.click(select);
  const options = canvas.getAllByRole('option');
  await expect(new Set(options.map(option => option.textContent)).size).toBe(options.length);
  const label = args.row === 'hub' ? 'availability-releases' : 'release-choices';
  const release = (sample(args.row, 'member', label).answer as BooksReleasePage).items.find(item => item.platform === (args.row === 'hub' ? 'paperback' : 'ebook'))!;
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

export const SameTitleSave: Story = { args: { row: 'ambiguous', saved: false }, async play({ canvasElement, args }) {
  await chooseRecordedEdition(canvasElement, args);
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
  const preference = sample('hub', 'member', 'own-preference-paperback').answer as EditionPreference;
  const releases = sample('hub', 'member', 'availability-releases').answer as BooksReleasePage;
  const release = releases.items.find(item => item.id === preference.edition?.resource)!;
  const name = releaseChoiceName(release as Release, args.locale, t);
  await expect(status).toHaveTextContent(name);
  await expect(within(canvasElement).findByRole('combobox', { name: t.edition })).resolves.toHaveTextContent(name);
  await expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(window.innerWidth);
} };
export const HubSaveProgress: Story = { async play({ canvasElement, args }) {
  await chooseRecordedEdition(canvasElement, args);
  const preference = sample('hub', 'member', 'save-preference-paperback').answer as EditionPreference;
  const releases = sample('hub', 'member', 'availability-releases').answer as BooksReleasePage;
  const release = releases.items.find(item => item.id === preference.edition?.resource)!;
  await expect(within(canvasElement).findByRole('status')).resolves.toHaveTextContent(copyOf('en').preferenceSaved);
  await waitFor(() => expect(within(canvasElement).getByRole('list', { name: messages.en.yourEdition }))
    .toHaveTextContent(copyOf('en').notStarted));
  await waitFor(() => expect(within(canvasElement).getByRole('list', { name: messages.en.yourEdition }))
    .toHaveTextContent(releaseChoiceName(release as Release, args.locale, copyOf(args.locale))));
} };
export const SavedHubJapaneseDesktop: Story = { ...SavedHubProgress, args: { saved: true, locale: 'ja' },
  globals: { locale: 'ja', viewport: { value: 'desktop' } } };
export const SavedHubJapanesePhone: Story = { ...SavedHubJapaneseDesktop,
  globals: { locale: 'ja', viewport: { value: 'phone' } } };
export const SavedHubChinesePhone: Story = { ...SavedHubProgress, args: { saved: true, locale: 'zh-Hans' },
  globals: { locale: 'zh-Hans', viewport: { value: 'phone' } } };

export const EmptyInventory: Story = { args: { state: 'empty' }, async play({ canvasElement, args }) {
  await compare(canvasElement, args);
  const canvas = within(canvasElement);
  const t = copyOf(args.locale);
  await expect(canvas.getByText(levelsCopy(args.locale).noReleasesBody)).toBeVisible();
  await expect(canvas.queryByRole('article')).not.toBeInTheDocument();
  const status = canvas.getByRole('list', { name: messages[args.locale].yourEdition });
  await expect(within(status).getAllByRole('listitem')).toHaveLength(1);
  await expect(status).toHaveTextContent(t.notStarted);
  await userEvent.click(canvas.getByText(messages[args.locale].yourEdition, { selector: 'summary' }));
  const select = await canvas.findByRole('combobox', { name: t.edition });
  await expect(select).toHaveTextContent(t.anyEdition);
  await expect(canvas.getByRole('button', { name: t.savePreference })).toBeVisible();
  await userEvent.click(select);
  await expect(canvas.getAllByRole('option')).toHaveLength(1);
  await waitFor(() => expect(canvas.getByRole('option', { name: t.anyEdition })).toBeVisible());
  await userEvent.keyboard('{Escape}');
  await expect(canvas.queryByRole('alert')).not.toBeInTheDocument();
  await expect(canvas.queryByRole('status')).not.toBeInTheDocument();
  await expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(window.innerWidth);
} };
export const EmptyInventoryPhone: Story = { ...EmptyInventory, globals: { viewport: { value: 'phone' } } };

export const Loading: Story = { args: { state: 'loading' }, async play({ canvasElement }) {
  await expect(within(canvasElement).getByRole('status')).toHaveTextContent(messages.en.loading);
} };
export const StaleRefusal: Story = { args: { state: 'stale' }, async play({ canvasElement, args }) {
  await chooseRecordedEdition(canvasElement, args);
  await expect(within(canvasElement).findByRole('alert')).resolves.toHaveTextContent(copyOf('en').preferenceStale);
  await expect(within(canvasElement).queryByText(copyOf('en').preferenceSaved)).not.toBeInTheDocument();
} };
