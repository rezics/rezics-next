import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import type { Account, Method } from '../../../../specs/community-driver.ts';
import { noEffect, runCommand, type CommandTransaction } from '../../src/command/command.ts';
import { createPool } from '../../src/database/pool.ts';
import { retireRealmRatingQuestion } from '../../src/rating/question-lifecycle.ts';
import {
  createQuestionVoteAdmission,
  type QuestionVoteAdmissionPreparation,
} from '../../src/rating/question-vote-admission.ts';
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
  let admissionPool: ReturnType<typeof createPool> | undefined;
  try {
    const fixture = await driver.provision();
    const { system } = communityFixtureRuntime();
    // Independent native executors must contend in PostgreSQL, beyond one pool's FIFO gate.
    const commandPool = createPool(system.database.pool.options.connectionString!);
    admissionPool = commandPool;
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
    const admission = createQuestionVoteAdmission();
    const questionHome = partitionOf(routeOf(question.id)!);
    const reviewed = admission.prepare({ questionId: question.id, question: { revision: 1, lifecycleRevision: 1 } });
    const admit = (
      prepared = reviewed,
      options: {
        home?: number;
        deadline?: number;
        before?: (tx: CommandTransaction) => Promise<void>;
        held?: (tx: CommandTransaction) => Promise<void>;
      } = {},
    ) =>
      runCommand(
        commandPool,
        { partition: options.home ?? questionHome, deadline: options.deadline ?? Date.now() + 30_000 },
        async (tx) => {
          await options.before?.(tx);
          const held = await admission.admit(tx, prepared);
          await options.held?.(tx);
          return noEffect(held);
        },
      );
    // The implicit lifecycle head is positively serialized by its real question.
    expect((await admit()).value).toEqual({
      questionId: question.id,
      revision: 1,
      lifecycleRevision: 1,
      lifecycleState: 'active',
    });
    const standard = admission.prepare({
      questionId: STANDARD_QUESTION_ID,
      question: { revision: 1, lifecycleRevision: 1 },
    });
    expect((await admit(standard, { home: 0 })).value.lifecycleState).toBe('active');
    await expect(admit(reviewed, { home: questionHome ^ 1 })).rejects.toMatchObject({
      code: 'vote_review_unavailable',
      reason: 'atomic_guard_unavailable',
    });
    const missing = admission.prepare({
      questionId: newId(routeOf(question.id)!),
      question: { revision: 1, lifecycleRevision: 1 },
    });
    await expect(admit(missing)).rejects.toMatchObject({ code: 'vote_review_stale', reason: 'question_changed' });
    const changed = admission.prepare({ questionId: question.id, question: { revision: 2, lifecycleRevision: 1 } });
    await expect(admit(changed)).rejects.toMatchObject({ code: 'vote_review_stale', reason: 'question_changed' });
    await json(
      await call('PUT', `/v1/rating-questions/${question.id}/label`, fixture.member, {
        expectedLabelRevision: 1,
        label: 'Translation accuracy',
      }),
    );
    expect((await admit()).value.revision).toBe(1);
    await expect(
      admit(reviewed, {
        held: async () => {
          throw new Error('abort participant');
        },
      }),
    ).rejects.toThrow('abort participant');
    await expect(
      admit(reviewed, {
        deadline: Date.now() + 500,
        held: async (tx) => {
          await tx.query('SELECT pg_sleep(2)');
        },
      }),
    ).rejects.toMatchObject({ reason: 'deadline' });
    let completed: CommandTransaction | undefined;
    await admit(reviewed, {
      held: async (tx) => {
        completed = tx;
      },
    });
    await expect(admission.admit(completed!, reviewed)).rejects.toThrow('No authorized live command transaction');

    const memberActor = await system.access.authenticate(fixture.member.bearer, {
      pool: system.database.pool,
      deadline: Date.now() + 30_000,
    });
    // Hold a genuine native transaction while the actual manager command competes.
    const locked = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const holding = admit(reviewed, {
      held: async () => {
        locked.resolve();
        await release.promise;
      },
    });
    try {
      await Promise.race([locked.promise, holding]);
      const blocked = await retireRealmRatingQuestion(
        { pool: system.database.pool, access: system.access },
        memberActor,
        { questionId: question.id, expectedRevision: 1 },
        { deadline: Date.now() + 1_000, idempotencyKey: randomUUID() },
      ).then(
        () => {
          throw new Error('Retirement committed through the held question');
        },
        (error: unknown) => error,
      );
      expect(blocked).toMatchObject({ name: 'CommandUnavailableError' });
      expect(['deadline', 'contention']).toContain((blocked as { reason: string }).reason);
    } finally {
      release.resolve();
      await holding;
    }
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
      await json(
        await call(
          'POST',
          `/v1/rating-questions/${question.id}/$retire`,
          fixture.member,
          { expectedLifecycleRevision: 1 },
          retireKey,
        ),
      ),
    ).toEqual(retired);
    // Retirement wins after preparation, before this command's admission/commit.
    await expect(admit()).rejects.toMatchObject({ code: 'vote_review_stale', reason: 'question_changed' });
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
      deadlineNow: () => Date.now(),
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
    await expect(admit()).rejects.toMatchObject({ code: 'vote_review_stale', reason: 'question_changed' });
    const restoredReview: QuestionVoteAdmissionPreparation = admission.prepare({
      questionId: question.id,
      question: { revision: 1, lifecycleRevision: 3 },
    });
    // Mint the command snapshot before a real retirement. The owning tuple must
    // force a retry; merely locking an unchanged question would admit the old head.
    const snapshotReady = Promise.withResolvers<void>();
    const retirementDone = Promise.withResolvers<void>();
    const waiting = admit(restoredReview, {
      before: async () => {
        snapshotReady.resolve();
        await retirementDone.promise;
      },
    });
    try {
      await Promise.race([snapshotReady.promise, waiting]);
      await json(
        await call('POST', `/v1/rating-questions/${question.id}/$retire`, fixture.member, {
          expectedLifecycleRevision: 3,
        }),
      );
    } finally {
      retirementDone.resolve();
    }
    await expect(waiting).rejects.toMatchObject({ code: 'vote_review_stale', reason: 'question_changed' });
    await json(
      await call('POST', `/v1/rating-questions/${question.id}/$restore`, fixture.member, {
        expectedLifecycleRevision: 4,
      }),
    );
    const currentReview = admission.prepare({
      questionId: question.id,
      question: { revision: 1, lifecycleRevision: 5 },
    });
    expect((await admit(currentReview)).value.lifecycleRevision).toBe(5);
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
      { state: 'retired', revision: '4', generation: '3' },
      { state: 'active', revision: '5', generation: '4' },
    ]);
  } finally {
    await admissionPool?.end();
    await driver.close();
    await closeCommunityDrivers();
  }
}, 600_000);
