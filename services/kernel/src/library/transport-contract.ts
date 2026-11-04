import { t } from 'elysia';
import type { ProgressPresentation } from './progress-model.ts';
import { MAX_PROGRESS_MEASURES } from './progress.ts';
import { libraryStoredVocabularySchema } from './profile-schemas.ts';
import { SubjectSummarySchema } from '../semantic/http/summaries.ts';

const closed = { additionalProperties: false } as const;
const id = t.String({ format: 'uuid' });
const nullableString = t.Union([t.String(), t.Null()]);
const mode = t.Union([t.Literal('scalar_amount'), t.Literal('cursor_position'), t.Literal('completed_units')]);
const state = t.Union([t.Literal('active'), t.Literal('completed'), t.Literal('abandoned')]);
const revision = t.Integer({ minimum: 1, maximum: 2_147_483_646 });

/** Stable Library wire contract, kept outside route handlers for Continue and Feed composition. */
export const progressPresentationSchema = t.Unsafe<ProgressPresentation>(
  t.Object(
    {
      meaning: t.Union([t.Literal('known'), t.Literal('unknown'), t.Literal('unavailable')]),
      unitLabel: t.Optional(t.String()),
      unitLabelLanguage: t.Optional(t.String()),
      unitCountForms: t.Optional(
        t.Object(
          {
            other: t.String(),
            zero: t.Optional(t.String()),
            one: t.Optional(t.String()),
            two: t.Optional(t.String()),
            few: t.Optional(t.String()),
            many: t.Optional(t.String()),
          },
          closed,
        ),
      ),
      dimension: t.Optional(t.String()),
      structure: t.Literal('unverified'),
      recording: t.Union([
        t.Object(
          {
            state: t.Literal('supported'),
            inputRules: t.Object(
              {
                min: t.Optional(t.String()),
                max: t.Optional(t.String()),
                step: t.String(),
                total: t.Union([t.Literal('optional'), t.Literal('required'), t.Literal('forbidden')]),
              },
              closed,
            ),
          },
          closed,
        ),
        t.Object({ state: t.Union([t.Literal('unsupported'), t.Literal('unavailable')]) }, closed),
      ]),
    },
    closed,
  ),
);

export const sessionSchema = t.Object(
  {
    id,
    subjectId: id,
    versionSubjectId: t.Union([id, t.Null()]),
    mode,
    unit: libraryStoredVocabularySchema,
    total: nullableString,
    amount: nullableString,
    locator: nullableString,
    position: nullableString,
    completedUnitCount: t.Integer({ minimum: 0, maximum: 20_000 }),
    state: t.Union([state, t.Literal('retired')]),
    revision,
    startedAt: t.String(),
    completedAt: nullableString,
    measures: t.Optional(
      t.Array(
        t.Object(
          {
            unit: libraryStoredVocabularySchema,
            amount: nullableString,
            total: nullableString,
            presentation: t.Optional(progressPresentationSchema),
          },
          closed,
        ),
        { minItems: 2, maxItems: MAX_PROGRESS_MEASURES },
      ),
    ),
  },
  closed,
);

const continueClosed = { additionalProperties: false } as const;
const continueNullable = t.Union([t.String(), t.Null()]);

export const continuePageSchema = t.Object(
  {
    subjects: t.Array(
      t.Object(
        {
          subjectId: t.String({ format: 'uuid' }),
          state: continueNullable,
          lastActivityAt: t.String(),
          activeProgressSession: t.Union([sessionSchema, t.Null()]),
          subject: t.Optional(t.Union([SubjectSummarySchema, t.Null()])),
        },
        continueClosed,
      ),
    ),
    next: continueNullable,
  },
  continueClosed,
);
