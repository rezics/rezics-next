import type { RatingCapabilities } from './contract/capabilities.ts';
import type { CommandTransaction } from '../command/command.ts';
import type { Pool } from 'pg';
import type { RatingChange } from './aggregate-effect.ts';
import { partitionOf, routeOf } from '../route/route.ts';
import { drainErasedFigureTargets } from './public-figure.ts';
import { STANDARD_QUESTION_ID } from './standard-question.ts';

/** One background page inside the existing command for this Subject home.
 * The command owns receipt/replay and durable resumption until complete. A committed Semantic
 * canonical-generation change starts a new pass; request readers never perform this repair.
 */
export async function rebuildRealmRankCanonicalOrder(
  tx: CommandTransaction,
  input: Readonly<{ partition: number; limit: number; restart?: boolean }>,
): Promise<
  Readonly<{
    partition: number;
    complete: boolean;
    consumed: number;
    canonicalGeneration: string;
    revision: string;
  }>
> {
  const { partition, limit, restart = false } = input;
  if (
    !Number.isInteger(partition) || partition < 0 || partition > 4095 ||
    !Number.isInteger(limit) || limit < 1 || limit > 200 || typeof restart !== 'boolean'
  )
    throw new TypeError('Invalid Realm rank canonical rebuild page');
  const result = await tx.query<{
    complete: boolean;
    consumed: number;
    canonicalGeneration: string;
    revision: string;
  }>(
    `SELECT complete,consumed,canonical_generation::text AS "canonicalGeneration",revision::text
     FROM rating.rebuild_realm_rank_canonical_order($1,$2,$3)`,
    [partition, limit, restart],
  );
  const page = result.rows[0];
  if (
    result.rows.length !== 1 || !page || typeof page.complete !== 'boolean' ||
    !Number.isInteger(page.consumed) || page.consumed < 0 || page.consumed > limit ||
    page.complete !== (page.consumed < limit) ||
    !/^[1-9][0-9]*$/.test(page.canonicalGeneration) || !/^[1-9][0-9]*$/.test(page.revision)
  )
    throw new Error('Realm rank canonical rebuild did not return a complete page result');
  return { partition, ...page };
}

/** The native erasure page remains outstanding until its figure/rank publications commit.
 * A failed or interrupted drain is retried by that same page effect, even if components already committed.
 */
export async function convergeRatingErasureFigures(
  pool: Pool,
  changes: readonly RatingChange[],
  capabilities?: RatingCapabilities,
): Promise<void> {
  const groups = new Map<string, { partition: number; populationId: string; subjectIds: Set<string> }>();
  for (const change of changes) {
    if (change.questionId !== STANDARD_QUESTION_ID) continue;
    const partition = partitionOf(routeOf(change.targetId)!);
    const key = `${partition}:${change.populationId}`;
    let group = groups.get(key);
    if (!group) {
      group = { partition, populationId: change.populationId, subjectIds: new Set() };
      groups.set(key, group);
    }
    group.subjectIds.add(change.targetId);
  }
  for (const group of groups.values()) {
    const subjectIds = [...group.subjectIds];
    for (let offset = 0; offset < subjectIds.length; offset += 100) {
      if (
        !(await drainErasedFigureTargets(
          pool,
          {
            partition: group.partition,
            populationId: group.populationId,
            questionId: STANDARD_QUESTION_ID,
            subjectIds: subjectIds.slice(offset, offset + 100),
          },
          capabilities,
        ))
      )
        throw new Error('Rating erasure figure publication is pending');
    }
  }
}
