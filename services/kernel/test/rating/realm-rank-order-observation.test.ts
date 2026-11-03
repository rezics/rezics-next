import { expect, test } from 'bun:test';
import { GLOBAL_CONTEXT } from '../../src/access/gates/catalogue.ts';
import { createRealmRankOrderSource } from '../../src/rating/realm-rank.ts';
import { STANDARD_QUESTION_ID } from '../../src/rating/votes.ts';
import { newId, partitionOf, routeOf } from '../../src/route/route.ts';
import { communityFixtureRuntime } from '../community/community-driver.ts';
import { createFigureFixture } from './support/figure-fixture.ts';

test('native rank primitives reobserve selected publication, prior and authority even for empty proofs', async () => {
  const fixture = await createFigureFixture({ subjects: 11, partitions: 1 });
  try {
    for (const subject of fixture.subjectIds.slice(0, 10))
      for (const voter of fixture.realmMembers) await fixture.vote(subject, voter, 0);
    await fixture.drain();
    const { system } = communityFixtureRuntime();
    const actor = await system.access.authenticate(fixture.realmMembers[0]!.bearer, {
      pool: fixture.database.pool,
      deadline: Date.now() + 30_000,
    });
    const source = createRealmRankOrderSource({
      pool: fixture.database.pool,
      access: system.access,
      tokens: system.tokenKeys,
    });
    const context = () => ({ deadline: Date.now() + 30_000 });
    const input = { realmId: fixture.realmId, questionId: STANDARD_QUESTION_ID };
    const partition = partitionOf(routeOf(fixture.subjectIds[0]!)!);
    const observation = await source.observe(actor, input, context());
    expect(observation).toMatchObject({
      populationId: fixture.realmId,
      questionProvenance: GLOBAL_CONTEXT.id,
      priorActive: true,
    });
    const request = { ...input, partition, subjectIds: [fixture.subjectIds[0]!, fixture.subjectIds[10]!] };
    const proof = await source.proveFigures(actor, request, observation, context());
    expect(proof.figures.find(({ subjectId }) => subjectId === request.subjectIds[0])).toMatchObject({
      scored: true,
      figure: { mean: 0, score: 0 },
    });
    expect(proof.figures.find(({ subjectId }) => subjectId === request.subjectIds[1])).toMatchObject({
      scored: false,
      figure: null,
    });
    const empty = { ...request, subjectIds: [] };
    await expect(
      source.proveFigures(
        { ...actor, scopes: actor.scopes.filter((scope) => scope !== 'definitions:read') },
        empty,
        observation,
        context(),
      ),
    ).rejects.toMatchObject({ code: 'not_found' });
    await fixture.database.admin.query(
      `INSERT INTO rating.question_label_head(question_id,revision,label) VALUES($1,1,'Current caption')
       ON CONFLICT(question_id) DO UPDATE SET revision=question_label_head.revision+1,label=EXCLUDED.label`,
      [input.questionId],
    );
    for (const read of [
      () => source.listScoredPartitions(actor, input, observation, context()),
      () => source.readScoredPartition(actor, { ...input, partition, limit: 1, after: null }, observation, context()),
      () => source.proveFigures(actor, empty, observation, context()),
    ])
      await expect(read()).rejects.toMatchObject({ code: 'search_restart_required' });
    const caption = await source.observe(actor, input, context());
    expect(caption.questionIdentity).toBe(observation.questionIdentity);
    expect(caption.questionPublication).not.toBe(observation.questionPublication);
    await fixture.database.admin.query(
      `UPDATE rating.population_prior_epoch SET generation=generation+1
       WHERE route=$1 AND question_id=$2 AND population_id=$3`,
      [routeOf(input.realmId), input.questionId, input.realmId],
    );
    await expect(source.proveFigures(actor, empty, caption, context())).rejects.toMatchObject({
      code: 'search_restart_required',
    });

    const questionId = newId(routeOf(input.realmId)!);
    await fixture.database.admin.query(
      `INSERT INTO rating.question(id,owner_id,revision,label,grain,minimum_units,maximum_units,step_units,realm_id,meaning)
       VALUES($1,$2,1,'Realm question','work',0,20,1,$3,'Independent Realm meaning')`,
      [questionId, fixture.realmMembers[0]!.id, input.realmId],
    );
    const custom = { ...input, questionId };
    const selected = await source.observe(actor, custom, context());
    expect(selected).toMatchObject({ questionProvenance: input.realmId, priorActive: false, priorEpoch: null });
    expect((await source.proveFigures(actor, { ...empty, questionId }, selected, context())).figures).toEqual([]);
    await fixture.database.admin.query(
      `INSERT INTO rating.question_lifecycle(question_id,revision,state) VALUES($1,2,'retired')`,
      [questionId],
    );
    await expect(source.observe(actor, custom, context())).rejects.toMatchObject({ reason: 'retired' });
    await expect(source.proveFigures(actor, { ...empty, questionId }, selected, context())).rejects.toMatchObject({
      reason: 'retired',
    });
  } finally {
    await fixture.close();
  }
}, 600_000);
