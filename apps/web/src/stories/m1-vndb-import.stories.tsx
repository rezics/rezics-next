import { useMemo, useState } from 'react';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, waitFor, within } from 'storybook/test';
import { PersonalVndbImportPage } from '../library/personal-list-import/page';
import { VndbImportPortContext } from '../library/personal-list-import/port';
import {
  VNDB_LIFECYCLE_TARGET,
  VNDB_LIFECYCLE_UPLOAD,
  VNDB_LIFECYCLE_XML,
  vndbLifecycleChangedRow,
  vndbLifecyclePage,
  vndbLifecycleLibraryPage,
  vndbLifecyclePort,
  vndbLifecyclePreviewRow,
  vndbLifecycleReviewedRow,
  vndbLifecycleUnmatchedRow,
  vndbLifecycleZeroClearRow,
} from '../library/personal-list-import/lifecycle';
import type { VndbVisit } from '../library/personal-list-import/visit';
import { ImportLibraryReaderContext } from '../library/showcase-import-return/current';
import type { ImportLibraryPage, ImportLibraryRead } from '../library/showcase-import-return/read';
import { m } from '../paraglide/messages.js';
import { PatternStory } from './page';

function illustrativeLibraryPage(): ImportLibraryPage {
  const page = vndbLifecycleLibraryPage();
  const first = page.libraryEntries[0]!;
  const libraryEntries = [
    first,
    {
      ...first,
      updatedAt: '2026-11-05T12:34:00Z',
      activeProgressSession: {
        mode: 'scalar_amount' as const,
        unit: 'page',
        amount: '0',
        total: '12',
        completedUnitCount: 0,
        locator: null,
      },
    },
    {
      ...page.libraryEntries[2]!,
      subject: null,
      activeProgressSession: {
        mode: 'cursor_position' as const,
        unit: 'page',
        amount: null,
        total: null,
        completedUnitCount: 0,
        locator: 'Native position without a total',
      },
    },
  ];
  if (page.viewerFacts?.state !== 'current') throw new Error('The Library fixture needs current vote facts.');
  const facts = page.viewerFacts;
  return {
    ...page,
    libraryEntries,
    viewerFacts: {
      ...facts,
      rows: libraryEntries.map((entry, index) => ({
        ...facts.rows[index]!,
        rowKey: String(index),
        subjectId: entry.subjectId,
        entry: { state: 'present', incarnationId: null, entryState: entry.state, revision: entry.revision },
        vote: facts.rows[index === 0 ? 1 : index === 1 ? 0 : 2]!.vote,
      })),
    },
  };
}

type Scenario =
  | 'upload'
  | 'review'
  | 'score'
  | 'changed'
  | 'results'
  | 'library'
  | 'signed-out'
  | 'cleanup-unknown'
  | 'cleanup-unavailable';
function VndbImportStory({ scenario = 'upload' }: { scenario?: Scenario }) {
  const [readerVersion, setReaderVersion] = useState(0);
  const libraryReader = useMemo(() => {
    const page = illustrativeLibraryPage();
    // Reuse even the observation object: successful revision replacement must still retire detail.
    const observation: ImportLibraryRead = { state: 'current', page };
    let reads = 0;
    return async (): Promise<ImportLibraryRead> => (++reads === 2 ? { state: 'unavailable' } : observation);
  }, [readerVersion]);
  const port = useMemo(() => {
    const matched =
      scenario === 'changed'
        ? vndbLifecycleChangedRow()
        : scenario === 'score' || scenario === 'results'
          ? vndbLifecycleReviewedRow()
          : vndbLifecyclePreviewRow();
    const page = vndbLifecyclePage([
      matched,
      vndbLifecycleZeroClearRow(),
      { ...vndbLifecycleUnmatchedRow(), ordinal: 2 },
    ]);
    let firstApply = true;
    let firstCleanup = true;
    const base = vndbLifecyclePort(page);
    return vndbLifecyclePort(page, {
      async apply(command) {
        if (firstApply) {
          firstApply = false;
          return { kind: 'unknown', command };
        }
        return base.apply(command);
      },
      async cancel() {
        return { kind: 'cancelled' };
      },
      async delete(command) {
        if (firstCleanup && (scenario === 'cleanup-unknown' || scenario === 'cleanup-unavailable')) {
          firstCleanup = false;
          return scenario === 'cleanup-unknown' ? { kind: 'unknown', command } : { kind: 'unavailable', status: 503 };
        }
        return { kind: 'deleted' };
      },
    });
  }, [scenario]);
  const visit = useMemo<VndbVisit>(() => {
    const controller = new AbortController();
    return {
      subject: VNDB_LIFECYCLE_TARGET,
      csrfToken: 'story-csrf',
      controller,
      current: () => !controller.signal.aborted,
      retire: () => controller.abort(),
    };
  }, []);
  const retained = scenario !== 'upload' && scenario !== 'signed-out' && scenario !== 'library';
  return (
    <PatternStory path="/library/import-vndb" visitor={scenario === 'signed-out' ? 'Signed Out' : 'Signed In'}>
      <aside className="mx-auto max-w-5xl space-y-2 border-b p-4 text-sm">
        {scenario.startsWith('cleanup-') ? (
          <p>
            Choose Replace upload and submit the sample. The first removal is uncertain or unavailable. Retry that
            removal, choose a newer replacement, or withdraw replacement while removal remains pending. Cleanup never
            reopens the old review or reverses acknowledged Library and score effects.
          </p>
        ) : null}
        <p>
          Illustrative contract-shaped fixtures using the production route. Matched, unmatched and source-zero items
          retain their provider identity. Review Library state, Progress and score independently. A native score
          requires confirmation; uploading alone has no vote effect. The first apply loses its acknowledgement; exact
          retry reports state acceptance and score unavailability separately. Use the existing result actions and
          Library return. Opening stays still; locale and viewport changes are manual.
        </p>
        {scenario === 'library' ? (
          <button type="button" className="min-h-11 underline" onClick={() => setReaderVersion((value) => value + 1)}>
            Replace illustrative Library source
          </button>
        ) : null}
        <a
          className="underline"
          download="vndb-illustrative.xml"
          href={`data:application/xml,${encodeURIComponent(VNDB_LIFECYCLE_XML)}`}
        >
          Download illustrative export
        </a>
      </aside>
      <VndbImportPortContext.Provider value={port}>
        <ImportLibraryReaderContext.Provider value={libraryReader}>
          <PersonalVndbImportPage
            visit={scenario === 'signed-out' ? null : visit}
            libraryReturn={scenario === 'library'}
            {...(retained ? { address: { uploadId: VNDB_LIFECYCLE_UPLOAD, offset: 0 } } : {})}
          />
        </ImportLibraryReaderContext.Provider>
      </VndbImportPortContext.Provider>
    </PatternStory>
  );
}
const meta = {
  title: 'Library/VNDB import',
  id: 'pages-library-vndb-import',
  component: VndbImportStory,
  parameters: { layout: 'fullscreen' },
} satisfies Meta<typeof VndbImportStory>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Upload: Story = { args: { scenario: 'upload' } };
export const Review: Story = { args: { scenario: 'review' } };
export const ScoreReview: Story = { args: { scenario: 'score' } };
export const UnchangedReopen: Story = { args: { scenario: 'review' } };
export const ChangedReimport: Story = { args: { scenario: 'changed' } };
export const Results: Story = {
  name: 'Partial result journey',
  args: { scenario: 'results' },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(await canvas.findByRole('button', { name: m.library_vndb_confirm_selection({ count: 2 }) }));
    await userEvent.click(await canvas.findByRole('button', { name: m.library_vndb_apply_selection({ count: 2 }) }));
    await userEvent.click(await canvas.findByRole('button', { name: m.library_bangumi_retry_command() }));
    await inspectCurrentLibrary(canvasElement);
  },
};
export const LibraryReturn: Story = {
  args: { scenario: 'library' },
  play: async ({ canvasElement }) => {
    await inspectCurrentLibrary(canvasElement);
    const canvas = within(canvasElement);
    const root = canvasElement.querySelector<HTMLElement>('[data-vndb-library-return]')!;
    await userEvent.click(within(root).getAllByRole('button', { expanded: false }).at(-1)!);
    await userEvent.click(canvas.getByRole('button', { name: 'Replace illustrative Library source' }));
    await waitFor(() => expect(root.querySelector('[data-vndb-inspected-entry]')).toBeNull());
    await userEvent.click(within(root).getByRole('button', { name: m.library_vndb_library_refresh() }));
    await waitFor(() => expect(root.querySelectorAll('[data-vndb-current-entry]')).toHaveLength(3));
    expect(root.querySelector('[data-vndb-inspected-entry]')).toBeNull();
  },
};

async function inspectCurrentLibrary(canvasElement: HTMLElement) {
  const canvas = within(canvasElement);
  await userEvent.click(await canvas.findByRole('button', { name: m.library_vndb_library_refresh() }));
  const root = canvasElement.querySelector<HTMLElement>('[data-vndb-library-return]')!;
  const view = within(root);
  await waitFor(() => expect(root.querySelectorAll('[data-vndb-current-entry]')).toHaveLength(3));
  for (const name of [m.library_layout_list(), m.library_layout_grid(), m.library_layout_table()]) {
    await userEvent.click(view.getByRole('button', { name, exact: true }));
    expect(root.querySelector('[data-vndb-inspected-entry]')).toBeNull();
    const openers = view.getAllByRole('button', { expanded: false });
    const opener = openers[1]!;
    opener.scrollIntoView({ block: 'center' });
    opener.focus({ preventScroll: true });
    const viewport = root.ownerDocument.defaultView!;
    const scroll = [viewport.scrollX, viewport.scrollY];
    await userEvent.keyboard('{Enter}');
    const detail = view.getByRole('region', { name: m.library_vndb_browse_inspection_title() });
    expect(opener).toHaveFocus();
    expect([viewport.scrollX, viewport.scrollY]).toEqual(scroll);
    expect(root.querySelectorAll('[data-vndb-inspected-entry]')).toHaveLength(1);
    const occurrence = opener.closest('[data-slot="list-row"], [data-slot="collection-member-card"], tr')!;
    if (occurrence.tagName === 'TR') {
      expect(occurrence.nextElementSibling).toContainElement(detail);
      expect(detail.closest('td')).toHaveAttribute('colspan', '6');
    } else expect(occurrence).toContainElement(detail);
    expect(detail.closest('a')).toBeNull();
    expect(within(detail).getByText('0 / 12')).toBeVisible();
    expect(detail.querySelector('[data-vndb-native-vote-zero]')).not.toBeNull();
    expect(within(detail).getByRole('link', { name: m.library_vndb_browse_inspection_work() })).toHaveAttribute(
      'href',
      expect.stringContaining('via='),
    );
    await userEvent.tab();
    expect(within(detail).getByRole('button', { name: m.library_vndb_browse_inspection_close() })).toHaveFocus();
    const work = within(detail).getByRole('link', { name: m.library_vndb_browse_inspection_work() });
    let remaining = detail.querySelectorAll('a,button').length;
    while (root.ownerDocument.activeElement !== work && remaining-- > 0) await userEvent.tab();
    expect(work).toHaveFocus();
    await userEvent.keyboard('{Escape}');
    expect(opener).toHaveFocus();
    expect(root.querySelector('[data-vndb-inspected-entry]')).toBeNull();
    await userEvent.click(openers[2]!);
    const withheld = view.getByRole('region', { name: m.library_vndb_browse_inspection_title() });
    expect(within(withheld).queryByRole('link', { name: m.library_vndb_browse_inspection_work() })).toBeNull();
    expect(within(withheld).queryByRole('progressbar')).toBeNull();
    expect(within(withheld).getByText('Native position without a total')).toBeVisible();
    await userEvent.click(within(withheld).getByRole('button', { name: m.library_vndb_browse_inspection_close() }));
    expect(openers[2]).toHaveFocus();
    await userEvent.click(opener);
    await userEvent.keyboard('{Escape}');
    expect(opener).toHaveFocus();
    await userEvent.click(opener);
  }
  await userEvent.click(view.getByRole('button', { name: m.library_vndb_browse_refresh() }));
  await view.findByRole('button', { name: m.library_vndb_browse_retry() });
  expect(root.querySelector('[data-vndb-inspected-entry]')).not.toBeNull();
  await userEvent.click(view.getByRole('button', { name: m.library_vndb_browse_retry() }));
  await waitFor(() => expect(root.querySelector('[data-vndb-inspected-entry]')).toBeNull());
  expect(view.queryByRole('dialog')).toBeNull();
}
export const OtherViewer: Story = { args: { scenario: 'signed-out' } };

export const ReplacementCleanupUnknown: Story = { args: { scenario: 'cleanup-unknown' } };
export const ReplacementCleanupUnavailable: Story = { args: { scenario: 'cleanup-unavailable' } };
