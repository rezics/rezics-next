import { afterAll, beforeAll, expect, test } from 'bun:test';
import { applyRatingChanges, type RatingChange } from '../../src/rating/aggregate-effect.ts';
import { drainPublicFigures, type PublicFigure } from '../../src/rating/public-figure.ts';
import { STANDARD_QUESTION_ID } from '../../src/rating/votes.ts';
import { newId, partitionOf, routeOf } from '../../src/route/route.ts';
import { openGrowthDatabase, type GrowthDatabase } from '../support/growth.ts';

const route = 0x4321;
const figureEvent = 'com.rezics.rating.public_figure.changed.v1';
const at = '2026-10-28T10:00:00.000Z';
let database: GrowthDatabase;

function votes(
  targetIds: readonly string[],
  count: number,
  units: number,
  ordinalStart: number,
  populationId: string,
): RatingChange[] {
  return Array.from({ length: count }, (_, index) => ({
    voterId: newId(0x4123),
    countingKey: (ordinalStart + index).toString(16).padStart(2, '0').padEnd(64, '0'),
    questionId: STANDARD_QUESTION_ID,
    populationId,
    targetId: targetIds[index % targetIds.length]!,
    units,
    revision: 1,
    at,
  }));
}

function removals(changes: readonly RatingChange[], selected: readonly number[]): RatingChange[] {
  return selected.map((index) => {
    const vote = changes[index]!;
    if (!('voterId' in vote) || !('countingKey' in vote) || !('targetId' in vote)) throw new Error('Bad fixture');
    return {
      voterId: vote.voterId,
      countingKey: vote.countingKey,
      questionId: vote.questionId,
      populationId: vote.populationId,
      targetId: vote.targetId,
      revision: 2,
      at,
      remove: true,
    };
  });
}

async function figureEvents(): Promise<PublicFigure[]> {
  const result = await database.admin.query<{ data: unknown }>(
    `SELECT data FROM core.outbox WHERE type = $1 ORDER BY partition_no, position, event_seq`,
    [figureEvent],
  );
  return result.rows.map(({ data }) => data as PublicFigure);
}

async function latestFigures(populationId: string): Promise<PublicFigure[]> {
  const latest = new Map<string, PublicFigure>();
  for (const figure of await figureEvents()) latest.set(`${figure.populationId}:${figure.subjectId}`, figure);
  return [...latest.values()].filter((figure) => figure.populationId === populationId);
}

async function drainPopulation(targetIds: readonly string[], limit = 500): Promise<{ drained: number; pages: number }> {
  let drained = 0;
  let pages = 0;
  const partition = partitionOf(routeOf(targetIds[0]!)!);
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const page = await drainPublicFigures(database.pool, partition, limit);
    expect(page).toBeLessThanOrEqual(limit);
    pages += 1;
    drained += page;
    if (page === 0) return { drained, pages };
  }
  throw new Error('Public figure work did not become idle');
}

beforeAll(async () => {
  database = await openGrowthDatabase();
});

afterAll(async () => {
  await database?.close();
});

test("a population's first prior epoch starts at 50 counted votes, freezes its mean, and every rated subject's score uses it", async () => {
  const populationId = newId(0x2123);
  const targets = Array.from({ length: 10 }, () => newId(route));
  await applyRatingChanges(database.pool, votes(targets, 50, 10, 1, populationId));
  await drainPopulation(targets);

  const figures = await latestFigures(populationId);
  expect(figures).toHaveLength(10);
  for (const figure of figures)
    expect(figure).toMatchObject({
      count: 5,
      mean: 5,
      score: 5,
      m: 5,
      C: 5,
      priorEpoch: 1,
    });
});

test('doubling or halving counted votes starts a new epoch and republishes every rated subject in bounded resumable pages', async () => {
  const populationId = newId(0x2123);
  const firstTargets = Array.from({ length: 50 }, () => newId(route));
  const first = votes(firstTargets, 50, 10, 100, populationId);
  await applyRatingChanges(database.pool, first);
  await drainPopulation(firstTargets);

  const secondTargets = Array.from({ length: 50 }, () => newId(route));
  const second = votes(secondTargets, 50, 20, 200, populationId);
  await applyRatingChanges(database.pool, second);
  const republish = await drainPopulation([...firstTargets, ...secondTargets], 10);
  expect(republish.pages).toBeGreaterThan(1);

  let figures = await latestFigures(populationId);
  expect(figures).toHaveLength(100);
  for (const targetId of firstTargets) {
    expect(figures.find(({ subjectId }) => subjectId === targetId)).toMatchObject({
      count: 1,
      score: null,
      m: 7.5,
      C: 5,
      priorEpoch: 2,
    });
  }
  for (const targetId of secondTargets)
    expect(figures.find(({ subjectId }) => subjectId === targetId)).toMatchObject({
      count: 1,
      score: null,
      m: 7.5,
      C: 5,
      priorEpoch: 2,
    });

  await applyRatingChanges(
    database.pool,
    removals(
      second,
      second.map((_, index) => index),
    ),
  );
  await drainPopulation([...firstTargets, ...secondTargets], 10);

  figures = await latestFigures(populationId);
  for (const targetId of firstTargets)
    expect(figures.find(({ subjectId }) => subjectId === targetId)).toMatchObject({
      count: 1,
      score: null,
      m: 5,
      C: 5,
      priorEpoch: 3,
    });
  for (const targetId of secondTargets)
    expect(figures.find(({ subjectId }) => subjectId === targetId)).toMatchObject({
      count: 0,
      score: null,
      m: 5,
      C: 5,
      priorEpoch: 3,
    });

  const events = await figureEvents();
  expect(events.filter(({ subjectId }) => firstTargets.includes(subjectId))).toHaveLength(150);
});

test('falling below 50 counted votes ends the epoch and clears every score of that population', async () => {
  const populationId = newId(0x2123);
  const targets = Array.from({ length: 10 }, () => newId(route));
  const counted = votes(targets, 50, 10, 300, populationId);
  await applyRatingChanges(database.pool, counted);
  await drainPopulation(targets);
  expect((await latestFigures(populationId)).every(({ score }) => score === 5)).toBe(true);

  await applyRatingChanges(database.pool, removals(counted, [0]));
  await drainPopulation(targets);

  const figures = await latestFigures(populationId);
  expect(figures).toHaveLength(10);
  for (const figure of figures) expect(figure).toMatchObject({ score: null, m: null, C: null, priorEpoch: null });
  expect(figures.find(({ count }) => count === 4)).toMatchObject({ mean: null, score: null });
});
