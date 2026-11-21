import { afterAll, beforeAll, expect, test } from 'bun:test';
import { Pool, type PoolClient } from 'pg';
import { createEconomyLedger } from '../../src/economy/ledger.ts';
import { marketTradeStatus } from '../../src/economy/market/trade.ts';
import {
  createMarketRepairQueue,
  enqueueMarketRepair,
  runMarketRepairWindow,
} from '../../src/economy/storage/market-repair.ts';
import { createNativeMarket } from '../../src/economy/storage/market-runner.ts';
import type { MarketStoreDatabase } from '../../src/economy/storage/market-store.ts';
import { workerTestEnv } from '../support/worker-env.ts';
import { openIsolatedEconomyDatabase } from './fixtures/isolated-database.ts';

let owned: Awaited<ReturnType<typeof openIsolatedEconomyDatabase>>;
let pool: Pool;
beforeAll(async () => {
  owned = await openIsolatedEconomyDatabase();
  pool = new Pool({ connectionString: owned.url });
});
afterAll(async () => {
  try {
    await pool?.end();
  } finally {
    await owned?.close();
  }
});

function value<T>(result: { kind: 'ok'; value: T } | { kind: string }): T {
  if (result.kind !== 'ok' || !('value' in result)) throw new Error(`Expected success, received ${result.kind}`);
  return result.value;
}

async function marketFixture() {
  const binding = { bookId: `market:${crypto.randomUUID()}`, node: 'b', itemHomeId: `items:${crypto.randomUUID()}` };
  const buyerId = crypto.randomUUID();
  const sellerId = crypto.randomUUID();
  const feeAccountId = crypto.randomUUID();
  const assetId = 'credit';
  let failFee = false;
  const database: MarketStoreDatabase = {
    read: (run) => run(pool),
    async transaction(run) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const query = (sql: string, args: unknown[] = []) => {
          if (failFee && sql.includes('UPDATE economy.position') && args[2] === feeAccountId)
            throw new Error('Private fixture fault');
          return client.query(sql, args);
        };
        const result = await run({ query: query as PoolClient['query'] });
        await client.query('COMMIT');
        return result;
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      } finally {
        client.release();
      }
    },
  };
  const market = createNativeMarket(database, binding);
  const ledger = createEconomyLedger(database, binding.bookId);
  value(await ledger.provisionAsset({ id: assetId, scale: 0, transferable: true }));
  value(await ledger.issue({ accountId: buyerId, assetId, amount: '100', operationId: 'opening' }));
  async function buy(tradeId: string) {
    const listingId = `listing-${tradeId}`;
    const item = {
      itemId: `item-${tradeId}`,
      homeId: binding.itemHomeId,
      holderId: sellerId,
      generation: 1n,
      reservationId: `hold-${tradeId}`,
    };
    const expiresAt = BigInt(Date.now() + 60_000);
    value(await market.item.register({ itemId: item.itemId, holderId: sellerId, marketable: true }));
    value(await market.item.reserveListing({ ...item, bookId: binding.bookId, listingId, protectedUntil: expiresAt }));
    value(
      await market.market.open({
        item,
        listingId,
        expiresAt,
        price: { ledgerBookId: binding.bookId, assetId, units: 50n, feeAccountId, policyVersion: 1n, feeBps: 2500n },
      }),
    );
    value(await market.market.purchase(listingId, 0n, { tradeId, buyerId, prepareUntil: expiresAt - 100n }));
  }
  const tradeId = 'purchase';
  await buy(tradeId);
  const queue = createMarketRepairQueue(database, binding);
  const request = { ...binding, tradeId, transactionId: Bun.randomUUIDv7() };
  async function row() {
    const { rows } = await pool.query(
      `SELECT attempts, outcome, claim_id, last_failure, finished_at IS NOT NULL AS finished,
              extract(epoch FROM (available_at - statement_timestamp()))::float8 AS remaining
       FROM economy.market_repair_request WHERE transaction_id = $1`,
      [request.transactionId],
    );
    return rows[0];
  }
  async function due() {
    await pool.query(
      'UPDATE economy.market_repair_request SET available_at = statement_timestamp() WHERE transaction_id = $1',
      [request.transactionId],
    );
  }
  async function balance(accountId: string) {
    return value(await ledger.readBalance({ accountId, assetId })).posted;
  }
  return {
    database,
    binding,
    market,
    queue,
    request,
    buy,
    row,
    due,
    balance,
    buyerId,
    sellerId,
    feeAccountId,
    failFee: (enabled: boolean) => {
      failFee = enabled;
    },
    accept: (input = request) => database.transaction((tx) => enqueueMarketRepair(tx, input)),
  };
}

test('acceptance shares the caller transaction and binds one immutable repair target', async () => {
  const f = await marketFixture();
  await f.buy('different-target');
  await expect(
    f.database.transaction(async (tx) => {
      expect(await enqueueMarketRepair(tx, f.request)).toEqual({ kind: 'queued' });
      throw new Error('Roll back command');
    }),
  ).rejects.toThrow('Roll back command');
  expect(await f.row()).toBeUndefined();
  const results = await Promise.all([f.accept(), f.accept()]);
  expect(results.map(({ kind }) => kind).sort()).toEqual(['queued', 'replayed']);
  for (const change of [
    { tradeId: 'different-target' },
    { node: 'different-node' },
    { itemHomeId: 'different-home' },
    { bookId: 'different-book' },
  ]) {
    expect(await f.accept({ ...f.request, ...change })).toEqual({ kind: 'conflict' });
  }
  expect(await f.accept({ ...f.request, transactionId: Bun.randomUUIDv7(), tradeId: 'missing' })).toEqual({
    kind: 'not_found',
  });
  expect(await f.accept({ ...f.request, transactionId: Bun.randomUUIDv7(), itemHomeId: 'different-home' })).toEqual({
    kind: 'not_found',
  });
  expect(await f.accept({ ...f.request, transactionId: 'invalid' })).toEqual({ kind: 'invalid_owner_request' });
  for (const binding of [
    { ...f.binding, node: 'different-node' },
    { ...f.binding, itemHomeId: 'different-home' },
    { ...f.binding, bookId: 'different-book' },
  ])
    expect(await createMarketRepairQueue(f.database, binding).claim()).toBeNull();
  expect(await f.row()).toMatchObject({ attempts: 0, claim_id: null, outcome: null });
});

test('lost repair completion reclaims only the named request and preserves original financial effects', async () => {
  const f = await marketFixture();
  const { tradeId } = f.request;
  for (let phase = 0; phase < 3; phase++) expect(value(await f.market.resumeTrade(tradeId)).retry).toEqual([]);
  expect(await f.accept()).toEqual({ kind: 'queued' });
  await runMarketRepairWindow(f.queue, async () => {
    throw new Error('Private transport detail');
  });
  const unavailable = await f.row();
  expect(unavailable).toMatchObject({ attempts: 1, outcome: null, claim_id: null, last_failure: 'unavailable' });
  expect(unavailable.remaining).toBeGreaterThan(20);
  expect(unavailable.remaining).toBeLessThanOrEqual(30);
  expect(await f.queue.claim()).toBeNull();

  await f.due();
  f.failFee(true);
  await runMarketRepairWindow(f.queue, f.market.resumeTrade);
  f.failFee(false);
  const deferred = await f.row();
  expect(deferred).toMatchObject({ attempts: 2, outcome: null, claim_id: null, last_failure: 'owner_retry' });
  expect(deferred.remaining).toBeGreaterThan(50);
  expect(deferred.remaining).toBeLessThanOrEqual(60);
  expect(await f.balance(f.sellerId)).toBe('0');
  expect(await f.balance(f.feeAccountId)).toBe('0');
  await pool.query(
    `UPDATE economy.market_work SET available_at = statement_timestamp()
     WHERE book_id = $1 AND instruction_id = 'market:release_proceeds:purchase'`,
    [f.binding.bookId],
  );
  await f.due();
  const interrupted = (await f.queue.claim())!;
  expect(interrupted).toMatchObject({ transactionId: f.request.transactionId, tradeId });
  expect(value(await f.market.resumeTrade(tradeId)).acknowledged).toEqual(['market:release_proceeds:purchase']);
  expect(await f.queue.claim()).toBeNull();
  expect(await f.queue.settle({ ...interrupted, tradeId: 'other' }, { finish: 'completed' })).toBe(false);
  expect(
    await createMarketRepairQueue(f.database, { ...f.binding, node: 'stale-node' }).settle(interrupted, {
      finish: 'completed',
    }),
  ).toBe(false);
  await f.due();
  expect(await f.queue.settle(interrupted, { finish: 'completed' })).toBe(false);
  const replacement = createMarketRepairQueue(f.database, f.binding);
  await Promise.all([
    runMarketRepairWindow(replacement, f.market.resumeTrade),
    runMarketRepairWindow(f.queue, f.market.resumeTrade),
  ]);
  expect(await f.queue.settle(interrupted, { retry: 'owner_retry' })).toBe(false);
  expect(await f.row()).toMatchObject({
    attempts: 4,
    finished: true,
    outcome: 'completed',
    claim_id: null,
    last_failure: null,
  });
  expect(await f.accept()).toEqual({ kind: 'replayed' });
  expect(await f.queue.claim()).toBeNull();
  expect(await f.balance(f.buyerId)).toBe('50');
  expect(await f.balance(f.sellerId)).toBe('38');
  expect(await f.balance(f.feeAccountId)).toBe('12');
  expect(await f.market.item.readItem('item-purchase')).toMatchObject({ holderId: f.buyerId, generation: 2n });
  const receipts = await pool.query(
    'SELECT count(*)::int AS count FROM economy.market_funds_receipt WHERE book_id = $1 AND trade_id = $2',
    [f.binding.bookId, tradeId],
  );
  expect(receipts.rows).toEqual([{ count: 3 }]);
});

test('the existing market schedule processes one private pass and leaves further progress to its sweep', async () => {
  const f = await marketFixture();
  expect(await f.accept()).toEqual({ kind: 'queued' });
  const program = `
    import { Pool } from 'pg';
    import { startWorker, readWorkerConfig } from './src/worker.ts';
    import { createWorkClient } from './src/work/client.ts';
    import { ECONOMY_MARKET_OWNER_WORK as market } from './src/composition/economy-owner-work.ts';
    const env = process.env;
    const binding = {
      bookId: env.KERNEL_ECONOMY_BOOK_ID,
      node: env.KERNEL_ECONOMY_NODE,
      itemHomeId: env.KERNEL_ECONOMY_MARKET_ITEM_HOME_ID,
    };
    let installed;
    const worker = await startWorker(
      { ...readWorkerConfig(env), handleSignals: false, effectsRelay: false },
      modules => modules.filter(module => module.name === 'economy').map(module => ({
        ...module,
        async register(context) {
          await module.register(context);
          installed = await context.client.getSchedule(market.name);
          if (installed) await context.client.pauseSchedule(market.name);
        },
      })),
      env,
    );
    const client = await createWorkClient(env.DATABASE_URL);
    const pool = new Pool({ connectionString: env.DATABASE_URL });
    try {
      const prior = await client.enqueue(
        { workflowName: market.workflow, queueName: 'maintenance' },
        new Date(), { ...binding, node: 'retired-node' },
      );
      const stale = await prior.getResult();
      const request = async () => (await pool.query(
        'SELECT attempts, outcome FROM economy.market_repair_request WHERE transaction_id = $1',
        [env.TEST_TRANSACTION_ID],
      )).rows[0];
      const untouched = await request();
      const run = async () => (await client.triggerSchedule(market.name)).getResult();
      const first = await run();
      const accepted = await request();
      const second = await run();
      console.log('REPAIR_WORK_RESULT=' + JSON.stringify({ installed, stale, untouched, first, accepted, second }));
    } finally {
      await pool.end();
      await client.close();
      await worker.stop();
    }
  `;
  const child = Bun.spawn([process.execPath, '-e', program], {
    cwd: import.meta.dir + '/../..',
    env: workerTestEnv({
      DATABASE_URL: owned.url,
      REYLO_CONFIG: process.env.REYLO_CONFIG,
      KERNEL_ECONOMY_BOOK_ID: f.binding.bookId,
      KERNEL_ECONOMY_NODE: f.binding.node,
      KERNEL_ECONOMY_MARKET_ITEM_HOME_ID: f.binding.itemHomeId,
      TEST_TRANSACTION_ID: f.request.transactionId,
    }),
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const timeout = setTimeout(() => child.kill(), 32_000);
  try {
    const [code, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    const prefix = 'REPAIR_WORK_RESULT=';
    const report = stdout.split('\n').find((line) => line.startsWith(prefix));
    if (code !== 0 || !report) throw new Error(`Worker exited ${code}\n${stdout}\n${stderr}`);
    expect(JSON.parse(report.slice(prefix.length))).toMatchObject({
      installed: { schedule: '*/10 * * * * *', queueName: 'maintenance', context: f.binding },
      stale: { kind: 'disabled' },
      untouched: { attempts: 0, outcome: null },
      first: {
        decisions: [{ tradeId: f.request.tradeId, kind: 'commit' }],
        acknowledged: ['market:escrow_funds:purchase'],
        retry: [],
      },
      accepted: { attempts: 1, outcome: 'completed' },
      second: {
        decisions: [],
        acknowledged: ['market:deliver_item:purchase', 'market:release_proceeds:purchase'],
        retry: [],
      },
    });
  } finally {
    clearTimeout(timeout);
  }
  expect(await f.row()).toMatchObject({ attempts: 1, finished: true, outcome: 'completed' });
  expect(marketTradeStatus((await f.market.market.readTrade(f.request.tradeId))!)).toBe('completed');
  expect(await f.balance(f.buyerId)).toBe('50');
  expect(await f.balance(f.sellerId)).toBe('38');
  expect(await f.balance(f.feeAccountId)).toBe('12');
}, 60_000);
