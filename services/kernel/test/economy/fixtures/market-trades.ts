import type { PoolClient } from 'pg';
import {
  acknowledgeMarketTrade,
  cancelMarketListing,
  decideMarketTrade,
  marketTradeStatus,
  openMarketListing,
  pendingMarketTradeInstructions,
  purchaseMarketListing,
  type MarketListing,
} from '../../../src/economy/market/trade.ts';
import { encodeMarketRecord } from '../../../src/economy/storage/market-codec.ts';

function value<T>(result: { kind: 'ok'; value: T } | { kind: string }): T {
  if (result.kind !== 'ok' || !('value' in result)) throw new Error(`Cannot seed market trade: ${result.kind}`);
  return result.value;
}

export function retainedListing({
  bookId,
  itemHomeId,
  sellerId,
  listingId,
  expiresAt,
  cancelled = false,
}: {
  bookId: string;
  itemHomeId: string;
  sellerId: string;
  listingId: string;
  expiresAt: bigint;
  cancelled?: boolean;
}) {
  const suffix = listingId.slice(-16);
  const item = {
    itemId: `item-${suffix}`,
    homeId: itemHomeId,
    holderId: sellerId,
    generation: 1n,
    reservationId: `reservation-${suffix}`,
  };
  const price = {
    ledgerBookId: bookId,
    assetId: 'test-market-credit',
    units: 9007199254740993n,
    feeAccountId: 'market-fee',
    policyVersion: 12n,
    feeBps: 2500n,
  };
  const open = value(
    openMarketListing(
      { listingId, item, expiresAt, price, now: expiresAt - 120_000n },
      { ...item, listingId, marketable: true, holderEligible: true, protectedUntil: expiresAt },
    ),
  );
  const listing = cancelled ? value(cancelMarketListing(open, 0n, sellerId, 'fixture-cancel')).listing : open;
  return { bookId, listing };
}

export function retainedTrade({
  bookId,
  itemHomeId,
  buyerId,
  sellerId,
  tradeId,
  startedAt,
  status = 'preparing',
}: {
  bookId: string;
  itemHomeId: string;
  buyerId: string;
  sellerId: string;
  tradeId: string;
  startedAt: bigint;
  status?: ReturnType<typeof marketTradeStatus>;
}) {
  const { listing: open } = retainedListing({
    bookId,
    itemHomeId,
    sellerId,
    listingId: tradeId,
    expiresAt: startedAt + 120_000n,
  });
  const bought = value(
    purchaseMarketListing(open, 0n, { tradeId, buyerId, prepareUntil: startedAt + 60_000n }, startedAt),
  );
  if (bought.replayed) throw new Error('Initial fixture purchase was a replay');
  let trade = bought.initialTrade;
  function acknowledgePending() {
    for (const instruction of pendingMarketTradeInstructions(trade)) {
      const receipt = {
        receiptId: `proof:${instruction.kind}`,
        ...(instruction.kind === 'deliver_item' ? { observedGeneration: 2n } : {}),
      };
      trade = value(acknowledgeMarketTrade(trade, trade.revision, { instruction, receipt }));
    }
  }
  if (status === 'committing' || status === 'completed') {
    acknowledgePending();
    trade = value(decideMarketTrade(trade, trade.revision, 'commit', startedAt));
  } else if (status === 'aborting' || status === 'aborted') {
    trade = value(decideMarketTrade(trade, trade.revision, 'abort', startedAt));
  }
  if (status === 'completed' || status === 'aborted') {
    while (pendingMarketTradeInstructions(trade).length > 0) acknowledgePending();
  }
  return { bookId, listing: bought.listing, trade };
}

export async function insertRetainedListings(
  client: Pick<PoolClient, 'query'>,
  fixtures: readonly { bookId: string; listing: MarketListing }[],
) {
  await client.query(
    `INSERT INTO economy.market_listing (book_id, listing_id, item_home_id, item_id, reservation_id, revision, payload)
     SELECT book_id, listing_id, item_home_id, item_id, reservation_id, revision, payload::jsonb
     FROM jsonb_to_recordset($1::jsonb) AS fixtures(book_id text, listing_id text, item_home_id text,
       item_id text, reservation_id text, revision bigint, payload text)`,
    [
      JSON.stringify(
        fixtures.map(({ bookId, listing }) => ({
          book_id: bookId,
          listing_id: listing.listingId,
          item_home_id: listing.item.homeId,
          item_id: listing.item.itemId,
          reservation_id: listing.item.reservationId,
          revision: listing.revision.toString(),
          payload: encodeMarketRecord(listing),
        })),
      ),
    ],
  );
}

export async function insertRetainedTrades(
  client: Pick<PoolClient, 'query'>,
  fixtures: readonly ReturnType<typeof retainedTrade>[],
) {
  await insertRetainedListings(client, fixtures);
  await client.query(
    `INSERT INTO economy.market_trade (book_id, trade_id, listing_id, revision, prepare_until, payload)
     SELECT book_id, trade_id, trade_id, revision, prepare_until, payload::jsonb
     FROM jsonb_to_recordset($1::jsonb) AS fixtures(book_id text, trade_id text, revision bigint,
       prepare_until bigint, payload text)`,
    [
      JSON.stringify(
        fixtures.map(({ bookId, trade }) => ({
          book_id: bookId,
          trade_id: trade.buyer.tradeId,
          revision: trade.revision.toString(),
          prepare_until: trade.buyer.prepareUntil.toString(),
          payload: encodeMarketRecord(trade),
        })),
      ),
    ],
  );
}
