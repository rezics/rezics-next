import { t } from 'elysia';
import { readPosition } from '../work/read-contract.ts';
import { WorkReadUnavailable, type WorkReadSession } from '../work/read-session.ts';

export const feedProjectionHealth = t.Object({
  status: t.Union([t.Literal('ready'), t.Literal('indexing')]),
  sourcePosition: readPosition,
  projection: t.Object({ sequence: t.String(), reviewSequence: t.String() }),
  targets: t.Object({ sequence: t.Nullable(t.String()), status: t.Union([t.Literal('current'), t.Literal('indexing')]) }),
});
export const FEED_HEALTH_COST = { accessStatements: 6, graphCalls: 2, payloads: 0 } as const;

export async function readFeedProjectionHealth(session: WorkReadSession) {
  if (!session.deps.feed) throw new WorkReadUnavailable('Feed owner is unavailable');
  return session.deps.feed.readiness(session.position);
}
