import { afterAll, beforeAll, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import {
  scopedJudgmentsFixture,
  short,
  RV,
  nativeId,
  type Opinion,
} from './scoped-judgments-support.ts';
import { GLOBAL_RATING_POPULATION_OWNER } from '../../../services/main/src/modules/rating/global.ts';
import { readMainOutboxEnvelope } from '../../../services/main/src/modules/outbox/relay.ts';
import { GRAPHS, iri } from '../../../services/main/src/modules/work/activate.ts';
import { fusekiReadBudget } from '../../../services/main/src/infrastructure/fuseki.ts';
import { ACCEPTED_TARGET_RATING_WRITE_COST } from '../../../services/main/src/modules/rating/target.ts';
import { ratingMergeHandler } from '../../../services/main/src/modules/rating/merge-handler.ts';

let h: Awaited<ReturnType<typeof scopedJudgmentsFixture>>;
beforeAll(async () => {
  h = await scopedJudgmentsFixture();
}, 300_000);
afterAll(async () => {
  await h?.stop();
});

test('projection questions are created, rated, reviewed and discussed at their exact revision; type and dimension acceptance filters before pagination', async () => {
  const character = await h.semantic('Misaka'),
    event = await h.semantic('Festival match', 'https://schema.org/Event');
  const continuity = await h.semantic('Canon', `${RV}NarrativeContinuity`);
  const inWork = await h.project(character, [h.work.work]);
  const inEvent = await h.project(character, [event]);
  const inBoth = await h.project(character, [h.work.work, continuity]);
  const q = await h.question({
    acceptedSubjectTypes: [`${RV}Character`],
    acceptedFrameDimensions: ['work'],
  });
  expect(q.displayThreshold).toBe(10);
  await h.grant(h.owner, `rating:observe:${q.context}`, 'rating.observation.set');
  const body = h.ratingBody(h.owner, q.context, inWork.id),
    key = randomUUID();
  const budget = {
    callsLeft: ACCEPTED_TARGET_RATING_WRITE_COST.graphCalls,
    bytesLeft: ACCEPTED_TARGET_RATING_WRITE_COST.graphBytes,
    signal: AbortSignal.timeout(ACCEPTED_TARGET_RATING_WRITE_COST.commandDeadlineMs),
  };
  const opinion = await h.json<Opinion>(
    await fusekiReadBudget.run(budget, () =>
      h.call(h.owner, 'POST', '/v1/rating-observations', body, key),
    ),
    201,
  );
  expect(budget.callsLeft).toBeGreaterThanOrEqual(0);
  expect(
    await h.json(
      await h.call(null, 'GET', `/v1/rating-populations?target=${encodeURIComponent(inWork.id)}`),
    ),
  ).toMatchObject({
    items: [expect.objectContaining({ id: h.realm, global: false, ratingCount: 1 })],
  });
  expect(
    await h.json(await h.call(h.owner, 'POST', '/v1/rating-observations', body, key)),
  ).toMatchObject({ ...opinion, replayed: true });
  expect(
    (await h.call(h.owner, 'POST', '/v1/rating-observations', { ...body, value: 7 }, key)).status,
  ).toBe(409);
  expect((await h.call(h.owner, 'POST', '/v1/rating-observations', body)).status).toBe(409);
  const review = await h.json<{ review: string }>(
    await h.call(h.owner, 'POST', '/v1/reviews', h.reviewBody(h.owner, q.context, inWork.id)),
    201,
  );
  expect(await h.json(await h.call(null, 'GET', `/v1/reviews/${review.review}`))).toMatchObject({
    work: inWork.id,
    rating: 8,
  });
  expect(
    await h.json(
      await h.call(null, 'POST', '/v1/rating-aggregates', {
        profile: 'realm-target-latest-mean-v1',
        context: q.context,
        target: inWork.id,
      }),
    ),
  ).toMatchObject({
    targetGrain: 'projection',
    count: 1,
    sum: 8,
    displayThreshold: 10,
    mean: null,
  });
  const draft = {
    profile: 'member-reply-draft-v1',
    reply: nativeId(),
    variantId: `urn:rezics:variant:${randomUUID()}`,
    rootTarget: inWork.id,
    rootRevision: inWork.revision,
    language: 'en',
    direction: 'ltr',
    expectedHead: null,
    body: 'Discussion of Misaka in this Work.',
    actingSubject: h.outsider.actor,
  };
  const saved = await h.json<{ revisionId: string }>(
    await h.call(h.outsider, 'POST', '/v1/member-reply-drafts', draft),
    201,
  );
  const identity = {
    profile: 'realm-reply-identity-v1',
    reply: draft.reply,
    variantId: draft.variantId,
    revisionId: saved.revisionId,
    author: h.outsider.actor,
    rootTarget: inWork.id,
    rootRevision: inWork.revision,
    parentReply: null,
    parentRevision: null,
    contextRevision: q.contextRevision,
  };
  expect(
    await h.json(await h.call(h.outsider, 'POST', '/v1/realm-replies', identity), 201),
  ).toMatchObject({
    rootTarget: inWork.id,
    rootRevision: inWork.revision,
    contextRevision: q.contextRevision,
  });
  expect(
    (
      await h.call(h.outsider, 'POST', '/v1/realm-replies', {
        ...identity,
        rootRevision: inEvent.revision,
      })
    ).status,
  ).toBe(403);
  await h.stack.fuseki.update(`PREFIX rv: <${RV}> INSERT DATA { GRAPH ${iri(GRAPHS.revisions)} {
    ${iri(q.contextRevision)} a rv:ErasedRevision } }`);
  try {
    expect((await h.call(h.outsider, 'POST', '/v1/realm-replies', identity)).status).toBe(403);
  } finally {
    await h.stack.fuseki.update(`PREFIX rv: <${RV}> DELETE DATA { GRAPH ${iri(GRAPHS.revisions)} {
      ${iri(q.contextRevision)} a rv:ErasedRevision } }`);
  }
  for (const target of [inEvent, inBoth]) {
    expect(
      await h.json(
        await h.call(
          h.owner,
          'POST',
          '/v1/rating-observations',
          h.ratingBody(h.owner, q.context, target.id),
        ),
        422,
      ),
    ).toMatchObject({ code: 'rating_target_not_accepted' });
    expect(
      await h.json(
        await h.call(h.owner, 'POST', '/v1/reviews', h.reviewBody(h.owner, q.context, target.id)),
        422,
      ),
    ).toMatchObject({ code: 'rating_target_not_accepted' });
    expect(
      await h.json(
        await h.call(h.outsider, 'POST', '/v1/realm-replies', {
          ...identity,
          rootTarget: target.id,
          rootRevision: target.revision,
        }),
        422,
      ),
    ).toMatchObject({ code: 'rating_target_not_accepted' });
  }
  const characterQuestion = await h.question({
    targetGrain: 'resource',
    acceptedSubjectTypes: [`${RV}Character`],
  });
  for (const path of ['/v1/rating-observations', '/v1/reviews']) {
    const command = path.endsWith('observations')
      ? h.ratingBody(h.owner, characterQuestion.context, h.work.work)
      : h.reviewBody(h.owner, characterQuestion.context, h.work.work);
    expect(await h.json(await h.call(h.owner, 'POST', path, command), 422)).toMatchObject({
      code: 'rating_target_not_accepted',
    });
  }
  const eventQuestion = await h.question({
    acceptedSubjectTypes: [`${RV}Character`],
    acceptedFrameDimensions: ['event'],
  });
  const otherType = await h.question({ acceptedSubjectTypes: ['https://schema.org/Person'] });
  const unrestricted = await h.question();
  const contexts = [q.context];
  for (let index = 0; index < 3; index++)
    contexts.push(
      (
        await h.question({
          acceptedSubjectTypes: [`${RV}Character`],
          acceptedFrameDimensions: ['work', 'continuity'],
        })
      ).context,
    );
  contexts.push(unrestricted.context);
  let cursor: string | null = null;
  const listed: string[] = [];
  do {
    const page = await h.json<{ items: { context: string }[]; nextCursor: string | null }>(
      await h.page(inWork.id, h.realm, 2, cursor ?? undefined),
    );
    expect(page.items.length).toBeGreaterThan(0);
    listed.push(...page.items.map((item) => item.context));
    cursor = page.nextCursor;
  } while (cursor);
  expect(listed.sort()).toEqual(contexts.sort());
  expect(listed).not.toContain(eventQuestion.context);
  expect(listed).not.toContain(otherType.context);
  expect(await h.json(await h.page(inEvent.id))).toMatchObject({
    items: expect.arrayContaining([
      expect.objectContaining({ context: eventQuestion.context }),
      expect.objectContaining({ context: unrestricted.context }),
    ]),
  });
  const subjectContexts = await h.json<{ items: { context: string }[] }>(await h.page(character));
  expect(subjectContexts.items.map((item) => item.context)).toEqual([characterQuestion.context]);
  const dependencies = {
    accessPool: h.stack.accessPool,
    contentPool: h.stack.contentPool,
    graph: h.stack.fuseki,
  };
  expect(
    await ratingMergeHandler(dependencies).preview(
      {
        operation: 'merge',
        source: { resource: inWork.id, revision: inWork.revision },
        survivor: { resource: inEvent.id, revision: inEvent.revision },
        evidence: [{ resource: character, revision: inWork.revision, locator: null }],
      },
      dependencies,
    ),
  ).toMatchObject({ owner: 'rating', count: 0, complete: true });
  // Projections and ordinary subjects have independent inventories; no implicit roll-up.
  expect(
    (
      await h.stack.accessPool.query('SELECT * FROM access.rating_aggregate_head WHERE work=$1', [
        h.work.work,
      ])
    ).rowCount,
  ).toBe(0);
  expect(
    (
      await h.stack.accessPool.query('SELECT * FROM access.target_rating_head WHERE target=$1', [
        character,
      ])
    ).rowCount,
  ).toBe(0);
}, 300_000);

test('administrators create Global target questions through v4; a non-member rates and reviews without observation grants, and the relay delivers target', async () => {
  const target = await h.semantic('Global character');
  const input = {
    realm: GLOBAL_RATING_POPULATION_OWNER,
    targetGrain: 'resource',
    acceptedSubjectTypes: [`${RV}Character`],
  };
  const q = await h.question(input);
  expect(
    await h.json(await h.call(null, 'GET', `/v1/rating-contexts/${short(q.context)}`)),
  ).toMatchObject({
    profile: 'realm-target-rating-context-v4',
    owner: { kind: 'global', id: GLOBAL_RATING_POPULATION_OWNER },
    realm: GLOBAL_RATING_POPULATION_OWNER,
    acceptedSubjectTypes: [`${RV}Character`],
  });
  const deniedCreation = {
    profile: 'realm-target-rating-context-v4',
    ...input,
    question: 'A non-admin Global question?',
    language: 'en',
    actingSubject: h.outsider.actor,
  };
  expect((await h.call(h.outsider, 'POST', '/v1/rating-contexts', deniedCreation)).status).toBe(
    403,
  );
  expect(
    (
      await h.stack.accessPool.query(
        "SELECT * FROM access.membership WHERE member_subject=$1 AND state='joined'",
        [h.outsider.actor],
      )
    ).rowCount,
  ).toBe(0);
  const body = h.ratingBody(h.outsider, q.context, target),
    key = randomUUID();
  expect((await h.call(null, 'POST', '/v1/rating-observations', body)).status).toBe(401);
  h.outsider.verified = false;
  expect((await h.call(h.outsider, 'POST', '/v1/rating-observations', body)).status).toBe(403);
  h.outsider.verified = true;
  const opinion = await h.json<Opinion>(
    await h.call(h.outsider, 'POST', '/v1/rating-observations', body, key),
    201,
  );
  expect(
    await h.json(await h.call(h.outsider, 'POST', '/v1/rating-observations', body, key)),
  ).toMatchObject({ ...opinion, replayed: true });
  expect(
    await h.json(
      await h.call(null, 'GET', `/v1/rating-populations?target=${encodeURIComponent(target)}`),
    ),
  ).toMatchObject({
    items: [
      expect.objectContaining({ id: GLOBAL_RATING_POPULATION_OWNER, global: true, ratingCount: 1 }),
    ],
  });
  const review = await h.json<{ review: string }>(
    await h.call(h.outsider, 'POST', '/v1/reviews', h.reviewBody(h.outsider, q.context, target)),
    201,
  );
  expect(await h.json(await h.call(null, 'GET', `/v1/reviews/${review.review}`))).toMatchObject({
    rating: 8,
    realm: GLOBAL_RATING_POPULATION_OWNER,
  });
  expect(await h.json(await h.page(target, null))).toMatchObject({
    items: [
      expect.objectContaining({
        context: q.context,
        owner: { kind: 'global', id: GLOBAL_RATING_POPULATION_OWNER },
      }),
    ],
  });
  expect(
    await h.json(
      await h.call(
        null,
        'GET',
        `/v1/resources/${short(target)}/ratings?scope=global&context=${encodeURIComponent(q.context)}`,
      ),
    ),
  ).toMatchObject({ target, count: 1, mean: null, aggregationScope: { countedTarget: target } });
  expect(
    (
      await h.stack.accessPool.query(
        `SELECT * FROM access.permission_grant WHERE recipient_subject=$1
      AND action='rating.observation.set'`,
        [h.outsider.actor],
      )
    ).rowCount,
  ).toBe(0);
  const rows = (
    await h.stack.fuseki
      .query(`PREFIX rv: <${RV}> SELECT ?batch ?event ?epoch ?sequence ?ordinal WHERE {
      GRAPH ${iri(GRAPHS.outbox)} { ?batch rv:event ?event ; rv:dataEpoch ?epoch ; rv:sequence ?sequence .
        ?event a rv:RatingObservationChangedEvent ; rv:ratingObservation ${iri(opinion.observation)} ; rv:ordinal ?ordinal }
    }`)
  ).results!.bindings;
  expect(rows).toHaveLength(1);
  const row = rows[0]!;
  const envelope = await readMainOutboxEnvelope(
    h.stack.fuseki,
    {
      batchId: row.batch!.value,
      dataEpoch: row.epoch!.value,
      sequence: row.sequence!.value,
      routingEpoch: h.stack.env.lineage.routingEpoch,
      eventIds: [row.event!.value],
    },
    row.event!.value,
  );
  expect(envelope.data.receipt).toMatchObject({ target, ratingValue: 8 });
  expect(envelope.data.receipt).not.toHaveProperty('work');
  expect(envelope.data.receipt).not.toHaveProperty('mainVersion');
  const next = await h.json<Opinion>(
    await h.call(h.outsider, 'POST', '/v1/rating-observations', {
      ...body,
      value: 7,
      expectedRevisionHead: opinion.observationRevision,
    }),
    201,
  );
  expect(
    (
      await h.call(h.outsider, 'POST', '/v1/rating-observations', {
        ...body,
        expectedRevisionHead: opinion.observationRevision,
      })
    ).status,
  ).toBe(409);
  // Closing the unchanged per-Context fence still prevents Global participation.
  await h.stack.accessPool.query('UPDATE access.scope_gate SET open=false WHERE id=$1', [
    `rating:observe:${q.context}`,
  ]);
  expect(
    (
      await h.call(h.outsider, 'POST', '/v1/rating-observations', {
        ...body,
        value: 6,
        expectedRevisionHead: next.observationRevision,
      })
    ).status,
  ).toBe(403);
}, 300_000);
