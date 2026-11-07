import { t } from 'elysia';
import type { ConversationActivityBatch } from './conversation-activity.ts';
import type { ReadingPagePlace } from './contract/index.ts';
import { readingPageCapabilities } from './adapters/reading-page-bind.ts';
import { readingPageBoundary } from './reading-page-failure.ts';

const closed = { additionalProperties: false } as const;

/** Only disclosed producer facts cross the reading-page boundary. */
export const ReadingPageActivitySchema = t.Union([
  t.Object(
    {
      state: t.Literal('current'),
      cohort: t.Literal('public'),
      count: t.Object(
        {
          kind: t.Union([t.Literal('exact'), t.Literal('lower-bound')]),
          value: t.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
        },
        closed,
      ),
      lastActivityAt: t.Union([t.String({ format: 'date-time' }), t.Null()]),
    },
    closed,
  ),
  t.Object({ state: t.Literal('withheld') }, closed),
  t.Object({ state: t.Literal('unavailable'), retryable: t.Literal(true) }, closed),
]);

/** Compatibility boundary: schemas and HTTP errors stay outside the application. */
export async function selectReadingPageActivity(
  producer: ConversationActivityBatch,
  place: ReadingPagePlace,
  deadline: number,
) {
  const selected = await readingPageBoundary(() => readingPageCapabilities().selectActivity(producer, place, deadline));
  return { confirm: () => readingPageBoundary(() => selected.confirm()) };
}
