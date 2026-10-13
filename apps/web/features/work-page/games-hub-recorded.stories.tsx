import { useEffect, useState } from 'react';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, within } from 'storybook/test';
import type { AnswerPersona, AnswerRecord } from '../../../../scripts/api/answer-record.ts';
import games from '../../../../tests/qa/fixtures/outcomes/games/work-hub-and-edition-choice.json';
import type { UiLocale } from '../../i18n/define.ts';
import { BFF_PREFIX, browserMainApi } from '../api/browser.ts';
import { ReaderActionsProvider } from '../catalogue/reader-actions.tsx';
import { recordedFetch, type RecordedSelection } from '../stories/recorded-fetch.ts';
import { copyOf } from '../tracking/messages.ts';
import { booksEditionReads, readBooksEditionStatus } from './books-edition-page.read.ts';
import { messages } from './messages.ts';
import { IdentityStatus } from './primary-action.tsx';
import type { WorkHeader } from './types.ts';
import { YourEdition } from './your-edition.tsx';

// The recorded release list omits the limit the production reader sends, so the
// frame shows the Work, the saved release named by its own address, and the
// sign-in refusal. It does not draw an empty or failed release list.

const record = games as AnswerRecord;
type Persona = 'visitor' | 'member';
type Mode = 'populated' | 'loading' | 'saved' | 'empty';
interface Props { persona: Persona; mode: Mode; locale: UiLocale }
type Status = Awaited<ReturnType<typeof readBooksEditionStatus>>;
interface View { header: WorkHeader; status: Status | null }

const sample = (persona: AnswerPersona, label: string) => {
  const found = record.personas[persona].find(item => item.label === label);
  if (!found) throw new Error(`Missing Games answer: ${persona}/${label}`);
  return found;
};

/** The same readers as the Work page. A held work-header request is the loading state. */
function RecordedGamesHub({ persona, mode, locale }: Props) {
  const [view, setView] = useState<View | null>(null);
  const [fault, setFault] = useState<string | null>(null);
  useEffect(() => {
    setView(null);
    setFault(null);
    const header = sample(persona, 'work-header');
    const actingSubject = new URL(header.path, 'https://recorded.invalid').searchParams.get('actingSubject') ?? undefined;
    const id = new URL(header.path, 'https://recorded.invalid').pathname.split('/').at(-1)!;
    const selections: RecordedSelection[] = [{ label: 'work-header', state: mode === 'loading' ? 'loading' : 'populated' }];
    if (persona === 'member' && mode !== 'loading') {
      selections.push(
        { label: mode === 'saved' ? 'preference-saved' : 'preference-empty', state: mode === 'saved' ? 'populated' : 'empty' },
        { label: 'progress-summary', state: 'populated' },
      );
      if (mode === 'saved') selections.push({ label: 'release-details', state: 'populated' });
    }
    const replay = recordedFetch(record, persona, selections, { pathPrefix: BFF_PREFIX });
    let mounted = true;
    const main = browserMainApi(window.location.origin, { anonymous: persona === 'visitor', fetcher: replay.fetcher });
    const reads = booksEditionReads({ main, actingSubject });
    // Hold the recorded work read open. The loading copy stays until it answers.
    if (mode === 'loading') {
      void reads.readWorkHeader(id);
      return () => { mounted = false; replay.dispose(); };
    }
    void Promise.all([reads.readWorkHeader(id), readBooksEditionStatus(reads, id, locale)]).then(([read, status]) => {
      if (!mounted) return;
      if (!read.ok) { setFault(`Work header: ${read.failure}`); return; }
      setView({ header: read.data, status });
    }).catch((error: unknown) => { if (mounted) setFault(String(error)); });
    return () => { mounted = false; replay.dispose(); };
  }, [persona, mode, locale]);
  const t = messages[locale];
  if (fault) return <pre role="alert" className="whitespace-pre-wrap break-words p-6">{fault}</pre>;
  if (!view) return <p role="status" aria-busy="true" className="p-6">{t.loading}</p>;
  return <ReaderActionsProvider signedIn={persona === 'member'} signInHref="/auth/start">
    <main className="mx-auto grid min-w-0 max-w-3xl grid-cols-1 gap-6 px-4 py-6" lang={locale}>
      <h1 className="break-words font-semibold text-2xl" lang={view.header.title.language}>{view.header.title.value}</h1>
      {persona === 'member' && view.status
        ? <IdentityStatus {...view.status} locale={locale} messages={t} /> : null}
      {persona === 'visitor' ? <YourEdition work={view.header.id} signInHref="/auth/start" locale={locale} messages={t} /> : null}
    </main>
  </ReaderActionsProvider>;
}

const meta = { title: 'Work page/Games hub recorded', component: RecordedGamesHub,
  args: { persona: 'visitor', mode: 'populated', locale: 'en' },
  globals: { viewport: { value: 'desktop' } }, parameters: { controls: { disable: true } },
} satisfies Meta<typeof RecordedGamesHub>;
export default meta;
type Story = StoryObj<typeof meta>;

async function title(canvasElement: HTMLElement, persona: Persona) {
  const header = sample(persona, 'work-header').answer as WorkHeader;
  await expect(within(canvasElement).findByRole('heading', { level: 1, name: header.title.value })).resolves.toBeVisible();
  await document.fonts.ready;
  await expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(window.innerWidth);
}

export const Visitor: Story = { async play({ canvasElement, args }) {
  await title(canvasElement, args.persona);
  await expect(within(canvasElement).getByRole('link', { name: messages[args.locale].signInForEdition })).toBeVisible();
  await expect(within(canvasElement).queryByRole('button', { name: copyOf(args.locale).savePreference })).not.toBeInTheDocument();
} };
export const VisitorPhone: Story = { ...Visitor, globals: { viewport: { value: 'phone' } } };

export const Loading: Story = { args: { mode: 'loading' }, async play({ canvasElement, args }) {
  await expect(within(canvasElement).getByRole('status')).toHaveTextContent(messages[args.locale].loading);
  await expect(within(canvasElement).queryByRole('heading', { level: 1 })).not.toBeInTheDocument();
} };
export const LoadingPhone: Story = { ...Loading, globals: { viewport: { value: 'phone' } } };

async function savedIdentity(canvasElement: HTMLElement, args: Props) {
  await title(canvasElement, args.persona);
  const release = sample('member', 'release-details').answer as { title: { value: string }; editionStatement: string };
  const status = within(canvasElement).getByRole('list', { name: messages[args.locale].yourEdition });
  await expect(status).toHaveTextContent(release.title.value);
  await expect(status).toHaveTextContent(release.editionStatement);
  await expect(status).toHaveTextContent(copyOf(args.locale).notStarted);
}

export const MemberSaved: Story = { args: { persona: 'member', mode: 'saved' }, async play({ canvasElement, args }) {
  await savedIdentity(canvasElement, args);
} };
export const MemberSavedPhone: Story = { ...MemberSaved, globals: { viewport: { value: 'phone' } } };
export const MemberSavedChinesePhone: Story = { ...MemberSaved, args: { persona: 'member', mode: 'saved', locale: 'zh-Hans' },
  globals: { locale: 'zh-Hans', viewport: { value: 'phone' } } };

export const MemberEmpty: Story = { args: { persona: 'member', mode: 'empty' }, async play({ canvasElement, args }) {
  await title(canvasElement, args.persona);
  const release = sample('member', 'release-details').answer as { title: { value: string } };
  const status = within(canvasElement).getByRole('list', { name: messages[args.locale].yourEdition });
  await expect(status).toHaveTextContent(copyOf(args.locale).notStarted);
  await expect(status).not.toHaveTextContent(release.title.value);
} };
export const MemberEmptyPhone: Story = { ...MemberEmpty, globals: { viewport: { value: 'phone' } } };
