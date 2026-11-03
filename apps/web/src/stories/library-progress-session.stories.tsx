import { expect, userEvent, within } from 'storybook/test';
import { m } from '../paraglide/messages.js';
import { profileSession, profileSessionId, retiredSessionId } from '../kernel/fake/progress-profiles';
import { ProgressSessionPage } from '../library/progress-session';
import type { NativeProgressPresentation, ProgressSessionPage as ProgressPageData } from '../library/progress-reads';
import {
  libraryProgressOriginalHistory,
  originalHistoryCursors,
  originalHistoryNextCursors,
  originalHistoryStaleCursors,
  originalHistoryUnit,
  setLibraryProgressStoryMode,
} from '../kernel/fake/library-progress-story';
import {
  manualScalarId,
  manualSparseId,
  manualCursorId,
  manualUnresolvedId,
  manualWithheldId,
} from '../kernel/fake/progress-profile-stories';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { PageStory, PatternStory, libraryProgressSessionReady, pagePaths, pageReady } from './page';
import { getLocale } from '../paraglide/runtime.js';

// UNRUN: story interactions, responsive layout and native recording/authority evidence remain deferred.
const meta = {
  title: 'Pages/Library/Progress Session',
  parameters: {
    layout: 'fullscreen',
    viewport: {
      options: {
        phone390: { name: 'Phone 390', styles: { width: '390px', height: '844px' }, type: 'mobile' },
        desktop1280: { name: 'Desktop 1280', styles: { width: '1280px', height: '900px' }, type: 'desktop' },
      },
    },
  },
  globals: { viewport: { value: 'desktop1280', isRotated: false } },
  beforeEach() {
    setLibraryProgressStoryMode('recorded');
    return () => setLibraryProgressStoryMode('recorded');
  },
} satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;
export const SignedIn: Story = {
  name: 'Owner',
  play: async (context) => {
    await libraryProgressSessionReady(context);
    const history = within(context.canvasElement).getByRole('region', { name: m.library_progress_changes() });
    expect(
      within(history).getByRole('heading', { level: 3, name: m.library_progress_change_recorded() }),
    ).toHaveAttribute('data-content-item-slot', 'title');
    expect(within(history).getByText('Part 2, chapter 14')).toBeVisible();
  },
  render: () => <PageStory visitor="Signed In" path={pagePaths['library-progress-session']} />,
};

// The recorded route has no presentation. These explicit DTO inputs illustrate the delivered shape,
// without resolving history from progressProfile or claiming a native recording/authorization result.
const declaredPresentation = {
  meaning: 'known',
  unitLabel: 'segment at acceptance',
  unitLabelLanguage: 'en',
  unitCountForms: { one: 'segment at acceptance', other: 'segments at acceptance' },
  structure: 'unverified',
  recording: {
    state: 'supported',
    inputRules: { min: '0.25', max: '98.5', step: '0.01', total: 'required' },
  },
} satisfies NativeProgressPresentation;
const boundedProfilePage: ProgressPageData = {
  signedIn: true,
  idempotencyKey: '10203040-5060-4070-8090-102030405060',
  session: {
    ...profileSession,
    mode: 'scalar_amount',
    state: 'active',
    meaning: declaredPresentation.meaning,
    unitLabel: declaredPresentation.unitLabel,
    unitLabelLanguage: declaredPresentation.unitLabelLanguage,
    unitCountForms: declaredPresentation.unitCountForms,
    recordingState: declaredPresentation.recording.state,
    inputRules: declaredPresentation.recording.inputRules,
    changes: [],
    changesNext: null,
    units: [],
    unitsNext: null,
  },
};

function DeclaredProfileView() {
  setLibraryProgressStoryMode('recorded');
  return (
    <PatternStory visitor="Signed In" path={`/library/progress/${profileSessionId}`}>
      <main className="w-full max-w-4xl space-y-6 p-4">
        <ProgressSessionPage page={boundedProfilePage} />
      </main>
    </PatternStory>
  );
}

export const ProfileUnits: Story = {
  name: 'Journey with declared profile units (bounded view)',
  parameters: {
    docs: { description: { story: 'Supplied presentation DTO. Native recording and authorization are unverified.' } },
  },
  play: async (context) => {
    await libraryProgressSessionReady(context);
    await userEvent.click(within(context.canvasElement).getByRole('button', { name: m.library_progress_update() }));
    const dialog = await within(document.body).findByRole('dialog');
    const amount = within(dialog).getByRole('spinbutton', { name: m.library_progress_amount() });
    expect(amount).toHaveAttribute('min', '0.25');
    expect(amount).toHaveAttribute('max', '98.5');
    expect(amount).toHaveAttribute('step', '0.01');
  },
  render: () => <DeclaredProfileView />,
};

export const ProfileUnitsRecordingUnavailable: Story = {
  name: 'Journey route without recorded presentation',
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await canvas.findByText(m.library_history_unavailable());
    await canvas.findByText(m.library_progress_recording_unavailable());
    expect(canvas.queryByRole('button', { name: m.library_progress_update() })).not.toBeInTheDocument();
    expect(canvas.getByText('2.5 / 10', { exact: true })).toBeVisible();
  },
  render: () => {
    setLibraryProgressStoryMode('recorded');
    return <PageStory visitor="Signed In" path={`/library/progress/${profileSessionId}`} />;
  },
};

export const DeclaredRecordingRefused: Story = {
  name: 'Current command refuses advisory support (bounded view)',
  parameters: {
    docs: { description: { story: 'Supplied presentation DTO. The current command refuses advisory support.' } },
  },
  play: async (context) => {
    await libraryProgressSessionReady(context);
    const canvas = within(context.canvasElement);
    await userEvent.click(canvas.getByRole('button', { name: m.library_progress_update() }));
    const dialog = within(await within(document.body).findByRole('dialog'));
    const amount = dialog.getByRole('spinbutton', { name: m.library_progress_amount() });
    await userEvent.clear(amount);
    await userEvent.type(amount, '3');
    await userEvent.click(dialog.getByRole('button', { name: m.library_progress_record() }));
    await canvas.findByRole('alert');
    await canvas.findByText(m.library_progress_no_longer_offered());
    expect(canvas.queryByRole('button', { name: m.library_progress_update() })).not.toBeInTheDocument();
    expect(canvas.getByText('2.5 / 10 segments at acceptance', { exact: true })).toBeVisible();
  },
  render: () => <DeclaredProfileView />,
};
export const RetiredPair: Story = {
  name: 'Progress no longer offered',
  play: async ({ canvasElement }) => {
    await within(canvasElement).findByText(m.library_progress_no_longer_offered());
  },
  render: () => <PageStory visitor="Signed In" path={`/library/progress/${retiredSessionId}`} />,
};

export const EmptyChanges: Story = {
  name: 'No changes recorded',
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await canvas.findByRole('heading', { level: 1, name: m.library_progress_heading() });
    await canvas.findByText(m.library_progress_changes_empty());
  },
  render: () => {
    setLibraryProgressStoryMode('detail-empty');
    return <PageStory visitor="Signed In" path={pagePaths['library-progress-session']} />;
  },
};

export const LongContent: Story = {
  name: 'Long change history',
  play: async ({ canvasElement }) => {
    await within(canvasElement).findByText('Progress story change 12');
    const history = within(canvasElement).getByRole('region', { name: m.library_progress_changes() });
    expect(within(history).getAllByRole('heading', { level: 3 })).toHaveLength(12);
  },
  render: () => {
    setLibraryProgressStoryMode('detail-long');
    return <PageStory visitor="Signed In" path={pagePaths['library-progress-session']} />;
  },
};

const exactLongLocator = `  epubcfi(/6/2[${'original-chapter-and-annotation:'.repeat(7)}])  `;
const longHistoryPage: ProgressPageData = {
  ...boundedProfilePage,
  session: {
    ...profileSession,
    mode: 'cursor_position',
    state: 'active',
    revision: 2,
    meaning: 'unknown',
    recordingState: 'unavailable',
    subject: {
      ...profileSession.subject,
      label: 'A long original reading title with annotations, alternate chapter names and a retained position',
    },
    unit: 'historic-cursor-unit-x',
    amount: null,
    total: null,
    locator: exactLongLocator,
    position: '12.250001',
    changes: [
      {
        id: `${profileSessionId}:2`,
        revision: 2,
        createdAt: '2026-10-29T00:00:00.001Z',
        action: null,
        amount: null,
        locator: exactLongLocator,
        position: '12.250001',
        add: [],
        remove: [],
      },
    ],
    changesNext: null,
    units: [],
    unitsNext: null,
  },
};

export const NarrowOriginalHistory: Story = {
  name: 'Narrow original cursor history with unknown meaning (bounded view)',
  globals: { viewport: { value: 'phone390', isRotated: false } },
  parameters: {
    docs: {
      description: {
        story:
          'Supplied DTO with unknown meaning and unavailable recording. Native authority and responsive behavior are unverified.',
      },
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await canvas.findByText(m.library_progress_meaning_unknown());
    expect(canvas.getByText(m.library_progress_structure_unverified())).toBeVisible();
    expect(canvas.getByText(m.library_progress_recording_unavailable())).toBeVisible();
    expect(canvas.queryByRole('button', { name: m.library_progress_update() })).not.toBeInTheDocument();
    expect(canvas.queryByRole('progressbar')).not.toBeInTheDocument();
    const history = canvas.getByRole('region', { name: m.library_progress_changes() });
    expect(within(history).getByText(exactLongLocator.trim())).toBeVisible();
    expect(within(history).getByText('12.250001')).toBeVisible();
    const summary = canvas.getByText(m.library_progress_details());
    summary.focus();
    await userEvent.keyboard('{Enter}');
    expect(summary.closest('details')).toHaveAttribute('open');
    expect(canvas.getByText('historic-cursor-unit-x')).toBeVisible();
  },
  render: () => {
    setLibraryProgressStoryMode('recorded');
    return (
      <PatternStory visitor="Signed In" path={`/library/progress/${profileSessionId}`}>
        <main className="w-full max-w-4xl space-y-6 p-4">
          <ProgressSessionPage page={longHistoryPage} />
        </main>
      </PatternStory>
    );
  },
};

const completedAmountPage: ProgressPageData = {
  ...boundedProfilePage,
  session: {
    ...boundedProfilePage.session,
    amount: '2.500000',
    state: 'completed',
    revision: 4,
    completedAt: '2026-10-30T00:00:00.000Z',
    changes: [
      {
        id: `${profileSessionId}:2`,
        revision: 2,
        createdAt: '2026-10-29T01:00:00.000Z',
        action: null,
        amount: '0.000000',
        locator: null,
        position: null,
        add: [],
        remove: [],
      },
      {
        id: `${profileSessionId}:3`,
        revision: 3,
        createdAt: '2026-10-29T02:00:00.000Z',
        action: null,
        amount: '2.500000',
        locator: null,
        position: null,
        add: [],
        remove: [],
      },
      {
        id: `${profileSessionId}:4`,
        revision: 4,
        createdAt: '2026-10-30T00:00:00.000Z',
        action: 'complete',
        amount: null,
        locator: null,
        position: null,
        add: [],
        remove: [],
      },
    ],
  },
};

export const CompletedAmountHistory: Story = {
  name: 'Exact amount history and explicit completion (bounded view)',
  parameters: {
    docs: {
      description: {
        story:
          'Supplied DTO with explicit lifecycle completion, independent of the recorded amount. Native recording and authorization are unverified.',
      },
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const history = await canvas.findByRole('region', { name: m.library_progress_changes() });
    expect(
      within(history)
        .getAllByRole('heading', { level: 3 })
        .map((heading) => heading.textContent),
    ).toEqual([
      m.library_progress_change_recorded(),
      m.library_progress_change_recorded(),
      m.library_progress_state_completed(),
    ]);
    expect(within(history).getByText('0.000000')).toBeVisible();
    expect(within(history).getByText('2.500000')).toBeVisible();
    expect(canvas.getByText('2.500000 / 10 segments at acceptance')).toBeVisible();
    expect(canvas.queryByRole('button', { name: m.library_progress_update() })).not.toBeInTheDocument();
  },
  render: () => {
    setLibraryProgressStoryMode('recorded');
    return (
      <PatternStory visitor="Signed In" path={`/library/progress/${profileSessionId}`}>
        <main className="w-full max-w-4xl space-y-6 p-4">
          <ProgressSessionPage page={completedAmountPage} />
        </main>
      </PatternStory>
    );
  },
};

export const Unavailable: Story = {
  name: 'Unavailable',
  play: async (context) => {
    await pageReady(context);
    await within(context.canvasElement).findByRole('heading', { level: 1, name: m.error_heading() });
  },
  render: () => {
    setLibraryProgressStoryMode('unavailable');
    return <PageStory visitor="Signed In" path={pagePaths['library-progress-session']} />;
  },
};

export const Error: Story = {
  name: 'Error',
  play: async (context) => {
    await pageReady(context);
    await within(context.canvasElement).findByRole('heading', { level: 1, name: m.error_heading() });
  },
  render: () => {
    setLibraryProgressStoryMode('error');
    return <PageStory visitor="Signed In" path={pagePaths['library-progress-session']} />;
  },
};

function manualStory(id: string) {
  setLibraryProgressStoryMode('recorded');
  return <PageStory visitor="Signed In" path={`/library/progress/${id}`} />;
}

export const HistoricScalar: Story = {
  name: 'Historic scalar, presentation unavailable',
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await canvas.findByText(m.library_history_unavailable());
    await canvas.findByRole('link', { name: m.library_progress_new_session() });
    expect(canvas.queryByRole('button', { name: m.library_progress_update() })).not.toBeInTheDocument();
  },
  render: () => manualStory(manualScalarId),
};

export const SparseHistory: Story = {
  name: 'Three sparse keys across exact pages',
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await canvas.findByText(m.library_progress_structure_unverified());
    const units = canvas.getByRole('region', { name: m.library_progress_units() });
    expect(
      within(units)
        .getAllByRole('listitem')
        .map((item) => item.textContent),
    ).toEqual(['1', '3']);
    expect(within(units).getByRole('link', { name: m.library_progress_more() })).toBeInTheDocument();
    const history = canvas.getByRole('region', { name: m.library_progress_changes() });
    const added = within(history).getByText(m.library_progress_units_added());
    expect([...added.nextElementSibling!.querySelectorAll('li')].map((item) => item.textContent)).toEqual([
      '1',
      '3',
      '7',
    ]);
  },
  render: () => manualStory(manualSparseId),
};

export const OpaqueCursor: Story = {
  name: 'Opaque cursor stays in its original session',
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await canvas.findByText(m.library_progress_structure_unverified());
    expect((await canvas.findAllByText('epubcfi(/6/2[old-chapter])')).length).toBeGreaterThan(0);
  },
  render: () => manualStory(manualCursorId),
};

export const UnresolvedUnit: Story = {
  name: 'Unresolved original unit remains raw',
  play: async ({ canvasElement }) => {
    await within(canvasElement).findByText(/historic-unit-x/);
  },
  render: () => manualStory(manualUnresolvedId),
};

export const WithheldSummaries: Story = {
  name: 'Own raw history with current summaries withheld',
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await canvas.findAllByText(m.library_subject_unavailable());
    expect(canvas.queryByText('Selected version A')).not.toBeInTheDocument();
  },
  render: () => manualStory(manualWithheldId),
};

// Constructed native-shape responses, through the actual route tree and shell; not native recordings.
export const OriginalHistoryRoute: Story = {
  render: () => {
    setLibraryProgressStoryMode('original-history');
    return <PageStory visitor="Signed In" path={pagePaths['library-progress-session']} />;
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await canvas.findByText(m.library_progress_meaning_unknown());
    const changes = canvas.getByRole('region', { name: m.library_progress_changes() });
    expect(within(changes).getAllByRole('heading', { level: 3 })).toHaveLength(12);
    expect(canvas.queryByRole('button', { name: m.library_progress_update() })).toBeNull();
  },
};
export const IndependentHistoryRecovery: Story = {
  render: () => {
    setLibraryProgressStoryMode('original-history');
    return (
      <PageStory
        visitor="Signed In"
        path={`${pagePaths['library-progress-session']}?${new URLSearchParams(originalHistoryCursors)}`}
      />
    );
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await canvas.findByText(m.library_progress_history_reader_changes_page_empty());
    for (const [field, heading] of [
      ['changes', m.library_progress_changes()],
      ['units', m.library_progress_units()],
    ] as const) {
      const section = canvas.getByRole('region', { name: heading });
      const first = within(section).getByRole('link', { name: m.library_collections_first_page() });
      const query = new URL(first.getAttribute('href')!, 'https://rezics.test').searchParams;
      expect(query.has(field)).toBe(false);
      for (const [key, cursor] of Object.entries(originalHistoryCursors))
        if (key !== field) expect(query.get(key)).toBe(cursor);
      const next = within(section).getByRole('link', { name: m.library_progress_more() });
      const nextQuery = new URL(next.getAttribute('href')!, 'https://rezics.test').searchParams;
      expect(nextQuery.get(field)).toBe(originalHistoryNextCursors[field]);
      for (const [key, cursor] of Object.entries(originalHistoryCursors))
        if (key !== field) expect(nextQuery.get(key)).toBe(cursor);
    }
    const firstLogs = canvas.getByRole('link', { name: m.library_progress_log_reader_first_page() });
    const url = new URL(firstLogs.getAttribute('href')!, 'https://rezics.test');
    expect(url.pathname).toBe(`/${getLocale()}${pagePaths['library-progress-session']}`);
    expect(Object.fromEntries(url.searchParams)).toEqual({
      changes: originalHistoryCursors.changes,
      units: originalHistoryCursors.units,
    });
  },
};

function detailStoryPath(search: Record<string, string> = {}): string {
  const query = new URLSearchParams(search).toString();
  return `/library/progress/${profileSessionId}${query ? `?${query}` : ''}`;
}

function linkSearch(link: HTMLElement): URLSearchParams {
  return new URL((link as HTMLAnchorElement).href).searchParams;
}

const constructedRouteDescription =
  'Constructed contract-shaped responses pass through the actual Progress route. These stories do not establish native history or recording permission.';

export const NarrowOriginalHistoryRoute: Story = {
  name: 'Long original cursor history through the detail route',
  globals: { viewport: { value: 'phone390', isRotated: false } },
  parameters: { docs: { description: { story: constructedRouteDescription } } },
  play: async (context) => {
    await libraryProgressSessionReady(context);
    const canvas = within(context.canvasElement);
    await canvas.findByText(m.library_progress_meaning_unknown());
    await canvas.findByText(m.library_progress_recording_unavailable());
    expect(canvas.queryByRole('button', { name: m.library_progress_update() })).not.toBeInTheDocument();
    const history = canvas.getByRole('region', { name: m.library_progress_changes() });
    const locator = libraryProgressOriginalHistory.locator;
    expect((history.textContent?.split(locator).length ?? 1) - 1).toBe(2);
    expect(history.textContent).toContain('0.000000');
    expect(
      within(history).getByRole('heading', { level: 3, name: m.library_progress_state_completed() }),
    ).toBeVisible();
    const summary = canvas.getByText(m.library_progress_details());
    await userEvent.click(summary);
    expect(summary.closest('details')?.textContent).toContain(libraryProgressOriginalHistory.unit);
  },
  render: () => {
    setLibraryProgressStoryMode('detail-original');
    return <PageStory visitor="Signed In" path={detailStoryPath()} />;
  },
};

export const StaleChangesRecovery: Story = {
  name: 'Stale changes cursor recovers while retaining units',
  parameters: { docs: { description: { story: constructedRouteDescription } } },
  render: () => {
    setLibraryProgressStoryMode('original-history');
    return (
      <PageStory
        visitor="Signed In"
        path={`${pagePaths['library-progress-session']}?${new URLSearchParams({
          changes: originalHistoryStaleCursors.changes,
          units: originalHistoryCursors.units,
        })}`}
      />
    );
  },
  play: async (context) => {
    await libraryProgressSessionReady(context);
    const canvas = within(context.canvasElement);
    const changes = canvas.getByRole('region', { name: m.library_progress_changes() });
    expect(within(changes).getAllByRole('heading', { level: 3 })).toHaveLength(12);
    expect(within(changes).queryByRole('link', { name: m.library_collections_first_page() })).not.toBeInTheDocument();
    const next = within(changes).getByRole('link', { name: m.library_progress_more() });
    expect(linkSearch(next).get('changes')).toBe(originalHistoryCursors.changes);
    expect(linkSearch(next).get('units')).toBe(originalHistoryCursors.units);
    const units = canvas.getByRole('region', { name: m.library_progress_units() });
    await within(units).findByText(m.library_progress_history_reader_units_page_empty());
    expect(within(units).getByRole('link', { name: m.library_collections_first_page() })).toBeVisible();
  },
};

export const StaleUnitsRecovery: Story = {
  name: 'Stale completed-units cursor recovers while retaining changes',
  parameters: { docs: { description: { story: constructedRouteDescription } } },
  render: () => {
    setLibraryProgressStoryMode('original-history');
    return (
      <PageStory
        visitor="Signed In"
        path={`${pagePaths['library-progress-session']}?${new URLSearchParams({
          changes: originalHistoryCursors.changes,
          units: originalHistoryStaleCursors.units,
        })}`}
      />
    );
  },
  play: async (context) => {
    await libraryProgressSessionReady(context);
    const canvas = within(context.canvasElement);
    const changes = canvas.getByRole('region', { name: m.library_progress_changes() });
    await within(changes).findByText(m.library_progress_history_reader_changes_page_empty());
    expect(within(changes).getByRole('link', { name: m.library_collections_first_page() })).toBeVisible();
    const units = canvas.getByRole('region', { name: m.library_progress_units() });
    await within(units).findByText(originalHistoryUnit);
    expect(within(units).queryByRole('link', { name: m.library_collections_first_page() })).not.toBeInTheDocument();
    const next = within(units).getByRole('link', { name: m.library_progress_more() });
    expect(linkSearch(next).get('units')).toBe(originalHistoryCursors.units);
    expect(linkSearch(next).get('changes')).toBe(originalHistoryCursors.changes);
  },
};
