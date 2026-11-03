import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { Value } from 'typebox/value';
import type { CloudEvent } from '../../src/events/log.ts';
import { createRatingCounter } from '../../src/access/rating-counter.ts';
import { readPublicFigureViews } from '../../src/rating/public-figure-http.ts';
import { createRatingAggregateEffect, readAggregate } from '../../src/rating/aggregate-effect.ts';
import { RATING_EVENTS } from '../../src/rating/events.ts';
import {
  assertPopulationDeliveryDelta,
  ratingQuestionHistogramIndex,
  ratingQuestionHistogramSize,
} from '../../src/rating/question-scale.ts';
import { STANDARD_QUESTION_ID } from '../../src/rating/votes.ts';
import { newId, routeOf } from '../../src/route/route.ts';
import { body, createNativePublicationFixture, votePath } from './public-figure-native-publication-fixture.ts';

const voteEventType = 'com.rezics.rating.vote.changed.v1';
const scale = { minimumUnits: 10, maximumUnits: 4096, stepUnits: 6 };

test('custom stored units survive the mounted vote, worker aggregate, clear and late delivery', async () => {
  const fixture = await createNativePublicationFixture();
  try {
    const { database, realmId, members, outsiders, target: subjectId } = fixture;
    await fixture.joinMembers();
    const voter = members[0]!;
    const questionId = newId(routeOf(realmId)!);
    await database.admin.query(
      `INSERT INTO rating.question
         (id, owner_id, revision, label, grain, minimum_units, maximum_units, step_units, realm_id, meaning)
       VALUES ($1, $2, 1, 'Bounded delivery question', 'work', 10, 4096, 6, $3,
               'Fixture metadata for independent native scale delivery')`,
      [questionId, voter.id, realmId],
    );

    const requestVote = async (units: number) =>
      fixture.request('PUT', votePath(subjectId, questionId), {
        actor: voter,
        key: randomUUID(),
        body: { units },
      });
    const latestEvent = async (revision: number): Promise<CloudEvent> => {
      const result = await database.admin.query<{
        id: string;
        partition_no: number;
        epoch: number;
        position: string;
        data: unknown;
        time: string;
      }>(
        `SELECT id, partition_no, epoch, position::text, data, recorded_at::text AS time
         FROM core.outbox WHERE type=$1 AND data->>'questionId'=$2 AND data->>'voterId'=$3
           AND data->>'revision'=$4 ORDER BY position DESC, event_seq DESC LIMIT 1`,
        [voteEventType, questionId, voter.id, String(revision)],
      );
      const row = result.rows[0];
      if (!row) throw new Error(`Missing durable vote event at revision ${revision}`);
      return {
        specversion: '1.0',
        id: row.id,
        source: `urn:rezics:log:${row.partition_no}.${row.epoch}`,
        sequence: row.position.padStart(19, '0'),
        time: row.time,
        type: voteEventType,
        datacontenttype: 'application/json',
        data: row.data,
      } as CloudEvent;
    };
    const aggregate = async () => {
      const result = await readAggregate(database.pool, {
        questionId,
        populationId: realmId,
        targetId: subjectId,
      });
      if (!result) throw new Error('Question aggregate is unavailable');
      return result;
    };

    expect(ratingQuestionHistogramSize({ minimumUnits: 0, maximumUnits: 4096, stepUnits: 1 })).toBe(4097);
    expect(() => ratingQuestionHistogramSize({ minimumUnits: 0, maximumUnits: 4097, stepUnits: 1 })).toThrow();
    expect(ratingQuestionHistogramIndex(scale, 4096)).toBe(681);
    expect(() => ratingQuestionHistogramIndex(scale, 4095)).toThrow();
    expect(() => assertPopulationDeliveryDelta(201n, 0n)).toThrow();
    expect(() => assertPopulationDeliveryDelta(0n, 819201n)).toThrow();
    const legacyEnvelope = {
      voterId: voter.id,
      questionId,
      targetId: subjectId,
      previous: null,
      units: 20,
      revision: 1,
      populations: [realmId],
    };
    expect(Value.Check(RATING_EVENTS[voteEventType], legacyEnvelope)).toBe(true);
    expect(Value.Check(RATING_EVENTS[voteEventType], { ...legacyEnvelope, units: 4096 })).toBe(true);
    expect(Value.Check(RATING_EVENTS[voteEventType], { ...legacyEnvelope, units: 4097 })).toBe(false);

    const first = await body(await requestVote(4096));
    expect(first).toMatchObject({ units: 4096, revision: 1 });
    await fixture.settle();
    const firstEvent = await latestEvent(1);
    expect(await aggregate()).toMatchObject({ count: 1n, sum: 4096n });
    expect((await aggregate()).histogram).toHaveLength(682);
    expect((await aggregate()).histogram[681]).toBe(1n);
    expect(
      await database.admin.query(
        `SELECT units FROM rating.vote WHERE voter_id=$1 AND question_id=$2 AND target_id=$3`,
        [voter.id, questionId, subjectId],
      ),
    ).toMatchObject({ rows: [{ units: 4096 }] });

    expect((await requestVote(4095)).status).toBe(400);
    expect((await aggregate()).sum).toBe(4096n);
    const second = await body(await requestVote(4090));
    expect(second).toMatchObject({ units: 4090, revision: 2 });
    await fixture.settle();
    const secondEvent = await latestEvent(2);
    const replay = createRatingAggregateEffect(database.pool, createRatingCounter({ secret: Buffer.alloc(32, 43) }));
    await replay.run(firstEvent);
    expect(await aggregate()).toMatchObject({ count: 1n, sum: 4090n });
    expect((await aggregate()).histogram[680]).toBe(1n);
    await expect(
      replay.run({
        ...firstEvent,
        data: { ...(firstEvent.data as Record<string, unknown>), units: 4095 },
      } as CloudEvent),
    ).rejects.toThrow('Rating vote is outside its question scale');
    expect(await aggregate()).toMatchObject({ count: 1n, sum: 4090n });

    const clear = await fixture.request('DELETE', votePath(subjectId, questionId), {
      actor: voter,
      key: randomUUID(),
    });
    expect(clear.status).toBe(204);
    await fixture.settle();
    const clearEvent = await latestEvent(3);
    await replay.run(secondEvent);
    await replay.run(firstEvent);
    await replay.run(clearEvent);
    const empty = await aggregate();
    expect(empty).toMatchObject({ count: 0n, sum: 0n });
    expect(empty.histogram).toEqual(Array.from({ length: 682 }, () => 0n));

    for (const standardVoter of outsiders.slice(0, 5)) await fixture.vote(subjectId, standardVoter, 20);
    await fixture.settle();
    const standard = await readPublicFigureViews(database.pool, [subjectId]);
    expect(standard?.get(subjectId)?.figure).toMatchObject({
      questionId: STANDARD_QUESTION_ID,
      scale: { min: 0, max: 20, displayStep: 1 },
      count: 5,
      state: 'ready',
      mean: 10,
    });
  } finally {
    await fixture.close();
  }
});
