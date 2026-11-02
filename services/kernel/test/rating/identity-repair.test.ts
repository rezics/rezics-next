import { afterAll, beforeAll, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { currentCommand, type CommandTransaction } from '../../src/command/command.ts';
import { createRatingIdentityRepairCommands } from '../../src/rating/identity-repair.ts';
import type { IdentityRepairPage, IdentityWorkRef } from '../../src/rating/identity-work-frame.ts';
import type { RatingIdentityProducer } from '../../src/rating/segment-identity-guard.ts';
import { STANDARD_QUESTION_ID } from '../../src/rating/votes.ts';
import pageVotes from '../../src/rating/segment-identity-page.sql';
import type { AccountActor } from '../../src/request/access.ts';
import { newId } from '../../src/route/route.ts';
import { openGrowthDatabase, type GrowthDatabase } from '../support/growth.ts';

const route = 0x3a07;
let database: GrowthDatabase;
const at = '2026-11-03T08:00:00Z';
beforeAll(async () => {
  database = await openGrowthDatabase();
});
afterAll(async () => {
  await database?.close();
});
const key = () => randomUUID();

async function voter(): Promise<AccountActor> {
  const accountId = newId(route);
  await database.admin.query(
    `INSERT INTO access.account
    (route, account_id, kind, state, transaction_id, authn_fenced, minimum_authn_epoch)
    VALUES ($1, $2, 'actor', 'active', $3, false, 1)`,
    [route, accountId, newId(route)],
  );
  return {
    kind: 'account',
    accountId,
    scopes: ['rating:vote'],
    clientId: 'identity-repair-test',
    requestedBy: null,
    authnEpoch: 1,
  };
}
async function seed(actor: AccountActor, targetId: string, units: number | null = 7) {
  await database.admin.query(
    `INSERT INTO rating.vote
    (route, voter_id, question_id, target_id, units, revision, changed_at, transaction_id)
    VALUES ($1, $2, $3, $4, $5, 1, $6, $7)`,
    [route, actor.accountId, STANDARD_QUESTION_ID, targetId, units, at, newId(route)],
  );
}
function producer(destination: (original: string) => string = (id) => id) {
  let handoff = true;
  let pending = '';
  const held = new WeakSet<CommandTransaction>();
  const port: RatingIdentityProducer = {
    async hold(tx, page) {
      expect(currentCommand(tx).transactionId).toBeTruthy();
      held.add(tx);
      if (pending) return { status: 'pending', reason: pending };
      return {
        status: 'current',
        obligationId: 'fixture-retained-obligation',
        mappings: [...new Set(page.votes.map((vote) => vote.targetId))].map((originalId) => ({
          originalId,
          terminalId: destination(originalId),
          epoch: '1',
        })),
      };
    },
    async complete(tx, input) {
      expect(held.has(tx)).toBe(true);
      expect(currentCommand(tx).transactionId).toBe(input.transactionId);
      const receipt = await tx.query('SELECT transaction_id FROM rating.identity_repair_receipt WHERE page_id = $1', [
        input.page.pageId,
      ]);
      expect(receipt.rows[0]?.transaction_id).toBe(input.transactionId);
      return handoff;
    },
  };
  return {
    port,
    setHandoff: (value: boolean) => {
      handoff = value;
    },
    setPending: (value: string) => {
      pending = value;
    },
  };
}
type Commands = ReturnType<typeof createRatingIdentityRepairCommands>;
async function admit(commands: Commands, actor: AccountActor): Promise<IdentityWorkRef> {
  const result = (await commands.admit(actor, { workId: newId(route), expectedGeneration: null }, key())).value;
  if (result.status !== 'admitted') throw new Error(result.reason);
  return { workId: result.frame.workId, generation: result.frame.generation };
}
async function select(commands: Commands, actor: AccountActor, ref: IdentityWorkRef): Promise<IdentityRepairPage> {
  const result = (await commands.select(actor, ref, key())).value;
  if (result.status !== 'selected') throw new Error(result.reason);
  return result.page;
}
const binding = (page: IdentityRepairPage) => ({
  workId: page.workId,
  generation: page.generation,
  pageId: page.pageId,
  digest: page.digest,
});
async function rows(actor: AccountActor) {
  return (
    await database.admin.query(
      `SELECT target_id, counted_target, units, revision, counted_revision
    FROM rating.vote WHERE route = $1 AND voter_id = $2 ORDER BY target_id`,
      [route, actor.accountId],
    )
  ).rows;
}
async function effects(actor: AccountActor) {
  return (
    await database.admin.query(
      `SELECT data FROM core.outbox
    WHERE subject = $1 AND type = 'com.rezics.rating.vote.changed.v1' ORDER BY position, event_seq`,
      [actor.accountId],
    )
  ).rows.map((row) => row.data);
}

test('durable pages remain bounded and pending without Semantic authority, then resume through an empty terminal receipt', async () => {
  const actor = await voter();
  const targets = Array.from({ length: 67 }, () => newId(route)).sort();
  for (const target of targets.slice(0, 66)) await seed(actor, target);
  const unavailable = createRatingIdentityRepairCommands({ pool: database.pool });
  const ref = await admit(unavailable, actor);
  // A vote beyond the admitted upper bound belongs to later work, even before the first selection.
  await seed(actor, targets[66]!);
  const first = await select(unavailable, actor, ref);
  expect(first.votes).toHaveLength(64);
  expect(first.after).toBeNull();
  expect(first.through).toEqual({ questionId: STANDARD_QUESTION_ID, targetId: targets[65]! });
  expect((await select(unavailable, actor, ref)).pageId).toBe(first.pageId);
  expect((await unavailable.commit(actor, binding(first), key())).value).toMatchObject({
    status: 'pending',
    reason: 'semantic-exact-currentness-and-held-repair-obligation-unavailable',
  });
  expect(await effects(actor)).toEqual([]);
  const fixture = producer();
  const commands = createRatingIdentityRepairCommands({ pool: database.pool, producer: fixture.port });
  for (const reason of ['epoch-pending', 'source-unavailable']) {
    fixture.setPending(reason);
    expect((await commands.commit(actor, binding(first), key())).value).toEqual({ status: 'pending', reason });
  }
  fixture.setPending('');
  expect((await commands.commit(actor, binding(first), key())).value.status).toBe('committed');
  const second = await select(commands, actor, ref);
  expect(second.votes).toHaveLength(2);
  expect(second.after).toEqual(first.next);
  expect([...first.votes, ...second.votes].map((vote) => vote.targetId)).toEqual(targets.slice(0, 66));
  await commands.commit(actor, binding(second), key());
  const last = await select(commands, actor, ref);
  expect(last.terminal).toBe(true);
  expect(last.votes).toEqual([]);
  expect((await commands.commit(actor, binding(last), key())).value).toMatchObject({
    status: 'committed',
    receipt: { terminal: true, checkpoint: second.next },
  });
  expect((await commands.select(actor, ref, key())).value).toMatchObject({ reason: 'stale-work' });
});

test('identity page locks the selected native vote until its transaction releases it', async () => {
  const actor = await voter();
  const target = newId(route);
  await seed(actor, target);
  const reader = await database.admin.connect();
  try {
    await reader.query('BEGIN');
    const page = await reader.query(pageVotes.sql, [
      route, actor.accountId, null, null, STANDARD_QUESTION_ID, target,
    ]);
    expect(page.rows.map((row) => row.targetId)).toEqual([target]);
    await expect(database.admin.query(
      'SELECT 1 FROM rating.vote WHERE route = $1 AND voter_id = $2 FOR UPDATE NOWAIT',
      [route, actor.accountId],
    )).rejects.toMatchObject({ code: '55P03' });
  } finally {
    await reader.query('ROLLBACK');
    reader.release();
  }
  expect((await database.admin.query(
    'SELECT 1 FROM rating.vote WHERE route = $1 AND voter_id = $2 FOR UPDATE NOWAIT',
    [route, actor.accountId],
  )).rowCount).toBe(1);
});

test('effects, receipt and checkpoint roll back together; lost responses replay while original votes and clears survive', async () => {
  const actor = await voter();
  const original = newId(route),
    terminal = newId(route),
    clearedOriginal = newId(route),
    clearedTerminal = newId(route);
  await seed(actor, original);
  await seed(actor, clearedOriginal, 9);
  await seed(actor, clearedTerminal, null);
  const fixture = producer((id) => (id === original ? terminal : id === clearedOriginal ? clearedTerminal : id));
  const commands = createRatingIdentityRepairCommands({ pool: database.pool, producer: fixture.port });
  const ref = await admit(commands, actor);
  const page = await select(commands, actor, ref);
  const before = await rows(actor);
  fixture.setHandoff(false);
  expect((await commands.commit(actor, binding(page), key())).value).toMatchObject({
    reason: 'semantic-repair-obligation-handoff-pending',
  });
  expect(await rows(actor)).toEqual(before);
  expect(await effects(actor)).toEqual([]);
  expect((await select(commands, actor, ref)).pageId).toBe(page.pageId);
  fixture.setHandoff(true);
  const requestKey = key();
  const committed = await commands.commit(actor, binding(page), requestKey);
  expect(committed.value.status).toBe('committed');
  const after = await rows(actor);
  expect(after.find((row) => row.target_id === original)).toMatchObject({
    counted_target: terminal,
    units: 7,
    revision: 1,
  });
  expect(after.find((row) => row.target_id === clearedOriginal)).toMatchObject({ counted_target: null, units: 9 });
  expect(after.find((row) => row.target_id === clearedTerminal)).toMatchObject({
    counted_target: clearedTerminal,
    units: null,
  });
  const emitted = await effects(actor);
  expect(
    emitted.some((event) => event.targetId === original && event.aggregateTargetId === terminal && event.units === 7),
  ).toBe(true);
  expect((await commands.commit(actor, binding(page), requestKey)).value).toEqual(committed.value);
  expect((await commands.commit(actor, binding(page), key())).value).toEqual(committed.value);
  expect(await effects(actor)).toEqual(emitted);
  await expect(commands.commit({ ...actor, scopes: [] }, binding(page), key())).rejects.toThrow();
  await expect(commands.commit({ ...actor, authnEpoch: 0 }, binding(page), key())).rejects.toThrow();
  const stranger = await voter();
  expect((await commands.commit(stranger, binding(page), key())).value).toMatchObject({ reason: 'stale-work' });
});

test('changed vote admission is fenced; eligible cancellation preserves votes and ineligible cancellation withdraws resumably', async () => {
  const actor = await voter();
  const original = newId(route);
  await seed(actor, original);
  const fixture = producer(() => newId(route));
  const commands = createRatingIdentityRepairCommands({ pool: database.pool, producer: fixture.port });
  const ref = await admit(commands, actor);
  const page = await select(commands, actor, ref);
  await database.admin.query('UPDATE rating.vote SET units = 8, revision = revision + 1 WHERE voter_id = $1', [
    actor.accountId,
  ]);
  expect((await commands.commit(actor, binding(page), key())).value).toMatchObject({ reason: 'vote-changed' });
  const refreshed = await select(commands, actor, ref);
  expect(refreshed.pageId).not.toBe(page.pageId);
  const before = await rows(actor);
  await commands.cancel(actor, ref, key());
  expect(await rows(actor)).toEqual(before);
  expect((await commands.commit(actor, binding(refreshed), key())).value).toMatchObject({ reason: 'stale-work' });
  expect((await commands.admit(actor, { workId: newId(route), expectedGeneration: null }, key())).value).toMatchObject({
    reason: 'stale-admission',
  });
  const next = (await commands.admit(actor, { workId: newId(route), expectedGeneration: ref.generation }, key())).value;
  if (next.status !== 'admitted') throw new Error(next.reason);
  const replacement = { workId: next.frame.workId, generation: next.frame.generation };
  await database.admin.query(
    `INSERT INTO rating.voter_state (route, voter_id, state, transition_id, purge_votes, populations)
    VALUES ($1, $2, 'ineligible', $3, false, '{}')`,
    [route, actor.accountId, newId(route)],
  );
  await commands.cancel(actor, replacement, key());
  const withdrawal = await select(commands, actor, replacement);
  expect(withdrawal.mode).toBe('withdrawal');
  await commands.commit(actor, binding(withdrawal), key());
  await commands.cancel(actor, replacement, key());
  const last = await select(commands, actor, replacement);
  expect(last.terminal).toBe(true);
  expect(last.after).toEqual(withdrawal.next);
  await commands.commit(actor, binding(last), key());
  expect((await rows(actor))[0]).toMatchObject({ counted_target: null, units: 8, revision: 2 });
  expect(await effects(actor)).toHaveLength(1);
});

test('repoint and rollback repair reuse original vote identity', async () => {
  const actor = await voter();
  const original = newId(route),
    terminal = newId(route);
  await seed(actor, original, null);
  let destination = terminal;
  const fixture = producer(() => destination);
  const commands = createRatingIdentityRepairCommands({ pool: database.pool, producer: fixture.port });
  let ref = await admit(commands, actor);
  for (const target of [terminal, original]) {
    destination = target;
    const page = await select(commands, actor, ref);
    await commands.commit(actor, binding(page), key());
    expect((await rows(actor))[0]).toMatchObject({
      target_id: original,
      counted_target: target,
      units: null,
      revision: 1,
    });
    await commands.cancel(actor, ref, key());
    const next = (await commands.admit(actor, { workId: newId(route), expectedGeneration: ref.generation }, key()))
      .value;
    if (next.status !== 'admitted') throw new Error(next.reason);
    ref = next.frame;
  }
});
