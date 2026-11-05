import type { Pool, PoolClient } from 'pg';
import { partitionReadClient } from '../database/read-snapshot.ts';
import { partitionOf, routeOf } from '../route/route.ts';
import { withReadTransaction } from '../semantic/read.ts';
import type { RatingAggregate } from './aggregate-effect.ts';
import readComponents from './aggregate-read.sql';
import readFreshness from './aggregate-read-freshness.sql';
import readQuestion from './aggregate-read-question.sql';
import { assertPostgresBigint, ratingQuestionHistogramSize } from './question-scale.ts';

type Queryable = Pick<Pool | PoolClient, 'query'>;

function isPool(client: Queryable): client is Pool {
  return typeof (client as Pool).connect === 'function' && typeof (client as PoolClient).release !== 'function';
}

/** Pool reads finish their source snapshot before the next checkout. A caller-owned
 * client retains its physical snapshot and transaction lifetime, with each logical
 * home bound independently through the ordinary read composition. Never check out
 * another connection while that caller holds its client.
 */
function atHome<T>(client: Queryable, route: number, read: (bound: Queryable) => Promise<T>): Promise<T> {
  const boundRead = async (connection: Queryable) => read(await partitionReadClient(connection, partitionOf(route)));
  return isPool(client) ? withReadTransaction(client, boundRead) : boundRead(client);
}

/** Three independent home observations, not a cross-home atomic snapshot. */
export async function readRatingAggregate(
  client: Queryable,
  input: { questionId: string; populationId: string; targetId: string },
): Promise<RatingAggregate | null> {
  const questionRoute = routeOf(input.questionId);
  const populationRoute = routeOf(input.populationId);
  const targetRoute = routeOf(input.targetId);
  if (questionRoute === null || populationRoute === null || targetRoute === null)
    throw new TypeError('Invalid rating aggregate address');

  const question = await atHome(client, questionRoute, (bound) =>
    readQuestion.run(bound, { question_id: input.questionId }),
  );
  if (!question) return null;
  const size = ratingQuestionHistogramSize(question);

  const freshness = await atHome(client, populationRoute, (bound) =>
    readFreshness.run(bound, { route: populationRoute, population_id: input.populationId }),
  );
  const rows = await atHome(client, targetRoute, (bound) =>
    readComponents.run(bound, {
      route: targetRoute,
      question_id: input.questionId,
      population_id: input.populationId,
      target_id: input.targetId,
    }),
  );
  if (rows.length > 16) throw new Error('Rating aggregate exceeds its component bound');
  const histogram = Array<bigint>(size).fill(0n);
  let count = 0n;
  let sum = 0n;
  let appliedAt: string | null = null;
  for (const row of rows) {
    count += BigInt(row.count);
    sum += BigInt(row.sum);
    assertPostgresBigint(count);
    assertPostgresBigint(sum);
    if (row.histogram.length !== size) throw new Error('Rating aggregate histogram scale mismatch');
    for (let index = 0; index < size; index++) {
      histogram[index]! += BigInt(row.histogram[index]!);
      assertPostgresBigint(histogram[index]!);
    }
    if (row.appliedAt !== null && (appliedAt === null || Date.parse(row.appliedAt) > Date.parse(appliedAt)))
      appliedAt = row.appliedAt;
  }
  return { count, sum, histogram, appliedAt, updating: freshness!.updating };
}
