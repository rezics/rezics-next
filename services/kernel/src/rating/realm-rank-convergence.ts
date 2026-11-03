import type { Pool } from 'pg';
import type { RatingChange } from './aggregate-effect.ts';
import { partitionOf, routeOf } from '../route/route.ts';
import { drainErasedFigureTargets } from './public-figure.ts';
import { STANDARD_QUESTION_ID } from './votes.ts';

/** The native erasure page remains outstanding until its figure/rank publications commit.
 * A failed or interrupted drain is retried by that same page effect, even if components already committed.
 */
export async function convergeRatingErasureFigures(pool: Pool, changes: readonly RatingChange[]): Promise<void> {
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
        !(await drainErasedFigureTargets(pool, {
          partition: group.partition,
          populationId: group.populationId,
          questionId: STANDARD_QUESTION_ID,
          subjectIds: subjectIds.slice(offset, offset + 100),
        }))
      )
        throw new Error('Rating erasure figure publication is pending');
    }
  }
}
