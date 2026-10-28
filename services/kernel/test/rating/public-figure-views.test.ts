import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from 'bun:test';
import type { PoolClient } from 'pg';
import { readPublicFigureViews } from '../../src/rating/public-figure-http.ts';
import { measure } from '../support/growth.ts';
import { createFigureFixture, type FigureFixture } from './support/figure-fixture.ts';
import { partitionOf, routeOf } from '../../src/route/route.ts';
import { restartWorker, worker } from '../community/community-driver.ts';

let fixture: FigureFixture;
let workerPaused = false;
beforeAll(async () => {
  fixture = await createFigureFixture({ subjects: 256, partitions: 3 });
}, 180_000);
// Bun owns subprocesses per test. Pause the shared native worker explicitly at that boundary,
// then resume its durable workflows for the next scenario instead of leaving a dangling child.
beforeEach(async () => {
  if (workerPaused) {
    await restartWorker();
    workerPaused = false;
  }
}, 90_000);
afterEach(async () => {
  await worker.stop();
  workerPaused = true;
}, 90_000);
afterAll(async () => {
  await fixture?.close();
});

async function snapshot<T>(read: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await fixture.database.pool.connect();
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    return await read(client);
  } finally {
    await client.query('ROLLBACK');
    client.release();
  }
}

// Synchronize at the same publication boundary used by the route's native worker test.
// This trigger only waits; it neither supplies nor changes any product data.
async function holdPublication(subjectId: string) {
  await fixture.database.admin
    .query(`CREATE OR REPLACE FUNCTION public.hold_view_publication() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      PERFORM pg_advisory_xact_lock(hashtext(NEW.subject_id::text), 95);
      RETURN NEW;
    END $$;
    CREATE OR REPLACE TRIGGER hold_view_publication BEFORE UPDATE ON rating.public_figure
    FOR EACH ROW WHEN (OLD.pending_position IS NOT NULL AND NEW.pending_position IS NULL)
    EXECUTE FUNCTION public.hold_view_publication()`);
  const lock = await fixture.database.admin.connect();
  await lock.query('BEGIN');
  await lock.query('SELECT pg_advisory_xact_lock(hashtext($1), 95)', [subjectId]);
  return async () => {
    await lock.query('ROLLBACK');
    lock.release();
  };
}

test('batched figure views answer every requested subject across partitions exactly as the subject figure route does', async () => {
  const [ready, pending, insufficient, absent] = fixture.subjectIds as [string, string, string, string, ...string[]];
  expect(new Set([ready, pending, insufficient].map((id) => partitionOf(routeOf(id)!))).size).toBe(3);
  // Fifty counted Global votes activate the native prior epoch, spread over real subjects and voters.
  for (const subject of [ready, ...fixture.subjectIds.slice(10, 19)])
    for (const voter of fixture.globalVoters) await fixture.vote(subject, voter, 16);
  await fixture.drain();
  const published = await fixture.published(ready, 5);
  expect(published.priorEpoch).not.toBeNull();
  await fixture.vote(insufficient, fixture.globalVoters[0]!, 4);
  await fixture.published(insufficient, 1);
  const release = await holdPublication(pending);
  try {
    await fixture.vote(pending, fixture.globalVoters[0]!, 20);
    const deadline = Date.now() + 60_000;
    while ((await fixture.figure(pending)).figure.state !== 'updating') {
      if (Date.now() > deadline) throw new Error('Native worker did not mark unpublished figure pending');
      await Bun.sleep(20);
    }
    const ids = [ready, pending, insufficient, absent];
    const views = await snapshot((client) => readPublicFigureViews(client, [...ids, ready]));
    expect(views?.size).toBe(ids.length);
    for (const id of ids) {
      const response = await fixture.figure(id);
      expect(views!.get(id)?.figure).toEqual(response.figure);
      expect(`"${views!.get(id)?.revision}"`).toBe(response.etag);
    }
    expect(views!.get(ready)?.figure).toMatchObject({ count: 5, state: 'ready', mean: 8 });
    expect(views!.get(ready)?.figure.score).not.toBeNull();
    expect(views!.get(pending)).toMatchObject({
      revision: '0',
      figure: { count: 0, state: 'updating', mean: null, score: null },
    });
    expect(views!.get(insufficient)?.figure).toMatchObject({
      count: 1,
      state: 'insufficient_data',
      mean: null,
      score: null,
    });
    expect(views!.get(absent)).toMatchObject({
      revision: '0',
      figure: { count: 0, state: 'insufficient_data', mean: null, score: null },
    });
  } finally {
    await release();
  }
  await fixture.published(pending, 1);

  const empty = await snapshot((client) => measure(fixture.database, () => readPublicFigureViews(client, [])));
  expect(empty.value?.size).toBe(0);
  expect(empty.cost.statements).toBe(0);
  for (const ids of [['invalid'], [ready.toUpperCase()], Array(257).fill(ready)])
    await expect(snapshot((client) => readPublicFigureViews(client, ids))).rejects.toBeInstanceOf(TypeError);
}, 180_000);

test('batched figure views use two statements for 1, 64 and 256 subjects across partitions', async () => {
  // Give every measured key a native figure, including the largest batch.
  for (const id of fixture.subjectIds) await fixture.vote(id, fixture.globalVoters[1]!, 12);
  await fixture.drain();
  for (const size of [1, 64, 256]) {
    const ids = fixture.subjectIds.slice(0, size);
    const measured = await snapshot((client) => measure(fixture.database, () => readPublicFigureViews(client, ids)));
    expect(measured.value?.size).toBe(size);
    expect(measured.cost.statements).toBe(2);
    expect(measured.cost.controlStatements).toBe(0);
    const figures = Object.entries(measured.cost.relations).filter(([name]) => name.endsWith('public_figure'));
    expect(figures.length).toBeGreaterThan(0);
    expect(figures.reduce((sum, [, cost]) => sum + cost.rows, 0)).toBeLessThanOrEqual(size);
    for (const [, cost] of figures) expect(cost.sequentialScans).toBe(0);
  }
}, 180_000);

test('a private Realm voting at the extreme changes no batched figure view', async () => {
  await fixture.joinMembers();
  const ids = fixture.subjectIds.slice(0, 4);
  for (const id of ids) {
    for (const voter of fixture.globalVoters) await fixture.vote(id, voter, 0);
    for (const voter of fixture.realmMembers) await fixture.vote(id, voter, 20);
  }
  await fixture.drain();
  const baseline = await snapshot((client) => readPublicFigureViews(client, ids));
  const responses = await Promise.all(ids.map((id) => fixture.figure(id)));
  // Swap equal populations' extremes. The Global publication stays fixed; only the Realm mean changes.
  for (const id of ids) {
    for (const voter of fixture.realmMembers) await fixture.vote(id, voter, 0);
    for (const voter of fixture.globalVoters) await fixture.vote(id, voter, 20);
  }
  for (const id of ids) expect((await fixture.published(id, 5, fixture.realmId)).mean).toBe(0);
  await fixture.drain();
  const after = await snapshot((client) => readPublicFigureViews(client, ids));
  for (const [index, id] of ids.entries()) {
    expect(after!.get(id)?.figure).toEqual(baseline!.get(id)?.figure);
    for (const actor of [null, fixture.realmMembers[0]!, fixture.globalVoters[0]!]) {
      const response = await fixture.request(`/v1/subjects/${id}/figure`, actor);
      expect(response.status).toBe(200);
      const text = await response.text();
      expect(JSON.parse(text)).toEqual({ figure: responses[index]!.figure });
      const serialized = text + JSON.stringify(after!.get(id));
      for (const secret of [
        fixture.realmId,
        ...fixture.realmMembers.map((voter) => voter.id),
        ...fixture.globalVoters.map((voter) => voter.id),
        'voterId',
        'units',
        'histogram',
        'vote',
      ])
        expect(serialized).not.toContain(secret);
    }
  }
}, 180_000);
