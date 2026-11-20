export const SPOT_MATCH_FILL_LIMIT = 32;
export const SPOT_MATCH_PRICE_LEVEL_LIMIT = 16;
export const SPOT_MATCH_WINDOW_LIMIT = SPOT_MATCH_FILL_LIMIT + 1;

const maxUnits = (1n << 63n) - 1n;
const basisPoints = 10_000n;
const keyPattern = /^[a-zA-Z0-9_-]{1,64}$/;

export type SpotInstrument = Readonly<{
  id: string;
  ledgerBookId: string;
  policyVersion: bigint;
  baseAssetId: string;
  quoteAssetId: string;
  baseUnitsPerLot: bigint;
  quoteUnitsPerPriceTick: bigint;
  makerFeeBps: bigint;
  takerFeeBps: bigint;
}>;

export type SpotBook = Readonly<{
  modelVersion: 1;
  instrument: SpotInstrument;
  revision: bigint;
  matchingSequence: bigint | null;
}>;

export type SpotOrderTerms = Readonly<{
  side: 'buy' | 'sell';
  /** Quote minor units per base lot. */
  price: bigint;
  lots: bigint;
}>;

export type SpotOrderRequest = SpotOrderTerms & Readonly<{ orderId: string; accountId: string }>;

/** The caller supplies this proof from its trusted reservation owner. */
export type SpotReservationProof = Readonly<{
  reservationId: string;
  ledgerBookId: string;
  instrumentId: string;
  policyVersion: bigint;
  orderId: string;
  accountId: string;
  assetId: string;
  units: bigint;
}>;

export type SpotOrder = SpotOrderRequest &
  Readonly<{
    instrumentId: string;
    policyVersion: bigint;
    sequence: bigint;
    remainingLots: bigint;
    status: 'matching' | 'resting' | 'filled' | 'cancelled';
    reservationId: string;
    reservedUnitsPerLot: bigint;
  }>;

type SpotFillParty = Readonly<{
  orderId: string;
  accountId: string;
  sequence: bigint;
  reservationId: string;
  allocatedAssetId: string;
  allocatedUnits: bigint;
}>;

/** A durable settlement obligation once both allocations and the match are committed by their owners. */
export type SpotFill = Readonly<{
  id: string;
  instrumentId: string;
  ledgerBookId: string;
  policyVersion: bigint;
  makerOrderId: string;
  takerOrderId: string;
  lots: bigint;
  price: bigint;
  baseUnits: bigint;
  quoteUnits: bigint;
  buyerFeeUnits: bigint;
  sellerFeeUnits: bigint;
  buyer: SpotFillParty;
  seller: SpotFillParty;
}>;

export type SpotRelease = Readonly<{
  id: string;
  orderId: string;
  accountId: string;
  reservationId: string;
  assetId: string;
  units: bigint;
  reason: 'fill_surplus' | 'cancelled' | 'self_trade';
}>;

type SpotError =
  | 'invalid_instrument'
  | 'invalid_order'
  | 'invalid_reservation'
  | 'invalid_priority_window'
  | 'stale_book'
  | 'book_busy';

type SpotResult<Value> = Readonly<{ kind: 'ok'; value: Value }> | Readonly<{ kind: SpotError }>;

type SpotOrderTransition = Readonly<{ book: SpotBook; order: SpotOrder }>;

export type SpotMatchTransition = SpotOrderTransition &
  Readonly<{
    makers: readonly SpotOrder[];
    fills: readonly SpotFill[];
    releases: readonly SpotRelease[];
  }>;

function positiveUnits(value: bigint): boolean {
  return value > 0n && value <= maxUnits;
}

function validFee(fee: bigint): boolean {
  return fee >= 0n && fee <= basisPoints;
}

function perLotFee(quoteUnits: bigint, feeBps: bigint): bigint {
  return (quoteUnits * feeBps + basisPoints - 1n) / basisPoints;
}

function validInstrument(instrument: SpotInstrument): boolean {
  return (
    keyPattern.test(instrument.id) &&
    keyPattern.test(instrument.ledgerBookId) &&
    keyPattern.test(instrument.baseAssetId) &&
    keyPattern.test(instrument.quoteAssetId) &&
    instrument.baseAssetId !== instrument.quoteAssetId &&
    positiveUnits(instrument.policyVersion) &&
    positiveUnits(instrument.baseUnitsPerLot) &&
    positiveUnits(instrument.quoteUnitsPerPriceTick) &&
    validFee(instrument.makerFeeBps) &&
    validFee(instrument.takerFeeBps)
  );
}

export function openSpotBook(instrument: SpotInstrument): SpotResult<SpotBook> {
  if (!validInstrument(instrument)) return { kind: 'invalid_instrument' };
  return {
    kind: 'ok',
    value: { modelVersion: 1, instrument: { ...instrument }, revision: 0n, matchingSequence: null },
  };
}

/** Round fees per lot so the exact obligation is independent of how an order divides into fills. */
export function quoteSpotReservation(
  instrument: SpotInstrument,
  terms: SpotOrderTerms,
): SpotResult<
  Readonly<{
    assetId: string;
    unitsPerLot: bigint;
    units: bigint;
  }>
> {
  if (!validInstrument(instrument)) return { kind: 'invalid_instrument' };
  if (
    (terms.side !== 'buy' && terms.side !== 'sell') ||
    !positiveUnits(terms.price) ||
    !positiveUnits(terms.lots) ||
    terms.price % instrument.quoteUnitsPerPriceTick !== 0n ||
    !positiveUnits(terms.price * terms.lots) ||
    !positiveUnits(instrument.baseUnitsPerLot * terms.lots)
  )
    return { kind: 'invalid_order' };

  const highestFee = instrument.makerFeeBps > instrument.takerFeeBps ? instrument.makerFeeBps : instrument.takerFeeBps;
  const buying = terms.side === 'buy';
  const unitsPerLot = buying ? terms.price + perLotFee(terms.price, highestFee) : instrument.baseUnitsPerLot;
  const units = unitsPerLot * terms.lots;
  if (!positiveUnits(units)) return { kind: 'invalid_order' };
  return {
    kind: 'ok',
    value: { assetId: buying ? instrument.quoteAssetId : instrument.baseAssetId, unitsPerLot, units },
  };
}

export function acceptSpotOrder(
  book: SpotBook,
  expectedRevision: bigint,
  request: SpotOrderRequest,
  reservation: SpotReservationProof | null,
): SpotResult<SpotOrderTransition> {
  if (expectedRevision !== book.revision) return { kind: 'stale_book' };
  if (book.matchingSequence !== null) return { kind: 'book_busy' };
  if (!keyPattern.test(request.orderId) || !keyPattern.test(request.accountId)) return { kind: 'invalid_order' };

  const { instrument } = book;
  const required = quoteSpotReservation(instrument, request);
  if (required.kind !== 'ok') return required;
  if (
    !reservation ||
    !keyPattern.test(reservation.reservationId) ||
    reservation.orderId !== request.orderId ||
    reservation.accountId !== request.accountId ||
    reservation.ledgerBookId !== instrument.ledgerBookId ||
    reservation.instrumentId !== instrument.id ||
    reservation.policyVersion !== instrument.policyVersion ||
    reservation.assetId !== required.value.assetId ||
    reservation.units !== required.value.units
  )
    return { kind: 'invalid_reservation' };

  const sequence = book.revision + 1n;
  const order: SpotOrder = {
    ...request,
    instrumentId: instrument.id,
    policyVersion: instrument.policyVersion,
    sequence,
    remainingLots: request.lots,
    status: 'matching',
    reservationId: reservation.reservationId,
    reservedUnitsPerLot: required.value.unitsPerLot,
  };
  return { kind: 'ok', value: { book: { ...book, revision: sequence, matchingSequence: sequence }, order } };
}

function belongsToBook(book: SpotBook, order: SpotOrder): boolean {
  const required = quoteSpotReservation(book.instrument, order);
  return (
    order.instrumentId === book.instrument.id &&
    order.policyVersion === book.instrument.policyVersion &&
    order.sequence > 0n &&
    order.sequence <= book.revision &&
    positiveUnits(order.remainingLots) &&
    order.remainingLots <= order.lots &&
    required.kind === 'ok' &&
    order.reservedUnitsPerLot === required.value.unitsPerLot
  );
}

function priorityOrder(taker: SpotOrder, earlier: SpotOrder, later: SpotOrder): boolean {
  if (earlier.price === later.price) return earlier.sequence < later.sequence;
  return taker.side === 'buy' ? earlier.price < later.price : earlier.price > later.price;
}

function crosses(taker: SpotOrder, maker: SpotOrder): boolean {
  return taker.side === 'buy' ? maker.price <= taker.price : maker.price >= taker.price;
}

function validPriorityWindow(book: SpotBook, taker: SpotOrder, makers: readonly SpotOrder[]): boolean {
  if (makers.length > SPOT_MATCH_WINDOW_LIMIT) return false;
  const orderIds = new Set([taker.orderId]);
  const reservationIds = new Set([taker.reservationId]);
  const sequences = new Set([taker.sequence]);
  let earlier: SpotOrder | undefined;
  for (const maker of makers) {
    if (
      !belongsToBook(book, maker) ||
      maker.status !== 'resting' ||
      maker.side === taker.side ||
      maker.sequence >= taker.sequence ||
      orderIds.has(maker.orderId) ||
      reservationIds.has(maker.reservationId) ||
      sequences.has(maker.sequence) ||
      (earlier !== undefined && !priorityOrder(taker, earlier, maker))
    )
      return false;
    earlier = maker;
    orderIds.add(maker.orderId);
    reservationIds.add(maker.reservationId);
    sequences.add(maker.sequence);
  }
  return true;
}

function orderPrefix(instrument: SpotInstrument, order: SpotOrder): string {
  return `spot-v1/${instrument.id}/${order.sequence}`;
}

function allocation(order: SpotOrder, allocatedAssetId: string, allocatedUnits: bigint): SpotFillParty {
  const { orderId, accountId, sequence, reservationId } = order;
  return { orderId, accountId, sequence, reservationId, allocatedAssetId, allocatedUnits };
}

function proposeFill(instrument: SpotInstrument, maker: SpotOrder, taker: SpotOrder, lots: bigint): SpotFill {
  const price = maker.price;
  const baseUnits = instrument.baseUnitsPerLot * lots;
  const quoteUnits = price * lots;
  const makerFee = perLotFee(price, instrument.makerFeeBps) * lots;
  const takerFee = perLotFee(price, instrument.takerFeeBps) * lots;
  const buyerMakes = maker.side === 'buy';
  const buyerFeeUnits = buyerMakes ? makerFee : takerFee;
  const sellerFeeUnits = buyerMakes ? takerFee : makerFee;
  return {
    id: `${orderPrefix(instrument, taker)}/fill/${maker.sequence}`,
    instrumentId: instrument.id,
    ledgerBookId: instrument.ledgerBookId,
    policyVersion: instrument.policyVersion,
    makerOrderId: maker.orderId,
    takerOrderId: taker.orderId,
    lots,
    price,
    baseUnits,
    quoteUnits,
    buyerFeeUnits,
    sellerFeeUnits,
    buyer: allocation(buyerMakes ? maker : taker, instrument.quoteAssetId, quoteUnits + buyerFeeUnits),
    seller: allocation(buyerMakes ? taker : maker, instrument.baseAssetId, baseUnits),
  };
}

function release(
  instrument: SpotInstrument,
  order: SpotOrder,
  id: string,
  units: bigint,
  reason: SpotRelease['reason'],
): SpotRelease {
  const { orderId, accountId, reservationId } = order;
  const assetId = order.side === 'buy' ? instrument.quoteAssetId : instrument.baseAssetId;
  return { id, orderId, accountId, reservationId, assetId, units, reason };
}

function releaseRemainder(
  instrument: SpotInstrument,
  order: SpotOrder,
  reason: 'cancelled' | 'self_trade',
): SpotRelease {
  return release(
    instrument,
    order,
    `${orderPrefix(instrument, order)}/remainder`,
    order.reservedUnitsPerLot * order.remainingLots,
    reason,
  );
}

/**
 * Supply the complete best-price/FIFO prefix of resting opposite orders for the expected book revision, up to
 * SPOT_MATCH_WINDOW_LIMIT. The extra row detects a fill-budget continuation. Persist the returned book, orders,
 * obligations and release intents together with the owner's allocation fence. Re-read the prefix after each step.
 */
export function matchSpotOrder(
  book: SpotBook,
  expectedRevision: bigint,
  taker: SpotOrder,
  priorityWindow: readonly SpotOrder[],
): SpotResult<SpotMatchTransition> {
  if (expectedRevision !== book.revision) return { kind: 'stale_book' };
  if (taker.sequence !== book.matchingSequence || taker.status !== 'matching' || !belongsToBook(book, taker)) {
    return { kind: 'invalid_order' };
  }
  if (!validPriorityWindow(book, taker, priorityWindow)) return { kind: 'invalid_priority_window' };

  const makers: SpotOrder[] = [];
  const fills: SpotFill[] = [];
  const releases: SpotRelease[] = [];
  const { instrument } = book;
  let remainingLots = taker.remainingLots;
  let status: SpotOrder['status'] = 'resting';
  let lastPrice: bigint | undefined;
  let priceLevels = 0;

  for (const maker of priorityWindow) {
    if (!crosses(taker, maker)) break;
    if (lastPrice !== maker.price) priceLevels++;
    if (fills.length === SPOT_MATCH_FILL_LIMIT || priceLevels > SPOT_MATCH_PRICE_LEVEL_LIMIT) {
      status = 'matching';
      break;
    }
    if (maker.accountId === taker.accountId) {
      releases.push(releaseRemainder(instrument, { ...taker, remainingLots }, 'self_trade'));
      status = 'cancelled';
      break;
    }

    const lots = remainingLots < maker.remainingLots ? remainingLots : maker.remainingLots;
    const fill = proposeFill(instrument, maker, taker, lots);
    const buyer = maker.side === 'buy' ? maker : taker;
    const surplus = buyer.reservedUnitsPerLot * lots - fill.buyer.allocatedUnits;
    if (surplus > 0n) releases.push(release(instrument, buyer, `${fill.id}/surplus`, surplus, 'fill_surplus'));
    fills.push(fill);
    lastPrice = maker.price;

    const makerRemaining = maker.remainingLots - lots;
    makers.push({ ...maker, remainingLots: makerRemaining, status: makerRemaining === 0n ? 'filled' : 'resting' });
    remainingLots -= lots;
    if (remainingLots === 0n) {
      status = 'filled';
      break;
    }
  }

  return {
    kind: 'ok',
    value: {
      book: { ...book, revision: book.revision + 1n, matchingSequence: status === 'matching' ? taker.sequence : null },
      order: { ...taker, remainingLots, status },
      makers,
      fills,
      releases,
    },
  };
}

export function cancelSpotOrder(
  book: SpotBook,
  expectedRevision: bigint,
  order: SpotOrder,
  accountId: string,
): SpotResult<SpotOrderTransition & Readonly<{ release: SpotRelease }>> {
  if (expectedRevision !== book.revision) return { kind: 'stale_book' };
  if (book.matchingSequence !== null) return { kind: 'book_busy' };
  if (accountId !== order.accountId || order.status !== 'resting' || !belongsToBook(book, order)) {
    return { kind: 'invalid_order' };
  }
  return {
    kind: 'ok',
    value: {
      book: { ...book, revision: book.revision + 1n },
      order: { ...order, status: 'cancelled' },
      release: releaseRemainder(book.instrument, order, 'cancelled'),
    },
  };
}
