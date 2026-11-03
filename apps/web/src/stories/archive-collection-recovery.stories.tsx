import type { Meta, StoryObj } from '@storybook/react-vite';
import type { EntityPickerSubject } from '@rezics/ui/entity-picker';
import {
  ArchiveCollectionChooser,
  ArchiveRecoveryReview,
} from '../library/archive-collection-recovery/review';
import { ArchiveRecoveryConflict, ArchiveRecoveryResults } from '../library/archive-collection-recovery/results';
import { ArchiveCollectionRecoveryUpload } from '../library/archive-collection-recovery/upload';
import type {
  RecoveryCollection,
  RecoveryCollectionsPage,
  RecoveryOccurrence,
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
  expiresAt: '2099-01-01T00:00:00.000Z',
  manifest: null,
  coverage: [
    { section: 'collections', capture: 'present', treatment: 'requires-explicit-mapping', rows: 1, reason: 'supported' },
    { section: 'entries', capture: 'empty', treatment: 'retained-unsupported', rows: 0, reason: 'not captured' },
  ],
  sourceRecordCount: 4,
  selectedCollectionId: collection.id,
  selectedOccurrences: 2,
  cancelRequested: false,
  collectionId: '00000000-0000-4000-8000-000000000027',
  confirmation: null,
  pin: { state: 'unsupported', reason: null },
  sectionReasons: {},
};
const nativeReview: RecoveryReview = {
  ...status,
  state: 'reviewed',
  review: {
    reviewId: 'story-review',
    digest: 'b'.repeat(64),
    epoch: 1,
    completeOrder: false,
    completeMembership: true,
    selectedOccurrences: 2,
    mappings: [{ sourceSubjectId: occurrenceRows[0]!.sourceSubjectId!, targetSubjectId: subject.id, currentSubjectId: subject.id, state: 'mapped' }],
  },
  mappings: [{ sourceSubjectId: occurrenceRows[0]!.sourceSubjectId!, targetSubjectId: subject.id, currentSubjectId: subject.id, state: 'mapped' }],
  completeOrder: false,
  completeMembership: true,
  pin: { state: 'unsupported', reason: null, reviewedRevision: null },
};
const page: RecoveryCollectionsPage = { ...status, next: 'native-next-cursor', collections: [collection] };
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
  title: 'Pages/Library/Archive Collection recovery',
  component: ArchiveCollectionRecoveryUpload,
  args: { busy: false, locked: false, onUpload: async () => undefined },
} satisfies Meta<typeof ArchiveCollectionRecoveryUpload>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Upload: Story = {};

export const Review: Story = {
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
        page={outcomes}
        busy={false}
        onRead={() => undefined}
        onFirst={() => undefined}
        onNext={() => undefined}
      />
    </div>
  ),
};

export const UnsupportedCollectionsRemainVisible: Story = {
  render: () => (
    <div className="mx-auto max-w-4xl p-4">
      <ArchiveCollectionChooser
        page={{ ...page, collections: [{ ...collection, id: '00000000-0000-4000-8000-000000000029', eligible: false, unsupported: 'dynamic' }] }}
        busy={false}
        onChoose={() => undefined}
        onFirst={() => undefined}
        onNext={() => undefined}
      />
    </div>
  ),
};
