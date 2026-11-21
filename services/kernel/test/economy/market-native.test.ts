import { afterAll, expect, test } from 'bun:test';
import { Pool, type PoolClient } from 'pg';
import { createEconomyLedger } from '../../src/economy/ledger.ts';
import { marketTradeStatus } from '../../src/economy/market/trade.ts';
import { createMarketFunds } from '../../src/economy/storage/market-funds.ts';
import { createNativeMarket } from '../../src/economy/storage/market-runner.ts';
import type { MarketStoreDatabase } from '../../src/economy/storage/market-store.ts';

if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL must name the migrated test database');
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
afterAll(() => pool.end());

function value<Value>(result: { kind: 'ok'; value: Value } | { kind: string }): Value {
  if (result.kind !== 'ok' || !('value' in result)) throw new Error(`Expected success, received ${result.kind}`);
  return result.value;
}

async function fixture(validMs = 60_000) {
  const bookId = `market:${crypto.randomUUID()}`;
  const itemHomeId = `item:${crypto.randomUUID()}`;
  const buyerId = crypto.randomUUID();
  const [sellerId, feeId] = [crypto.randomUUID(), crypto.randomUUID()].sort() as [string, string];
  let refuse: 'delivery' | 'fee' | null = null;
  let sellerPostingObserved = false;
  const database: MarketStoreDatabase = {
    read: (work) => work(pool),
    async transaction(work) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const query = client.query.bind(client) as (sql: string, values?: readonly unknown[]) => Promise<unknown>;
        const faultable = async (sql: string, params: readonly unknown[] = []) => {
          if (refuse === 'delivery' && sql.includes('UPDATE economy.market_item SET holder_id'))
            throw new Error('Injected item update failure');
          if (refuse === 'fee' && sql.includes('UPDATE economy.position') && params[2] === feeId)
            throw new Error('Injected fee update failure');
          const result = await query(sql, params);
          if (refuse === 'fee' && sql.includes('UPDATE economy.position') && params[2] === sellerId)
            sellerPostingObserved = true;
          return result;
        };
        const result = await work({ query: faultable as PoolClient['query'] });
        await client.query('COMMIT');
        return result;
      } catch (cause) {
        await client.query('ROLLBACK');
        throw cause;
      } finally {
        client.release();
      }
    },
  };
  const runtime = createNativeMarket(database, { bookId, itemHomeId });
  const ledger = createEconomyLedger(database, bookId);
  const assetId = 'credit';
  value(await ledger.provisionAsset({ id: assetId, scale: 0, transferable: true }));
  value(await ledger.issue({ accountId: buyerId, assetId, amount: '100', operationId: 'opening' }));
  const item = { itemId: 'item', homeId: itemHomeId, holderId: sellerId, generation: 1n, reservationId: 'hold-item' };
  const protectedUntil = BigInt(Date.now() + validMs);
  const listingId = 'listing';
  const tradeId = 'trade';
  value(await runtime.item.register({ itemId: item.itemId, holderId: sellerId, marketable: true }));
  value(await runtime.item.reserveListing({ ...item, bookId, listingId, protectedUntil }));
  value(
    await runtime.market.open({
      item,
      listingId,
      expiresAt: protectedUntil,
      price: { ledgerBookId: bookId, assetId, units: 50n, feeAccountId: feeId, policyVersion: 1n, feeBps: 2500n },
    }),
  );
  const prepareUntil = protectedUntil - 100n;
  value(await runtime.market.purchase(listingId, 0n, { tradeId, buyerId, prepareUntil }));
  const moneyOwner = { kind: 'ledger', id: bookId } as const;

  async function balance(accountId: string, posted: string, held: string) {
    expect(value(await ledger.readBalance({ accountId, assetId }))).toMatchObject({ posted, held });
  }

  async function expireLease(instructionId: string) {
    const { rowCount } = await pool.query(
      `UPDATE economy.market_work SET available_at = statement_timestamp()
       WHERE book_id = $1 AND instruction_id = $2 AND status = 'pending'`,
      [bookId, instructionId],
    );
    expect(rowCount).toBe(1);
  }

  async function escrow() {
    const { rows } = await pool.query<{ escrowId: string; phase: string }>(
      `SELECT escrow_id AS "escrowId", phase FROM economy.market_funds_trade WHERE book_id = $1 AND trade_id = $2`,
      [bookId, tradeId],
    );
    return rows[0]!;
  }

  return {
    runtime,
    database,
    ledger,
    bookId,
    itemHomeId,
    tradeId,
    buyerId,
    sellerId,
    feeId,
    item,
    assetId,
    prepareUntil,
    moneyOwner,
    balance,
    expireLease,
    escrow,
    faultAt: (where: typeof refuse) => {
      refuse = where;
    },
    didPostSellerBeforeFault: () => sellerPostingObserved,
  };
}

async function passNativeTime(instant: bigint) {
  await pool.query(
    'SELECT pg_sleep(greatest(0, $1::double precision / 1000 - extract(epoch FROM clock_timestamp())) + 0.01)',
    [instant.toString()],
  );
}

async function acceptAnotherTrade(f: Awaited<ReturnType<typeof fixture>>, tradeId: string, itemHomeId: string) {
  const runtime = createNativeMarket(f.database, { bookId: f.bookId, itemHomeId });
  const item = {
    itemId: `item-${tradeId}`,
    homeId: itemHomeId,
    holderId: f.sellerId,
    generation: 1n,
    reservationId: `hold-${tradeId}`,
  };
  const listingId = `listing-${tradeId}`;
  const expiresAt = BigInt(Date.now() + 60_000);
  value(await runtime.item.register({ itemId: item.itemId, holderId: f.sellerId, marketable: true }));
  value(await runtime.item.reserveListing({ ...item, bookId: f.bookId, listingId, protectedUntil: expiresAt }));
  value(
    await runtime.market.open({
      item,
      listingId,
      expiresAt,
      price: {
        ledgerBookId: f.bookId,
        assetId: f.assetId,
        units: 50n,
        feeAccountId: f.feeId,
        policyVersion: 1n,
        feeBps: 2500n,
      },
    }),
  );
  value(await runtime.market.purchase(listingId, 0n, { tradeId, buyerId: f.buyerId, prepareUntil: expiresAt - 100n }));
  return { runtime, tradeId, bookId: f.bookId };
}

const idle = { decisions: [], acknowledged: [], retry: [] };

test('named repair keeps the retained commit and recovers a lost proceeds acknowledgment without another effect', async () => {
  const f = await fixture(3000);
  expect(value(await f.runtime.resumeTrade(f.tradeId))).toEqual({
    ...idle,
    acknowledged: ['market:prepare_item:trade', 'market:prepare_funds:trade'],
  });
  expect(value(await f.runtime.resumeTrade(f.tradeId))).toEqual({
    ...idle,
    decisions: [{ tradeId: f.tradeId, kind: 'commit' }],
    acknowledged: ['market:escrow_funds:trade'],
  });
  const commitment = (await f.runtime.market.readTrade(f.tradeId))!.decision;
  const foreignBook = await fixture();
  const foreignHome = `home:${crypto.randomUUID()}`;
  const neighbors = [
    await acceptAnotherTrade(f, 'same-market', f.itemHomeId),
    await acceptAnotherTrade(f, 'other-home', foreignHome),
    await acceptAnotherTrade(foreignBook, 'other-book', f.itemHomeId),
  ];
  const repair = createNativeMarket(f.database, { bookId: f.bookId, itemHomeId: f.itemHomeId });
  for (const tradeId of ['missing', 'other-home', 'other-book']) {
    expect(await repair.resumeTrade(tradeId)).toEqual({ kind: 'not_found' });
  }
  const wrongHome = createNativeMarket(f.database, { bookId: f.bookId, itemHomeId: foreignHome });
  expect(await wrongHome.resumeTrade(f.tradeId)).toEqual({ kind: 'not_found' });

  await passNativeTime(f.prepareUntil);
  expect(value(await repair.resumeTrade(f.tradeId))).toEqual({
    ...idle,
    acknowledged: ['market:deliver_item:trade'],
  });
  const id = 'market:release_proceeds:trade';
  const claimId = crypto.randomUUID();
  const initial = value(await repair.market.claim(f.moneyOwner, id, claimId));
  const receipt = value(await repair.funds.execute({ bookId: f.bookId, instructionId: id, claimId }));
  expect(value(await repair.resumeTrade(f.tradeId))).toEqual(idle);
  expect(await repair.market.findIssuedWork(f.moneyOwner, id, claimId)).toEqual(initial.work);
  expect(marketTradeStatus((await repair.market.readTrade(f.tradeId))!)).toBe('committing');
  await f.balance(f.sellerId, '38', '0');
  await f.balance(f.feeId, '12', '0');

  await f.expireLease(id);
  const afterCrash = createNativeMarket(f.database, { bookId: f.bookId, itemHomeId: f.itemHomeId });
  const attempts = await Promise.all([afterCrash.resumeTrade(f.tradeId), afterCrash.resumeTrade(f.tradeId)]);
  expect(attempts.flatMap((attempt) => value(attempt).acknowledged)).toEqual([id]);
  expect(attempts.flatMap((attempt) => value(attempt).retry)).toEqual([]);
  expect(await afterCrash.funds.findReceipt(initial.work, receipt.receiptId)).toEqual(receipt);
  expect(await repair.market.acknowledge(f.moneyOwner, id, claimId, receipt.receiptId)).toEqual({
    kind: 'stale_claim',
  });
  const completed = (await repair.market.readTrade(f.tradeId))!;
  expect(completed.decision).toEqual(commitment);
  expect(marketTradeStatus(completed)).toBe('completed');
  expect(await repair.item.readItem(f.item.itemId)).toMatchObject({ holderId: f.buyerId, generation: 2n });
  const { escrowId } = await f.escrow();
  await f.balance(f.buyerId, '50', '0');
  await f.balance(escrowId, '0', '0');
  await f.balance(f.sellerId, '38', '0');
  await f.balance(f.feeId, '12', '0');
  expect(value(await repair.resumeTrade(f.tradeId))).toEqual(idle);
  expect(await repair.market.readTrade(f.tradeId)).toEqual(completed);

  for (const neighbor of neighbors) {
    expect(await neighbor.runtime.market.readTrade(neighbor.tradeId)).toMatchObject({
      revision: 0n,
      decision: null,
      receipts: {},
    });
    const work = await pool.query(
      'SELECT status, claim_id FROM economy.market_work WHERE book_id = $1 AND trade_id = $2 ORDER BY instruction_id',
      [neighbor.bookId, neighbor.tradeId],
    );
    expect(work.rows).toEqual([
      { status: 'pending', claim_id: null },
      { status: 'pending', claim_id: null },
    ]);
  }
}, 20_000);

test('named repair waits for preparation until native expiry then aborts and fences a previously admitted prepare', async () => {
  const f = await fixture(2000);
  const instructionId = 'market:prepare_funds:trade';
  const claimId = crypto.randomUUID();
  value(await f.runtime.market.claim(f.moneyOwner, instructionId, claimId));
  const issued = await f.runtime.market.findIssuedWork(f.moneyOwner, instructionId, claimId);
  const delayed = createMarketFunds(f.database, f.bookId, { findIssuedWork: async () => issued });
  expect(value(await f.runtime.resumeTrade(f.tradeId))).toEqual({
    ...idle,
    acknowledged: ['market:prepare_item:trade'],
  });
  expect(await f.runtime.market.findIssuedWork(f.moneyOwner, instructionId, claimId)).toEqual(issued);
  expect((await f.runtime.market.readTrade(f.tradeId))!.decision).toBeNull();
  await passNativeTime(f.prepareUntil);
  expect(value(await f.runtime.resumeTrade(f.tradeId))).toEqual({
    ...idle,
    decisions: [{ tradeId: f.tradeId, kind: 'abort' }],
    acknowledged: ['market:fence_item_abort:trade', 'market:fence_funds_abort:trade'],
  });
  expect(await f.runtime.market.findIssuedWork(f.moneyOwner, instructionId, claimId)).toBeNull();
  expect(await delayed.execute({ bookId: f.bookId, instructionId, claimId })).toEqual({ kind: 'out_of_order' });
  expect(value(await f.runtime.resumeTrade(f.tradeId))).toEqual({
    ...idle,
    acknowledged: ['market:release_item:trade', 'market:release_funds:trade'],
  });
  await f.balance(f.buyerId, '100', '0');
  expect(await f.runtime.item.readItem(f.item.itemId)).toMatchObject({ holderId: f.sellerId, generation: 1n });
  expect(marketTradeStatus((await f.runtime.market.readTrade(f.tradeId))!)).toBe('aborted');
  expect(value(await f.runtime.resumeTrade(f.tradeId))).toEqual(idle);
}, 20_000);

test('a fixed-price sale recovers actual escrow, delivery, fee failure and lost acknowledgment across expiry', async () => {
  const f = await fixture(2000);
  const prepared = await f.runtime.sweep(10);
  expect(prepared.acknowledged).toEqual(['market:prepare_item:trade', 'market:prepare_funds:trade']);
  await f.balance(f.buyerId, '100', '50');
  const commitment = value(await f.runtime.market.decide(f.tradeId, 2n, 'commit'));
  expect(commitment.kind).toBe('commit');
  await passNativeTime(f.prepareUntil);
  const holdId = `market:funds:${f.tradeId}`;
  const allocation = {
    accountId: f.buyerId,
    assetId: f.assetId,
    holdId,
    purpose: 'market_trade',
    reference: f.tradeId,
  } as const;
  expect(value(await f.ledger.readAllocation(allocation))).toMatchObject({ amount: '50', status: 'protected' });
  expect(await f.ledger.expire({ ...allocation, operationId: 'ordinary-expiration' })).toEqual({ kind: 'hold_closed' });

  const reopened = createNativeMarket(f.database, { bookId: f.bookId, itemHomeId: f.itemHomeId });
  expect((await reopened.sweep(10)).acknowledged).toEqual(['market:escrow_funds:trade']);
  const escrow = await f.escrow();
  expect(escrow.phase).toBe('escrowed');
  expect(escrow.escrowId.split('-')[2]?.[0]).toBe('4');
  await f.balance(f.buyerId, '50', '0');
  await f.balance(escrow.escrowId, '50', '0');
  f.faultAt('delivery');
  expect((await reopened.sweep(10)).retry).toEqual([{ id: 'market:deliver_item:trade', reason: 'work_unavailable' }]);
  expect(await reopened.item.readItem(f.item.itemId)).toMatchObject({ holderId: f.sellerId, generation: 1n });
  await f.balance(escrow.escrowId, '50', '0');
  await f.balance(f.sellerId, '0', '0');
  expect(await reopened.market.listReady(f.moneyOwner, 1)).toEqual({ kind: 'ok', value: [] });

  await f.expireLease('market:deliver_item:trade');
  f.faultAt('fee');
  const feeFailure = await reopened.sweep(10);
  expect(feeFailure.acknowledged).toEqual(['market:deliver_item:trade']);
  expect(feeFailure.retry).toEqual([{ id: 'market:release_proceeds:trade', reason: 'work_unavailable' }]);
  expect(f.didPostSellerBeforeFault()).toBe(true);
  expect(await reopened.item.readItem(f.item.itemId)).toMatchObject({ holderId: f.buyerId, generation: 2n });
  await f.balance(escrow.escrowId, '50', '0');
  await f.balance(f.sellerId, '0', '0');
  await f.balance(f.feeId, '0', '0');

  await f.expireLease('market:release_proceeds:trade');
  f.faultAt(null);
  const id = 'market:release_proceeds:trade';
  const claimId = crypto.randomUUID();
  const claimed = value(await reopened.market.claim(f.moneyOwner, id, claimId));
  expect(await reopened.market.findIssuedWork(f.moneyOwner, id, crypto.randomUUID())).toBeNull();
  const receipt = value(await reopened.funds.execute({ bookId: f.bookId, instructionId: id, claimId }));
  expect(await reopened.funds.findReceipt(claimed.work, receipt.receiptId)).toEqual(receipt);
  // Worker was lost after its transaction committed and before the coordinator received the acknowledgment.
  await f.expireLease(id);
  expect((await reopened.sweep(10)).acknowledged).toEqual([id]);
  expect(await f.escrow()).toMatchObject({ phase: 'settled' });
  await f.balance(escrow.escrowId, '0', '0');
  await f.balance(f.sellerId, '38', '0');
  await f.balance(f.feeId, '12', '0');
  expect(marketTradeStatus((await reopened.market.readTrade(f.tradeId))!)).toBe('completed');
  expect(await reopened.sweep(10)).toEqual({ decisions: [], acknowledged: [], retry: [] });
});

test('a funds abort fence rejects a prepare already admitted before the coordinator decided', async () => {
  const f = await fixture();
  const instructionId = 'market:prepare_funds:trade';
  const claimId = crypto.randomUUID();
  value(await f.runtime.market.claim(f.moneyOwner, instructionId, claimId));
  const issued = await f.runtime.market.findIssuedWork(f.moneyOwner, instructionId, claimId);
  expect(issued?.id).toBe(instructionId);
  const delayed = createMarketFunds(f.database, f.bookId, { findIssuedWork: async () => issued });
  value(await f.runtime.market.decide(f.tradeId, 0n, 'abort'));
  expect(await f.runtime.market.findIssuedWork(f.moneyOwner, instructionId, claimId)).toBeNull();
  const fenced = await f.runtime.sweep(10);
  expect(fenced.acknowledged).toEqual(['market:fence_item_abort:trade', 'market:fence_funds_abort:trade']);
  expect(await delayed.execute({ bookId: f.bookId, instructionId, claimId })).toEqual({ kind: 'out_of_order' });
  await f.balance(f.buyerId, '100', '0');
  expect((await f.runtime.sweep(10)).acknowledged).toEqual(['market:release_item:trade', 'market:release_funds:trade']);
  expect(marketTradeStatus((await f.runtime.market.readTrade(f.tradeId))!)).toBe('aborted');
  await f.balance(f.buyerId, '100', '0');
});

test('abort keeps prepared funds protected until both owner fences are acknowledged', async () => {
  const f = await fixture();
  expect((await f.runtime.sweep(10)).acknowledged).toEqual(['market:prepare_item:trade', 'market:prepare_funds:trade']);
  await f.balance(f.buyerId, '100', '50');
  value(await f.runtime.market.decide(f.tradeId, 2n, 'abort'));
  const id = 'market:fence_funds_abort:trade';
  const claimId = crypto.randomUUID();
  value(await f.runtime.market.claim(f.moneyOwner, id, claimId));
  const fence = value(await f.runtime.funds.execute({ bookId: f.bookId, instructionId: id, claimId }));
  value(await f.runtime.market.acknowledge(f.moneyOwner, id, claimId, fence.receiptId));
  expect(await f.runtime.market.listReady(f.moneyOwner, 1)).toEqual({ kind: 'ok', value: [] });
  await f.balance(f.buyerId, '100', '50');
  expect((await f.runtime.sweep(10)).acknowledged).toEqual([
    'market:fence_item_abort:trade',
    'market:release_funds:trade',
  ]);
  await f.balance(f.buyerId, '100', '0');
  expect((await f.runtime.sweep(10)).acknowledged).toEqual(['market:release_item:trade']);
  expect(marketTradeStatus((await f.runtime.market.readTrade(f.tradeId))!)).toBe('aborted');
});
