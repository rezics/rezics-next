import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Pool } from 'pg';
import { bookFixtureDatabase } from '../test/economy/fixtures/book-reconciliation-native.ts';
import { createEconomyLedger } from '../src/economy/ledger.ts';
import { marketTradeStatus } from '../src/economy/market/trade.ts';
import { reconcileBook } from '../src/economy/storage/book-reconciliation.ts';
import { createFundingLedgerBinder } from '../src/economy/storage/funding-ledger.ts';
import { createFundingStore } from '../src/economy/storage/funding-store.ts';
import {
  createDeterministicFundingRail,
  runDeterministicFundingDispatch,
} from '../src/economy/storage/funding-test-rail.ts';
import {
  createMarketRepairQueue,
  enqueueMarketRepair,
  runMarketRepairWindow,
} from '../src/economy/storage/market-repair.ts';
import { createNativeMarket } from '../src/economy/storage/market-runner.ts';
import { POSTGRES_IMAGE } from './database.ts';

const dbName = 'economy_restore';
const password = crypto.randomUUID();
const tag = crypto.randomUUID();

function docker(args: readonly string[], input?: Uint8Array): Uint8Array {
  const result = Bun.spawnSync(['docker', ...args], {
    stdout: 'pipe',
    stderr: 'pipe',
    ...(input === undefined ? {} : { stdin: input }),
  });
  if (!result.success)
    throw new Error(`Economy restore Docker ${args[0]} failed: ${new TextDecoder().decode(result.stderr)}`);
  return result.stdout;
}

async function start(label: string, cleanups: (() => Promise<void>)[]) {
  const container = `economy-book-restore-${label}-${tag}`;
  docker([
    'run',
    '--rm',
    '-d',
    '--name',
    container,
    '-p',
    '127.0.0.1::5432',
    '-e',
    `POSTGRES_DB=${dbName}`,
    '-e',
    `POSTGRES_PASSWORD=${password}`,
    POSTGRES_IMAGE,
  ]);
  let removed = false;
  async function remove() {
    if (removed) return;
    docker(['rm', '-f', container]);
    removed = true;
  }
  cleanups.unshift(remove);
  const deadline = Date.now() + 30_000;
  for (;;) {
    const result = Bun.spawnSync([
      'docker',
      'exec',
      container,
      'pg_isready',
      '-q',
      '-h',
      '127.0.0.1',
      '-U',
      'postgres',
      '-d',
      dbName,
    ]);
    if (result.success) break;
    if (Date.now() >= deadline) throw new Error('Economy restore PostgreSQL did not become ready');
    await Bun.sleep(100);
  }
  const address = new TextDecoder().decode(docker(['port', container, '5432/tcp'])).trim();
  assert.match(address, /^127\.0\.0\.1:\d+$/);
  const pool = new Pool({ connectionString: `postgres://postgres:${password}@${address}/${dbName}?sslmode=disable` });
  let closed = false;
  async function close() {
    if (closed) return;
    await pool.end();
    closed = true;
  }
  cleanups.unshift(close);
  return { container, pool, close, remove };
}

function migrateEconomy(container: string): void {
  const directory = resolve(import.meta.dir, '../db/economy/migrations');
  for (const name of readdirSync(directory)
    .filter((name) => name.endsWith('.sql'))
    .sort()) {
    const migration = readFileSync(resolve(directory, name), 'utf8').split(/^-- migrate:down/m)[0]!;
    docker(
      ['exec', '-i', container, 'psql', '-q', '-1', '-f', '-', '-v', 'ON_ERROR_STOP=1', '-U', 'postgres', '-d', dbName],
      new TextEncoder().encode(migration),
    );
  }
}

function ok<T>(result: { kind: 'ok'; value: T } | { kind: string }): T {
  if (result.kind !== 'ok' || !('value' in result))
    throw new Error(`Expected an Economy result, received ${result.kind}`);
  return result.value;
}

async function audit(pool: Pool, bookId: string) {
  const result = await reconcileBook(bookFixtureDatabase(pool), { bookId, deadline: Date.now() + 8000 });
  if (result.kind !== 'consistent') throw new Error(`Economy book audit failed: ${JSON.stringify(result)}`);
  return result.assets;
}

async function waitForDispatch(store: ReturnType<typeof createFundingStore>, intentId: string) {
  const deadline = Date.now() + 3000;
  while (!ok(await store.due()).includes(intentId)) {
    if (Date.now() >= deadline) throw new Error('Restored Economy funding action did not become due');
    await Bun.sleep(100);
  }
}

async function run(): Promise<void> {
  const cleanup: (() => Promise<void>)[] = [];
  let originalFailure: unknown;
  try {
    const source = await start('source', cleanup);
    migrateEconomy(source.container);
    const bookId = `restore:${tag}`;
    const itemHomeId = `custody:${tag}`;
    const assetId = 'demo-usd';
    const walletId = crypto.randomUUID();
    const buyer = crypto.randomUUID();
    const seller = crypto.randomUUID();
    const fee = crypto.randomUUID();
    const provider = { namespace: `test:${tag}`, mode: 'test', destinationRef: 'destination' } as const;
    const database = bookFixtureDatabase(source.pool);
    const ledger = createEconomyLedger(database, bookId);
    const funding = createFundingStore(database, bookId, createFundingLedgerBinder(bookId));
    const market = createNativeMarket(database, { bookId, itemHomeId });
    ok(await ledger.provisionAsset({ id: assetId, transferable: true, scale: 2 }));
    for (const accountId of [walletId, buyer])
      ok(await ledger.issue({ accountId, assetId, amount: '100', operationId: 'opening' }));

    const original = {
      bookId,
      intentId: 'withdrawal',
      walletId,
      assetId,
      units: '60',
      direction: 'withdrawal',
      provider,
    } as const;
    const wallet = { accountId: walletId, assetId };
    const issue = await funding.begin(original);
    assert.equal(ok(issue).kind, 'created');
    const prepared = ok(await funding.prepare(original.intentId));
    assert.equal(prepared.kind, 'queued');
    const { attemptId } = prepared;
    let submissionCount = 0;
    const rail = createDeterministicFundingRail(provider.namespace, () => {
      submissionCount++;
      return 'accepted_unknown';
    });
    const send = await runDeterministicFundingDispatch(funding, rail, original.intentId, crypto.randomUUID());
    assert.deepEqual(send, { kind: 'ok', value: { kind: 'acknowledged' } });
    assert.equal(ok(await funding.read(original.intentId))?.phase, 'unknown');
    const hold = { ...wallet, holdId: attemptId, purpose: 'withdrawal', reference: attemptId } as const;
    assert.equal(ok(await ledger.readAllocation(hold)).status, 'protected');

    const item = {
      itemId: 'item',
      homeId: itemHomeId,
      holderId: seller,
      generation: 1n,
      reservationId: 'reserve-item',
    };
    const protectedUntil = BigInt(Date.now() + 120_000);
    ok(await market.item.register({ itemId: item.itemId, holderId: seller, marketable: true }));
    ok(await market.item.reserveListing({ ...item, bookId, listingId: 'listing', protectedUntil }));
    ok(
      await market.market.open({
        item,
        listingId: 'listing',
        expiresAt: protectedUntil,
        price: { ledgerBookId: bookId, assetId, units: 50n, feeAccountId: fee, policyVersion: 1n, feeBps: 2500n },
      }),
    );
    ok(
      await market.market.purchase('listing', 0n, {
        tradeId: 'trade',
        buyerId: buyer,
        prepareUntil: protectedUntil - 100n,
      }),
    );
    assert.deepEqual((await market.sweep(10)).acknowledged, [
      'market:prepare_item:trade',
      'market:prepare_funds:trade',
    ]);
    assert.equal(ok(await market.market.decide('trade', 2n, 'commit')).kind, 'commit');
    assert.deepEqual((await market.sweep(10)).acknowledged, ['market:escrow_funds:trade']);
    const escrow = async (pool: Pool) => {
      const result = await pool.query<{ escrowId: string; phase: string }>(
        `SELECT escrow_id AS "escrowId", phase FROM economy.market_funds_trade WHERE book_id = $1 AND trade_id = 'trade'`,
        [bookId],
      );
      return result.rows[0]!;
    };
    const beforeEscrow = await escrow(source.pool);
    assert.equal(beforeEscrow.phase, 'escrowed');
    assert.equal((await market.item.readItem(item.itemId))?.holderId, seller);
    const repairBinding = { bookId, itemHomeId, node: 'restore-node' };
    const repair = { ...repairBinding, transactionId: crypto.randomUUID(), tradeId: 'trade' };
    const sourceQueue = createMarketRepairQueue(database, repairBinding);
    assert.deepEqual(await database.transaction((client) => enqueueMarketRepair(client, repair)), {
      kind: 'queued',
    });
    const originalRepairClaim = await sourceQueue.claim();
    assert.ok(originalRepairClaim);
    assert.equal(originalRepairClaim.transactionId, repair.transactionId);
    assert.equal(originalRepairClaim.tradeId, repair.tradeId);
    const before = await audit(source.pool, bookId);

    // Retire every source writer before export. The fixture's test provider remains the external witness.
    await source.close();
    const backup = docker([
      'exec',
      source.container,
      'pg_dump',
      '-Fc',
      '--no-owner',
      '--no-privileges',
      '--schema=economy',
      '-U',
      'postgres',
      '-d',
      dbName,
    ]);
    assert.equal(new TextDecoder().decode(backup.subarray(0, 5)), 'PGDMP');
    await source.remove();
    const restored = await start('restored', cleanup);
    const blank = await restored.pool.query<{ schema: string | null }>(`SELECT to_regnamespace('economy') AS schema`);
    assert.equal(blank.rows[0]?.schema, null);
    docker(
      [
        'exec',
        '-i',
        restored.container,
        'pg_restore',
        '--exit-on-error',
        '--single-transaction',
        '--no-owner',
        '--no-privileges',
        '-U',
        'postgres',
        '-d',
        dbName,
      ],
      backup,
    );
    assert.deepEqual(await audit(restored.pool, bookId), before);
    assert.deepEqual(await escrow(restored.pool), beforeEscrow);

    const restoredDatabase = bookFixtureDatabase(restored.pool);
    const restoredLedger = createEconomyLedger(restoredDatabase, bookId);
    const restoredFunding = createFundingStore(restoredDatabase, bookId, createFundingLedgerBinder(bookId));
    const restoredMarket = createNativeMarket(restoredDatabase, { bookId, itemHomeId });
    const restoredQueue = createMarketRepairQueue(restoredDatabase, repairBinding);
    assert.equal(ok(await restoredLedger.readAllocation(hold)).status, 'protected');
    assert.deepEqual(ok(await restoredFunding.prepare(original.intentId)), {
      kind: 'queued',
      action: 'reconcile',
      attemptId,
    });
    await waitForDispatch(restoredFunding, original.intentId);
    const claimId = crypto.randomUUID();
    assert.deepEqual(await runDeterministicFundingDispatch(restoredFunding, rail, original.intentId, claimId), {
      kind: 'ok',
      value: { kind: 'acknowledged' },
    });
    assert.equal(submissionCount, 1);
    const evidence = rail.reconcile({ attemptId, intent: original });
    assert.equal(evidence.kind, 'observed');
    assert.deepEqual(ok(await restoredFunding.observe(original.intentId, evidence.observation)), { kind: 'replayed' });
    assert.deepEqual(ok(await restoredFunding.acknowledge(original.intentId, claimId, evidence)), {
      kind: 'acknowledged',
    });
    assert.equal(ok(await restoredLedger.readAllocation(hold)).status, 'captured');
    const balance = ok(await restoredLedger.readBalance(wallet));
    assert.deepEqual([balance.posted, balance.held, balance.available], ['40', '0', '40']);
    const statement = ok(await restoredLedger.readStatement({ ...wallet, limit: 10 }));
    assert.equal(statement.entries.filter((item) => item.kind === 'withdrawal').length, 1);

    const retainedRepair = await restored.pool.query(
      `SELECT claim_id AS "claimId", attempts, finished_at AS "finishedAt"
       FROM economy.market_repair_request WHERE transaction_id = $1 AND book_id = $2 AND trade_id = $3`,
      [repair.transactionId, bookId, repair.tradeId],
    );
    assert.deepEqual(retainedRepair.rows, [{ claimId: originalRepairClaim.claimId, attempts: 1, finishedAt: null }]);
    assert.deepEqual(await restoredDatabase.transaction((client) => enqueueMarketRepair(client, repair)), {
      kind: 'replayed',
    });
    // Reproduce the source worker's lost lease without sleeping through another lease period.
    await restored.pool.query(
      `UPDATE economy.market_repair_request SET available_at = statement_timestamp() - interval '1 second'
       WHERE transaction_id = $1`,
      [repair.transactionId],
    );
    assert.equal(await restoredQueue.settle(originalRepairClaim, { finish: 'completed' }), false);
    let repairPasses = 0;
    const resume = async (tradeId: string) => {
      repairPasses++;
      assert.equal(tradeId, repair.tradeId);
      const result = await restoredMarket.resumeTrade(tradeId);
      assert.deepEqual(ok(result), { decisions: [], acknowledged: ['market:deliver_item:trade'], retry: [] });
      return result;
    };
    await runMarketRepairWindow(restoredQueue, resume);
    await runMarketRepairWindow(restoredQueue, resume);
    assert.equal(repairPasses, 1);
    const completedRepair = await restored.pool.query(
      `SELECT attempts, outcome, finished_at IS NOT NULL AS finished
       FROM economy.market_repair_request WHERE transaction_id = $1`,
      [repair.transactionId],
    );
    assert.deepEqual(completedRepair.rows, [{ attempts: 2, outcome: 'completed', finished: true }]);

    const delivery = await restoredMarket.sweep(10);
    assert.deepEqual(delivery.acknowledged, ['market:release_proceeds:trade']);
    assert.deepEqual(delivery.retry, []);
    assert.deepEqual(await restoredMarket.sweep(10), { decisions: [], acknowledged: [], retry: [] });
    const delivered = await restoredMarket.market.readTrade('trade');
    assert.ok(delivered);
    assert.equal(marketTradeStatus(delivered), 'completed');
    const transferred = await restoredMarket.item.readItem(item.itemId);
    assert.equal(transferred?.holderId, buyer);
    assert.equal(transferred?.generation, 2n);
    assert.equal((await escrow(restored.pool)).phase, 'settled');
    for (const [accountId, posted] of [
      [buyer, '50'],
      [seller, '38'],
      [fee, '12'],
      [beforeEscrow.escrowId, '0'],
    ] as const)
      assert.equal(ok(await restoredLedger.readBalance({ accountId, assetId })).posted, posted);
    await audit(restored.pool, bookId);
    process.stdout.write(
      `Economy restore proved one withdrawal, one named repair and one escrow delivery from ${backup.byteLength} native dump bytes.\n`,
    );
  } catch (error) {
    originalFailure = error;
    throw error;
  } finally {
    const failed: unknown[] = [];
    for (const dispose of cleanup) {
      try {
        await dispose();
      } catch (error) {
        failed.push(error);
      }
    }
    if (failed.length > 0)
      throw new AggregateError(failed, 'Economy restore fixture cleanup failed', { cause: originalFailure });
  }
}

if (import.meta.main) await run();
