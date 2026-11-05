import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { GLOBAL_CONTEXT } from '../../src/access/gates/catalogue.ts';
import { createPublicRatingSource } from '../../src/rating/public-rating-source.ts';
import { createRealmRankSource, type RealmRankRequest } from '../../src/rating/realm-rank.ts';
import { STANDARD_QUESTION_ID } from '../../src/rating/votes.ts';
import { newId, partitionOf, routeOf } from '../../src/route/route.ts';
import { communityFixtureRuntime } from '../community/community-driver.ts';
import { createFigureFixture } from './support/figure-fixture.ts';

test('protected native rank converges after votes, clear and membership loss without changing Global', async () => {
  const fixture = await createFigureFixture({ subjects: 12, partitions: 1 });
  try {
    const { system, kernel } = communityFixtureRuntime();
    const source = createRealmRankSource({
      pool: fixture.database.pool,
      access: system.access,
      tokens: system.tokenKeys,
    });
    const actor = await system.access.authenticate(fixture.realmMembers[0]!.bearer, {
      pool: fixture.database.pool,
      deadline: Date.now() + 30_000,
    });
    const request = {
      realmId: fixture.realmId,
      questionId: STANDARD_QUESTION_ID,
      partition: partitionOf(routeOf(fixture.subjectIds[0]!)!),
      sort: 'score_desc' as const,
      limit: 100,
    };
    const page = (input: RealmRankRequest = request, principal = actor) =>
      source.page(principal, input, { deadline: Date.now() + 30_000 });
    await expect(source.page({ kind: 'anonymous' }, request, { deadline: Date.now() + 30_000 })).rejects.toMatchObject({
      code: 'not_found',
    });
    await expect(page({ ...request, realmId: GLOBAL_CONTEXT.id })).rejects.toMatchObject({ code: 'invalid_request' });
    await expect(page({ ...request, questionId: newId(0x2100) })).rejects.toMatchObject({ code: 'not_found' });
    const boundary = fixture.subjectIds.at(-1)!;
    for (const subject of fixture.subjectIds)
      for (const voter of subject === boundary ? fixture.realmMembers.slice(0, 4) : fixture.realmMembers)
        await fixture.vote(subject, voter, 10);
    await fixture.drain();
    const below = await page();
    expect(below.candidates).toHaveLength(11);
    expect(below.candidates.some((row) => row.subjectId === boundary)).toBe(false);
    for (const row of below.candidates) expect(row).toMatchObject({ count: 5, mean: 5, score: 5, priorEpoch: 1 });
    const first = await page({ ...request, limit: 1 });
    expect(first.candidates).toHaveLength(1);
    expect(first.next).toBeString();
    expect(first.next).not.toContain(first.candidates[0]!.subjectId);
    const continuation = await page({ ...request, limit: 1, cursor: first.next! });
    expect(continuation.candidates[0]!.subjectId < first.candidates[0]!.subjectId).toBe(true);
    await expect(page({ ...request, limit: 2, cursor: first.next! })).rejects.toMatchObject({ code: 'invalid_cursor' });
    await fixture.vote(boundary, fixture.realmMembers[4]!, 10);
    await fixture.drain();
    expect((await page()).candidates).toHaveLength(12);
    await expect(page({ ...request, limit: 1, cursor: first.next! })).rejects.toMatchObject({ code: 'invalid_cursor' });
    const mutate = async (method: string, path: string) => {
      const response = await kernel.handle(
        new Request(`https://content.test${path}`, {
          method,
          headers: {
            authorization: `Bearer ${fixture.realmMembers[0]!.bearer}`,
            'idempotency-key': JSON.stringify(randomUUID()),
          },
        }),
      );
      if (!response.ok) throw new Error(`${method} ${path}: ${response.status} ${await response.text()}`);
      await fixture.drain();
    };
    await mutate('DELETE', `/v1/subjects/${boundary}/ratings/${STANDARD_QUESTION_ID}/vote`);
    expect((await page()).candidates.some((row) => row.subjectId === boundary)).toBe(false);
    for (const voter of fixture.realmMembers) await fixture.vote(boundary, voter, 0);
    await fixture.drain();
    expect((await page()).candidates.find((row) => row.subjectId === boundary)).toMatchObject({
      count: 5,
      mean: 0,
      score: 2.5,
    });
    const global = createPublicRatingSource(fixture.database.pool);
    const before = await global.read(request.partition, fixture.subjectIds);
    // Current candidate disclosure is independent of the rating projection's published numbers.
    await fixture.database.admin.query(
      `UPDATE semantic.subject SET visibility='taken_down',security_revision=security_revision+1
       WHERE route=$1 AND subject_id=$2`,
      [routeOf(boundary), boundary],
    );
    expect((await page()).candidates.some((row) => row.subjectId === boundary)).toBe(false);
    await mutate('DELETE', `/v1/realms/${fixture.realmId}/membership`);
    await expect(page()).rejects.toMatchObject({ code: 'not_found' });
    const remaining = await system.access.authenticate(fixture.realmMembers[1]!.bearer, {
      pool: fixture.database.pool,
      deadline: Date.now() + 30_000,
    });
    expect((await page(request, remaining)).candidates).toEqual([]);
    expect((await global.read(request.partition, fixture.subjectIds)).figures).toEqual(before.figures);
  } finally {
    await fixture.close();
  }
}, 600_000);
