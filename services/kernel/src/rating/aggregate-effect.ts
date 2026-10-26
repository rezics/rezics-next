import type { Pool, PoolClient } from 'pg';
import { Value } from 'typebox/value';
import type { RatingCounter } from '../access/rating-counter.ts';
import { runCommand } from '../command/command.ts';
import { withConnection } from '../database/pool.ts';
import type { Effect } from '../events/effects.ts';
import type { CloudEvent } from '../events/log.ts';
import { partitionOf, routeOf } from '../route/route.ts';
import { RATING_EVENTS } from './events.ts';
import applyComponent from './aggregate-component-apply.sql';
import readAggregateSql from './aggregate-read.sql';
import readCountedVote from './population-vote-counted-read.sql';
import readPopulationVotersSql from './population-voters-page.sql';
import deletePopulationVote from './population-vote-delete.sql';
import upsertPopulationVote from './population-vote-upsert.sql';
import readQuestionScale from './question-scale-read.sql';

const VOTE_CHANGED = 'com.rezics.rating.vote.changed.v1';
const AGGREGATE_APPLIED = 'com.rezics.rating.aggregate.applied.v1';
const SEGMENT_PAGE = 'com.rezics.rating.segment.page.v1';

export type RatingChange = {
  voterId: string;
  countingKey: string;
  questionId: string;
  populationId: string;
  targetId: string;
  revision: number;
  at: string | Date;
} & ({ units: number | null; remove?: false } | { remove: true; units?: never });

type Queryable = Pick<Pool | PoolClient, 'query'>;
type QuestionScale = { minimumUnits: number; maximumUnits: number; stepUnits: number };
type CountedVote = { voterId: string; units: number; at: string };

export type RatingAggregate = {
  count: bigint;
  sum: bigint;
  histogram: bigint[];
  appliedAt: string | null;
  updating: boolean;
};

export type PopulationVoter = {
  questionId: string;
  voterId: string;
  units: number | null;
  revision: number;
  at: string;
};

class NoAggregateChange extends Error {}

function validId(value: string): boolean {
  return routeOf(value) !== null;
}

function normalizeInstant(value: string | Date): string {
  const at = value instanceof Date ? value.toISOString() : value;
  if (!Number.isFinite(Date.parse(at))) throw new TypeError('Invalid rating change time');
  return at;
}

function validateChange(change: RatingChange): { route: number; at: string; shard: number } {
  if (
    !change ||
    !validId(change.voterId) ||
    !validId(change.questionId) ||
    !validId(change.populationId) ||
    !validId(change.targetId) ||
    !/^[0-9a-f]{64}$/.test(change.countingKey) ||
    !Number.isSafeInteger(change.revision) ||
    change.revision < 1 ||
    (!change.remove &&
      change.units !== null &&
      (!Number.isSafeInteger(change.units) || change.units < 0 || change.units > 20))
  )
    throw new TypeError('Invalid rating aggregate change');
  const route = routeOf(change.targetId)!;
  const keyByte = Number.parseInt(change.countingKey.slice(0, 2), 16);
  return { route, at: normalizeInstant(change.at), shard: keyByte % 16 };
}

function histogramSize(scale: QuestionScale): number {
  const distance = scale.maximumUnits - scale.minimumUnits;
  if (
    !Number.isSafeInteger(scale.minimumUnits) ||
    !Number.isSafeInteger(scale.maximumUnits) ||
    !Number.isSafeInteger(scale.stepUnits) ||
    scale.stepUnits < 1 ||
    distance < 0 ||
    distance % scale.stepUnits !== 0
  )
    throw new Error('Invalid rating question scale');
  return distance / scale.stepUnits + 1;
}

function histogramIndex(scale: QuestionScale, units: number): number {
  const offset = units - scale.minimumUnits;
  if (offset < 0 || offset % scale.stepUnits !== 0 || units > scale.maximumUnits)
    throw new TypeError('Rating vote is outside its question scale');
  return offset / scale.stepUnits;
}

function deltaFor(
  before: CountedVote | null,
  after: CountedVote | null,
  scale: QuestionScale,
): {
  count: bigint;
  sum: bigint;
  histogram: bigint[];
} {
  const histogram = Array<bigint>(histogramSize(scale)).fill(0n);
  let count = 0n;
  let sum = 0n;
  if (before) {
    count -= 1n;
    sum -= BigInt(before.units);
    histogram[histogramIndex(scale, before.units)]! -= 1n;
  }
  if (after) {
    count += 1n;
    sum += BigInt(after.units);
    histogram[histogramIndex(scale, after.units)]! += 1n;
  }
  return { count, sum, histogram };
}

function returnedRows(value: unknown): boolean {
  if (Array.isArray(value)) return value.length > 0;
  return value !== null && value !== undefined;
}

async function applyPartition(pool: Pool, changes: readonly RatingChange[], partition: number): Promise<void> {
  try {
    await runCommand(pool, { partition }, async (tx, command) => {
      const scales = new Map<string, QuestionScale>();
      let applied = 0;
      for (const change of changes) {
        const { route, at, shard } = validateChange(change);
        let scale = scales.get(change.questionId);
        if (!scale) {
          scale = (await readQuestionScale.run(tx, { question_id: change.questionId })) ?? undefined;
          if (!scale) throw new Error('Rating question unavailable');
          scales.set(change.questionId, scale);
        }
        const parameters = {
          route,
          question_id: change.questionId,
          population_id: change.populationId,
          target_id: change.targetId,
          counting_key: change.countingKey,
        };
        const before = await readCountedVote.run(tx, parameters);
        let wroteVote = false;
        if (change.remove) {
          wroteVote = returnedRows(
            await deletePopulationVote.run(tx, { ...parameters, voter_id: change.voterId, revision: change.revision }),
          );
        } else {
          wroteVote = returnedRows(
            await upsertPopulationVote.run(tx, {
              ...parameters,
              voter_id: change.voterId,
              units: change.units,
              at,
              revision: change.revision,
            }),
          );
        }
        const after = await readCountedVote.run(tx, parameters);
        const delta = deltaFor(before, after, scale);
        if (!wroteVote) continue;
        const rows = await applyComponent.run(tx, {
          ...parameters,
          shard,
          count_delta: delta.count.toString(),
          sum_delta: delta.sum.toString(),
          histogram_delta: delta.histogram.map(String),
          at,
        });
        if (!returnedRows(rows)) throw new Error('Rating aggregate component would be negative or incompatible');
        applied += 1;
      }
      if (applied === 0) throw new NoAggregateChange();
      return {
        value: undefined,
        events: [{ type: AGGREGATE_APPLIED, data: { applied } }],
      };
    });
  } catch (error) {
    if (!(error instanceof NoAggregateChange)) throw error;
  }
}

/** Apply vote changes using one target-partition command for each partition in the input. */
export async function applyRatingChanges(pool: Pool, input: readonly RatingChange[]): Promise<void> {
  if (!Array.isArray(input)) throw new TypeError('Rating changes must be an array');
  const grouped = new Map<number, RatingChange[]>();
  for (const change of input) {
    const { route } = validateChange(change);
    const partition = partitionOf(route);
    const changes = grouped.get(partition) ?? [];
    changes.push(change);
    grouped.set(partition, changes);
  }
  await Promise.all([...grouped].map(([partition, changes]) => applyPartition(pool, changes, partition)));
}

/** Resolve the private counting key at the event T, then apply that vote to every listed population. */
export async function applyRatingVoteEvent(pool: Pool, ratingCounter: RatingCounter, event: CloudEvent): Promise<void> {
  if (
    event.type !== VOTE_CHANGED ||
    !Value.Check(RATING_EVENTS[VOTE_CHANGED], event.data) ||
    !Number.isFinite(Date.parse(event.time))
  )
    throw new TypeError('Invalid rating vote event');
  const data = event.data as {
    voterId: string;
    questionId: string;
    targetId: string;
    units: number | null;
    revision: number;
    populations: string[];
  };
  const countingKey = await withConnection(pool, (client) => ratingCounter(client, data.voterId, event.time));
  const changes: RatingChange[] = data.populations.map((populationId) => ({
    voterId: data.voterId,
    countingKey,
    questionId: data.questionId,
    populationId,
    targetId: data.targetId,
    units: data.units,
    revision: data.revision,
    at: event.time,
  }));
  await applyRatingChanges(pool, changes);
}

/** Register the single shared-effects consumer for rating vote changes. */
export function createRatingAggregateEffect(pool: Pool, ratingCounter: RatingCounter): Effect {
  return {
    name: 'rating_aggregate',
    types: [VOTE_CHANGED, SEGMENT_PAGE],
    async run(event) {
      if (event.type === SEGMENT_PAGE) await applyRatingSegmentPageEvent(pool, ratingCounter, event);
      else await applyRatingVoteEvent(pool, ratingCounter, event);
    },
  };
}

/** Apply one voter Realm page through the same grouped component writer as ordinary vote events. */
export async function applyRatingSegmentPageEvent(
  pool: Pool,
  ratingCounter: RatingCounter,
  event: CloudEvent,
): Promise<void> {
  if (
    event.type !== SEGMENT_PAGE ||
    !Value.Check(RATING_EVENTS[SEGMENT_PAGE], event.data) ||
    !Number.isFinite(Date.parse(event.time))
  )
    throw new TypeError('Invalid rating segment page event');
  const data = event.data as {
    voterId: string;
    realmId: string;
    direction: 'adding' | 'removing';
    votes: Array<{ questionId: string; targetId: string; units: number | null; revision: number }>;
  };
  if (data.votes.length === 0) return;
  const countingKey = await withConnection(pool, (client) => ratingCounter(client, data.voterId, event.time));
  await applyRatingChanges(
    pool,
    data.votes.map((vote) => ({
      voterId: data.voterId,
      countingKey,
      questionId: vote.questionId,
      populationId: data.realmId,
      targetId: vote.targetId,
      revision: vote.revision,
      at: event.time,
      ...(data.direction === 'removing' ? { remove: true as const } : { units: vote.units }),
    })),
  );
}

/** Sum at most sixteen shards. A missing question returns null; a question without votes returns zero components. */
export async function readAggregate(
  client: Queryable,
  input: { questionId: string; populationId: string; targetId: string },
): Promise<RatingAggregate | null> {
  const route = routeOf(input.targetId);
  if (route === null || !validId(input.questionId) || !validId(input.populationId))
    throw new TypeError('Invalid rating aggregate address');
  const rows = await readAggregateSql.run(client, {
    route,
    population_route: routeOf(input.populationId)!,
    question_id: input.questionId,
    population_id: input.populationId,
    target_id: input.targetId,
  });
  if (rows.length === 0) return null;
  const first = rows[0]!;
  const size = histogramSize(first);
  const histogram = Array<bigint>(size).fill(0n);
  let count = 0n;
  let sum = 0n;
  let appliedAt: string | null = null;
  for (const row of rows) {
    if (row.count === null) continue;
    count += BigInt(row.count);
    sum += BigInt(row.sum!);
    const shardHistogram = JSON.parse(row.histogram!) as string[];
    if (shardHistogram.length !== size) throw new Error('Rating aggregate histogram scale mismatch');
    for (let index = 0; index < size; index++) histogram[index]! += BigInt(shardHistogram[index]!);
    if (row.appliedAt !== null && (appliedAt === null || Date.parse(row.appliedAt) > Date.parse(appliedAt)))
      appliedAt = row.appliedAt;
  }
  return { count, sum, histogram, appliedAt, updating: first.updating };
}

/** Page population votes in (question_id, voter_id) order without exposing their counting keys. */
export async function readPopulationVoters(
  client: Queryable,
  input: {
    populationId: string;
    targetId: string;
    after: { questionId: string; voterId: string } | null;
    limit: number;
  },
): Promise<PopulationVoter[]> {
  const route = routeOf(input.targetId);
  if (
    route === null ||
    !validId(input.populationId) ||
    !Number.isSafeInteger(input.limit) ||
    input.limit < 1 ||
    input.limit > 100 ||
    (input.after !== null && (!validId(input.after.questionId) || !validId(input.after.voterId)))
  )
    throw new TypeError('Invalid population voter page');
  const rows = await readPopulationVotersSql.run(client, {
    route,
    population_id: input.populationId,
    target_id: input.targetId,
    after_question_id: input.after?.questionId ?? null,
    after_voter_id: input.after?.voterId ?? null,
    limit: input.limit,
  });
  return rows.map((row) => ({
    questionId: row.questionId,
    voterId: row.voterId,
    units: row.units === null ? null : Number(row.units),
    revision: Number(row.revision),
    at: row.at,
  }));
}
