import { expect, test } from 'bun:test';
import {
  acceptSpotOrder,
  cancelSpotOrder,
  matchSpotOrder,
  openSpotBook,
  quoteSpotReservation,
  SPOT_MATCH_FILL_LIMIT,
  SPOT_MATCH_PRICE_LEVEL_LIMIT,
  SPOT_MATCH_WINDOW_LIMIT,
  type SpotBook,
  type SpotInstrument,
  type SpotOrder,
  type SpotOrderRequest,
  type SpotReservationProof,
} from '../../src/economy/exchange/order-book.ts';

const instrument: SpotInstrument = {
  id: 'point-coin',
  ledgerBookId: 'economy',
  policyVersion: 2n,
  baseAssetId: 'point',
  quoteAssetId: 'coin',
  baseUnitsPerLot: 2n,
  quoteUnitsPerPriceTick: 1n,
  makerFeeBps: 100n,
  takerFeeBps: 0n,
};

function value<T>(result: { kind: 'ok'; value: T } | { kind: string }): T {
  if (!('value' in result)) throw new Error(`Unsuccessful transition: ${result.kind}`);
  return result.value;
}

function order(
  orderId: string,
  accountId: string,
  side: SpotOrder['side'],
  price: bigint,
  lots: bigint,
): SpotOrderRequest {
  return { orderId, accountId, side, price, lots };
}

function proof(book: SpotBook, request: SpotOrderRequest): SpotReservationProof {
  const { assetId, units } = value(quoteSpotReservation(book.instrument, request));
  return {
    reservationId: `hold-${request.orderId}`,
    ledgerBookId: book.instrument.ledgerBookId,
    instrumentId: book.instrument.id,
    policyVersion: book.instrument.policyVersion,
    orderId: request.orderId,
    accountId: request.accountId,
    assetId,
    units,
  };
}

function place(book: SpotBook, request: SpotOrderRequest) {
  return value(acceptSpotOrder(book, book.revision, request, proof(book, request)));
}

function fill(book: SpotBook, taker: SpotOrder, window: readonly SpotOrder[]) {
  return value(matchSpotOrder(book, book.revision, taker, window));
}

function rest(book: SpotBook, request: SpotOrderRequest) {
  const accepted = place(book, request);
  return fill(accepted.book, accepted.order, []);
}

test('admission binds funds to the instrument, account, order and exact integer terms', () => {
  expect(openSpotBook({ ...instrument, baseAssetId: instrument.quoteAssetId })).toEqual({ kind: 'invalid_instrument' });
  const book = value(openSpotBook({ ...instrument, quoteUnitsPerPriceTick: 2n }));
  const bid = order('bid', 'buyer', 'buy', 10n, 10n);
  const funded = proof(book, bid);
  expect(funded.units).toBe(110n);
  expect(quoteSpotReservation(book.instrument, { ...bid, price: 9n })).toEqual({ kind: 'invalid_order' });
  expect(quoteSpotReservation(book.instrument, { ...bid, lots: 1n << 62n })).toEqual({ kind: 'invalid_order' });
  const mismatches = [
    null,
    { ...funded, accountId: 'other-buyer' },
    { ...funded, orderId: 'other-order' },
    { ...funded, ledgerBookId: 'other-book' },
    { ...funded, instrumentId: 'other-instrument' },
    { ...funded, policyVersion: 1n },
    { ...funded, assetId: 'point' },
    { ...funded, units: funded.units - 1n },
  ];
  for (const reservation of mismatches) {
    expect(acceptSpotOrder(book, book.revision, bid, reservation)).toEqual({ kind: 'invalid_reservation' });
  }
  expect(place(book, bid).order).toMatchObject({ status: 'matching', reservedUnitsPerLot: 11n });
});

test('matching uses best price before arrival, and arrival before later orders at the same price', () => {
  const initial = value(openSpotBook(instrument));
  const dear = rest(initial, order('dear', 'seller-1', 'sell', 10n, 3n));
  const cheap = rest(dear.book, order('cheap', 'seller-2', 'sell', 8n, 3n));
  const later = rest(cheap.book, order('later', 'seller-3', 'sell', 8n, 3n));
  const bid = place(later.book, order('bid', 'buyer', 'buy', 10n, 7n));
  expect(matchSpotOrder(bid.book, bid.book.revision, bid.order, [dear.order, cheap.order, later.order])).toEqual({
    kind: 'invalid_priority_window',
  });
  expect(matchSpotOrder(bid.book, bid.book.revision, bid.order, [later.order, cheap.order])).toEqual({
    kind: 'invalid_priority_window',
  });
  expect(
    matchSpotOrder(bid.book, bid.book.revision, bid.order, [{ ...cheap.order, instrumentId: 'different' }]),
  ).toEqual({
    kind: 'invalid_priority_window',
  });
  const window = [cheap.order, later.order, dear.order];
  const matched = fill(bid.book, bid.order, window);
  expect(fill(bid.book, bid.order, window)).toEqual(matched);
  expect(matched.fills.map(({ makerOrderId, lots, price }) => [makerOrderId, lots, price])).toEqual([
    ['cheap', 3n, 8n],
    ['later', 3n, 8n],
    ['dear', 1n, 10n],
  ]);
  expect(matched.fills[0]).toMatchObject({ baseUnits: 6n, quoteUnits: 24n, buyerFeeUnits: 0n, sellerFeeUnits: 3n });
  expect(matched.makers[2]).toMatchObject({ orderId: 'dear', status: 'resting', remainingLots: 2n });
  expect(matched.order.status).toBe('filled');
});

test('partial fills protect exact allocations while cancellation releases only the unallocated remainder', () => {
  const initial = value(openSpotBook(instrument));
  const ask = rest(initial, order('ask', 'seller-1', 'sell', 8n, 4n));
  const bid = place(ask.book, order('bid', 'buyer', 'buy', 10n, 10n));
  const first = fill(bid.book, bid.order, [ask.order]);
  expect(first.order).toMatchObject({ status: 'resting', remainingLots: 6n });
  expect(first.fills[0]?.buyer).toMatchObject({
    reservationId: 'hold-bid',
    allocatedAssetId: 'coin',
    allocatedUnits: 32n,
  });
  expect(first.releases).toMatchObject([{ reservationId: 'hold-bid', units: 12n, reason: 'fill_surplus' }]);

  const next = place(first.book, order('ask-next', 'seller-2', 'sell', 9n, 3n));
  const second = fill(next.book, next.order, [first.order]);
  expect(second.fills[0]).toMatchObject({ quoteUnits: 30n, buyerFeeUnits: 3n, sellerFeeUnits: 0n });
  expect(second.fills[0]?.buyer.allocatedUnits).toBe(33n);
  const resting = second.makers[0]!;
  expect(cancelSpotOrder(second.book, second.book.revision, resting, 'seller-2')).toEqual({ kind: 'invalid_order' });
  const cancelled = value(cancelSpotOrder(second.book, second.book.revision, resting, 'buyer'));
  expect(cancelled).toMatchObject({
    order: { status: 'cancelled' },
    release: { reservationId: 'hold-bid', units: 33n, reason: 'cancelled' },
  });
  expect(second.fills[0]?.id).not.toBe(first.fills[0]?.id);
  expect(32n + 12n + 33n + cancelled.release.units).toBe(proof(ask.book, bid.order).units);
});

test('a self-cross cancels the incoming remainder and leaves each older order at its priority', () => {
  const initial = value(openSpotBook(instrument));
  const other = rest(initial, order('other-ask', 'other', 'sell', 8n, 2n));
  const own = rest(other.book, order('self-ask', 'owner', 'sell', 9n, 2n));
  const after = rest(own.book, order('after-ask', 'third', 'sell', 9n, 2n));
  const bid = place(after.book, order('bid', 'owner', 'buy', 10n, 5n));
  const matched = fill(bid.book, bid.order, [other.order, own.order, after.order]);
  expect(matched.order).toMatchObject({ status: 'cancelled', remainingLots: 3n });
  expect(matched.book.matchingSequence).toBeNull();
  expect(matched.fills.map((f) => f.makerOrderId)).toEqual(['other-ask']);
  expect(matched.makers.map((o) => o.orderId)).toEqual(['other-ask']);
  expect(matched.releases).toMatchObject([
    { units: 6n, reason: 'fill_surplus' },
    { units: 33n, reason: 'self_trade' },
  ]);
});

function addAsks(count: number, price: (index: number) => bigint) {
  let book = value(openSpotBook(instrument));
  const makers: SpotOrder[] = [];
  for (let index = 0; index < count; index++) {
    const resting = rest(book, order(`ask-${index}`, `seller-${index}`, 'sell', price(index), 1n));
    book = resting.book;
    makers.push(resting.order);
  }
  return { book, makers };
}

test('equal-price fills resume after the order cap with later admissions fenced', () => {
  const { book, makers } = addAsks(SPOT_MATCH_WINDOW_LIMIT + 1, () => 8n);
  const bid = place(book, order('bid', 'buyer', 'buy', 10n, BigInt(SPOT_MATCH_WINDOW_LIMIT)));
  expect(matchSpotOrder(bid.book, bid.book.revision, bid.order, makers)).toEqual({ kind: 'invalid_priority_window' });
  const first = fill(bid.book, bid.order, makers.slice(0, SPOT_MATCH_WINDOW_LIMIT));
  expect(first.fills).toHaveLength(SPOT_MATCH_FILL_LIMIT);
  expect(first.order).toMatchObject({ status: 'matching', remainingLots: 1n });
  expect(first.book.matchingSequence).toBe(bid.order.sequence);
  const later = order('later', 'new-buyer', 'buy', 10n, 1n);
  expect(acceptSpotOrder(first.book, first.book.revision, later, proof(first.book, later))).toEqual({
    kind: 'book_busy',
  });
  expect(cancelSpotOrder(first.book, first.book.revision, makers.at(-1)!, 'seller-33')).toEqual({ kind: 'book_busy' });
  expect(matchSpotOrder(first.book, bid.book.revision, bid.order, [])).toEqual({ kind: 'stale_book' });

  const next = fill(first.book, first.order, makers.slice(SPOT_MATCH_FILL_LIMIT));
  expect(next.fills.map((f) => f.makerOrderId)).toEqual([`ask-${SPOT_MATCH_FILL_LIMIT}`]);
  expect(next.book.matchingSequence).toBeNull();
  expect(next.order.status).toBe('filled');
});

test('distinct price levels consume their own budget and a non-crossing head leaves a resting order', () => {
  const { book, makers } = addAsks(SPOT_MATCH_PRICE_LEVEL_LIMIT + 2, (index) => BigInt(index + 1));
  const bid = place(book, order('bid', 'buyer', 'buy', BigInt(SPOT_MATCH_PRICE_LEVEL_LIMIT + 1), 20n));
  const first = fill(bid.book, bid.order, makers);
  expect(first.fills).toHaveLength(SPOT_MATCH_PRICE_LEVEL_LIMIT);
  expect(first.order.status).toBe('matching');
  const next = fill(first.book, first.order, makers.slice(SPOT_MATCH_PRICE_LEVEL_LIMIT));
  expect(next.fills).toHaveLength(1);
  expect(next.order.remainingLots).toBe(20n - BigInt(SPOT_MATCH_PRICE_LEVEL_LIMIT + 1));
  expect(next.order.status).toBe('resting');
});
