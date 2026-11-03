import type { Meta, StoryObj } from '@storybook/react-vite';
import { fn } from 'storybook/test';
import { LibraryBulkOperationRecoveryView } from '../library/bulk-operation-recovery-view';
import type { BulkOperation } from '../library/bulk-operation-recovery-native';
import type { LibraryBulkOutcome, LibraryBulkRecoveryRead } from '../library/bulk-operation-recovery';

const meta = {
  title: 'Pages/Library/Bulk Operation Recovery',
  parameters: { layout: 'fullscreen' },
} satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;

const operationId = '01b5b3de-6ad2-7fc8-a604-e058df922001';
const retiredAddressId = '01b5b3de-6ad2-7fc8-a604-e058df922099';

const workingCounts: BulkOperation['counts'] = {
  scannedCandidates: 3,
  selectedSubjects: 3,
  scannedOccurrences: 0,
  capturedOccurrences: 0,
  targets: 3,
  pending: 1,
  reconciling: 1,
  applied: 1,
  no_effect: 0,
  conflict: 0,
  denied: 0,
  failed: 0,
  cancelled: 0,
};

const mixedCounts: BulkOperation['counts'] = {
  ...workingCounts,
  pending: 0,
  reconciling: 0,
  conflict: 1,
  failed: 1,
};

const oneCompletedCount: BulkOperation['counts'] = {
  ...workingCounts,
  scannedCandidates: 1,
  selectedSubjects: 1,
  targets: 1,
  pending: 0,
  reconciling: 0,
  applied: 1,
};

const pagedCounts: BulkOperation['counts'] = {
  ...oneCompletedCount,
  scannedCandidates: 21,
  selectedSubjects: 21,
  targets: 21,
  applied: 21,
};

function operation(phase: BulkOperation['phase'], counts: BulkOperation['counts'] = workingCounts): BulkOperation {
  return {
    id: operationId,
    route: 1,
    action: 'set_status',
    state: null,
    collectionId: null,
    selectionKind: 'explicit',
    phase,
    selectionComplete: true,
    occurrencesComplete: true,
    cancelRequested: false,
    counts,
    summary: null,
    admittedAt: '2026-11-03T01:00:00.000Z',
    targetBoundAt: null,
    expiresAt: '2026-11-04T01:00:00.000Z',
    resultsExpireAt: '2026-11-05T01:00:00.000Z',
    finishedAt: phase === 'applying' ? null : '2026-11-03T02:00:00.000Z',
    reason: null,
  };
}

function outcome(state: LibraryBulkOutcome['state'], ordinal: string, subjectId: string): LibraryBulkOutcome {
  return { ordinal, subjectId, memberId: null, resultingMemberId: null, state, reason: null };
}

function fixture({
  label,
  read,
  addressOperationId = operationId,
  authorized = true,
  cancelState = 'idle',
}: {
  label: string;
  read: LibraryBulkRecoveryRead;
  addressOperationId?: string;
  authorized?: boolean;
  cancelState?: 'idle' | 'capturing' | 'pending' | 'uncertain' | 'refused' | 'accepted';
}): Story {
  return {
    name: `Constructed fixture / ${label}`,
    parameters: {
      docs: { description: { story: 'Constructed UI fixture; not a native recording or passing interface evidence.' } },
    },
    render: () => (
      <LibraryBulkOperationRecoveryView
        addressOperationId={addressOperationId}
        authorized={authorized}
        read={read}
        readAgain={fn()}
        readMore={fn()}
        cancel={fn()}
        retryCancel={fn()}
        cancelState={cancelState}
      />
    ),
  };
}

export const WorkingAdmittedOperation = fixture({
  label: 'working admitted operation',
  read: {
    state: 'available',
    operation: operation('applying'),
    outcomes: [
      outcome('applied', '0', 'fixture-subject-one'),
      outcome('pending', '1', 'fixture-subject-two'),
      outcome('reconciling', '2', 'fixture-subject-three'),
    ],
    next: null,
  },
});

export const CompletedMixedResults = fixture({
  label: 'completed mixed per-target results',
  read: {
    state: 'available',
    operation: operation('completed_with_errors', mixedCounts),
    outcomes: [
      outcome('applied', '0', 'fixture-subject-one'),
      outcome('conflict', '1', 'fixture-subject-two'),
      outcome('failed', '2', 'fixture-subject-three'),
    ],
    next: null,
  },
});

export const ReadUnavailableRetry = fixture({
  label: 'read unavailable and retry',
  read: { state: 'unavailable', operationId },
});

export const ForbiddenAddress = fixture({
  label: 'forbidden address',
  authorized: false,
  read: { state: 'forbidden', operationId },
});

export const RetiredAddress = fixture({
  label: 'retired address',
  read: {
    state: 'available',
    operation: operation('completed', oneCompletedCount),
    outcomes: [outcome('applied', '0', 'fixture-subject-one')],
    next: null,
  },
  addressOperationId: retiredAddressId,
});

export const ExpiredReport = fixture({
  label: 'expired report',
  read: { state: 'expired', operationId },
});

export const PagedResults = fixture({
  label: 'paged results',
  read: {
    state: 'available',
    operation: operation('completed', pagedCounts),
    outcomes: Array.from({ length: 20 }, (_, index) =>
      outcome('applied', String(index), `fixture-subject-${String(index + 1).padStart(2, '0')}`),
    ),
    next: 'native-cursor-fixture',
  },
});

export const UncertainCancellation = fixture({
  label: 'uncertain original cancellation',
  read: {
    state: 'available',
    operation: operation('applying'),
    outcomes: [
      outcome('applied', '0', 'fixture-subject-one'),
      outcome('pending', '1', 'fixture-subject-two'),
      outcome('reconciling', '2', 'fixture-subject-three'),
    ],
    next: null,
  },
  cancelState: 'uncertain',
});
