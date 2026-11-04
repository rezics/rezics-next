import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import type { Account, Method } from '../../../../specs/community-driver.ts';
import { routeOf } from '../../src/route/route.ts';
import { STANDARD_QUESTION_ID } from '../../src/rating/votes.ts';
import { readQuestionManagementPage } from '../../src/rating/question-management.ts';
import { AccessUnavailableError } from '../../src/access/unavailable.ts';
import labelPage from '../../src/rating/question-label-page.sql';
import { accountDeletionRuntime, deletePersona } from '../support/account-deletion.ts';
import { observeSql } from '../content/support/sql-observer.ts';
import {
  closeCommunityDrivers,
  communityFixtureRuntime,
  createCommunityDriver,
} from '../community/community-driver.ts';

const definition = {
  meaning: 'Judge translation accuracy independently of enjoyment of the original work.',
  label: 'Translation accuracy',
  grain: 'release',
  scale: { min: 0, max: 20, displayStep: 2 },
};

test('Realm management advice composes native immutable creation, caption CAS and independent lifecycle commands', async () => {
  const driver = await createCommunityDriver();
  try {
    const fixture = await driver.provision();
    const call = (method: Method, path: string, actor: Account | null, body?: unknown, key = randomUUID()) =>
      driver.request({ method, path, actor, body, key: JSON.stringify(key) });
    const json = async (response: Response, status = 200) => {
      if (response.status !== status) throw new Error(`${response.status}: ${await response.text()}`);
      return response.json();
    };
    const space = (await json(await call('POST', '/v1/spaces', fixture.owner, { title: 'Question management' }), 201))
      .space;
    const realmId: string = (
      await json(
        await call('POST', '/v1/realms', fixture.owner, {
          spaceId: space.spaceId,
          title: 'Translation questions',
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
    const management = `/v1/realms/${realmId}/rating-questions/management`;
    const empty = await json(await call('GET', management, fixture.owner));
    expect(empty.directory).toEqual({ ratingQuestions: [], next: null });
    expect(empty.selected).toBeNull();
    const create = empty.actions.create;
    expect(create).toEqual({ method: 'POST', href: `/v1/realms/${realmId}/rating-questions` });
    expect((await json(await call('GET', management, fixture.member))).actions.create).toBeNull();
    expect((await call('POST', create.href, fixture.member, definition)).status).toBe(403);
    expect((await call('GET', management, fixture.outsider)).status).toBe(404);
    expect((await call('GET', management, null)).status).toBe(401);
    expect(
      (await call('GET', `/v1/realms/${fixture.unknown.realm}/rating-questions/management`, fixture.owner)).status,
    ).toBe(404);
    expect(
      (await call('POST', create.href, fixture.owner, { ...definition, scale: { min: 0, max: 20, displayStep: 3 } }))
        .status,
    ).toBe(400);

    const grant = {
      resource: { route: routeOf(realmId), id: realmId },
      subject: { kind: 'account', id: fixture.member.id },
      actions: ['realm:manage'],
      valid: '(,)',
    };
    await json(await call('POST', '/v1/grants', fixture.owner, grant), 201);
    // A lost acknowledgement is retried with the original body and key.
    const key = randomUUID();
    const created = await json(await call('POST', create.href, fixture.member, definition, key), 201);
    expect(await json(await call('POST', create.href, fixture.member, definition, key), 201)).toEqual(created);
    expect(
      (await call('POST', create.href, fixture.member, { ...definition, meaning: 'Changed meaning' }, key)).status,
    ).toBe(422);
    const selectedPath = `${management}?selectedQuestionId=${created.id}`;
    const selected = (await json(await call('GET', selectedPath, fixture.member))).selected;
    expect(selected.question).toEqual(created);
    const caption = selected.actions.caption;
    expect(caption).toEqual({
      method: 'PUT',
      href: `/v1/rating-questions/${created.id}/label`,
      expectedLabelRevision: 1,
    });
    expect(selected.actions.lifecycle).toEqual({
      method: 'POST',
      href: `/v1/rating-questions/${created.id}/$retire`,
      expectedLifecycleRevision: 1,
    });
    expect(
      (
        await call('PUT', caption.href, fixture.member, {
          expectedLabelRevision: 1,
          label: 'Corrected caption',
          meaning: 'Rewritten',
        })
      ).status,
    ).toBe(400);
    const labelBody = { expectedLabelRevision: caption.expectedLabelRevision, label: 'Corrected caption' };
    const labelKey = randomUUID();
    const renamed = await json(await call('PUT', caption.href, fixture.member, labelBody, labelKey));
    expect(await json(await call('PUT', caption.href, fixture.member, labelBody, labelKey))).toEqual(renamed);
    expect(
      (await call('PUT', caption.href, fixture.member, { ...labelBody, label: 'Concurrent stale edit' })).status,
    ).toBe(409);
    const retire = selected.actions.lifecycle;
    const lifecycleBody = { expectedLifecycleRevision: retire.expectedLifecycleRevision };
    const lifecycleKey = randomUUID();
    const retired = await json(await call('POST', retire.href, fixture.member, lifecycleBody, lifecycleKey));
    expect(await json(await call('POST', retire.href, fixture.member, lifecycleBody, lifecycleKey))).toEqual(retired);
    const after = await json(await call('GET', selectedPath, fixture.member));
    expect(after.directory.ratingQuestions).toEqual([]);
    expect(after.selected.question).toEqual({
      ...created,
      label: labelBody.label,
      labelRevision: 2,
      lifecycle: { state: 'retired', revision: 2 },
    });
    expect(after.selected.actions.caption.expectedLabelRevision).toBe(2);
    expect(after.selected.actions.lifecycle).toEqual({
      method: 'POST',
      href: `/v1/rating-questions/${created.id}/$restore`,
      expectedLifecycleRevision: 2,
    });
    const history = await json(await call('GET', after.selected.history, fixture.member));
    expect(history.labels.map((label: { labelRevision: number }) => label.labelRevision)).toEqual([1, 2]);
    expect(await json(await call('GET', `${after.selected.history}/1`, fixture.member))).toMatchObject({
      label: definition.label,
      at: null,
      author: { id: fixture.member.id, state: 'active' },
    });
    await json(
      await call('POST', after.selected.actions.lifecycle.href, fixture.member, { expectedLifecycleRevision: 2 }),
    );
    expect((await call('POST', retire.href, fixture.member, lifecycleBody, lifecycleKey)).status).toBe(409);
    const { system } = communityFixtureRuntime();
    const actor = await system.access.authenticate(fixture.member.bearer, {
      pool: system.database.pool,
      deadline: Date.now() + 30_000,
    });
    const input = Object.freeze({ realmId, selectedQuestionId: created.id });
    const native = { pool: system.database.pool, access: system.access, tokens: system.tokenKeys };
    await expect(
      readQuestionManagementPage(
        {
          ...native,
          access: {
            ...system.access,
            async prepare(caller, action, resource, context) {
              if (action === 'realm:manage') throw new AccessUnavailableError('overloaded');
              return system.access.prepare?.(caller, action, resource, context);
            },
          },
        },
        actor,
        input,
        Date.now() + 30_000,
      ),
    ).rejects.toMatchObject({ reason: 'overloaded' });
    // A caption change during foreign advice preparation requires fresh selected inspection.
    let changed = false;
    await expect(
      readQuestionManagementPage(
        {
          ...native,
          access: {
            ...system.access,
            async prepare(caller, action, resource, context) {
              const evidence = await system.access.prepare?.(caller, action, resource, context);
              if (action === 'realm:manage' && !changed) {
                changed = true;
                await json(
                  await call('PUT', caption.href, fixture.member, {
                    expectedLabelRevision: 2,
                    label: 'Latest caption',
                  }),
                );
              }
              return evidence;
            },
          },
        },
        actor,
        input,
        Date.now() + 30_000,
      ),
    ).rejects.toMatchObject({ code: 'conflict' });
    await json(await call('POST', '/v1/grants:revoke', fixture.owner, grant));
    const readonly = (await json(await call('GET', selectedPath, fixture.member))).selected;
    expect(readonly.actions).toEqual({ caption: null, lifecycle: null });
    // Creation/ownership and retained receipts cannot substitute for current authority.
    expect((await call('POST', create.href, fixture.member, definition, key)).status).toBe(403);
    expect((await call('PUT', caption.href, fixture.member, labelBody, labelKey)).status).toBe(403);
    await driver.suspend(fixture.member);
    expect((await call('GET', selectedPath, fixture.member)).status).toBe(403);
    expect((await call('GET', `${management}?selectedQuestionId=${STANDARD_QUESTION_ID}`, fixture.owner)).status).toBe(
      404,
    );

    // Raw continuation remains bounded and bound to authority, selection and native lifecycle generation.
    for (let index = 0; index < 20; index++)
      await json(await call('POST', create.href, fixture.owner, { ...definition, label: `Question ${index}` }), 201);
    const first = await json(await call('GET', `${management}?selectedQuestionId=${created.id}`, fixture.owner));
    expect(first.directory.ratingQuestions).toHaveLength(20);
    expect(first.directory.next.length).toBeLessThanOrEqual(4096);
    expect(Buffer.byteLength(JSON.stringify(first))).toBeLessThanOrEqual(1_048_576);
    const frontier = `${management}?selectedQuestionId=${created.id}&cursor=${encodeURIComponent(first.directory.next)}`;
    const next = await json(await call('GET', frontier, fixture.owner));
    expect(next.directory.ratingQuestions).toHaveLength(1);
    expect(next.directory.next).toBeNull();
    expect(await json(await call('GET', frontier, fixture.owner))).toEqual(next);
    expect(
      (await call('GET', `${management}?cursor=${encodeURIComponent(first.directory.next)}`, fixture.owner)).status,
    ).toBe(400);
    await json(await call('POST', retire.href, fixture.owner, { expectedLifecycleRevision: 3 }));
    expect((await call('GET', frontier, fixture.owner)).status).toBe(400);
    expect((await call('GET', `${management}?cursor=${'x'.repeat(4097)}`, fixture.owner)).status).toBe(400);
    expect(
      (
        await call(
          'GET',
          `${management}?selectedQuestionId=${created.id}&selectedQuestionId=${created.id}`,
          fixture.owner,
        )
      ).status,
    ).toBe(400);
  } finally {
    await driver.close();
    await closeCommunityDrivers();
  }
}, 600_000);

test.serial('management keeps deleted caption authors canonical and failed history continuation retryable', async () => {
  const driver = await createCommunityDriver();
  try {
    const fixture = await driver.provision();
    const { system } = communityFixtureRuntime();
    const deletion = accountDeletionRuntime(system);
    const author = await deletion.person();
    const authorAccount: Account = { id: author.accountId, bearer: author.bearer };
    const call = (method: Method, path: string, actor: Account | null, body?: unknown, key = randomUUID()) =>
      driver.request({ method, path, actor, body, key: JSON.stringify(key) });
    const json = async (response: Response, status = 200) => {
      if (response.status !== status) throw new Error(`${response.status}: ${await response.text()}`);
      return response.json();
    };
    const space = (await json(await call('POST', '/v1/spaces', fixture.owner, { title: 'Caption history' }), 201)).space;
    const realmId: string = (
      await json(
        await call('POST', '/v1/realms', fixture.owner, {
          spaceId: space.spaceId,
          title: 'Deleted caption author',
          visibility: 'protected',
          contextId: fixture.contextId,
        }),
        201,
      )
    ).realm.realmId;
    await json(await call('POST', `/v1/realms/${realmId}/members`, fixture.owner, { accountId: author.accountId }), 202);
    await driver.settle();
    await json(
      await call('POST', '/v1/grants', fixture.owner, {
        resource: { route: routeOf(realmId), id: realmId },
        subject: { kind: 'account', id: author.accountId },
        actions: ['realm:manage'],
        valid: '(,)',
      }),
      201,
    );
    const created = await json(
      await call('POST', `/v1/realms/${realmId}/rating-questions`, authorAccount, definition),
      201,
    );
    await json(
      await call('PUT', `/v1/rating-questions/${created.id}/label`, authorAccount, {
        expectedLabelRevision: 1,
        label: 'A caption by a retained author',
      }),
    );
    await deletePersona({ pool: system.database.pool, auth: deletion.auth }, author);
    await driver.settle();

    const management = `/v1/realms/${realmId}/rating-questions/management?selectedQuestionId=${created.id}`;
    const selected = await json(await call('GET', management, fixture.owner));
    expect(selected.selected.question).toMatchObject({
      id: created.id,
      canonicalLabel: definition.label,
      label: 'A caption by a retained author',
      labelRevision: 2,
      revision: 1,
    });
    const historyPath = `${selected.selected.history}?limit=1`;
    const first = await json(await call('GET', historyPath, fixture.owner));
    expect(first.labels[0]).toMatchObject({
      questionId: created.id,
      labelRevision: 1,
      label: definition.label,
      at: null,
      author: { id: author.accountId, state: 'deleted' },
    });
    expect(first.labels[0].author).not.toHaveProperty('displayName');
    const continuation = `${historyPath}&cursor=${encodeURIComponent(first.next)}`;
    const expected = await json(await call('GET', continuation, fixture.owner));
    expect(expected.labels[0].author).toMatchObject({ id: author.accountId, state: 'deleted' });

    const observer = observeSql(system.database.pool);
    observer.armFault({ match: { statement: labelPage.sql }, boundary: 'before', error: new Error('History page unavailable') });
    try {
      expect((await call('GET', continuation, fixture.owner)).status).toBe(503);
      expect(await json(await call('GET', continuation, fixture.owner))).toEqual(expected);
    } finally {
      await observer.close();
    }
  } finally {
    await driver.close();
    await closeCommunityDrivers();
  }
}, 600_000);
