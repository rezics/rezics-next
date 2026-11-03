import { expect, test } from 'bun:test';
import { GLOBAL_CONTEXT } from '../../src/access/gates/catalogue.ts';
import type { CloudEvent } from '../../src/events/log.ts';
import { applyRatingChanges, applyRatingVoteEvent } from '../../src/rating/aggregate-effect.ts';
import { createRatingIdentityRepairCommands } from '../../src/rating/identity-repair.ts';
import { drainPublicFigures } from '../../src/rating/public-figure.ts';
import { STANDARD_QUESTION_ID } from '../../src/rating/votes.ts';
import { newId, partitionOf } from '../../src/route/route.ts';
import { openGrowthDatabase } from '../support/growth.ts';
import { ratingIdentityFixture, route, at } from './identity-repair-fixture.ts';

test('native repair receipts converge both rank homes and old source events cannot restore the alias', async () => {
  const db = await openGrowthDatabase();
  try {
    const fixture = ratingIdentityFixture(() => db);
    const realm = newId(0x5a00), original = newId(route), terminal = newId(0x4b00);
    const targets = [original, ...Array.from({ length: 9 }, () => newId(route))];
    const voters = await Promise.all(Array.from({ length: 5 }, () => fixture.voter()));
    const changes = [];
    for (const [index, actor] of voters.entries()) {
      await fixture.seed(actor, original, 10);
      await db.admin.query(`INSERT INTO rating.voter_realm(route,voter_id,realm_id,joined_at,state)
        VALUES($1,$2,$3,$4,'counted')`, [route, actor.accountId, realm, at]);
      for (const targetId of targets)
        for (const populationId of [GLOBAL_CONTEXT.id, realm])
          changes.push({ voterId: actor.accountId, countingKey: String(index).padStart(64, '0'),
            questionId: STANDARD_QUESTION_ID, populationId, targetId, units: 10, revision: 1, at });
    }
    await applyRatingChanges(db.pool, changes);
    await drainPublicFigures(db.pool, partitionOf(route));
    const rank = (subject: string) => db.admin.query(`SELECT count::text,score::text,prior_epoch
      FROM rating.realm_rank WHERE subject_id=$1 AND population_id=$2`, [subject, realm]);
    expect((await rank(original)).rows).toEqual([{ count: '5', score: '5.0000', prior_epoch: 1 }]);
    const producer = fixture.producer((id) => id === original ? terminal : id);
    const commands = createRatingIdentityRepairCommands({ pool: db.pool, producer: producer.port });
    const events: CloudEvent[] = [];
    for (const actor of voters) {
      const ref = await fixture.admit(commands, actor);
      for (;;) {
        const page = await fixture.select(commands, actor, ref);
        const result = await commands.commit(actor, fixture.binding(page), fixture.key());
        expect(result.value.status).toBe('committed');
        expect((await commands.commit(actor, fixture.binding(page), fixture.key())).value).toEqual(result.value);
        if (page.terminal) break;
      }
      events.push(...(await fixture.effects(actor)).map((data): CloudEvent => ({
        specversion: '1.0', id: newId(route), source: 'urn:rezics:kernel', time: at,
        type: 'com.rezics.rating.vote.changed.v1', subject: actor.accountId,
        sequence: '1', datacontenttype: 'application/json', data,
      })));
    }
    const counter = async (_: unknown, id: string) => String(voters.findIndex((v) => v.accountId === id)).padStart(64, '0');
    // Deliver destination additions before source removals, then redeliver both and the old vote.
    for (const event of events.toReversed()) await applyRatingVoteEvent(db.pool, counter, event);
    await drainPublicFigures(db.pool, partitionOf(route));
    await drainPublicFigures(db.pool, partitionOf(0x4b00));
    expect((await rank(original)).rows).toEqual([]);
    const repaired = (await rank(terminal)).rows;
    expect(repaired).toEqual([{ count: '5', score: '5.0000', prior_epoch: 1 }]);
    for (const event of events) await applyRatingVoteEvent(db.pool, counter, event);
    await applyRatingChanges(db.pool, changes.filter((change) => change.targetId === original));
    await drainPublicFigures(db.pool, partitionOf(route));
    await drainPublicFigures(db.pool, partitionOf(0x4b00));
    expect((await rank(original)).rows).toEqual([]);
    expect((await rank(terminal)).rows).toEqual(repaired);
  } finally {
    await db.close();
  }
});

test('an erasure before delivery fences missing contributions without changing ordinary removal semantics', async () => {
  const db = await openGrowthDatabase();
  try {
    const vote = { voterId: newId(route), targetId: newId(route), populationId: newId(route),
      questionId: STANDARD_QUESTION_ID, countingKey: '0'.repeat(64), units: 10, revision: 1, at };
    const { units: _units, ...removal } = vote;
    await applyRatingChanges(db.pool, [{ ...removal, remove: true, erasure: true }]);
    await applyRatingChanges(db.pool, [vote, { ...vote, rekey: true, rekeyAt: at, rekeyAllowMissing: true }]);
    const rows = () => db.admin.query('SELECT units FROM rating.population_vote WHERE target_id=$1', [vote.targetId]);
    expect((await rows()).rows).toEqual([]);
    const ordinary = { ...vote, targetId: newId(route) };
    await applyRatingChanges(db.pool, [ordinary]);
    await applyRatingChanges(db.pool, [{ ...removal, targetId: ordinary.targetId, remove: true }]);
    await applyRatingChanges(db.pool, [ordinary]);
    expect((await db.admin.query('SELECT units FROM rating.population_vote WHERE target_id=$1',
      [ordinary.targetId])).rows).toEqual([{ units: 10 }]);
  } finally {
    await db.close();
  }
});
