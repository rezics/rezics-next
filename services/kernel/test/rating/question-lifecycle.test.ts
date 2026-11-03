import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import type { Account, Method } from '../../../../specs/community-driver.ts';
import { createRealmRankSource } from '../../src/rating/realm-rank.ts';
import { STANDARD_QUESTION_ID } from '../../src/rating/votes.ts';
import { newId, partitionOf, routeOf } from '../../src/route/route.ts';
import {
  closeCommunityDrivers,
  communityFixtureRuntime,
  createCommunityDriver,
} from '../community/community-driver.ts';

const definition = {
  meaning: 'Evaluate the translation independently of the source work.',
  label: 'Translation quality',
  grain: 'release' as const,
  scale: { min: 0, max: 10, displayStep: 1 },
};

test('Realm curators retire and restore without changing question meaning or private vote history', async () => {
  const driver = await createCommunityDriver();
  try {
    const fixture = await driver.provision();
    const { system } = communityFixtureRuntime();
    const call = (method: Method, path: string, actor: Account | null, body?: unknown, key = randomUUID()) =>
      driver.request({ method, path, actor, body, key: JSON.stringify(key) });
    const json = async (response: Response, status = 200) => {
      if (response.status !== status) throw new Error(`${response.status}: ${await response.text()}`);
      return response.json();
    };
    const space = (await json(await call('POST', '/v1/spaces', fixture.owner, { title: 'Question space' }), 201)).space;
    const realm = (
      await json(
        await call('POST', '/v1/realms', fixture.owner, {
          spaceId: space.spaceId,
          title: 'Translation curators',
          visibility: 'protected',
          contextId: fixture.contextId,
        }),
        201,
      )
    ).realm;
    const realmId: string = realm.realmId;
    await json(
      await call('POST', `/v1/realms/${realmId}/members`, fixture.owner, { accountId: fixture.member.id }),
      202,
    );
    await driver.settle();
    const grant = {
      resource: { route: routeOf(realmId), id: realmId },
      subject: { kind: 'account', id: fixture.member.id },
      actions: ['realm:manage'],
      valid: '(,)',
    };
    await json(await call('POST', '/v1/grants', fixture.owner, grant), 201);
    const author = `/v1/realms/${realmId}/rating-questions`;
    const question = await json(await call('POST', author, fixture.member, definition), 201);
    const second = await json(
      await call('POST', author, fixture.member, { ...definition, label: 'Source fidelity' }),
      201,
    );
    const vote = `/v1/subjects/${fixture.subject.id}/ratings/${question.id}/vote`;
    await json(await call('PUT', vote, fixture.member, { units: 8 }));
    const selection = `/v1/rating-questions?realm=${realmId}&limit=1`;
    const page = await json(await call('GET', selection, fixture.member));
    expect(page.ratingQuestions).toHaveLength(1);
    expect(page.next).toBeString();

    const retireKey = randomUUID();
    const retired = await json(
      await call(
        'POST',
        `/v1/rating-questions/${question.id}/$retire`,
        fixture.member,
        { expectedLifecycleRevision: 1 },
        retireKey,
      ),
    );
    expect(retired).toEqual({ questionId: question.id, lifecycle: { state: 'retired', revision: 2 } });
    expect(
      (
        await call('POST', `/v1/rating-questions/${question.id}/$restore`, fixture.member, {
          expectedLifecycleRevision: 1,
        })
      ).status,
    ).toBe(409);
    expect((await call('GET', `${selection}&cursor=${encodeURIComponent(page.next!)}`, fixture.member)).status).toBe(
      400,
    );
    const choices = await json(await call('GET', `/v1/rating-questions?realm=${realmId}`, fixture.member));
    expect(choices.ratingQuestions.map((item: { id: string }) => item.id)).toEqual([second.id]);
    const point = `/v1/rating-questions/${question.id}`;
    expect(await json(await call('GET', point, fixture.member))).toMatchObject({
      lifecycle: { state: 'retired', revision: 2 },
      canonicalLabel: definition.label,
      meaning: definition.meaning,
    });
    expect(
      (
        await call('POST', `/v1/rating-questions/${STANDARD_QUESTION_ID}/$retire`, fixture.member, {
          expectedLifecycleRevision: 1,
        })
      ).status,
    ).toBe(404);
    expect((await call('PUT', vote, fixture.member, { units: 9 })).status).toBe(409);
    expect(await json(await call('GET', vote, fixture.member))).toMatchObject({ units: 8 });

    const actor = await system.access.authenticate(fixture.member.bearer, {
      pool: system.database.pool,
      deadline: Date.now() + 30_000,
    });
    const source = createRealmRankSource({
      pool: system.database.pool,
      access: system.access,
      tokens: system.tokenKeys,
    });
    const rankRequest = {
      realmId,
      questionId: question.id,
      partition: partitionOf(routeOf(fixture.subject.id)!),
      sort: 'score_desc' as const,
      limit: 1,
    };
    await expect(source.page(actor, rankRequest, { deadline: Date.now() + 30_000 })).rejects.toMatchObject({
      name: 'RealmRankQuestionUnavailableError',
      reason: 'retired',
    });

    await json(await call('POST', '/v1/grants:revoke', fixture.owner, grant));
    expect(
      (
        await call(
          'POST',
          `/v1/rating-questions/${question.id}/$retire`,
          fixture.member,
          { expectedLifecycleRevision: 1 },
          retireKey,
        )
      ).status,
    ).toBe(403);
    expect((await call('DELETE', vote, fixture.member)).status).toBe(204);
    const retained = await system.database.pool.query(
      'SELECT units, revision FROM rating.vote WHERE voter_id=$1 AND question_id=$2 AND target_id=$3',
      [fixture.member.id, question.id, fixture.subject.id],
    );
    expect(retained.rows[0]).toMatchObject({ units: null, revision: 2 });
    expect((await call('GET', point, fixture.outsider)).status).toBe(
      (await call('GET', `/v1/rating-questions/${newId(routeOf(realmId)!)}`, fixture.outsider)).status,
    );
    expect((await call('GET', point, fixture.outsider)).status).toBe(404);

    await json(await call('POST', '/v1/grants', fixture.owner, grant), 201);
    const restored = await json(
      await call('POST', `/v1/rating-questions/${question.id}/$restore`, fixture.member, {
        expectedLifecycleRevision: 2,
      }),
    );
    expect(restored).toEqual({ questionId: question.id, lifecycle: { state: 'active', revision: 3 } });
    await expect(source.page(actor, rankRequest, { deadline: Date.now() + 30_000 })).rejects.toMatchObject({
      name: 'RealmRankQuestionUnavailableError',
      reason: 'unavailable',
    });
    expect(
      (
        await call(
          'POST',
          `/v1/rating-questions/${question.id}/$retire`,
          fixture.member,
          { expectedLifecycleRevision: 1 },
          retireKey,
        )
      ).status,
    ).toBe(409);
    await json(await call('PUT', vote, fixture.member, { units: 6 }));
    const unchanged = await system.database.pool.query(
      'SELECT owner_id, realm_id, meaning, revision, label, grain, minimum_units, maximum_units, step_units FROM rating.question WHERE id=$1',
      [question.id],
    );
    expect(unchanged.rows[0]).toEqual({
      owner_id: fixture.member.id,
      realm_id: realmId,
      meaning: definition.meaning,
      revision: 1,
      label: definition.label,
      grain: definition.grain,
      minimum_units: 0,
      maximum_units: 10,
      step_units: 1,
    });
    const events = await system.database.pool.query(
      `SELECT data->>'state' AS state, data->>'revision' AS revision, data->>'generation' AS generation
       FROM core.outbox WHERE type='com.rezics.rating.question.lifecycle-changed.v1' AND subject=$1
       ORDER BY (data->>'generation')::bigint`,
      [question.id],
    );
    expect(events.rows).toEqual([
      { state: 'retired', revision: '2', generation: '1' },
      { state: 'active', revision: '3', generation: '2' },
    ]);
  } finally {
    await driver.close();
    await closeCommunityDrivers();
  }
}, 600_000);
