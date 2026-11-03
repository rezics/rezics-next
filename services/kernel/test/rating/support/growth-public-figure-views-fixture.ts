import { expect } from 'bun:test';
import { GLOBAL_CONTEXT } from '../../../src/access/gates/catalogue.ts';
import { readPublicFigureViews } from '../../../src/rating/public-figure-http.ts';
import { STANDARD_QUESTION_ID } from '../../../src/rating/votes.ts';
import { newId, partitionOf, routeOf } from '../../../src/route/route.ts';
import { createFigureFixture, type FigureFixture } from './figure-fixture.ts';

export const VIEW_SCALES = [256, 1024, 4096] as const;
export const VIEW_AXES = ['subjects', 'figures', 'population history'] as const;
export type ViewAxis = (typeof VIEW_AXES)[number];

// The only selected producer is the shared native HTTP/registered-worker fixture.
// SQL below seeds unrelated pressure or holds a publication boundary; it never supplies selected results.
export async function createViewGrowthFixture() {
  const native = await createFigureFixture({ subjects: 13, partitions: 3 });
  let release: (() => Promise<void>) | undefined;
  try {
    const ids = native.subjectIds.slice(0, 4);
    const [ready, pending, insufficient, absent] = ids as [string, string, string, string];
    const route = routeOf(ready)!;
    const partitions = new Set(ids.map((id) => partitionOf(routeOf(id)!)));
    expect(partitions.size).toBe(3);

    // Fifty real Global votes establish the prior. A zero mean and zero score must remain numbers.
    for (const subject of [ready, ...native.subjectIds.slice(4)])
      for (const voter of native.globalVoters) await native.vote(subject, voter, 0);
    await native.published(ready, 5);
    await native.vote(insufficient, native.globalVoters[0]!, 4);
    await native.published(insufficient, 1);
    const baseline = await native.figure(ready);
    expect(baseline.figure).toMatchObject({ state: 'ready', count: 5, mean: 0, score: 0 });

    // Native private Realm publications change at both extremes while Global output and ETag stay exact.
    for (const units of [20, 0]) {
      for (const voter of native.realmMembers) await native.vote(ready, voter, units);
      expect((await native.published(ready, 5, native.realmId)).mean).toBe(units / 2);
      expect(await native.figure(ready)).toEqual(baseline);
    }

    release = await holdPublication(native, pending);
    await native.vote(pending, native.globalVoters[0]!, 20);
    const deadline = Date.now() + 60_000;
    while ((await native.figure(pending)).figure.state !== 'updating') {
      if (Date.now() > deadline) throw new Error('Native figure worker did not expose the pending mark');
      await Bun.sleep(20);
    }
    const responses = await Promise.all(ids.map((id) => native.figure(id)));
    expect(responses[0]).toEqual(baseline);
    expect(responses[1]!.figure).toMatchObject({ state: 'updating', count: 0, mean: null, score: null });
    expect(responses[2]!.figure).toMatchObject({ state: 'insufficient_data', count: 1, mean: null, score: null });
    expect(responses[3]!.figure).toMatchObject({ state: 'insufficient_data', count: 0, mean: null, score: null });
    expect(responses[1]!.etag).toBe('"0"');
    expect(responses[3]!.etag).toBe('"0"');
    const expected = new Map(
      ids.map((id, index) => [id, { figure: responses[index]!.figure, revision: responses[index]!.etag.slice(1, -1) }]),
    );
    const pressureIds = Array.from({ length: VIEW_SCALES[2] }, () => newId(route));
    expect(pressureIds.every((id) => partitions.has(partitionOf(routeOf(id)!)))).toBe(true);

    return {
      database: native.database,
      ids,
      expected,
      partitionCount: partitions.size,
      async grow(axis: ViewAxis, scale: number, previous: number) {
        const added = pressureIds.slice(previous, scale);
        const db = native.database.admin;
        if (axis === 'subjects') {
          await db.query(
            `INSERT INTO semantic.subject (route, subject_id, type, recorded_transaction_id)
             SELECT $1, id, 'schema:Book', id FROM unnest($2::uuid[]) AS id`,
            [route, added],
          );
        } else {
          await db.query(
            `INSERT INTO rating.public_figure
               (route, question_id, population_id, subject_id, count, mean, score, m, c,
                prior_epoch, revision, as_of, position)
             SELECT $1, $2, CASE WHEN $3 THEN $4::uuid ELSE id END,
                    CASE WHEN $3 THEN id ELSE $5::uuid END,
                    5, 10, 10, 10, 5, 1, 99, '2026-10-27T10:00:00Z', 99
             FROM unnest($6::uuid[]) AS id`,
            [route, STANDARD_QUESTION_ID, axis === 'figures', GLOBAL_CONTEXT.id, ready, added],
          );
          if (axis === 'population history') {
            await db.query(
              `INSERT INTO rating.population_vote
                 (route, question_id, population_id, target_id, voter_id, counting_key, units, at, revision)
               SELECT $1, $2, id, $3, voter, repeat('0', 64), 20, '2026-10-27T10:00:00Z', 99
               FROM unnest($4::uuid[]) AS id CROSS JOIN unnest($5::uuid[]) AS voter`,
              [route, STANDARD_QUESTION_ID, ready, added, native.realmMembers.map(({ id }) => id)],
            );
            await db.query(
              `INSERT INTO rating.aggregate_component
                 (route, question_id, population_id, target_id, shard, count, sum, histogram, applied_at)
               SELECT $1, $2, id, $3, 0, 5, 100,
                      ARRAY(SELECT CASE WHEN unit = 20 THEN 5::bigint ELSE 0::bigint END
                            FROM generate_series(0, 20) AS unit), '2026-10-27T10:00:00Z'
               FROM unnest($4::uuid[]) AS id`,
              [route, STANDARD_QUESTION_ID, ready, added],
            );
          }
        }
        // Verify the actual independent axes, not just the requested seeding size.
        const footprint = (await db.query<{
          subjects: number; figures: number; populations: number; votes: number; components: number;
        }>(
          `SELECT
             (SELECT count(*)::int FROM semantic.subject WHERE route = $1 AND subject_id = ANY($2::uuid[])) AS subjects,
             (SELECT count(*)::int FROM rating.public_figure WHERE route = $1 AND question_id = $3
                AND population_id = $4 AND subject_id = ANY($2::uuid[])) AS figures,
             (SELECT count(*)::int FROM rating.public_figure WHERE route = $1 AND question_id = $3
                AND subject_id = $5 AND population_id = ANY($2::uuid[])) AS populations,
             (SELECT count(*)::int FROM rating.population_vote WHERE route = $1 AND question_id = $3
                AND target_id = $5 AND population_id = ANY($2::uuid[])) AS votes,
             (SELECT count(*)::int FROM rating.aggregate_component WHERE route = $1 AND question_id = $3
                AND target_id = $5 AND population_id = ANY($2::uuid[])) AS components`,
          [route, pressureIds, STANDARD_QUESTION_ID, GLOBAL_CONTEXT.id, ready],
        )).rows[0]!;
        expect(footprint).toEqual({
          subjects: axis === 'subjects' ? scale : 0,
          figures: axis === 'figures' ? scale : 0,
          populations: axis === 'population history' ? scale : 0,
          votes: axis === 'population history' ? scale * 5 : 0,
          components: axis === 'population history' ? scale : 0,
        });
        console.info('public figure views seeded', JSON.stringify({ axis, scale, footprint }));
      },
      async read() {
        const client = await native.database.pool.connect();
        try {
          await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
          const views = await readPublicFigureViews(client, ids);
          expect(views).toEqual(expected);
          for (const [index, id] of ids.entries())
            expect(`"${views!.get(id)!.revision}"`).toBe(responses[index]!.etag);
          const serialized = JSON.stringify([...views!]);
          for (const secret of [native.realmId, ...native.realmMembers.map(({ id }) => id), 'histogram', 'units'])
            expect(serialized).not.toContain(secret);
          expect((await readPublicFigureViews(client, []))?.size).toBe(0);
          // This helper has no actor gate. Denied work here means invalid input, before any SQL.
          for (const rejected of [['invalid'], [ready.toUpperCase()], Array(257).fill(ready)])
            await expect(readPublicFigureViews(client, rejected)).rejects.toBeInstanceOf(TypeError);
          return views;
        } finally {
          await client.query('ROLLBACK');
          client.release();
        }
      },
      async close() {
        try {
          await release!();
          release = undefined;
          await native.published(pending, 1);
          await native.database.admin.query('DROP TRIGGER hold_growth_view_publication ON rating.public_figure');
          await native.database.admin.query('DROP FUNCTION public.hold_growth_view_publication()');
        } finally {
          await native.close();
        }
      },
    };
  } catch (error) {
    try {
      await release?.();
    } finally {
      await native.close();
    }
    throw error;
  }
}

async function holdPublication(native: FigureFixture, subjectId: string) {
  await native.database.admin.query(`
    CREATE FUNCTION public.hold_growth_view_publication() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      PERFORM pg_advisory_xact_lock(hashtext(NEW.subject_id::text), 96);
      RETURN NEW;
    END $$;
    CREATE TRIGGER hold_growth_view_publication BEFORE UPDATE ON rating.public_figure
    FOR EACH ROW WHEN (OLD.pending_position IS NOT NULL AND NEW.pending_position IS NULL)
    EXECUTE FUNCTION public.hold_growth_view_publication()`);
  const lock = await native.database.admin.connect();
  try {
    await lock.query('BEGIN');
    await lock.query('SELECT pg_advisory_xact_lock(hashtext($1), 96)', [subjectId]);
  } catch (error) {
    lock.release(true);
    throw error;
  }
  return async () => {
    try {
      await lock.query('ROLLBACK');
    } finally {
      lock.release();
    }
  };
}
