import { useMemo } from 'react';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { PersonalVndbImportPage } from '../library/personal-list-import/page';
import { VndbImportPortContext } from '../library/personal-list-import/port';
import {
  VNDB_LIFECYCLE_TARGET,
  VNDB_LIFECYCLE_UPLOAD,
  VNDB_LIFECYCLE_XML,
  vndbLifecycleChangedRow,
  vndbLifecyclePage,
  vndbLifecyclePort,
  vndbLifecyclePreviewRow,
  vndbLifecycleReviewedRow,
  vndbLifecycleUnmatchedRow,
  vndbLifecycleZeroClearRow,
} from '../library/personal-list-import/lifecycle';
import type { VndbVisit } from '../library/personal-list-import/visit';
import { PatternStory } from './page';

type Scenario = 'upload' | 'review' | 'score' | 'changed' | 'results' | 'library' | 'signed-out';
function VndbImportStory({ scenario = 'upload' }: { scenario?: Scenario }) {
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
      async delete() {
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
        <p>
          Illustrative contract-shaped fixtures using the production route. Matched, unmatched and source-zero items
          retain their provider identity. Review Library state, Progress and score independently. A native score
          requires confirmation; uploading alone has no vote effect. The first apply loses its acknowledgement; exact
          retry reports state acceptance and score unavailability separately. Use the existing result actions and
          Library return. Opening stays still; locale and viewport changes are manual.
        </p>
        <a
          className="underline"
          download="vndb-illustrative.xml"
          href={`data:application/xml,${encodeURIComponent(VNDB_LIFECYCLE_XML)}`}
        >
          Download illustrative export
        </a>
      </aside>
      <VndbImportPortContext.Provider value={port}>
        <PersonalVndbImportPage
          visit={scenario === 'signed-out' ? null : visit}
          libraryReturn={scenario === 'library'}
          {...(retained ? { address: { uploadId: VNDB_LIFECYCLE_UPLOAD, offset: 0 } } : {})}
        />
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
export const Results: Story = { name: 'Partial result journey', args: { scenario: 'results' } };
export const LibraryReturn: Story = { args: { scenario: 'library' } };
export const OtherViewer: Story = { args: { scenario: 'signed-out' } };
