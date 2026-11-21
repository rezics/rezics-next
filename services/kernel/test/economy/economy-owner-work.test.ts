import { randomUUID } from 'node:crypto';
import { afterAll, expect, test } from 'bun:test';
import { Pool, type PoolClient } from 'pg';
import { createNativeEconomyDatabase, createNativeEconomyLedger } from '../../src/composition/economy.ts';
import {
  ECONOMY_CREDIT_EXPIRY_WORK,
  ECONOMY_MARKET_OWNER_WORK,
  ECONOMY_SPOT_OWNER_WORK,
} from '../../src/composition/economy-owner-work.ts';
import type { AssetProgram } from '../../src/economy/contract.ts';
import { createEconomyLedger } from '../../src/economy/ledger.ts';
import { marketTradeStatus } from '../../src/economy/market/trade.ts';
import { createNativeMarket } from '../../src/economy/storage/market-runner.ts';
import type { MarketStoreDatabase } from '../../src/economy/storage/market-store.ts';
import { createSpotStore } from '../../src/economy/storage/spot-store.ts';
import { createWorkClient } from '../../src/work/client.ts';
import { workerTestEnv } from '../support/worker-env.ts';

if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL must name the migrated test database');
const databaseUrl = process.env.DATABASE_URL;
const pool = new Pool({ connectionString: databaseUrl });
afterAll(() => pool.end());

function value<T>(result: { kind: 'ok'; value: T } | { kind: string }): T {
  if (result.kind !== 'ok' || !('value' in result)) throw new Error(`Expected success, received ${result.kind}`);
  return result.value;
}

async function runWorker(
  action: string,
  variables: Record<string, string> = {},
  workerDeadline = 22_000,
): Promise<unknown> {
  const program = `
    import { startWorker, readWorkerConfig } from './src/worker.ts';
    import { createWorkClient } from './src/work/client.ts';
    import {
      ECONOMY_CREDIT_EXPIRY_WORK as expiry,
      ECONOMY_MARKET_OWNER_WORK as market,
      ECONOMY_SPOT_OWNER_WORK as spot,
    } from './src/composition/economy-owner-work.ts';
    const env = process.env;
    let installed;
    const worker = await startWorker(
      { ...readWorkerConfig(env), handleSignals: false, effectsRelay: false },
      modules => modules.filter(module => module.name === 'economy').map(module => ({
        ...module,
        async register(context) {
          await module.register(context);
          const client = context.client;
          installed = await Promise.all([spot, market, expiry].map(schedule => client.getSchedule(schedule.name)));
          // Keep manual triggering deterministic while testing the actual installed DBOS schedules.
          for (const entry of installed) if (entry) await client.pauseSchedule(entry.scheduleName);
        },
      })),
      env,
    );
    const client = await createWorkClient(env.DATABASE_URL);
    try {
      const run = async (schedule) => (await client.triggerSchedule(schedule.name)).getResult();
      const report = await (async () => { ${action} })();
      console.log('OWNER_WORK_RESULT=' + JSON.stringify(report));
    } finally {
      await client.close();
      await worker.stop();
    }
  `;
  const processFixture = Bun.spawn([process.execPath, '-e', program], {
    cwd: import.meta.dir + '/../..',
    env: workerTestEnv({
      DATABASE_URL: databaseUrl,
      REYLO_CONFIG: process.env.REYLO_CONFIG,
      ...variables,
    }),
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const timeout = setTimeout(() => processFixture.kill(), workerDeadline);
  try {
    const [code, stdout, stderr] = await Promise.all([
      processFixture.exited,
      new Response(processFixture.stdout).text(),
      new Response(processFixture.stderr).text(),
    ]);
    const report = stdout.split('\n').find((line) => line.startsWith('OWNER_WORK_RESULT='));
    if (code !== 0 || !report) throw new Error(`Worker exited ${code}\n${stdout}\n${stderr}`);
    return JSON.parse(report.slice('OWNER_WORK_RESULT='.length));
  } finally {
    clearTimeout(timeout);
  }
}

async function spotFixture(bookId: string) {
  const ledger = createNativeEconomyLedger(pool, bookId);
  const store = createSpotStore(createNativeEconomyDatabase(pool), bookId);
  const buyer = randomUUID();
  const seller = randomUUID();
  const feeAccountId = randomUUID();
  for (const id of ['base', 'quote']) value(await ledger.provisionAsset({ id, scale: 0, transferable: true }));
  value(await ledger.issue({ accountId: seller, assetId: 'base', amount: '100', operationId: 'base-opening' }));
  value(await ledger.issue({ accountId: buyer, assetId: 'quote', amount: '100', operationId: 'quote-opening' }));

  async function acceptSell(id: string) {
    value(
      await store.provision({
        id,
        ledgerBookId: bookId,
        policyVersion: 1n,
        baseAssetId: 'base',
        quoteAssetId: 'quote',
        baseUnitsPerLot: 1n,
        quoteUnitsPerPriceTick: 1n,
        makerFeeBps: 0n,
        takerFeeBps: 0n,
        feeAccountId,
      }),
    );
    value(await store.place(id, { orderId: 'ask', accountId: seller, side: 'sell', price: 10n, lots: 1n }));
  }

  async function acceptCross(id: string) {
    await acceptSell(id);
    value(await store.match(id, value(await store.readBook(id)).revision));
    value(await store.place(id, { orderId: 'bid', accountId: buyer, side: 'buy', price: 10n, lots: 1n }));
  }

  return { ledger, store, buyer, seller, acceptSell, acceptCross };
}

async function marketFixture(bookId: string, itemHomeId: string) {
  const database: MarketStoreDatabase = {
    read: (work) => work(pool),
    async transaction<T>(work: (client: Pick<PoolClient, 'query'>) => Promise<T>) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const result = await work(client);
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
  const owners = createNativeMarket(database, { bookId, itemHomeId });
  const ledger = createNativeEconomyLedger(pool, bookId);
  const buyer = randomUUID();
  const seller = randomUUID();
  const fee = randomUUID();
  const price = {
    ledgerBookId: bookId,
    assetId: 'credit',
    units: 50n,
    feeAccountId: fee,
    policyVersion: 1n,
    feeBps: 2500n,
  };
  value(await ledger.provisionAsset({ id: price.assetId, scale: 0, transferable: true }));
  value(await ledger.issue({ accountId: buyer, assetId: price.assetId, amount: '100', operationId: 'credit-opening' }));
  const item = { itemId: 'item', homeId: itemHomeId, holderId: seller, generation: 1n, reservationId: 'item-hold' };
  const protectedUntil = BigInt(Date.now() + 60_000);
  value(await owners.item.register({ itemId: item.itemId, holderId: seller, marketable: true }));
  value(await owners.item.reserveListing({ ...item, bookId, listingId: 'listing', protectedUntil }));
  value(await owners.market.open({ item, listingId: 'listing', expiresAt: protectedUntil, price }));
  value(
    await owners.market.purchase('listing', 0n, {
      tradeId: 'trade',
      buyerId: buyer,
      prepareUntil: protectedUntil - 100n,
    }),
  );
  return { ...owners, ledger, buyer, seller, fee, itemId: item.itemId, assetId: price.assetId };
}

async function expiryIn(milliseconds: number): Promise<string> {
  const result = await pool.query<{ expiresAt: Date }>(
    `SELECT clock_timestamp() + $1::integer * interval '1 millisecond' AS "expiresAt"`,
    [milliseconds],
  );
  return result.rows[0]!.expiresAt.toISOString();
}

async function waitForExpiry(expiresAt: string) {
  await pool.query('SELECT pg_sleep(greatest(extract(epoch FROM ($1::timestamptz - clock_timestamp())), 0) + 0.02)', [
    expiresAt,
  ]);
}

async function awardPromotion(bookId: string, id: string, expiresAt: string, accounts: readonly string[]) {
  const ledger = createNativeEconomyLedger(pool, bookId);
  const policy = {
    id,
    scale: 0,
    transferable: false,
    programId: `programme-${id}`,
    version: '1',
    issuanceSource: 'promotion',
    supplyCap: '1000',
    redeemable: true,
    expiresAt,
  } satisfies AssetProgram;
  value(await ledger.provisionAssetProgram(policy));
  for (const accountId of accounts) {
    const award = { assetId: id, accountId, issuanceSource: policy.issuanceSource };
    value(await ledger.enrollAssetProgramRecipient(award));
    value(await ledger.issueProgramUnits({ ...award, sourceReference: accountId, amount: '7' }));
  }
  return ledger;
}

test('absent Economy bindings remove only their schedules and leave already queued owner work inert', async () => {
  const bookId = `economy:${randomUUID()}`;
  const itemHomeId = `item:${randomUUID()}`;
  const f = await spotFixture(bookId);
  await f.acceptSell('unconfigured');
  const purchase = await marketFixture(bookId, itemHomeId);
  const expiresAt = await expiryIn(1500);
  const credit = { accountId: randomUUID(), assetId: 'promotion' };
  const creditLedger = await awardPromotion(bookId, credit.assetId, expiresAt, [credit.accountId]);
  expect(await creditLedger.expireProgramCredits(credit)).toEqual({ kind: 'invalid_operation' });
  await waitForExpiry(expiresAt);
  const client = await createWorkClient(databaseUrl);
  const neighbor = `economy-test-neighbor-${randomUUID()}`;
  try {
    const settings = { bookId, node: 'worker-test', itemHomeId };
    await client.applySchedules(
      [
        { ...ECONOMY_SPOT_OWNER_WORK },
        { ...ECONOMY_MARKET_OWNER_WORK },
        { ...ECONOMY_CREDIT_EXPIRY_WORK },
        { name: neighbor, workflow: 'unrelated.inventory' },
      ].map(({ name, workflow }) => ({
        scheduleName: name,
        workflowName: workflow,
        queueName: 'maintenance',
        schedule: '17 0 29 2 *',
        context: settings,
      })),
    );
    const enqueue = (workflowName: string) =>
      client.enqueue({ workflowName, queueName: 'maintenance' }, new Date(), settings);
    const spotJob = await enqueue(ECONOMY_SPOT_OWNER_WORK.workflow);
    const marketJob = await enqueue(ECONOMY_MARKET_OWNER_WORK.workflow);
    const expiryJob = await enqueue(ECONOMY_CREDIT_EXPIRY_WORK.workflow);
    const truth = await runWorker(
      `
        const [spotJob, marketJob, expiryJob] = await Promise.all(
          [env.SPOT_JOB, env.MARKET_JOB, env.EXPIRY_JOB].map(id => client.retrieveWorkflow(id).getResult()),
        );
        return {
          spotSchedule: (await client.getSchedule(spot.name)) ?? null,
          marketSchedule: (await client.getSchedule(market.name)) ?? null,
          expirySchedule: (await client.getSchedule(expiry.name)) ?? null,
          neighbor: (await client.getSchedule(env.NEIGHBOR))?.status,
          spotJob, marketJob, expiryJob,
        };
      `,
      {
        SPOT_JOB: spotJob.workflowID,
        MARKET_JOB: marketJob.workflowID,
        EXPIRY_JOB: expiryJob.workflowID,
        NEIGHBOR: neighbor,
      },
    );
    expect(truth).toEqual({
      spotSchedule: null,
      marketSchedule: null,
      expirySchedule: null,
      neighbor: 'ACTIVE',
      spotJob: { kind: 'disabled' },
      marketJob: { kind: 'disabled' },
      expiryJob: { kind: 'disabled' },
    });
  } finally {
    await client.deleteSchedule(neighbor);
    await client.close();
  }
  expect(value(await f.store.readOwnOrder('unconfigured', 'ask', f.seller)).status).toBe('matching');
  expect(value(await f.ledger.readBalance({ accountId: f.seller, assetId: 'base' })).held).toBe('1');
  expect(await purchase.market.readTrade('trade')).toMatchObject({ revision: 0n, decision: null, receipts: {} });
  expect(value(await creditLedger.readBalance(credit))).toMatchObject({ posted: '7', restricted: '7', available: '0' });
  expect(value(await creditLedger.readStatement({ ...credit, limit: 2 })).entries.map(({ kind }) => kind)).toEqual([
    'issue',
  ]);
});

test('the configured worker settles real spot and market work and pages past an individual match failure', async () => {
  const bookId = `economy:${randomUUID()}`;
  const itemHomeId = `item:${randomUUID()}`;
  const f = await spotFixture(bookId);
  await f.acceptCross('aaa');
  const reservation = await pool.query<{ reservation_id: string }>(
    'SELECT reservation_id::text FROM economy.spot_order WHERE book_id = $1 AND instrument_id = $2 AND order_id = $3',
    [bookId, 'aaa', 'bid'],
  );
  // Interrupt one admitted match by closing its funding hold through the trusted fixture ledger.
  value(
    await f.ledger.release({
      accountId: f.buyer,
      assetId: 'quote',
      holdId: reservation.rows[0]!.reservation_id,
      operationId: 'interrupted',
    }),
  );
  for (let index = 0; index < 31; index++) await f.acceptSell(`entry-${String(index).padStart(2, '0')}`);
  await f.acceptCross('zzz');
  const purchase = await marketFixture(bookId, itemHomeId);
  const client = await createWorkClient(databaseUrl);
  try {
    const truth = await runWorker(
      `
        const { createHash } = await import('node:crypto');
        const first = await client.triggerSchedule(spot.name);
        const page = await first.getResult();
        const book = { bookId: env.KERNEL_ECONOMY_BOOK_ID, node: env.KERNEL_ECONOMY_NODE };
        const key = createHash('sha256').update(JSON.stringify([book, first.workflowID, 'entry-30'])).digest('hex');
        const continuation = await client.retrieveWorkflow('economy:spot:page:' + key).getResult();
        const old = await client.enqueue(
          { workflowName: spot.workflow, queueName: 'maintenance' },
          new Date(), { bookId: book.bookId, node: 'obsolete-node' },
        );
        await run(spot);
        for (let pass = 0; pass < 4; pass++) await run(market);
        return {
          spot: installed[0],
          market: installed[1],
          page,
          continuation,
          stale: await old.getResult(),
        };
      `,
      {
        KERNEL_ECONOMY_BOOK_ID: bookId,
        KERNEL_ECONOMY_NODE: 'worker-test',
        KERNEL_ECONOMY_MARKET_ITEM_HOME_ID: itemHomeId,
      },
    );
    expect(truth).toMatchObject({
      spot: { status: 'ACTIVE', schedule: '*/10 * * * * *', queueName: 'maintenance' },
      market: { status: 'ACTIVE', context: { bookId, node: 'worker-test', itemHomeId } },
      page: { kind: 'advanced', matched: 31, deferred: 1 },
      continuation: { kind: 'advanced', matched: 1, deferred: 0 },
      stale: { kind: 'disabled' },
    });
  } finally {
    await client.deleteSchedule(ECONOMY_SPOT_OWNER_WORK.name);
    await client.deleteSchedule(ECONOMY_MARKET_OWNER_WORK.name);
    await client.deleteSchedule(ECONOMY_CREDIT_EXPIRY_WORK.name);
    await client.close();
  }

  expect(value(await f.store.readOwnOrder('aaa', 'bid', f.buyer)).status).toBe('matching');
  expect(value(await f.store.readOwnOrder('entry-30', 'ask', f.seller)).status).toBe('resting');
  expect(value(await f.store.readOwnOrder('zzz', 'bid', f.buyer)).status).toBe('filled');
  expect((await pool.query('SELECT 1 FROM economy.spot_settlement WHERE book_id = $1', [bookId])).rowCount).toBe(1);
  expect(value(await f.ledger.readBalance({ accountId: f.buyer, assetId: 'base' }))).toMatchObject({
    posted: '1',
    held: '0',
  });
  expect(value(await f.ledger.readBalance({ accountId: f.buyer, assetId: 'quote' }))).toMatchObject({
    posted: '90',
    held: '0',
  });

  const trade = await purchase.market.readTrade('trade');
  expect(trade && marketTradeStatus(trade)).toBe('completed');
  expect(await purchase.item.readItem(purchase.itemId)).toMatchObject({
    holderId: purchase.buyer,
    generation: 2n,
  });
  for (const [accountId, posted] of [
    [purchase.buyer, '50'],
    [purchase.seller, '38'],
    [purchase.fee, '12'],
  ] as const) {
    expect(value(await purchase.ledger.readBalance({ accountId, assetId: purchase.assetId }))).toMatchObject({
      posted,
      held: '0',
    });
  }
});

test('promotional expiry advances account and programme pages past a blocked position and posts each credit once', async () => {
  const bookId = `economy:${randomUUID()}`;
  const otherBook = `economy:${randomUUID()}`;
  const retiredAt = await expiryIn(-1000);
  for (let index = 0; index < 96; index++) {
    const assetId = `archived-${index}`;
    const archived = await awardPromotion(bookId, assetId, retiredAt, []);
    if (!value(await archived.retireExpiredAssetProgram(assetId))) throw new Error('Historical programme stayed ready');
  }
  const accounts = Array.from({ length: 33 }, () => randomUUID()).sort();
  const first = { assetId: 'credits-a', accountId: accounts[0]! };
  const second = { assetId: 'credits-b', accountId: first.accountId };
  const future = { assetId: 'credits-future', accountId: first.accountId };
  const expiresAt = await expiryIn(3500);
  const ledger = await awardPromotion(bookId, first.assetId, expiresAt, accounts);
  await awardPromotion(bookId, second.assetId, expiresAt, [second.accountId]);
  await awardPromotion(bookId, 'credits-empty', expiresAt, []);
  await awardPromotion(bookId, future.assetId, await expiryIn(120_000), [future.accountId]);
  const otherLedger = await awardPromotion(otherBook, first.assetId, expiresAt, [first.accountId]);

  expect(await ledger.nextExpiredAssetProgram()).toEqual({ kind: 'ok', value: null });
  expect(await ledger.expireProgramCredits(first)).toEqual({ kind: 'invalid_operation' });
  await waitForExpiry(expiresAt);
  expect(value(await ledger.readBalance(first))).toMatchObject({ posted: '7', restricted: '7', available: '0' });

  const client = await createWorkClient(databaseUrl);
  try {
    const truth = await runWorker(
      `
        const { Pool } = await import('pg');
        const pool = new Pool({ connectionString: env.DATABASE_URL });
        async function traverse() {
          let job = await client.triggerSchedule(expiry.name);
          const pages = [];
          for (let pass = 0; pass < 4; pass++) {
            const page = await job.getResult();
            pages.push(page);
            if (!page.next) return pages;
            job = client.retrieveWorkflow(page.next);
          }
          throw new Error('Unexpected expiry continuation');
        }
        const hold = await pool.connect();
        let blocked;
        let pending;
        try {
          await hold.query('BEGIN');
          await hold.query(
            'SELECT 1 FROM economy.position WHERE book_id = $1 AND asset_id = $2 AND account_id = $3 FOR UPDATE',
            [env.KERNEL_ECONOMY_BOOK_ID, env.BLOCKED_ASSET, env.BLOCKED_ACCOUNT],
          );
          blocked = await traverse();
          const waiting = await hold.query(
            'SELECT asset_id FROM economy.asset_program_expiry WHERE book_id = $1 AND retired_at IS NULL ORDER BY asset_id',
            [env.KERNEL_ECONOMY_BOOK_ID],
          );
          pending = waiting.rows.map(row => row.asset_id);
        } finally {
          await hold.query('ROLLBACK');
          hold.release();
          await pool.end();
        }
        return { schedule: installed[2], blocked, pending, repaired: await traverse(), replay: await run(expiry) };
      `,
      {
        KERNEL_ECONOMY_BOOK_ID: bookId,
        KERNEL_ECONOMY_NODE: 'worker-test',
        BLOCKED_ASSET: first.assetId,
        BLOCKED_ACCOUNT: first.accountId,
      },
      32_000,
    );
    expect(truth).toMatchObject({
      schedule: { status: 'ACTIVE', context: { bookId, node: 'worker-test' } },
      blocked: [
        { kind: 'advanced', expired: 31, deferred: 1, next: expect.any(String) },
        { kind: 'advanced', expired: 1, deferred: 0, next: expect.any(String) },
        { kind: 'advanced', expired: 1, deferred: 0, next: expect.any(String) },
        { kind: 'advanced', expired: 0, deferred: 0, next: null },
      ],
      pending: [first.assetId, future.assetId],
      repaired: [{ kind: 'advanced', expired: 1, deferred: 0, next: null }],
      replay: { kind: 'idle' },
    });
  } finally {
    await client.deleteSchedule(ECONOMY_SPOT_OWNER_WORK.name);
    await client.deleteSchedule(ECONOMY_CREDIT_EXPIRY_WORK.name);
    await client.close();
  }

  const { rows } = await pool.query<{ assetId: string; count: number }>(
    `SELECT asset_id AS "assetId", count(*)::int AS count FROM economy.journal WHERE book_id = $1 AND kind = 'credit_expiry'
     GROUP BY asset_id ORDER BY asset_id`,
    [bookId],
  );
  expect(rows).toEqual([
    { assetId: first.assetId, count: 33 },
    { assetId: second.assetId, count: 1 },
  ]);
  expect(value(await ledger.readStatement({ ...first, limit: 2 })).entries[0]).toMatchObject({
    kind: 'credit_expiry',
    postedDelta: '-7',
  });
  const receipt = await pool.query<{ outcome: string }>(
    `SELECT outcome FROM economy.command_receipt
     WHERE book_id = $1 AND origin_id = $2 AND namespace = 'owner' AND operation_id = $3`,
    [bookId, first.accountId, `program-expiry/${first.assetId}`],
  );
  expect(receipt.rows).toEqual([{ outcome: 'ok' }]);
  const retired = await pool.query<{ count: number }>(
    'SELECT count(*)::int AS count FROM economy.asset_program_expiry WHERE book_id = $1 AND retired_at IS NOT NULL',
    [bookId],
  );
  expect(retired.rows).toEqual([{ count: 99 }]);
  expect(value(await ledger.readBalance(first))).toMatchObject({ posted: '0', restricted: '0', available: '0' });
  expect(value(await ledger.readBalance(future))).toMatchObject({ posted: '7', available: '7' });
  expect(value(await otherLedger.readBalance(first))).toMatchObject({ posted: '7', restricted: '7', available: '0' });
}, 40_000);

test('an expired programme cannot retire ahead of issuance admitted immediately before expiry', async () => {
  const bookId = `economy:${randomUUID()}`;
  const expiresAt = await expiryIn(1500);
  const wallet = { assetId: 'inflight-credit', accountId: randomUUID() };
  const ledger = await awardPromotion(bookId, wallet.assetId, expiresAt, []);
  const award = { ...wallet, issuanceSource: 'promotion' };
  value(await ledger.enrollAssetProgramRecipient(award));

  const connection = await pool.connect();
  const pending = createEconomyLedger(
    { read: (work) => work(connection), transaction: (work) => work(connection) },
    bookId,
  );
  try {
    await connection.query('BEGIN');
    value(await pending.issueProgramUnits({ ...award, sourceReference: 'opening-credit', amount: '7' }));
    await waitForExpiry(expiresAt);
    expect(await ledger.retireExpiredAssetProgram(wallet.assetId)).toEqual({ kind: 'unavailable' });
    await connection.query('COMMIT');
  } catch (error) {
    await connection.query('ROLLBACK');
    throw error;
  } finally {
    connection.release();
  }
  expect(await ledger.retireExpiredAssetProgram(wallet.assetId)).toEqual({ kind: 'ok', value: false });
  expect(value(await ledger.nextExpiredAssetProgram())).toMatchObject({ assetId: wallet.assetId });
  value(await ledger.expireProgramCredits(wallet));
  expect(await ledger.retireExpiredAssetProgram(wallet.assetId)).toEqual({ kind: 'ok', value: true });
  expect(await ledger.nextExpiredAssetProgram()).toEqual({ kind: 'ok', value: null });
});
