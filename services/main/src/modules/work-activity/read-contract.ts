import { t } from 'elysia';
import { pageFields, readId } from '../work/read-contract.ts';

export const discussionItem = t.Object({
  reply: readId, realm: readId, placement: readId,
  revisionId: t.String({ pattern: '^[0-9a-f-]{36}$' }),
  body: t.String({ maxLength: 1_048_576 }),
  dataEpoch: t.String(), sequence: t.String(),
});
export const historyKind = t.Union([
  t.Literal('metadata-revision'), t.Literal('publication-decision'),
  t.Literal('reply-placement'),
]);
export const activityHistoryItem = t.Object({
  id: readId, kind: historyKind, dataEpoch: t.String(), sequence: t.String(),
  href: t.Nullable(t.String()),
  actor: t.Optional(readId),
});
export const discussionPage = t.Object({ items: t.Array(discussionItem, { maxItems: 20 }), ...pageFields });
export const activityHistoryPage = t.Object({ items: t.Array(activityHistoryItem, { maxItems: 20 }), ...pageFields });

/** At most one candidate page and one Content batch; review is checked twice per item. */
export const WORK_ACTIVITY_COST = { pageSize: 20, contentBytes: 4 * 1024 * 1024,
  reviewChecks: 40, graphCalls: 160, graphBytes: 4 * 1024 * 1024,
  deadlineMs: 10_000 } as const;
