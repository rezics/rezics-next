import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { bundledRelease } from '@rezics/definitions/bundled';
import type { Account, Method } from '../../../../specs/community-driver.ts';
import { newId, routeOf } from '../../src/route/route.ts';
import { GLOBAL_CONTEXT, bootstrapRelease } from '../../src/semantic/definitions.ts';
import { STANDARD_QUESTION_ID } from '../../src/rating/votes.ts';
import { readQuestionManagementPage } from '../../src/rating/question-management.ts';
import { AccessUnavailableError } from '../../src/access/unavailable.ts';
import labelPage from '../../src/rating/question-label-page.sql';
import { createRealAccess } from '../semantic/real-access.ts';
import { assertGrowthAccessPaths, checkGrowth, openGrowthDatabase } from '../support/growth.ts';
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

test('Realm management keeps raw, selected, byte and cursor bounds under independent unrelated growth', async () => {
  const route = 0x5371;
  const ownerId = newId(route);
  const spaceId = newId(route);
  const realmId = newId(route);
  const spaceRevisionId = newId(route);
  const realmRevisionId = newId(route);
  const targetId = newId(route);
  const prefix = `80000000-0000-7000-8000-${route.toString(16).padStart(4, '0')}`;
  const unrelatedId = `${prefix}00000000`;
  const database = await openGrowthDatabase();
  database.pool.options.max = 1;
  try {
    await bootstrapRelease(database.pool, bundledRelease);
    const realAccess = await createRealAccess(database.admin, { owner: ownerId }, ['realm:read', 'realm:manage']);
    const now = new Date();
    const transactionId = randomUUID();
    const setupClient = await database.admin.connect();
    try {
      await setupClient.query('BEGIN');
      await setupClient.query(
      `INSERT INTO community.space (route, space_id, state, head_revision_id, created_at, creator)
       VALUES ($1, $2, 'active', $3, $4, $5)`,
        [route, spaceId, spaceRevisionId, now, ownerId],
      );
      await setupClient.query(
      `INSERT INTO community.space_revision
         (route, space_id, revision_id, predecessor, title, summary, created_at, author)
       VALUES ($1, $2, $3, NULL, 'Question management growth', '', $4, $5)`,
        [route, spaceId, spaceRevisionId, now, ownerId],
      );
      await setupClient.query(
      `INSERT INTO community.realm
         (route, realm_id, space_id, state, visibility, context_id, head_revision_id, created_at, creator)
       VALUES ($1, $2, $3, 'active', 'protected', $4, $5, $6, $7)`,
        [route, realmId, spaceId, GLOBAL_CONTEXT, realmRevisionId, now, ownerId],
      );
      await setupClient.query(
      `INSERT INTO community.realm_revision
         (route, realm_id, revision_id, predecessor, title, summary, visibility, context_id, created_at, author)
       VALUES ($1, $2, $3, NULL, 'Question management growth', '', 'protected', $4, $5, $6)`,
        [route, realmId, realmRevisionId, GLOBAL_CONTEXT, now, ownerId],
      );
      await setupClient.query(
      `INSERT INTO access.resource_initialization
         (route, resource_id, resource_type, creator_id, initialized_at)
       VALUES ($1, $2, 'community.space', $4, $5), ($1, $3, 'community.realm', $4, $5)`,
        [route, spaceId, realmId, ownerId, now],
      );
      await setupClient.query(
      `INSERT INTO access.resource_role_grant
         (route, resource_id, subject_kind, subject_id, subject_role, grant_role, valid, transaction_id)
       VALUES ($1, $2, 'identity', $3, '', 'community.realm.owner', '(,)', $4),
              ($1, $5, 'identity', $3, '', 'community.space.owner', '(,)', $4)`,
        [route, realmId, ownerId, transactionId, spaceId],
      );
      await setupClient.query(
      `INSERT INTO rating.question
         (id, owner_id, realm_id, revision, meaning, label, grain, minimum_units, maximum_units, step_units)
       VALUES ($1, $2, $3, 1, 'Recorded target definition', 'Target question', 'release', 0, 20, 2),
              ($4, $2, $3, 1, 'Unrelated definition', 'Unrelated question', 'release', 0, 20, 2)`,
        [targetId, ownerId, realmId, unrelatedId],
      );
      await setupClient.query(
      `INSERT INTO rating.question_label_head (question_id, revision, label) VALUES ($1, 1, 'Unrelated question')`,
        [unrelatedId],
      );
      await setupClient.query('COMMIT');
    } catch (error) {
      await setupClient.query('ROLLBACK');
      throw error;
    } finally {
      setupClient.release();
    }
    const access = realAccess.access({ actions: new Map() });
    const actor = await access.authenticate(realAccess.bearer('owner'), {
      pool: database.pool,
      deadline: Date.now() + 30_000,
    });
    const tokens = { current: 1, keys: new Map([[1, new Uint8Array(32).fill(57)]]) };
    const input = { realmId, selectedQuestionId: targetId };
    const read = () =>
      readQuestionManagementPage(
        { pool: database.pool, access, tokens },
        actor,
        input,
        Date.now() + 30_000,
      );
    const axes = ['questions', 'caption revisions', 'votes', 'authority'] as const;
    for (const axis of axes) {
      const report = await checkGrowth(database, {
        name: `Realm question management under independent ${axis} growth`,
        scales: [256, 1024, 4096],
        repetitions: 2,
        includeBackends: true,
        bounds: { rows: 'constant', statements: 'constant', blocks: 'logarithmic' },
        indexProbes: 256,
        grow: async (_db, scale, previous) => {
          if (axis === 'questions')
            await database.admin.query(
              `INSERT INTO rating.question
                 (id, owner_id, realm_id, revision, meaning, label, grain, minimum_units, maximum_units, step_units)
               SELECT ($1 || lpad(to_hex(n), 8, '0'))::uuid, $2, $3, 1,
                      'Unrelated definition ' || n::text, 'Unrelated question ' || n::text,
                      'release', 0, 20, 2
               FROM generate_series($4::int, $5::int) AS n`,
              [prefix, ownerId, realmId, previous + 1, scale],
            );
          else if (axis === 'caption revisions')
            await database.admin.query(
              `INSERT INTO rating.question_label_revision (question_id, revision, label, author_id, changed_at)
               SELECT $1, n + 1, 'Unrelated caption ' || n::text, $2, $3
               FROM generate_series($4::int, $5::int) AS n`,
              [unrelatedId, ownerId, now, previous + 1, scale],
            );
          if (axis === 'caption revisions')
            await database.admin.query(
              `UPDATE rating.question_label_head SET revision = $2, label = 'Unrelated current caption'
               WHERE question_id = $1`,
              [unrelatedId, scale + 1],
            );
          else if (axis === 'votes')
            await database.admin.query(
              `INSERT INTO rating.vote
                 (route, voter_id, question_id, target_id, counted_target, counted_revision, units, revision,
                  changed_at, transaction_id)
               SELECT $1, ($2 || lpad(to_hex(n + 10000), 8, '0'))::uuid, $3,
                      ($2 || lpad(to_hex(n + 20000), 8, '0'))::uuid, NULL, 1, 10, 1, $4, gen_random_uuid()
               FROM generate_series($5::int, $6::int) AS n`,
              [route, prefix, unrelatedId, now, previous + 1, scale],
            );
          else
            await database.admin.query(
              `INSERT INTO access.resource_grant
                 (route, resource_id, subject_id, action, valid, transaction_id)
               SELECT $1, ($2 || lpad(to_hex(n + 30000), 8, '0'))::uuid,
                      ($2 || lpad(to_hex(n + 40000), 8, '0'))::uuid, 'realm:read', '(,)', gen_random_uuid()
               FROM generate_series($3::int, $4::int) AS n`,
              [route, prefix, previous + 1, scale],
            );
        },
        operation: async () => {
          const page = await read();
          expect(page.directory.ratingQuestions).toHaveLength(20);
          expect(page.directory.next).toEqual(expect.any(String));
          expect(page.directory.next!.length).toBeLessThanOrEqual(4096);
          expect(page.selected?.question.id).toBe(targetId);
          expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThanOrEqual(1_048_576);
          return page;
        },
      });
      const relations = [
        ...new Set(
          report.samples.flatMap(({ repetitions }) => repetitions.flatMap(({ relations }) => Object.keys(relations))),
        ),
      ];
      assertGrowthAccessPaths(report.name, report.samples, relations);
      for (const sample of report.samples) {
        expect(sample.backendRepetitions).toHaveLength(2);
        for (const cost of sample.repetitions) {
          expect(cost.rows).toBeGreaterThan(0);
          expect(cost.statements).toBeGreaterThan(0);
          expect(cost.blocks).toBeGreaterThan(0);
          expect(cost.failedStatements ?? {}).toEqual({});
        }
      }
    }
  } finally {
    await database.close();
  }
}, 1_800_000);
