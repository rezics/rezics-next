import { afterAll, beforeAll, expect, test } from 'bun:test';
import { currentCommand, runCommand } from '../../src/command/command.ts';
import {
  drainInstalledIdentityRatingRepair,
  identityRatingRepairProducer,
} from '../../src/composition/identity-rating-repair.ts';
import { createRatingIdentityRepairCommands } from '../../src/rating/identity-repair.ts';
import {
  admitIdentityRepairGeneration,
  continueIdentityRepairGeneration,
} from '../../src/rating/identity-repair-run.ts';
import { RATING_IDENTITY_PAGE_SIZE } from '../../src/rating/identity-work-frame.ts';
import {
  identityMappingDigest,
  unavailableRatingIdentityProducer,
  IDENTITY_REPAIR_CROSS_HOME_REASON,
  IDENTITY_REPAIR_LATER_VOTE_REASON,
} from '../../src/rating/segment-identity-guard.ts';
import { partitionOf } from '../../src/route/route.ts';
import { newId } from '../../src/route/route.ts';
import { IDENTITY_EPOCH_PROGRESS, IDENTITY_RATING_REPAIR_CONTINUATION } from '../../src/semantic/events.ts';
import { IDENTITY_REPAIR_MEMBERSHIP_CAP } from '../../src/rating/identity-repair-bounds.ts';
import {
  IDENTITY_REPAIR_NATIVE_AT,
  laterIdentities,
  openIdentityRepairNative,
  type IdentityRepairNativeHost,
} from './support/identity-repair-native.ts';

let host: IdentityRepairNativeHost;
beforeAll(async () => {
  host = await openIdentityRepairNative({ identities: 67 });
}, 180_000);
afterAll(async () => {
  await host?.close();
});

test('installed module application admits, pages at 64, commits an empty terminal, and reads mapping receipt checkpoint independently', async () => {
  const voter = await host.actor();
  const beyond = host.originals[66]!;
  await host.seedMemberships(voter, IDENTITY_REPAIR_MEMBERSHIP_CAP);
  for (const original of host.originals.slice(0, 66)) await host.seedVote(voter, original);
  const started = await admitIdentityRepairGeneration(
    host.commands,
    voter,
    { workId: newId(host.route), expectedGeneration: null },
    host.key,
  );
  expect(started.status).toBe('complete');
  if (started.status !== 'complete') throw new Error(started.reason);
  expect(started.pages).toBe(3);
  expect(started.receipts).toHaveLength(3);
  expect(started.receipts[0]?.terminal).toBe(false);
  expect(started.receipts[1]?.terminal).toBe(false);
  expect(started.receipts[2]).toMatchObject({ terminal: true, checkpoint: started.receipts[1]?.checkpoint });
  await host.seedVote(voter, beyond);
  const votes = await host.read.countedVotes(voter.accountId);
  expect(votes).toHaveLength(67);
  expect(votes.filter((vote) => vote.targetId !== beyond).every((vote) => vote.revision === 1)).toBe(true);
  expect(votes.find((vote) => vote.targetId === beyond)).toMatchObject({
    countedTargetId: null,
    units: 7,
    revision: 1,
    changedAt: IDENTITY_REPAIR_NATIVE_AT,
  });
  for (const original of host.originals.slice(0, RATING_IDENTITY_PAGE_SIZE)) {
    expect(votes.find((vote) => vote.targetId === original)).toMatchObject({
      countedTargetId: host.terminal(original),
      units: 7,
      revision: 1,
      changedAt: IDENTITY_REPAIR_NATIVE_AT,
    });
  }
  const receipts = await host.read.receipts(voter.accountId);
  expect(receipts.map((receipt) => receipt.pageId)).toEqual(started.receipts.map((receipt) => receipt.pageId));
  expect(await host.read.checkpoint(voter.accountId)).toMatchObject({
    state: 'complete',
    mode: 'repair',
    generation: started.ref.generation,
    workId: started.ref.workId,
    selectedPageId: null,
    cursor: started.receipts[1]?.checkpoint,
  });
  expect(await host.read.pageEffects(voter.accountId)).toMatchObject([
    { terminal: false, pageId: started.receipts[0]?.pageId },
    { terminal: false, pageId: started.receipts[1]?.pageId },
    { terminal: true, pageId: started.receipts[2]?.pageId },
  ]);
  for (const receipt of started.receipts) {
    expect(receipt.obligationId).toBeTruthy();
    const mappingDigest = receipt.mappingDigest;
    if (mappingDigest === null) throw new Error('expected mapping digest');
    expect(mappingDigest).toMatch(/^[0-9a-f]{64}$/);
    const obligation = await host.read.boundObligation(voter.accountId, receipt.pageId);
    expect(obligation).toMatchObject({
      obligationId: receipt.obligationId,
      mappingDigest,
      receiptTransactionId: receipt.transactionId,
      state: 'bound',
      laterVote: true,
    });
    expect(identityMappingDigest(obligation?.mappings ?? [])).toBe(mappingDigest);
  }
  expect((await host.read.voteEffects(voter.accountId)).length).toBeGreaterThan(0);
  expect(
    (await host.read.voteEffects(voter.accountId)).every(
      (effect) => effect.populations.length === IDENTITY_REPAIR_MEMBERSHIP_CAP + 1,
    ),
  ).toBe(true);
});

test('exact redirect, competing originals and a terminal clear keep original vote keys', async () => {
  const isolated = await openIdentityRepairNative({ identities: 3, redirectIndexes: [1, 2] });
  try {
    const voter = await isolated.actor();
    const original = isolated.originals[1]!;
    const competitor = isolated.originals[2]!;
    const terminal = isolated.root;
    await isolated.seedVote(voter, original, 7, '2026-11-07T08:00:00.000000Z');
    await isolated.seedVote(voter, competitor, 9, '2026-11-07T09:00:00.000000Z');
    await isolated.seedVote(voter, terminal, null, '2026-11-07T10:00:00.000000Z');
    const repaired = await admitIdentityRepairGeneration(
      isolated.commands,
      voter,
      { workId: newId(isolated.route), expectedGeneration: null },
      isolated.key,
    );
    expect(repaired.status).toBe('complete');
    const rows = await isolated.read.countedVotes(voter.accountId);
    expect(rows.find((row) => row.targetId === original)).toMatchObject({
      countedTargetId: null,
      units: 7,
      revision: 1,
      changedAt: '2026-11-07T08:00:00.000000Z',
    });
    expect(rows.find((row) => row.targetId === competitor)).toMatchObject({
      countedTargetId: null,
      units: 9,
      revision: 1,
      changedAt: '2026-11-07T09:00:00.000000Z',
    });
    expect(rows.find((row) => row.targetId === terminal)).toMatchObject({
      countedTargetId: terminal,
      units: null,
      revision: 1,
      changedAt: '2026-11-07T10:00:00.000000Z',
    });
  } finally {
    await isolated.close();
  }
});

test('lost-response replay, cancelled eligible repair and withdrawal use installed receipts', async () => {
  const isolated = await openIdentityRepairNative({ identities: 2 });
  try {
    const voter = await isolated.actor();
    const stranger = await isolated.actor('stranger');
    const original = isolated.originals[1] ?? isolated.root;
    await isolated.seedVote(voter, original);
    const ref = await isolated.admit(voter);
    const page = await isolated.select(voter, ref);
    const requestKey = isolated.key();
    const committed = await isolated.commands.commit(voter, isolated.binding(page), requestKey);
    expect(committed.value.status).toBe('committed');
    expect((await isolated.commands.commit(voter, isolated.binding(page), requestKey)).value).toEqual(committed.value);
    expect((await isolated.commands.commit(voter, isolated.binding(page), isolated.key())).value).toEqual(
      committed.value,
    );
    await expect(
      isolated.commands.commit({ ...voter, scopes: [] }, isolated.binding(page), isolated.key()),
    ).rejects.toThrow();
    await expect(
      isolated.commands.commit({ ...voter, authnEpoch: 0 }, isolated.binding(page), isolated.key()),
    ).rejects.toThrow();
    expect((await isolated.commands.commit(stranger, isolated.binding(page), isolated.key())).value).toMatchObject({
      reason: 'stale-work',
    });
    expect(await isolated.read.receipt(voter.accountId, page.pageId)).toEqual(
      committed.value.status === 'committed' ? committed.value.receipt : null,
    );
    await isolated.commands.cancel(voter, ref, isolated.key());
    const next = await isolated.admit(voter, ref.generation);
    const before = await isolated.read.countedVotes(voter.accountId);
    await isolated.commands.cancel(voter, next, isolated.key());
    expect(await isolated.read.countedVotes(voter.accountId)).toEqual(before);
    await isolated.db.admin.query(
      `INSERT INTO rating.voter_state (route, voter_id, state, transition_id, purge_votes, populations)
       VALUES ($1, $2, 'ineligible', $3, false, '{}')`,
      [isolated.route, voter.accountId, newId(isolated.route)],
    );
    await isolated.commands.cancel(voter, next, isolated.key());
    const withdrawal = await isolated.select(voter, next);
    expect(withdrawal.mode).toBe('withdrawal');
    expect((await isolated.commands.commit(voter, isolated.binding(withdrawal), isolated.key())).value.status).toBe(
      'committed',
    );
    const last = await isolated.select(voter, next);
    expect(last.terminal).toBe(true);
    expect((await isolated.commands.commit(voter, isolated.binding(last), isolated.key())).value.status).toBe(
      'committed',
    );
    expect((await isolated.read.countedVotes(voter.accountId))[0]).toMatchObject({
      countedTargetId: null,
      units: 7,
      revision: 1,
    });
  } finally {
    await isolated.close();
  }
});

test('later identity change and later vote remain under durable custody and converge through ordinary scheduling', async () => {
  const isolated = await openIdentityRepairNative({ identities: 3 });
  try {
    const voter = await isolated.actor();
    const original = isolated.originals[1] ?? isolated.root;
    const later = isolated.originals[2] ?? isolated.root;
    await isolated.seedVote(voter, original);
    const first = await admitIdentityRepairGeneration(
      isolated.commands,
      voter,
      { workId: newId(isolated.route), expectedGeneration: null },
      isolated.key,
    );
    expect(first.status).toBe('complete');
    if (first.status !== 'complete') throw new Error(first.reason);
    await isolated.seedVote(voter, later);
    expect(
      (await isolated.read.obligations(voter.accountId)).some((row) => row.laterVote && row.state === 'bound'),
    ).toBe(true);
    await isolated.db.admin.query(`UPDATE semantic.identity_epoch_mapping SET epoch = epoch + 1 WHERE original = $1`, [
      original,
    ]);
    expect((await isolated.read.obligations(voter.accountId)).some((row) => row.laterChange)).toBe(true);
    expect((await drainInstalledIdentityRatingRepair(isolated.db.pool, isolated.partition)).drained).toBeGreaterThan(0);
    const continued = await continueIdentityRepairGeneration(isolated.commands, voter, first.ref, isolated.key);
    expect(continued.status).toBe('complete');
    if (continued.status !== 'complete') throw new Error(continued.reason);
    const votes = await isolated.read.countedVotes(voter.accountId);
    expect(votes.find((vote) => vote.targetId === later)?.countedTargetId).toBe(isolated.terminal(later));
    expect(votes.find((vote) => vote.targetId === original)?.revision).toBe(1);
    expect(await isolated.read.checkpoint(voter.accountId)).toMatchObject({
      state: 'complete',
      generation: continued.ref.generation,
    });
  } finally {
    await isolated.close();
  }
});

test('installed hold keeps the partition owner through COMMIT; omitted factory producer stays the unavailable seam', async () => {
  const isolated = await openIdentityRepairNative({ identities: 1 });
  try {
    const voter = await isolated.actor();
    await isolated.seedVote(voter, isolated.root);
    const ref = await isolated.admit(voter);
    const page = await isolated.select(voter, ref);
    const partition = partitionOf(isolated.route);
    const producer = identityRatingRepairProducer();
    await runCommand(isolated.db.pool, { partition }, async (tx) => {
      const authority = await producer.hold(tx, page);
      expect(authority.status).toBe('current');
      await expect(
        isolated.db.admin.query('SELECT 1 FROM core.partition WHERE partition_no=$1 FOR UPDATE NOWAIT', [partition]),
      ).rejects.toMatchObject({ code: '55P03' });
      return {
        value: currentCommand(tx).transactionId,
        events: [{ type: IDENTITY_EPOCH_PROGRESS, data: { partition, generation: '1' } }],
      };
    });
    await expect(
      isolated.db.admin.query('SELECT 1 FROM core.partition WHERE partition_no=$1 FOR UPDATE NOWAIT', [partition]),
    ).resolves.toMatchObject({ rowCount: 1 });
    expect((await isolated.commands.commit(voter, isolated.binding(page), isolated.key())).value.status).toBe(
      'committed',
    );
    const seam = createRatingIdentityRepairCommands({
      pool: isolated.db.pool,
      producer: unavailableRatingIdentityProducer,
    });
    const other = await isolated.actor('stranger');
    await isolated.seedVote(other, isolated.root);
    const otherPage = await isolated.select(other, await isolated.admit(other));
    expect((await seam.commit(other, isolated.binding(otherPage), isolated.key())).value).toMatchObject({
      reason: 'semantic-exact-currentness-and-held-repair-obligation-unavailable',
    });
  } finally {
    await isolated.close();
  }
});

test('later votes beyond the captured upper key stay off the page and mark later_vote on the bound obligation', async () => {
  const isolated = await openIdentityRepairNative({ identities: 2 });
  try {
    const voter = await isolated.actor();
    const original = isolated.originals[0]!;
    const last = isolated.originals.slice().sort().at(-1)!;
    await isolated.seedVote(voter, original);
    const ref = await isolated.admit(voter);
    const later = laterIdentities(last, 3);
    for (const target of later) await isolated.seedVote(voter, target);
    const page = await isolated.select(voter, ref);
    expect(page.votes.map((vote) => vote.targetId)).toEqual([original]);
    expect(later.some((target) => page.votes.some((vote) => vote.targetId === target))).toBe(false);
    expect((await isolated.commands.commit(voter, isolated.binding(page), isolated.key())).value.status).toBe(
      'committed',
    );
    const extra = laterIdentities(later.at(-1)!, 1)[0]!;
    await isolated.seedVote(voter, extra);
    const votes = await isolated.read.countedVotes(voter.accountId);
    expect(votes.find((vote) => vote.targetId === original)?.countedTargetId).toBe(isolated.terminal(original));
    for (const target of [...later, extra])
      expect(votes.find((vote) => vote.targetId === target)).toMatchObject({
        countedTargetId: null,
        units: 7,
        revision: 1,
      });
    expect((await isolated.read.obligations(voter.accountId)).some((row) => row.laterVote)).toBe(true);
    expect(IDENTITY_REPAIR_LATER_VOTE_REASON).toBe('identity-repair-later-vote');
  } finally {
    await isolated.close();
  }
});

test('foreign originals persist a preparing obligation and continuation under the original voter command', async () => {
  const isolated = await openIdentityRepairNative({ identities: 2, foreignIndexes: [1] });
  try {
    const voter = await isolated.actor();
    const foreign = isolated.foreignOriginals[0]!;
    await isolated.seedVote(voter, foreign);
    const ref = await isolated.admit(voter);
    const page = await isolated.select(voter, ref);
    const before = await isolated.read.countedVotes(voter.accountId);
    expect((await isolated.commands.commit(voter, isolated.binding(page), isolated.key())).value).toMatchObject({
      status: 'pending',
      reason: IDENTITY_REPAIR_CROSS_HOME_REASON,
    });
    expect(await isolated.read.countedVotes(voter.accountId)).toEqual(before);
    expect((await isolated.read.obligations(voter.accountId))[0]).toMatchObject({
      state: 'preparing',
      pageId: page.pageId,
    });
    const continuations = (
      await isolated.db.admin.query(`SELECT data FROM core.outbox WHERE type = $1 ORDER BY position, event_seq`, [
        IDENTITY_RATING_REPAIR_CONTINUATION,
      ])
    ).rows.map((row) => row.data);
    expect(continuations[0]).toMatchObject({
      kind: 'prepare',
      originals: [foreign],
    });
    expect((await isolated.select(voter, ref)).pageId).toBe(page.pageId);
    expect(await isolated.read.checkpoint(voter.accountId)).toMatchObject({
      state: 'active',
      selectedPageId: page.pageId,
    });
  } finally {
    await isolated.close();
  }
});

test('repeated empty terminal receipts replay without a second native page', async () => {
  const isolated = await openIdentityRepairNative({ identities: 1 });
  try {
    const voter = await isolated.actor();
    await isolated.seedVote(voter, isolated.root);
    const ref = await isolated.admit(voter);
    const first = await isolated.select(voter, ref);
    expect(first.votes).toHaveLength(1);
    expect((await isolated.commands.commit(voter, isolated.binding(first), isolated.key())).value.status).toBe(
      'committed',
    );
    const empty = await isolated.select(voter, ref);
    expect(empty.votes).toHaveLength(0);
    expect(empty.terminal).toBe(true);
    const requestKey = isolated.key();
    const committed = await isolated.commands.commit(voter, isolated.binding(empty), requestKey);
    expect(committed.value).toMatchObject({ status: 'committed', receipt: { terminal: true } });
    expect((await isolated.commands.commit(voter, isolated.binding(empty), requestKey)).value).toEqual(committed.value);
    expect((await isolated.commands.commit(voter, isolated.binding(empty), isolated.key())).value).toEqual(
      committed.value,
    );
    expect((await isolated.commands.select(voter, ref, isolated.key())).value).toMatchObject({
      status: 'pending',
      reason: 'stale-work',
    });
    const receipts = await isolated.read.receipts(voter.accountId);
    expect(receipts.filter((receipt) => receipt.terminal)).toHaveLength(1);
    expect(await isolated.read.checkpoint(voter.accountId)).toMatchObject({
      state: 'complete',
      selectedPageId: null,
    });
  } finally {
    await isolated.close();
  }
});
