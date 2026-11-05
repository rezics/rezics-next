import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { createRealmRankSource, type RealmRankRequest } from '../../src/rating/realm-rank.ts';
import type { Actor } from '../../src/request/access.ts';
import { newId, partitionOf, routeOf } from '../../src/route/route.ts';
import { communityFixtureRuntime } from '../community/community-driver.ts';
import { createFigureFixture } from './support/figure-fixture.ts';

test('selected questions keep their scale, private prior, threshold and continuation through native publication', async () => {
  const fixture = await createFigureFixture({ subjects: 11, partitions: 1 });
  try {
    const { system, kernel } = communityFixtureRuntime();
    const questionIds = [newId(0x2100), newId(routeOf(fixture.realmId)!)];
    for (const [index, questionId] of questionIds.entries())
      await fixture.database.admin.query(
        `INSERT INTO rating.question(id,owner_id,revision,label,grain,minimum_units,maximum_units,step_units,realm_id,meaning)
         VALUES($1,$2,$3,$4,'work',$5,$6,$7,$8,$9)`,
        [
          questionId,
          fixture.realmMembers[0]!.id,
          index + 1,
          index === 0 ? 'Translation quality' : 'Adaptation fidelity',
          index === 0 ? 0 : 2,
          index === 0 ? 4 : 20,
          index === 0 ? 1 : 2,
          index === 0 ? null : fixture.realmId,
          index === 0 ? null : 'Judge adaptation independently of translation quality.',
        ],
      );
    const source = createRealmRankSource({
      pool: fixture.database.pool,
      access: system.access,
      tokens: system.tokenKeys,
    });
    const actor = await system.access.authenticate(fixture.realmMembers[0]!.bearer, {
      pool: fixture.database.pool,
      deadline: Date.now() + 30_000,
    });
    const request: RealmRankRequest = {
      realmId: fixture.realmId,
      questionId: questionIds[0]!,
      partition: partitionOf(routeOf(fixture.subjectIds[0]!)!),
      sort: 'score_desc',
      limit: 100,
    };
    const page = (input: RealmRankRequest = request, principal: Actor = actor) =>
      source.page(principal, input, { deadline: Date.now() + 30_000 });
    const write = async (questionId: string, subjectId: string, voter: { bearer: string }, units: number | null) => {
      const response = await kernel.handle(
        new Request(`https://content.test/v1/subjects/${subjectId}/ratings/${questionId}/vote`, {
          method: units === null ? 'DELETE' : 'PUT',
          headers: {
            authorization: `Bearer ${voter.bearer}`,
            'content-type': 'application/json',
            'idempotency-key': JSON.stringify(randomUUID()),
          },
          ...(units === null ? {} : { body: JSON.stringify({ units }) }),
        }),
      );
      if (!response.ok) throw new Error(`Question vote: ${response.status} ${await response.text()}`);
    };
    expect((await page()).candidates).toEqual([]);
    const boundary = fixture.subjectIds[10]!;
    for (const [questionIndex, questionId] of questionIds.entries()) {
      for (const [subjectIndex, subjectId] of fixture.subjectIds.entries()) {
        for (const voter of subjectId === boundary ? fixture.realmMembers.slice(0, 4) : fixture.realmMembers)
          await write(
            questionId,
            subjectId,
            voter,
            questionIndex === 0 ? (subjectIndex === 0 ? 4 : 0) : subjectIndex === 1 ? 20 : 2,
          );
        // Finish the first 50 counted Realm votes before adding below-threshold targets.
        if (subjectIndex === 9) await fixture.drain();
      }
      // These Global votes must never supply the selected Realm's prior.
      for (const voter of questionIndex === 0 ? fixture.globalVoters : [])
        await write(questionId, fixture.subjectIds[0]!, voter, questionIndex === 0 ? 0 : 20);
    }
    await fixture.drain();
    const first = await page();
    const secondRequest = { ...request, questionId: questionIds[1]! };
    const second = await page(secondRequest);
    const directory = await (await fixture.request('/v1/rating-questions')).json();
    const realmDirectory = await (
      await fixture.request(`/v1/rating-questions?realm=${fixture.realmId}`, fixture.realmMembers[0]!)
    ).json();
    directory.ratingQuestions.push(...realmDirectory.ratingQuestions);
    for (const result of [first, second]) {
      expect(result.question).toEqual(
        directory.ratingQuestions.find((q: { id: string }) => q.id === result.question.id),
      );
      expect(result.candidates).toHaveLength(10);
      expect(result.candidates.some((row) => row.subjectId === boundary)).toBe(false);
      for (const row of result.candidates) expect(row).toMatchObject({ count: 5, priorEpoch: 1 });
    }
    expect(first.candidates[0]).toMatchObject({ subjectId: fixture.subjectIds[0], mean: 4 });
    expect(first.candidates[0]!.score).toBeCloseTo(2.2, 3);
    expect(second.candidates[0]).toMatchObject({ subjectId: fixture.subjectIds[1], mean: 20 });
    expect(second.candidates[0]!.score).toBeCloseTo(11.9, 3);
    const cursorPage = await page({ ...request, limit: 1 });
    const otherCursor = await page({ ...secondRequest, limit: 1 });
    expect(cursorPage.next).toBeString();
    await expect(page({ ...secondRequest, limit: 1, cursor: cursorPage.next! })).rejects.toMatchObject({
      code: 'invalid_cursor',
    });
    await expect(page({ ...request, questionId: newId(0x2100) })).rejects.toMatchObject({ code: 'not_found' });
    await expect(page({ ...request, realmId: newId(0x2300) })).rejects.toMatchObject({ code: 'not_found' });
    await expect(page(request, { kind: 'anonymous' })).rejects.toMatchObject({ code: 'not_found' });
    await expect(
      page(request, { ...actor, scopes: actor.scopes.filter((scope) => scope !== 'definitions:read') }),
    ).rejects.toMatchObject({ code: 'not_found' });
    const unavailableQuestion = newId(0x2400);
    await fixture.database.admin.query(
      `INSERT INTO rating.question(id,owner_id,revision,label,grain,minimum_units,maximum_units,step_units,realm_id,meaning)
       VALUES($1,$2,1,'Unavailable question','work',0,1,1,$3,'Private meaning')`,
      [unavailableQuestion, fixture.realmMembers[0]!.id, newId(0x2400)],
    );
    await expect(page({ ...request, questionId: unavailableQuestion })).rejects.toMatchObject({ code: 'not_found' });
    // A below-threshold change contributes no rank generation or cursor evidence.
    await write(request.questionId, boundary, fixture.realmMembers[0]!, null);
    await fixture.drain();
    expect((await page({ ...request, limit: 1, cursor: cursorPage.next! })).candidates).toHaveLength(1);
    // Removing a ready row invalidates this question's continuation, while the other question remains usable.
    await write(request.questionId, fixture.subjectIds[0]!, fixture.realmMembers[0]!, null);
    await fixture.drain();
    await expect(page({ ...request, limit: 1, cursor: cursorPage.next! })).rejects.toMatchObject({
      code: 'invalid_cursor',
    });
    expect((await page({ ...secondRequest, limit: 1, cursor: otherCursor.next! })).candidates).toHaveLength(1);
    expect((await page()).candidates).toHaveLength(9);
    await fixture.database.admin.query('UPDATE rating.question SET revision=revision+1, maximum_units=6 WHERE id=$1', [
      request.questionId,
    ]);
    await expect(page({ ...request, limit: 1, cursor: cursorPage.next! })).rejects.toMatchObject({
      code: 'invalid_cursor',
    });
    expect((await page()).candidates).toEqual([]);
    expect((await page(secondRequest)).candidates).toHaveLength(10);
    const publicEvents = await fixture.database.admin.query(
      `SELECT 1 FROM core.outbox WHERE type='com.rezics.rating.public_figure.changed.v1'
       AND data->>'questionId'=ANY($1::text[])`,
      [questionIds],
    );
    expect(publicEvents.rows).toEqual([]);
  } finally {
    await fixture.close();
  }
}, 600_000);
