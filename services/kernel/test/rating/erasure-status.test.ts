import { afterAll, beforeAll, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { createWriteRateLimiter } from '../../src/access/write-rate.ts';
import { GLOBAL_CONTEXT } from '../../src/access/gates/catalogue.ts';
import { drainPublicFigures } from '../../src/rating/public-figure.ts';
import { readRatingErasureDone } from '../../src/rating/erasure-status.ts';
import acknowledgePage from '../../src/rating/erasure-status-ack.sql';
import deletePopulationVote from '../../src/rating/population-vote-delete.sql';
import { applyRatingChanges, applyRatingSegmentPageEvent } from '../../src/rating/aggregate-effect.ts';
import { createVoterEligibilityEffect, readRatingEligibilityJob } from '../../src/rating/eligibility.ts';
import { processRatingSegmentPage, type SegmentCursor } from '../../src/rating/segment-job.ts';
import { STANDARD_QUESTION_ID } from '../../src/rating/votes.ts';
import type { CloudEvent } from '../../src/events/log.ts';
import { newId, partitionOf, routeOf } from '../../src/route/route.ts';
import { nativeFixture } from '../access/native-account-bindings-fixture.ts';
import { deletePersona } from '../support/account-deletion.ts';
import { measure, openGrowthDatabase, type GrowthDatabase } from '../support/growth.ts';
import { createPersonas } from '../support/personas.ts';
import { testKernel } from '../support/test-kernel.ts';
import { observeSql } from '../content/support/sql-observer.ts';

let db: GrowthDatabase;
let auth: Awaited<ReturnType<typeof nativeFixture>>;
let people: Awaited<ReturnType<typeof createPersonas>>;
const countingKey = (id: string) => createHash('sha256').update(id).digest('hex');
beforeAll(async () => {
  db = await openGrowthDatabase();
  auth = await nativeFixture(db.pool);
  const service = auth.host.service;
  const kernel = testKernel({
    pool: db.pool,
    auth: { ...service.verifier, fetch: (url, init) => service.handler(new Request(url, init)) },
    writeRate: createWriteRateLimiter({ secret: 'rating-erasure-status-native-test-secret' }),
  });
  people = await createPersonas(kernel, { version: 1, pool: db.pool, auth });
}, 360000);
afterAll(async () => {
  await auth?.close();
  await db?.close();
});

test('rating erasure status is done only after every vote, population vote and voter Realm row of a deleted voter is gone', async () => {
  const voter = people.alice;
  const route = routeOf(voter.accountId)!;
  const realms = [newId(0x6b09), newId(0x6b0a)];
  const populations = [GLOBAL_CONTEXT.id, ...realms];
  const at = new Date().toISOString();
  const targets = Array.from({ length: 205 }, (_, i) => newId(0x3100 + (i % 3) * 0x10));
  await db.admin.query(
    `INSERT INTO rating.vote(route,voter_id,question_id,target_id,units,revision,changed_at,transaction_id)
     SELECT $1,$2,$3,id,10,1,$4,id FROM unnest($5::uuid[]) AS t(id)`,
    [route, voter.accountId, STANDARD_QUESTION_ID, at, targets],
  );
  for (const realm of realms)
    await db.admin.query(
      `INSERT INTO rating.voter_realm(route,voter_id,realm_id,joined_at,state) VALUES($1,$2,$3,$4,'counted')`,
      [route, voter.accountId, realm, at],
    );
  await db.admin.query(
    `INSERT INTO rating.voter_realm(route,voter_id,realm_id,joined_at,state)
     SELECT $1,$2,id,$3,'uncounted' FROM unnest($4::uuid[]) AS t(id)`,
    [route, voter.accountId, at, Array.from({ length: 205 }, () => newId(0x6b0b))],
  );
  // Populate in bounded batches so setup does not put all 615 aggregate writes
  // inside the default command deadline on a shared check host.
  for (let start = 0; start < targets.length; start += 25)
    await applyRatingChanges(
      db.pool,
      targets.slice(start, start + 25).flatMap((targetId) =>
        populations.map((populationId) => ({
          voterId: voter.accountId,
          countingKey: countingKey(voter.accountId),
          questionId: STANDARD_QUESTION_ID,
          targetId,
          populationId,
          units: 10,
          revision: 1,
          at,
        })),
      ),
    );
  const statements: number[] = [];
  const status = async () => {
    const measured = await measure(db, () => readRatingErasureDone({ pool: db.pool }, voter.accountId));
    statements.push(measured.cost.statements);
    return measured.value;
  };
  expect((await status()).done).toBe(false);
  const rankedTarget = targets[0]!;
  await applyRatingChanges(db.pool, Array.from({ length: 4 }, (_, index) => ({
    voterId: newId(route), countingKey: countingKey(`remaining-${index}`), questionId: STANDARD_QUESTION_ID,
    populationId: realms[0]!, targetId: rankedTarget, units: 10, revision: 1, at,
  })));
  await drainPublicFigures(db.pool, partitionOf(routeOf(rankedTarget)!));
  const rank = () => db.admin.query('SELECT count FROM rating.realm_rank WHERE subject_id=$1 AND population_id=$2',
    [rankedTarget, realms[0]]);
  expect((await rank()).rows).toEqual([{ count: '5' }]);
  await deletePersona({ version: 1, pool: db.pool, auth }, voter);
  expect((await status()).done).toBe(false);
  const tombstone = await db.admin.query(
    `SELECT id::text, recorded_at::text AS time, data FROM core.outbox
     WHERE subject=$1 AND type='com.rezics.access.account-tombstoned.v1' ORDER BY position DESC LIMIT 1`,
    [voter.accountId],
  );
  const event = (data: unknown, type: string): CloudEvent => ({
    specversion: '1.0',
    id: crypto.randomUUID(),
    source: 'urn:rezics:kernel',
    subject: voter.accountId,
    time: at,
    type,
    datacontenttype: 'application/json',
    sequence: '1',
    data,
  });
  await createVoterEligibilityEffect(db.pool).run({
    ...event(tombstone.rows[0].data, 'com.rezics.access.account-tombstoned.v1'),
    id: tombstone.rows[0].id,
    time: tombstone.rows[0].time,
  });
  const job = await readRatingEligibilityJob(db.pool, { voterId: voter.accountId });
  expect(job).not.toBeNull();
  let after: SegmentCursor | null = null;
  const pages: CloudEvent[] = [];
  for (;;) {
    const trace = observeSql(db.pool);
    let result;
    try {
      result = await processRatingSegmentPage(db.pool, { ...job!, after });
    } finally {
      await trace.close();
    }
    const realmDeletes = trace.records.filter((record) => record.statement.includes('DELETE FROM rating.voter_realm'));
    for (const deletion of realmDeletes) expect(deletion.statement).toContain('LIMIT 100');
    pages.push(event(result.eventData, 'com.rezics.rating.segment.page.v1'));
    expect((await status()).done).toBe(false);
    if (pages.length === 1) {
      // A source commit can outlive the durable worker's checkpoint. Its event
      // and witness remain the delivery authority when that page is redriven.
      const replay = await processRatingSegmentPage(db.pool, { ...job!, after });
      expect(replay.cursor).toEqual(result.cursor);
      expect(replay.eventData.votes).toEqual([]);
      expect(replay.done).toBe(false);
    }
    if (result.done) break;
    after = result.cursor;
  }
  expect(
    (await db.admin.query('SELECT 1 FROM rating.vote WHERE route=$1 AND voter_id=$2', [route, voter.accountId])).rows,
  ).toHaveLength(0);
  expect(
    (await db.admin.query('SELECT 1 FROM rating.voter_realm WHERE route=$1 AND voter_id=$2', [route, voter.accountId]))
      .rows,
  ).toHaveLength(0);
  const witnesses = await db.admin.query<{ page_id: string }>(
    'SELECT page_id::text FROM rating.erasure_page WHERE route=$1 AND voter_id=$2 AND NOT terminal',
    [route, voter.accountId],
  );
  expect(witnesses.rows.map((row) => row.page_id).sort()).toEqual(
    pages
      .flatMap((page) => {
        const { erasurePageId } = page.data as { erasurePageId?: string };
        return erasurePageId ? [erasurePageId] : [];
      })
      .sort(),
  );
  // Apply out of order, including the final empty page, so completion cannot rely on queue order.
  for (const page of pages.toReversed()) {
    if (page === pages[1]) {
      const trace = observeSql(db.pool);
      trace.armFault({
        match: { statement: deletePopulationVote.sql, occurrence: 2 },
        boundary: 'before',
        error: new Error('Population removal interrupted'),
      });
      try {
        await expect(
          applyRatingSegmentPageEvent(db.pool, async (_client, id) => countingKey(id), page),
        ).rejects.toThrow('Population removal interrupted');
      } finally {
        await trace.close();
      }
      expect((await status()).done).toBe(false);
      const { erasurePageId } = page.data as { erasurePageId: string };
      expect(
        (
          await db.admin.query(
            'SELECT 1 FROM rating.erasure_page WHERE route=$1 AND voter_id=$2 AND page_id=$3 AND NOT terminal',
            [route, voter.accountId, erasurePageId],
          )
        ).rows,
      ).toHaveLength(1);
    }
    if (page === pages[0]) {
      const trace = observeSql(db.pool);
      trace.armFault({
        match: { statement: acknowledgePage.sql },
        boundary: 'before',
        error: new Error('Erasure acknowledgement interrupted'),
      });
      try {
        await expect(
          applyRatingSegmentPageEvent(db.pool, async (_client, id) => countingKey(id), page),
        ).rejects.toThrow('Erasure acknowledgement interrupted');
      } finally {
        await trace.close();
      }
      expect((await status()).done).toBe(false);
    }
    await applyRatingSegmentPageEvent(db.pool, async (_client, id) => countingKey(id), page);
    if (page !== pages[0]) expect((await status()).done).toBe(false);
  }
  expect(
    (await db.admin.query('SELECT 1 FROM rating.population_vote WHERE voter_id=$1', [voter.accountId])).rows,
  ).toHaveLength(0);
  expect(await status()).toEqual({ done: true, hadVotes: true });
  expect((await rank()).rows).toEqual([]);
  const late = { voterId: voter.accountId, countingKey: countingKey(voter.accountId),
    questionId: STANDARD_QUESTION_ID, populationId: realms[0]!, targetId: rankedTarget,
    units: 20, revision: 1, at };
  await applyRatingChanges(db.pool, [late, { ...late, rekey: true, rekeyAt: at, rekeyAllowMissing: true }]);
  await drainPublicFigures(db.pool, partitionOf(routeOf(rankedTarget)!));
  expect((await rank()).rows).toEqual([]);
  expect((await db.admin.query('SELECT count FROM rating.public_figure WHERE subject_id=$1 AND population_id=$2',
    [rankedTarget, realms[0]])).rows).toEqual([{ count: '4' }]);

  expect(pages.filter((page) => (page.data as { votes: unknown[] }).votes.length === 0)).toHaveLength(3);
  await applyRatingSegmentPageEvent(db.pool, async (_client, id) => countingKey(id), pages[0]!);
  expect(await status()).toEqual({ done: true, hadVotes: true });
  expect(new Set(statements).size).toBe(1);
  expect(statements[0]).toBe(1);
  expect(await readRatingErasureDone({ pool: db.pool }, people.bob.accountId)).toEqual({
    done: false,
    hadVotes: false,
  });
});

test('a tombstoned account without votes still needs its persisted terminal purge transition', async () => {
  const voter = people.bob;
  expect(await readRatingErasureDone({ pool: db.pool }, voter.accountId)).toEqual({ done: false, hadVotes: false });
  await deletePersona({ version: 1, pool: db.pool, auth }, voter);
  expect(await readRatingErasureDone({ pool: db.pool }, voter.accountId)).toEqual({ done: false, hadVotes: false });
  const tombstone = await db.admin.query(
    `SELECT id::text, recorded_at::text AS time, data FROM core.outbox
     WHERE subject=$1 AND type='com.rezics.access.account-tombstoned.v1' ORDER BY position DESC LIMIT 1`,
    [voter.accountId],
  );
  const event: CloudEvent = {
    specversion: '1.0',
    id: tombstone.rows[0].id,
    source: 'urn:rezics:kernel',
    subject: voter.accountId,
    time: tombstone.rows[0].time,
    type: 'com.rezics.access.account-tombstoned.v1',
    datacontenttype: 'application/json',
    sequence: '1',
    data: tombstone.rows[0].data,
  };
  const effect = createVoterEligibilityEffect(db.pool);
  await effect.run(event);
  expect((await readRatingErasureDone({ pool: db.pool }, voter.accountId)).done).toBe(false);
  const job = await readRatingEligibilityJob(db.pool, { voterId: voter.accountId });
  expect(job).not.toBeNull();
  const terminal = await processRatingSegmentPage(db.pool, { ...job!, after: null });
  expect(terminal.done).toBe(true);
  expect(terminal.eventData.votes).toEqual([]);
  expect(await readRatingErasureDone({ pool: db.pool }, voter.accountId)).toEqual({ done: true, hadVotes: false });
  await effect.run(event);
  await processRatingSegmentPage(db.pool, { ...job!, after: null });
  expect(await readRatingErasureDone({ pool: db.pool }, voter.accountId)).toEqual({ done: true, hadVotes: false });
});

test('absence and an obsolete terminal witness cannot complete a different persisted transition', async () => {
  const route = 0x4d31;
  const voterId = newId(route);
  const oldTransition = newId(route);
  const transitionId = newId(route);
  await db.admin.query(
    `INSERT INTO rating.erasure_page(route,voter_id,page_id,terminal,had_votes) VALUES($1,$2,$3,true,true)`,
    [route, voterId, oldTransition],
  );
  expect(await readRatingErasureDone({ pool: db.pool }, voterId)).toEqual({ done: false, hadVotes: false });
  await db.admin.query(
    `INSERT INTO rating.voter_state(route,voter_id,state,transition_id) VALUES($1,$2,'ineligible',$3)`,
    [route, voterId, transitionId],
  );
  expect(await readRatingErasureDone({ pool: db.pool }, voterId)).toEqual({ done: false, hadVotes: false });
  await db.admin.query(
    `INSERT INTO rating.erasure_page(route,voter_id,page_id,terminal,had_votes) VALUES($1,$2,$3,true,false)`,
    [route, voterId, transitionId],
  );
  expect(await readRatingErasureDone({ pool: db.pool }, voterId)).toEqual({ done: true, hadVotes: false });
});
