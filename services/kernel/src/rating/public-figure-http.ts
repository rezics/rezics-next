import { t } from 'elysia';
import type { Pool } from 'pg';
import type { Static } from 'typebox';
import { deadlineClient } from '../access/authenticate.ts';
import { GLOBAL_CONTEXT } from '../access/gates/catalogue.ts';
import { discardConnection, withConnection } from '../database/pool.ts';
import { partitionOf, routeOf } from '../route/route.ts';
import { publicFigureState, type Queryable } from './public-figure.ts';
import readViews from './public-figure-views.sql';
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

export type PublicFigureView = Static<typeof PublicFigureSchema>;

/** Two Global-only point reads within the caller's REPEATABLE READ READ ONLY snapshot; no transaction control. */
export async function readPublicFigureViews(
  client: Queryable,
  subjectIds: readonly string[],
): Promise<ReadonlyMap<string, Readonly<{ figure: PublicFigureView; revision: string }>> | null> {
  if (!Array.isArray(subjectIds) || subjectIds.length > 256)
    throw new TypeError('Public figure reads accept at most 256 subjects');
  const subjects = [...new Set(subjectIds)].map((subject_id) => {
    const route = routeOf(subject_id);
    if (route === null) throw new TypeError('Invalid subject figure address');
    return { partition_no: partitionOf(route), route, subject_id };
  });
  const result = new Map<string, Readonly<{ figure: PublicFigureView; revision: string }>>();
  if (subjects.length === 0) return result;
  const question = await questionRead.run(client, { question_id: STANDARD_QUESTION_ID });
  const rows = await readViews.run(client, {
    subjects,
    question_id: STANDARD_QUESTION_ID,
    population_id: GLOBAL_CONTEXT.id,
  });
  if (!question) return null;
  const bySubject = new Map(rows.map((row) => [row.subjectId, row]));
  for (const { subject_id } of subjects) {
    const row = bySubject.get(subject_id);
    const published = row && row.revision !== '0' ? row : undefined;
    const count = Number(published?.count ?? 0);
    if (!Number.isSafeInteger(count) || count < 0)
      throw new Error('Public rating figure count is outside the safe range');
    const state = publicFigureState({ count }, question.grain, row?.pending ?? false);
    result.set(subject_id, {
      revision: published?.revision ?? '0',
      figure: {
        questionId: question.id,
        populationId: GLOBAL_CONTEXT.id,
        scale: { min: question.minimumUnits, max: question.maximumUnits, displayStep: question.stepUnits },
        count,
        state,
        mean: state === 'ready' && published?.mean != null ? Number(published.mean) : null,
        score:
          state === 'ready' && published?.priorEpoch != null && published.score !== null
            ? Number(published.score)
            : null,
      },
    });
  }
  return result;
}

/** Only published Global data and its pending mark enter the consumer snapshot. */
export async function readSubjectPublicFigure(pool: Pool, subjectId: string, deadline: number) {
  if (routeOf(subjectId) === null) throw new TypeError('Invalid subject figure address');
  return withConnection(pool, async (client) => {
    const bounded = deadlineClient(client, deadline);
    await bounded.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    try {
      const views = await readPublicFigureViews(bounded, [subjectId]);
      const result = views?.get(subjectId) ?? null;
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
