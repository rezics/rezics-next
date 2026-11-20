import { randomUUID } from 'node:crypto';
import { afterAll, expect, test } from 'bun:test';
import { Pool, type PoolClient } from 'pg';
import type { EconomyResult } from '../../src/economy/contract.ts';
import type { SpotInstrument, SpotOrderRequest } from '../../src/economy/exchange/order-book.ts';
import { createEconomyLedger, type EconomyDatabase } from '../../src/economy/ledger.ts';
import { createSpotStore } from '../../src/economy/storage/spot-store.ts';

if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL must name the migrated test database');
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
afterAll(() => pool.end());

function value<T>(result: { kind: 'ok'; value: T } | { kind: string }): T {
  if (result.kind !== 'ok' || !('value' in result)) throw new Error(`Expected a result, received ${result.kind}`);
  return result.value;
}

async function connected<T>(work: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    return await work(client);
  } finally {
    client.release();
  }
}

async function fixture() {
  let statementToInterrupt: string | null = null;
  const database: EconomyDatabase = {
    transaction<T>(work: (tx: Pick<PoolClient, 'query'>) => Promise<EconomyResult<T>>) {
      return connected(async (client) => {
        await client.query('BEGIN');
        try {
          const query = ((statement: string, parameters?: unknown[]) => {
            if (statementToInterrupt && statement.includes(statementToInterrupt))
              throw new Error('abandoned transaction');
            return client.query(statement, parameters);
          }) as PoolClient['query'];
          const result = await work({ query });
          await client.query('COMMIT');
          return result;
        } catch (error) {
          await client.query('ROLLBACK');
          throw error;
        }
      });
    },
    read: connected,
  };
  const bookId = `spot-${randomUUID()}`;
  const ledger = createEconomyLedger(database, bookId);
  const store = createSpotStore(database, bookId);
  const feeAccountId = randomUUID();
  const buyer = randomUUID();
  const makerA = randomUUID();
  const makerB = randomUUID();
  const makerC = randomUUID();
  const terms = {
    id: 'pair',
    ledgerBookId: bookId,
    policyVersion: 1n,
    baseAssetId: 'base',
    quoteAssetId: 'quote',
    baseUnitsPerLot: 2n,
    quoteUnitsPerPriceTick: 1n,
    makerFeeBps: 100n,
    takerFeeBps: 200n,
    feeAccountId,
  } satisfies SpotInstrument & { feeAccountId: string };
  for (const id of ['base', 'quote']) value(await ledger.provisionAsset({ id, scale: 0, transferable: true }));
  for (const accountId of [makerA, makerB, makerC])
    value(await ledger.issue({ accountId, assetId: 'base', amount: '1000', operationId: 'issue-base' }));
  value(await ledger.issue({ accountId: buyer, assetId: 'quote', amount: '30000', operationId: 'issue-quote' }));
  value(await store.provision(terms));
  function request(orderId: string, accountId: string, side: SpotOrderRequest['side'], price: bigint, lots: bigint) {
    return { orderId, accountId, side, price, lots } satisfies SpotOrderRequest;
  }
  async function match() {
    const book = value(await store.readBook(terms.id));
    return value(await store.match(terms.id, book.revision));
  }
  async function rest(order: SpotOrderRequest) {
    value(await store.place(terms.id, order));
    expect((await match()).status).toBe('resting');
  }
  async function balance(accountId: string, assetId: string, posted: string, held: string) {
    expect(value(await ledger.readBalance({ accountId, assetId }))).toMatchObject({ posted, held });
  }
  return {
    bookId,
    ledger,
    store,
    terms,
    feeAccountId,
    buyer,
    makerA,
    makerB,
    makerC,
    request,
    match,
    rest,
    balance,
    interrupt(statement: string | null) {
      statementToInterrupt = statement;
    },
  };
}

test('native matching observes price and time priority and retries with durable, single-use allocations', async () => {
  const f = await fixture();
  const { store, terms, buyer, makerA, makerB, makerC, request, rest, balance, bookId } = f;
  await rest(request('worse', makerA, 'sell', 100n, 2n));
  await rest(request('first', makerB, 'sell', 90n, 1n));
  await rest(request('second', makerC, 'sell', 90n, 1n));
  const bid = request('bid', buyer, 'buy', 120n, 3n);
  const [accepted, replayed] = await Promise.all([store.place(terms.id, bid), store.place(terms.id, bid)]);
  expect(value(accepted)).toEqual(value(replayed));
  expect(await store.place(terms.id, { ...bid, price: 121n })).toEqual({ kind: 'operation_conflict' });
  expect(await store.provision({ ...terms, feeAccountId: randomUUID() })).toEqual({ kind: 'operation_conflict' });
  await expect(
    pool.query('UPDATE economy.spot_instrument SET taker_fee_bps = 0 WHERE book_id = $1', [bookId]),
  ).rejects.toMatchObject({ code: '23514' });
  expect(await store.readOwnOrder(terms.id, bid.orderId, makerA)).toEqual({ kind: 'not_found' });
  const { revision } = value(await store.readBook(terms.id));
  const [matched, duplicate] = await Promise.all([store.match(terms.id, revision), store.match(terms.id, revision)]);
  const receipt = value(matched);
  expect(value(duplicate)).toEqual(receipt);
  expect(receipt.status).toBe('filled');
  const observed = await pool.query<{ maker_order_id: string }>(
    `SELECT maker_order_id FROM unnest($2::text[]) WITH ORDINALITY AS ids(fill_id, ordinal)
     JOIN economy.spot_fill USING (fill_id) WHERE book_id = $1 ORDER BY ids.ordinal`,
    [bookId, receipt.fillIds],
  );
  expect(observed.rows.map((row) => row.maker_order_id)).toEqual(['first', 'second', 'worse']);
  await balance(buyer, 'quote', '30000', '286');
  const cancelled = value(await store.cancel(terms.id, 'worse', makerA));
  expect(value(await store.cancel(terms.id, 'worse', makerA))).toEqual(cancelled);
  await balance(makerA, 'base', '1000', '2');
  expect(value(await store.match(terms.id, revision))).toEqual(receipt);
  expect(
    await pool.query('SELECT 1 FROM economy.hold_allocation WHERE book_id = $1', [bookId]).then((r) => r.rowCount),
  ).toBe(6);

  let index = 0;
  for (const fillId of receipt.fillIds) {
    const [first, second] = await Promise.all([store.claimFill(fillId), store.claimFill(fillId)]);
    const claim = first.kind === 'ok' ? first.value : value(second);
    expect(first.kind === 'ok' ? second.kind : first.kind).toBe('idle');
    if (index++ === 0) {
      await pool.query(
        `UPDATE economy.spot_fill SET due_at = statement_timestamp() - interval '1 second'
        WHERE book_id = $1 AND fill_id = $2`,
        [bookId, fillId],
      );
      expect(await store.settleFill(fillId, claim.token)).toEqual({ kind: 'stale_claim' });
      const takeover = value(await store.claimFill(fillId));
      expect(await store.settleFill(fillId, claim.token)).toEqual({ kind: 'stale_claim' });
      expect(value(await store.settleFill(fillId, takeover.token))).toEqual({ operationId: fillId });
      expect(value(await store.settleFill(fillId, takeover.token))).toEqual({ operationId: fillId });
    } else {
      expect(value(await store.settleFill(fillId, claim.token))).toEqual({ operationId: fillId });
    }
  }
  expect(value(await store.readyFills())).toEqual([]);
  await balance(buyer, 'quote', '29714', '0');
  await balance(buyer, 'base', '6', '0');
  await balance(makerA, 'quote', '99', '0');
  await balance(makerB, 'quote', '89', '0');
  await balance(makerC, 'quote', '89', '0');
  await balance(terms.feeAccountId, 'quote', '9', '0');
  expect(
    await pool.query('SELECT 1 FROM economy.spot_settlement WHERE book_id = $1', [bookId]).then((r) => r.rowCount),
  ).toBe(3);
});

test('interruption rolls back reserve, matching allocations and paired settlement before their corresponding state changes', async () => {
  const f = await fixture();
  const { store, terms, buyer, makerA, request, rest, balance, bookId } = f;
  const ask = request('ask', makerA, 'sell', 90n, 1n);
  f.interrupt('INSERT INTO economy.spot_order');
  await expect(store.place(terms.id, ask)).rejects.toThrow('abandoned transaction');
  expect(value(await store.readBook(terms.id)).revision).toBe(0n);
  await balance(makerA, 'base', '1000', '0');
  f.interrupt(null);
  await rest(ask);
  value(await store.place(terms.id, request('bid', buyer, 'buy', 120n, 1n)));
  const { revision } = value(await store.readBook(terms.id));
  f.interrupt('INSERT INTO economy.spot_fill');
  await expect(store.match(terms.id, revision)).rejects.toThrow('abandoned transaction');
  expect(value(await store.readBook(terms.id)).revision).toBe(revision);
  expect(value(await store.readOwnOrder(terms.id, 'ask', makerA)).status).toBe('resting');
  expect(
    await pool.query('SELECT 1 FROM economy.hold_allocation WHERE book_id = $1', [bookId]).then((r) => r.rowCount),
  ).toBe(0);
  await balance(buyer, 'quote', '30000', '123');
  f.interrupt(null);
  const fillId = value(await store.match(terms.id, revision)).fillIds[0]!;
  const { token } = value(await store.claimFill(fillId));
  f.interrupt('UPDATE economy.spot_fill SET settled_at');
  await expect(store.settleFill(fillId, token)).rejects.toThrow('abandoned transaction');
  expect(
    await pool.query('SELECT 1 FROM economy.spot_settlement WHERE book_id = $1', [bookId]).then((r) => r.rowCount),
  ).toBe(0);
  await balance(buyer, 'quote', '30000', '92');
  await balance(buyer, 'base', '0', '0');
  f.interrupt(null);
  expect(value(await store.settleFill(fillId, token))).toEqual({ operationId: fillId });
  await balance(buyer, 'quote', '29908', '0');
  await balance(buyer, 'base', '2', '0');
});

test('a native FIFO prefix persists the continuation and fill discovery stays bounded', async () => {
  const { store, terms, buyer, makerA, request, match, rest } = await fixture();
  for (let index = 0; index < 34; index++) await rest(request(`ask-${index}`, makerA, 'sell', 90n, 1n));
  value(await store.place(terms.id, request('bid', buyer, 'buy', 90n, 34n)));
  const first = await match();
  expect(first).toMatchObject({ status: 'matching', orderId: 'bid' });
  expect(first.fillIds.length).toBe(32);
  expect(value(await store.readyMatches())).toEqual([{ instrumentId: terms.id, revision: first.revision }]);
  expect(await store.place(terms.id, request('new', makerA, 'sell', 80n, 1n))).toEqual({ kind: 'book_busy' });
  const next = await match();
  expect(next.status).toBe('filled');
  expect(next.fillIds.length).toBe(2);
  expect(value(await store.readyMatches())).toEqual([]);
  expect(value(await store.readyFills()).length).toBe(32);
});
