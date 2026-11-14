import type { Meta, StoryObj } from '@storybook/react-vite';
import type { EntityPickerSubject } from '@rezics/ui/entity-picker';
import { expect, userEvent, within } from 'storybook/test';
import { m } from '../paraglide/messages.js';
import { PageStory, PatternStory } from './page';
import { ArchiveCollectionChooser, ArchiveOccurrenceChooser, ArchiveRecoveryReview } from '../library/archive-collection-recovery/review';
import { ArchiveRecoveryConflict, ArchiveRecoveryResults, ArchiveRecoveryUnknown } from '../library/archive-collection-recovery/results';
import { ArchiveCollectionRecoveryUpload } from '../library/archive-collection-recovery/upload';
import type {
  RecoveryCollection,
  RecoveryCollectionsPage,
  RecoveryOccurrence,
  RecoveryOccurrencesPage,
  RecoveryOutcomesPage,
  RecoveryReview,
  RecoveryStatus,
} from '../library/archive-collection-recovery/contract';
import type { OccurrenceSelection } from '../library/archive-collection-recovery/selection';

const subject: EntityPickerSubject = {
  id: '00000000-0000-4000-8000-000000000026',
  title: 'Current canonical Subject',
  types: ['schema:Book'],
  typeLabel: 'Book',
  year: 2024,
  cover: null,
};
const collection: RecoveryCollection = {
  id: '00000000-0000-4000-8000-000000000022',
  title: 'Curated reading list',
  description: 'The archive description is shown before creating a private destination.',
  metadataValid: true,
  visibility: 'private',
  membershipKind: 'manual',
  builtinKind: null,
  presentationKind: 'collection',
  presentationDisposition: 'none',
  presentationAdmissible: false,
  presentationReleaseDigest: null,
  memberCount: 2,
  orderedCount: 2,
  eligible: true,
  membershipComplete: true,
  orderComplete: true,
  visibilityDisposition: 'private',
  unsupported: null,
};
const occurrenceRows: RecoveryOccurrence[] = [
  {
    sourceOccurrenceId: '00000000-0000-4000-8000-000000000024',
    sourceSubjectId: '00000000-0000-4000-8000-000000000023',
    note: 'First occurrence note',
    notePresent: true,
    noteValid: true,
    noteState: 'value',
    orderKey: '2',
    orderPresent: true,
    orderState: 'supported',
  },
  {
    sourceOccurrenceId: '00000000-0000-4000-8000-000000000025',
    sourceSubjectId: '00000000-0000-4000-8000-000000000023',
    note: 'Second occurrence note',
    notePresent: true,
    noteValid: true,
    noteState: 'value',
    orderKey: '1',
    orderPresent: true,
    orderState: 'supported',
  },
];
const selected: OccurrenceSelection = new Map(occurrenceRows.map((row) => [row.sourceOccurrenceId, row]));
const status: RecoveryStatus = {
  uploadId: '00000000-0000-4000-8000-000000000021',
  state: 'partial',
  createdAt: null,
  expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
  manifest: null,
  coverage: [
    {
      section: 'collections',
      capture: 'present',
      treatment: 'requires-explicit-mapping',
      rows: 1,
      reason: 'supported',
    },
    { section: 'entries', capture: 'empty', treatment: 'retained-unsupported', rows: 0, reason: 'not captured' },
  ],
  sourceRecordCount: 4,
  selectedCollectionId: collection.id,
  selectedOccurrences: 2,
  cancelRequested: false,
  collectionId: '00000000-0000-4000-8000-000000000027',
  confirmation: null,
  fullRestoration: false,
  presentation: { state: 'unattempted', kind: null, source: null, releaseDigest: null, reason: null },
  pin: { state: 'unsupported', reason: null },
  sectionReasons: {},
};
const nativeReview: RecoveryReview = {
  ...status,
  state: 'reviewed',
  collectionId: null,
  review: {
    reviewId: '00000000-0000-4000-8000-000000000034',
    digest: 'b'.repeat(64),
    epoch: 1,
    presentation: { kind: null, releaseDigest: null, source: 'mixed' },
    completeOrder: false,
    completeMembership: true,
    selectedOccurrences: 2,
    mappings: [
      {
        sourceSubjectId: occurrenceRows[0]!.sourceSubjectId!,
        targetSubjectId: subject.id,
        currentSubjectId: subject.id,
        state: 'mapped',
      },
    ],
  },
  mappings: [
    {
      sourceSubjectId: occurrenceRows[0]!.sourceSubjectId!,
      targetSubjectId: subject.id,
      currentSubjectId: subject.id,
      state: 'mapped',
    },
  ],
  completeOrder: false,
  completeMembership: true,
  pin: { state: 'unsupported', reason: null, reviewedRevision: null },
};
const page: RecoveryCollectionsPage = { ...status, state: 'preview', collectionId: null, selectedCollectionId: null,
  selectedOccurrences: 0, next: 'native-next-cursor', collections: [collection] };
const outcomes: RecoveryOutcomesPage = {
  ...status,
  next: null,
  collection: { id: status.collectionId!, visibility: 'private' },
  outcomes: [
    {
      sourceOccurrenceId: occurrenceRows[0]!.sourceOccurrenceId,
      sourceSubjectId: occurrenceRows[0]!.sourceSubjectId,
      targetSubjectId: subject.id,
      nativeMemberId: '00000000-0000-4000-8000-000000000028',
      note: occurrenceRows[0]!.note,
      notePresent: true,
      noteValid: true,
      sourceNoteState: 'value',
      orderKey: occurrenceRows[0]!.orderKey,
      orderPresent: true,
      addState: 'applied',
      noteState: 'applied',
      orderState: 'applied',
      outcomeReason: null,
      outcome: 'applied',
    },
    {
      sourceOccurrenceId: occurrenceRows[1]!.sourceOccurrenceId,
      sourceSubjectId: occurrenceRows[1]!.sourceSubjectId,
      targetSubjectId: subject.id,
      nativeMemberId: null,
      note: occurrenceRows[1]!.note,
      notePresent: true,
      noteValid: true,
      sourceNoteState: 'value',
      orderKey: occurrenceRows[1]!.orderKey,
      orderPresent: true,
      addState: 'unresolved',
      noteState: 'unsupported',
      orderState: 'unsupported',
      outcomeReason: 'subject_unresolved',
      outcome: 'partial',
    },
  ],
};

const meta = {
  title: 'Library/Archive Collection recovery',
  id: 'pages-library-archive-collection-recovery',
  component: ArchiveCollectionRecoveryUpload,
  parameters: { layout: 'fullscreen' },
  decorators: [(Story, context) => context.id.endsWith('--upload') ? <Story /> : (
    <PatternStory visitor="Signed In" path="/library/recover-collections"><Story /></PatternStory>
  )],
  args: {
    busy: false,
    locked: false,
    isCurrent: () => true,
    canUseOriginal: false,
    canUseCompleted: false,
    onUpload: async () => undefined,
    onUseOriginal: async () => undefined,
    onUseCompleted: async () => undefined,
  },
} satisfies Meta<typeof ArchiveCollectionRecoveryUpload>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Upload: Story = {
  render: () => <PageStory visitor="Signed In" path="/library/recover-collections" />,
};

export const PreparingArchive: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const file = new File(['{}'], 'library.json', { type: 'application/json' });
    Object.defineProperty(file, 'arrayBuffer', { value: () => new Promise<ArrayBuffer>(() => undefined) });
    await userEvent.upload(canvas.getByLabelText(m.library_archive_recovery_file()), file);
    await userEvent.click(canvas.getByRole('button', { name: m.library_archive_recovery_upload_action() }));
    await expect(await canvas.findByRole('status')).toHaveTextContent(m.library_archive_recovery_preparing());
  },
};

export const ArchiveReadFailed: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const file = new File(['{}'], 'library.json', { type: 'application/json' });
    Object.defineProperty(file, 'arrayBuffer', {
      value: async () => {
        throw new Error('File read failed');
      },
    });
    await userEvent.upload(canvas.getByLabelText(m.library_archive_recovery_file()), file);
    await userEvent.click(canvas.getByRole('button', { name: m.library_archive_recovery_upload_action() }));
    await expect(await canvas.findByRole('alert')).toHaveTextContent(m.library_archive_recovery_upload_read_failed());
    await expect(canvas.getByLabelText(m.library_archive_recovery_file())).toBeEnabled();
    await expect(canvas.getByRole('button', { name: m.library_archive_recovery_upload_action() })).toBeEnabled();
  },
};

export const Review: Story = {
  name: 'Populated review',
  render: () => (
    <div className="mx-auto max-w-4xl p-4">
      <ArchiveRecoveryReview
        collection={collection}
        selected={selected}
        targets={new Map([[occurrenceRows[0]!.sourceSubjectId!, subject]])}
        review={nativeReview}
        busy={false}
        onTarget={() => undefined}
        onSubmit={() => undefined}
        onApply={() => undefined}
      />
    </div>
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const apply = canvas.getByRole('button', { name: m.library_archive_recovery_apply_action() });
    await expect(apply).toBeDisabled();
    await expect(canvas.getByText(m.library_archive_recovery_destination_private())).toBeVisible();
    await expect(canvas.getByText(occurrenceRows[0]!.note!)).toBeVisible();
    await expect(canvas.getByText(occurrenceRows[1]!.note!)).toBeVisible();
    await expect(canvas.getByText(m.library_archive_progress_exact()).closest('details')).not.toHaveAttribute('open');
    await userEvent.click(canvas.getByRole('checkbox', { name: m.library_archive_recovery_confirm_private() }));
    await expect(apply).toBeEnabled();
  },
};

export const StaleReviewConflict: Story = {
  render: () => (
    <div className="mx-auto max-w-4xl p-4">
      <ArchiveRecoveryConflict busy={false} onRefresh={() => undefined} />
    </div>
  ),
};

export const PartialResult: Story = {
  render: () => (
    <div className="mx-auto max-w-4xl p-4">
      <ArchiveRecoveryResults
        status={status}
        targets={new Map([[occurrenceRows[0]!.sourceSubjectId!, subject]])}
        sourceTitle={collection.title}
        page={outcomes}
        receiving={null}
        busy={false}
        canPrevious={false}
        onRead={() => undefined}
        onFirst={() => undefined}
        onPrevious={() => undefined}
        onNext={() => undefined}
        onReadCollection={() => undefined}
      />
    </div>
  ),
};

export const UnsupportedCollectionsRemainVisible: Story = {
  render: () => (
    <div className="mx-auto max-w-4xl p-4">
      <ArchiveCollectionChooser
        page={{
          ...page,
          collections: [
            { ...collection, id: '00000000-0000-4000-8000-000000000029', eligible: false, unsupported: 'dynamic' },
          ],
        }}
        busy={false}
        canPrevious={false}
        onChoose={() => undefined}
        onFirst={() => undefined}
        onPrevious={() => undefined}
        onNext={() => undefined}
      />
    </div>
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole('button', { name: m.library_archive_recovery_choose_collection() })).toBeDisabled();
    await expect(canvas.getByText(collection.title!)).toBeVisible();
    await expect(canvas.getAllByText(m.library_archive_recovery_coverage_empty())).toHaveLength(1);
    await expect(canvas.getAllByText(m.library_archive_recovery_coverage_requires_mapping({ rows: 1 }))).toHaveLength(1);
  },
};

const sparse: RecoveryOccurrencesPage = { ...status, state: 'preview', collectionId: null, collection, occurrences: [], next: 'native-sparse-next' };
export const SparseContinuation: Story = {
  render: () => (
    <div className="mx-auto max-w-4xl p-4">
      <ArchiveOccurrenceChooser page={sparse} selected={new Map()} busy={false} canPrevious={true}
        onToggle={() => undefined} onTogglePage={() => undefined} onReview={() => undefined}
        onPage={() => undefined} onFirst={() => undefined} onPrevious={() => undefined} onCollections={() => undefined} />
    </div>
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByText(m.library_archive_recovery_empty_occurrences())).toBeVisible();
    await expect(canvas.getByRole('button', { name: m.library_archive_recovery_next_page() })).toBeEnabled();
    await expect(canvas.getByRole('button', { name: m.library_archive_recovery_open_review() })).toBeDisabled();
  },
};
export const UnknownApplicationRecovery: Story = {
  render: () => (
    <div className="mx-auto max-w-4xl p-4">
      <ArchiveRecoveryUnknown busy={false} onRetry={() => undefined} />
    </div>
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole('status')).toHaveTextContent(m.library_archive_recovery_uncertain());
    await expect(canvas.getByRole('button', { name: m.library_archive_recovery_retry_original() })).toBeEnabled();
    await expect(canvas.queryByRole('link', { name: m.library_archive_recovery_open_collection() })).toBeNull();
  },
};
const completed: RecoveryOutcomesPage = {
  ...outcomes, state: 'complete',
  presentation: { state: 'mixed', kind: null, source: 'mixed', releaseDigest: null, reason: null },
  outcomes: outcomes.outcomes.map((item, index) => ({ ...item, addState: 'applied', noteState: 'applied', orderState: 'applied',
    nativeMemberId: `00000000-0000-4000-8000-00000000003${index}`, outcome: 'applied', outcomeReason: null })),
};
export const CompletedResult: Story = {
  render: () => (
    <div className="mx-auto max-w-4xl p-4">
      <ArchiveRecoveryResults status={completed} page={completed} targets={new Map([[occurrenceRows[0]!.sourceSubjectId!, subject]])}
        sourceTitle={collection.title} busy={false} canPrevious={false}
        receiving={{ id: status.collectionId!, title: 'Recovered private reading list', visibility: 'private', memberCount: 2,
          members: completed.outcomes.map((item) => ({ id: item.nativeMemberId!, subjectId: subject.id, note: item.note, addedAt: '2026-11-14T00:00:00.000Z' })), next: null }}
        onRead={() => undefined} onFirst={() => undefined} onPrevious={() => undefined} onNext={() => undefined} onReadCollection={() => undefined} />
    </div>
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole('heading', { name: m.library_archive_recovery_complete_title() })).toBeVisible();
    await expect(canvas.getByRole('heading', { name: 'Recovered private reading list' })).toBeVisible();
    await expect(canvas.getByRole('link', { name: m.library_archive_recovery_open_collection() })).toHaveAttribute('href', expect.stringContaining(status.collectionId!));
    await expect(canvas.getByText(m.library_archive_entry_current()).closest('details')).not.toHaveAttribute('open');
  },
};
