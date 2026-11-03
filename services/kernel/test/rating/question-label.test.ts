import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import type { Account, Method } from '../../../../specs/community-driver.ts';
import { validateQuestionLabel } from '../../src/rating/question-label.ts';
import { STANDARD_QUESTION_ID } from '../../src/rating/votes.ts';
import publicIdentityPage from '../../src/access/public-identity-page.sql';
import labelPage from '../../src/rating/question-label-page.sql';
import { partitionOf, routeOf } from '../../src/route/route.ts';
import { accountDeletionRuntime, deletePersona } from '../support/account-deletion.ts';
import { observeSql } from '../content/support/sql-observer.ts';
import {
  closeCommunityDrivers,
  communityFixtureRuntime,
  createCommunityDriver,
} from '../community/community-driver.ts';

const definition = {
  meaning: 'Evaluate translation accuracy independently of enjoyment.',
  label: 'Translaton quality',
  grain: 'release',
  scale: { min: 0, max: 10, displayStep: 1 },
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
    const realmId = (
      await json(
        await call('POST', '/v1/realms', fixture.owner, {
          spaceId: space.spaceId,
          title: 'Translation captions',
          visibility: 'protected',
          contextId: fixture.contextId,
        }),
        201,
      )
    ).realm.realmId;
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
    const created = await json(
      await call('POST', `/v1/realms/${realmId}/rating-questions`, fixture.member, definition),
      201,
    );
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
      ...created,
      label: input.label,
      canonicalLabel: definition.label,
      labelRevision: 2,
    });
    expect(
      (await json(await call('GET', history, fixture.member))).labels.map((v: { label: string }) => v.label),
    ).toEqual([definition.label, input.label]);
    expect(await json(await call('GET', `${history}/1`, fixture.member))).toMatchObject({
      questionId: created.id,
      labelRevision: 1,
      label: definition.label,
      at: null,
      author: { id: fixture.member.id },
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
    const replacement = await system.auth.issue({
      accountId: fixture.member.id,
      clientId: system.auth.websiteClient.id,
      scopes: system.auth.ordinaryScopes,
    });
    const replacementActor = { id: fixture.member.id, bearer: replacement.bearer };
    expect((await call('GET', continuation, replacementActor)).status).toBe(400);
    expect((await json(await call('GET', `${history}?limit=1`, replacementActor))).labels).toEqual(first.labels);
    expect(
      (await call('GET', `${history}?limit=2&cursor=${encodeURIComponent(first.next)}`, fixture.member)).status,
    ).toBe(400);
    expect((await call('GET', `${history}?limit=1&limit=1`, fixture.member)).status).toBe(400);
    expect((await call('GET', `${history}?limit=1&cursor=invalid`, fixture.member)).status).toBe(400);
    // Two writers at one exact head yield one immutable correction, never two.
    const concurrent = await Promise.all(
      ['Translation score', 'Translation quality score'].map((label) =>
        call('PUT', command, fixture.member, { expectedLabelRevision: 2, label }),
      ),
    );
    expect(concurrent.map((r) => r.status).sort()).toEqual([200, 409]);
    const second = await json(await call('GET', continuation, fixture.member));
    expect(second.labels).toEqual([exactSecond]);
    expect(second.next).toBeNull(); // Initial ceiling excludes the concurrent append.
    expect(await json(await call('GET', `${history}/2`, fixture.member))).toEqual(exactSecond);
    const complete = await json(await call('GET', history, fixture.member));
    expect(complete.labels.map((v: { labelRevision: number }) => v.labelRevision)).toEqual([1, 2, 3]);
    expect((await measurement()).rows[0]).toEqual(original);
    expect(await json(await call('GET', votePath, fixture.member))).toEqual(beforeVote);

    const questionHome = partitionOf(routeOf(created.id)!);
    const partition = await system.database.pool.query<{ epoch: number }>(
      'SELECT epoch FROM core.partition WHERE partition_no=$1',
      [questionHome],
    );
    const originalEpoch = Number(partition.rows[0]!.epoch);
    await system.database.pool.query('UPDATE core.partition SET epoch=$2 WHERE partition_no=$1', [
      questionHome,
      originalEpoch + 1,
    ]);
    try {
      const stale = await call('GET', continuation, fixture.member);
      expect(stale.status).toBe(409);
      expect(await stale.json()).toMatchObject({ code: 'stale_cursor' });
      expect((await json(await call('GET', `${history}?limit=1`, fixture.member))).labels).toEqual([
        expect.objectContaining({ labelRevision: 1 }),
      ]);
    } finally {
      await system.database.pool.query('UPDATE core.partition SET epoch=$2 WHERE partition_no=$1', [
        questionHome,
        originalEpoch,
      ]);
    }

    for (const actor of [fixture.outsider, null]) {
      expect((await call('GET', history, actor)).status).toBe(404);
      expect((await call('GET', `${history}/2`, actor)).status).toBe(404);
      expect((await call('GET', continuation, actor)).status).toBe(404);
    }
    expect((await call('PUT', command, fixture.outsider, input)).status).toBe(404);
    expect((await call('PUT', `/v1/rating-questions/${STANDARD_QUESTION_ID}/label`, fixture.owner, input)).status).toBe(
      404,
    );
    expect((await call('GET', `${history}/999`, fixture.member)).status).toBe(404);
    await json(await call('POST', '/v1/grants:revoke', fixture.owner, grant));
    expect((await call('PUT', command, fixture.member, input, key)).status).toBe(403);
    expect((await json(await call('GET', history, fixture.member))).labels).toEqual(complete.labels);
    await json(
      await call('PUT', `/v1/realms/${realmId}/bans/${fixture.member.id}`, fixture.owner, {
        reason: 'Caption disclosure',
      }),
    );
    expect((await call('GET', history, fixture.member)).status).toBe(404);
    expect((await call('GET', continuation, fixture.member)).status).toBe(404);
    expect((await call('GET', `${history}/1`, fixture.member)).status).toBe(404);
    expect((await call('PUT', command, fixture.member, input, key)).status).toBe(404);
    expect((await measurement()).rows[0]).toEqual(original);

    await json(await call('POST', `${point}/$retire`, fixture.owner, { expectedLifecycleRevision: 1 }));
    expect((await json(await call('GET', point, fixture.owner))).lifecycle).toEqual({ state: 'retired', revision: 2 });
    expect((await json(await call('GET', history, fixture.owner))).labels).toEqual(complete.labels);
  } finally {
    await driver.close();
    await closeCommunityDrivers();
  }
}, 600_000);

test.serial(
  'history finishes source and author observations after later identity hydration and retries dependency failure',
  async () => {
    const driver = await createCommunityDriver();
    try {
      const fixture = await driver.provision();
      const { system } = communityFixtureRuntime();
      const deletion = accountDeletionRuntime(system);
      const author = await deletion.person();
      const authorActor: Account = { id: author.accountId, bearer: author.bearer };
      const call = (method: Method, path: string, actor: Account | null, body?: unknown, key = randomUUID()) =>
        driver.request({ method, path, actor, body, key: JSON.stringify(key) });
      const json = async (response: Response, status = 200) => {
        if (response.status !== status) throw new Error(`${response.status}: ${await response.text()}`);
        return response.json();
      };

      await json(
        await call('PATCH', `/v1/accounts/${author.accountId}`, authorActor, { displayName: 'Private caption author' }),
      );
      const space = (
        await json(await call('POST', '/v1/spaces', fixture.owner, { title: 'Caption observations' }), 201)
      ).space;
      const realmId = (
        await json(
          await call('POST', '/v1/realms', fixture.owner, {
            spaceId: space.spaceId,
            title: 'Caption observation Realm',
            visibility: 'protected',
            contextId: fixture.contextId,
          }),
          201,
        )
      ).realm.realmId;
      for (const account of [fixture.member, authorActor])
        await json(await call('POST', `/v1/realms/${realmId}/members`, fixture.owner, { accountId: account.id }), 202);
      await driver.settle();
      for (const account of [fixture.member, authorActor])
        await json(
          await call('POST', '/v1/grants', fixture.owner, {
            resource: { route: routeOf(realmId), id: realmId },
            subject: { kind: 'account', id: account.id },
            actions: ['realm:manage'],
            valid: '(,)',
          }),
          201,
        );

      const created = await json(
        await call('POST', `/v1/realms/${realmId}/rating-questions`, fixture.owner, definition),
        201,
      );
      const history = `/v1/rating-questions/${created.id}/labels?limit=20`;
      const command = `/v1/rating-questions/${created.id}/label`;
      await json(await call('PUT', command, authorActor, { expectedLabelRevision: 1, label: 'Corrected by author' }));
      await json(
        await call('PUT', command, fixture.member, { expectedLabelRevision: 2, label: 'Current member caption' }),
      );

      const privacyObserver = observeSql(system.database.pool);
      const privacyBarrier = privacyObserver.hold({ statement: publicIdentityPage.sql, occurrence: 2 }, 'after');
      const privateRead = call('GET', history, fixture.owner);
      let privateLabels:
        | {
            labels: {
              labelRevision: number;
              author: { id: string; state: string; displayName?: string | null } | null;
            }[];
          }
        | undefined;
      try {
        await privacyBarrier.entered;
        await json(await call('PATCH', `/v1/accounts/${author.accountId}`, authorActor, { displayName: null }));
        privacyBarrier.release();
        privateLabels = await json(await privateRead);
      } finally {
        privacyBarrier.release();
        await privacyObserver.close();
      }
      expect(privateLabels!.labels[1]!.author).toMatchObject({
        id: author.accountId,
        state: 'active',
        displayName: null,
      });

      await json(await call('PATCH', `/v1/accounts/${author.accountId}`, authorActor, { displayName: 'Exact author' }));
      const exactObserver = observeSql(system.database.pool);
      const exactBarrier = exactObserver.hold({ statement: publicIdentityPage.sql }, 'after');
      const exactRead = call('GET', `/v1/rating-questions/${created.id}/labels/2`, fixture.owner);
      try {
        await exactBarrier.entered;
        await json(await call('PATCH', `/v1/accounts/${author.accountId}`, authorActor, { displayName: null }));
        exactBarrier.release();
        expect(await json(await exactRead)).toMatchObject({
          label: 'Corrected by author',
          author: { id: author.accountId, state: 'active', displayName: null },
        });
      } finally {
        exactBarrier.release();
        await exactObserver.close();
      }

      const erasureObserver = observeSql(system.database.pool);
      const erasureBarrier = erasureObserver.hold({ statement: publicIdentityPage.sql, occurrence: 2 }, 'after');
      const erasedRead = call('GET', history, fixture.owner);
      let erasedLabels: typeof privateLabels;
      try {
        await erasureBarrier.entered;
        await deletePersona({ pool: system.database.pool, auth: deletion.auth }, author);
        erasureBarrier.release();
        erasedLabels = await json(await erasedRead);
      } finally {
        erasureBarrier.release();
        await erasureObserver.close();
      }
      expect(erasedLabels!.labels[1]!.author).toMatchObject({ id: author.accountId, state: 'deleted' });
      expect(erasedLabels!.labels[1]!.author).not.toHaveProperty('displayName');

      const expected = await json(await call('GET', history, fixture.owner));
      const retryObserver = observeSql(system.database.pool);
      retryObserver.armFault({
        match: { statement: publicIdentityPage.sql },
        boundary: 'before',
        error: new Error('Identity home unavailable'),
      });
      try {
        expect((await call('GET', history, fixture.owner)).status).toBe(503);
        expect(await json(await call('GET', history, fixture.owner))).toEqual(expected);
      } finally {
        await retryObserver.close();
      }

      const first = await json(await call('GET', history.replace('limit=20', 'limit=1'), fixture.owner));
      const continuation = `${history.replace('limit=20', 'limit=1')}&cursor=${encodeURIComponent(first.next)}`;
      const expectedPage = await json(await call('GET', continuation, fixture.owner));
      const sourceObserver = observeSql(system.database.pool);
      sourceObserver.armFault({
        match: { statement: labelPage.sql, occurrence: 2 },
        boundary: 'before',
        error: new Error('Caption source unavailable'),
      });
      try {
        expect((await call('GET', continuation, fixture.owner)).status).toBe(503);
        expect(await json(await call('GET', continuation, fixture.owner))).toEqual(expectedPage);
      } finally {
        await sourceObserver.close();
      }

      const home = partitionOf(routeOf(created.id)!);
      const {
        rows: [partition],
      } = await system.database.pool.query<{ epoch: number }>(
        'SELECT epoch FROM core.partition WHERE partition_no=$1',
        [home],
      );
      const epochObserver = observeSql(system.database.pool);
      const epochBarrier = epochObserver.hold({ statement: labelPage.sql, occurrence: 2 }, 'after');
      const movingRead = call('GET', continuation, fixture.owner);
      try {
        await epochBarrier.entered;
        await system.database.pool.query('UPDATE core.partition SET epoch=epoch+1 WHERE partition_no=$1', [home]);
        epochBarrier.release();
        expect((await movingRead).status).toBe(409);
        expect((await call('GET', continuation, fixture.owner)).status).toBe(409);
        const restarted = await json(await call('GET', history.replace('limit=20', 'limit=1'), fixture.owner));
        expect(restarted.labels[0].labelRevision).toBe(1);
        expect(restarted.next).not.toBe(first.next);
      } finally {
        epochBarrier.release();
        await epochObserver.close();
        await system.database.pool.query('UPDATE core.partition SET epoch=$2 WHERE partition_no=$1', [
          home,
          partition!.epoch,
        ]);
      }
    } finally {
      await driver.close();
      await closeCommunityDrivers();
    }
  },
  600_000,
);

test('caption bounds retain exact valid bytes and reject blank, NUL, oversized and inexact revisions', () => {
  const input = {
    questionId: '00000000-0000-7000-8000-240100000001',
    expectedLabelRevision: 1,
    label: '  Translation quality  ',
  };
  expect(() => validateQuestionLabel(input)).not.toThrow();
  expect(() => validateQuestionLabel({ ...input, label: '😀'.repeat(200) })).not.toThrow();
  for (const fields of [
    { label: ' ' },
    { label: '\0' },
    { label: '😀'.repeat(201) },
    { expectedLabelRevision: 0 },
    { expectedLabelRevision: 1.5 },
    { expectedLabelRevision: 2_147_483_647 },
  ])
    expect(() => validateQuestionLabel({ ...input, ...fields })).toThrow();
});
