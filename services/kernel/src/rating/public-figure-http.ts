import { t } from 'elysia';
import type { Pool } from 'pg';
import { deadlineClient } from '../access/authenticate.ts';
import { GLOBAL_CONTEXT } from '../access/gates/catalogue.ts';
import { discardConnection, withConnection } from '../database/pool.ts';
import { partitionOf, routeOf } from '../route/route.ts';
import { publicFigureState, readPublicFigurePending, readPublicFigures } from './public-figure.ts';
import questionRead from './question-read.sql';
import { STANDARD_QUESTION_ID } from './votes.ts';

const closed = { additionalProperties: false } as const;
const nullableDisplayNumber = t.Union([t.Number({ minimum: 0, maximum: 10 }), t.Null()]);

/** Shared subject-page and search-hit transport; units metadata belongs to the question. */
export const PublicFigureSchema = t.Object(
  {
    questionId: t.String({ format: 'uuid' }),
    populationId: t.String({ format: 'uuid' }),
    scale: t.Object({ min: t.Integer(), max: t.Integer(), displayStep: t.Integer({ minimum: 1 }) }, closed),
    count: t.Integer({ minimum: 0 }),
    state: t.Union([t.Literal('ready'), t.Literal('insufficient_data'), t.Literal('updating')]),
    mean: nullableDisplayNumber,
    score: nullableDisplayNumber,
  },
  closed,
);

/** Only published Global data and its pending mark enter the consumer snapshot. */
export async function readSubjectPublicFigure(pool: Pool, subjectId: string, deadline: number) {
  const route = routeOf(subjectId);
  if (route === null) throw new TypeError('Invalid subject figure address');
  return withConnection(pool, async (client) => {
    const bounded = deadlineClient(client, deadline);
    await bounded.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    try {
      const question = await questionRead.run(bounded, { question_id: STANDARD_QUESTION_ID });
      if (!question) {
        await bounded.query('COMMIT');
        return null;
      }
      const [published] = await readPublicFigures(bounded, {
        partition: partitionOf(route),
        questionId: STANDARD_QUESTION_ID,
        populationId: GLOBAL_CONTEXT.id,
        subjectIds: [subjectId],
      });
      const pending = await readPublicFigurePending(bounded, {
        questionId: STANDARD_QUESTION_ID,
        populationId: GLOBAL_CONTEXT.id,
        subjectId,
      });
      const state = publicFigureState(published ?? null, question.grain, pending);
      const result = {
        revision: published?.revision ?? '0',
        figure: {
          questionId: question.id,
          populationId: GLOBAL_CONTEXT.id,
          scale: { min: question.minimumUnits, max: question.maximumUnits, displayStep: question.stepUnits },
          count: published?.count ?? 0,
          state,
          mean: state === 'ready' ? (published?.mean ?? null) : null,
          score: state === 'ready' && published?.priorEpoch != null ? published.score : null,
        },
      };
      await bounded.query('COMMIT');
      return result;
    } catch (error) {
      try {
        await client.query('ROLLBACK');
      } catch (rollbackError) {
        discardConnection(client, rollbackError instanceof Error ? rollbackError : new Error(String(rollbackError)));
      }
      throw error;
    }
  });
}
