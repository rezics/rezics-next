import { expect, test } from 'bun:test';
import type {
  EntryImportMetadataConfirmation,
  EntryImportMetadataReview,
} from '../../src/library/list-import-entry-metadata.ts';
import {
  appendListImportMetadataReview,
  mergeListImportMetadataConfirmation,
  selectListImportMetadataConfirmation,
} from '../../src/library/list-import-metadata-coordinator.ts';

const fields = [{ field: 'note' as const, action: 'adopt' as const }];

function confirmation(): EntryImportMetadataConfirmation {
  return {
    fields,
    selectionDigest: 'selection-v1',
    annotationKey: 'original-annotation-key',
    provenanceKey: 'original-provenance-key',
    annotationStarted: false,
    provenanceStarted: false,
  };
}

function review(
  token: string,
  requestDigest: string,
  saved?: EntryImportMetadataConfirmation,
): EntryImportMetadataReview {
  return {
    token,
    requestDigest,
    sourceReviewToken: 'source-review',
    subjectId: 'subject',
    clientId: 'client',
    requestedBy: null,
    annotationRevision: 0,
    personalDigest: 'personal',
    sourceDigest: 'source',
    profileDigest: 'profile',
    incarnationId: null,
    ...(saved === undefined ? {} : { confirmation: saved }),
  };
}

test('metadata history, selection and progress transitions preserve the original confirmation', () => {
  const first = review('first', 'request-one'),
    duplicate = appendListImportMetadataReview([first], review('replacement', 'request-one'));
  expect(duplicate).toMatchObject({ reviewToken: 'first', added: false });

  const second = appendListImportMetadataReview([first], review('second', 'request-two'));
  expect(second).toMatchObject({ reviewToken: 'second', added: true });
  expect(() => appendListImportMetadataReview(second.history, review('third', 'request-three'))).toThrow();

  const original = confirmation(),
    changedKey = { ...original, annotationKey: 'refreshed-key' };
  expect(selectListImportMetadataConfirmation(original, changedKey)).toBe(original);
  expect(() => selectListImportMetadataConfirmation(original, { ...changedKey, selectionDigest: 'other' })).toThrow();

  const complete = {
      ...original,
      annotationStarted: true,
      annotationStatus: 'applied' as const,
      outcome: { reviewToken: 'first', fields: [{ field: 'note' as const, status: 'applied' as const }] },
    },
    merged = mergeListImportMetadataConfirmation(complete, original);
  expect(merged.outcome).toEqual(complete.outcome);
  expect(merged.annotationStatus).toBe('applied');
  expect(merged.annotationStarted).toBe(true);

  const oldVndb = confirmation();
  expect(Object.hasOwn(mergeListImportMetadataConfirmation(oldVndb, oldVndb), 'nativeAdmission')).toBe(false);
});

test('expiry merge keeps receipt authority and completed outcomes without restoring private operands', () => {
  const pending = {
    ...confirmation(),
    annotationStarted: true,
    annotationReceiptDigest: 'a'.repeat(64),
    annotationInput: {
      revision: 0,
      note: { op: 'set' as const, value: 'private note' },
      priority: { op: 'unchanged' as const },
      effect: true,
      expectedRevision: 1,
      expectedNote: 'private note',
      expectedPriority: null,
    },
  };
  const completed = {
      ...pending,
      sourceExpired: true,
      annotationStatus: 'applied' as const,
      outcome: { reviewToken: 'first', fields: [{ field: 'note' as const, status: 'applied' as const }] },
      annotationInput: undefined,
    },
    late = { ...pending, annotationStatus: 'unattempted' as const, outcome: undefined };
  const merged = mergeListImportMetadataConfirmation(completed, late);
  expect(merged.outcome).toEqual(completed.outcome);
  expect(merged.annotationStatus).toBe('applied');
  expect(merged.annotationReceiptDigest).toBe('a'.repeat(64));
  expect(merged.annotationInput).toBeUndefined();
  expect(merged.sourceExpired).toBe(true);
});
