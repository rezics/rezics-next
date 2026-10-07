import { Elysia } from 'elysia';
import { problemResult } from '../api-contract.ts';
import { readProblems } from '../api-responses.ts';
import { RatingAggregateUnavailable } from '../modules/rating/aggregate.ts';
import { queryRatingRollup } from '../modules/rating/rollup-read.ts';
import { rollupInput, rollupResult } from '../modules/rating/rollup-api.ts';
import { workRead, WorkReadMissing } from '../modules/work/read-session.ts';
import { TargetNotBound } from '../modules/target/resolve.ts';
import type { MainWorkDependencies } from './dependencies.ts';
import { commandError, problem } from './problems.ts';

/** A read-only derived metric: nothing is stored, and the formula, coverage and
 * every member's components come back with the value. */
export function ratingRollupRoutes(work: MainWorkDependencies) {
  return new Elysia().post('/v1/rating-rollups', {
    body: rollupInput,
    response: { 200: rollupResult, ...readProblems, 422: problemResult(422) },
  }, async ({ body, request }) => {
    try {
      if (!work.targetRatingInventory) throw new RatingAggregateUnavailable('Target inventory unavailable');
      const inventory = work.targetRatingInventory;
      const result = await queryRatingRollup(operation => workRead(work, request, { actingSubject: body.actingSubject }, operation),
        inventory, { context: body.context, targets: body.targets, formula: body.formula, rank: body.rank === true });
      return Response.json(result, { headers: { 'cache-control': 'no-store' } });
    } catch (error) {
      if (error instanceof TargetNotBound) return problem(422, error.code, error.message);
      if (error instanceof WorkReadMissing) return problem(404, 'resource_unavailable', error.message);
      return commandError(error);
    }
  });
}

export const openApiOperations = {
  '/v1/rating-rollups': { post: { exposure: 'public', rateLimitFamily: 'read' } },
} as const;
