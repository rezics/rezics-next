import { randomUUID } from 'node:crypto';
import type { CommandOutcome } from '../command/command.ts';
import type { Actor } from '../request/access.ts';
import { ProblemError } from '../http/problem.ts';
import type { LabelCommandAdmission } from './label-command-admission.ts';
import { createEntryPersonalCommands } from './entry-personal.ts';
import type { PersonalEntry } from './entry-personal-model.ts';
import {
  applyEntryImportMetadataCommands,
  ENTRY_IMPORT_METADATA_LIMITS,
  assertEntryImportMetadataHistorySize,
  entryImportMetadataDigest,
  entryPersonalMetadataDigest,
  parseEntryImportMetadataSelections,
  type EntryImportMetadataConfirmation,
  type EntryImportMetadataOutcome,
  type EntryImportMetadataProposals,
  type EntryImportMetadataReview,
  type EntryImportMetadataView,
} from './list-import-entry-metadata.ts';
import {
  listImportMetadataOrConflict,
  listImportMetadataProposedConfirmation,
  mergeListImportMetadataConfirmation as mergeConfirmation,
  recoverListImportMetadataExpiredOutcome,
  selectListImportMetadataConfirmation as selectConfirmation,
  type ListImportMetadataDecision,
  type ListImportMetadataReceiptObservation,
} from './list-import-metadata-core.ts';

export {
  confirmListImportMetadata,
  listImportMetadataFenceFacts,
  listImportMetadataFirstPhaseEligible,
  listImportMetadataOrConflict,
  listImportMetadataPhaseStart,
  listImportMetadataProposedConfirmation,
  persistListImportMetadata,
  recoverListImportMetadataExpiredOutcome,
} from './list-import-metadata-core.ts';
export type {
  ListImportMetadataDecision,
  ListImportMetadataFenceFacts,
  ListImportMetadataReceiptObservation,
} from './list-import-metadata-core.ts';

export type ListImportMetadataScope = { actor: Actor; id: string; ordinal: number };
export type ListImportMetadataReviewRequest = ListImportMetadataScope & {
  sourceReviewToken: string;
  key: string;
};
export type ListImportMetadataViewRequest = ListImportMetadataScope & {
  reviewToken: string;
  reconcile?: boolean;
};
export type ListImportMetadataApplyRequest = ListImportMetadataScope & {
  reviewToken: string;
  fields: unknown;
  record?: (outcome: CommandOutcome<unknown>) => void;
  signal?: AbortSignal;
};

export type ListImportMetadataReviewIdentity = Omit<
  EntryImportMetadataReview,
  'token' | 'requestDigest' | 'confirmation'
>;

export type ListImportMetadataExpiredRecovery = Pick<
  EntryImportMetadataReview,
  'token' | 'subjectId' | 'clientId' | 'requestedBy'
> & {
  sourceReviewToken: string;
  confirmation?: EntryImportMetadataConfirmation;
};
type ListImportMetadataConfirmedRecovery = ListImportMetadataExpiredRecovery & {
  confirmation: EntryImportMetadataConfirmation;
};

export type ListImportMetadataObservation = {
  sourceReviewToken: string | null;
  subjectId: string | null;
  clientId: string;
  requestedBy: string | null;
  sourceDigest: string;
  profileDigest: string | null;
  incarnationId: string | null;
  personal: PersonalEntry;
  proposals: EntryImportMetadataProposals;
  recordId: string;
  providerCurrent: boolean;
};

export type ListImportMetadataViewState = {
  review: EntryImportMetadataReview | null;
  observation: ListImportMetadataObservation | null;
};

export type ListImportMetadataCoordinatorAdapter<ReviewResult = { ordinal: number; reviewToken: string }> = {
  provider: string;
  nativeAdmission?: EntryImportMetadataConfirmation['nativeAdmission'];
  native: ReturnType<typeof createEntryPersonalCommands>;
  prepareReview: (input: ListImportMetadataReviewRequest) => Promise<{
    history: readonly EntryImportMetadataReview[];
    identity: ListImportMetadataReviewIdentity;
    requestDigest?: string;
  }>;
  persistReview: (input: ListImportMetadataReviewRequest, review: EntryImportMetadataReview) => Promise<ReviewResult>;
  loadReview: (
    input: ListImportMetadataScope,
    reviewToken: string,
    reconcile: boolean,
  ) => Promise<EntryImportMetadataReview | null>;
  loadExpiredRecovery?: (
    input: ListImportMetadataScope,
    reviewToken: string,
  ) => Promise<ListImportMetadataExpiredRecovery | null>;
  recoverReceipt?: (
    input: ListImportMetadataScope,
    review: ListImportMetadataConfirmedRecovery,
    phase: 'annotation' | 'provenance',
  ) => Promise<boolean>;
  readReceipt?: (
    input: ListImportMetadataScope,
    review: EntryImportMetadataReview,
    phase: 'annotation' | 'provenance',
  ) => Promise<boolean>;
  readView: (input: ListImportMetadataViewRequest, reviewToken: string) => Promise<ListImportMetadataViewState>;
  confirm: (
    input: ListImportMetadataScope,
    reviewToken: string,
    confirmation: EntryImportMetadataConfirmation,
  ) => Promise<void>;
  persist: (
    input: ListImportMetadataScope,
    reviewToken: string,
    confirmation: EntryImportMetadataConfirmation,
  ) => Promise<void>;
  isCurrent: (input: ListImportMetadataScope, review: EntryImportMetadataReview) => Promise<boolean>;
  isCancelled: (input: ListImportMetadataScope) => Promise<boolean>;
  admission?: (
    input: ListImportMetadataScope,
    review: EntryImportMetadataReview,
    signal?: AbortSignal,
  ) => LabelCommandAdmission;
};

export function assertListImportMetadataReviewAvailable(history: readonly EntryImportMetadataReview[]): void {
  if (history.some((item) => item.confirmation && !item.confirmation.outcome)) throw new ProblemError('conflict');
}

export function appendListImportMetadataReview(
  history: readonly EntryImportMetadataReview[],
  review: EntryImportMetadataReview,
): { history: EntryImportMetadataReview[]; reviewToken: string; added: boolean } {
  const existing = history.find((item) => item.requestDigest === review.requestDigest);
  if (existing) return { history: [...history], reviewToken: existing.token, added: false };
  assertListImportMetadataReviewAvailable(history);
  if (history.length >= 2) throw new ProblemError('conflict');
  const next = [...history, review];
  assertEntryImportMetadataHistorySize(next);
  return { history: next, reviewToken: review.token, added: true };
}

function requireConfirmation(
  decision: ListImportMetadataDecision<EntryImportMetadataConfirmation>,
): EntryImportMetadataConfirmation {
  return listImportMetadataOrConflict(decision, () => {
    throw new ProblemError('conflict');
  });
}

export function selectListImportMetadataConfirmation(
  current: EntryImportMetadataConfirmation | undefined,
  proposed: EntryImportMetadataConfirmation,
): EntryImportMetadataConfirmation {
  return requireConfirmation(selectConfirmation(current, proposed));
}

export function mergeListImportMetadataConfirmation(
  current: EntryImportMetadataConfirmation | undefined,
  next: EntryImportMetadataConfirmation,
): EntryImportMetadataConfirmation {
  return requireConfirmation(mergeConfirmation(current, next));
}

function currentReview(review: EntryImportMetadataReview, observation: ListImportMetadataObservation): boolean {
  return (
    observation.providerCurrent &&
    observation.sourceReviewToken === review.sourceReviewToken &&
    observation.subjectId === review.subjectId &&
    observation.clientId === review.clientId &&
    observation.requestedBy === review.requestedBy &&
    observation.sourceDigest === review.sourceDigest &&
    entryPersonalMetadataDigest(observation.personal) === review.personalDigest &&
    observation.personal.annotationRevision === review.annotationRevision &&
    observation.profileDigest === review.profileDigest &&
    observation.incarnationId === review.incarnationId
  );
}

function createView(
  reviewToken: string,
  review: EntryImportMetadataReview,
  observation: ListImportMetadataObservation,
): EntryImportMetadataView {
  const view: EntryImportMetadataView = {
    status: currentReview(review, observation) ? 'current' : 'stale',
    reviewToken,
    sourceReviewToken: review.sourceReviewToken,
    subjectId: review.subjectId,
    personal: observation.personal,
    proposals: observation.proposals,
    outcome: review.confirmation?.outcome ?? null,
  };
  if (Buffer.byteLength(JSON.stringify(view)) > ENTRY_IMPORT_METADATA_LIMITS.responseBytes)
    throw new ProblemError('invalid_request');
  return view;
}

function confirmationFor(
  provider: string,
  id: string,
  ordinal: number,
  reviewToken: string,
  fields: EntryImportMetadataConfirmation['fields'],
  nativeAdmission?: EntryImportMetadataConfirmation['nativeAdmission'],
): EntryImportMetadataConfirmation {
  return listImportMetadataProposedConfirmation({
    fields,
    selectionDigest: entryImportMetadataDigest(fields),
    annotationKey: `${provider}:${id}:${ordinal}:${reviewToken}:annotations`,
    provenanceKey: `${provider}:${id}:${ordinal}:${reviewToken}:provenance`,
    nativeAdmission,
  });
}

function receiptObservation(value: boolean | null | undefined): ListImportMetadataReceiptObservation | null {
  if (value === true) return 'present';
  if (value === false) return 'missing';
  if (value === null) return 'unknown';
  return null;
}

export function createListImportMetadataCoordinator<ReviewResult>(
  adapter: ListImportMetadataCoordinatorAdapter<ReviewResult>,
) {
  async function expiredOutcome(
    input: ListImportMetadataApplyRequest,
    reviewToken: string,
    selections: ReturnType<typeof parseEntryImportMetadataSelections>,
    selectionDigest: string,
  ): Promise<EntryImportMetadataOutcome | null> {
    const review = await adapter.loadExpiredRecovery?.(input, reviewToken);
    const confirmation = review?.confirmation;
    if (!review) return null;
    const annotationReceipt =
      confirmation?.annotationStarted && confirmation.annotationReceiptDigest
        ? await adapter.recoverReceipt?.(input, { ...review, confirmation }, 'annotation')
        : null;
    const provenanceReceipt =
      confirmation?.provenanceStarted && confirmation.provenanceReceiptDigest
        ? await adapter.recoverReceipt?.(input, { ...review, confirmation }, 'provenance')
        : null;
    return listImportMetadataOrConflict(
      recoverListImportMetadataExpiredOutcome({
        reviewToken,
        selections,
        selectionDigest,
        ...(confirmation === undefined ? {} : { confirmation }),
        annotationReceipt: receiptObservation(annotationReceipt),
        provenanceReceipt: receiptObservation(provenanceReceipt),
      }),
      () => {
        throw new ProblemError('conflict');
      },
    );
  }

  return {
    async review(input: ListImportMetadataReviewRequest) {
      const prepared = await adapter.prepareReview(input);
      assertListImportMetadataReviewAvailable(prepared.history);
      if (prepared.identity.sourceReviewToken !== input.sourceReviewToken) throw new ProblemError('conflict');
      const review: EntryImportMetadataReview = {
        token: randomUUID(),
        requestDigest: prepared.requestDigest ?? entryImportMetadataDigest({ key: input.key }),
        ...prepared.identity,
      };
      return adapter.persistReview(input, review);
    },
    async view(input: ListImportMetadataViewRequest): Promise<EntryImportMetadataView> {
      const state = await adapter.readView(input, input.reviewToken);
      if (!state.review || !state.observation) throw new ProblemError('conflict');
      return createView(input.reviewToken, state.review, state.observation);
    },
    async apply(input: ListImportMetadataApplyRequest): Promise<EntryImportMetadataOutcome> {
      const selections = parseEntryImportMetadataSelections(input.fields),
        selectionDigest = entryImportMetadataDigest(selections);
      let review: EntryImportMetadataReview | null;
      try {
        review = await adapter.loadReview(input, input.reviewToken, true);
      } catch (error) {
        const recovered = await expiredOutcome(input, input.reviewToken, selections, selectionDigest);
        if (recovered) return recovered;
        throw error;
      }
      if (!review) {
        const recovered = await expiredOutcome(input, input.reviewToken, selections, selectionDigest);
        if (recovered) return recovered;
        return {
          reviewToken: input.reviewToken,
          fields: selections.map(({ field }) => ({ field, status: 'stale' as const })),
        };
      }
      if (review.confirmation && review.confirmation.selectionDigest !== selectionDigest)
        throw new ProblemError('conflict');
      if (review.confirmation?.outcome) return review.confirmation.outcome;
      if (!review.confirmation) {
        const confirmation = confirmationFor(
          adapter.provider,
          input.id,
          input.ordinal,
          input.reviewToken,
          selections,
          adapter.nativeAdmission,
        );
        await adapter.confirm(input, input.reviewToken, confirmation);
        try {
          review = await adapter.loadReview(input, input.reviewToken, true);
        } catch (error) {
          const recovered = await expiredOutcome(input, input.reviewToken, selections, selectionDigest);
          if (recovered) return recovered;
          throw error;
        }
      }
      if (!review?.confirmation || review.confirmation.selectionDigest !== selectionDigest)
        throw new ProblemError('conflict');
      if (review.confirmation.outcome) return review.confirmation.outcome;

      let state: ListImportMetadataViewState;
      try {
        state = await adapter.readView({ ...input, reconcile: true }, input.reviewToken);
      } catch (error) {
        const recovered = await expiredOutcome(input, input.reviewToken, selections, selectionDigest);
        if (recovered) return recovered;
        throw error;
      }
      const latest = state.review,
        observation = state.observation;
      if (!latest?.confirmation || !observation) throw new ProblemError('conflict');
      if (latest.confirmation.selectionDigest !== selectionDigest) throw new ProblemError('conflict');
      if (latest.confirmation.outcome) return latest.confirmation.outcome;
      const view = createView(input.reviewToken, latest, observation),
        confirmation = latest.confirmation;
      if (view.status !== 'current' && !confirmation.annotationStarted && !confirmation.provenanceStarted) {
        const outcome: EntryImportMetadataOutcome = {
          reviewToken: input.reviewToken,
          fields: confirmation.fields.map(({ field }) => ({ field, status: 'stale' })),
        };
        confirmation.outcome = outcome;
        await adapter.persist(input, input.reviewToken, confirmation);
        return outcome;
      }
      const result = await applyEntryImportMetadataCommands({
        actor: input.actor,
        subjectId: latest.subjectId,
        provider: adapter.provider,
        recordId: observation.recordId,
        reviewToken: input.reviewToken,
        personal: observation.personal,
        proposals: observation.proposals,
        selections: confirmation.fields,
        baselineAnnotationRevision: latest.annotationRevision,
        confirmation,
        native: adapter.native,
        persist: (value) => adapter.persist(input, input.reviewToken, value),
        isCurrent: () => adapter.isCurrent(input, latest),
        isCancelled: () => adapter.isCancelled(input),
        ...(adapter.admission === undefined ? {} : { admission: adapter.admission(input, latest, input.signal) }),
        ...(adapter.readReceipt === undefined
          ? {}
          : { readReceipt: (phase: 'annotation' | 'provenance') => adapter.readReceipt!(input, latest, phase) }),
        ...(input.record === undefined ? {} : { record: input.record }),
        ...(input.signal === undefined ? {} : { signal: input.signal }),
      });
      return result.outcome;
    },
  };
}
