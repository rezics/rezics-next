import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import type { Account } from '../../../../specs/community-driver.ts';
import { createRealmRatingQuestion, validateQuestionDefinition } from '../../src/rating/question-authoring.ts';
import { resolveRatingQuestionSelection } from '../../src/content/review-context-eligibility.ts';
import { STANDARD_QUESTION_ID } from '../../src/rating/votes.ts';
import { partitionOf, routeOf } from '../../src/route/route.ts';
import { closeCommunityDrivers, communityFixtureRuntime, createCommunityDriver } from '../community/community-driver.ts';

const definition = {
  meaning: 'Evaluate the accuracy and naturalness of this translation, independently of the original work.',
  label: 'Translation quality', grain: 'release' as const,
  scale: { min: 0, max: 10, displayStep: 1 },
};

test('a current native curator creates, replays, selects and votes on an immutable Realm question', async () => {
  const driver = await createCommunityDriver();
  try {
    const fixture = await driver.provision();
    const { system } = communityFixtureRuntime();
    const call = (method: string, path: string, actor: Account | null, body?: unknown, key = randomUUID()) =>
      driver.request({ method, path, actor, body, key: JSON.stringify(key) });
    const json = async (response: Response, status = 200) => {
      if (response.status !== status) throw new Error(`${response.status}: ${await response.text()}`);
      return response.json();
    };
    const space = (await json(await call('POST', '/v1/spaces', fixture.owner, { title: 'Question space' }), 201)).space;
    const realm = (await json(await call('POST', '/v1/realms', fixture.owner, {
      spaceId: space.spaceId, title: 'Translation curators', visibility: 'protected', contextId: fixture.contextId,
    }), 201)).realm;
    const realmId: string = realm.realmId;
    const path = `/v1/realms/${realmId}/rating-questions`;
    await json(await call('POST', `/v1/realms/${realmId}/members`, fixture.owner, { accountId: fixture.member.id }), 202);
    await driver.settle();
    // Membership alone provides no question-authoring authority.
    expect((await call('POST', path, fixture.member, definition)).status).toBe(403);
    expect((await call('POST', path, fixture.outsider, definition)).status).toBe(403);
    const grant = {
      resource: { route: routeOf(realmId), id: realmId }, subject: { kind: 'account', id: fixture.member.id },
      actions: ['realm:manage'], valid: '(,)',
    };
    await json(await call('POST', '/v1/grants', fixture.owner, grant), 201);
    const key = randomUUID();
    const created = await json(await call('POST', path, fixture.member, definition, key), 201);
    expect(created).toMatchObject({ ...definition, realmId, revision: 1 });
    expect(routeOf(created.id)).toBe(routeOf(realmId));
    expect(await json(await call('POST', path, fixture.member, definition, key), 201)).toEqual(created);
    expect((await call('POST', path, fixture.member, { ...definition, meaning: 'Different meaning' }, key)).status).toBe(422);
    const current = await system.database.pool.query(
      'SELECT owner_id, realm_id, meaning FROM rating.question WHERE id=$1', [created.id]);
    expect(current.rows[0]).toEqual({ owner_id: fixture.member.id, realm_id: realmId, meaning: definition.meaning });
    const event = await system.database.pool.query(
      `SELECT count(*)::integer AS n FROM core.outbox WHERE type='com.rezics.rating.question.created.v1' AND subject=$1`,
      [created.id]);
    expect(event.rows[0].n).toBe(1);
    const point = `/v1/rating-questions/${created.id}`;
    expect(await json(await call('GET', point, fixture.member))).toEqual(created);
    const actor = await system.access.authenticate(fixture.member.bearer, {
      pool: system.database.pool, deadline: Date.now() + 30_000,
    });
    expect((await resolveRatingQuestionSelection({ pool: system.database.pool, access: system.access }, created.id,
      { actor, deadline: Date.now() + 30_000 })).question.label).toBe(definition.label);
    const binary = await json(await call('POST', path, fixture.member, {
      ...definition, label: 'Accurate translation', scale: { min: 0, max: 1, displayStep: 1 },
    }), 201);
    const selection = `/v1/rating-questions?realm=${realmId}&limit=1`;
    const first = await json(await call('GET', selection, fixture.member));
    expect(first.ratingQuestions).toHaveLength(1);
    expect(first.next).toBeString();
    const second = await json(await call('GET', `${selection}&cursor=${encodeURIComponent(first.next)}`, fixture.member));
    expect(new Set([...first.ratingQuestions, ...second.ratingQuestions].map((q: { id: string }) => q.id)))
      .toEqual(new Set([created.id, binary.id]));
    expect(second.next).toBeNull();
    expect((await call('GET', `/v1/rating-questions?limit=1&cursor=${encodeURIComponent(first.next)}`, fixture.member)).status).toBe(400);
    expect((await call('GET', `${selection}&cursor=${encodeURIComponent(first.next)}`, fixture.owner)).status).toBe(400);
    const global = await json(await call('GET', '/v1/rating-questions', null));
    expect(global.ratingQuestions.some((q: { id: string }) => q.id === created.id || q.id === binary.id)).toBe(false);
    expect(await json(await call('GET', `/v1/rating-questions/${STANDARD_QUESTION_ID}`, null))).toEqual({
      id: STANDARD_QUESTION_ID, revision: 1, label: 'How much did you like this work?', grain: 'work',
      scale: { min: 0, max: 20, displayStep: 1 },
    });
    const vote = `/v1/subjects/${fixture.subject.id}/ratings/${created.id}/vote`;
    await json(await call('PUT', vote, fixture.member, { units: 10 }));
    expect((await call('PUT', vote, fixture.member, { units: 11 })).status).toBe(400);
    for (const principal of [fixture.outsider, null]) {
      expect((await call('GET', point, principal)).status).toBe(404);
      expect((await call('GET', selection, principal)).status).toBe(404);
      expect((await call('GET', `/v1/subjects/${fixture.subject.id}/ratings?question=${created.id}&population=${realmId}`, principal)).status).toBe(404);
    }
    expect((await call('PUT', vote, fixture.outsider, { units: 1 })).status).toBe(404);
    await json(await call('POST', '/v1/grants:revoke', fixture.owner, grant));
    // Exact receipt replay still requires manage authority after it is revoked.
    expect((await call('POST', path, fixture.member, definition, key)).status).toBe(403);
    expect(await json(await call('GET', point, fixture.member))).toEqual(created);
    await json(await call('PUT', `/v1/realms/${realmId}/bans/${fixture.member.id}`, fixture.owner, { reason: 'Read boundary' }));
    expect((await call('GET', point, fixture.member)).status).toBe(404);
    expect((await call('GET', selection, fixture.member)).status).toBe(404);
    expect((await call('PUT', vote, fixture.member, { units: 9 })).status).toBe(404);
    // Native API rejects unsupported bounds before they reach the installed 0..20 path.
    expect((await call('POST', path, fixture.owner, { ...definition, scale: { min: 0, max: 21, displayStep: 1 } })).status).toBe(400);
    const authenticatedOwner = await system.access.authenticate(fixture.owner.bearer, {
      pool: system.database.pool, deadline: Date.now() + 30_000,
    });
    const native = await createRealmRatingQuestion({ pool: system.database.pool, access: system.access }, authenticatedOwner,
      { ...definition, realmId, label: 'Native binary', scale: { min: 0, max: 1, displayStep: 1 } },
      { deadline: Date.now() + 30_000, idempotencyKey: randomUUID() });
    expect(native.partition).toBe(partitionOf(routeOf(realmId)!));
    expect(native.value.realmId).toBe(realmId);
  } finally {
    await driver.close();
    await closeCommunityDrivers();
  }
}, 600_000);

test('definitions admit only bounded nonempty meanings, labels and installed stored-unit scales', () => {
  const realmId = '00000000-0000-7000-8000-240100000001';
  for (const scale of [{ min: 0, max: 1, displayStep: 1 }, { min: 0, max: 10, displayStep: 1 },
    { min: 2, max: 20, displayStep: 2 }])
    expect(() => validateQuestionDefinition({ ...definition, realmId, scale })).not.toThrow();
  for (const scale of [{ min: -1, max: 10, displayStep: 1 }, { min: 0, max: 21, displayStep: 1 },
    { min: 0, max: 10, displayStep: 3 }, { min: 1, max: 1, displayStep: 1 },
    { min: 0, max: 10, displayStep: 0 }])
    expect(() => validateQuestionDefinition({ ...definition, realmId, scale })).toThrow();
  for (const fields of [{ label: ' ' }, { meaning: '' }, { meaning: 'x'.repeat(2001) }, { label: '\0' }])
    expect(() => validateQuestionDefinition({ ...definition, realmId, ...fields })).toThrow();
});
