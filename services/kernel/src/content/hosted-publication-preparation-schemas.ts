import { t } from 'elysia';
import { HostedIdSchema } from './hosted-chapters-schemas.ts';

const closed = { additionalProperties: false } as const;

export const HostedPublicationPreparationStartSchema = t.Object(
  {
    stageId: HostedIdSchema,
    expectedRevisionId: HostedIdSchema,
    expectedPublicationId: t.Union([HostedIdSchema, t.Null()]),
    mode: t.Union([t.Literal('whole'), t.Literal('selection')]),
  },
  closed,
);

export const HostedPublicationPreparationBatchSchema = t.Object(
  {
    batchId: HostedIdSchema,
    occurrenceIds: t.Array(HostedIdSchema, { minItems: 1, maxItems: 512 }),
  },
  closed,
);

export const HostedPublicationPreparationAdvanceSchema = t.Object({ stepId: HostedIdSchema }, closed);
export const HostedPublicationPreparationEmptySchema = t.Object({}, closed);

const staging = t.Object(
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

const batch = t.Object(
  {
    replayed: t.Boolean(),
    inputVersion: t.String(),
    firstInputPosition: t.String(),
    itemCount: t.Integer({ minimum: 0 }),
  },
  closed,
);

const candidate = t.Object(
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

/** Public wire shape contains only private progress counts and native locators. */
export const HostedPublicationPreparationProgressSchema = t.Object(
  {
    catalogueId: HostedIdSchema,
    stageId: HostedIdSchema,
    stage: staging,
    batch: t.Optional(batch),
    candidate: t.Union([candidate, t.Null()]),
    candidateReady: t.Boolean(),
  },
  closed,
);
