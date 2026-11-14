import { t } from 'elysia';
import { memoizedValue } from '../memoized.ts';
import { HostedIdSchema } from './hosted-chapters-schemas.ts';
import { HOSTED_PUBLICATION_STAGING_BATCH_LIMIT } from './hosted-publication-staging-model.ts';

const closed = { additionalProperties: false } as const;

export function HostedPublicationPreparationStartSchema() {
  return memoizedValue(HostedPublicationPreparationStartSchema, () =>
    t.Object(
      {
        stageId: HostedIdSchema,
        expectedRevisionId: HostedIdSchema,
        expectedPublicationId: t.Union([HostedIdSchema, t.Null()]),
        mode: t.Union([t.Literal('whole'), t.Literal('selection')]),
      },
      closed,
    ),
  );
}

export function HostedPublicationPreparationBatchSchema() {
  return memoizedValue(HostedPublicationPreparationBatchSchema, () =>
    t.Object(
      {
        batchId: HostedIdSchema,
        occurrenceIds: t.Array(HostedIdSchema, {
          minItems: 1,
          maxItems: HOSTED_PUBLICATION_STAGING_BATCH_LIMIT,
        }),
      },
      closed,
    ),
  );
}

export function HostedPublicationPreparationAdvanceSchema() {
  return memoizedValue(HostedPublicationPreparationAdvanceSchema, () => t.Object({ stepId: HostedIdSchema }, closed));
}

export function HostedPublicationPreparationEmptySchema() {
  return memoizedValue(HostedPublicationPreparationEmptySchema, () => t.Object({}, closed));
}

function staging() {
  return t.Object(
    {
      locator: t.Object({ catalogueId: HostedIdSchema, stageId: HostedIdSchema }, closed),
      state: t.Union([
        t.Literal('collecting'),
        t.Literal('building'),
        t.Literal('closing'),
        t.Literal('ready'),
        t.Literal('sealed'),
        t.Literal('cancelled'),
        t.Literal('expired'),
        t.Literal('failed'),
      ]),
      mode: t.Union([t.Literal('whole'), t.Literal('selection')]),
      sourceRevisionId: t.Optional(HostedIdSchema),
      expectedHeadRevisionId: t.Optional(HostedIdSchema),
      expectedPublicationId: t.Optional(t.Union([HostedIdSchema, t.Null()])),
      inputVersion: t.String(),
      inputCount: t.String(),
      settledInputCount: t.String(),
      candidateCount: t.String(),
      sourceFrontier: t.String(),
      sourceExhausted: t.Boolean(),
      closureFrontier: t.String(),
      closureCheckedCount: t.String(),
      closureMissingCount: t.String(),
      failure: t.Union([t.String(), t.Null()]),
    },
    closed,
  );
}

function batch() {
  return t.Object(
    {
      replayed: t.Boolean(),
      inputVersion: t.String(),
      firstInputPosition: t.String(),
      itemCount: t.Integer({ minimum: 0 }),
    },
    closed,
  );
}

function candidate() {
  return t.Object(
    {
      candidateId: HostedIdSchema,
      generationId: HostedIdSchema,
      afterSourceOrder: t.Union([t.String(), t.Null()]),
      placementCount: t.String(),
      rootCount: t.String(),
      chapterCount: t.String(),
      coverageComplete: t.Boolean(),
      sealed: t.Boolean(),
    },
    closed,
  );
}

/** New progress adds only immutable source/publication IDs; optional binding fields keep older receipts replayable. */
export function HostedPublicationPreparationProgressSchema() {
  return memoizedValue(HostedPublicationPreparationProgressSchema, () =>
    t.Object(
      {
        catalogueId: HostedIdSchema,
        stageId: HostedIdSchema,
        stage: staging(),
        batch: t.Optional(batch()),
        candidate: t.Union([candidate(), t.Null()]),
        candidateReady: t.Boolean(),
      },
      closed,
    ),
  );
}

/** Exact native activation progress; `publicationId` stays null until the pointer CAS commits. */
export function HostedPublicationActivationProgressSchema() {
  return memoizedValue(HostedPublicationActivationProgressSchema, () =>
    t.Object(
      {
        catalogueId: HostedIdSchema,
        stageId: HostedIdSchema,
        state: t.Union([t.Literal('checking'), t.Literal('ready'), t.Literal('restart'), t.Literal('activated')]),
        passId: HostedIdSchema,
        checkedTargetCount: t.String(),
        totalTargetCount: t.String(),
        candidateGenerationId: HostedIdSchema,
        publicationId: t.Union([HostedIdSchema, t.Null()]),
        restartRequired: t.Boolean(),
      },
      closed,
    ),
  );
}
