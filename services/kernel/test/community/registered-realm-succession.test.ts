import { afterAll, beforeAll, expect, test } from 'bun:test';
import {
  createRegisteredSuccessionFixture,
  type RegisteredSuccessionFixture,
} from './support/registered-realm-succession-fixture.ts';

let f: RegisteredSuccessionFixture;
beforeAll(async () => {
  f = await createRegisteredSuccessionFixture();
}, 180_000);
afterAll(async () => {
  await f?.close();
});

// Every erasure below enters through real Auth deletion and the normally registered worker.
// Reads observe native decisions; no test invokes the ownership adapter or assigns an orphan episode.
test('registered erasure orphans at the original root and leaves an ordinary member Realm owned', async () => {
  const owned = await f.realm();
  const unrelated = await f.realm();
  await f.member(unrelated, owned.owner.account);
  const release = await f.fault(owned, 'unlink');
  let erased: { at: string };
  let original: Awaited<ReturnType<typeof f.state>>;
  try {
    erased = await f.erase(owned.owner);
    original = await f.until(
      () => f.state(owned),
      (s) => s.decisions[0]?.decision_state === 'orphaned',
    );
    expect(original.locators).toHaveLength(1);
    await f.worker.crash();
  } finally {
    await release();
  }
  await f.restartWorker();
  await f.driver.settle();
  const orphan = await f.state(owned);
  expect(orphan.decisions).toEqual(original.decisions);
  expect(orphan.continuity).toEqual(original.continuity);
  expect(orphan.continuity).toEqual({
    ownership_state: 'orphaned',
    orphaned_at: erased.at,
    claim_eligible_at: orphan.continuity.claim_eligible_at,
    exact_deadline: true,
  });
  expect(orphan.decisions).toHaveLength(1);
  expect(orphan.decisions[0]).toMatchObject({ source_at: erased.at, decision_state: 'orphaned' });
  expect(orphan.locators).toEqual([]);
  const memberOnly = await f.state(unrelated, owned.owner.account.id);
  expect(memberOnly.continuity.ownership_state).toBe('owned');
  expect(memberOnly.owners).toEqual([{ subject_id: unrelated.owner.account.id }]);
  expect(memberOnly.decisions).toEqual([]);
  expect(memberOnly.locators).toEqual([]);
}, 180_000);

test('pending retains its locator across restart; lost unlink reply replays the same selected operation', async () => {
  const selected = await f.realm();
  const successor = await f.person();
  await f.member(selected, successor.account);
  await f.moderator(selected, successor.account);
  await f.suspend(successor.account, true);
  const erased = await f.erase(selected.owner);
  const pending = await f.until(
    () => f.state(selected),
    (s) => s.decisions.length === 1,
  );
  expect(pending.decisions[0]).toMatchObject({ source_at: erased.at, decision_state: null });
  expect(pending.locators).toHaveLength(1);
  expect(pending.continuity.ownership_state).toBe('owned');
  await f.worker.crash();
  const release = await f.fault(selected, 'unlink');
  try {
    await f.restartWorker();
    await f.suspend(successor.account, false, false);
    const applied = await f.until(
      () => f.state(selected),
      (s) => s.decisions[0]?.decision_state === 'owned',
    );
    expect(applied.owners).toEqual([{ subject_id: successor.account.id }]);
    expect(applied.locators).toHaveLength(1);
    expect(applied.continuity).toMatchObject({ ownership_state: 'owned', orphaned_at: null, claim_eligible_at: null });
    await f.worker.crash();
    await release();
    await f.restartWorker();
    await f.driver.settle();
    const replay = await f.state(selected);
    expect(replay.decisions).toEqual(applied.decisions);
    expect(replay.owners).toEqual(applied.owners);
    expect(replay.continuity).toEqual(applied.continuity);
    expect(replay.locators).toEqual([]);
  } catch (error) {
    // Fixture cleanup owns only its own worker and database.
    await release().catch(() => {});
    throw error;
  }
}, 180_000);

test('an unrelated continuity write failure rolls back native grants and decision and retains the owner locator', async () => {
  const selected = await f.realm();
  const before = await f.state(selected);
  const release = await f.fault(selected, 'continuity');
  try {
    await f.erase(selected.owner);
    await expect(f.driver.settle()).rejects.toThrow('registered succession fault');
    const failed = await f.state(selected);
    expect(failed.continuity).toEqual(before.continuity);
    expect(failed.owners).toEqual(before.owners);
    expect(failed.decisions).toEqual([]);
    expect(failed.locators).toHaveLength(1);
  } finally {
    await release();
  }
}, 180_000);
