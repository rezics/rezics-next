import { expect, test } from 'bun:test';
import {
  acknowledgeMarketTrade,
  cancelMarketListing,
  decideMarketTrade,
  marketTradeStatus,
  openMarketListing,
  pendingMarketTradeInstructions,
  purchaseMarketListing,
  type MarketTrade,
  type MarketTradeAck,
  type MarketTradeInstruction,
} from '../../src/economy/market/trade.ts';

const item = {
  itemId: 'copy-one',
  homeId: 'item-home',
  holderId: 'seller',
  generation: 7n,
  reservationId: 'listing-hold',
};
const price = {
  ledgerBookId: 'book',
  assetId: 'points',
  units: 9_007_199_254_740_993n,
  feeAccountId: 'treasury',
  feeBps: 250n,
  policyVersion: 2n,
};
const listingInput = { item, listingId: 'listing-one', price, expiresAt: 500n, now: 100n };
const proof = {
  ...item,
  listingId: listingInput.listingId,
  protectedUntil: 500n,
  marketable: true,
  holderEligible: true,
};
const buyer = { tradeId: 'trade-one', buyerId: 'buyer', prepareUntil: 300n };

function value<Value>(result: { kind: 'ok'; value: Value } | { kind: string }): Value {
  if (!('value' in result)) throw new Error(`Market transition failed: ${result.kind}`);
  return result.value;
}

function listing() {
  return value(openMarketListing(listingInput, proof));
}

function newTrade() {
  const reserved = value(purchaseMarketListing(listing(), 0n, buyer, 150n));
  if (reserved.replayed) throw new Error('Expected a newly reserved listing');
  return reserved.initialTrade;
}

function effect(trade: MarketTrade, kind: MarketTradeInstruction['kind']) {
  const selected = pendingMarketTradeInstructions(trade).find((instruction) => instruction.kind === kind);
  if (!selected) throw new Error(`Missing ${kind} instruction`);
  return selected;
}

function acknowledgment(
  instruction: MarketTradeInstruction,
  receiptId: string,
  observedGeneration?: bigint,
): MarketTradeAck {
  return {
    instruction,
    receipt: { receiptId, ...(observedGeneration === undefined ? {} : { observedGeneration }) },
  };
}

function acknowledge(trade: MarketTrade, kind: MarketTradeInstruction['kind'], receiptId: string, generation?: bigint) {
  return value(
    acknowledgeMarketTrade(trade, trade.revision, acknowledgment(effect(trade, kind), receiptId, generation)),
  );
}

function preparedTrade() {
  const held = acknowledge(newTrade(), 'prepare_funds', 'funds-prepared');
  return acknowledge(held, 'prepare_item', 'item-prepared');
}

test('a listing snapshots an eligible item home, generation, expiration and exact fee split', () => {
  const opened = listing();
  expect(opened.price).toMatchObject({
    units: 9_007_199_254_740_993n,
    feeUnits: 225_179_981_368_524n,
    sellerUnits: 8_782_019_273_372_469n,
    policyVersion: 2n,
  });
  for (const invalid of [
    { ...proof, listingId: 'other' },
    { ...proof, homeId: 'other' },
    { ...proof, holderId: 'other' },
    { ...proof, generation: 8n },
    { ...proof, protectedUntil: 499n },
    { ...proof, holderEligible: false },
  ]) {
    expect(openMarketListing(listingInput, invalid)).toEqual({ kind: 'invalid_listing' });
  }
});

test('one buyer can reserve the listing and only an exact purchase retry returns the trade reference', () => {
  const reserved = value(purchaseMarketListing(listing(), 0n, buyer, 150n));
  expect(reserved).toMatchObject({ replayed: false, listing: { revision: 1n, status: 'purchased' } });
  expect(purchaseMarketListing(reserved.listing, 0n, { ...buyer, tradeId: 'trade-two' }, 150n)).toEqual({
    kind: 'listing_unavailable',
  });
  expect(purchaseMarketListing(reserved.listing, 0n, { ...buyer, prepareUntil: 301n }, 150n)).toEqual({
    kind: 'conflict',
  });
  expect(purchaseMarketListing(reserved.listing, 0n, buyer, 700n)).toEqual({
    kind: 'ok',
    value: { listing: reserved.listing, tradeId: buyer.tradeId, replayed: true },
  });
  expect(cancelMarketListing(reserved.listing, 0n, item.holderId, 'cancel')).toEqual({ kind: 'stale_revision' });
  expect(cancelMarketListing(reserved.listing, 1n, item.holderId, 'cancel')).toEqual({ kind: 'listing_unavailable' });
});

test('seller cancellation produces one named item release and fences a delayed purchase', () => {
  expect(cancelMarketListing(listing(), 0n, 'buyer', 'cancel-one')).toEqual({ kind: 'invalid_listing' });
  const cancelled = value(cancelMarketListing(listing(), 0n, item.holderId, 'cancel-one'));
  expect(cancelled.release).toEqual({ id: 'market:cancel:listing-one', reservation: item });
  expect(value(cancelMarketListing(cancelled.listing, 0n, item.holderId, 'cancel-one'))).toEqual(cancelled);
  expect(cancelMarketListing(cancelled.listing, 1n, item.holderId, 'cancel-two')).toEqual({ kind: 'conflict' });
  expect(purchaseMarketListing(cancelled.listing, 1n, buyer, 150n)).toEqual({ kind: 'listing_unavailable' });
});

test('the commit decision requires both matching preparations and a live admission window', () => {
  const preparing = newTrade();
  const reserve = effect(preparing, 'prepare_funds');
  expect(reserve).toMatchObject({
    ownerId: 'book',
    money: { assetId: 'points', units: price.units },
    tradeId: buyer.tradeId,
  });
  expect(
    acknowledgeMarketTrade(preparing, 0n, acknowledgment({ ...reserve, ownerId: 'other' }, 'foreign-receipt')),
  ).toEqual({
    kind: 'invalid_receipt',
  });
  expect(
    acknowledgeMarketTrade(
      preparing,
      0n,
      acknowledgment({ ...reserve, money: { ...reserve.money!, units: 1n } }, 'short'),
    ),
  ).toEqual({
    kind: 'invalid_receipt',
  });
  const funds = acknowledge(preparing, 'prepare_funds', 'funds-prepared');
  expect(decideMarketTrade(funds, funds.revision, 'commit', 160n)).toEqual({ kind: 'unprepared' });
  const prepared = acknowledge(funds, 'prepare_item', 'item-prepared');
  expect(decideMarketTrade(prepared, prepared.revision, 'commit', 300n)).toEqual({ kind: 'unprepared' });
  const committed = value(decideMarketTrade(prepared, prepared.revision, 'commit', 200n));
  expect(decideMarketTrade(committed, prepared.revision, 'commit', 301n)).toEqual({ kind: 'ok', value: committed });
  expect(decideMarketTrade(committed, committed.revision, 'abort', 301n)).toEqual({ kind: 'conflict' });
});

test('a delayed delivery holds escrow and advances the holder once before seller and fee settlement', () => {
  const prepared = preparedTrade();
  const committed = value(decideMarketTrade(prepared, prepared.revision, 'commit', 200n));
  const escrow = effect(committed, 'escrow_funds');
  expect(escrow.prerequisites.map(({ receiptId }) => receiptId)).toEqual(['item-prepared', 'funds-prepared']);
  const escrowed = acknowledge(committed, 'escrow_funds', 'escrowed-once');
  const delivery = effect(escrowed, 'deliver_item');
  expect(delivery).toMatchObject({ ownerId: item.homeId, item, sellerId: item.holderId, buyerId: buyer.buyerId });
  expect(pendingMarketTradeInstructions(escrowed)).toEqual([delivery]);
  expect(marketTradeStatus(escrowed)).toBe('committing');
  expect(decideMarketTrade(escrowed, escrowed.revision, 'abort', 700n)).toEqual({ kind: 'conflict' });
  expect(acknowledgeMarketTrade(escrowed, escrowed.revision, acknowledgment(delivery, 'wrong-generation', 9n))).toEqual(
    {
      kind: 'invalid_receipt',
    },
  );
  const deliveryAck = acknowledgment(delivery, 'ownership-moved', 8n);
  const delivered = value(acknowledgeMarketTrade(escrowed, escrowed.revision, deliveryAck));
  expect(acknowledgeMarketTrade(delivered, escrowed.revision, deliveryAck)).toEqual({ kind: 'ok', value: delivered });
  expect(acknowledgeMarketTrade(delivered, delivered.revision, acknowledgment(delivery, 'second-move', 8n))).toEqual({
    kind: 'conflict',
  });
  const payout = effect(delivered, 'release_proceeds');
  expect(payout.money!.sellerUnits + payout.money!.feeUnits).toBe(price.units);
  expect(payout.prerequisites).toEqual([{ instructionId: delivery.id, receiptId: 'ownership-moved' }]);
  const completed = acknowledge(delivered, 'release_proceeds', 'settled');
  expect(marketTradeStatus(completed)).toBe('completed');
  expect(pendingMarketTradeInstructions(completed)).toEqual([]);
});

test('both owners install abort fences before either release can run and late prepares stay fenced', () => {
  const undecided = newTrade();
  const delayed = effect(undecided, 'prepare_item');
  const reserved = acknowledge(undecided, 'prepare_funds', 'funds-prepared');
  const abort = value(decideMarketTrade(reserved, reserved.revision, 'abort', 301n));
  expect(pendingMarketTradeInstructions(abort).map(({ kind }) => kind)).toEqual([
    'fence_item_abort',
    'fence_funds_abort',
  ]);
  expect(acknowledgeMarketTrade(abort, abort.revision, acknowledgment(delayed, 'late-preparation'))).toEqual({
    kind: 'out_of_order',
  });
  const oneFence = acknowledge(abort, 'fence_item_abort', 'item-fenced');
  expect(pendingMarketTradeInstructions(oneFence).map(({ kind }) => kind)).toEqual(['fence_funds_abort']);
  const bothFences = acknowledge(oneFence, 'fence_funds_abort', 'funds-fenced');
  expect(effect(bothFences, 'release_funds').prerequisites.map(({ receiptId }) => receiptId)).toEqual([
    'item-fenced',
    'funds-fenced',
  ]);
  const released = acknowledge(bothFences, 'release_funds', 'funds-free');
  const aborted = acknowledge(released, 'release_item', 'item-free');
  expect(marketTradeStatus(aborted)).toBe('aborted');
  expect(pendingMarketTradeInstructions(aborted)).toEqual([]);
});
