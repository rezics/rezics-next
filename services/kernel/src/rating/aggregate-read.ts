import type { Pool, PoolClient } from 'pg';
import { routeOf } from '../route/route.ts';
import populationPageSql from './aggregate-populations-page.sql';
import questionRead from './question-read.sql';
import { readAggregate, type RatingAggregate } from './aggregate-effect.ts';

type Queryable = Pick<Pool | PoolClient, 'query'>;

export type RatingFigure = Readonly<{
  population: string;
  count: number;
  freshness: Readonly<{ asOf: string | null; updating: boolean }>;
}> &
  (
    | Readonly<{ mean: number; histogram: number[]; remaining?: never }>
    | Readonly<{ remaining: number; mean?: never; histogram?: never }>
    | Readonly<{ mean?: never; histogram?: never; remaining?: never }>
  );

export type RatingPopulation = Readonly<{ population: string; count: number }>;

export type RatingPopulationPage = Readonly<{
  populations: RatingPopulation[];
  after: string | null;
  hasMore: boolean;
}>;

export type RatingQuestionGrain = 'work' | 'release' | 'episode' | 'character';

/** Trusted internal metadata only; disclosure callers use readVisibleRatingQuestion. */
export async function readRatingQuestion(
  client: Queryable,
  questionId: string,
): Promise<Readonly<{ id: string; grain: RatingQuestionGrain; realmId: string | null }> | null> {
  if (routeOf(questionId) === null) return null;
  const row = await questionRead.run(client, { question_id: questionId });
  if (!row) return null;
  if (row.grain !== 'work' && row.grain !== 'release' && row.grain !== 'episode' && row.grain !== 'character')
    throw new Error('Unknown rating question grain');
  return { id: row.id, grain: row.grain, realmId: row.realmId };
}

function asFigure(
  population: string,
  aggregate: RatingAggregate,
  grain: 'work' | 'release' | 'episode' | 'character',
): RatingFigure {
  const count = Number(aggregate.count);
  if (!Number.isSafeInteger(count) || count < 0) throw new Error('Rating aggregate count is outside the safe range');
  const freshness = {
    asOf: aggregate.appliedAt === null ? null : new Date(aggregate.appliedAt).toISOString(),
    updating: aggregate.updating,
  };
  const threshold = grain === 'work' || grain === 'release' ? 5 : 10;
  if (count === 0) return { population, count, freshness };
  if (count < threshold) return { population, count, remaining: threshold - count, freshness };
  return {
    population,
    count,
    mean: Number((Number(aggregate.sum) / count).toFixed(2)),
    histogram: aggregate.histogram.map((value) => Number(value)),
    freshness,
  };
}

/** Read the independently sharded aggregate for one population and apply its grain threshold. */
export async function readAggregateFigure(
  client: Queryable,
  input: {
    questionId: string;
    populationId: string;
    targetId: string;
    grain?: RatingQuestionGrain;
  },
): Promise<RatingFigure | null> {
  const aggregate = await readAggregate(client, input);
  if (!aggregate) return null;
  return asFigure(input.populationId, aggregate, input.grain ?? 'work');
}

/** Page populations that have a positive component for the target, using the target-first partial index. */
export async function readRatingPopulationPage(
  client: Queryable,
  input: { questionId: string; targetId: string; after: string | null; limit?: number },
): Promise<RatingPopulationPage> {
  const route = routeOf(input.targetId);
  const limit = input.limit ?? 20;
  if (
    route === null ||
    routeOf(input.questionId) === null ||
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    limit > 20 ||
    (input.after !== null && routeOf(input.after) === null)
  )
    throw new TypeError('Invalid rating population page');
  const rows = (await populationPageSql.run(client, {
    route,
    question_id: input.questionId,
    target_id: input.targetId,
    after_population_id: input.after ?? '00000000-0000-0000-0000-000000000000',
    limit,
  })) as { population: string; count: string; hasMore: boolean }[];
  const populations = rows.map((row) => {
    const count = Number(row.count);
    if (!Number.isSafeInteger(count) || count < 1) throw new Error('Rating population count is outside the safe range');
    return { population: row.population, count };
  });
  return {
    populations,
    after: populations.at(-1)?.population ?? null,
    hasMore: rows[0]?.hasMore ?? false,
  };
}
