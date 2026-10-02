import { resourceHref } from '../address/path.ts';
import { localizedPath } from '../../i18n/locale.ts';
import { useState } from 'react';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, screen, userEvent, waitFor, within } from 'storybook/test';
import type { UiLocale } from '../../i18n/define.ts';
import { ReaderActionsProvider, ShelfButton } from '../catalogue/reader-actions.tsx';
import { PageContainer } from '../shell/page.tsx';
import * as fixture from './fixtures.ts';
import { createMemoryMain, type MemoryMain, memoryReader, memoryTracking } from './memory.ts';
import { SeriesProgressPanel } from './series-progress-panel.tsx';
import { TrackingControl } from './tracking-control.tsx';

/** Opens a styled select and picks an option; the list is portalled, so options are found on the document. */
async function choose(scope: ReturnType<typeof within>, name: string | RegExp, option: string) {
  await userEvent.click(scope.getByRole('combobox', { name }));
  await userEvent.click(await within(document.body).findByRole('option', { name: option }));
}

interface Args {
  locale: UiLocale;
  main: MemoryMain;
  work: string;
  title: string;
  status?: 'read' | 'reading' | null;
}

const signInHref = '/auth/start';

/** One device: the shelf button and, below it, whatever the story embeds, acting on a shared in-memory Main. */
function Device({
  locale,
  main,
  work,
  title,
  status = 'reading',
  panel = false,
}: Args & { panel?: boolean }) {
  const [actions] = useState(() => memoryReader(main, { [work]: status }));
  return (
    <ReaderActionsProvider signedIn signInHref={signInHref} actions={actions}>
      <PageContainer className="grid max-w-md gap-6">
        <ShelfButton work={work} title={title} locale={locale} />
        <TrackingControl work={work} title={title} locale={locale} size="sm" />
        {panel ? <SeriesProgressPanel work={work} locale={locale} /> : null}
      </PageContainer>
    </ReaderActionsProvider>
  );
}

const meta = {
  title: 'Tracking/Attempts and series progress',
  component: Device,
  parameters: {
    docs: {
      description: {
        component:
          'The status button keeps its one-tap shelves and gains Details: a sheet of attempts (planned, reading, paused, did not finish, finished), rereads, editions and formats, unknown dates and a page, percentage or time position with current and furthest apart. Edits send the version they read; when another device changed the attempt first, both states are shown and the reader chooses. The series panel shows Main’s progress states as separate lines.',
      },
    },
  },
  args: {
    locale: 'en',
    work: fixture.saoOne,
    title: fixture.saoOneTitle,
    main: createMemoryMain({ editions: fixture.editions }),
  },
  globals: { viewport: { value: 'desktop' } },
} satisfies Meta<Args>;
export default meta;
type Story = StoryObj<typeof meta>;

/** Opens the sheet and waits for its slide-in to finish, so typing and clicks land on a settled panel. */
const openSheet = async (canvasElement: HTMLElement, name = 'Details') => {
  await userEvent.click(within(canvasElement).getByRole('button', { name }));
  const dialog = await screen.findByRole('dialog');
  await waitFor(() => expect(dialog).toBeVisible());
  return within(dialog);
};
const openDetails = (canvasElement: HTMLElement) => openSheet(canvasElement);

/** Start in print, add the audiobook, pause, finish, then start a reread: the attempt's whole life in one sheet. */
export const AttemptLifecycle: Story = {
  args: { main: createMemoryMain({ editions: fixture.editions }) },
  async play({ canvasElement }) {
    const sheet = await openDetails(canvasElement);
    await sheet.findByText('No attempts recorded yet.');
    const start = sheet.getByRole('region', { name: 'Start an attempt' });
    await choose(within(start), 'Edition', 'Sword Art Online 1: Aincrad · paperback');
    await choose(within(start), 'Format', 'Print');
    await userEvent.click(within(start).getByRole('button', { name: 'Start reading' }));
    const first = await sheet.findByRole('article', { name: 'First read' });
    await expect(within(first).getByText('Reading')).toBeVisible();
    await expect(within(first).getByText(/Sword Art Online 1: Aincrad · paperback/)).toBeVisible();

    await choose(within(first), 'Edition', 'Sword Art Online 1 (audiobook) · audiobook');
    await choose(within(first), 'Format', 'Audiobook');
    await userEvent.click(within(first).getByRole('button', { name: 'Add' }));
    await waitFor(() => expect(within(first).getAllByText(/audiobook/i).length).toBeGreaterThan(1));

    await userEvent.click(within(first).getByRole('button', { name: 'Pause' }));
    await waitFor(() => expect(within(first).getByText('Paused')).toBeVisible());
    await userEvent.click(within(first).getByRole('button', { name: 'Resume' }));
    await userEvent.click(await within(first).findByRole('button', { name: 'Mark finished' }));
    await waitFor(() => expect(within(first).getByText('Finished')).toBeVisible());
    await expect(
      within(first).getByText('This attempt has ended. To read it again, start a new one.'),
    ).toBeVisible();

    const reread = sheet.getByRole('region', { name: 'Start a reread' });
    await userEvent.click(within(reread).getByRole('button', { name: 'Start reading' }));
    await expect(await sheet.findByRole('article', { name: 'Reread 1' })).toBeVisible();
  },
};

/** Dates keep their precision; empty is unknown and never today. */
export const UnknownDates: Story = {
  args: {
    main: createMemoryMain({
      editions: fixture.editions,
      sessions: [fixture.session({ startedOn: null })],
    }),
  },
  async play({ canvasElement }) {
    const sheet = await openDetails(canvasElement);
    const card = await sheet.findByRole('article', { name: 'First read' });
    await expect(within(card).getAllByText('Unknown')).toHaveLength(2);
    await userEvent.type(within(card).getAllByLabelText('Started')[0]!, '2024-05');
    await userEvent.click(within(card).getAllByRole('button', { name: 'Save' })[0]!);
    await waitFor(() => expect(within(card).getByText('May 2024')).toBeVisible());
    await userEvent.type(within(card).getAllByLabelText('Finished')[0]!, '2024-13');
    await userEvent.click(within(card).getAllByRole('button', { name: 'Save' })[1]!);
    await expect(await within(card).findByRole('alert')).toHaveTextContent(
      'Use a year, a month or a day',
    );
  },
};

/** Current and furthest apart; the Work itself has no pages, so an edition is chosen first. */
export const PageAndFurthest: Story = {
  args: { main: createMemoryMain({ editions: fixture.editions, sessions: [fixture.session()] }) },
  async play({ canvasElement }) {
    const sheet = await openDetails(canvasElement);
    const card = await sheet.findByRole('article', { name: 'First read' });
    await expect(within(card).getByText(/Choose an edition to record a page/)).toBeVisible();
    await choose(within(card), 'Edition', 'Sword Art Online 1: Aincrad · paperback');
    await userEvent.click(within(card).getByRole('button', { name: 'Add' }));
    const position = await within(card).findByLabelText('Value');
    await userEvent.type(position, '200');
    await userEvent.click(within(card).getByRole('button', { name: 'Save position' }));
    await waitFor(() => expect(within(card).getByText(/Furthest/)).toBeVisible());
    await userEvent.type(within(card).getByLabelText('Value'), '50');
    await userEvent.click(within(card).getByRole('button', { name: 'Save position' }));
    await waitFor(() => expect(card).toHaveTextContent('Now page 50 · Furthest page 200'));
  },
};

/** Two devices began an attempt each: the sheet says so and either can be closed. */
export const TwoOpenAttempts: Story = {
  args: {
    main: createMemoryMain({
      editions: fixture.editions,
      sessions: [
        fixture.session({ id: fixture.iri('a2'), startedOn: '2026-09-02' }),
        fixture.session(),
      ],
    }),
  },
  async play({ canvasElement }) {
    const sheet = await openDetails(canvasElement);
    await expect(await sheet.findByText(/Two attempts are open/)).toBeVisible();
    const [newer] = await sheet.findAllByRole('article');
    await userEvent.click(within(newer!).getByRole('button', { name: 'Mark did not finish' }));
    await waitFor(() => expect(sheet.queryByText(/Two attempts are open/)).toBeNull());
    await expect(
      within(newer!).getByText(
        'Did not finish ends this attempt. To read it again, start a new one.',
      ),
    ).toBeVisible();
  },
};

/** The other device paused the attempt first: the reader sees both and keeps their own. */
export const ConflictKeepMine: Story = {
  args: { main: createMemoryMain({ editions: fixture.editions, sessions: [fixture.session()] }) },
  async play({ canvasElement, args }) {
    const sheet = await openDetails(canvasElement);
    const card = await sheet.findByRole('article', { name: 'First read' });
    // Device B changes the attempt while this one still holds version 1.
    await memoryTracking(args.main).change(fixture.session().id, 1, { state: 'paused' });
    await userEvent.click(within(card).getByRole('button', { name: 'Mark finished' }));
    const conflict = await sheet.findByRole('alert');
    await expect(within(conflict).getByText('Changed on another device')).toBeVisible();
    await expect(within(conflict).getByText('Your change')).toBeVisible();
    await expect(within(conflict).getByText('On the other device')).toBeVisible();
    await expect(within(conflict).getByText('Finished')).toBeVisible();
    await expect(within(conflict).getByText('Paused')).toBeVisible();
    await userEvent.click(within(conflict).getByRole('button', { name: 'Keep my change' }));
    await waitFor(() => expect(sheet.queryByRole('alert')).toBeNull());
    await expect(within(card).getByText('Finished')).toBeVisible();
    await expect(args.main.sessions[0]!.state).toBe('finished');
  },
};

export const ConflictUseTheirs: Story = {
  args: { main: createMemoryMain({ editions: fixture.editions, sessions: [fixture.session()] }) },
  async play({ canvasElement, args }) {
    const sheet = await openDetails(canvasElement);
    const card = await sheet.findByRole('article', { name: 'First read' });
    await memoryTracking(args.main).change(fixture.session().id, 1, { state: 'paused' });
    await userEvent.click(within(card).getByRole('button', { name: 'Mark finished' }));
    await userEvent.click(
      await within(card).findByRole('button', { name: 'Use the other version' }),
    );
    await waitFor(() => expect(sheet.queryByRole('alert')).toBeNull());
    await expect(within(card).getByText('Paused')).toBeVisible();
    await expect(args.main.sessions[0]!.state).toBe('paused');
  },
};

const panelMain = (summary = fixture.indexSummary, language = summary.language) =>
  createMemoryMain({
    summaries: { [language]: summary },
    editions: fixture.editions,
    relations: null,
  });

/** Index Original in zh-Hant: caught up with available material, not finished with the published parts. */
export const SeriesCaughtUpNotFinished: Story = {
  args: {
    main: panelMain(),
    work: fixture.iri('100'),
    title: 'A Certain Magical Index',
    status: null,
  },
  render: (args) => <Device {...args} panel />,
  async play({ canvasElement }) {
    const panel = within(
      await within(canvasElement).findByRole('region', { name: 'Series progress' }),
    );
    const lines = canvasElement.querySelectorAll('[data-series-progress] dl > [data-state]');
    await expect(
      [...lines].map(
        (line) => `${line.getAttribute('data-state')}=${line.getAttribute('data-value')}`,
      ),
    ).toEqual([
      'caughtUpWithAvailableMaterial=true',
      'finishedPublishedParts=false',
      'seriesConcluded=false',
      'correspondenceUnresolved=true',
    ]);
    await expect(panel.getByText('Caught up with available material')).toBeVisible();
    await expect(panel.getByText('Finished the published parts')).toBeVisible();
    await expect(panel.getByText('2 of 4 required parts finished')).toBeVisible();
    await expect(
      panel.getByText('The next required part, which has no text in this language yet.'),
    ).toBeVisible();
    await expect(panel.getByRole('link', { name: '3' })).toHaveAttribute(
      'href',
      localizedPath(resourceHref('/w/', fixture.iri('103').slice(-36)), 'en'),
    );
    await expect(panel.getByText(/page 240/)).toBeVisible();
  },
};

export const SeriesPartial: Story = {
  args: {
    main: panelMain(fixture.partialSummary),
    work: fixture.iri('100'),
    title: 'A Certain Magical Index',
    status: null,
  },
  render: (args) => <Device {...args} panel />,
  async play({ canvasElement }) {
    const panel = within(
      await within(canvasElement).findByRole('region', { name: 'Series progress' }),
    );
    await expect(panel.getByText(/more parts than one page holds/)).toBeVisible();
    await expect(
      canvasElement.querySelectorAll('[data-series-progress] dl > [data-value="null"]').length,
    ).toBe(3);
  },
};

/** The edition preference picker: choosing a language and a release saves against the version read. */
export const EditionPreference: Story = {
  args: {
    main: panelMain(fixture.caughtUpSummary, 'en'),
    work: fixture.saoOne,
    title: fixture.saoOneTitle,
    status: null,
  },
  render: (args) => <Device {...args} panel />,
  async play({ canvasElement, args }) {
    const panel = within(
      await within(canvasElement).findByRole('region', { name: 'Series progress' }),
    );
    await choose(panel, 'Edition', 'Sword Art Online 1: Aincrad');
    await userEvent.click(panel.getByRole('button', { name: 'Save choice' }));
    await waitFor(() =>
      expect(args.main.preferences.get(fixture.saoOne)).toMatchObject({
        language: 'en',
        version: 1,
        edition: { kind: 'release', resource: fixture.iri('p1') },
      }),
    );
  },
};

/** Web Spider with a standalone summary that Main would compute from the attempts at the time of the read. */
const spiderMain = (
  summary: (main: MemoryMain) => ReturnType<typeof fixture.standaloneSummary>,
) => {
  const main = createMemoryMain({
    editions: fixture.editions,
    relations: fixture.spiderRelations(),
  });
  main.summaries = { en: () => summary(main) };
  return main;
};
const spiderTitle = 'So I’m a Spider, So What? (web)';
const offer = 'Also mark “So I’m a Spider, So What? (book)” as read';

/** Finishing web Spider leaves book Spider unstarted until the reader accepts the offered action. */
export const AlsoMarkCorrespondence: Story = {
  args: {
    main: spiderMain(() => fixture.standaloneSummary('finished')),
    work: fixture.spider.web,
    title: spiderTitle,
    status: 'read',
  },
  render: (args) => <Device {...args} panel />,
  async play({ canvasElement, args }) {
    const panel = within(
      await within(canvasElement).findByRole('region', { name: 'Your progress' }),
    );
    await expect(args.main.calls.started).toEqual([]);
    await expect(panel.getByText('Finished')).toBeVisible();
    await expect(panel.getByText(/Nothing is marked until you choose/)).toBeVisible();
    await userEvent.click(panel.getByRole('button', { name: offer }));
    await waitFor(() => expect(args.main.calls.started).toEqual([fixture.spider.book]));
    await expect(args.main.sessions[0]).toMatchObject({
      state: 'finished',
      target: { work: fixture.spider.book },
    });
    await expect(
      await panel.findByText('“So I’m a Spider, So What? (book)” is marked as read.'),
    ).toBeVisible();
    await waitFor(() => expect(panel.queryByRole('button', { name: offer })).toBeNull());
  },
};

/** Not offered while this Work is not finished: nothing completes by itself, and no series panel is drawn for a standalone Work. */
export const NoOfferUntilFinished: Story = {
  args: {
    main: spiderMain(() => fixture.standaloneSummary('reading')),
    work: fixture.spider.web,
    title: spiderTitle,
    status: 'reading',
  },
  render: (args) => <Device {...args} panel />,
  async play({ canvasElement, args }) {
    await within(canvasElement).findByRole('button', { name: 'Details' });
    await waitFor(() => expect(canvasElement.querySelector('[data-series-progress]')).toBeNull());
    await expect(args.main.calls.started).toEqual([]);
  },
};

/** A Work with no composition answers for itself: no series lines, no "0 of 1 required parts", no language form. */
export const StandaloneWorkDrawsNoSeries: Story = {
  args: {
    main: createMemoryMain({
      summaries: { en: fixture.standaloneSummary('not-started') },
      editions: fixture.editions,
    }),
    work: fixture.spider.web,
    title: spiderTitle,
    status: null,
  },
  render: (args) => <Device {...args} panel />,
  async play({ canvasElement }) {
    await within(canvasElement).findByRole('button', { name: 'Details' });
    await new Promise((done) => setTimeout(done, 300));
    await expect(canvasElement.querySelector('[data-series-progress]')).toBeNull();
    await expect(canvasElement.textContent).not.toMatch(/required part/);
  },
};

/** Finishing in Details moves the shelf without a reload: the status button reads Read, and the offer appears. */
export const FinishingMovesTheShelf: Story = {
  args: {
    main: spiderMain((main) =>
      fixture.standaloneSummary(
        main.sessions.some((item) => item.state === 'finished') ? 'finished' : 'reading',
      ),
    ),
    work: fixture.spider.web,
    title: spiderTitle,
    status: null,
  },
  render: (args) => <Device {...args} panel />,
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await expect(canvas.queryByRole('button', { name: offer })).toBeNull();
    const sheet = await openDetails(canvasElement);
    await userEvent.click(
      within(await sheet.findByRole('region', { name: 'Start an attempt' })).getByRole('button', {
        name: 'Start reading',
      }),
    );
    await userEvent.click(await sheet.findByRole('button', { name: 'Mark finished' }));
    await waitFor(() =>
      expect(sheet.getByText('Finished', { selector: '[data-slot=badge]' })).toBeVisible(),
    );
    await userEvent.keyboard('{Escape}');
    await waitFor(() =>
      expect(canvas.getByRole('button', { name: /^Read — Shelve/ })).toBeVisible(),
    );
    await expect(await canvas.findByRole('button', { name: offer })).toBeVisible();
  },
};

/** While an attempt is open there is no second Start; once it ends the form reads "Start a reread". */
export const StartOnlyWithoutAnOpenAttempt: Story = {
  args: { main: createMemoryMain({ editions: fixture.editions, sessions: [fixture.session()] }) },
  async play({ canvasElement }) {
    const sheet = await openDetails(canvasElement);
    const card = await sheet.findByRole('article', { name: 'First read' });
    await expect(sheet.queryByRole('region', { name: 'Start an attempt' })).toBeNull();
    await userEvent.click(within(card).getByRole('button', { name: 'Mark finished' }));
    await expect(await sheet.findByRole('region', { name: 'Start a reread' })).toBeVisible();
  },
};

/** Another device already made the same change: nothing to choose between, so no conflict is shown. */
export const ConflictAlreadyResolved: Story = {
  args: { main: createMemoryMain({ editions: fixture.editions, sessions: [fixture.session()] }) },
  async play({ canvasElement, args }) {
    const sheet = await openDetails(canvasElement);
    const card = await sheet.findByRole('article', { name: 'First read' });
    await memoryTracking(args.main).change(fixture.session().id, 1, { state: 'finished' });
    await userEvent.click(within(card).getByRole('button', { name: 'Mark finished' }));
    await waitFor(() =>
      expect(within(card).getByText('Finished', { selector: '[data-slot=badge]' })).toBeVisible(),
    );
    await expect(sheet.queryByRole('alert')).toBeNull();
  },
};

export const PhoneSheet: Story = {
  globals: { viewport: { value: 'mobile1' } },
  args: { main: createMemoryMain({ editions: fixture.editions, sessions: [fixture.session()] }) },
  async play({ canvasElement }) {
    const sheet = await openDetails(canvasElement);
    await expect(await sheet.findByRole('article', { name: 'First read' })).toBeVisible();
    await expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(window.innerWidth);
  },
};

export const SimplifiedChinese: Story = {
  args: {
    locale: 'zh-Hans',
    main: createMemoryMain({ editions: fixture.editions, sessions: [fixture.session()] }),
  },
  async play({ canvasElement }) {
    const sheet = await openSheet(canvasElement, '详情');
    await expect(await sheet.findByRole('article', { name: '初读' })).toBeVisible();
    await expect(sheet.getByText('阅读中')).toBeVisible();
  },
};
