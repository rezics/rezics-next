import { memoizedValue } from '../../memoized.ts';
import { t } from 'elysia';
import { SubjectSummarySchema, type SubjectSummary } from '../../semantic/adapters/public-summary-schema.ts';
import { sessionSchema } from '../transport-contract.ts';
import { createContinueReads } from '../continue-reads.ts';
import type { ContinuePage, ContinueSubject } from '../contract/index.ts';

const continueClosed = { additionalProperties: false } as const;
const continueNullable = t.Union([t.String(), t.Null()]);

export type { ContinuePage, ContinueReads, ContinueSession, ContinueSubject } from '../contract/index.ts';

export type DisclosedContinueSubject = ContinueSubject<SubjectSummary>;
export type DisclosedContinuePage = ContinuePage<SubjectSummary>;

/** Closed Continue page. Session presentation is Library-owned; optional subject is Semantic's disclosed summary. */
export function continuePageSchema() {
  return memoizedValue(continuePageSchema, () =>
    t.Object(
      {
        subjects: t.Array(
          t.Object(
            {
              subjectId: t.String({ format: 'uuid' }),
              state: continueNullable,
              lastActivityAt: t.String(),
              activeProgressSession: t.Union([sessionSchema(), t.Null()]),
              subject: t.Optional(t.Union([SubjectSummarySchema, t.Null()])),
            },
            continueClosed,
          ),
        ),
        next: continueNullable,
      },
      continueClosed,
    ),
  );
}

/** Native Continue producer. Composition binds this; Content consumes the page, not Library storage. */
export function createContinuePageAdapter(
  ...args: Parameters<typeof createContinueReads>
): ReturnType<typeof createContinueReads> {
  return createContinueReads(...args);
}
