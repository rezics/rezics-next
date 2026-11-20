import { afterAll, expect, test } from 'bun:test';
import { Pool } from 'pg';
import { marketTradeStatus } from '../../src/economy/market/trade.ts';
import { createItemCustody, type ItemCustodyAuthority } from '../../src/economy/storage/item-custody.ts';
import {
  createMarketStore,
  type MarketStoreDatabase,
  type MarketWork,
  type MarketWorkClaim,
} from '../../src/economy/storage/market-store.ts';

if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL must name the migrated test database');
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
afterAll(() => pool.end());

const database: MarketStoreDatabase = {
  read: (work) => work(pool),
  async transaction(work) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const result = await work(client);
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

function value<Value>(result: { kind: 'ok'; value: Value } | { kind: string }): Value {
  if (result.kind !== 'ok' || !('value' in result)) throw new Error(`Expected ok, received ${result.kind}`);
  return result.value;
}

async function passNativeTime(instant: bigint) {
  await pool.query(
    'SELECT pg_sleep(greatest(0, $1::double precision / 1000 - extract(epoch FROM clock_timestamp())) + 0.01)',
    [instant.toString()],
  );
}

function fixture(windowMs = 60_000) {
  const bookId = `trade:${crypto.randomUUID()}`;
  const homeId = `item:${crypto.randomUUID()}`;
  const admittedClaims = new Map<string, MarketWork>();
  const authority: ItemCustodyAuthority = {
    async findIssuedWork(claim) {
      const work = admittedClaims.get(claim.claimId);
      return work && claim.homeId === homeId && work.bookId === claim.bookId && work.id === claim.instructionId
        ? work
        : null;
    },
  };
  const item = createItemCustody(database, homeId, authority);
  // External money storage is outside the item home. These are exact ledger-owner receipts for the tested seam.
  const moneyReceipts = new Map<string, string>();
  const market = createMarketStore(database, bookId, {
    findListingProof: item.findListingProof,
    async findReceipt(work, id) {
      return work.owner.kind === 'item'
        ? item.findReceipt(work, id)
        : moneyReceipts.get(work.id) === id
          ? { receiptId: id }
          : null;
    },
  });
  const claim = { homeId, itemId: 'item', holderId: 'seller', generation: 1n, reservationId: 'listing-hold' };
  const registration = { itemId: claim.itemId, holderId: claim.holderId, marketable: true };
  const protectedUntil = BigInt(Date.now() + windowMs);
  const listing = {
    item: claim,
    listingId: 'listing',
    expiresAt: protectedUntil,
    price: {
      ledgerBookId: bookId,
      assetId: 'credit',
      units: 42n,
      policyVersion: 1n,
      feeAccountId: 'fee',
      feeBps: 100n,
    },
  };
  const reservation = { ...claim, bookId, listingId: listing.listingId, protectedUntil };
  const purchase = { tradeId: 'trade', buyerId: 'buyer', prepareUntil: protectedUntil - 100n };
  const itemOwner = { kind: 'item', id: homeId } as const;
  const ledgerOwner = { kind: 'ledger', id: bookId } as const;

  async function openListing() {
    value(await item.register(registration));
    value(await item.reserveListing(reservation));
    value(await market.open(listing));
  }

  async function claimWork(owner: typeof itemOwner | typeof ledgerOwner, id: string) {
    const claimId = crypto.randomUUID();
    return value(await market.claim(owner, id, claimId));
  }

  async function issueItemWork(id: string) {
    const work = await claimWork(itemOwner, id);
    admittedClaims.set(work.claimId, work.work);
    return work;
  }

  function claimLocator(work: MarketWorkClaim) {
    return { bookId, instructionId: work.work.id, claimId: work.claimId };
  }

  async function acknowledgeItem(work: MarketWorkClaim) {
    const receipt = value(await item.execute(claimLocator(work)));
    expect(await market.acknowledge(itemOwner, work.work.id, work.claimId, receipt.receiptId)).toEqual({
      kind: 'ok',
      value: receipt,
    });
    return receipt;
  }

  async function acknowledgeFunds(id: string) {
    const work = await claimWork(ledgerOwner, id);
    const receiptId = crypto.randomUUID();
    moneyReceipts.set(work.work.id, receiptId);
    expect(await market.acknowledge(ledgerOwner, id, work.claimId, receiptId)).toEqual({
      kind: 'ok',
      value: { receiptId },
    });
  }

  return {
    bookId,
    homeId,
    authority,
    item,
    market,
    registration,
    listing,
    reservation,
    purchase,
    itemOwner,
    openListing,
    issueItemWork,
    claimLocator,
    acknowledgeItem,
    acknowledgeFunds,
  };
}

test('exact registration and a single active holder reservation survive competing listings', async () => {
  const { item, registration, reservation, listing } = fixture();
  const original = await item.register(registration);
  expect(original).toMatchObject({ kind: 'ok' });
  expect(await item.register(registration)).toEqual(original);
  expect(await item.register({ ...registration, holderId: 'another' })).toEqual({ kind: 'conflict' });
  expect(await item.reserveListing({ ...reservation, generation: 2n })).toEqual({ kind: 'not_eligible' });
  const results = await Promise.all([
    item.reserveListing(reservation),
    item.reserveListing({ ...reservation, listingId: 'another', reservationId: 'another-hold' }),
  ]);
  expect(results.map((result) => result.kind).sort()).toEqual(['item_reserved', 'ok']);
  const winning = value(results.find((result) => result.kind === 'ok')!);
  expect(await item.findListingProof({ ...listing, item: winning, listingId: winning.listingId })).toEqual(winning);
  expect(
    await item.findListingProof({ ...listing, item: { ...winning, holderId: 'other' }, listingId: winning.listingId }),
  ).toBeNull();
  expect(
    await item.reserveListing({ ...reservation, listingId: winning.listingId, reservationId: winning.reservationId }),
  ).toEqual({ kind: 'ok', value: winning });
});

test('durable delivery changes the holder and generation once after escrow and preparation expiry', async () => {
  const f = fixture(1800);
  await f.openListing();
  value(await f.market.purchase(f.listing.listingId, 0n, f.purchase));
  const prepare = await f.issueItemWork('market:prepare_item:trade');
  await f.acknowledgeItem(prepare);
  await f.acknowledgeFunds('market:prepare_funds:trade');
  expect(await f.market.decide(f.purchase.tradeId, 2n, 'commit')).toMatchObject({ kind: 'ok' });
  await f.acknowledgeFunds('market:escrow_funds:trade');
  const delivery = await f.issueItemWork('market:deliver_item:trade');
  const locator = f.claimLocator(delivery);
  await passNativeTime(f.reservation.protectedUntil);
  expect(
    await f.item.reserveListing({
      ...f.reservation,
      listingId: 'another',
      reservationId: 'another-hold',
      protectedUntil: BigInt(Date.now() + 60_000),
    }),
  ).toEqual({ kind: 'item_reserved' });
  expect(await f.item.execute({ ...locator, claimId: crypto.randomUUID() })).toEqual({ kind: 'unproved_work' });
  const [first, replay] = await Promise.all([f.item.execute(locator), f.item.execute(locator)]);
  const receipt = value(first);
  expect(replay).toEqual(first);
  expect(receipt.observedGeneration).toBe(2n);
  const restarted = createItemCustody(database, f.homeId, f.authority);
  expect(await restarted.findReceipt(delivery.work, receipt.receiptId)).toEqual(receipt);
  if (delivery.work.kind !== 'trade') throw new Error('Expected trade delivery');
  const altered = { ...delivery.work, instruction: { ...delivery.work.instruction, buyerId: 'altered-buyer' } };
  expect(await restarted.findReceipt(altered, receipt.receiptId)).toBeNull();
  expect(await restarted.readItem(f.registration.itemId)).toMatchObject({
    holderId: f.purchase.buyerId,
    generation: 2n,
  });
  expect(await restarted.register(f.registration)).toMatchObject({ kind: 'ok' });
  expect(await restarted.readItem(f.registration.itemId)).toMatchObject({
    holderId: f.purchase.buyerId,
    generation: 2n,
  });
  await f.acknowledgeItem(delivery);
  await f.acknowledgeFunds('market:release_proceeds:trade');
  expect(marketTradeStatus((await f.market.readTrade(f.purchase.tradeId))!)).toBe('completed');
});

test('an abort fence beats a previously issued delayed preparation and keeps the reservation until both owners fence', async () => {
  const f = fixture();
  await f.openListing();
  value(await f.market.purchase(f.listing.listingId, 0n, f.purchase));
  const delayed = await f.issueItemWork('market:prepare_item:trade');
  value(await f.market.decide(f.purchase.tradeId, 0n, 'abort'));
  const fence = await f.issueItemWork('market:fence_item_abort:trade');
  const receipt = await f.acknowledgeItem(fence);
  expect(await f.item.execute(f.claimLocator(fence))).toEqual({ kind: 'ok', value: receipt });
  expect(await f.item.execute(f.claimLocator(delayed))).toEqual({ kind: 'out_of_order' });
  const another = { ...f.reservation, listingId: 'another', reservationId: 'another-hold' };
  expect(await f.item.reserveListing(another)).toEqual({ kind: 'item_reserved' });
  expect(await f.market.listReady(f.itemOwner, 1)).toEqual({ kind: 'ok', value: [] });
  await f.acknowledgeFunds('market:fence_funds_abort:trade');
  await f.acknowledgeItem(await f.issueItemWork('market:release_item:trade'));
  await f.acknowledgeFunds('market:release_funds:trade');
  expect(marketTradeStatus((await f.market.readTrade(f.purchase.tradeId))!)).toBe('aborted');
  expect(await f.item.reserveListing(another)).toMatchObject({ kind: 'ok' });
  expect(await f.item.execute(f.claimLocator(delayed))).toEqual({ kind: 'out_of_order' });
  expect(await f.item.readItem(f.registration.itemId)).toMatchObject({
    holderId: f.registration.holderId,
    generation: 1n,
  });
});

test('late cancellation acknowledges an expired original reservation without releasing its replacement', async () => {
  const f = fixture(800);
  await f.openListing();
  value(await f.market.cancel(f.listing.listingId, 0n, f.registration.holderId, 'cancel'));
  const cancel = await f.issueItemWork('market:cancel:listing');
  await passNativeTime(f.reservation.protectedUntil);
  const another = {
    ...f.reservation,
    listingId: 'another',
    reservationId: 'another-hold',
    protectedUntil: BigInt(Date.now() + 60_000),
  };
  const proof = value(await f.item.reserveListing(another));
  await f.acknowledgeItem(cancel);
  expect(
    await f.item.findListingProof({
      ...f.listing,
      listingId: another.listingId,
      item: proof,
      expiresAt: another.protectedUntil,
    }),
  ).toEqual(proof);
  expect(await f.item.reserveListing({ ...another, listingId: 'third', reservationId: 'third-hold' })).toEqual({
    kind: 'item_reserved',
  });
});
