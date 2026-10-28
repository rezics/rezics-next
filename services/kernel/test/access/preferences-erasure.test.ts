import { afterAll, expect, test } from 'bun:test';
import { createPool } from '../../src/database/pool.ts';
import { newId, routeOf } from '../../src/route/route.ts';
import { createLifecycleCommands, createLifecycleInternals, LIFECYCLE_ACTIONS } from '../../src/access/lifecycle.ts';
import { createPreferenceCommands } from '../../src/access/preferences.ts';
import { admittedAccess, authenticateAccount } from '../support/admitted-access.ts';

const pool = createPool(process.env.DATABASE_URL!);
afterAll(() => pool.end());
const access = admittedAccess({ actions: LIFECYCLE_ACTIONS });
const commands = createLifecycleCommands({ pool, access });
const preferences = createPreferenceCommands({ pool, access, clock: () => new Date() });
const internal = createLifecycleInternals({
  pool,
  routeKey: new Uint8Array(32),
  provisioningEvidence: async () => null,
  recoveryEvidence: async () => null,
});
const key = () => Bun.randomUUIDv7();
const stored = (accountId: string) =>
  pool.query('SELECT * FROM access.account_preferences WHERE route=$1 AND account_id=$2', [
    routeOf(accountId),
    accountId,
  ]);
const account = (accountId: string) =>
  pool.query('SELECT state, authn_fenced, transaction_id FROM access.account WHERE route=$1 AND account_id=$2', [
    routeOf(accountId),
    accountId,
  ]);

async function person(savePreferences = true) {
  const accountId = newId(0x7351);
  await pool.query(
    `INSERT INTO access.account(route,account_id,kind,state,transaction_id)
     VALUES($1,$2,'actor','active',$2)`,
    [routeOf(accountId), accountId],
  );
  await pool.query(
    `INSERT INTO access.resource_grant(route,resource_id,subject_id,action,valid,transaction_id)
     SELECT $1,$2,$2,action,'(,)'::tstzrange,$2
     FROM unnest(ARRAY['account:read','account:update','account:delete','account:manage']) AS action`,
    [routeOf(accountId), accountId],
  );
  const actor = await authenticateAccount(
    access,
    { pool, deadline: Date.now() + 10000 },
    { accountId, clientId: 'preferences-erasure-test', scopes: [...LIFECYCLE_ACTIONS.keys()] },
  );
  const context = { actor, pool, deadline: Date.now() + 10000 };
  if (savePreferences) {
    await preferences.setPreferences(context, {
      accountId,
      key: key(),
      expectedVersion: 0,
      spoilerLevel: 2,
      suitability: 'show',
      shelf: { layouts: { all: 'table' }, gridSize: 'large', tableColumns: ['title', 'progress'] },
    });
    expect((await stored(accountId)).rows).toHaveLength(1);
  }
  return { accountId, context };
}

test('deleting an account erases its preferences row in the barrier transaction', async () => {
  const { accountId, context } = await person();
  const other = await person();
  const otherBefore = (await stored(other.accountId)).rows;
  const result = await commands.tombstone(context, { accountId, key: key() });
  expect((await account(accountId)).rows).toEqual([
    { state: 'deleted', authn_fenced: true, transaction_id: result.transactionId },
  ]);
  expect(await internal.readFenceReceipt(accountId, result.value.receiptId)).toEqual(result.value);
  expect((await stored(accountId)).rows).toEqual([]);
  expect((await stored(other.accountId)).rows).toEqual(otherBefore);
});

test('a suspension or recovery fence keeps the preferences row', async () => {
  const { accountId } = await person();
  const before = (await stored(accountId)).rows;
  const result = await internal.raiseFence({ accountId, key: key() });
  expect((await account(accountId)).rows).toEqual([
    { state: 'active', authn_fenced: true, transaction_id: result.transactionId },
  ]);
  expect((await stored(accountId)).rows).toEqual(before);
});

test('an account without a preferences row is deleted as before', async () => {
  const { accountId, context } = await person(false);
  expect((await stored(accountId)).rows).toEqual([]);
  const result = await commands.tombstone(context, { accountId, key: key() });
  expect((await account(accountId)).rows).toEqual([
    { state: 'deleted', authn_fenced: true, transaction_id: result.transactionId },
  ]);
  expect(await internal.readFenceReceipt(accountId, result.value.receiptId)).toEqual(result.value);
  expect((await stored(accountId)).rows).toEqual([]);
});

test('a failed barrier transaction preserves the preferences row', async () => {
  const { accountId, context } = await person();
  const before = (await stored(accountId)).rows;
  const accountBefore = (await account(accountId)).rows;
  await pool.query(
    `CREATE FUNCTION public.reject_preferences_erasure_receipt() RETURNS trigger LANGUAGE plpgsql AS $$
     BEGIN RAISE EXCEPTION 'receipt failure'; END $$`,
  );
  await pool.query(
    `CREATE TRIGGER reject_preferences_erasure_receipt BEFORE INSERT ON core.receipt
     FOR EACH ROW EXECUTE FUNCTION public.reject_preferences_erasure_receipt()`,
  );
  try {
    await expect(commands.tombstone(context, { accountId, key: key() })).rejects.toThrow('receipt failure');
  } finally {
    await pool.query('DROP TRIGGER reject_preferences_erasure_receipt ON core.receipt');
    await pool.query('DROP FUNCTION public.reject_preferences_erasure_receipt()');
  }
  expect((await account(accountId)).rows).toEqual(accountBefore);
  expect((await stored(accountId)).rows).toEqual(before);
});
