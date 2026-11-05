import { afterAll, beforeAll, expect, test } from 'bun:test';
import { noEffect, runCommand, type CommandTransaction } from '../../src/command/command.ts';
import { newId } from '../../src/route/route.ts';
import { bindIdentityRatingPage } from '../../src/semantic/identity-rating-adapter.ts';
import {
  acknowledgeIdentityRatingJournalPage as acknowledge,
  commitIdentityRatingJournalPage as commit,
  readIdentityRatingJournalCheckpoint as checkpoint,
  readIdentityRatingJournalPage as retained,
  reclaimIdentityRatingJournalPages as reclaim,
  verifyIdentityRatingJournalReclaimed as verify,
} from '../../src/semantic/identity-rating-journal.ts';
import type {
  IdentityRatingRepairScope,
  IdentityRatingSelectedPage,
} from '../../src/semantic/identity-rating-parent.ts';
import { IDENTITY_EPOCH_PROGRESS } from '../../src/semantic/events.ts';
import { epochFixture, type EpochFixture } from './support/identity-epoch.ts';

let f: EpochFixture;
beforeAll(async () => {
  f = await epochFixture();
});
afterAll(async () => {
  await f?.close();
});
const partition = 0x6e1;
const scope = (): IdentityRatingRepairScope => ({
  subjectId: newId(0x6e10),
  visibility: 'hidden',
  securityRevision: '9',
});
const write = <T>(body: (tx: CommandTransaction) => Promise<T>) =>
  runCommand(f.pool, { partition }, async (tx) => ({
    value: await body(tx),
    events: [
      {
        type: IDENTITY_EPOCH_PROGRESS,
        data: { partition, generation: '9' },
      },
    ],
  }));
const read = async <T>(body: (tx: CommandTransaction) => Promise<T>) =>
  (await runCommand(f.pool, { partition }, async (tx) => noEffect(await body(tx)))).value;
async function page(index: number, count: number): Promise<IdentityRatingSelectedPage> {
  const native = (await f.admin.query('SELECT node,epoch FROM core.partition WHERE partition_no=$1', [partition]))
    .rows[0];
  return {
    pageId: `page-${index}`,
    ownerId: native.node,
    ownerRevision: String(native.epoch),
    identityEpoch: '12',
    after: index ? String(index) : null,
    next: index === count - 1 ? null : String(index + 1),
    terminal: index === count - 1,
    items: [],
    native: { frontier: 'actual-retained-frontier', phase: 'withdrawal', revision: String(index) },
  };
}

test('native effects, exact selection and acknowledgement survive lost replies without replaying the writer', async () => {
  const s = scope(),
    p = await page(0, 1),
    binding = bindIdentityRatingPage(s, p)!.binding;
  let effects = 0;
  const producer = {
    async assertHeldAdmission(
      tx: CommandTransaction,
      selection: { scope: IdentityRatingRepairScope; page: IdentityRatingSelectedPage },
    ) {
      expect(selection.scope).toEqual(s);
      expect(selection.page).toEqual(p);
      expect(Object.isFrozen(selection.page)).toBe(true);
      expect(await checkpoint(tx, s)).toBeNull();
    },
    async applySelectedPage() {
      effects++;
    },
  };
  const first = await write((tx) => commit(tx, s, p, producer));
  expect(first.value.position).toBe(first.position.toString());
  const replay = await write((tx) => commit(tx, s, p, producer));
  expect(replay.value).toEqual(first.value);
  expect(effects).toBe(1);
  expect(await write((tx) => acknowledge(tx, s, binding, { ...first.value, position: '0' }))).toMatchObject({
    value: false,
  });
  await expect(
    (async () => {
      await write((tx) => acknowledge(tx, s, binding, first.value));
      throw new Error('lost acknowledgement reply');
    })(),
  ).rejects.toThrow('lost acknowledgement reply');
  expect(await read((tx) => checkpoint(tx, s))).toMatchObject({
    phase: 'reclamation',
    binding: { native: p.native, digest: binding.digest },
    receipt: first.value,
  });
  expect(await read((tx) => retained(tx, s, binding))).toMatchObject({ selected_page: p });
  expect(await write((tx) => acknowledge(tx, s, binding, first.value))).toMatchObject({ value: true });
  expect(await read((tx) => retained(tx, { ...s, securityRevision: '10' }, binding))).toBeNull();
});

test('bounded native deletion retains final-reference payload and recovers both cleanup commits including the tombstone', async () => {
  const s = scope(),
    pages = await Promise.all(Array.from({ length: 66 }, (_, i) => page(i, 66)));
  await write(async (tx) => {
    for (const p of pages) {
      const receipt = await commit(tx, s, p, { async assertHeldAdmission() {}, async applySelectedPage() {} });
      expect(await acknowledge(tx, s, bindIdentityRatingPage(s, p)!.binding, receipt)).toBe(true);
    }
  });
  const saved = (await read((tx) => checkpoint(tx, s)))!;
  expect(await write((tx) => reclaim(tx, s, async () => false))).toMatchObject({ value: 'still-referenced' });
  const count = async () =>
    Number(
      (
        await f.admin.query(
          "SELECT count(*) FROM semantic.identity_rating_repair_page WHERE partition_no=$1 AND binding->>'subjectId'=$2",
          [partition, s.subjectId],
        )
      ).rows[0].count,
    );
  expect(await count()).toBe(66);
  await expect(
    (async () => {
      expect(await write((tx) => reclaim(tx, s, async () => true))).toMatchObject({ value: 'continuing' });
      throw new Error('lost bounded deletion reply');
    })(),
  ).rejects.toThrow('lost bounded deletion reply');
  expect(await count()).toBe(2);
  expect(await read((tx) => retained(tx, s, saved.binding))).not.toBeNull();
  await expect(
    (async () => {
      expect(await write((tx) => reclaim(tx, s, async () => true))).toMatchObject({ value: 'reclaimed' });
      throw new Error('lost payload deletion reply');
    })(),
  ).rejects.toThrow('lost payload deletion reply');
  expect(await count()).toBe(0);
  expect(await read((tx) => verify(tx, s, saved))).toBe('current');
  expect(await read((tx) => verify(tx, s, { ...saved, receipt: { ...saved.receipt, position: '0' } }))).toBe('pending');
  expect(await write((tx) => reclaim(tx, s, async () => true))).toMatchObject({ value: 'already-reclaimed' });
  await expect(
    write((tx) =>
      commit(tx, s, pages[0]!, {
        async assertHeldAdmission() {},
        async applySelectedPage() {
          throw new Error('revived old pin');
        },
      }),
    ),
  ).rejects.toThrow('identity_rating_journal_stale');
  const original = (await f.admin.query('SELECT epoch,node FROM core.partition WHERE partition_no=$1', [partition]))
    .rows[0];
  try {
    // Moving away and back keeps the node name but changes the native incarnation.
    await f.admin.query('UPDATE core.partition SET epoch=epoch+2 WHERE partition_no=$1', [partition]);
    expect(await read((tx) => verify(tx, s, saved))).toBe('stale');
  } finally {
    await f.admin.query('UPDATE core.partition SET epoch=$2 WHERE partition_no=$1', [partition, original.epoch]);
  }
});

test('a failed producer rolls back its journal and cannot issue a native empty certificate', async () => {
  const s = scope(),
    p = await page(0, 1);
  await expect(
    write((tx) =>
      commit(tx, s, p, {
        async assertHeldAdmission() {},
        async applySelectedPage() {
          throw new Error('producer interrupted');
        },
      }),
    ),
  ).rejects.toThrow('producer interrupted');
  expect(await read((tx) => checkpoint(tx, s))).toBeNull();
  expect(await read((tx) => retained(tx, s, bindIdentityRatingPage(s, p)!.binding))).toBeNull();
});
