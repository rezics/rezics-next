import type { BulkOperation } from '../src/library/bulk-operation-recovery-native';
import type { BulkUndoOutcome } from '../src/library/bulk-operation-undo-evidence';
import type { LibraryRestoreResult } from '../src/library/entries-read';
export const id = '12345678-1234-4234-8234-123456789abc';
export const operation: BulkOperation = {
  id,
  route: 1,
  action: 'remove_from_library',
  state: null,
  collectionId: null,
  selectionKind: 'explicit',
  selectionSource: null,
  phase: 'completed',
  selectionComplete: true,
  occurrencesComplete: true,
  cancelRequested: false,
  counts: {
    scannedCandidates: 2,
    selectedSubjects: 2,
    scannedOccurrences: 0,
    capturedOccurrences: 0,
    targets: 2,
    applied: 2,
    pending: 0,
    no_effect: 0,
    reconciling: 0,
    conflict: 0,
    denied: 0,
    failed: 0,
    cancelled: 0,
  },
  summary: null,
  admittedAt: '2026-11-03T00:00:00Z',
  targetBoundAt: null,
  expiresAt: '2099-11-04T00:00:00Z',
  resultsExpireAt: '2099-11-05T00:00:00Z',
  finishedAt: '2026-11-03T01:00:00Z',
  reason: null,
};
export const outcome: BulkUndoOutcome = {
  ordinal: '0',
  subjectId: 'book-one',
  memberId: null,
  resultingMemberId: null,
  state: 'applied',
  reason: null,
  memberDeletion: null,
  deletion: { deletionId: id, revision: 12, restoreUntil: '2099-11-04T00:00:00Z' },
};

export const restored: LibraryRestoreResult = {
  ok: true,
  entry: {
    subjectId: 'one',
    state: 'active',
    revision: 13,
    createdAt: '2026-11-03T00:00:00Z',
    updatedAt: '2026-11-05T00:00:00Z',
    subject: null,
  },
};
