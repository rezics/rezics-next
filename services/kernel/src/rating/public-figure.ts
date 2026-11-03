import type { Pool, PoolClient } from 'pg';
import { defineQuery } from 'reylo';
import { Value } from 'typebox/value';
import { runCommand } from '../command/command.ts';
import type { Effect } from '../events/effects.ts';
import type { CloudEvent } from '../events/log.ts';
import { partitionOf, routeOf } from '../route/route.ts';
import { readPartition } from '../partition/partition.ts';
import { withReadTransaction } from '../semantic/read.ts';
import { RATING_EVENTS } from './events.ts';
import drainPublicFiguresSql from './public-figure-drain.sql';
import readFigureInputPage from './public-figure-input-page.sql';
import readPriorInput from './population-prior-input-read.sql';
import writeSubjectPriorInputs from './public-figure-prior-input-upsert.sql';
import readPendingPriorGroup from './public-figure-prior-pending-group.sql';
import readPendingPriorSubjects from './public-figure-prior-pending-subjects.sql';
import pagePublicFiguresSql from './public-figures-page.sql';
import readPublicFiguresSql from './public-figures-read.sql';
import readPendingFigure from './public-figure-pending-read.sql';
import lockPriorEpochTotals from './population-prior-epoch-totals-lock.sql';
import readPriorEpoch from './population-prior-epoch-read.sql';
import readPriorQuestion from './question-read.sql';
import { partitionReadClient } from '../database/read-snapshot.ts';
import { ratingQuestionIdentity } from './question-directory.ts';
import writePriorEpoch from './population-prior-epoch-upsert.sql';
import enqueuePriorRepublish from './population-prior-republish-enqueue.sql';
import readNextPriorRepublish from './population-prior-republish-next.sql';
import readPriorRepublishPage from './population-prior-republish-page.sql';
import advancePriorRepublish from './population-prior-republish-checkpoint.sql';
import deletePriorRepublish from './population-prior-republish-delete.sql';
import readPendingEpochPopulations from './population-total-epoch-pending.sql';
import publicFigurePosition from './public-figure-next-position.sql';
import markPriorRepublishPage from './public-figure-republish-mark-page.sql';
import { flushPopulationTotalDeliveries, readPopulationTotalClock } from './population-total.ts';
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

export type Queryable = Pick<Pool | PoolClient, 'query'>;

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
  questionIdentity: string | null;
  epoch: number;
  generation: string;
  startCount: string | null;
  m: string | null;
  C: string | null;
};
type FigureInputKey = { questionId: string; populationId: string; subjectId: string };
export type SubjectPriorInput = {
  question_identity?: string | null;
  population_route: number;
  question_id: string;
  population_id: string;
  generation: string;
  epoch: number | null;
  status: 'absent' | 'inactive' | 'active';
  m: string | null;
  c: string | null;
};

/** Finish each source snapshot before checking out any subject command connection. */
export async function capturePublicFigurePriorInputs(
  pool: Pool,
  keys: readonly PendingPopulation[],
): Promise<SubjectPriorInput[]> {
  if (keys.length > MAX_DRAIN_LIMIT) throw new RangeError('Rating prior input page exceeds 500 keys');
  const distinct = new Map(keys.map((key) => [`${key.questionId}/${key.populationId}`, key]));
  const inputs: SubjectPriorInput[] = [];
  for (const key of distinct.values()) {
    const route = routeOf(key.populationId);
    if (route === null || routeOf(key.questionId) === null) throw new TypeError('Invalid rating prior input address');
    const prior = await withReadTransaction(pool, async (tx) => {
      const home = await readPartition(tx, partitionOf(route));
      if (!home || home.writeState === 'moved') throw new Error('Rating prior input partition is unavailable');
      return readPriorInput.run(tx, { route, question_id: key.questionId, population_id: key.populationId });
    });
    inputs.push({
      population_route: route,
      question_id: key.questionId,
      population_id: key.populationId,
      generation: prior?.generation ?? '0',
      question_identity: prior?.questionIdentity ?? null,
      epoch: prior?.epoch ?? null,
      status: prior == null ? 'absent' : prior.startCount === null ? 'inactive' : 'active',
      m: prior?.m ?? null,
      c: prior?.C ?? null,
    });
  }
  return inputs;
}

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
  // Current question authority is observed at its home before the population command.
  const question = await withReadTransaction(pool, async (client) => {
    const bound = await partitionReadClient(client, partitionOf(routeOf(population.questionId)!));
    return readPriorQuestion.run(bound, { question_id: population.questionId });
  });
  if (!question) throw new Error('Rating question unavailable while starting a prior epoch');
  const identity = ratingQuestionIdentity(question);
  const threshold = question.grain === 'work' || question.grain === 'release' ? 5 : 10;
  try {
    await runCommand(pool, { partition }, async (tx) => {
      const [totals] = await lockPriorEpochTotals.run(tx, {
        route: populationRoute,
        question_id: population.questionId,
        population_id: population.populationId,
      });
      if (!totals || Number(totals.cleared) === 0) throw new NoPriorEpochCheck();

      const previous = (await readPriorEpoch.run(tx, {
        route: populationRoute,
        question_id: population.questionId,
        population_id: population.populationId,
      })) as PriorEpochRow | undefined;
      // A changed measurement requires a new question ID, never a prior over the old votes.
      if (previous?.questionIdentity != null && previous.questionIdentity !== identity)
        return {
          value: undefined,
          events: [
            priorEpochWorkEvent('check', population.questionId, population.populationId, previous.generation, 0),
          ],
        };
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
        if (totals.mean === null) throw new Error('Rating population prior mean is unavailable');
        epoch += 1;
        generation += 1n;
        startCount = count;
        mean = Number(totals.mean);
        C = threshold;
        changed = true;
      } else if (active && (count >= startCount! * 2n || count * 2n <= startCount!)) {
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
          question_identity: identity,
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
      limit: PRIOR_EPOCH_CHECK_BATCH,
    })) as PendingPopulation[];
    if (populations.length === 0) return;
    await Promise.all(populations.map((population) => checkPopulationPriorEpoch(pool, population)));
  }
}

/** Resume retained custom totals through the existing durable epoch/republish work. */
export async function resumeRealmRankPublication(pool: Pool): Promise<void> {
  await drainPendingPriorEpochChecks(pool);
  await markPriorEpochRepublishPage(pool, MAX_DRAIN_LIMIT);
}

async function markPriorEpochRepublishPage(pool: Pool, limit: number): Promise<void> {
  const job = (await readNextPriorRepublish.run(pool, {})) as PriorRepublishJob | undefined;
  if (!job) return;
  const populationRoute = routeOf(job.populationId);
  if (populationRoute === null || populationRoute !== job.route || routeOf(job.questionId) === null)
    throw new Error('Invalid durable rating prior republish job');

  const priorInputs = await capturePublicFigurePriorInputs(pool, [job]);
  const captured = priorInputs[0]!;
  // A stale job cannot lend its generation to a different captured value. A newer job remains durable.
  if (BigInt(captured.generation) < BigInt(job.generation)) return;

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
    [...groups].map(([partition, subjectIds]) =>
      markPublicFigurePriorPage(pool, { partition, subjectIds, prior: captured, requiredGeneration: job.generation }),
    ),
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

/** Internal subject-home command for a captured republish page, also safe to redeliver after an epoch change. */
export async function markPublicFigurePriorPage(
  pool: Pool,
  input: {
    partition: number;
    subjectIds: readonly string[];
    prior: SubjectPriorInput;
    requiredGeneration: string;
  },
): Promise<void> {
  validateAddress({
    partition: input.partition,
    questionId: input.prior.question_id,
    populationId: input.prior.population_id,
  });
  if (
    input.subjectIds.length > MAX_DRAIN_LIMIT ||
    input.prior.population_route !== routeOf(input.prior.population_id) ||
    input.subjectIds.some((id) => routeOf(id) === null || partitionOf(routeOf(id)!) !== input.partition)
  )
    throw new TypeError('Invalid rating prior subject page');
  if (input.subjectIds.length === 0 || BigInt(input.prior.generation) < BigInt(input.requiredGeneration)) return;
  await runCommand(pool, { partition: input.partition }, async (tx) => {
    await writeSubjectPriorInputs.run(tx, { partition_no: input.partition, inputs: [input.prior] });
    const position = await publicFigurePosition.run(tx, { partition_no: input.partition });
    if (!position) throw new Error('Rating figure partition is unavailable');
    await markPriorRepublishPage.run(tx, {
      partition_no: input.partition,
      question_id: input.prior.question_id,
      population_id: input.prior.population_id,
      subject_ids: [...input.subjectIds],
      position: position.position,
      generation: input.requiredGeneration,
    });
    return {
      value: undefined,
      events: [
        priorEpochWorkEvent(
          'mark',
          input.prior.question_id,
          input.prior.population_id,
          input.prior.generation,
          input.subjectIds.length,
        ),
      ],
    };
  });
}

async function drainFigurePage(
  pool: Pool,
  partition: number,
  limit: number,
  filter?: { questionId: string; populationId: string; subjectIds: readonly string[] },
): Promise<number> {
  const prepared = await withReadTransaction(pool, async (tx) => {
    const home = await readPartition(tx, partition);
    if (!home || home.writeState === 'moved') throw new Error('Rating figure partition is unavailable');
    const clock = await readPopulationTotalClock(tx, partition);
    if (clock.pending !== '0') return { clock, keys: [] as FigureInputKey[] };
    const keys = filter
      ? (
          await tx.query<FigureInputKey>(
            `SELECT figure.subject_id::text AS "subjectId",figure.question_id::text AS "questionId",
                  figure.population_id::text AS "populationId"
           FROM unnest($1::uuid[]) AS key(subject_id)
           JOIN rating.public_figure AS figure
             ON figure.route=get_byte(uuid_send(key.subject_id),10)*256+get_byte(uuid_send(key.subject_id),11)
            AND figure.subject_id=key.subject_id AND figure.question_id=$2 AND figure.population_id=$3
           WHERE figure.partition_no=$4 AND figure.pending_position IS NOT NULL
           ORDER BY figure.route,figure.question_id,figure.population_id,figure.subject_id LIMIT $5`,
            [filter.subjectIds, filter.questionId, filter.populationId, partition, limit],
          )
        ).rows
      : ((await readFigureInputPage.run(tx, {
          partition_no: partition,
          limit,
          subject_ids: null,
          question_id: null,
          population_id: null,
        })) as FigureInputKey[]);
    return { clock, keys };
  });
  const { keys, clock } = prepared;
  if (keys.length === 0) return 0;
  // Checks occur after the no-outstanding-delivery observation, before foreign prior capture.
  await drainPendingPriorEpochChecks(pool);
  const priorInputs = await capturePublicFigurePriorInputs(pool, keys);
  try {
    const outcome = await runCommand(pool, { partition }, async (tx) => {
      const current = await readPopulationTotalClock(tx, partition);
      if (current.pending !== '0' || current.generation !== clock.generation) throw new NoPendingFigures();
      await writeSubjectPriorInputs.run(tx, { partition_no: partition, inputs: priorInputs });
      const rows = (await drainPublicFiguresSql.run(tx, {
        partition_no: partition,
        subject_ids: keys.map((key) => key.subjectId),
        question_ids: keys.map((key) => key.questionId),
        population_ids: keys.map((key) => key.populationId),
      })) as PublicFigureRow[];
      if (rows.length === 0) throw new NoPendingFigures();
      const figures = rows.map(figureFromRow);
      return {
        value: figures.length,
        events: figures.map((figure) =>
          figure.questionId === STANDARD_QUESTION_ID
            ? { type: FIGURE_CHANGED, subject: figure.subjectId, data: figure }
            : {
                type: 'com.rezics.rating.realm_rank.changed.v1',
                subject: figure.subjectId,
                data: {
                  questionId: figure.questionId,
                  populationId: figure.populationId,
                  subjectId: figure.subjectId,
                  revision: figure.revision,
                },
              },
        ),
      };
    });
    return outcome.value;
  } catch (error) {
    if (error instanceof NoPendingFigures) return 0;
    throw error;
  }
}

/** Exact native erasure obligation; unrelated figure pages never extend this call. */
export async function drainErasedFigureTargets(
  pool: Pool,
  input: { partition: number; questionId: string; populationId: string; subjectIds: readonly string[] },
): Promise<boolean> {
  validateAddress(input);
  if (
    input.subjectIds.length > 100 ||
    input.subjectIds.some((id) => routeOf(id) === null || partitionOf(routeOf(id)!) !== input.partition)
  )
    throw new TypeError('Invalid rating erasure figure page');
  if (input.subjectIds.length === 0) return true;
  await drainFigurePage(pool, input.partition, input.subjectIds.length, input);
  return withReadTransaction(pool, async (tx) => {
    const home = await readPartition(tx, input.partition);
    if (!home || home.writeState === 'moved') throw new Error('Rating figure partition is unavailable');
    const result = await tx.query<{ pending: boolean }>(
      `SELECT EXISTS (
         SELECT 1 FROM unnest($1::uuid[]) AS key(subject_id)
         JOIN rating.public_figure AS figure
           ON figure.route=get_byte(uuid_send(key.subject_id),10)*256+get_byte(uuid_send(key.subject_id),11)
          AND figure.subject_id=key.subject_id AND figure.question_id=$2 AND figure.population_id=$3
         WHERE figure.pending_position IS NOT NULL
       ) AS pending`,
      [input.subjectIds, input.questionId, input.populationId],
    );
    return !result.rows[0]!.pending;
  });
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

/** Compute consumer readiness from the published count, never from pending votes or shard totals. */
export function publicFigureState(
  figure: Pick<PublicFigure, 'count'> | null,
  grain: string,
  pending: boolean,
): 'ready' | 'insufficient_data' | 'updating' {
  let threshold: number;
  switch (grain) {
    case 'work':
    case 'release':
      threshold = 5;
      break;
    case 'episode':
    case 'character':
      threshold = 10;
      break;
    default:
      throw new TypeError('Unknown rating question grain');
  }
  if ((figure?.count ?? 0) >= threshold) return 'ready';
  return pending ? 'updating' : 'insufficient_data';
}

/** Point-read the pending mark, including an unpublished row; no vote or aggregate data is read. */
export async function readPublicFigurePending(
  client: Queryable,
  input: { questionId: string; populationId: string; subjectId: string },
): Promise<boolean> {
  const route = routeOf(input.subjectId);
  if (route === null || !validId(input.questionId) || !validId(input.populationId))
    throw new TypeError('Invalid public rating figure address');
  const row = await readPendingFigure.run(client, {
    route,
    question_id: input.questionId,
    population_id: input.populationId,
    subject_id: input.subjectId,
  });
  return row?.pending ?? false;
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

  await flushPopulationTotalDeliveries(pool, partition);
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
      await flushPopulationTotalDeliveries(pool, partition);
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
