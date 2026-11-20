import { afterAll, expect, test } from 'bun:test';
import { Pool } from 'pg';
import {
  createMarketStore,
  type MarketOwnerProofs,
  type MarketStoreDatabase,
  type MarketWork,
  type MarketWorkOwner,
} from '../../src/economy/storage/market-store.ts';
import { marketTradeStatus } from '../../src/economy/market/trade.ts';

if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL must name the migrated test database');
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
afterAll(() => pool.end());

function value<Value>(result: { kind: 'ok'; value: Value } | { kind: string }): Value {
  if (result.kind !== 'ok' || !('value' in result)) throw new Error(`Expected ok, received ${result.kind}`);
  return result.value;
}

function fixture() {
  const bookId = `market:${crypto.randomUUID()}`;
  const ownerReceipts = new Map<string, Awaited<ReturnType<MarketOwnerProofs['findReceipt']>>>();
  let commitFailure: 'before' | 'after' | undefined;
  const database: MarketStoreDatabase = {
    read: (work) => work(pool),
    async transaction(work) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const result = await work(client);
        const failure = commitFailure;
        commitFailure = undefined;
        if (failure === 'before') throw new Error('Simulated crash before commit');
        await client.query('COMMIT');
        if (failure === 'after') throw new Error('Simulated lost commit response');
        return result;
      } catch (cause) {
        await client.query('ROLLBACK');
        throw cause;
      } finally {
        client.release();
      }
    },
  };
  const owners: MarketOwnerProofs = {
    async findListingProof(input) {
      return {
        ...input.item,
        listingId: input.listingId,
        marketable: true,
        holderEligible: true,
        protectedUntil: input.expiresAt,
      };
    },
    async findReceipt(work, receiptId) {
      return ownerReceipts.get(`${work.owner.kind}:${work.owner.id}:${work.id}:${receiptId}`) ?? null;
    },
  };
  const store = createMarketStore(database, bookId, owners);
  const expiresAt = BigInt(Date.now() + 60_000);
  const input = {
    item: {
      itemId: 'item',
      homeId: 'catalogue',
      holderId: 'seller',
      generation: 9007199254740994n,
      reservationId: 'item-hold',
    },
    listingId: 'listing',
    price: {
      ledgerBookId: bookId,
      assetId: 'credit',
      units: 9007199254740993n,
      feeAccountId: 'fees',
      policyVersion: 5n,
      feeBps: 250n,
    },
    expiresAt,
  };
  const purchase = { tradeId: 'trade', buyerId: 'buyer', prepareUntil: expiresAt - 1500n };
  const itemOwner = { kind: 'item', id: input.item.homeId } satisfies MarketWorkOwner;
  const moneyOwner = { kind: 'ledger', id: bookId } satisfies MarketWorkOwner;

  function recordProof(work: MarketWork) {
    const proof = {
      receiptId: 'proof',
      ...(work.kind === 'trade' && work.instruction.kind === 'deliver_item'
        ? { observedGeneration: input.item.generation + 1n }
        : {}),
    };
    ownerReceipts.set(`${work.owner.kind}:${work.owner.id}:${work.id}:${proof.receiptId}`, proof);
    return proof;
  }

  async function acknowledgeReady(owner: MarketWorkOwner, expectedInstruction: string) {
    const [work] = value<readonly MarketWork[]>(await store.listReady(owner, 1));
    expect(work?.id).toBe(expectedInstruction);
    const claimId = crypto.randomUUID();
    expect(await store.claim(owner, work!.id, claimId)).toMatchObject({ kind: 'ok' });
    const proof = recordProof(work!);
    expect(await store.acknowledge(owner, work!.id, claimId, proof.receiptId)).toEqual({ kind: 'ok', value: proof });
    return { work: work!, claimId, proof };
  }

  return {
    bookId,
    store,
    input,
    purchase,
    itemOwner,
    moneyOwner,
    acknowledgeReady,
    recordProof,
    failAtCommit: (when: typeof commitFailure) => {
      commitFailure = when;
    },
  };
}

test('purchase rollback leaves a listing open and its retry after response loss claims one exact trade', async () => {
  const { store, input, purchase, itemOwner, moneyOwner, failAtCommit } = fixture();
  expect(await store.open(input)).toEqual({ kind: 'ok', value: { listingId: 'listing' } });
  expect(await store.open(input)).toEqual({ kind: 'ok', value: { listingId: 'listing' } });
  expect(await store.open({ ...input, price: { ...input.price, units: input.price.units + 1n } })).toEqual({
    kind: 'conflict',
  });
  expect(await store.readListing(input.listingId)).toMatchObject({ item: input.item, price: input.price });

  failAtCommit('before');
  await expect(store.purchase(input.listingId, 0n, purchase)).rejects.toThrow('Simulated crash before commit');
  expect(await store.readListing(input.listingId)).toMatchObject({ status: 'open', revision: 0n });
  expect(await store.readTrade(purchase.tradeId)).toBeNull();
  expect(value(await store.listReady(itemOwner, 100))).toEqual([]);
  expect(value(await store.listReady(moneyOwner, 100))).toEqual([]);

  failAtCommit('after');
  await expect(store.purchase(input.listingId, 0n, purchase)).rejects.toThrow('Simulated lost commit response');
  expect(await store.purchase(input.listingId, 0n, purchase)).toEqual({ kind: 'ok', value: { tradeId: 'trade' } });
  expect(await store.purchase(input.listingId, 0n, { ...purchase, buyerId: 'other' })).toEqual({ kind: 'conflict' });
  expect(await store.readTrade(purchase.tradeId)).toMatchObject({ terms: { price: input.price }, buyer: purchase });
  expect(value(await store.listReady(itemOwner, 100))).toEqual([
    expect.objectContaining({ id: 'market:prepare_item:trade' }),
  ]);
  expect(value(await store.listReady(moneyOwner, 100))).toEqual([
    expect.objectContaining({ id: 'market:prepare_funds:trade' }),
  ]);
  expect(await store.listReady(moneyOwner, 101)).toEqual({ kind: 'invalid_owner_request' });
  expect(value(await store.listReady({ ...itemOwner, id: 'another-home' }, 100))).toEqual([]);
});

test('two buyers serialize and the selected trade completes through exact owner receipts', async () => {
  const { bookId, store, input, purchase, itemOwner, moneyOwner, acknowledgeReady, recordProof, failAtCommit } =
    fixture();
  value(await store.open(input));
  const [first, second] = await Promise.all([
    store.purchase(input.listingId, 0n, purchase),
    store.purchase(input.listingId, 0n, { ...purchase, tradeId: 'rival-trade', buyerId: 'rival' }),
  ]);
  const winner = value<{ tradeId: string }>(first.kind === 'ok' ? first : second).tradeId;
  expect((first.kind === 'ok' ? second : first).kind).toBe('listing_unavailable');
  expect(await store.decide(winner, 0n, 'commit')).toEqual({ kind: 'unprepared' });
  const workId = `market:prepare_item:${winner}`;
  const token = crypto.randomUUID();
  const claimed = value(await store.claim(itemOwner, workId, token));
  expect(value(await store.claim(itemOwner, workId, token))).toEqual(claimed);
  expect(value(await store.listReady(itemOwner, 2))).toEqual([]);
  expect(await store.claim(itemOwner, workId, crypto.randomUUID())).toEqual({ kind: 'not_ready' });
  expect(await store.acknowledge(itemOwner, workId, token, 'unproved')).toEqual({ kind: 'invalid_receipt' });
  expect(await store.acknowledge(moneyOwner, workId, token, 'proof')).toEqual({ kind: 'not_found' });

  // The owner already acted when the worker vanished. The retry retains the named work and proof.
  const proof = recordProof(claimed.work);
  await pool.query(
    `UPDATE economy.market_work SET available_at = statement_timestamp()
     WHERE book_id = $1 AND instruction_id = $2`,
    [bookId, workId],
  );
  const recoveredToken = crypto.randomUUID();
  const reclaimed = value(await store.claim(itemOwner, workId, recoveredToken));
  expect(reclaimed.work).toEqual(claimed.work);
  expect(await store.acknowledge(itemOwner, workId, token, proof.receiptId)).toEqual({ kind: 'stale_claim' });
  expect(await store.acknowledge(itemOwner, workId, recoveredToken, proof.receiptId)).toEqual({
    kind: 'ok',
    value: proof,
  });

  expect(value(await store.listDecisionCandidates('commit', 1))).toEqual([]);
  await acknowledgeReady(moneyOwner, `market:prepare_funds:${winner}`);
  expect(value(await store.listDecisionCandidates('commit', 1))).toEqual([{ tradeId: winner, revision: 2n }]);
  expect(await store.decide(winner, 1n, 'commit')).toEqual({ kind: 'stale_revision' });
  failAtCommit('before');
  await expect(store.decide(winner, 2n, 'commit')).rejects.toThrow('Simulated crash before commit');
  expect(value(await store.listReady(moneyOwner, 3))).toEqual([]);
  expect(await store.readTrade(winner)).toMatchObject({ revision: 2n, decision: null });
  const commitment = value(await store.decide(winner, 2n, 'commit'));
  expect(value(await store.decide(winner, 2n, 'commit'))).toEqual(commitment);
  expect(value(await store.listDecisionCandidates('commit', 1))).toEqual([]);
  expect(await store.decide(winner, 2n, 'abort')).toEqual({ kind: 'conflict' });
  await acknowledgeReady(moneyOwner, `market:escrow_funds:${winner}`);
  await acknowledgeReady(itemOwner, `market:deliver_item:${winner}`);
  const settled = await acknowledgeReady(moneyOwner, `market:release_proceeds:${winner}`);
  expect(await store.acknowledge(moneyOwner, settled.work.id, settled.claimId, settled.proof.receiptId)).toEqual({
    kind: 'ok',
    value: settled.proof,
  });
  expect(await store.acknowledge(moneyOwner, settled.work.id, settled.claimId, 'different')).toEqual({
    kind: 'conflict',
  });
  expect(marketTradeStatus((await store.readTrade(winner))!)).toBe('completed');
  expect(value(await store.listReady(moneyOwner, 100))).toEqual([]);
});

test('abort supersedes claimed prepares and emits releases only after both owner fences', async () => {
  const { store, input, purchase, itemOwner, moneyOwner, acknowledgeReady, recordProof } = fixture();
  value(await store.open(input));
  value(await store.purchase(input.listingId, 0n, purchase));
  const token = crypto.randomUUID();
  const claimed = value(await store.claim(itemOwner, 'market:prepare_item:trade', token));
  const proof = recordProof(claimed.work);
  value(await store.decide(purchase.tradeId, 0n, 'abort'));
  expect(await store.acknowledge(itemOwner, claimed.work.id, token, proof.receiptId)).toEqual({ kind: 'stale_claim' });
  await acknowledgeReady(itemOwner, 'market:fence_item_abort:trade');
  expect(value(await store.listReady(itemOwner, 100))).toEqual([]);
  await acknowledgeReady(moneyOwner, 'market:fence_funds_abort:trade');
  await acknowledgeReady(itemOwner, 'market:release_item:trade');
  expect(marketTradeStatus((await store.readTrade(purchase.tradeId))!)).toBe('aborting');
  await acknowledgeReady(moneyOwner, 'market:release_funds:trade');
  expect(marketTradeStatus((await store.readTrade(purchase.tradeId))!)).toBe('aborted');
});

test('cancellation stores one owner release and a later purchase cannot create a trade', async () => {
  const { store, input, purchase, itemOwner, acknowledgeReady } = fixture();
  value(await store.open(input));
  const canceled = await store.cancel(input.listingId, 0n, input.item.holderId, 'cancel-request');
  expect(canceled).toEqual({ kind: 'ok', value: { releaseId: 'market:cancel:listing' } });
  expect(await store.cancel(input.listingId, 0n, input.item.holderId, 'cancel-request')).toEqual(canceled);
  expect(await store.cancel(input.listingId, 0n, input.item.holderId, 'changed-request')).toEqual({ kind: 'conflict' });
  expect(await store.purchase(input.listingId, 1n, purchase)).toEqual({ kind: 'listing_unavailable' });
  expect(await store.readTrade(purchase.tradeId)).toBeNull();
  await acknowledgeReady(itemOwner, 'market:cancel:listing');
  expect(value(await store.listReady(itemOwner, 100))).toEqual([]);
});

test('expired undecided trades remain discoverable after owner work is interrupted', async () => {
  const { store, input, purchase, itemOwner } = fixture();
  value(await store.open(input));
  const prepareUntil = BigInt(Date.now() + 800);
  value(await store.purchase(input.listingId, 0n, { ...purchase, prepareUntil }));
  expect(value(await store.listDecisionCandidates('abort', 1))).toEqual([]);
  await pool.query('SELECT pg_sleep(0.85)');
  expect(value(await store.listDecisionCandidates('abort', 1))).toEqual([{ tradeId: purchase.tradeId, revision: 0n }]);
  expect(await store.decide(purchase.tradeId, 0n, 'commit')).toEqual({ kind: 'unprepared' });
  expect(value(await store.decide(purchase.tradeId, 0n, 'abort'))).toMatchObject({ kind: 'abort' });
  expect(value(await store.listDecisionCandidates('abort', 1))).toEqual([]);
  expect(value(await store.listReady(itemOwner, 2))).toEqual([
    expect.objectContaining({ id: 'market:fence_item_abort:trade' }),
  ]);
});
