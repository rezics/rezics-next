import type { PoolClient } from 'pg';
import {
  acknowledgeMarketTrade,
  decideMarketTrade,
  marketTradeStatus,
  openMarketListing,
  pendingMarketTradeInstructions,
  purchaseMarketListing,
} from '../../../src/economy/market/trade.ts';
import { encodeMarketRecord } from '../../../src/economy/storage/market-codec.ts';

function value<T>(result: { kind: 'ok'; value: T } | { kind: string }): T {
  if (result.kind !== 'ok' || !('value' in result)) throw new Error(`Cannot seed market trade: ${result.kind}`);
  return result.value;
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
  const listingId = tradeId;
  const expiresAt = startedAt + 120_000n;
  const item = { itemId: tradeId, homeId: itemHomeId, holderId: sellerId, generation: 1n, reservationId: tradeId };
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
      { listingId, item, expiresAt, price, now: startedAt },
      { ...item, listingId, marketable: true, holderEligible: true, protectedUntil: expiresAt },
    ),
  );
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

export async function insertRetainedTrades(
  client: Pick<PoolClient, 'query'>,
  fixtures: readonly ReturnType<typeof retainedTrade>[],
) {
  await client.query(
    `INSERT INTO economy.market_listing (book_id, listing_id, item_home_id, item_id, reservation_id, revision, payload)
     SELECT book_id, listing_id, item_home_id, item_id, reservation_id, 1, payload::jsonb
     FROM jsonb_to_recordset($1::jsonb) AS fixtures(book_id text, listing_id text, item_home_id text,
       item_id text, reservation_id text, payload text)`,
    [
      JSON.stringify(
        fixtures.map(({ bookId, listing }) => ({
          book_id: bookId,
          listing_id: listing.listingId,
          item_home_id: listing.item.homeId,
          item_id: listing.item.itemId,
          reservation_id: listing.item.reservationId,
          payload: encodeMarketRecord(listing),
        })),
      ),
    ],
  );
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
