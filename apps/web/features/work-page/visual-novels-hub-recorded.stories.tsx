import { useEffect, useState } from 'react';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, waitFor, within } from 'storybook/test';
import type { AnswerPersona, AnswerRecord } from '../../../../scripts/api/answer-record.ts';
import record from '../../../../tests/qa/fixtures/outcomes/visual-novels/work-hub-and-edition-choice.json';
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
import { editionsHref, releaseHref } from '../work-levels/route.ts';
import { booksEditionReads, readBooksEditionPage, readBooksEditionStatus, type BooksReleasePage } from './books-edition-page.read.ts';
import { BooksEditionPage } from './books-edition-page.tsx';
import { messages } from './messages.ts';
import { IdentityStatus } from './primary-action.tsx';
import type { WorkHeader } from './types.ts';

const row = record as AnswerRecord;
type Persona = 'visitor' | 'stranger' | 'member' | 'owner' | 'moderator' | 'operator';
type Chooser = Exclude<Persona, 'visitor' | 'stranger'>;
type Saved = 'none' | 'release' | 'realization';
interface Props { persona: Persona; state: 'populated' | 'loading' | 'stale' | 'save'; saved: Saved; locale: UiLocale }
type PageView = Awaited<ReturnType<typeof readBooksEditionPage>> & { actions?: ReaderActions };

/** Member's production inventory was recorded with the hub page; every other persona has the chooser page. */
function inventoryLabel(persona: Persona, kind: 'releases' | 'realizations') {
  return persona === 'member' ? `hub-${kind}` : persona === 'visitor' ? `chooser-${kind}` : `visit-chooser-${kind}`;
}

function sample(persona: AnswerPersona, label: string) {
  const found = row.personas[persona].find(item => item.label === label);
  if (!found) throw new Error(`Missing visual-novels answer: ${persona}/${label}`);
  return found;
}

/** Empty and saved progress share one path, so the page opens on the summary recorded for that state. */
function progressLabel(persona: Persona, saved: Saved, locale: UiLocale) {
  if (saved === 'realization') return 'primary-get-me-progress-summaries-0';
  if (saved === 'release') return 'chooser-progress-release';
  if (locale === 'zh-Hans' && persona === 'member') return 'hub-progress-empty-zh-Hans';
  return persona === 'member' ? 'hub-progress-empty' : 'chooser-progress-empty';
}

function preferenceLabel(persona: Persona, saved: Saved) {
  if (persona === 'stranger') return 'chooser-preference-empty';
  if (saved === 'release') return 'primary-get-me-edition-preferences-2';
  if (saved === 'realization') return 'primary-get-me-edition-preferences-3';
  return 'primary-get-me-edition-preferences-1';
}

function selectionsFor(persona: Persona, state: Props['state'], saved: Saved, locale: UiLocale): RecordedSelection[] {
  const selections: RecordedSelection[] = [
    { label: 'primary-get-works-0', state: state === 'loading' ? 'loading' : 'populated' },
    { label: inventoryLabel(persona, 'releases'), state: 'populated' },
  ];
  if (persona === 'visitor') return selections;
  selections.push(
    { label: inventoryLabel(persona, 'realizations'), state: 'populated' },
    { label: preferenceLabel(persona, state === 'loading' ? 'none' : saved), state: saved === 'none' || state === 'loading' ? 'empty' : 'populated' },
    { label: progressLabel(persona, state === 'loading' ? 'none' : saved, locale), state: 'populated' },
  );
  if (state === 'loading') return selections;
  if (saved === 'release' || (state === 'save' && saved === 'none')) {
    selections.push({ label: 'saved-release-detail', state: 'populated' });
  }
  if (saved === 'realization' || (state === 'save' && saved === 'release')) {
    selections.push({ label: 'saved-realization-detail', state: 'populated' });
  }
  if (state === 'save' && saved === 'none') selections.push({ label: 'primary-put-me-edition-preferences-1', state: 'populated' });
  if (state === 'save' && saved === 'release') selections.push({ label: 'primary-put-me-edition-preferences-4', state: 'populated' });
  if (state === 'stale') selections.push({ label: 'primary-put-me-edition-preferences-3', state: 'error' });
  return selections;
}

/** The Work hub's edition slice, read through the same seam as the server page. */
function RecordedVisualNovelsHub({ persona, state, saved, locale }: Props) {
  const [shown, setShown] = useState<PageView | null>(null);
  const [fault, setFault] = useState<string | null>(null);
  useEffect(() => {
    setShown(null);
    setFault(null);
    const header = sample(persona, 'primary-get-works-0');
    const actingSubject = new URL(header.path, 'https://recorded.invalid').searchParams.get('actingSubject') ?? undefined;
    const id = new URL(header.path, 'https://recorded.invalid').pathname.split('/').at(-1)!;
    const replay = recordedFetch(row, persona, selectionsFor(persona, state, saved, locale), { pathPrefix: BFF_PREFIX });
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
      setShown({ ...page, actions });
    });
    const refresh = (event: Event) => {
      const detail = (event as CustomEvent<{ work: string; preference: EditionPreference | null }>).detail;
      if (detail.work.slice(-36) !== id) return;
      void readBooksEditionStatus(reads, id, locale, { ok: true, data: detail.preference }).then(status => {
        if (mounted) setShown(current => current ? { ...current, status } : current);
      });
    };
    window.addEventListener(EDITION_SAVED, refresh);
    return () => { mounted = false; window.removeEventListener(EDITION_SAVED, refresh); replay.dispose(); };
  }, [persona, state, saved, locale]);
  const t = messages[locale];
  if (fault) return <pre role="alert" className="whitespace-pre-wrap break-words p-6">{fault}</pre>;
  if (!shown || !shown.header.ok) return <p role="status" aria-busy="true" className="p-6">{t.loading}</p>;
  return <ReaderActionsProvider signedIn={persona !== 'visitor'} signInHref="/auth/start" actions={shown.actions}>
    <main className="mx-auto grid min-w-0 max-w-3xl grid-cols-1 gap-6 px-4 py-6" lang={locale}>
      <h1 className="break-words font-semibold text-2xl" lang={shown.header.data.title.language}>{shown.header.data.title.value}</h1>
      <IdentityStatus {...shown.status} locale={locale} messages={t} />
      <BooksEditionPage work={shown.header.data.id} releases={shown.releases} signInHref="/auth/start"
        editionsHref={editionsHref(shown.header.data.id.slice(-36))} locale={locale} messages={t} />
    </main>
  </ReaderActionsProvider>;
}

const meta = { title: 'Work page/Visual novels hub recorded', component: RecordedVisualNovelsHub,
  args: { persona: 'member', state: 'populated', saved: 'none', locale: 'en' },
  globals: { viewport: { value: 'desktop' } }, parameters: { controls: { disable: true } },
} satisfies Meta<typeof RecordedVisualNovelsHub>;
export default meta;
type Story = StoryObj<typeof meta>;

const phone = { viewport: { value: 'phone' } } as const;

function recordedRelease(persona: Persona, label: string) {
  const resource = (sample(persona, label).body as { edition: { resource: string } }).edition.resource;
  const release = (sample(persona, inventoryLabel(persona, 'releases')).answer as BooksReleasePage).items
    .find(item => item.id === resource);
  if (!release) throw new Error(`Recorded release ${resource} is absent for ${persona}`);
  return release as Release;
}

function releaseName(persona: Persona, locale: UiLocale) {
  return releaseChoiceName(sample(persona, 'saved-release-detail').answer as Release, locale, copyOf(locale));
}

function realizationName(persona: Persona, locale: UiLocale) {
  const detail = sample(persona, 'saved-realization-detail').answer as { language: string; kind: string };
  const t = copyOf(locale);
  const language = languageName(detail.language, locale);
  return detail.kind === 'original' ? t.originalText({ language }) : t.translationText({ language });
}

async function expectTitle(canvasElement: HTMLElement, persona: Persona) {
  const header = sample(persona, 'primary-get-works-0').answer as WorkHeader;
  await expect(within(canvasElement).findByRole('heading', { level: 1, name: header.title.value })).resolves.toBeVisible();
  return header;
}

async function expectReleases(canvasElement: HTMLElement, persona: Persona, locale: UiLocale, status: boolean) {
  const canvas = within(canvasElement);
  const releases = sample(persona, inventoryLabel(persona, 'releases')).answer as BooksReleasePage;
  for (const release of releases.items) {
    const link = canvas.getAllByRole('link', { name: release.title.value })
      .find(item => item.getAttribute('href')?.endsWith(releaseHref(release.id)));
    await expect(link).toBeVisible();
    const article = link!.closest('article')!;
    await expect(article).toHaveTextContent(release.publisher!);
    await expect(article).toHaveTextContent(String(release.publicationYear));
    if (release.platform) await expect(article).toHaveTextContent(release.platform);
  }
  if (status) await expect(canvas.getByRole('list', { name: messages[locale].yourEdition }))
    .toHaveTextContent(copyOf(locale).notStarted);
  await document.fonts.ready;
  await expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(window.innerWidth);
  return releases;
}

async function expectOwnChooser(canvasElement: HTMLElement, args: Props) {
  await expectTitle(canvasElement, args.persona);
  const releases = await expectReleases(canvasElement, args.persona, args.locale, true);
  const canvas = within(canvasElement);
  const t = copyOf(args.locale);
  await userEvent.click(await canvas.findByRole('combobox', { name: t.edition }));
  const options = canvas.getAllByRole('option');
  await expect(new Set(options.map(option => option.textContent)).size).toBe(options.length);
  const original = t.originalText({ language: languageName('en', args.locale) });
  const names = [original, ...releases.items.map(release => releaseChoiceName(release as Release, args.locale, t))];
  for (const name of names) {
    await waitFor(() => expect(canvas.getByRole('option', { name })).toBeVisible());
  }
  await userEvent.keyboard('{Escape}');
}

async function expectSavedRelease(canvasElement: HTMLElement, args: Props) {
  await expectTitle(canvasElement, args.persona);
  await expectReleases(canvasElement, args.persona, args.locale, true);
  const canvas = within(canvasElement);
  const name = releaseName(args.persona, args.locale);
  const status = canvas.getByRole('list', { name: messages[args.locale].yourEdition });
  await expect(status).toHaveTextContent(name);
  await expect(await canvas.findByRole('combobox', { name: copyOf(args.locale).edition })).toHaveTextContent(name);
  return name;
}

async function chooseRecorded(canvas: ReturnType<typeof within>, locale: UiLocale, name: string) {
  const t = copyOf(locale);
  await userEvent.click(await canvas.findByRole('combobox', { name: t.edition }));
  await chooseOption(canvas, name);
  await userEvent.click(canvas.getByRole('button', { name: t.savePreference }));
  const saved = await canvas.findByText(t.preferenceSaved);
  await expect(saved).toHaveAttribute('role', 'status');
  await expect(saved).toBeVisible();
}

export const Visitor: Story = { args: { persona: 'visitor' }, async play({ canvasElement, args }) {
  await expectTitle(canvasElement, 'visitor');
  await expectReleases(canvasElement, 'visitor', args.locale, false);
  await expect(within(canvasElement).getByRole('link', { name: messages[args.locale].signInForEdition })).toBeVisible();
  await expect(within(canvasElement).queryByRole('button', { name: copyOf(args.locale).savePreference })).not.toBeInTheDocument();
  await expect(within(canvasElement).queryByRole('list', { name: messages[args.locale].yourEdition })).not.toBeInTheDocument();
} };
export const VisitorPhone: Story = { ...Visitor, globals: phone };
export const VisitorChinese: Story = { ...Visitor, args: { persona: 'visitor', locale: 'zh-Hans' },
  globals: { locale: 'zh-Hans' } };
export const VisitorChinesePhone: Story = { ...VisitorChinese, globals: { locale: 'zh-Hans', viewport: { value: 'phone' } } };

export const Member: Story = { play: async ({ canvasElement, args }) => { await expectOwnChooser(canvasElement, args); } };
export const MemberPhone: Story = { ...Member, globals: phone };
export const Stranger: Story = { args: { persona: 'stranger' }, play: Member.play };
export const StrangerPhone: Story = { ...Stranger, globals: phone };
export const Owner: Story = { args: { persona: 'owner' }, play: Member.play };
export const OwnerPhone: Story = { ...Owner, globals: phone };
export const Moderator: Story = { args: { persona: 'moderator' }, play: Member.play };
export const ModeratorPhone: Story = { ...Moderator, globals: phone };
export const Operator: Story = { args: { persona: 'operator' }, play: Member.play };
export const OperatorPhone: Story = { ...Operator, globals: phone };

export const MemberChinese: Story = { args: { persona: 'member', locale: 'zh-Hans' },
  globals: { locale: 'zh-Hans' }, async play({ canvasElement, args }) {
    await expectTitle(canvasElement, 'member');
    await expectReleases(canvasElement, 'member', args.locale, true);
    const canvas = within(canvasElement);
    const t = copyOf(args.locale);
    const select = await canvas.findByRole('combobox', { name: t.edition });
    await expect(select).toHaveTextContent(t.anyEdition);
    await userEvent.click(select);
    await expect(canvas.getAllByRole('option')).toHaveLength(1);
    await waitFor(() => expect(canvas.getByRole('option', { name: t.anyEdition })).toBeVisible());
    await userEvent.keyboard('{Escape}');
    await expect(canvas.queryByRole('alert')).not.toBeInTheDocument();
  } };
export const MemberChinesePhone: Story = { ...MemberChinese, globals: { locale: 'zh-Hans', viewport: { value: 'phone' } } };

export const Loading: Story = { args: { state: 'loading' }, async play({ canvasElement }) {
  await expect(within(canvasElement).getByRole('status')).toHaveTextContent(messages.en.loading);
} };
export const LoadingPhone: Story = { ...Loading, globals: phone };

export const StaleRefusal: Story = { args: { state: 'stale' }, async play({ canvasElement, args }) {
  await expectTitle(canvasElement, 'member');
  await expectReleases(canvasElement, 'member', args.locale, true);
  const canvas = within(canvasElement);
  const t = copyOf(args.locale);
  await userEvent.click(await canvas.findByRole('combobox', { name: t.edition }));
  await chooseOption(canvas, t.originalText({ language: languageName('en', args.locale) }));
  await userEvent.click(canvas.getByRole('button', { name: t.savePreference }));
  await expect(canvas.findByRole('alert')).resolves.toHaveTextContent(t.preferenceStale);
  await expect(canvas.queryByText(t.preferenceSaved)).not.toBeInTheDocument();
  await expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(window.innerWidth);
} };
export const StaleRefusalPhone: Story = { ...StaleRefusal, globals: phone };

const saveRelease: Story['play'] = async ({ canvasElement, args }) => {
  await expectOwnChooser(canvasElement, args);
  const canvas = within(canvasElement);
  const listed = recordedRelease(args.persona, 'primary-put-me-edition-preferences-1');
  await chooseRecorded(canvas, args.locale, releaseChoiceName(listed, args.locale, copyOf(args.locale)));
  const name = releaseName(args.persona, args.locale);
  await waitFor(() => expect(canvas.getByRole('list', { name: messages[args.locale].yourEdition })).toHaveTextContent(name));
  await expect(canvas.getByRole('combobox', { name: copyOf(args.locale).edition })).toHaveTextContent(name);
  await expect(canvas.queryByRole('alert')).not.toBeInTheDocument();
  await expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(window.innerWidth);
};

const saveRealization: Story['play'] = async ({ canvasElement, args }) => {
  await expectSavedRelease(canvasElement, args);
  const canvas = within(canvasElement);
  await chooseRecorded(canvas, args.locale, realizationName(args.persona, args.locale));
  const preference = sample(args.persona, 'primary-put-me-edition-preferences-4').answer as EditionPreference;
  const language = languageName(preference.language, args.locale);
  const status = () => canvas.getByRole('list', { name: messages[args.locale].yourEdition });
  await waitFor(() => expect(status()).toHaveTextContent(language));
  await expect(status()).not.toHaveTextContent(recordedRelease(args.persona, 'primary-put-me-edition-preferences-1').title.value);
  await expect(canvas.getByRole('combobox', { name: copyOf(args.locale).edition }))
    .toHaveTextContent(realizationName(args.persona, args.locale));
  await expect(canvas.queryByRole('alert')).not.toBeInTheDocument();
  await expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(window.innerWidth);
};

const replayRealization: Story['play'] = async ({ canvasElement, args }) => {
  await expectTitle(canvasElement, args.persona);
  await expectReleases(canvasElement, args.persona, args.locale, true);
  const canvas = within(canvasElement);
  const preference = sample(args.persona, 'primary-get-me-edition-preferences-3').answer as EditionPreference;
  const status = canvas.getByRole('list', { name: messages[args.locale].yourEdition });
  await expect(status).toHaveTextContent(languageName(preference.language, args.locale));
  await expect(status).not.toHaveTextContent(recordedRelease(args.persona, 'primary-put-me-edition-preferences-1').title.value);
  await expect(await canvas.findByRole('combobox', { name: copyOf(args.locale).edition }))
    .toHaveTextContent(realizationName(args.persona, args.locale));
  await expect(canvas.queryByRole('alert')).not.toBeInTheDocument();
};

function chooserStory(persona: Chooser, args: Partial<Props>, play: Story['play'], viewport: 'desktop' | 'phone' = 'desktop'): Story {
  return { args: { persona, ...args }, globals: viewport === 'phone' ? phone : { viewport: { value: 'desktop' } }, play };
}

export const ReleaseSaveMember: Story = chooserStory('member', { state: 'save' }, saveRelease);
export const ReleaseSaveMemberPhone: Story = chooserStory('member', { state: 'save' }, saveRelease, 'phone');
export const ReleaseSaveOwner: Story = chooserStory('owner', { state: 'save' }, saveRelease);
export const ReleaseSaveOwnerPhone: Story = chooserStory('owner', { state: 'save' }, saveRelease, 'phone');
export const ReleaseSaveModerator: Story = chooserStory('moderator', { state: 'save' }, saveRelease);
export const ReleaseSaveModeratorPhone: Story = chooserStory('moderator', { state: 'save' }, saveRelease, 'phone');
export const ReleaseSaveOperator: Story = chooserStory('operator', { state: 'save' }, saveRelease);
export const ReleaseSaveOperatorPhone: Story = chooserStory('operator', { state: 'save' }, saveRelease, 'phone');

export const SavedReleaseChinese: Story = { ...chooserStory('member', { saved: 'release', locale: 'zh-Hans' },
  async ({ canvasElement, args }) => { await expectSavedRelease(canvasElement, args); }),
  globals: { locale: 'zh-Hans', viewport: { value: 'desktop' } } };
export const SavedReleaseChinesePhone: Story = { ...SavedReleaseChinese,
  globals: { locale: 'zh-Hans', viewport: { value: 'phone' } } };

export const RealizationSaveMember: Story = chooserStory('member', { state: 'save', saved: 'release' }, saveRealization);
export const RealizationSaveMemberPhone: Story = chooserStory('member', { state: 'save', saved: 'release' }, saveRealization, 'phone');
export const RealizationSaveOwner: Story = chooserStory('owner', { state: 'save', saved: 'release' }, saveRealization);
export const RealizationSaveOwnerPhone: Story = chooserStory('owner', { state: 'save', saved: 'release' }, saveRealization, 'phone');
export const RealizationSaveModerator: Story = chooserStory('moderator', { state: 'save', saved: 'release' }, saveRealization);
export const RealizationSaveModeratorPhone: Story = chooserStory('moderator', { state: 'save', saved: 'release' }, saveRealization, 'phone');
export const RealizationSaveOperator: Story = chooserStory('operator', { state: 'save', saved: 'release' }, saveRealization);
export const RealizationSaveOperatorPhone: Story = chooserStory('operator', { state: 'save', saved: 'release' }, saveRealization, 'phone');

export const SavedRealizationMember: Story = chooserStory('member', { saved: 'realization' }, replayRealization);
export const SavedRealizationMemberPhone: Story = chooserStory('member', { saved: 'realization' }, replayRealization, 'phone');
export const SavedRealizationOwner: Story = chooserStory('owner', { saved: 'realization' }, replayRealization);
export const SavedRealizationOwnerPhone: Story = chooserStory('owner', { saved: 'realization' }, replayRealization, 'phone');
export const SavedRealizationModerator: Story = chooserStory('moderator', { saved: 'realization' }, replayRealization);
export const SavedRealizationModeratorPhone: Story = chooserStory('moderator', { saved: 'realization' }, replayRealization, 'phone');
export const SavedRealizationOperator: Story = chooserStory('operator', { saved: 'realization' }, replayRealization);
export const SavedRealizationOperatorPhone: Story = chooserStory('operator', { saved: 'realization' }, replayRealization, 'phone');
