import type { Pool } from 'pg';
import { defineQuery } from 'reylo';
import { GLOBAL_CONTEXT } from '../access/gates/catalogue.ts';
import { discardConnection, withConnection } from '../database/pool.ts';
import { partitionOf, routeOf } from '../route/route.ts';
import type {
  PublicRatingEpoch,
  PublicRatingFigure,
  PublicRatingSnapshot,
  PublicRatingSource,
} from '../search/rating-source.ts';
import { readPublicFigures } from './public-figure.ts';
import readPublicRatingEpochSql from './public-rating-source-epoch.sql';
import { STANDARD_QUESTION_ID } from './votes.ts';

const MAX_SUBJECTS = 256;

const readPublicRatingEpoch = defineQuery<
  (typeof readPublicRatingEpochSql)['~reylo']['input'],
  (typeof readPublicRatingEpochSql)['~reylo']['element'],
  typeof readPublicRatingEpochSql.cardinality,
  'postgres'
>({
  dialect: readPublicRatingEpochSql.dialect,
  sql: readPublicRatingEpochSql.raw,
  params: readPublicRatingEpochSql.params,
  cardinality: readPublicRatingEpochSql.cardinality,
});

type PriorEpochRow = { priorEpoch: number | null };

function validateRead(partition: number, subjectIds: readonly string[]): void {
  if (!Number.isSafeInteger(partition) || partition < 0 || partition > 4095)
    throw new RangeError('Public rating source partition must be an integer from 0 through 4095');
  if (!Array.isArray(subjectIds) || subjectIds.length > MAX_SUBJECTS)
    throw new RangeError('Public rating source reads accept at most 256 subjects');

  for (const subjectId of subjectIds) {
    const route = routeOf(subjectId);
    if (route === null || partitionOf(route) !== partition)
      throw new RangeError('Every public rating subject must be anchored to the requested partition');
  }
}

function toPublicFigure(figure: Awaited<ReturnType<typeof readPublicFigures>>[number]): PublicRatingFigure {
  if (figure.count < 1 || figure.asOf === null) throw new Error('Invalid current public rating figure');
  return {
    questionId: figure.questionId,
    populationId: figure.populationId,
    subjectId: figure.subjectId,
    count: figure.count,
    mean: figure.mean,
    score: figure.score,
    priorEpoch: figure.priorEpoch,
    revision: figure.revision,
    asOf: figure.asOf,
  };
}

/** Compose the search rating source from current public figures for the standard question and Global population. */
export function createPublicRatingSource(pool: Pool): PublicRatingSource {
  return {
    async read(partition: number, subjectIds: readonly string[]): Promise<PublicRatingSnapshot> {
      validateRead(partition, subjectIds);
      return withConnection(pool, async (client) => {
        await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
        try {
          const partitionResult = await client.query<{ position: string }>(
            'SELECT "position"::text AS position FROM core.partition WHERE partition_no = $1',
            [partition],
          );
          const partitionRow = partitionResult.rows[0];
          if (!partitionRow) throw new Error('Rating source partition position is unavailable');

          const current = await readPublicFigures(client, {
            partition,
            questionId: STANDARD_QUESTION_ID,
            populationId: GLOBAL_CONTEXT.id,
            subjectIds,
          });
          const figures = new Map<string, PublicRatingFigure>();
          for (const figure of current) {
            if (figure.count === 0) continue;
            const publicFigure = toPublicFigure(figure);
            figures.set(publicFigure.subjectId, publicFigure);
          }

          await client.query('COMMIT');
          return { partition, position: BigInt(partitionRow.position), figures };
        } catch (error) {
          try {
            await client.query('ROLLBACK');
          } catch (rollbackError) {
            discardConnection(
              client,
              rollbackError instanceof Error ? rollbackError : new Error(String(rollbackError)),
            );
          }
          throw error;
        }
      });
    },

    async epoch(): Promise<PublicRatingEpoch> {
      return withConnection(pool, async (client) => {
        const row = (await readPublicRatingEpoch.run(client, {
          route: routeOf(GLOBAL_CONTEXT.id)!,
          question_id: STANDARD_QUESTION_ID,
          population_id: GLOBAL_CONTEXT.id,
        })) as PriorEpochRow | undefined;
        const priorEpoch = row?.priorEpoch ?? null;
        if (priorEpoch !== null && (!Number.isSafeInteger(priorEpoch) || priorEpoch < 1))
          throw new Error('Rating prior epoch is outside the safe range');
        return { questionId: STANDARD_QUESTION_ID, populationId: GLOBAL_CONTEXT.id, priorEpoch };
      });
    },
  };
}
