import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { createRatingCounter } from '../../src/access/rating-counter.ts';
import type { CloudEvent } from '../../src/events/log.ts';
import { applyRatingSegmentPageEvent, applyRatingVoteEvent } from '../../src/rating/aggregate-effect.ts';
import { createPublicRatingSource } from '../../src/rating/public-rating-source.ts';
import { createRealmRankSource } from '../../src/rating/realm-rank.ts';
import { STANDARD_QUESTION_ID } from '../../src/rating/votes.ts';
import { partitionOf, routeOf } from '../../src/route/route.ts';
import { communityFixtureRuntime } from '../community/community-driver.ts';
import { createFigureFixture } from './support/figure-fixture.ts';

test('native membership pages converge rank and prior; late votes and old join/leave pages cannot restore an old epoch', async () => {
  const f = await createFigureFixture({ subjects: 12, partitions: 1, deferMembership: true });
  try {
    const { system, kernel } = communityFixtureRuntime();
    const source = createRealmRankSource({ pool: f.database.pool, access: system.access, tokens: system.tokenKeys });
    const counter = createRatingCounter({ secret: Buffer.alloc(32, 43) });
    const member = f.realmMembers[0]!;
    const request = { realmId: f.realmId, questionId: STANDARD_QUESTION_ID,
      partition: partitionOf(routeOf(f.subjectIds[0]!)!), sort: 'score_desc' as const, limit: 100 };
    const actor = await system.access.authenticate(member.bearer, { pool: f.database.pool, deadline: Date.now() + 30_000 });
    const other = await system.access.authenticate(f.realmMembers[1]!.bearer, { pool: f.database.pool, deadline: Date.now() + 30_000 });
    const page = (principal = other) => source.page(principal, request, { deadline: Date.now() + 30_000 });
    const command = async (method: string, path: string, bearer: string, body?: unknown) => {
      const response = await kernel.handle(new Request(`https://content.test${path}`, { method,
        headers: { authorization: `Bearer ${bearer}`, 'idempotency-key': JSON.stringify(randomUUID()), 'content-type': 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }));
      expect(response.status, await response.text()).toBeLessThan(300);
    };
    const events = async (type: string, direction?: string): Promise<CloudEvent[]> => {
      const rows = await f.database.admin.query(
        `SELECT id::text,partition_no,epoch,position::text,recorded_at::text AS time,data
         FROM core.outbox WHERE subject=$1 AND type=$2 AND ($3::text IS NULL OR data->>'direction'=$3)
         ORDER BY position,event_seq`, [member.id, type, direction ?? null]);
      return rows.rows.map((row) => ({ specversion: '1.0', id: row.id, type, subject: member.id,
        source: `urn:rezics:log:${row.partition_no}.${row.epoch}`, sequence: row.position.padStart(19, '0'),
        time: row.time, datacontenttype: 'application/json', data: row.data }));
    };
    const replay = async (pages: CloudEvent[]) => {
      for (const event of pages) await applyRatingSegmentPageEvent(f.database.pool, counter, event);
      await f.drain();
    };
    const pending = async () => (await f.database.admin.query(
      'SELECT pending_jobs FROM rating.population_pending WHERE route=$1 AND population_id=$2',
      [routeOf(f.realmId), f.realmId])).rows[0]?.pending_jobs ?? 0;
    const generation = async () => (await f.database.admin.query(
      'SELECT generation::text FROM rating.realm_rank_generation WHERE partition_no=$1 AND question_id=$2 AND population_id=$3',
      [request.partition, STANDARD_QUESTION_ID, f.realmId])).rows[0]?.generation;
    for (const subject of f.subjectIds) for (const voter of f.realmMembers) await f.vote(subject, voter, 10);
    await f.drain();
    const global = createPublicRatingSource(f.database.pool);
    const before = await global.read(request.partition, f.subjectIds);
    const oldVotes = await events('com.rezics.rating.vote.changed.v1');
    await f.joinMembers();
    const joined = await page();
    expect(joined.candidates).toHaveLength(12);
    for (const candidate of joined.candidates) expect(candidate).toMatchObject({ count: 5, mean: 5, score: 5, priorEpoch: 1 });
    expect(await pending()).toBe(0);
    const oldJoin = await events('com.rezics.rating.segment.page.v1', 'adding');
    expect(oldJoin.some((event) => (event.data as { votes: unknown[] }).votes.length > 0)).toBe(true);
    const cursor = await source.page(other, { ...request, limit: 1 }, { deadline: Date.now() + 30_000 });
    const joinedGeneration = await generation();
    await command('DELETE', `/v1/realms/${f.realmId}/membership`, member.bearer);
    // Authorization must follow current membership even before asynchronous rank convergence settles.
    await expect(page(actor)).rejects.toMatchObject({ code: 'not_found' });
    await f.drain();
    expect((await page()).candidates).toEqual([]); // 48 votes end the Realm's prior, and each subject drops below 5.
    expect(await pending()).toBe(0);
    expect(await generation()).not.toBe(joinedGeneration);
    await expect(source.page(other, { ...request, limit: 1, cursor: cursor.next! }, { deadline: Date.now() + 30_000 }))
      .rejects.toMatchObject({ code: 'invalid_cursor' });
    const oldLeave = await events('com.rezics.rating.segment.page.v1', 'removing');
    const leftGeneration = await generation();
    await replay(oldJoin);
    for (const event of oldVotes) await applyRatingVoteEvent(f.database.pool, counter, event);
    await f.drain();
    expect((await page()).candidates).toEqual([]);
    expect(await generation()).toBe(leftGeneration);
    await command('POST', `/v1/realms/${f.realmId}/members`, system.actors.author.bearer, { accountId: member.id });
    await f.drain();
    const rejoined = await page();
    expect(rejoined.candidates).toHaveLength(12);
    for (const candidate of rejoined.candidates) expect(candidate).toMatchObject({ count: 5, mean: 5, score: 5 });
    await replay(oldLeave);
    expect((await page()).candidates).toEqual(rejoined.candidates);
    expect(await pending()).toBe(0);
    expect((await global.read(request.partition, f.subjectIds)).figures).toEqual(before.figures);
  } finally { await f.close(); }
}, 600_000);
