import { t } from 'elysia';
import type { Static } from 'typebox';
import { classifyUnavailability } from '../access/unavailable.ts';
import { ProblemError } from '../http/problem.ts';
import type { ConversationActivityBatch, ConversationActivitySelection } from './conversation-activity.ts';
import type { AnchoredPosition } from './model.ts';

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

type Activity = Static<typeof ReadingPageActivitySchema>;
type SelectedPlace = Readonly<{
  threadId: string;
  boardId: string;
  threadSecurityRevision: string;
  boardSecurityRevision: string;
  realmId: string | null;
}>;

function unavailable(error: unknown): boolean {
  return (
    classifyUnavailability(error) !== undefined ||
    (error instanceof ProblemError && error.code === 'dependency_unavailable')
  );
}

function changed(): never {
  throw new ProblemError('dependency_unavailable', { detail: 'The reading page changed during hydration' });
}

/** One native selection, then confirmation after foreign hydration. No reply-page input supplies a total. */
export async function selectReadingPageActivity(
  producer: ConversationActivityBatch,
  place: SelectedPlace,
  deadline: number,
) {
  let selected: readonly ConversationActivitySelection[];
  try {
    selected = await producer.select([place.threadId], deadline);
  } catch (error) {
    if (!unavailable(error)) throw error;
    return {
      confirm: async (): Promise<{ value: Activity; anchors: readonly AnchoredPosition[] }> => ({
        value: { state: 'unavailable', retryable: true },
        anchors: [],
      }),
    };
  }

  function requirePlace(item: ConversationActivitySelection) {
    if (item.threadId !== place.threadId) changed();
    if (item.status !== 'current') return;
    const witness = item.witness;
    if (
      witness.threadId !== place.threadId ||
      witness.boardId !== place.boardId ||
      witness.threadSecurityRevision !== place.threadSecurityRevision ||
      witness.boardSecurityRevision !== place.boardSecurityRevision ||
      witness.realmId !== place.realmId
    )
      changed();
  }
  if (selected.length !== 1) changed();
  requirePlace(selected[0]!);

  return {
    async confirm(): Promise<{ value: Activity; anchors: readonly AnchoredPosition[] }> {
      let confirmed: readonly ConversationActivitySelection[];
      try {
        confirmed = await producer.confirm(selected, deadline);
      } catch (error) {
        if (!unavailable(error)) throw error;
        return { value: { state: 'unavailable', retryable: true }, anchors: [] };
      }
      if (confirmed.length !== 1) changed();
      const item = confirmed[0]!;
      requirePlace(item);
      // A changed activity observation uses the page's existing same-request retry path.
      if (item.status === 'withheld') {
        if (item.reason === 'stale' || selected[0]!.status === 'current') changed();
        return { value: { state: 'withheld' }, anchors: [] };
      }
      return {
        value: {
          state: 'current',
          cohort: item.cohort,
          count: { ...item.replyCount },
          lastActivityAt: item.lastContributionAt,
        },
        anchors: [item.witness.source],
      };
    },
  };
}
