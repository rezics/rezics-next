import type { Pool, PoolClient } from 'pg';
import { defineQuery } from 'reylo';
import { Value } from 'typebox/value';
import { runCommand } from '../command/command.ts';
import type { Effect } from '../events/effects.ts';
import type { CloudEvent } from '../events/log.ts';
import { partitionOf, routeOf } from '../route/route.ts';
import { RATING_EVENTS } from './events.ts';
import drainPublicFiguresSql from './public-figure-drain.sql';
import pagePublicFiguresSql from './public-figures-page.sql';
import readPublicFiguresSql from './public-figures-read.sql';

const readPublicFiguresStatement = defineQuery<
  (typeof readPublicFiguresSql)['~reylo']['input'],
  (typeof readPublicFiguresSql)['~reylo']['element'],
  typeof readPublicFiguresSql.cardinality,
  'postgres'
>({
  dialect: readPublicFiguresSql.dialect,
  sql: readPublicFiguresSql.raw,
  params: readPublicFiguresSql.params,
  cardinality: readPublicFiguresSql.cardinality,
});
const pagePublicFiguresStatement = defineQuery<
  (typeof pagePublicFiguresSql)['~reylo']['input'],
  (typeof pagePublicFiguresSql)['~reylo']['element'],
  typeof pagePublicFiguresSql.cardinality,
  'postgres'
>({
  dialect: pagePublicFiguresSql.dialect,
  sql: pagePublicFiguresSql.raw,
  params: pagePublicFiguresSql.params,
  cardinality: pagePublicFiguresSql.cardinality,
});

const FIGURE_CHANGED = 'com.rezics.rating.public_figure.changed.v1';
const AGGREGATE_APPLIED = 'com.rezics.rating.aggregate.applied.v1';
const DEFAULT_DRAIN_LIMIT = 500;
const MAX_DRAIN_LIMIT = 500;
const MAX_READ_IDS = 256;

type Queryable = Pick<Pool | PoolClient, 'query'>;

export type PublicFigure = Readonly<{
  questionId: string;
  populationId: string;
  subjectId: string;
  count: number;
  mean: number | null;
  score: number | null;
  m: number | null;
  C: number | null;
  priorEpoch: number | null;
  revision: string;
  asOf: string | null;
  position: string;
}>;

type PublicFigureRow = {
  questionId: string;
  populationId: string;
  subjectId: string;
  count: string;
  mean: string | null;
  score: string | null;
  m: string | null;
  C: string | null;
  priorEpoch: number | null;
  revision: string;
  asOf: string | null;
  position: string;
};

class NoPendingFigures extends Error {}

function validId(value: string): boolean {
  return routeOf(value) !== null;
}

function validateAddress(input: { partition: number; questionId: string; populationId: string }): void {
  if (
    !Number.isSafeInteger(input.partition) ||
    input.partition < 0 ||
    input.partition > 4095 ||
    !validId(input.questionId) ||
    !validId(input.populationId)
  )
    throw new TypeError('Invalid public rating figure address');
}

function figureFromRow(row: PublicFigureRow): PublicFigure {
  const count = Number(row.count);
  const priorEpoch = row.priorEpoch === null ? null : Number(row.priorEpoch);
  if (!Number.isSafeInteger(count) || count < 0)
    throw new Error('Public rating figure count is outside the safe range');
  if (priorEpoch !== null && !Number.isSafeInteger(priorEpoch))
    throw new Error('Public rating figure prior epoch is outside the safe range');
  return {
    questionId: row.questionId,
    populationId: row.populationId,
    subjectId: row.subjectId,
    count,
    mean: row.mean === null ? null : Number(row.mean),
    score: row.score === null ? null : Number(row.score),
    m: row.m === null ? null : Number(row.m),
    C: row.C === null ? null : Number(row.C),
    priorEpoch,
    revision: row.revision,
    asOf: row.asOf === null ? null : new Date(row.asOf).toISOString(),
    position: row.position,
  };
}

/** Read up to 256 current, published figures for subjects in their anchor partition with one statement. */
export async function readPublicFigures(
  client: Queryable,
  input: { partition: number; questionId: string; populationId: string; subjectIds: readonly string[] },
): Promise<PublicFigure[]> {
  validateAddress(input);
  if (!Array.isArray(input.subjectIds) || input.subjectIds.length > MAX_READ_IDS)
    throw new TypeError('Public figure reads accept at most 256 subjects');
  for (const subjectId of input.subjectIds) {
    const route = routeOf(subjectId);
    if (route === null || partitionOf(route) !== input.partition)
      throw new TypeError('Public figure subjects must belong to the requested partition');
  }
  const rows = (await readPublicFiguresStatement.run(client, {
    partition_no: input.partition,
    question_id: input.questionId,
    population_id: input.populationId,
    subject_ids: [...input.subjectIds],
  })) as PublicFigureRow[];
  return rows.map(figureFromRow);
}

/** Page published figures for one question and population in anchor-subject order with one statement. */
export async function pagePublicFigures(
  client: Queryable,
  input: { partition: number; questionId: string; populationId: string; after: string | null; limit: number },
): Promise<PublicFigure[]> {
  validateAddress(input);
  const afterRoute = input.after === null ? null : routeOf(input.after);
  if (
    !Number.isSafeInteger(input.limit) ||
    input.limit < 1 ||
    input.limit > 500 ||
    (input.after !== null && (afterRoute === null || partitionOf(afterRoute) !== input.partition))
  )
    throw new TypeError('Invalid public rating figure page');
  const rows = (await pagePublicFiguresStatement.run(client, {
    partition_no: input.partition,
    question_id: input.questionId,
    population_id: input.populationId,
    after: input.after ?? '00000000-0000-0000-0000-000000000000',
    limit: input.limit,
  })) as PublicFigureRow[];
  return rows.map(figureFromRow);
}

/** Publish at most one event per pending figure in a serial anchor-partition page. */
export async function drainPublicFigures(pool: Pool, partition: number, limit = DEFAULT_DRAIN_LIMIT): Promise<number> {
  if (!Number.isSafeInteger(partition) || partition < 0 || partition > 4095)
    throw new TypeError('Invalid public rating figure partition');
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_DRAIN_LIMIT)
    throw new TypeError('Public figure drain limit must be from 1 to 500');

  try {
    const outcome = await runCommand(pool, { partition }, async (tx) => {
      const rows = (await drainPublicFiguresSql.run(tx, { partition_no: partition, limit })) as PublicFigureRow[];
      if (rows.length === 0) throw new NoPendingFigures();
      const figures = rows.map(figureFromRow);
      return {
        value: figures.length,
        events: figures.map((figure) => ({ type: FIGURE_CHANGED, subject: figure.subjectId, data: figure })),
      };
    });
    return outcome.value;
  } catch (error) {
    if (error instanceof NoPendingFigures) return 0;
    throw error;
  }
}

function eventPartition(event: CloudEvent): number {
  const match = /^urn:rezics:log:(\d+)\.(\d+)$/.exec(event.source);
  const partition = match?.[1] === undefined ? Number.NaN : Number(match[1]);
  const epoch = match?.[2] === undefined ? Number.NaN : Number(match[2]);
  if (
    !Number.isSafeInteger(partition) ||
    partition < 0 ||
    partition > 4095 ||
    !Number.isSafeInteger(epoch) ||
    epoch < 1 ||
    !/^\d{19}$/.test(event.sequence) ||
    BigInt(event.sequence) < 1n
  )
    throw new TypeError('Invalid rating aggregate event position');
  return partition;
}

/** Drain the aggregate partition's pending figures after the aggregate-applied event commits. */
export function createPublicFigureDrainEffect(pool: Pool): Effect {
  return {
    name: 'rating_public_figure',
    types: [AGGREGATE_APPLIED],
    async run(event) {
      if (event.type !== AGGREGATE_APPLIED || !Value.Check(RATING_EVENTS[AGGREGATE_APPLIED], event.data))
        throw new TypeError('Invalid rating aggregate applied event');
      const partition = eventPartition(event);
      while ((await drainPublicFigures(pool, partition)) === MAX_DRAIN_LIMIT) {
        // A full page has a successor; each next page commits independently under the partition gate.
      }
    },
  };
}
