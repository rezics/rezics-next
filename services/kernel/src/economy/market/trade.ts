const key = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/;
const maxValue = (1n << 63n) - 1n;
const basisPoints = 10_000n;

type ItemClaim = Readonly<{
  itemId: string;
  homeId: string;
  holderId: string;
  generation: bigint;
  reservationId: string;
}>;

/** The item owner binds an eligible reservation to exactly one listing and holder generation. */
export type MarketListingProof = ItemClaim &
  Readonly<{ listingId: string; marketable: boolean; holderEligible: boolean; protectedUntil: bigint }>;

type Price = Readonly<{
  ledgerBookId: string;
  assetId: string;
  units: bigint;
  feeAccountId: string;
  policyVersion: bigint;
  feeBps: bigint;
}>;

type MarketTerms = Readonly<{
  listingId: string;
  item: ItemClaim;
  expiresAt: bigint;
  price: Price & Readonly<{ feeUnits: bigint; sellerUnits: bigint }>;
}>;

type PurchaseRequest = Readonly<{ tradeId: string; buyerId: string; prepareUntil: bigint }>;
type Buyer = PurchaseRequest & Readonly<{ startedAt: bigint }>;

type ListingState =
  | Readonly<{ status: 'open' }>
  | Readonly<{ status: 'cancelled'; operationId: string }>
  | Readonly<{ status: 'purchased'; buyer: Buyer }>;

export type MarketListing = MarketTerms & ListingState & Readonly<{ modelVersion: 1; revision: bigint }>;

type TradeAction =
  | 'prepare_item'
  | 'prepare_funds'
  | 'fence_item_abort'
  | 'fence_funds_abort'
  | 'release_item'
  | 'release_funds'
  | 'escrow_funds'
  | 'deliver_item'
  | 'release_proceeds';

type TradeReceipt = Readonly<{ receiptId: string; observedGeneration?: bigint }>;

type Decision = Readonly<{ kind: 'commit' | 'abort'; at: bigint }>;

export type MarketTrade = Readonly<{
  modelVersion: 1;
  revision: bigint;
  terms: MarketTerms;
  buyer: Buyer;
  decision: Decision | null;
  receipts: Readonly<Partial<Record<TradeAction, TradeReceipt>>>;
}>;

export type MarketTradeInstruction = Readonly<{
  id: string;
  kind: TradeAction;
  tradeId: string;
  ownerId: string;
  reservationId: string;
  buyerId: string;
  sellerId: string;
  prepareUntil: bigint;
  item: ItemClaim | null;
  money: MarketTerms['price'] | null;
  decision: Decision | null;
  prerequisites: readonly Readonly<{ instructionId: string; receiptId: string }>[];
}>;

export type MarketTradeAck = Readonly<{ instruction: MarketTradeInstruction; receipt: TradeReceipt }>;

type Failure =
  | 'invalid_listing'
  | 'invalid_purchase'
  | 'invalid_receipt'
  | 'stale_revision'
  | 'listing_unavailable'
  | 'conflict'
  | 'unprepared'
  | 'out_of_order';

type Result<Value> = Readonly<{ kind: 'ok'; value: Value }> | Readonly<{ kind: Failure }>;

type Purchase =
  | Readonly<{ listing: MarketListing; initialTrade: MarketTrade; replayed: false }>
  | Readonly<{ listing: MarketListing; tradeId: string; replayed: true }>;
type Cancel = Readonly<{
  listing: MarketListing;
  release: Readonly<{ id: string; reservation: ItemClaim }>;
}>;

function ok<Value>(value: Value): Result<Value> {
  return { kind: 'ok', value };
}

function inRange(value: bigint, lower = 0n): boolean {
  return value >= lower && value <= maxValue;
}

function termsOf(listing: MarketListing): MarketTerms {
  const { listingId, item, expiresAt, price } = listing;
  return { listingId, item, expiresAt, price };
}

export function openMarketListing(
  input: Readonly<{ item: ItemClaim; listingId: string; price: Price; expiresAt: bigint; now: bigint }>,
  proof: MarketListingProof,
): Result<MarketListing> {
  const { listingId, item, price, expiresAt, now } = input;
  if (
    ![
      listingId,
      item.itemId,
      item.homeId,
      item.holderId,
      item.reservationId,
      price.ledgerBookId,
      price.assetId,
      price.feeAccountId,
    ].every((value) => key.test(value)) ||
    !inRange(now) ||
    !inRange(expiresAt, now + 1n) ||
    !inRange(item.generation, 1n) ||
    item.generation === maxValue ||
    !inRange(price.units, 1n) ||
    !inRange(price.policyVersion, 1n) ||
    price.feeBps < 0n ||
    price.feeBps > basisPoints ||
    price.feeAccountId === item.holderId ||
    !proof.marketable ||
    !proof.holderEligible ||
    !inRange(proof.protectedUntil, expiresAt) ||
    proof.listingId !== listingId ||
    proof.itemId !== item.itemId ||
    proof.homeId !== item.homeId ||
    proof.holderId !== item.holderId ||
    proof.generation !== item.generation ||
    proof.reservationId !== item.reservationId
  ) {
    return { kind: 'invalid_listing' };
  }
  const feeUnits = (price.units * price.feeBps) / basisPoints;
  return ok({
    modelVersion: 1,
    revision: 0n,
    status: 'open',
    listingId,
    item,
    expiresAt,
    price: { ...price, feeUnits, sellerUnits: price.units - feeUnits },
  });
}

/** Persist the listing revision before dispatching its named item release. */
export function cancelMarketListing(
  listing: MarketListing,
  revision: bigint,
  holderId: string,
  operationId: string,
): Result<Cancel> {
  if (holderId !== listing.item.holderId || !key.test(operationId)) return { kind: 'invalid_listing' };
  const release = { id: `market:cancel:${listing.listingId}`, reservation: listing.item };
  if (listing.status === 'cancelled')
    return listing.operationId === operationId ? ok({ listing, release }) : { kind: 'conflict' };
  if (listing.revision !== revision) return { kind: 'stale_revision' };
  if (listing.status !== 'open') return { kind: 'listing_unavailable' };
  return ok({ listing: { ...listing, status: 'cancelled', operationId, revision: revision + 1n }, release });
}

function newTrade(listing: MarketListing, buyer: Buyer): MarketTrade {
  return { modelVersion: 1, revision: 0n, terms: termsOf(listing), buyer, decision: null, receipts: {} };
}

/** A compare-and-set stores the listing, initial trade, and the prepare intents together. */
export function purchaseMarketListing(
  listing: MarketListing,
  revision: bigint,
  input: PurchaseRequest,
  now: bigint,
): Result<Purchase> {
  if (listing.status === 'purchased') {
    const { buyer } = listing;
    if (buyer.tradeId !== input.tradeId) return { kind: 'listing_unavailable' };
    if (buyer.buyerId !== input.buyerId || buyer.prepareUntil !== input.prepareUntil) return { kind: 'conflict' };
    return ok({ listing, tradeId: buyer.tradeId, replayed: true });
  }
  if (listing.revision !== revision) return { kind: 'stale_revision' };
  if (listing.status !== 'open' || now >= listing.expiresAt) return { kind: 'listing_unavailable' };
  if (
    !key.test(input.tradeId) ||
    !key.test(input.buyerId) ||
    input.buyerId === listing.item.holderId ||
    input.buyerId === listing.price.feeAccountId ||
    !inRange(now) ||
    !inRange(input.prepareUntil, now + 1n) ||
    input.prepareUntil > listing.expiresAt
  ) {
    return { kind: 'invalid_purchase' };
  }
  const buyer = { ...input, startedAt: now };
  return ok({
    listing: { ...listing, revision: revision + 1n, status: 'purchased', buyer },
    initialTrade: newTrade(listing, buyer),
    replayed: false,
  });
}

function operationId(tradeId: string, kind: TradeAction): string {
  return `market:${kind}:${tradeId}`;
}

function instruction(trade: MarketTrade, kind: TradeAction): MarketTradeInstruction {
  const { terms, buyer, receipts } = trade;
  const item =
    kind === 'prepare_item' || kind === 'fence_item_abort' || kind === 'release_item' || kind === 'deliver_item';
  const purposes: Partial<Record<TradeAction, readonly TradeAction[]>> = {
    release_item: ['fence_item_abort', 'fence_funds_abort'],
    release_funds: ['fence_item_abort', 'fence_funds_abort'],
    escrow_funds: ['prepare_item', 'prepare_funds'],
    deliver_item: ['escrow_funds'],
    release_proceeds: ['deliver_item'],
  };
  return {
    kind,
    id: operationId(buyer.tradeId, kind),
    tradeId: buyer.tradeId,
    ownerId: item ? terms.item.homeId : terms.price.ledgerBookId,
    reservationId: item ? terms.item.reservationId : `market:funds:${buyer.tradeId}`,
    buyerId: buyer.buyerId,
    sellerId: terms.item.holderId,
    prepareUntil: buyer.prepareUntil,
    item: item ? terms.item : null,
    money: item ? null : terms.price,
    decision: kind === 'prepare_item' || kind === 'prepare_funds' ? null : trade.decision,
    prerequisites: (purposes[kind] ?? []).map((prior) => ({
      instructionId: operationId(buyer.tradeId, prior),
      receiptId: receipts[prior]!.receiptId,
    })),
  };
}

export function pendingMarketTradeInstructions(trade: MarketTrade): readonly MarketTradeInstruction[] {
  const { decision, receipts } = trade;
  const kinds: readonly TradeAction[] =
    decision === null
      ? ['prepare_item', 'prepare_funds']
      : decision.kind === 'abort'
        ? receipts.fence_item_abort && receipts.fence_funds_abort
          ? ['release_item', 'release_funds']
          : ['fence_item_abort', 'fence_funds_abort']
        : !receipts.escrow_funds
          ? ['escrow_funds']
          : !receipts.deliver_item
            ? ['deliver_item']
            : ['release_proceeds'];
  return kinds.filter((kind) => !receipts[kind]).map((kind) => instruction(trade, kind));
}

export function marketTradeStatus(
  trade: MarketTrade,
): 'preparing' | 'committing' | 'aborting' | 'completed' | 'aborted' {
  const { decision, receipts } = trade;
  if (decision === null) return 'preparing';
  if (decision.kind === 'commit') return receipts.release_proceeds ? 'completed' : 'committing';
  return receipts.release_item && receipts.release_funds ? 'aborted' : 'aborting';
}

/** The preparation receipts prove protection until the owners observe a durable decision. */
export function decideMarketTrade(
  trade: MarketTrade,
  revision: bigint,
  kind: Decision['kind'],
  now: bigint,
): Result<MarketTrade> {
  if (trade.decision !== null) return trade.decision.kind === kind ? ok(trade) : { kind: 'conflict' };
  if (trade.revision !== revision) return { kind: 'stale_revision' };
  if (!inRange(now, trade.buyer.startedAt)) return { kind: 'invalid_purchase' };
  if (
    kind === 'commit' &&
    (now >= trade.buyer.prepareUntil || !trade.receipts.prepare_item || !trade.receipts.prepare_funds)
  )
    return { kind: 'unprepared' };
  return ok({ ...trade, revision: revision + 1n, decision: { kind, at: now } });
}

function sameItem(left: ItemClaim | null, right: ItemClaim | null): boolean {
  if (left === null || right === null) return left === right;
  return (
    left.homeId === right.homeId &&
    left.itemId === right.itemId &&
    left.holderId === right.holderId &&
    left.generation === right.generation &&
    left.reservationId === right.reservationId
  );
}

function sameMoney(left: MarketTerms['price'] | null, right: MarketTerms['price'] | null): boolean {
  if (left === null || right === null) return left === right;
  return (
    left.ledgerBookId === right.ledgerBookId &&
    left.assetId === right.assetId &&
    left.units === right.units &&
    left.feeAccountId === right.feeAccountId &&
    left.policyVersion === right.policyVersion &&
    left.feeBps === right.feeBps &&
    left.feeUnits === right.feeUnits &&
    left.sellerUnits === right.sellerUnits
  );
}

function sameInstruction(left: MarketTradeInstruction, right: MarketTradeInstruction): boolean {
  return (
    left.kind === right.kind &&
    left.id === right.id &&
    left.tradeId === right.tradeId &&
    left.ownerId === right.ownerId &&
    left.reservationId === right.reservationId &&
    left.buyerId === right.buyerId &&
    left.sellerId === right.sellerId &&
    left.prepareUntil === right.prepareUntil &&
    sameItem(left.item, right.item) &&
    sameMoney(left.money, right.money) &&
    left.decision?.kind === right.decision?.kind &&
    left.decision?.at === right.decision?.at &&
    left.prerequisites.length === right.prerequisites.length &&
    left.prerequisites.every(
      ({ instructionId, receiptId }, index) =>
        instructionId === right.prerequisites[index]?.instructionId &&
        receiptId === right.prerequisites[index]?.receiptId,
    )
  );
}

/** Consume authenticated owner receipts only. Persist the next revision before issuing its instructions. */
export function acknowledgeMarketTrade(trade: MarketTrade, revision: bigint, ack: MarketTradeAck): Result<MarketTrade> {
  const { instruction: received, receipt } = ack;
  const recorded = trade.receipts[received.kind];
  const expected = recorded
    ? instruction(trade, received.kind)
    : pendingMarketTradeInstructions(trade).find(({ kind }) => kind === received.kind);
  if (expected === undefined) return { kind: 'out_of_order' };
  const delivered = received.kind === 'deliver_item' ? trade.terms.item.generation + 1n : undefined;
  if (!sameInstruction(expected, received) || !key.test(receipt.receiptId) || receipt.observedGeneration !== delivered)
    return { kind: 'invalid_receipt' };
  if (recorded) return recorded.receiptId === receipt.receiptId ? ok(trade) : { kind: 'conflict' };
  if (trade.revision !== revision) return { kind: 'stale_revision' };
  return ok({ ...trade, revision: revision + 1n, receipts: { ...trade.receipts, [received.kind]: receipt } });
}
