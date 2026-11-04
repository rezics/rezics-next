import { expect, test } from 'bun:test';
import type { Actor } from '../../src/request/access.ts';
import type { CommandOutcome } from '../../src/command/command.ts';
import { createEntryPersonalCommands } from '../../src/library/entry-personal.ts';
import type { PersonalEntry } from '../../src/library/entry-personal-model.ts';
import {
  entryImportMetadataDigest,
  type EntryImportMetadataConfirmation,
  type EntryImportMetadataProposals,
  type EntryImportMetadataReview,
} from '../../src/library/list-import-entry-metadata.ts';
import { createListImportMetadataCoordinator } from '../../src/library/list-import-metadata-coordinator.ts';
import {
  confirmListImportMetadata,
  listImportMetadataFenceFacts,
  listImportMetadataFirstPhaseEligible,
  listImportMetadataProposedConfirmation,
  persistListImportMetadata,
  recoverListImportMetadataExpiredOutcome,
} from '../../src/library/list-import-metadata-core.ts';

const providers = [
  { provider: 'anilist', nativeAdmission: undefined },
  { provider: 'bangumi', nativeAdmission: 'bangumi-source-v1' as const },
  { provider: 'mal', nativeAdmission: undefined },
  { provider: 'vndb', nativeAdmission: 'vndb-source-v1' as const },
];

const actor: Actor = {
  kind: 'account',
  accountId: 'owner',
  clientId: 'client',
  requestedBy: null,
  authnEpoch: 1,
  scopes: ['library_entry:update'],
};
const fields = [
  { field: 'note' as const, action: 'adopt' as const },
  { field: 'privacy' as const, action: 'adopt' as const },
  { field: 'sourceCreated' as const, action: 'adopt' as const },
  { field: 'sourceUpdated' as const, action: 'adopt' as const },
];
const selectionDigest = entryImportMetadataDigest(fields);

function personal(): PersonalEntry {
  return {
    subjectId: 'subject',
    annotationRevision: 0,
    note: null,
    priority: null,
    annotationUpdatedAt: null,
    sourceObservations: [],
  };
}

function proposals(): EntryImportMetadataProposals {
  return {
    note: { state: 'value', sourceField: 'notes', value: 'Imported note' },
    priority: { state: 'unsupported', sourceField: null, reason: 'unsupported' },
    privacy: { state: 'value', sourceField: 'private', value: { status: 'known', meaning: 'private' } },
    sourceCreated: { state: 'value', sourceField: 'created_at', value: { status: 'known', value: '2020-01-01' } },
    sourceUpdated: { state: 'value', sourceField: 'updated_at', value: { status: 'known', value: '2020-02-01' } },
  };
}

function eligibleFacts() {
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

function storedReview(): EntryImportMetadataReview {
  return {
    token: 'review',
    requestDigest: 'request',
    sourceReviewToken: 'source-review',
    subjectId: 'subject',
    clientId: 'client',
    requestedBy: null,
    annotationRevision: 0,
    personalDigest: 'personal',
    sourceDigest: 'source-digest',
    profileDigest: 'profile-digest',
    incarnationId: 'incarnation',
  };
}

function journey(provider: string, admission?: EntryImportMetadataConfirmation['nativeAdmission']) {
  const entry = personal();
  const shown = proposals();
  let review: EntryImportMetadataReview = storedReview();
  const facts = eligibleFacts();
  const sent: { phase: 'annotation' | 'provenance'; key: string; input: unknown }[] = [];
  const native = {
    receiptDigest(_actor: Actor, kind: string, input: unknown) {
      return `${kind}:${JSON.stringify(input)}`;
    },
    async readPersonalEntry() {
      return entry;
    },
    async saveAnnotations(_actor: Actor, _subject: string, input: unknown, key: string) {
      sent.push({ phase: 'annotation', key, input });
      entry.annotationRevision += 1;
      entry.note = 'Imported note';
      return { value: entry, partition: 1, epoch: 1, position: 1n, transactionId: 'annotation', replayed: sent.length > 1 } satisfies CommandOutcome<PersonalEntry>;
    },
    async admitSourceObservation(_actor: Actor, _subject: string, input: unknown, key: string) {
      sent.push({ phase: 'provenance', key, input });
      entry.sourceObservations = [
        {
          provider,
          recordId: `${provider}-1`,
          revision: 1,
          privacy: { status: 'known', meaning: 'private' },
          sourceCreated: { status: 'known', value: '2020-01-01', precision: 'day', zone: 'unknown' },
          sourceUpdated: { status: 'known', value: '2020-02-01', precision: 'day', zone: 'unknown' },
          recordedAt: '2020-02-01T00:00:00Z',
        },
      ];
      return { value: { sourceObservation: entry.sourceObservations[0] }, partition: 1, epoch: 1, position: 2n, transactionId: 'provenance', replayed: false };
    },
    async correctSourceObservation() {
      throw new Error('correction is not part of this admission journey');
    },
  };
  const coordinator = createListImportMetadataCoordinator({
    provider,
    ...(admission === undefined ? {} : { nativeAdmission: admission }),
    native: native as ReturnType<typeof createEntryPersonalCommands>,
    async prepareReview() {
      return { history: [], identity: storedReview() };
    },
    async persistReview(_input, next) {
      review = next;
      return { ordinal: 0, reviewToken: next.token };
    },
    async loadReview() {
      return review;
    },
    async readView() {
      return {
        review,
        observation: {
          sourceReviewToken: review.sourceReviewToken,
          subjectId: review.subjectId,
          clientId: review.clientId,
          requestedBy: review.requestedBy,
          sourceDigest: review.sourceDigest,
          profileDigest: review.profileDigest,
          incarnationId: review.incarnationId,
          personal: entry,
          proposals: shown,
          recordId: `${provider}-1`,
          providerCurrent: true,
        },
      };
    },
    async confirm(_input, _token, confirmation) {
      review.confirmation = listImportMetadataOrThrow(confirmListImportMetadata(review.confirmation, confirmation, facts));
    },
    async persist(_input, _token, confirmation) {
      review.confirmation = listImportMetadataOrThrow(persistListImportMetadata(review.confirmation, confirmation, facts));
    },
    async isCurrent() {
      return true;
    },
    async isCancelled() {
      return false;
    },
  });
  return { coordinator, sent, review: () => review };
}

function listImportMetadataOrThrow<T>(decision: { ok: true; value: T } | { ok: false; reason: 'conflict' }): T {
  if (!decision.ok) throw new Error('conflict');
  return decision.value;
}

test('each provider confirmation reaches native annotation and provenance and resumes the same command identity', async () => {
  for (const { provider, nativeAdmission } of providers) {
    const first = journey(provider, nativeAdmission);
    const outcome = await first.coordinator.apply({
      actor,
      id: 'upload',
      ordinal: 0,
      reviewToken: 'review',
      fields,
    });
    expect(outcome.fields.map((field) => field.status)).toEqual(['applied', 'applied', 'applied', 'applied']);
    expect(first.sent.map((item) => item.key)).toEqual([
      `${provider}:upload:0:review:annotations`,
      `${provider}:upload:0:review:provenance`,
    ]);
    expect(first.review().confirmation?.selectionDigest).toBe(selectionDigest);
    expect(first.review().confirmation?.annotationInput?.note).toEqual({ op: 'set', value: 'Imported note' });
    expect(first.review().confirmation?.provenanceInput).toMatchObject({ kind: 'admit', effect: true });
    if (nativeAdmission) expect(first.review().confirmation?.nativeAdmission).toBe(nativeAdmission);
    else expect(first.review().confirmation?.nativeAdmission).toBeUndefined();

    const lost = journey(provider, nativeAdmission);
    lost.review().confirmation = {
      ...proposed(provider, nativeAdmission),
      annotationStarted: true,
      provenanceStarted: true,
      annotationInput: first.review().confirmation!.annotationInput,
      provenanceInput: first.review().confirmation!.provenanceInput,
      annotationReceiptDigest: first.review().confirmation!.annotationReceiptDigest,
      provenanceReceiptDigest: first.review().confirmation!.provenanceReceiptDigest,
      provenanceKind: 'admit',
      sourceObservationDigest: first.review().confirmation!.sourceObservationDigest,
    };
    const resumed = await lost.coordinator.apply({
      actor,
      id: 'upload',
      ordinal: 0,
      reviewToken: 'review',
      fields,
    });
    expect(resumed.fields.map((field) => field.status)).toEqual(['applied', 'applied', 'applied', 'applied']);
    expect(lost.sent.map((item) => item.key)).toEqual(first.sent.map((item) => item.key));
    expect(lost.sent.map((item) => item.input)).toEqual(first.sent.map((item) => item.input));
    expect(lost.review().confirmation?.annotationKey).toBe(first.review().confirmation?.annotationKey);
    expect(lost.review().confirmation?.provenanceKey).toBe(first.review().confirmation?.provenanceKey);
  }
});

test('cancelled, changed, expired and concurrent confirmations refuse new phases while original receipts stay honest', () => {
  const original = proposed('bangumi', 'bangumi-source-v1');
  original.annotationStarted = true;
  original.annotationReceiptDigest = 'annotation-receipt';
  original.annotationStatus = 'applied';
  original.fieldOutcomes = [{ field: 'note', status: 'applied' }];
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
    const recovered = persistListImportMetadata(
      original,
      { ...original, annotationStatus: 'unattempted', provenanceStarted: true },
      facts,
    );
    expect(recovered.ok).toBe(true);
    if (recovered.ok) {
      expect(recovered.value.annotationReceiptDigest).toBe('annotation-receipt');
      expect(recovered.value.annotationStatus).toBe('applied');
      expect(recovered.value.annotationStarted).toBe(true);
      expect(recovered.value.selectionDigest).toBe(original.selectionDigest);
    }
    unrelated.push(proposed(`other-${unrelated.length}`));
  }
  expect(unrelated).toHaveLength(6);
  expect(original.selectionDigest).toBe(selectionDigest);
  expect(original.annotationKey).toBe('bangumi:upload:0:review:annotations');
  const concurrent = confirmListImportMetadata(original, { ...original, selectionDigest: 'other-selection' }, eligibleFacts());
  expect(concurrent.ok).toBe(false);
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
    expect(expired.value.fields.slice(1).map((field) => field.status)).toEqual(['unattempted', 'unattempted', 'unattempted']);
  }
  const mismatched = recoverListImportMetadataExpiredOutcome({
    reviewToken: 'review',
    selections: fields,
    selectionDigest: 'other',
    confirmation: original,
    annotationReceipt: 'present',
    provenanceReceipt: 'missing',
  });
  expect(mismatched.ok).toBe(false);
});
