import { useEffect, useMemo, useState } from 'react';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, waitFor, within } from 'storybook/test';
import { Button } from '@rezics/ui/button';
import { materializeData } from 'native-i18n';
import type { AnswerPersona } from '../../../../scripts/api/answer-record.ts';
import type { UiLocale } from '../../i18n/define.ts';
import { localizedPath } from '../../i18n/locale.ts';
import { signInPath } from '../auth/paths.ts';
import { createReaderStore } from '../catalogue/reader-store.ts';
import { messages as catalogueMessages } from '../catalogue/messages.ts';
import { mainRelationships } from '../relationships/api.ts';
import { chooseMenuItem } from '../stories/choose-option.ts';
import { BooksContentsRecordedPage, mapBooksContentsRecordedPage, type BooksContentsRecordedView } from '../work-page/books-contents-recorded-page.tsx';
import { messages as workMessages } from '../work-page/messages.ts';
import { WorkFrame } from '../work-page/work-frame.tsx';
import { WorkCredits } from '../work-page/credits.tsx';
import { workHref } from '../work-page/route.ts';
import { MediumProgress } from './medium-progress.tsx';
import { chapterScenarioIdentity, createChapterScenario, type ChapterScenarioMedium, type ChapterScenarioState } from './chapter-progress-fixtures.ts';
import { copyOf } from './messages.ts';

interface Props { medium: ChapterScenarioMedium; persona: AnswerPersona; state: ChapterScenarioState; locale: UiLocale }
function ChapterProgressPage({ medium, persona, state, locale }: Props) {
  const scenario = useMemo(() => createChapterScenario(medium, persona, state), [medium, persona, state]);
  const [contents, setContents] = useState<BooksContentsRecordedView>({ kind: 'loading' });
  const [generation, setGeneration] = useState(0);
  const t = copyOf(locale);
  const actions = useMemo(() => scenario.actingSubject ? { ...createReaderStore({ actingSubject: scenario.actingSubject,
    seed: scenario.seed, main: () => scenario.first }), tracking: null } : undefined, [scenario]);
  const relationships = useMemo(() => scenario.actingSubject ? mainRelationships(scenario.actingSubject, {
    origin: 'https://recorded.invalid/api/main', fetch: scenario.fetcher }) : undefined, [scenario]);
  useEffect(() => {
    let current = true;
    if (persona === 'visitor') void scenario.first.v1['reading-positions']({ work: scenario.work.slice(-36) })
      .get({ query: { position: 'start', limit: 20 } }).then(answer => {
        if (current) setContents(mapBooksContentsRecordedPage(answer, { workRef: scenario.work.slice(-36),
          workIri: scenario.work, locale }));
      });
    return () => { current = false; };
  }, [scenario, persona, locale]);
  return <div lang={locale} data-persona={persona} data-acting-subject={scenario.actingSubject ?? ''}>
    <WorkFrame workRef={scenario.work.slice(-36)} work={scenario.header} locale={locale} messages={workMessages[locale]}
      signedIn={persona !== 'visitor'} actingSubject={scenario.actingSubject} readerActions={actions}
      signInHref={signInPath(localizedPath(workHref(scenario.work.slice(-36)), locale))} relationships={relationships}
      credits={<WorkCredits locale={locale} messages={workMessages[locale]} agentCredits={{ ok: true, data: {
        items: [{ id: 'https://rezics.com/id/00000000-0000-7000-8000-000000000900', role: 'author',
          agent: chapterScenarioIdentity(medium, 'owner').actingSubject!,
          displayName: 'Fixture author', handle: null }], nextCursor: null,
      } }} credits={{ ok: true, data: { items: [], nextCursor: null } }} />}>
      {persona === 'visitor' ? <BooksContentsRecordedPage view={contents} locale={locale} messages={workMessages[locale]} /> :
        <div className="grid min-w-0 gap-6 lg:grid-cols-2">
          {(['first', 'second'] as const).map(device => <div key={device} data-device={device} className="min-w-0">
            <p lang="en" className="mb-3 text-muted-foreground text-sm">{device === 'first' ? 'First device'
              : scenario.omnibus ? 'Second device · Omnibus' : 'Second device'}</p>
            <MediumProgress key={`${device}/${generation}`} work={device === 'second' ? scenario.omnibus ?? scenario.work : scenario.work}
              api={device === 'first' ? scenario.firstApi! : scenario.secondApi!} episodes={null} t={t} />
            <Button className="mt-3" variant="outline" onClick={() => setGeneration(value => value + 1)}>{t.retry}</Button>
          </div>)}
        </div>}
    </WorkFrame>
  </div>;
}

const meta = {
  title: 'Features/Tracking/Chapter progress Work page', component: ChapterProgressPage,
  parameters: { layout: 'fullscreen', docs: { description: { component:
    'Production WorkFrame, public Contents and the API-selected MediumProgress control. Book owner commands replay unchanged recorded answers. '
    + 'Manga, own-person role variants and adverse states use the contract; exact missing requests are exported by chapterProgressMissingStates. '
    + 'The two panels represent two own Account grants of the same Person. Manga resumes the second panel through the omnibus. '
    + 'Rights: original-contribution. Original fictional manga text and chapter labels, and synthetic Book and series text, '
    + 'by the fixture owner Person; no external source. The author credit is a missing contract-built read.' } } },
  args: { medium: 'manga', persona: 'owner', state: 'populated', locale: 'en' },
} satisfies Meta<typeof ChapterProgressPage>;
export default meta;
type Story = StoryObj<typeof meta>;
const phone = { viewport: { value: 'phone', isRotated: false } };

async function devices({ canvasElement, args }: { canvasElement: HTMLElement; args: Props }) {
  const t = copyOf(args.locale), page = within(canvasElement);
  if (args.medium === 'manga') {
    const catalogue = materializeData(catalogueMessages[args.locale], { locale: args.locale });
    await userEvent.click(await page.findByRole('button', { name: catalogue.shelfOptions }));
    const menu = within(canvasElement.ownerDocument.body);
    await chooseMenuItem(menu, 'menuitemradio', catalogue.reading);
    await page.findByRole('button', { name: name => name.startsWith(`${catalogue.reading} —`) });
  }
  const first = within(canvasElement.querySelector('[data-device="first"]') as HTMLElement);
  const second = within(canvasElement.querySelector('[data-device="second"]') as HTMLElement);
  const chapter = args.medium === 'book' ? 'Chapter 2' : 'Volume 2, chapter 1';
  for (const view of [first, second]) {
    if (args.medium === 'manga') await userEvent.click(await view.findByRole('button', { name: t.showMore }));
    await userEvent.click(await view.findByRole('button', { name: chapter }));
    await view.findByRole('textbox', { name: t.conflictPosition });
  }
  if (args.medium === 'book') {
    await userEvent.type(first.getByRole('textbox', { name: t.conflictPosition }), 'device one paragraph');
    await userEvent.click(first.getByRole('button', { name: t.savePosition }));
    await waitFor(() => expect(first.getByRole('textbox', { name: t.conflictPosition })).toHaveValue('device one paragraph'));
  } else {
    await userEvent.click(first.getByRole('button', { name: t.markChapterRead }));
    await first.findByRole('button', { name: t.markChapterUnread });
  }
  await userEvent.click(second.getByRole('button', { name: args.medium === 'book' ? t.markChapterUnread : t.markChapterRead }));
  await second.findByText(t.conflictTitle);
  await expect(second.getByText(t.conflictMine)).toBeVisible();
  await expect(second.getByText(t.conflictTheirs)).toBeVisible();
  // Accept the winning save, then explicitly undo it from its current version.
  await userEvent.click(second.getByRole('button', { name: t.useTheirs }));
  await userEvent.click(await second.findByRole('button', { name: t.markChapterUnread }));
  await second.findByRole('button', { name: t.markChapterRead });
  if (args.medium === 'manga') await second.findByText(t.lastRead({ place: 'Volume 1, chapter 2' }));
  await userEvent.click(first.getByRole('button', { name: t.retry }));
  if (args.medium === 'manga') await userEvent.click(await first.findByRole('button', { name: t.showMore }));
  await userEvent.click(await first.findByRole('button', { name: chapter }));
  await first.findByRole('button', { name: t.markChapterRead });
  await expect(first.getByRole('textbox', { name: t.conflictPosition })).toHaveValue('');
  await expect(page.queryByText(t.conflictTitle)).not.toBeInTheDocument();
  await expect(canvasElement.scrollWidth).toBeLessThanOrEqual(canvasElement.clientWidth + 1);
}
function manga(persona: AnswerPersona): Story { return { args: { persona }, play: devices }; }
export const MangaOwner = manga('owner');
export const MangaOwnerPhone: Story = { ...MangaOwner, globals: phone };
export const MangaStranger = manga('stranger');
export const MangaMember = manga('member');
export const MangaModerator = manga('moderator');
export const MangaOperator = manga('operator');
export const MangaStrangerPhone: Story = { ...MangaStranger, globals: phone };
export const MangaMemberPhone: Story = { ...MangaMember, globals: phone };
export const MangaModeratorPhone: Story = { ...MangaModerator, globals: phone };
export const MangaOperatorPhone: Story = { ...MangaOperator, globals: phone };
export const BookOwner: Story = { args: { medium: 'book' }, play: devices };
export const BookOwnerPhone: Story = { ...BookOwner, globals: phone };
export const MangaVisitor: Story = { args: { persona: 'visitor' }, async play({ canvasElement }) {
  const view = within(canvasElement);
  await view.findByRole('link', { name: /Volume 1, chapter 1/ });
  await expect(canvasElement.querySelector('[data-chapter-progress]')).toBeNull();
  await expect(canvasElement.querySelector('[data-acting-subject]')).toHaveAttribute('data-acting-subject', '');
} };
export const MangaVisitorPhone: Story = { ...MangaVisitor, globals: phone };
export const BookVisitor: Story = { ...MangaVisitor, args: { medium: 'book', persona: 'visitor' }, async play({ canvasElement }) {
  const view = within(canvasElement);
  await view.findByRole('link', { name: /Chapter 1/ });
  await expect(canvasElement.querySelector('[data-chapter-progress]')).toBeNull();
} };
export const BookVisitorPhone: Story = { ...BookVisitor, globals: phone };

function bookSelf(persona: AnswerPersona): Story {
  return { args: { medium: 'book', persona }, async play({ canvasElement, args }) {
    const t = copyOf(args.locale);
    const first = within(canvasElement.querySelector('[data-device="first"]') as HTMLElement);
    await userEvent.click(await first.findByRole('button', { name: 'Chapter 2' }));
    await first.findByRole('button', { name: t.markChapterRead });
    await expect(first.getByRole('textbox', { name: t.conflictPosition })).toHaveValue('');
    await expect(canvasElement.querySelector('[data-acting-subject]')).not.toHaveAttribute('data-acting-subject', chapterScenarioIdentity('book', 'owner').actingSubject!);
  } };
}
export const BookStranger = bookSelf('stranger');
export const BookMember = bookSelf('member');
export const BookModerator = bookSelf('moderator');
export const BookOperator = bookSelf('operator');
export const BookStrangerPhone: Story = { ...BookStranger, globals: phone };
export const BookMemberPhone: Story = { ...BookMember, globals: phone };
export const BookModeratorPhone: Story = { ...BookModerator, globals: phone };
export const BookOperatorPhone: Story = { ...BookOperator, globals: phone };

function stateStory(state: ChapterScenarioState, medium: ChapterScenarioMedium = 'manga'): Story {
  return { args: { state, medium }, async play({ canvasElement, args }) {
    const t = copyOf(args.locale), view = within(canvasElement.querySelector('[data-device="first"]') as HTMLElement);
    if (state === 'error') await view.findByRole('alert', {}, { timeout: 10_000 });
    else if (state === 'empty') await view.findByText(t.noChapters);
    else if (state === 'indexing') {
      await waitFor(() => expect(canvasElement.querySelector('[data-device="first"] [data-chapter-progress]')).not.toBeNull());
      const progress = within(canvasElement.querySelector('[data-device="first"] [data-chapter-progress]') as HTMLElement);
      await progress.findByRole('button', { name: t.retry });
      await expect(progress.queryByText(t.noChapters)).toBeNull();
    }
    else await waitFor(() => expect(canvasElement.querySelector('[data-loading]')).not.toBeNull());
    await expect(canvasElement.querySelector('[data-pending]')).toBeNull();
  } };
}
export const MangaLoading = stateStory('loading');
export const MangaLoadingPhone: Story = { ...MangaLoading, globals: phone };
export const MangaEmpty = stateStory('empty');
export const MangaEmptyPhone: Story = { ...MangaEmpty, globals: phone };
export const MangaError = stateStory('error');
export const MangaErrorPhone: Story = { ...MangaError, globals: phone };
export const MangaIndexing = stateStory('indexing');
export const MangaIndexingPhone: Story = { ...MangaIndexing, globals: phone };
export const BookLoading = stateStory('loading', 'book');
export const BookLoadingPhone: Story = { ...BookLoading, globals: phone };
export const BookEmpty = stateStory('empty', 'book');
export const BookEmptyPhone: Story = { ...BookEmpty, globals: phone };
export const BookError = stateStory('error', 'book');
export const BookErrorPhone: Story = { ...BookError, globals: phone };
export const BookIndexing = stateStory('indexing', 'book');
export const BookIndexingPhone: Story = { ...BookIndexing, globals: phone };
export const German: Story = { args: { locale: 'de' }, play: devices };
export const Spanish: Story = { args: { locale: 'es' }, play: devices };
export const French: Story = { args: { locale: 'fr' }, play: devices };
export const Japanese: Story = { args: { locale: 'ja' }, play: devices };
export const Korean: Story = { args: { locale: 'ko' }, play: devices };
export const SimplifiedChinese: Story = { args: { locale: 'zh-Hans' }, play: devices };
export const TraditionalChinese: Story = { args: { locale: 'zh-Hant' }, play: devices };
