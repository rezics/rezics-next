export declare const SPOT_MATCH_FILL_LIMIT = 32;
export declare const SPOT_MATCH_PRICE_LEVEL_LIMIT = 16;
export declare const SPOT_MATCH_WINDOW_LIMIT: number;
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
export type SpotOrderRequest = SpotOrderTerms & Readonly<{
    orderId: string;
    accountId: string;
}>;
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
export type SpotOrder = SpotOrderRequest & Readonly<{
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
type SpotError = 'invalid_instrument' | 'invalid_order' | 'invalid_reservation' | 'invalid_priority_window' | 'stale_book' | 'book_busy';
type SpotResult<Value> = Readonly<{
    kind: 'ok';
    value: Value;
}> | Readonly<{
    kind: SpotError;
}>;
type SpotOrderTransition = Readonly<{
    book: SpotBook;
    order: SpotOrder;
}>;
export type SpotMatchTransition = SpotOrderTransition & Readonly<{
    makers: readonly SpotOrder[];
    fills: readonly SpotFill[];
    releases: readonly SpotRelease[];
}>;
export declare function openSpotBook(instrument: SpotInstrument): SpotResult<SpotBook>;
/** Round fees per lot so the exact obligation is independent of how an order divides into fills. */
export declare function quoteSpotReservation(instrument: SpotInstrument, terms: SpotOrderTerms): SpotResult<Readonly<{
    assetId: string;
    unitsPerLot: bigint;
    units: bigint;
}>>;
export declare function acceptSpotOrder(book: SpotBook, expectedRevision: bigint, request: SpotOrderRequest, reservation: SpotReservationProof | null): SpotResult<SpotOrderTransition>;
/**
 * Supply the complete best-price/FIFO prefix of resting opposite orders for the expected book revision, up to
 * SPOT_MATCH_WINDOW_LIMIT. The extra row detects a fill-budget continuation. Persist the returned book, orders,
 * obligations and release intents together with the owner's allocation fence. Re-read the prefix after each step.
 */
export declare function matchSpotOrder(book: SpotBook, expectedRevision: bigint, taker: SpotOrder, priorityWindow: readonly SpotOrder[]): SpotResult<SpotMatchTransition>;
export declare function cancelSpotOrder(book: SpotBook, expectedRevision: bigint, order: SpotOrder, accountId: string): SpotResult<SpotOrderTransition & Readonly<{
    release: SpotRelease;
}>>;
export {};
