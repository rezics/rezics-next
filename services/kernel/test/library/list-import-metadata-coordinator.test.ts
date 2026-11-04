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

for (const status of ['applied', 'stale', 'unsupported'] as const) {
  test(`a delayed pending checkpoint cannot replace ${status} or its original operands`, () => {
    const pending = confirmation();
    pending.annotationStarted = true;
    pending.annotationInput = {
      revision: 3,
      note: { op: 'set', value: 'Original' },
      priority: { op: 'unchanged' },
      effect: true,
      expectedRevision: 4,
      expectedNote: 'Original',
      expectedPriority: null,
    };
    const terminal = {
      ...pending,
      annotationStatus: status,
      provenanceStatus: status,
      outcome: { reviewToken: 'first', fields: [{ field: 'note' as const, status }] },
    };
    const merged = mergeListImportMetadataConfirmation(terminal, {
      ...pending,
      annotationStatus: 'unattempted',
      provenanceStatus: 'unattempted',
    });
    expect(merged).toEqual(terminal);
    expect(() =>
      mergeListImportMetadataConfirmation(terminal, {
        ...pending,
        annotationInput: { ...pending.annotationInput!, note: { op: 'set', value: 'Substituted' } },
      }),
    ).toThrow();
    expect(mergeListImportMetadataConfirmation(pending, terminal)).toEqual(terminal);
  });
}

test('pending effects block refresh and byte limits include the complete review history', () => {
  const pending = review('first', 'one', confirmation());
  expect(() => appendListImportMetadataReview([pending], review('second', 'two'))).toThrow();
  const oversized = review('second', 'two');
  oversized.sourceReviewToken = '界'.repeat(11_000);
  expect(() => appendListImportMetadataReview([], oversized)).toThrow();
  const retained = review('first', 'one');
  retained.sourceReviewToken = 'x'.repeat(32_000);
  expect(appendListImportMetadataReview([], retained).history).toEqual([retained]);
  expect(() => appendListImportMetadataReview([retained], oversized)).toThrow();
});

test('two individual maximum reviews also obey the encoded history limit', () => {
  const sized = (token: string, bytes: number) => {
    const item = review(token, token);
    item.sourceReviewToken = '';
    item.sourceReviewToken = 'x'.repeat(bytes - Buffer.byteLength(JSON.stringify(item)));
    return item;
  };
  const first = sized('first', 32768);
  expect(appendListImportMetadataReview([], first).history).toEqual([first]);
  expect(() => appendListImportMetadataReview([first], sized('second', 32768))).toThrow();
  expect(appendListImportMetadataReview([sized('first', 32766)], sized('second', 32766)).history).toHaveLength(2);
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
