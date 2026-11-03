import type { Pool, PoolClient } from 'pg';
import { Value } from 'typebox/value';
import type { RatingCounter } from '../access/rating-counter.ts';
import { runCommand } from '../command/command.ts';
import { withConnection } from '../database/pool.ts';
import type { Effect } from '../events/effects.ts';
import type { CloudEvent } from '../events/log.ts';
import { partitionOf, routeOf } from '../route/route.ts';
import { RATING_EVENTS } from './events.ts';
import { acknowledgeRatingErasurePage } from './erasure-status.ts';
import applyComponent from './aggregate-component-apply.sql';
import { readRatingAggregate } from './aggregate-read-components.ts';
import readCountedVote from './population-vote-counted-read.sql';
import readPopulationVotersSql from './population-voters-page.sql';
import deletePopulationVote from './population-vote-delete.sql';
import upsertPopulationVote from './population-vote-upsert.sql';
import readPopulationVoteForRekey from './population-vote-rekey-read.sql';
import rekeyPopulationVote from './population-vote-rekey-upsert.sql';
import { PopulationTotalCapture, flushPopulationTotalDeliveries } from './population-total.ts';
import { partitionReadClient } from '../database/read-snapshot.ts';
import { withReadTransaction } from '../semantic/read.ts';
import readQuestionScale from './question-scale-read.sql';
import readPublicFigurePosition from './public-figure-next-position.sql';
import markPublicFigurePending from './public-figure-pending.sql';
import { STANDARD_QUESTION_ID } from './votes.ts';
import { advanceRatingSource, ratingSourcePosition, type RatingSourcePosition } from './realm-rank-delivery.ts';

const VOTE_CHANGED = 'com.rezics.rating.vote.changed.v1';
const AGGREGATE_APPLIED = 'com.rezics.rating.aggregate.applied.v1';
const SEGMENT_PAGE = 'com.rezics.rating.segment.page.v1';

type RatingChangeFields = {
  voterId: string;
  countingKey: string;
  questionId: string;
  populationId: string;
  targetId: string;
  revision: number;
  at: string | Date;
  source?: RatingSourcePosition | undefined;
  appliedAt?: string;
};
export type RatingChange = RatingChangeFields &
  (
    | { units: number | null; remove?: false; rekey?: never; rekeyAt?: never }
    | {
        units: number | null;
        remove?: false;
        rekey: true;
        rekeyAt: string | Date;
        rekeyAllowMissing: boolean;
      }
    | { remove: true; units?: never; rekey?: never; rekeyAt?: never }
  );

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

function validateChange(change: RatingChange): { route: number; at: string; appliedAt: string; shard: number } {
  if (
    !change ||
    !validId(change.voterId) ||
    !validId(change.questionId) ||
    !validId(change.populationId) ||
    !validId(change.targetId) ||
    !/^[0-9a-f]{64}$/.test(change.countingKey) ||
    !Number.isSafeInteger(change.revision) ||
    change.revision < 1 ||
    (change.rekey === true && typeof change.rekeyAllowMissing !== 'boolean') ||
    (!change.remove &&
      change.units !== null &&
      (!Number.isSafeInteger(change.units) || change.units < 0 || change.units > 20))
  )
    throw new TypeError('Invalid rating aggregate change');
  const route = routeOf(change.targetId)!;
  const keyByte = Number.parseInt(change.countingKey.slice(0, 2), 16);
  const at = normalizeInstant(change.at);
  return {
    route,
    at,
    appliedAt: change.rekey ? normalizeInstant(change.rekeyAt) : normalizeInstant(change.appliedAt ?? at),
    shard: keyByte % 16,
  };
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

async function applyComponentDelta(
  tx: Queryable,
  change: RatingChange,
  countingKey: string,
  before: CountedVote | null,
  after: CountedVote | null,
  scale: QuestionScale,
  at: string,
): Promise<ReturnType<typeof deltaFor>> {
  const keyByte = Number.parseInt(countingKey.slice(0, 2), 16);
  const delta = deltaFor(before, after, scale);
  const rows = await applyComponent.run(tx, {
    route: routeOf(change.targetId)!,
    question_id: change.questionId,
    population_id: change.populationId,
    target_id: change.targetId,
    shard: keyByte % 16,
    count_delta: delta.count.toString(),
    sum_delta: delta.sum.toString(),
    histogram_delta: delta.histogram.map(String),
    at,
  });
  if (!returnedRows(rows)) throw new Error('Rating aggregate component would be negative or incompatible');
  return delta;
}

async function applyPartition(
  pool: Pool,
  changes: readonly RatingChange[],
  partition: number,
  scales: ReadonlyMap<string, QuestionScale>,
): Promise<void> {
  try {
    await runCommand(pool, { partition }, async (tx, command) => {
      const totals = new PopulationTotalCapture();
      let applied = 0;
      let received = 0;
      let figurePosition: string | undefined;
      const markFigurePending = async (change: RatingChange, route: number): Promise<void> => {
        if (change.questionId !== STANDARD_QUESTION_ID) return;
        if (figurePosition === undefined) {
          const row = await readPublicFigurePosition.run(tx, { partition_no: partition });
          if (!row) throw new Error('Rating figure partition is unavailable');
          figurePosition = row.position;
        }
        if (figurePosition === undefined) throw new Error('Rating figure partition is unavailable');
        const rows = await markPublicFigurePending.run(tx, {
          route,
          question_id: change.questionId,
          population_id: change.populationId,
          subject_id: change.targetId,
          position: figurePosition,
        });
        if (!returnedRows(rows)) throw new Error('Rating public figure could not be marked pending');
      };
      for (const change of changes) {
        const { route, at, appliedAt, shard } = validateChange(change);
        const scale = scales.get(change.questionId);
        if (!scale) throw new Error('Rating question unavailable');
        const parameters = {
          route,
          question_id: change.questionId,
          population_id: change.populationId,
          target_id: change.targetId,
          counting_key: change.countingKey,
        };

        if (change.source) {
          if (
            !(await advanceRatingSource(
              tx,
              route,
              'aggregate',
              [change.voterId, change.questionId, change.populationId, change.targetId],
              change.source,
            ))
          )
            continue;
          received += 1;
        }

        if (change.rekey) {
          const existing = await readPopulationVoteForRekey.run(tx, {
            ...parameters,
            voter_id: change.voterId,
          });
          if (existing && Number(existing.revision) > change.revision) continue;
          const oldKey = existing?.countingKey ?? change.countingKey;
          const newBefore = await readCountedVote.run(tx, parameters);
          const oldBefore =
            oldKey === change.countingKey
              ? newBefore
              : await readCountedVote.run(tx, { ...parameters, counting_key: oldKey });
          const wroteVote = returnedRows(
            await rekeyPopulationVote.run(tx, {
              ...parameters,
              voter_id: change.voterId,
              units: change.units,
              at,
              revision: change.revision,
              allow_missing: change.rekeyAllowMissing,
            }),
          );
          if (!wroteVote) continue;
          const newAfter = await readCountedVote.run(tx, parameters);
          let oldTotalDelta: ReturnType<typeof deltaFor> | null = null;
          if (oldKey !== change.countingKey) {
            const oldAfter = await readCountedVote.run(tx, { ...parameters, counting_key: oldKey });
            oldTotalDelta = await applyComponentDelta(tx, change, oldKey, oldBefore, oldAfter, scale, appliedAt);
            applied += 1;
          }
          const newTotalDelta = await applyComponentDelta(
            tx,
            change,
            change.countingKey,
            newBefore,
            newAfter,
            scale,
            appliedAt,
          );
          totals.add(change, [
            ...(oldKey !== change.countingKey && oldTotalDelta ? [{ countingKey: oldKey, delta: oldTotalDelta }] : []),
            { countingKey: change.countingKey, delta: newTotalDelta },
          ]);
          await markFigurePending(change, route);
          applied += 1;
          continue;
        }

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
          at: appliedAt,
        });
        if (!returnedRows(rows)) throw new Error('Rating aggregate component would be negative or incompatible');
        totals.add(change, [{ countingKey: change.countingKey, delta }]);
        await markFigurePending(change, route);
        applied += 1;
      }
      if (applied === 0 && received === 0) throw new NoAggregateChange();
      return {
        value: undefined,
        events: [
          { type: AGGREGATE_APPLIED, data: { applied: Math.max(applied, received) } },
          ...(await totals.commit(tx)),
        ],
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
  // Question revisions/scales are immutable. Finish every anchored preparation before target checkout.
  const scales = new Map<string, QuestionScale>();
  for (const questionId of new Set(input.map((change) => change.questionId))) {
    const scale = await withReadTransaction(pool, async (client) => {
      const bound = await partitionReadClient(client, partitionOf(routeOf(questionId)!));
      return readQuestionScale.run(bound, { question_id: questionId });
    });
    if (!scale) throw new Error('Rating question unavailable');
    histogramSize(scale);
    scales.set(questionId, scale);
  }
  // A page has <=100 changes, <=100 destinations and <=200 counted shard deltas per destination.
  // Its aggregate event plus deliveries stays below the native 1000-event command cap.
  for (const [partition, changes] of grouped)
    for (let offset = 0; offset < changes.length; offset += 100)
      await applyPartition(pool, changes.slice(offset, offset + 100), partition, scales);
  // Also recover committed obligations on a vote replay: its old delta cannot be reconstructed.
  for (const [partition, changes] of grouped) {
    const populations = [...new Set(changes.map((change) => change.populationId))];
    for (let offset = 0; offset < populations.length; offset += 100)
      await flushPopulationTotalDeliveries(pool, partition, populations.slice(offset, offset + 100));
  }
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
    aggregateTargetId?: string;
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
    targetId: data.aggregateTargetId ?? data.targetId,
    units: data.units,
    revision: data.revision,
    at: event.time,
    source: ratingSourcePosition(event, data.voterId, data.revision),
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
  const data = event.data as
    | {
        voterId: string;
        direction: 'rekey';
        at: string;
        allowMissing: boolean;
        votes: Array<{
          questionId: string;
          targetId: string;
          countedTargetId?: string | null;
          units: number | null;
          revision: number;
          populations: string[];
          changedAt: string;
        }>;
      }
    | {
        voterId: string;
        direction: 'adding' | 'removing';
        erasurePageId?: string;
        votes: Array<{
          questionId: string;
          targetId: string;
          countedTargetId?: string | null;
          changedAt?: string;
          units: number | null;
          revision: number;
          populations: string[];
        }>;
      }
    | {
        voterId: string;
        realmId: string;
        direction: 'adding' | 'removing';
        votes: Array<{
          questionId: string;
          targetId: string;
          countedTargetId?: string | null;
          changedAt?: string;
          units: number | null;
          revision: number;
        }>;
      };
  if (data.votes.length === 0) return;
  if (data.direction === 'rekey') {
    const countingKey = await withConnection(pool, (client) => ratingCounter(client, data.voterId, data.at));
    const changes: RatingChange[] = data.votes.flatMap((vote) =>
      vote.countedTargetId === null
        ? []
        : vote.populations.map((populationId) => ({
            voterId: data.voterId,
            countingKey,
            questionId: vote.questionId,
            populationId,
            targetId: vote.countedTargetId ?? vote.targetId,
            units: vote.units,
            revision: vote.revision,
            at: vote.changedAt,
            rekey: true as const,
            rekeyAt: data.at,
            rekeyAllowMissing: data.allowMissing,
            source: ratingSourcePosition(event, data.voterId, vote.revision),
          })),
    );
    await applyRatingChanges(pool, changes);
    return;
  }
  const countingKey = await withConnection(pool, (client) => ratingCounter(client, data.voterId, event.time));
  const change = (
    vote: {
      questionId: string;
      targetId: string;
      countedTargetId?: string | null;
      changedAt?: string;
      units: number | null;
      revision: number;
    },
    populationId: string,
  ): RatingChange | null => {
    if (vote.countedTargetId === null) return null;
    return {
      voterId: data.voterId,
      countingKey,
      questionId: vote.questionId,
      populationId,
      targetId: vote.countedTargetId ?? vote.targetId,
      revision: vote.revision,
      at: vote.changedAt ?? event.time,
      appliedAt: event.time,
      source: ratingSourcePosition(event, data.voterId, vote.revision),
      ...(data.direction === 'removing' ? { remove: true as const } : { units: vote.units }),
    };
  };
  const changes: RatingChange[] =
    'realmId' in data
      ? data.votes.flatMap((vote) => {
          const next = change(vote, data.realmId);
          return next ? [next] : [];
        })
      : data.votes.flatMap((vote) =>
          vote.populations.flatMap((populationId) => {
            const next = change(vote, populationId);
            return next ? [next] : [];
          }),
        );
  await applyRatingChanges(pool, changes);
  if ('erasurePageId' in data && data.erasurePageId !== undefined)
    await acknowledgeRatingErasurePage(pool, data.voterId, data.erasurePageId);
}

/** Sum at most sixteen shards. A missing question returns null; a question without votes returns zero components. */
export async function readAggregate(
  client: Queryable,
  input: { questionId: string; populationId: string; targetId: string },
): Promise<RatingAggregate | null> {
  return readRatingAggregate(client, input);
}

/** Page population votes by voter id, with all their questions and no counting keys. */
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
