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
import type { Release } from '../tracking/types.ts';
import { editionsHref, releaseHref } from '../work-levels/route.ts';
import { booksEditionReads, readBooksEditionPage, type BooksReleasePage } from './books-edition-page.read.ts';
import { BooksEditionPage } from './books-edition-page.tsx';
import { messages } from './messages.ts';
import { IdentityStatus } from './primary-action.tsx';
import type { WorkHeader } from './types.ts';
import { YourEdition } from './your-edition.tsx';

const row = record as AnswerRecord;
type Persona = 'visitor' | 'member';
interface Props { persona: Persona; state: 'populated' | 'loading' | 'stale'; locale: UiLocale }
type MemberView = Awaited<ReturnType<typeof readBooksEditionPage>> & { actions?: ReaderActions };
type Shown = { kind: 'visitor'; header: WorkHeader } | { kind: 'member'; page: MemberView };

function sample(persona: AnswerPersona, label: string) {
  const found = row.personas[persona].find(item => item.label === label);
  if (!found) throw new Error(`Missing visual-novels answer: ${persona}/${label}`);
  return found;
}

/** The Work hub's edition slice, read through the same seam as the server page. */
function RecordedVisualNovelsHub({ persona, state, locale }: Props) {
  const [shown, setShown] = useState<Shown | null>(null);
  const [fault, setFault] = useState<string | null>(null);
  useEffect(() => {
    setShown(null);
    setFault(null);
    const header = sample(persona, 'primary-get-works-0');
    const actingSubject = new URL(header.path, 'https://recorded.invalid').searchParams.get('actingSubject') ?? undefined;
    const id = new URL(header.path, 'https://recorded.invalid').pathname.split('/').at(-1)!;
    const selections: RecordedSelection[] = [
      { label: header.label, state: state === 'loading' ? 'loading' : 'populated' },
    ];
    // The production release read asks for limit 20. Only the member's hub read recorded that page.
    if (persona === 'member') {
      selections.push(
        { label: 'hub-releases', state: 'populated' },
        { label: 'hub-realizations', state: 'populated' },
        { label: 'primary-get-me-edition-preferences-1', state: 'empty' },
        { label: 'hub-progress-empty', state: 'populated' },
      );
      if (state === 'stale') selections.push({ label: 'primary-put-me-edition-preferences-3', state: 'error' });
    }
    const replay = recordedFetch(row, persona, selections, { pathPrefix: BFF_PREFIX });
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
    const pending = persona === 'member'
      ? readBooksEditionPage(reads, id, locale).then(page => {
        if (!page.header.ok) return { fault: `Work header: ${page.header.failure}` } as const;
        return { shown: { kind: 'member' as const, page: { ...page, actions } } } as const;
      })
      : reads.readWorkHeader(id).then(read => {
        if (!read.ok) return { fault: `Work header: ${read.failure}` } as const;
        return { shown: { kind: 'visitor' as const, header: read.data } } as const;
      });
    void pending.then(result => {
      if (!mounted) return;
      if ('fault' in result) setFault(result.fault);
      else setShown(result.shown);
    });
    return () => { mounted = false; replay.dispose(); };
  }, [persona, state, locale]);
  const t = messages[locale];
  if (fault) return <pre role="alert" className="whitespace-pre-wrap break-words p-6">{fault}</pre>;
  if (!shown) return <p role="status" aria-busy="true" className="p-6">{t.loading}</p>;
  const header = shown.kind === 'visitor' ? shown.header : shown.page.header.ok ? shown.page.header.data : null;
  if (!header) return null;
  return <ReaderActionsProvider signedIn={shown.kind === 'member'} signInHref="/auth/start"
    actions={shown.kind === 'member' ? shown.page.actions : undefined}>
    <main className="mx-auto grid min-w-0 max-w-3xl grid-cols-1 gap-6 px-4 py-6" lang={locale}>
      <h1 className="break-words font-semibold text-2xl" lang={header.title.language}>{header.title.value}</h1>
      {shown.kind === 'member' && shown.page.header.ok ? <>
        <IdentityStatus {...shown.page.status} locale={locale} messages={t} />
        <BooksEditionPage work={shown.page.header.data.id} releases={shown.page.releases} signInHref="/auth/start"
          editionsHref={editionsHref(shown.page.header.data.id.slice(-36))} locale={locale} messages={t} />
      </> : <YourEdition work={header.id} signInHref="/auth/start" locale={locale} messages={t} />}
    </main>
  </ReaderActionsProvider>;
}

const meta = { title: 'Work page/Visual novels hub recorded', component: RecordedVisualNovelsHub,
  args: { persona: 'member', state: 'populated', locale: 'en' },
  globals: { viewport: { value: 'desktop' } }, parameters: { controls: { disable: true } },
} satisfies Meta<typeof RecordedVisualNovelsHub>;
export default meta;
type Story = StoryObj<typeof meta>;

const phone = { viewport: { value: 'phone' } } as const;

async function expectTitle(canvasElement: HTMLElement, persona: Persona) {
  const header = sample(persona, 'primary-get-works-0').answer as WorkHeader;
  await expect(within(canvasElement).findByRole('heading', { level: 1, name: header.title.value })).resolves.toBeVisible();
  return header;
}

async function expectReleases(canvasElement: HTMLElement, locale: UiLocale) {
  const canvas = within(canvasElement);
  const releases = sample('member', 'hub-releases').answer as BooksReleasePage;
  for (const release of releases.items) {
    const link = canvas.getAllByRole('link', { name: release.title.value })
      .find(item => item.getAttribute('href')?.endsWith(releaseHref(release.id)));
    await expect(link).toBeVisible();
    const article = link!.closest('article')!;
    await expect(article).toHaveTextContent(release.publisher!);
    await expect(article).toHaveTextContent(String(release.publicationYear));
    if (release.platform) await expect(article).toHaveTextContent(release.platform);
  }
  await expect(canvas.getByRole('list', { name: messages[locale].yourEdition }))
    .toHaveTextContent(copyOf(locale).notStarted);
  await document.fonts.ready;
  await expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(window.innerWidth);
  return releases;
}

export const Visitor: Story = { args: { persona: 'visitor' }, async play({ canvasElement, args }) {
  await expectTitle(canvasElement, 'visitor');
  await expect(within(canvasElement).getByRole('link', { name: messages[args.locale].signInForEdition })).toBeVisible();
  await expect(within(canvasElement).queryByRole('button', { name: copyOf(args.locale).savePreference })).not.toBeInTheDocument();
  await document.fonts.ready;
  await expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(window.innerWidth);
} };
export const VisitorPhone: Story = { ...Visitor, globals: phone };
export const VisitorChinese: Story = { ...Visitor, args: { persona: 'visitor', locale: 'zh-Hans' },
  globals: { locale: 'zh-Hans' } };
export const VisitorChinesePhone: Story = { ...VisitorChinese, globals: { locale: 'zh-Hans', viewport: { value: 'phone' } } };

export const Member: Story = { async play({ canvasElement, args }) {
  await expectTitle(canvasElement, 'member');
  const releases = await expectReleases(canvasElement, args.locale);
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
} };
export const MemberPhone: Story = { ...Member, globals: phone };

export const Loading: Story = { args: { state: 'loading' }, async play({ canvasElement }) {
  await expect(within(canvasElement).getByRole('status')).toHaveTextContent(messages.en.loading);
} };
export const LoadingPhone: Story = { ...Loading, globals: phone };

export const StaleRefusal: Story = { args: { state: 'stale' }, async play({ canvasElement, args }) {
  await expectTitle(canvasElement, 'member');
  await expectReleases(canvasElement, args.locale);
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
