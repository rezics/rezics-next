import { expect, test } from 'bun:test';
import type { EntryImportMetadataConfirmation } from '../../src/library/list-import-entry-metadata.ts';
import {
  confirmListImportMetadata,
  listImportMetadataFenceFacts,
  listImportMetadataFirstPhaseEligible,
  listImportMetadataProposedConfirmation,
  persistListImportMetadata,
  recoverListImportMetadataExpiredOutcome,
  type ListImportMetadataFenceFacts,
} from '../../src/library/list-import-metadata-core.ts';

const providers = [
  { provider: 'anilist', nativeAdmission: undefined },
  { provider: 'bangumi', nativeAdmission: 'bangumi-source-v1' as const },
  { provider: 'mal', nativeAdmission: undefined },
  { provider: 'vndb', nativeAdmission: 'vndb-source-v1' as const },
];

const fields = [
  { field: 'note' as const, action: 'adopt' as const },
  { field: 'privacy' as const, action: 'adopt' as const },
  { field: 'sourceCreated' as const, action: 'adopt' as const },
  { field: 'sourceUpdated' as const, action: 'adopt' as const },
];
const selectionDigest = 'selection-v1';

function eligibleFacts(): ListImportMetadataFenceFacts {
  return listImportMetadataFenceFacts({
    currentSourceReviewToken: 'source-review',
    boundSourceReviewToken: 'source-review',
    currentSourceDigest: 'source-digest',
    boundSourceDigest: 'source-digest',
    currentProfileDigest: 'profile-digest',
    boundProfileDigest: 'profile-digest',
    currentIncarnationId: 'incarnation',
    boundIncarnationId: 'incarnation',
  });
}

function proposed(provider: string, admission?: EntryImportMetadataConfirmation['nativeAdmission']) {
  return listImportMetadataProposedConfirmation({
    fields,
    selectionDigest,
    annotationKey: `${provider}:upload:0:review:annotations`,
    provenanceKey: `${provider}:upload:0:review:provenance`,
    nativeAdmission: admission,
  });
}

function operands(
  provider: string,
): Pick<
  EntryImportMetadataConfirmation,
  | 'annotationInput'
  | 'provenanceInput'
  | 'annotationReceiptDigest'
  | 'provenanceReceiptDigest'
  | 'sourceObservationDigest'
> {
  return {
    annotationInput: {
      revision: 0,
      note: { op: 'set', value: 'Imported note' },
      priority: { op: 'unchanged' },
      effect: true,
      expectedRevision: 1,
      expectedNote: 'Imported note',
      expectedPriority: null,
    },
    provenanceInput: {
      kind: 'admit',
      effect: true,
      value: {
        provider,
        recordId: `${provider}-1`,
        confirmReviewed: true,
        privacy: { status: 'known', meaning: 'private' },
        sourceCreated: { status: 'known', value: '2020-01-01' },
        sourceUpdated: { status: 'known', value: '2020-02-01' },
      },
    },
    annotationReceiptDigest: `${provider}-annotation-receipt`,
    provenanceReceiptDigest: `${provider}-provenance-receipt`,
    sourceObservationDigest: 'observations',
  };
}

test('each provider confirmation reaches native annotation and provenance and resumes the same command identity', () => {
  const facts = eligibleFacts();
  for (const { provider, nativeAdmission } of providers) {
    const selected = confirmListImportMetadata(undefined, proposed(provider, nativeAdmission), facts);
    expect(selected.ok).toBe(true);
    if (!selected.ok) throw new Error('confirm');
    expect(selected.value.selectionDigest).toBe(selectionDigest);
    expect(selected.value.annotationKey).toBe(`${provider}:upload:0:review:annotations`);
    expect(selected.value.provenanceKey).toBe(`${provider}:upload:0:review:provenance`);
    if (nativeAdmission) expect(selected.value.nativeAdmission).toBe(nativeAdmission);
    else expect(selected.value.nativeAdmission).toBeUndefined();

    const started = persistListImportMetadata(
      selected.value,
      {
        ...selected.value,
        ...operands(provider),
        annotationStarted: true,
        provenanceStarted: true,
        annotationStatus: 'applied',
        provenanceStatus: 'applied',
        fieldOutcomes: fields.map(({ field }) => ({ field, status: 'applied' as const })),
        outcome: {
          reviewToken: 'review',
          fields: fields.map(({ field }) => ({ field, status: 'applied' as const })),
        },
      },
      facts,
    );
    expect(started.ok).toBe(true);
    if (!started.ok) throw new Error('persist');
    expect(started.value.outcome?.fields.map((field) => field.status)).toEqual([
      'applied',
      'applied',
      'applied',
      'applied',
    ]);

    const resumed = persistListImportMetadata(
      started.value,
      {
        ...proposed(provider, nativeAdmission),
        ...operands(provider),
        annotationStarted: true,
        provenanceStarted: true,
      },
      facts,
    );
    expect(resumed.ok).toBe(true);
    if (!resumed.ok) throw new Error('resume');
    expect(resumed.value.annotationKey).toBe(selected.value.annotationKey);
    expect(resumed.value.provenanceKey).toBe(selected.value.provenanceKey);
    expect(resumed.value.annotationInput).toEqual(operands(provider).annotationInput);
    expect(resumed.value.provenanceInput).toEqual(operands(provider).provenanceInput);
    expect(resumed.value.annotationReceiptDigest).toBe(`${provider}-annotation-receipt`);
    expect(resumed.value.provenanceReceiptDigest).toBe(`${provider}-provenance-receipt`);
    expect(resumed.value.selectionDigest).toBe(selectionDigest);
    expect(resumed.value.outcome?.fields.map((field) => field.status)).toEqual([
      'applied',
      'applied',
      'applied',
      'applied',
    ]);
  }
});

test('cancelled, changed, expired and concurrent confirmations refuse new phases while original receipts stay honest', () => {
  const original = {
    ...proposed('bangumi', 'bangumi-source-v1'),
    ...operands('bangumi'),
    annotationStarted: true,
    annotationStatus: 'applied' as const,
    fieldOutcomes: [{ field: 'note' as const, status: 'applied' as const }],
  };
  const unrelated: EntryImportMetadataConfirmation[] = [];
  for (const change of [
    { cancelled: true },
    { expired: true },
    { currentSourceReviewToken: 'other-review' },
    { currentSourceDigest: 'other-source' },
    { currentProfileDigest: 'other-profile' },
    { currentIncarnationId: 'other-incarnation' },
  ] as const) {
    const facts = listImportMetadataFenceFacts({
      currentSourceReviewToken: 'source-review',
      boundSourceReviewToken: 'source-review',
      currentSourceDigest: 'source-digest',
      boundSourceDigest: 'source-digest',
      currentProfileDigest: 'profile-digest',
      boundProfileDigest: 'profile-digest',
      currentIncarnationId: 'incarnation',
      boundIncarnationId: 'incarnation',
      ...change,
    });
    expect(listImportMetadataFirstPhaseEligible(facts)).toBe(false);
    expect(confirmListImportMetadata(undefined, proposed('mal'), facts).ok).toBe(false);
    expect(persistListImportMetadata(proposed('mal'), { ...proposed('mal'), annotationStarted: true }, facts).ok).toBe(
      false,
    );
    const recovered = persistListImportMetadata(original, { ...original, annotationStatus: 'unattempted' }, facts);
    expect(recovered.ok).toBe(true);
    if (recovered.ok) {
      expect(recovered.value.annotationReceiptDigest).toBe('bangumi-annotation-receipt');
      expect(recovered.value.annotationStatus).toBe('applied');
      expect(recovered.value.annotationStarted).toBe(true);
      expect(recovered.value.selectionDigest).toBe(original.selectionDigest);
    }
    unrelated.push(proposed(`other-${unrelated.length}`));
  }
  expect(unrelated).toHaveLength(6);
  expect(original.selectionDigest).toBe(selectionDigest);
  expect(original.annotationKey).toBe('bangumi:upload:0:review:annotations');
  expect(
    confirmListImportMetadata(original, { ...original, selectionDigest: 'other-selection' }, eligibleFacts()).ok,
  ).toBe(false);
  const expired = recoverListImportMetadataExpiredOutcome({
    reviewToken: 'review',
    selections: fields,
    selectionDigest,
    confirmation: original,
    annotationReceipt: 'present',
    provenanceReceipt: 'missing',
  });
  expect(expired.ok).toBe(true);
  if (expired.ok) {
    expect(expired.value.fields[0]).toEqual({ field: 'note', status: 'applied' });
    expect(expired.value.fields.slice(1).map((field) => field.status)).toEqual([
      'unattempted',
      'unattempted',
      'unattempted',
    ]);
  }
  expect(
    recoverListImportMetadataExpiredOutcome({
      reviewToken: 'review',
      selections: fields,
      selectionDigest: 'other',
      confirmation: original,
      annotationReceipt: 'present',
      provenanceReceipt: 'missing',
    }).ok,
  ).toBe(false);
});
