import { afterAll, expect, test } from 'bun:test';
import { Pool, type PoolClient } from 'pg';
import type { EconomyResult, HoldAllocationKey, SpotFillSettlement } from '../../src/economy/contract.ts';
import { createEconomyLedger } from '../../src/economy/ledger.ts';

if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL must name the migrated test database');
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
afterAll(() => pool.end());

async function connected<T>(work: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    return await work(client);
  } finally {
    client.release();
  }
}

async function transaction<T>(work: (client: PoolClient) => Promise<EconomyResult<T>>): Promise<EconomyResult<T>> {
  return connected(async (client) => {
    await client.query('BEGIN');
    try {
      const result = await work(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    }
  });
}

async function fixture() {
  const bookId = `test:${crypto.randomUUID()}`;
  const ledger = createEconomyLedger({ transaction, read: connected }, bookId);
  const terms = {
    fillId: 'spot:test/fill/41',
    instrumentId: 'pair',
    policyVersion: '1',
    buyerId: crypto.randomUUID(),
    sellerId: crypto.randomUUID(),
    feeAccountId: crypto.randomUUID(),
    buyerHoldId: 'buyer-order',
    sellerHoldId: 'seller-order',
    baseAssetId: 'base',
    quoteAssetId: 'quote',
    baseUnits: '4',
    quoteUnits: '25',
    buyerFeeUnits: '2',
    sellerFeeUnits: '1',
  } satisfies SpotFillSettlement;
  const buyer = { accountId: terms.buyerId, assetId: terms.quoteAssetId, holdId: terms.buyerHoldId };
  const seller = { accountId: terms.sellerId, assetId: terms.baseAssetId, holdId: terms.sellerHoldId };
  const expiry = new Date(Date.now() + 60_000).toISOString();
  for (const [position, issued, reserved] of [
    [buyer, '100', '50'],
    [seller, '20', '10'],
  ] as const) {
    expect(await ledger.provisionAsset({ id: position.assetId, scale: 0, transferable: true })).toMatchObject({
      kind: 'ok',
    });
    expect(await ledger.issue({ ...position, operationId: 'issue', amount: issued })).toMatchObject({ kind: 'ok' });
    expect(
      await ledger.reserve({ ...position, operationId: 'hold', amount: reserved, expiresAt: expiry }),
    ).toMatchObject({ kind: 'ok' });
  }
  function allocation(position: typeof buyer | typeof seller): HoldAllocationKey {
    return { ...position, purpose: 'spot_fill', reference: terms.fillId };
  }
  async function protect(position: typeof buyer | typeof seller, amount: string) {
    expect(await ledger.allocate({ ...allocation(position), operationId: 'protect', amount })).toMatchObject({
      kind: 'ok',
    });
  }
  async function balance(accountId: string, assetId: string, posted: string, held: string) {
    expect(await ledger.readBalance({ accountId, assetId })).toMatchObject({ kind: 'ok', value: { posted, held } });
  }
  return { ledger, bookId, terms, buyer, seller, allocation, protect, balance };
}

test('one spot fill atomically posts the two assets and exact fees across repeated concurrent delivery', async () => {
  const f = await fixture();
  const { ledger, terms, buyer, seller, protect, balance } = f;
  await protect(buyer, '27');
  await protect(seller, '4');
  const settled = { kind: 'ok', value: { operationId: terms.fillId } } as const;
  expect(await Promise.all([ledger.settleSpotFill(terms), ledger.settleSpotFill(terms)])).toEqual([settled, settled]);
  expect(await ledger.settleSpotFill({ ...terms, sellerFeeUnits: '0' })).toEqual({ kind: 'operation_conflict' });
  await balance(buyer.accountId, buyer.assetId, '73', '23');
  await balance(seller.accountId, seller.assetId, '16', '6');
  await balance(buyer.accountId, seller.assetId, '4', '0');
  await balance(seller.accountId, buyer.assetId, '24', '0');
  await balance(terms.feeAccountId, buyer.assetId, '3', '0');
  expect(await ledger.readAllocation(f.allocation(buyer))).toMatchObject({ kind: 'ok', value: { status: 'captured' } });
  expect(await ledger.readAllocation(f.allocation(seller))).toMatchObject({
    kind: 'ok',
    value: { status: 'captured' },
  });
  const rows = await pool.query<{ asset_id: string; sum: string }>(
    'SELECT asset_id, sum(posted_delta)::text AS sum FROM economy.entry WHERE book_id = $1 GROUP BY asset_id ORDER BY asset_id',
    [f.bookId],
  );
  expect(rows.rows).toEqual([
    { asset_id: 'base', sum: '0' },
    { asset_id: 'quote', sum: '0' },
  ]);
});

test('a missing second allocation rolls back the first leg and allows completion under the original fill ID', async () => {
  const f = await fixture();
  const { ledger, terms, buyer, seller, protect, balance } = f;
  await protect(seller, '4');
  expect(await ledger.settleSpotFill(terms)).toEqual({ kind: 'allocation_missing' });
  expect(await ledger.readAllocation(f.allocation(seller))).toMatchObject({
    kind: 'ok',
    value: { status: 'protected' },
  });
  await balance(seller.accountId, seller.assetId, '20', '10');
  await balance(buyer.accountId, seller.assetId, '0', '0');
  expect((await pool.query('SELECT 1 FROM economy.spot_settlement WHERE book_id = $1', [f.bookId])).rowCount).toBe(0);
  await protect(buyer, '27');
  expect(await ledger.settleSpotFill({ ...terms, quoteUnits: '24' })).toEqual({ kind: 'operation_conflict' });
  await balance(seller.accountId, seller.assetId, '20', '10');
  expect(await ledger.settleSpotFill(terms)).toEqual({ kind: 'ok', value: { operationId: terms.fillId } });
});
