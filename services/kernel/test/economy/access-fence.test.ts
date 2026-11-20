import { afterAll, expect, test } from 'bun:test';
import { Pool, type PoolClient } from 'pg';
import { GLOBAL_CONTEXT } from '../../src/access/gates/catalogue.ts';
import { createNativeEconomyLedger, createNativeEconomyWallet } from '../../src/composition/economy.ts';
import { newId, routeOf } from '../../src/route/route.ts';

const applicationName = `economy-fence-${crypto.randomUUID()}`;
const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL must name the migrated test database');
const walletPool = new Pool({ connectionString: databaseUrl, application_name: applicationName });
const admin = new Pool({ connectionString: databaseUrl });

afterAll(() => Promise.all([walletPool.end(), admin.end()]));

async function fixture() {
  const bookId = `fence:${crypto.randomUUID()}`;
  const assetId = 'points';
  const accountId = newId(0x6d10);
  const recipientId = newId(0x6d20);
  for (const party of [accountId, recipientId]) {
    await admin.query(
      "INSERT INTO access.account (route,account_id,kind,state,transaction_id) VALUES ($1,$2,'actor','active',$2)",
      [routeOf(party), party],
    );
    await admin.query(
      `INSERT INTO access.resource_grant (route,resource_id,subject_id,action,valid,transaction_id)
       VALUES (0,$1,$2,'gate:economy',tstzrange(statement_timestamp() - interval '1 second',NULL,'[)'),$2)`,
      [GLOBAL_CONTEXT.id, party],
    );
  }
  const raw = createNativeEconomyLedger(walletPool, bookId);
  const wallet = createNativeEconomyWallet(walletPool, { bookId, node: 'b' });
  expect(await raw.provisionAsset({ id: assetId, scale: 0, transferable: true })).toMatchObject({ kind: 'ok' });
  expect(await raw.issue({ accountId, assetId, amount: '100', operationId: 'funding' })).toMatchObject({ kind: 'ok' });
  return { bookId, assetId, accountId, recipientId, raw, wallet };
}

async function waitForLock(blocker: PoolClient) {
  const pid = (await blocker.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0]!.pid;
  const deadline = Date.now() + 1_000;
  while (Date.now() < deadline) {
    const waiting = await admin.query(
      `SELECT 1 FROM pg_stat_activity WHERE application_name=$1 AND $2::integer=ANY(pg_blocking_pids(pid))`,
      [applicationName, pid],
    );
    if (waiting.rows.length > 0) return;
    await Bun.sleep(5);
  }
  throw new Error('The native wallet operation did not wait on the owner row lock');
}

async function race<T>(
  lock: (blocker: PoolClient) => Promise<unknown>,
  apply: (blocker: PoolClient) => Promise<unknown>,
  execute: () => Promise<T>,
) {
  const blocker = await admin.connect();
  try {
    await blocker.query('BEGIN');
    await lock(blocker);
    const attempt = execute().then(
      (value) => ({ value }),
      (error: unknown) => ({ error }),
    );
    await waitForLock(blocker);
    await apply(blocker);
    await blocker.query('COMMIT');
    return await attempt;
  } finally {
    await blocker.query('ROLLBACK');
    blocker.release();
  }
}

test('a direct grant revision that wins its row lock fences even an exact wallet replay', async () => {
  const { bookId, assetId, accountId, recipientId, raw, wallet } = await fixture();
  const input = { accountId, assetId, recipientId, operationId: 'transfer', amount: '30' };
  expect(await wallet.transfer(input)).toEqual({ kind: 'ok', value: { operationId: 'transfer' } });
  const where = "route=0 AND resource_id=$1 AND subject_id=$2 AND action='gate:economy'";
  const key = [GLOBAL_CONTEXT.id, accountId];
  const replay = await race(
    (client) => client.query(`SELECT 1 FROM access.resource_grant WHERE ${where} FOR UPDATE`, key),
    (client) =>
      client.query(
        `UPDATE access.resource_grant SET valid=tstzrange(lower(valid),clock_timestamp(),'[)') WHERE ${where}`,
        key,
      ),
    () => wallet.transfer(input),
  );
  expect(replay).toMatchObject({ error: { code: 'platform_closed' } });
  await expect(wallet.readBalance({ accountId, assetId })).rejects.toMatchObject({ code: 'platform_closed' });
  await expect(wallet.readStatement({ accountId, assetId, limit: 1 })).rejects.toMatchObject({
    code: 'platform_closed',
  });
  expect(await raw.readBalance({ accountId, assetId })).toMatchObject({ kind: 'ok', value: { posted: '70' } });
  const count = await admin.query(
    "SELECT count(*)::int AS n FROM economy.journal WHERE book_id=$1 AND kind='transfer'",
    [bookId],
  );
  expect(count.rows[0]).toEqual({ n: 1 });
});

test('terminal recipient wins its Account row lock without a receipt, posting or credit', async () => {
  const { bookId, assetId, accountId, recipientId, raw, wallet } = await fixture();
  const key = [routeOf(recipientId), recipientId];
  const attempted = await race(
    (client) => client.query('SELECT 1 FROM access.account WHERE route=$1 AND account_id=$2 FOR UPDATE', key),
    (client) =>
      client.query(
        "UPDATE access.account SET state='deleted', authn_fenced=true WHERE route=$1 AND account_id=$2",
        key,
      ),
    () => wallet.transfer({ accountId, assetId, recipientId, operationId: 'recipient-closing', amount: '30' }),
  );
  expect(attempted).toMatchObject({ error: { code: 'not_found' } });
  expect(await raw.readBalance({ accountId, assetId })).toMatchObject({ kind: 'ok', value: { posted: '100' } });
  const stored = await admin.query(
    'SELECT operation_id FROM economy.command_receipt WHERE book_id=$1 ORDER BY operation_id',
    [bookId],
  );
  expect(stored.rows).toEqual([{ operation_id: 'funding' }]);
});

test('the production wallet requires native local ownership of the configured Accounts homes', async () => {
  const { bookId, assetId, accountId } = await fixture();
  const foreign = createNativeEconomyWallet(walletPool, { bookId, node: 'other-node' });
  expect(await foreign.readBalance({ accountId, assetId })).toEqual({ kind: 'unavailable' });
});
