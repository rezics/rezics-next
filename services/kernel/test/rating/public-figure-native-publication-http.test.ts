import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import type { Account } from '../../../../specs/community-driver.ts';
import { GLOBAL_CONTEXT } from '../../src/access/gates/catalogue.ts';
import { SESSION_HEADER } from '../../src/http/request.ts';
import { STANDARD_QUESTION_ID } from '../../src/rating/votes.ts';
import { newId, partitionOf, routeOf } from '../../src/route/route.ts';
import {
  aggregatePath,
  body,
  createNativePublicationFixture,
  votePath,
  type NativePublicationFixture,
  type NativeVote,
} from './public-figure-native-publication-fixture.ts';

const scale = { min: 0, max: 20, displayStep: 1 };
const round4 = (value: number) => Number(value.toFixed(4));

async function exactPublicOutcome(fixture: NativePublicationFixture, subjectId: string, units: readonly number[]) {
  // Inputs are the committed HTTP vote values. No expectation is selected from an aggregate response.
  const count = units.length;
  const sum = units.reduce((sum, value) => sum + value, 0);
  const mean = count >= 5 ? round4(sum / (2 * count)) : null;
  const score = count >= 5 ? round4((5 * 2 + sum / 2) / (5 + count)) : null;
  const expected = {
    questionId: STANDARD_QUESTION_ID,
    populationId: GLOBAL_CONTEXT.id,
    scale,
    count,
    state: count >= 5 ? 'ready' : 'insufficient_data',
    mean,
    score,
  };
  const published = await fixture.current(subjectId);
  const asOf = published.asOf;
  if (asOf === null) throw new Error('A current published native figure must have an asOf timestamp');
  expect(published).toEqual({
    questionId: STANDARD_QUESTION_ID,
    populationId: GLOBAL_CONTEXT.id,
    subjectId,
    count,
    mean,
    score,
    m: 2,
    C: 5,
    priorEpoch: 1,
    revision: expect.stringMatching(/^[1-9][0-9]*$/),
    asOf: expect.any(String),
    position: expect.stringMatching(/^[1-9][0-9]*$/),
  });
  const histogram = Array.from({ length: 21 }, (_, unit) => units.filter((value) => value === unit).length);
  const component = await fixture.database.admin.query<{ count: number; sum: number }>(
    `SELECT coalesce(sum(count), 0)::integer AS count, coalesce(sum(sum), 0)::integer AS sum
     FROM rating.aggregate_component WHERE route = $1 AND question_id = $2 AND population_id = $3 AND target_id = $4`,
    [routeOf(subjectId), STANDARD_QUESTION_ID, GLOBAL_CONTEXT.id, subjectId],
  );
  expect(component.rows).toEqual([{ count, sum }]);

  for (const actor of [null, fixture.reader]) {
    const response = await fixture.request('GET', `/v1/subjects/${subjectId}/figure`, { actor });
    expect(response.headers.get('etag')).toBe(`"${published.revision}"`);
    expect(response.headers.get('cache-control')).toBe('no-cache');
    const value = await body(response);
    expect(value).toEqual({ figure: expected });
    const text = JSON.stringify(value);
    for (const secret of [...fixture.members, ...fixture.outsiders].map(({ id }) => id))
      expect(text).not.toContain(secret);
    for (const secret of [
      'voterId',
      'countingKey',
      'units',
      'histogram',
      'revision',
      'priorEpoch',
      'subjectId',
      'position',
    ])
      expect(text).not.toContain(`"${secret}"`);

    const aggregate = await body(await fixture.request('GET', aggregatePath(subjectId), { actor }));
    expect(aggregate).toEqual({
      question: STANDARD_QUESTION_ID,
      subject: subjectId,
      figures: [
        {
          population: GLOBAL_CONTEXT.id,
          count,
          ...(count >= 5 ? { mean: Number((sum / count).toFixed(2)), histogram } : { remaining: 5 - count }),
          freshness: { asOf: expect.any(String), updating: false },
        },
      ],
    });
    for (const secret of [
      'voterId',
      'countingKey',
      ...fixture.members.map(({ id }) => id),
      ...fixture.outsiders.map(({ id }) => id),
    ])
      expect(JSON.stringify(aggregate)).not.toContain(secret);
  }

  const partition = partitionOf(routeOf(subjectId)!);
  const snapshot = await fixture.source.read(partition, [subjectId]);
  expect(snapshot.partition).toBe(partition);
  expect(snapshot.position).toBeGreaterThanOrEqual(BigInt(published.position));
  expect([...snapshot.figures]).toEqual([
    [
      subjectId,
      {
        questionId: STANDARD_QUESTION_ID,
        populationId: GLOBAL_CONTEXT.id,
        subjectId,
        count,
        mean,
        score,
        priorEpoch: 1,
        revision: published.revision,
        asOf,
      },
    ],
  ]);
  expect(await fixture.source.epoch()).toEqual({
    questionId: STANDARD_QUESTION_ID,
    populationId: GLOBAL_CONTEXT.id,
    priorEpoch: 1,
  });
  return { published, expected };
}

async function replay(fixture: NativePublicationFixture, vote: NativeVote) {
  const before = await fixture.current(vote.subjectId);
  const nativeBefore = await mutationState(fixture, vote.subjectId, vote.voter);
  const response = await fixture.request(vote.units === null ? 'DELETE' : 'PUT', votePath(vote.subjectId), {
    actor: vote.voter,
    key: vote.key,
    ...(vote.units === null ? {} : { body: { units: vote.units } }),
  });
  expect(response.headers.get(SESSION_HEADER)).toBe(vote.session);
  expect(await body(response, vote.units === null ? 204 : 200)).toEqual(vote.value);
  await fixture.settle();
  expect(await fixture.current(vote.subjectId)).toEqual(before);
  expect(await mutationState(fixture, vote.subjectId, vote.voter)).toEqual(nativeBefore);
}

async function mutationState(fixture: NativePublicationFixture, subjectId: string, actor: Account) {
  const [votes, receipts, events] = await Promise.all([
    fixture.database.admin.query(
      `SELECT units, revision, changed_at, transaction_id, counted_target, counted_revision FROM rating.vote
       WHERE route = $1 AND voter_id = $2 AND question_id = $3 AND target_id = $4`,
      [routeOf(actor.id), actor.id, STANDARD_QUESTION_ID, subjectId],
    ),
    fixture.database.admin.query(
      `SELECT idempotency_key, position::text, response FROM core.receipt
       WHERE partition_no = $1 AND principal_id = $2 AND command_kind = 'rating.vote.put' ORDER BY idempotency_key`,
      [partitionOf(routeOf(actor.id)!), actor.id],
    ),
    fixture.database.admin.query(
      `SELECT id, data FROM core.outbox WHERE partition_no = $1
       AND type = 'com.rezics.rating.vote.changed.v1' AND data->>'voterId' = $2 ORDER BY position, event_seq`,
      [partitionOf(routeOf(actor.id)!), actor.id],
    ),
  ]);
  return { votes: votes.rows, receipts: receipts.rows, events: events.rows };
}

test('Ratings: native Global figure threshold, prior and current public disclosure through actual native APIs and producer outcomes', async () => {
  const fixture = await createNativePublicationFixture();
  try {
    const { target, privateTarget, members, outsiders, reader } = fixture;
    const question = await body(await fixture.request('GET', `/v1/rating-questions/${STANDARD_QUESTION_ID}`));
    expect(question).toMatchObject({ id: STANDARD_QUESTION_ID, revision: 1, grain: 'work', scale });
    expect(await body(await fixture.request('GET', `/v1/subjects/${target}/figure`))).toEqual({
      figure: {
        questionId: STANDARD_QUESTION_ID,
        populationId: GLOBAL_CONTEXT.id,
        scale,
        count: 0,
        state: 'insufficient_data',
        mean: null,
        score: null,
      },
    });
    await fixture.establishPrior(); // 50 native votes, all 4 units, on this same question and Global population.

    const values = [13, 15, 17, 19, 20, 1];
    const voters = [...members, outsiders[0]!];
    const commands: NativeVote[] = [];
    for (let index = 0; index < values.length; index++) {
      const committed = await fixture.vote(target, voters[index]!, values[index]!);
      commands.push(committed);
      await fixture.applied(committed);
      if (index >= 3) await exactPublicOutcome(fixture, target, values.slice(0, index + 1));
    }
    // Threshold-1 publishes no mean or histogram; threshold and threshold+1 retain a positive frozen prior/score.
    expect((await fixture.current(target)).score).toBe(4.7727);
    const updated = await fixture.vote(target, members[0]!, 3);
    await fixture.applied(updated);
    values[0] = 3;
    const afterUpdate = await exactPublicOutcome(fixture, target, values);
    expect(BigInt(afterUpdate.published.revision)).toBeGreaterThan(BigInt(commands[0]!.revision));
    await replay(fixture, updated);
    await replay(fixture, commands[0]!); // An old successful receipt cannot restore an overwritten vote.
    await exactPublicOutcome(fixture, target, values);

    const clear = await fixture.vote(target, outsiders[0]!, null);
    await fixture.applied(clear);
    values.pop();
    expect((await exactPublicOutcome(fixture, target, values)).expected).toMatchObject({
      count: 5,
      mean: 7.4,
      score: 4.7,
    });
    await replay(fixture, clear);
    const below = await fixture.vote(target, members[4]!, null);
    await fixture.applied(below);
    values.pop();
    await exactPublicOutcome(fixture, target, values);
    await replay(fixture, commands[4]!); // A cleared vote remains a tombstone after replaying its original put.
    expect(await body(await fixture.request('GET', votePath(target), { actor: members[4]! }), 404)).toMatchObject({
      code: 'not_found',
    });
    expect(await body(await fixture.request('GET', votePath(target), { actor: members[0]! }))).toMatchObject({
      units: 3,
      revision: updated.revision,
    });
    expect(await body(await fixture.request('GET', votePath(target), { actor: reader }), 404)).toMatchObject({
      code: 'not_found',
    });
    expect(await body(await fixture.request('GET', votePath(target)), 401)).toMatchObject({
      code: 'authentication_required',
    });

    await fixture.joinMembers();
    for (let index = 0; index < members.length; index++) {
      await fixture.applied(await fixture.vote(privateTarget, members[index]!, 20));
      if (index === 3) {
        const small = await body(
          await fixture.request('GET', aggregatePath(privateTarget, fixture.realmId), { actor: members[0]! }),
        );
        expect(small).toEqual({
          question: STANDARD_QUESTION_ID,
          subject: privateTarget,
          figures: [
            {
              population: fixture.realmId,
              count: 4,
              remaining: 1,
              freshness: { asOf: expect.any(String), updating: false },
            },
          ],
        });
      }
    }
    for (const voter of outsiders) await fixture.applied(await fixture.vote(privateTarget, voter, 0));
    expect(await fixture.current(privateTarget, fixture.realmId)).toMatchObject({ count: 5, mean: 10 });
    await exactPublicOutcome(fixture, privateTarget, [20, 20, 20, 20, 20, 0, 0, 0, 0, 0]);
    for (const actor of [null, reader, members[0]!]) {
      const result = await body(await fixture.request('GET', `/v1/subjects/${privateTarget}/figure`, { actor }));
      expect(result.figure).toMatchObject({ populationId: GLOBAL_CONTEXT.id, count: 10, mean: 5, score: 4 });
      expect(JSON.stringify(result)).not.toContain(fixture.realmId);
    }
    for (const actor of [null, reader]) {
      expect(await body(await fixture.request('GET', `/v1/realms/${fixture.realmId}`, { actor }), 404)).toMatchObject({
        code: 'not_found',
      });
      expect(
        await body(await fixture.request('GET', aggregatePath(privateTarget, fixture.realmId), { actor })),
      ).toEqual({
        question: STANDARD_QUESTION_ID,
        subject: privateTarget,
        figures: [{ population: fixture.realmId, count: 0, freshness: { asOf: null, updating: false } }],
      });
      const page = await body(
        await fixture.request(
          'GET',
          `/v1/subjects/${privateTarget}/ratings/populations?question=${STANDARD_QUESTION_ID}`,
          { actor },
        ),
      );
      expect(page).toEqual({ populations: [{ population: GLOBAL_CONTEXT.id, count: 10 }], next: null });
    }
    const privateAggregate = await body(
      await fixture.request('GET', aggregatePath(privateTarget, fixture.realmId), { actor: members[0]! }),
    );
    expect(privateAggregate.figures[0]).toMatchObject({
      count: 5,
      mean: 20,
      histogram: Array.from({ length: 21 }, (_, unit) => (unit === 20 ? 5 : 0)),
    });

    const unknown = newId(routeOf(target)!);
    for (const path of [
      aggregatePath(target, GLOBAL_CONTEXT.id, unknown),
      aggregatePath(target, GLOBAL_CONTEXT.id, fixture.realmId),
      `/v1/subjects/${unknown}/figure`,
    ])
      expect(await body(await fixture.request('GET', path), 404)).toMatchObject({ code: 'not_found' });
    expect(await body(await fixture.request('GET', aggregatePath(target, unknown)))).toEqual({
      question: STANDARD_QUESTION_ID,
      subject: target,
      figures: [{ population: unknown, count: 0, freshness: { asOf: null, updating: false } }],
    });
    expect(
      await body(
        await fixture.request(
          'GET',
          `/v1/subjects/${target}/ratings/populations?question=${STANDARD_QUESTION_ID}&cursor=invalid`,
        ),
        400,
      ),
    ).toMatchObject({ code: 'invalid_cursor' });
    await expect(fixture.source.read((partitionOf(routeOf(target)!) + 1) % 4096, [target])).rejects.toBeInstanceOf(
      RangeError,
    );
    await expect(
      fixture.source.read(
        partitionOf(routeOf(target)!),
        Array.from({ length: 257 }, () => target),
      ),
    ).rejects.toBeInstanceOf(RangeError);
    const absent = await fixture.source.read(partitionOf(routeOf(unknown)!), [unknown]);
    expect(absent.figures.size).toBe(0);

    const actor = members[0]!;
    const before = await mutationState(fixture, target, actor);
    for (const units of [-1, 21, 0.5])
      expect(
        await body(
          await fixture.request('PUT', votePath(target), {
            actor,
            key: randomUUID(),
            body: { units },
          }),
          400,
        ),
      ).toMatchObject({ code: 'invalid_request' });
    expect(
      await body(
        await fixture.request('PUT', votePath(target), {
          actor,
          key: updated.key,
          body: { units: 9 },
        }),
        422,
      ),
    ).toMatchObject({ code: 'idempotency_conflict' });
    expect(
      await body(
        await fixture.request('PUT', votePath(target, unknown), {
          actor,
          key: randomUUID(),
          body: { units: 9 },
        }),
        404,
      ),
    ).toMatchObject({ code: 'not_found' });
    expect(await mutationState(fixture, target, actor)).toEqual(before);

    const suspended = outsiders[0]!;
    const priorBearer = suspended.bearer;
    await fixture.command('POST', `/v1/accounts/${suspended.id}:suspend`, fixture.governance, {
      reason: 'Native rating publication account suspension',
    });
    await fixture.settle();
    const deniedBefore = await mutationState(fixture, privateTarget, suspended);
    for (const path of [
      `/v1/subjects/${privateTarget}/figure`,
      aggregatePath(privateTarget),
      votePath(privateTarget),
    ]) {
      const denied = await fixture.request('GET', path, { bearer: priorBearer });
      expect(await body(denied, 401)).toMatchObject({ code: 'invalid_credentials' });
    }
    expect(
      await body(
        await fixture.request('PUT', votePath(privateTarget), {
          bearer: priorBearer,
          key: randomUUID(),
          body: { units: 20 },
        }),
        401,
      ),
    ).toMatchObject({ code: 'invalid_credentials' });
    expect(await mutationState(fixture, privateTarget, suspended)).toEqual(deniedBefore);
    await exactPublicOutcome(fixture, privateTarget, [20, 20, 20, 20, 20, 0, 0, 0, 0]);
  } finally {
    await fixture.close();
  }
}, 900_000);

test('Default public rating publication uses independently anchored population priors across different partitions and never regresses a published prior generation', async () => {
  const fixture = await createNativePublicationFixture();
  try {
    const populationPartition = partitionOf(routeOf(GLOBAL_CONTEXT.id)!);
    const subjects = [
      await fixture.createSubject((populationPartition + 1) % 4096),
      await fixture.createSubject((populationPartition + 2) % 4096),
    ];
    expect(new Set([populationPartition, ...subjects.map((id) => partitionOf(routeOf(id)!))]).size).toBe(3);
    const absent = await fixture.captureGlobalPrior();
    expect(absent).toMatchObject({ generation: '0', epoch: null, status: 'absent', m: null, c: null });
    for (const [index, subject] of subjects.entries()) {
      for (const voter of fixture.members)
        await fixture.applied(await fixture.vote(subject, voter, index === 0 ? 20 : 12));
      expect(await fixture.current(subject)).toMatchObject({
        count: 5,
        mean: index === 0 ? 10 : 6,
        score: null,
        m: null,
        C: null,
        priorEpoch: null,
      });
    }
    // Exactly fifty native votes: ten on the two independent subject homes and forty prior votes.
    for (const subject of fixture.priorSubjects.slice(0, 8))
      for (const voter of fixture.members) await fixture.applied(await fixture.vote(subject, voter, 4));
    const first = await fixture.captureGlobalPrior();
    expect(first).toMatchObject({ generation: '1', epoch: 1, status: 'active', m: '3.2000', c: '5' });

    const assertPublished = async (generation: string, epoch: number | null, m: number | null) => {
      const figures = [];
      for (const [index, subject] of subjects.entries()) {
        const mean = index === 0 ? 10 : 6;
        const figure = await fixture.current(subject);
        const score = m === null ? null : round4((5 * m + 5 * mean) / 10);
        expect(figure).toMatchObject({ count: 5, mean, score, m, C: m === null ? null : 5, priorEpoch: epoch });
        for (const actor of [null, fixture.reader])
          expect(await body(await fixture.request('GET', `/v1/subjects/${subject}/figure`, { actor }))).toEqual({
            figure: {
              questionId: STANDARD_QUESTION_ID,
              populationId: GLOBAL_CONTEXT.id,
              scale,
              count: 5,
              state: 'ready',
              mean,
              score,
            },
          });
        const local = await fixture.database.admin.query(
          `SELECT input.generation::text, input.status, input.epoch, input.m::float8, input.c::integer,
                  figure.published_prior_generation::text, figure.pending_prior_generation::text
           FROM rating.subject_home_prior_input AS input
           JOIN rating.public_figure AS figure ON figure.partition_no = input.partition_no
             AND figure.question_id = input.question_id AND figure.population_id = input.population_id
           WHERE input.partition_no = $1 AND input.population_route = $2
             AND input.question_id = $3 AND input.population_id = $4 AND figure.route = $5 AND figure.subject_id = $6`,
          [
            partitionOf(routeOf(subject)!),
            routeOf(GLOBAL_CONTEXT.id),
            STANDARD_QUESTION_ID,
            GLOBAL_CONTEXT.id,
            routeOf(subject),
            subject,
          ],
        );
        expect(local.rows).toEqual([
          {
            generation,
            status: m === null ? 'inactive' : 'active',
            epoch: m === null ? 1 : epoch,
            m,
            c: m === null ? null : 5,
            published_prior_generation: generation,
            pending_prior_generation: null,
          },
        ]);
        const indexed = await fixture.source.read(partitionOf(routeOf(subject)!), [subject]);
        expect(indexed.figures.get(subject)).toMatchObject({ count: 5, mean, score, priorEpoch: epoch });
        figures.push(figure);
      }
      return figures;
    };
    await assertPublished('1', 1, 3.2);
    const clearedSubject = fixture.priorSubjects[0]!;
    const voter = fixture.members[0]!;
    await fixture.applied(await fixture.vote(clearedSubject, voter, null));
    const inactive = await fixture.captureGlobalPrior();
    expect(inactive).toMatchObject({ generation: '2', epoch: 1, status: 'inactive', m: null, c: null });
    const deactivated = await assertPublished('2', null, null);
    for (const subject of subjects) {
      await fixture.redeliverGlobalPrior(subject, first);
      await fixture.redeliverGlobalPrior(subject, absent);
    }
    expect(await assertPublished('2', null, null)).toEqual(deactivated);

    // Returning to fifty starts a new epoch with a different frozen mean, through the same native effect path.
    await fixture.applied(await fixture.vote(clearedSubject, voter, 20));
    expect(await fixture.captureGlobalPrior()).toMatchObject({
      generation: '3',
      epoch: 2,
      status: 'active',
      m: '3.3600',
      c: '5',
    });
    const renewed = await assertPublished('3', 2, 3.36);
    for (const subject of subjects) {
      await fixture.redeliverGlobalPrior(subject, inactive);
      await fixture.redeliverGlobalPrior(subject, first);
    }
    expect(await assertPublished('3', 2, 3.36)).toEqual(renewed);

    // An ordinary aggregate-applied publication must also retain the new local prior, not relabel old m/C.
    await fixture.applied(await fixture.vote(subjects[0]!, voter, 18));
    const updated = await fixture.current(subjects[0]!);
    expect(updated).toMatchObject({ count: 5, mean: 9.8, score: 6.58, m: 3.36, C: 5, priorEpoch: 2 });
    expect(BigInt(updated.revision)).toBeGreaterThan(BigInt(renewed[0]!.revision));
    expect(BigInt(updated.position)).toBeGreaterThan(BigInt(renewed[0]!.position));
    await fixture.redeliverGlobalPrior(subjects[0]!, first);
    expect(await fixture.current(subjects[0]!)).toEqual(updated);
  } finally {
    await fixture.close();
  }
}, 900_000);
