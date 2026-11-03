import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import type { Account, Method } from '../../../../specs/community-driver.ts';
import { validateQuestionLabel } from '../../src/rating/question-label.ts';
import { STANDARD_QUESTION_ID } from '../../src/rating/votes.ts';
import { routeOf } from '../../src/route/route.ts';
import { closeCommunityDrivers, communityFixtureRuntime, createCommunityDriver } from '../community/community-driver.ts';

const definition = {
  meaning: 'Evaluate translation accuracy independently of enjoyment.', label: 'Translaton quality',
  grain: 'release', scale: { min: 0, max: 10, displayStep: 1 },
};

test('native curator captions preserve measurement, exact wording, bounded history and current disclosure', async () => {
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
    const space = (await json(await call('POST', '/v1/spaces', fixture.owner, { title: 'Caption space' }), 201)).space;
    const realmId = (await json(await call('POST', '/v1/realms', fixture.owner, {
      spaceId: space.spaceId, title: 'Translation captions', visibility: 'protected', contextId: fixture.contextId,
    }), 201)).realm.realmId;
    await json(await call('POST', `/v1/realms/${realmId}/members`, fixture.owner, { accountId: fixture.member.id }), 202);
    await driver.settle();
    const grant = { resource: { route: routeOf(realmId), id: realmId },
      subject: { kind: 'account', id: fixture.member.id }, actions: ['realm:manage'], valid: '(,)' };
    await json(await call('POST', '/v1/grants', fixture.owner, grant), 201);
    const created = await json(await call('POST', `/v1/realms/${realmId}/rating-questions`, fixture.member, definition), 201);
    const point = `/v1/rating-questions/${created.id}`;
    const history = `${point}/labels`;
    const command = `${point}/label`;
    const votePath = `/v1/subjects/${fixture.subject.id}/ratings/${created.id}/vote`;
    const beforeVote = await json(await call('PUT', votePath, fixture.member, { units: 10 }));
    const measurement = () => system.database.pool.query('SELECT * FROM rating.question WHERE id=$1', [created.id]);
    const original = (await measurement()).rows[0];
    const input = { expectedLabelRevision: 1, label: 'Translation quality' };
    const key = randomUUID();
    const corrected = await json(await call('PUT', command, fixture.member, input, key));
    expect(corrected).toEqual({ questionId: created.id, labelRevision: 2, label: input.label });
    expect(await json(await call('PUT', command, fixture.member, input, key))).toEqual(corrected);
    expect((await call('PUT', command, fixture.member, { ...input, label: 'Changed retry' }, key)).status).toBe(422);
    expect((await call('PUT', command, fixture.member, { ...input, label: 'Stale revision' })).status).toBe(409);
    expect(await json(await call('GET', point, fixture.member))).toEqual({
      ...created, label: input.label, canonicalLabel: definition.label, labelRevision: 2,
    });
    expect((await json(await call('GET', history, fixture.member))).labels.map((v: { label: string }) => v.label))
      .toEqual([definition.label, input.label]);
    expect(await json(await call('GET', `${history}/1`, fixture.member))).toMatchObject({
      questionId: created.id, labelRevision: 1, label: definition.label, at: null, author: { id: fixture.member.id },
    });
    const exactSecond = await json(await call('GET', `${history}/2`, fixture.member));
    expect(exactSecond).toMatchObject({ label: input.label, author: { id: fixture.member.id, state: 'active' } });
    expect(typeof exactSecond.at).toBe('string');
    const selection = await json(await call('GET', `/v1/rating-questions?realm=${realmId}`, fixture.member));
    expect(selection.ratingQuestions).toContainEqual({ ...created, label: input.label, labelRevision: 2 });
    const first = await json(await call('GET', `${history}?limit=1`, fixture.member));
    expect(first.labels.map((v: { labelRevision: number }) => v.labelRevision)).toEqual([1]);
    expect(typeof first.next).toBe('string');
    const continuation = `${history}?limit=1&cursor=${encodeURIComponent(first.next)}`;
    expect((await call('GET', continuation, fixture.owner)).status).toBe(400);
    expect((await call('GET', `${history}?limit=2&cursor=${encodeURIComponent(first.next)}`, fixture.member)).status).toBe(400);
    expect((await call('GET', `${history}?limit=1&limit=1`, fixture.member)).status).toBe(400);
    expect((await call('GET', `${history}?limit=1&cursor=invalid`, fixture.member)).status).toBe(400);
    // Two writers at one exact head yield one immutable correction, never two.
    const concurrent = await Promise.all(['Translation score', 'Translation quality score'].map(label =>
      call('PUT', command, fixture.member, { expectedLabelRevision: 2, label })));
    expect(concurrent.map(r => r.status).sort()).toEqual([200, 409]);
    const second = await json(await call('GET', continuation, fixture.member));
    expect(second.labels).toEqual([exactSecond]);
    expect(second.next).toBeNull(); // Initial ceiling excludes the concurrent append.
    expect(await json(await call('GET', `${history}/2`, fixture.member))).toEqual(exactSecond);
    const complete = await json(await call('GET', history, fixture.member));
    expect(complete.labels.map((v: { labelRevision: number }) => v.labelRevision)).toEqual([1, 2, 3]);
    expect((await measurement()).rows[0]).toEqual(original);
    expect(await json(await call('GET', votePath, fixture.member))).toEqual(beforeVote);
    for (const actor of [fixture.outsider, null]) {
      expect((await call('GET', history, actor)).status).toBe(404);
      expect((await call('GET', `${history}/2`, actor)).status).toBe(404);
      expect((await call('GET', continuation, actor)).status).toBe(404);
    }
    expect((await call('PUT', command, fixture.outsider, input)).status).toBe(404);
    expect((await call('PUT', `/v1/rating-questions/${STANDARD_QUESTION_ID}/label`, fixture.owner, input)).status).toBe(404);
    expect((await call('GET', `${history}/999`, fixture.member)).status).toBe(404);
    await json(await call('POST', '/v1/grants:revoke', fixture.owner, grant));
    expect((await call('PUT', command, fixture.member, input, key)).status).toBe(403);
    expect((await json(await call('GET', history, fixture.member))).labels).toEqual(complete.labels);
    await json(await call('PUT', `/v1/realms/${realmId}/bans/${fixture.member.id}`, fixture.owner, { reason: 'Caption disclosure' }));
    expect((await call('GET', history, fixture.member)).status).toBe(404);
    expect((await call('GET', continuation, fixture.member)).status).toBe(404);
    expect((await call('GET', `${history}/1`, fixture.member)).status).toBe(404);
    expect((await call('PUT', command, fixture.member, input, key)).status).toBe(404);
    expect((await measurement()).rows[0]).toEqual(original);
  } finally {
    await driver.close();
    await closeCommunityDrivers();
  }
}, 600_000);

test('caption bounds retain exact valid bytes and reject blank, NUL, oversized and inexact revisions', () => {
  const input = { questionId: '00000000-0000-7000-8000-240100000001', expectedLabelRevision: 1, label: '  Translation quality  ' };
  expect(() => validateQuestionLabel(input)).not.toThrow();
  expect(() => validateQuestionLabel({ ...input, label: '😀'.repeat(200) })).not.toThrow();
  for (const fields of [{ label: ' ' }, { label: '\0' }, { label: '😀'.repeat(201) },
    { expectedLabelRevision: 0 }, { expectedLabelRevision: 1.5 }, { expectedLabelRevision: 2_147_483_647 }])
    expect(() => validateQuestionLabel({ ...input, ...fields })).toThrow();
});
