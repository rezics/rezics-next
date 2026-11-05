import { expect, test } from 'bun:test';
import { createRealmRankSource, type RealmRankRequest } from '../../src/rating/realm-rank.ts';
import { STANDARD_QUESTION_ID } from '../../src/rating/votes.ts';
import { newId, partitionOf, routeOf } from '../../src/route/route.ts';
import { communityFixtureRuntime } from '../community/community-driver.ts';
import { createFigureFixture } from './support/figure-fixture.ts';

test('scored compatibility pages keep standard and Realm question authority distinct and restart on caption publication', async () => {
  const fixture = await createFigureFixture({ subjects: 10, partitions: 1 });
  try {
    const { system } = communityFixtureRuntime();
    for (const subject of fixture.subjectIds)
      for (const voter of fixture.realmMembers) await fixture.vote(subject, voter, 0);
    await fixture.drain();
    const actor = await system.access.authenticate(fixture.realmMembers[0]!.bearer, {
      pool: fixture.database.pool,
      deadline: Date.now() + 30_000,
    });
    const source = createRealmRankSource({
      pool: fixture.database.pool,
      access: system.access,
      tokens: system.tokenKeys,
    });
    const request: RealmRankRequest = {
      realmId: fixture.realmId,
      questionId: STANDARD_QUESTION_ID,
      partition: partitionOf(routeOf(fixture.subjectIds[0]!)!),
      sort: 'score_desc',
      limit: 1,
    };
    const page = (input = request, principal = actor) =>
      source.page(principal, input, { deadline: Date.now() + 30_000 });
    const custom = newId(routeOf(fixture.realmId)!);
    const sql = fixture.database.admin;
    await sql.query(
      `INSERT INTO rating.question(id,owner_id,revision,label,grain,minimum_units,maximum_units,step_units,realm_id,meaning)
       VALUES($1,$2,1,'Realm question','work',0,20,1,$3,'Independent Realm meaning')`,
      [custom, fixture.realmMembers[0]!.id, fixture.realmId],
    );
    expect((await page({ ...request, questionId: custom })).candidates).toEqual([]);
    // Retain native publication shapes. Only the installed figure trigger writes the rank projection.
    await sql.query(
      `INSERT INTO rating.population_prior_epoch(route,question_id,population_id,epoch,generation,start_count,m,c,question_identity)
       SELECT route,$1,population_id,epoch,generation,start_count,m,c,question_identity
       FROM rating.population_prior_epoch WHERE question_id=$2 AND population_id=$3`,
      [custom, STANDARD_QUESTION_ID, fixture.realmId],
    );
    await sql.query(
      `INSERT INTO rating.public_figure(route,question_id,population_id,subject_id,count,mean,score,m,c,prior_epoch,
         revision,as_of,position,published_prior_generation,question_identity)
       SELECT route,$1,population_id,subject_id,count,mean,score,m,c,prior_epoch,
         revision,as_of,position,published_prior_generation,question_identity
       FROM rating.public_figure WHERE question_id=$2 AND population_id=$3`,
      [custom, STANDARD_QUESTION_ID, fixture.realmId],
    );
    const withoutDefinitions = {
      ...actor,
      scopes: actor.scopes.filter((scope) => scope !== 'definitions:read'),
    };
    await expect(page(request, withoutDefinitions)).rejects.toMatchObject({
      code: 'not_found',
    });
    expect((await page({ ...request, questionId: custom }, withoutDefinitions)).question.realmId).toBe(fixture.realmId);
    for (const questionId of [STANDARD_QUESTION_ID, custom]) {
      const input = { ...request, questionId };
      const first = await page(input);
      expect(first.candidates).toHaveLength(1);
      expect(first.candidates[0]).toMatchObject({
        count: 5,
        mean: 0,
        score: 0,
      });
      expect(first.next).toBeString();
      expect((await page({ ...input, cursor: first.next! })).candidates[0]!.subjectId).not.toBe(
        first.candidates[0]!.subjectId,
      );
      await sql.query(
        `INSERT INTO rating.question_label_head(question_id,revision,label) VALUES($1,1,'New caption')
         ON CONFLICT(question_id) DO UPDATE SET revision=question_label_head.revision+1,label=EXCLUDED.label`,
        [questionId],
      );
      await expect(page({ ...input, cursor: first.next! })).rejects.toMatchObject({ code: 'invalid_cursor' });
      expect((await page(input)).question.label).toBe('New caption');
    }
  } finally {
    await fixture.close();
  }
}, 600_000);
