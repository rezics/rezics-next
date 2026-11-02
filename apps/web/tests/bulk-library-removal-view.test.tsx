import { expect, test } from 'bun:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  captureBulkLibraryRemovalPreview,
  createBulkLibraryRemovalManifest,
  type BulkLibraryRemovalOperation,
  type BulkLibraryRemovalTargetOutcome,
} from '../src/library/bulk-library-removal';
import type {
  BulkLibraryRemovalController,
  BulkLibraryRemovalReview,
} from '../src/library/bulk-library-removal-controller';
import { BulkLibraryRemovalReviewView } from '../src/library/bulk-library-removal-view';

const ids = ['subject-1', 'subject-2'];
const operation: BulkLibraryRemovalOperation = {
  id: '01b5b3de-6ad2-7fc8-a604-e058df922001',
  route: 1,
  action: 'remove_from_library',
  selectionKind: 'explicit',
  state: null,
  collectionId: null,
  phase: 'preview',
  selectionComplete: true,
  occurrencesComplete: true,
  cancelRequested: false,
  counts: {
    scannedCandidates: 0,
    selectedSubjects: 2,
    scannedOccurrences: 0,
    capturedOccurrences: 0,
    targets: 2,
    pending: 0,
    reconciling: 0,
    applied: 0,
    no_effect: 0,
    conflict: 0,
    denied: 0,
    failed: 0,
    cancelled: 0,
  },
  summary: null,
  admittedAt: '2026-11-03T01:00:00.000Z',
  targetBoundAt: null,
  expiresAt: '2026-11-04T01:00:00.000Z',
  resultsExpireAt: '2026-11-05T01:00:00.000Z',
  finishedAt: null,
  reason: null,
};
const outcome = (
  ordinal: number,
  subjectId: string,
  state: BulkLibraryRemovalTargetOutcome['state'],
  reason: BulkLibraryRemovalTargetOutcome['reason'] = null,
): BulkLibraryRemovalTargetOutcome => ({
  ordinal: String(ordinal),
  subjectId,
  memberId: null,
  state,
  reason,
  resultingMemberId: null,
});

test('shows the exact action, count, operation identity and independent data kept without sending a command', () => {
  const captured = captureBulkLibraryRemovalPreview(
    ids.map((subjectId) => ({ subjectId, subject: { id: subjectId }, revision: 1, removeKey: 'remove' })),
  );
  if (!captured.ok) throw new Error('Expected an explicit native preview');
  const calls: string[] = [];
  const manifest = createBulkLibraryRemovalManifest(
    captured,
    {},
    {
      preview: async () => {
        calls.push('preview');
        return operation;
      },
      confirm: async () => {
        calls.push('confirm');
        return operation;
      },
      read: async () => {
        calls.push('read');
        return { operation, outcomes: [] };
      },
    },
  );
  const review: BulkLibraryRemovalReview = {
    manifest,
    signature: captured.signature,
    locale: 'en',
    targets: ids.map((subjectId) => ({ subjectId, title: `Title ${subjectId}` })),
    operationId: operation.id,
    operation,
    outcomes: [
      outcome(0, ids[0]!, 'conflict', 'revision_mismatch'),
      outcome(1, ids[1]!, 'conflict', 'incarnation_mismatch'),
    ],
    phase: 'ready',
  };
  const controller: BulkLibraryRemovalController = {
    review,
    changed: false,
    error: null,
    busy: false,
    showAction: true,
    canPreview: false,
    canRetryPreview: false,
    canConfirm: true,
    canRecover: true,
    preview: async () => calls.push('preview'),
    retryPreview: async () => calls.push('preview-retry'),
    confirm: async () => calls.push('confirm'),
    recover: async () => calls.push('read'),
  };
  const html = renderToStaticMarkup(createElement(BulkLibraryRemovalReviewView, { controller, pending: false }));

  expect(html).toContain('Remove 2 entries');
  expect(html).toContain('Operation ID:');
  expect(html).toContain('Only personal tracking entries are removed');
  expect(html).toContain('Copies');
  expect(html).toContain('Skipped because the entry changed');
  expect(html).toContain('Skipped because the entry was recreated');
  expect(calls).toEqual([]);
});
