import type { Pool, PoolClient } from 'pg';
import { defineQuery } from 'reylo';
import { Value } from 'typebox/value';
import { runCommand } from '../command/command.ts';
import type { Effect } from '../events/effects.ts';
import type { CloudEvent } from '../events/log.ts';
import { partitionOf, routeOf } from '../route/route.ts';
import { RATING_EVENTS } from './events.ts';
import drainPublicFiguresSql from './public-figure-drain.sql';
import readPendingPriorGroup from './public-figure-prior-pending-group.sql';
import readPendingPriorSubjects from './public-figure-prior-pending-subjects.sql';
import pagePublicFiguresSql from './public-figures-page.sql';
import readPublicFiguresSql from './public-figures-read.sql';
import lockPriorEpochTotals from './population-prior-epoch-totals-lock.sql';
import readPriorEpoch from './population-prior-epoch-read.sql';
import readPriorGrain from './population-prior-grain-read.sql';
import writePriorEpoch from './population-prior-epoch-upsert.sql';
import enqueuePriorRepublish from './population-prior-republish-enqueue.sql';
import readNextPriorRepublish from './population-prior-republish-next.sql';
import readPriorRepublishPage from './population-prior-republish-page.sql';
import advancePriorRepublish from './population-prior-republish-checkpoint.sql';
import deletePriorRepublish from './population-prior-republish-delete.sql';
import readPendingEpochPopulations from './population-total-epoch-pending.sql';
import publicFigurePosition from './public-figure-next-position.sql';
import markPriorRepublishPage from './public-figure-republish-mark-page.sql';
import { STANDARD_QUESTION_ID } from './votes.ts';

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
const PRIOR_EPOCH_WORK = 'com.rezics.rating.prior_epoch.work.v1';
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
class NoPriorEpochCheck extends Error {}
class NoPriorRepublishAdvance extends Error {}

function returnedRows(value: unknown): boolean {
  if (Array.isArray(value)) return value.length > 0;
  return value !== null && value !== undefined;
}

type PendingPopulation = { questionId: string; populationId: string };
type PriorEpochRow = {
  epoch: number;
  generation: string;
  startCount: string | null;
  m: string | null;
  C: string | null;
};
type PriorRepublishJob = {
  route: number;
  questionId: string;
  populationId: string;
  generation: string;
  afterSubjectId: string | null;
};
type PriorRepublishSubject = { subjectId: string; route: number };
type PendingPriorGroup = { questionId: string; populationId: string };
type PendingPriorSubject = { partition: number; subjectId: string };

const ZERO_SUBJECT = '00000000-0000-0000-0000-000000000000';
const PRIOR_EPOCH_CHECK_BATCH = 100;

function priorEpochWorkEvent(
  action: 'check' | 'mark' | 'advance',
  questionId: string,
  populationId: string,
  generation: string,
  subjects: number,
) {
  return {
    type: PRIOR_EPOCH_WORK,
    data: { action, questionId, populationId, generation, subjects },
  };
}

async function checkPopulationPriorEpoch(pool: Pool, population: PendingPopulation): Promise<void> {
  const populationRoute = routeOf(population.populationId);
  if (populationRoute === null || routeOf(population.questionId) === null)
    throw new TypeError('Invalid rating prior epoch address');
  const partition = partitionOf(populationRoute);
  try {
    await runCommand(pool, { partition }, async (tx) => {
      const totals = (await lockPriorEpochTotals.run(tx, {
        route: populationRoute,
        question_id: population.questionId,
        population_id: population.populationId,
      })) as { count: string; sum: string; mean: string | null; cleared: string } | undefined;
      if (!totals || Number(totals.cleared) === 0) throw new NoPriorEpochCheck();

      const previous = (await readPriorEpoch.run(tx, {
        route: populationRoute,
        question_id: population.questionId,
        population_id: population.populationId,
      })) as PriorEpochRow | undefined;
      const count = BigInt(totals.count);
      let epoch = previous?.epoch ?? 0;
      let generation = BigInt(previous?.generation ?? '0');
      let startCount =
        previous?.startCount === null || previous?.startCount === undefined ? null : BigInt(previous.startCount);
      let mean = previous?.m === null || previous?.m === undefined ? null : Number(previous.m);
      let C = previous?.C === null || previous?.C === undefined ? null : Number(previous.C);
      const active = startCount !== null;
      let changed = false;

      if (count < 50n && active) {
        startCount = null;
        mean = null;
        C = null;
        generation += 1n;
        changed = true;
      } else if (count >= 50n && !active) {
        const grain = (await readPriorGrain.run(tx, { question_id: population.questionId })) as
          | { grain: string }
          | undefined;
        if (!grain) throw new Error('Rating question unavailable while starting a prior epoch');
        const threshold = grain.grain === 'work' || grain.grain === 'release' ? 5 : 10;
        if (totals.mean === null) throw new Error('Rating population prior mean is unavailable');
        epoch += 1;
        generation += 1n;
        startCount = count;
        mean = Number(totals.mean);
        C = threshold;
        changed = true;
      } else if (active && (count >= startCount! * 2n || count * 2n <= startCount!)) {
        const grain = (await readPriorGrain.run(tx, { question_id: population.questionId })) as
          | { grain: string }
          | undefined;
        if (!grain) throw new Error('Rating question unavailable while starting a prior epoch');
        const threshold = grain.grain === 'work' || grain.grain === 'release' ? 5 : 10;
        if (totals.mean === null) throw new Error('Rating population prior mean is unavailable');
        epoch += 1;
        generation += 1n;
        startCount = count;
        mean = Number(totals.mean);
        C = threshold;
        changed = true;
      }

      if (changed) {
        await writePriorEpoch.run(tx, {
          route: populationRoute,
          question_id: population.questionId,
          population_id: population.populationId,
          epoch,
          generation: generation.toString(),
          start_count: startCount?.toString() ?? null,
          m: mean?.toString() ?? null,
          c: C,
        });
        const queued = await enqueuePriorRepublish.run(tx, {
          route: populationRoute,
          question_id: population.questionId,
          population_id: population.populationId,
          generation: generation.toString(),
        });
        if (!returnedRows(queued)) throw new Error('Rating prior epoch republish could not be queued');
      }

      return {
        value: undefined,
        events: [
          priorEpochWorkEvent('check', population.questionId, population.populationId, generation.toString(), 0),
        ],
      };
    });
  } catch (error) {
    if (!(error instanceof NoPriorEpochCheck)) throw error;
  }
}

async function drainPendingPriorEpochChecks(pool: Pool): Promise<void> {
  for (;;) {
    const populations = (await readPendingEpochPopulations.run(pool, {
      question_id: STANDARD_QUESTION_ID,
      limit: PRIOR_EPOCH_CHECK_BATCH,
    })) as PendingPopulation[];
    if (populations.length === 0) return;
    await Promise.all(populations.map((population) => checkPopulationPriorEpoch(pool, population)));
  }
}

async function markPriorEpochRepublishPage(pool: Pool, limit: number): Promise<void> {
  const job = (await readNextPriorRepublish.run(pool, {})) as PriorRepublishJob | undefined;
  if (!job) return;
  const populationRoute = routeOf(job.populationId);
  if (populationRoute === null || populationRoute !== job.route || routeOf(job.questionId) === null)
    throw new Error('Invalid durable rating prior republish job');

  const candidates = (await readPriorRepublishPage.run(pool, {
    question_id: job.questionId,
    population_id: job.populationId,
    after_subject_id: job.afterSubjectId ?? ZERO_SUBJECT,
    limit,
  })) as PriorRepublishSubject[];
  const page = candidates.slice(0, limit);
  const groups = new Map<number, string[]>();
  for (const subject of page) {
    const partition = partitionOf(subject.route);
    const subjectIds = groups.get(partition) ?? [];
    subjectIds.push(subject.subjectId);
    groups.set(partition, subjectIds);
  }

  await Promise.all(
    [...groups].map(async ([partition, subjectIds]) => {
      await runCommand(pool, { partition }, async (tx) => {
        const position = await publicFigurePosition.run(tx, { partition_no: partition });
        if (!position) throw new Error('Rating figure partition is unavailable');
        await markPriorRepublishPage.run(tx, {
          question_id: job.questionId,
          population_id: job.populationId,
          subject_ids: subjectIds,
          position: position.position,
          generation: job.generation,
        });
        return {
          value: subjectIds.length,
          events: [priorEpochWorkEvent('mark', job.questionId, job.populationId, job.generation, subjectIds.length)],
        };
      });
    }),
  );

  const hasMore = candidates.length > limit;
  const afterSubjectId = page.at(-1)?.subjectId ?? null;
  try {
    await runCommand(pool, { partition: partitionOf(populationRoute) }, async (tx) => {
      const rows =
        hasMore && afterSubjectId !== null
          ? await advancePriorRepublish.run(tx, {
              route: populationRoute,
              question_id: job.questionId,
              population_id: job.populationId,
              generation: job.generation,
              after_subject_id: afterSubjectId,
              expected_after_subject_id: job.afterSubjectId,
            })
          : await deletePriorRepublish.run(tx, {
              route: populationRoute,
              question_id: job.questionId,
              population_id: job.populationId,
              generation: job.generation,
              expected_after_subject_id: job.afterSubjectId,
            });
      if (!returnedRows(rows)) throw new NoPriorRepublishAdvance();
      return {
        value: undefined,
        events: [priorEpochWorkEvent('advance', job.questionId, job.populationId, job.generation, page.length)],
      };
    });
  } catch (error) {
    if (!(error instanceof NoPriorRepublishAdvance)) throw error;
  }
}

async function drainFigurePage(
  pool: Pool,
  partition: number,
  limit: number,
  filter?: { questionId: string; populationId: string; subjectIds: readonly string[] },
): Promise<number> {
  try {
    const outcome = await runCommand(pool, { partition }, async (tx) => {
      const rows = (await drainPublicFiguresSql.run(tx, {
        partition_no: partition,
        limit,
        subject_ids: filter ? [...filter.subjectIds] : null,
        question_id: filter?.questionId ?? null,
        population_id: filter?.populationId ?? null,
      })) as PublicFigureRow[];
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

async function drainPriorEpochPendingFigures(
  pool: Pool,
  limit: number,
  filter?: { questionId?: string; populationId?: string; partition?: number },
): Promise<number> {
  const group =
    filter?.questionId !== undefined && filter.populationId !== undefined
      ? { questionId: filter.questionId, populationId: filter.populationId }
      : ((await readPendingPriorGroup.run(pool, { partition_no: filter?.partition ?? null })) as
          | PendingPriorGroup
          | undefined);
  if (!group) return 0;
  const subjects = (await readPendingPriorSubjects.run(pool, {
    question_id: group.questionId,
    population_id: group.populationId,
    partition_no: filter?.partition ?? null,
    limit,
  })) as PendingPriorSubject[];
  const groups = new Map<number, string[]>();
  for (const subject of subjects) {
    const subjectIds = groups.get(subject.partition) ?? [];
    subjectIds.push(subject.subjectId);
    groups.set(subject.partition, subjectIds);
  }
  const results = await Promise.all(
    [...groups].map(([partition, subjectIds]) =>
      drainFigurePage(pool, partition, subjectIds.length, {
        questionId: group.questionId,
        populationId: group.populationId,
        subjectIds,
      }),
    ),
  );
  return results.reduce((sum, count) => sum + count, 0);
}

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

  await drainPendingPriorEpochChecks(pool);
  let priorFigures = await drainPriorEpochPendingFigures(pool, limit, { partition });
  if (priorFigures === 0) {
    await markPriorEpochRepublishPage(pool, limit);
    priorFigures = await drainPriorEpochPendingFigures(pool, limit, { partition });
  }
  const remaining = limit - priorFigures;
  const figures = remaining > 0 ? await drainFigurePage(pool, partition, remaining) : 0;
  return priorFigures + figures;
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
    types: [AGGREGATE_APPLIED, PRIOR_EPOCH_WORK],
    async run(event) {
      const partition = eventPartition(event);
      if (event.type === PRIOR_EPOCH_WORK) {
        if (!Value.Check(RATING_EVENTS[PRIOR_EPOCH_WORK], event.data))
          throw new TypeError('Invalid rating prior epoch work event');
        const data = event.data as {
          action: 'check' | 'mark' | 'advance';
          questionId: string;
          populationId: string;
        };
        if (data.action === 'mark') {
          while (
            (await drainPriorEpochPendingFigures(pool, MAX_DRAIN_LIMIT, {
              questionId: data.questionId,
              populationId: data.populationId,
              partition,
            })) === MAX_DRAIN_LIMIT
          ) {
            // A full page has a successor; each next page commits independently under the partition gate.
          }
          return;
        }
        await markPriorEpochRepublishPage(pool, MAX_DRAIN_LIMIT);
        return;
      }

      if (event.type !== AGGREGATE_APPLIED || !Value.Check(RATING_EVENTS[AGGREGATE_APPLIED], event.data))
        throw new TypeError('Invalid rating aggregate applied event');
      while ((await drainPublicFigures(pool, partition)) === MAX_DRAIN_LIMIT) {
        // A full page has a successor; durable prior-epoch work events drive pages on other partitions.
      }
    },
  };
}
