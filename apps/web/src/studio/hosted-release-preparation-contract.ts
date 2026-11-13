import * as v from 'valibot';
import { hostedId, hostedKey, hostedOwnerViewer } from './hosted-contract';

const locator = { catalogueId: hostedId, stageId: hostedId };
const count = v.pipe(v.string(), v.regex(/^(0|[1-9][0-9]*)$/));
export const releaseStartBody = v.strictObject({
  stageId: hostedId,
  expectedRevisionId: hostedId,
  expectedPublicationId: v.nullable(hostedId),
  mode: v.picklist(['whole', 'selection']),
});
export const releaseSelectionBatch = v.strictObject({
  batchId: hostedId,
  occurrenceIds: v.pipe(v.array(hostedId), v.minLength(1), v.maxLength(512)),
});
const envelope = {
  ...locator,
  expectedViewer: hostedOwnerViewer,
  idempotencyKey: hostedKey,
  expectedMode: v.optional(v.picklist(['whole', 'selection'])),
};
export const releaseRequest = v.variant('kind', [
  v.strictObject({ ...envelope, kind: v.literal('start'), body: releaseStartBody }),
  v.strictObject({ ...envelope, kind: v.literal('append'), body: releaseSelectionBatch }),
  v.strictObject({ ...envelope, kind: v.literal('freeze'), body: v.strictObject({}) }),
  v.strictObject({ ...envelope, kind: v.literal('advance'), body: v.strictObject({ stepId: hostedId }) }),
  v.strictObject({ ...envelope, kind: v.literal('progress'), body: v.strictObject({}) }),
  v.strictObject({ ...envelope, kind: v.literal('seal'), body: v.strictObject({}) }),
  v.strictObject({ ...envelope, kind: v.literal('cancel'), body: v.strictObject({}) }),
]);

/** Mirrors the mounted preparation schema. Counts stay decimal strings, including beyond JS safe integers. */
export const releaseProgress = v.strictObject({
  ...locator,
  stage: v.strictObject({
    locator: v.strictObject(locator),
    state: v.picklist(['collecting', 'building', 'closing', 'ready', 'sealed', 'cancelled', 'expired', 'failed']),
    mode: v.picklist(['whole', 'selection']),
    // Missing only on durable command receipts written before stage binding was added.
    sourceRevisionId: v.optional(hostedId),
    expectedHeadRevisionId: v.optional(hostedId),
    expectedPublicationId: v.optional(v.nullable(hostedId)),
    inputVersion: count,
    inputCount: count,
    settledInputCount: count,
    candidateCount: count,
    sourceFrontier: v.string(),
    sourceExhausted: v.boolean(),
    closureFrontier: v.string(),
    closureCheckedCount: count,
    closureMissingCount: count,
    failure: v.nullable(v.string()),
  }),
  batch: v.optional(
    v.strictObject({
      replayed: v.boolean(),
      inputVersion: count,
      firstInputPosition: count,
      itemCount: v.pipe(v.number(), v.integer(), v.minValue(0)),
    }),
  ),
  candidate: v.nullable(
    v.strictObject({
      candidateId: hostedId,
      generationId: hostedId,
      afterSourceOrder: v.nullable(v.string()),
      placementCount: count,
      rootCount: count,
      chapterCount: count,
      coverageComplete: v.boolean(),
      sealed: v.boolean(),
    }),
  ),
  candidateReady: v.boolean(),
  durableInitiator: v.optional(v.pipe(v.string(), v.regex(/^[0-9a-f]{64}$/))),
});
export type ReleaseRequest = v.InferOutput<typeof releaseRequest>;
export type ReleaseProgress = v.InferOutput<typeof releaseProgress>;
export type ReleaseStartBody = v.InferOutput<typeof releaseStartBody>;

/** A source stage marked sealed is still not a sealed candidate. */
export function releaseReadiness(progress: ReleaseProgress): 'prepared' | 'ready' | 'advance' {
  if (progress.candidateReady && progress.candidate?.sealed) return 'prepared';
  if (progress.stage.state === 'sealed' && progress.candidate?.coverageComplete) return 'ready';
  return 'advance';
}

export type ReleaseMode = ReleaseStartBody['mode'];
export type ReleaseSelectionBatch = v.InferOutput<typeof releaseSelectionBatch>;
