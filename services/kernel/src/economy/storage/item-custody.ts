import type { PoolClient } from 'pg';
import { isEconomyBookId } from '../contract.ts';
import type { MarketListingProof, MarketTradeAck } from '../market/trade.ts';
import { encodeMarketRecord } from './market-codec.ts';
import type { MarketOwnerProofs, MarketStoreDatabase, MarketWork } from './market-store.ts';
import {
  custodyKey,
  maxItemGeneration,
  readBoundItemWork,
  validItemWorkClaim,
  type ItemTradeInstruction,
  type ItemWorkClaim,
} from './item-custody-work.ts';

type Query = Pick<PoolClient, 'query'>;
type Receipt = MarketTradeAck['receipt'];
type Lookup = Parameters<MarketOwnerProofs['findListingProof']>[0];
type Failure =
  | 'invalid_request'
  | 'item_missing'
  | 'unproved_work'
  | 'conflict'
  | 'not_eligible'
  | 'item_reserved'
  | 'expired'
  | 'out_of_order';
type Result<Value> = Readonly<{ kind: 'ok'; value: Value }> | Readonly<{ kind: Failure }>;

/** Load exact issued work under the installed coordinator's authenticated claim authority. */
export interface ItemCustodyAuthority {
  findIssuedWork(claim: ItemWorkClaim & Readonly<{ homeId: string }>): Promise<MarketWork | null>;
}

export type CustodiedItem = Readonly<{
  homeId: string;
  itemId: string;
  holderId: string;
  generation: bigint;
  marketable: boolean;
}>;

type ListingReservation = Readonly<{
  bookId: string;
  listingId: string;
  itemId: string;
  holderId: string;
  generation: bigint;
  reservationId: string;
  protectedUntil: bigint;
}>;

type ItemRow = Omit<CustodiedItem, 'generation'> & { generation: string };
type ListingRow = Omit<ListingReservation, 'generation' | 'protectedUntil'> & {
  generation: string;
  protectedUntil: string;
  phase: 'reserved' | 'prepared' | 'fenced' | 'released' | 'delivered';
  tradeId: string | null;
};
type TradePhase = 'prepared' | 'fenced' | 'released' | 'delivered';
type TradeRow = { phase: TradePhase; decidedAt: string | null; matches: boolean };
type ReceiptRow = { receiptId: string; observedGeneration: string | null; matches: boolean };

function ok<Value>(value: Value): Result<Value> {
  return { kind: 'ok', value };
}

function proof(homeId: string, reservation: ListingReservation): MarketListingProof {
  return {
    homeId,
    listingId: reservation.listingId,
    itemId: reservation.itemId,
    holderId: reservation.holderId,
    generation: reservation.generation,
    reservationId: reservation.reservationId,
    marketable: true,
    holderEligible: true,
    protectedUntil: reservation.protectedUntil,
  };
}

function receiptFrom(row: ReceiptRow): Receipt {
  return row.observedGeneration === null
    ? { receiptId: row.receiptId }
    : { receiptId: row.receiptId, observedGeneration: BigInt(row.observedGeneration) };
}

async function nativeMillis(client: Query): Promise<bigint> {
  const { rows } = await client.query<{ at: string }>(
    'SELECT floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint::text AS at',
  );
  return BigInt(rows[0]!.at);
}

async function lockOperation(client: Query, type: 'listing' | 'trade', homeId: string, bookId: string, id: string) {
  await client.query(
    `SELECT pg_advisory_xact_lock(hashtextextended(jsonb_build_array('market-item', $1::text, $2::text, $3::text, $4::text)::text, 0))`,
    [type, homeId, bookId, id],
  );
}

async function loadItem(client: Query, homeId: string, itemId: string, lock = false): Promise<CustodiedItem | null> {
  const { rows } = await client.query<ItemRow>(
    `SELECT home_id AS "homeId", item_id AS "itemId", holder_id AS "holderId", generation::text, marketable
     FROM economy.market_item WHERE home_id = $1 AND item_id = $2 ${lock ? 'FOR UPDATE' : ''}`,
    [homeId, itemId],
  );
  const row = rows[0];
  return row ? { ...row, generation: BigInt(row.generation) } : null;
}

const listingColumns = `book_id AS "bookId", listing_id AS "listingId", item_id AS "itemId", holder_id AS "holderId",
    generation::text, reservation_id AS "reservationId", protected_until::text AS "protectedUntil",
    phase, trade_id AS "tradeId"`;

async function loadListing(client: Query, homeId: string, bookId: string, id: string): Promise<ListingRow | null> {
  const { rows } = await client.query<ListingRow>(
    `SELECT ${listingColumns} FROM economy.market_item_listing WHERE home_id = $1 AND book_id = $2 AND listing_id = $3`,
    [homeId, bookId, id],
  );
  return rows[0] ?? null;
}

function saveListing(
  client: Query,
  homeId: string,
  row: ListingRow,
  phase: ListingRow['phase'],
  tradeId = row.tradeId,
) {
  return client.query(
    `UPDATE economy.market_item_listing SET phase = $4, trade_id = $5
     WHERE home_id = $1 AND book_id = $2 AND listing_id = $3`,
    [homeId, row.bookId, row.listingId, phase, tradeId],
  );
}

function matchesListing(
  row: ListingRow,
  claim: { itemId: string; holderId: string; generation: bigint; reservationId: string },
) {
  return (
    row.itemId === claim.itemId &&
    row.holderId === claim.holderId &&
    row.generation === claim.generation.toString() &&
    row.reservationId === claim.reservationId
  );
}

function matchesItem(item: CustodiedItem, row: ListingRow): boolean {
  return item.marketable && item.holderId === row.holderId && item.generation.toString() === row.generation;
}

async function findReceiptRow(client: Query, homeId: string, work: MarketWork): Promise<ReceiptRow | null> {
  const { rows } = await client.query<ReceiptRow>(
    `SELECT receipt_id AS "receiptId", observed_generation::text AS "observedGeneration", work = $4::jsonb AS matches
     FROM economy.market_item_receipt WHERE home_id = $1 AND book_id = $2 AND instruction_id = $3`,
    [homeId, work.bookId, work.id, encodeMarketRecord(work)],
  );
  return rows[0] ?? null;
}

function saveReceipt(client: Query, homeId: string, work: MarketWork, receipt: Receipt) {
  return client.query(
    `INSERT INTO economy.market_item_receipt
       (home_id, book_id, instruction_id, work, receipt_id, observed_generation)
     VALUES ($1, $2, $3, $4::jsonb, $5, $6)`,
    [
      homeId,
      work.bookId,
      work.id,
      encodeMarketRecord(work),
      receipt.receiptId,
      receipt.observedGeneration?.toString() ?? null,
    ],
  );
}

function tradeBinding(instruction: ItemTradeInstruction): string {
  return encodeMarketRecord({
    buyerId: instruction.buyerId,
    sellerId: instruction.sellerId,
    item: instruction.item,
    prepareUntil: instruction.prepareUntil,
  });
}

async function findTrade(client: Query, homeId: string, listing: ListingRow, instruction: ItemTradeInstruction) {
  const { rows } = await client.query<TradeRow>(
    `SELECT phase, decided_at::text AS "decidedAt", (listing_id = $4 AND binding = $5::jsonb) AS matches
     FROM economy.market_item_trade WHERE home_id = $1 AND book_id = $2 AND trade_id = $3`,
    [homeId, listing.bookId, instruction.tradeId, listing.listingId, tradeBinding(instruction)],
  );
  return rows[0];
}

async function saveTrade(
  client: Query,
  homeId: string,
  listing: ListingRow,
  instruction: ItemTradeInstruction,
  prior: TradeRow | undefined,
  phase: TradePhase,
) {
  const decisionAt = instruction.decision?.at.toString() ?? null;
  if (prior) {
    await client.query(
      `UPDATE economy.market_item_trade SET phase = $4, decided_at = $5
       WHERE home_id = $1 AND book_id = $2 AND trade_id = $3`,
      [homeId, listing.bookId, instruction.tradeId, phase, decisionAt],
    );
    return;
  }
  await client.query(
    `INSERT INTO economy.market_item_trade (home_id, book_id, trade_id, listing_id, binding, phase, decided_at)
     VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7)`,
    [homeId, listing.bookId, instruction.tradeId, listing.listingId, tradeBinding(instruction), phase, decisionAt],
  );
}

async function applyItemTrade(
  client: Query,
  homeId: string,
  item: CustodiedItem,
  listing: ListingRow,
  instruction: ItemTradeInstruction,
): Promise<Result<bigint | null>> {
  const trade = await findTrade(client, homeId, listing, instruction);
  if ((trade && !trade.matches) || (listing.tradeId !== null && listing.tradeId !== instruction.tradeId))
    return { kind: 'conflict' };

  switch (instruction.kind) {
    case 'prepare_item': {
      if (trade || listing.phase !== 'reserved' || !matchesItem(item, listing)) return { kind: 'out_of_order' };
      const now = await nativeMillis(client);
      if (now >= instruction.prepareUntil || instruction.prepareUntil > BigInt(listing.protectedUntil))
        return { kind: 'expired' };
      await saveTrade(client, homeId, listing, instruction, trade, 'prepared');
      await saveListing(client, homeId, listing, 'prepared', instruction.tradeId);
      return ok(null);
    }
    case 'fence_item_abort': {
      if ((trade && trade.phase !== 'prepared') || listing.phase === 'delivered') return { kind: 'out_of_order' };
      await saveTrade(client, homeId, listing, instruction, trade, 'fenced');
      if (listing.phase !== 'released') await saveListing(client, homeId, listing, 'fenced', instruction.tradeId);
      return ok(null);
    }
    case 'release_item': {
      if (
        trade?.phase !== 'fenced' ||
        trade.decidedAt !== instruction.decision!.at.toString() ||
        (listing.phase !== 'fenced' && listing.phase !== 'released')
      )
        return { kind: 'out_of_order' };
      const localFence = instruction.prerequisites[0]!;
      const { rowCount } = await client.query(
        `SELECT 1 FROM economy.market_item_receipt
         WHERE home_id = $1 AND book_id = $2 AND instruction_id = $3 AND receipt_id::text = $4`,
        [homeId, listing.bookId, localFence.instructionId, localFence.receiptId],
      );
      if (rowCount !== 1) return { kind: 'unproved_work' };
      await saveTrade(client, homeId, listing, instruction, trade, 'released');
      if (listing.phase !== 'released') await saveListing(client, homeId, listing, 'released');
      return ok(null);
    }
    case 'deliver_item': {
      if (trade?.phase !== 'prepared' || listing.phase !== 'prepared' || !matchesItem(item, listing))
        return { kind: 'out_of_order' };
      const { rows } = await client.query<{ generation: string }>(
        `UPDATE economy.market_item SET holder_id = $3, generation = generation + 1
         WHERE home_id = $1 AND item_id = $2 RETURNING generation::text`,
        [homeId, listing.itemId, instruction.buyerId],
      );
      await saveTrade(client, homeId, listing, instruction, trade, 'delivered');
      await saveListing(client, homeId, listing, 'delivered');
      return ok(BigInt(rows[0]!.generation));
    }
  }
}

/** Trusted item-home operations. The HTTP boundary must admit the current actor before invoking them. */
export function createItemCustody(database: MarketStoreDatabase, homeId: string, authority: ItemCustodyAuthority) {
  if (!custodyKey.test(homeId)) throw new Error('Invalid item custody home ID');

  return {
    readItem(itemId: string): Promise<CustodiedItem | null> {
      return custodyKey.test(itemId)
        ? database.read((client) => loadItem(client, homeId, itemId))
        : Promise.resolve(null);
    },

    register(
      input: Readonly<{ itemId: string; holderId: string; marketable: boolean }>,
    ): Promise<Result<{ itemId: string }>> {
      if (![input.itemId, input.holderId].every((id) => custodyKey.test(id)) || typeof input.marketable !== 'boolean')
        return Promise.resolve({ kind: 'invalid_request' });
      return database.transaction(async (client) => {
        const { rowCount } = await client.query(
          `INSERT INTO economy.market_item (home_id, item_id, initial_holder_id, holder_id, marketable)
           VALUES ($1, $2, $3, $3, $4) ON CONFLICT DO NOTHING`,
          [homeId, input.itemId, input.holderId, input.marketable],
        );
        if (rowCount === 1) return ok({ itemId: input.itemId });
        const existing = await client.query(
          `SELECT 1 FROM economy.market_item
           WHERE home_id = $1 AND item_id = $2 AND initial_holder_id = $3 AND marketable = $4`,
          [homeId, input.itemId, input.holderId, input.marketable],
        );
        return existing.rowCount === 1 ? ok({ itemId: input.itemId }) : { kind: 'conflict' };
      });
    },

    reserveListing(input: ListingReservation): Promise<Result<MarketListingProof>> {
      if (
        !isEconomyBookId(input.bookId) ||
        ![input.listingId, input.itemId, input.holderId, input.reservationId].every((id) => custodyKey.test(id)) ||
        input.generation <= 0n ||
        input.generation >= maxItemGeneration ||
        input.protectedUntil <= 0n ||
        input.protectedUntil > maxItemGeneration
      )
        return Promise.resolve({ kind: 'invalid_request' });
      return database.transaction(async (client) => {
        await lockOperation(client, 'listing', homeId, input.bookId, input.listingId);
        const previous = await loadListing(client, homeId, input.bookId, input.listingId);
        if (previous)
          return matchesListing(previous, input) && previous.protectedUntil === input.protectedUntil.toString()
            ? ok(proof(homeId, input))
            : { kind: 'conflict' };
        const item = await loadItem(client, homeId, input.itemId, true);
        if (!item) return { kind: 'item_missing' };
        if (!item.marketable || item.holderId !== input.holderId || item.generation !== input.generation)
          return { kind: 'not_eligible' };
        const now = await nativeMillis(client);
        if (now >= input.protectedUntil) return { kind: 'expired' };
        const byReservation = await client.query(
          `SELECT 1 FROM economy.market_item_listing
           WHERE home_id = $1 AND item_id = $2 AND reservation_id = $3`,
          [homeId, input.itemId, input.reservationId],
        );
        if (byReservation.rowCount !== 0) return { kind: 'conflict' };
        const { rows } = await client.query<ListingRow>(
          `SELECT ${listingColumns} FROM economy.market_item_listing
           WHERE home_id = $1 AND item_id = $2 AND phase IN ('reserved', 'prepared', 'fenced')`,
          [homeId, input.itemId],
        );
        const current = rows[0];
        if (current) {
          if (current.phase !== 'reserved' || now < BigInt(current.protectedUntil)) return { kind: 'item_reserved' };
          await saveListing(client, homeId, current, 'released');
        }
        const reserved = await client.query(
          `INSERT INTO economy.market_item_listing
             (home_id, book_id, listing_id, item_id, holder_id, generation, reservation_id, protected_until, phase)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'reserved')`,
          [
            homeId,
            input.bookId,
            input.listingId,
            input.itemId,
            input.holderId,
            input.generation.toString(),
            input.reservationId,
            input.protectedUntil.toString(),
          ],
        );
        if (reserved.rowCount !== 1) throw new Error('Locked item reservation did not persist');
        return ok(proof(homeId, input));
      });
    },

    findListingProof(input: Lookup): Promise<MarketListingProof | null> {
      const { item, listingId, price, expiresAt } = input;
      if (
        item.homeId !== homeId ||
        !isEconomyBookId(price.ledgerBookId) ||
        ![listingId, item.itemId, item.holderId, item.reservationId].every((id) => custodyKey.test(id)) ||
        item.generation <= 0n ||
        item.generation >= maxItemGeneration ||
        expiresAt <= 0n ||
        expiresAt > maxItemGeneration
      )
        return Promise.resolve(null);
      return database.read(async (client) => {
        const { rows } = await client.query<{ protectedUntil: string }>(
          `SELECT listing.protected_until::text AS "protectedUntil"
           FROM economy.market_item_listing listing JOIN economy.market_item item USING (home_id, item_id)
           WHERE listing.home_id = $1 AND listing.book_id = $2 AND listing.listing_id = $3
             AND listing.phase = 'reserved' AND listing.protected_until >= $4
             AND listing.protected_until > floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint
             AND listing.item_id = $5 AND listing.holder_id = $6 AND listing.generation = $7
             AND listing.reservation_id = $8 AND item.marketable AND item.generation = listing.generation
             AND item.holder_id = listing.holder_id`,
          [
            homeId,
            price.ledgerBookId,
            listingId,
            expiresAt.toString(),
            item.itemId,
            item.holderId,
            item.generation.toString(),
            item.reservationId,
          ],
        );
        return rows[0]
          ? proof(homeId, {
              ...item,
              bookId: price.ledgerBookId,
              listingId,
              protectedUntil: BigInt(rows[0].protectedUntil),
            })
          : null;
      });
    },

    async execute(claim: ItemWorkClaim): Promise<Result<Receipt>> {
      if (!validItemWorkClaim(claim)) return { kind: 'invalid_request' };
      // The caller supplies a claim locator. The installed authority returns the complete bound instruction.
      const work = await authority.findIssuedWork({ ...claim, homeId });
      if (!work || work.bookId !== claim.bookId || work.id !== claim.instructionId) return { kind: 'unproved_work' };
      const command = readBoundItemWork(work, homeId);
      if (!command) return { kind: 'unproved_work' };
      return database.transaction(async (client) => {
        if (command.kind === 'cancel') await lockOperation(client, 'listing', homeId, work.bookId, work.listingId);
        else await lockOperation(client, 'trade', homeId, work.bookId, command.instruction.tradeId);
        const prior = await findReceiptRow(client, homeId, work);
        if (prior) return prior.matches ? ok(receiptFrom(prior)) : { kind: 'conflict' };
        const item = await loadItem(client, homeId, command.item.itemId, true);
        if (!item) return { kind: 'item_missing' };
        const listing = await loadListing(client, homeId, work.bookId, work.listingId);
        if (!listing || !matchesListing(listing, command.item)) return { kind: 'conflict' };
        let observedGeneration: bigint | null = null;
        if (command.kind === 'cancel') {
          if (listing.tradeId !== null || (listing.phase !== 'reserved' && listing.phase !== 'released'))
            return { kind: 'out_of_order' };
          if (listing.phase === 'reserved') await saveListing(client, homeId, listing, 'released');
        } else {
          const result = await applyItemTrade(client, homeId, item, listing, command.instruction);
          if (result.kind !== 'ok') return result;
          observedGeneration = result.value;
        }
        const receipt =
          observedGeneration === null
            ? { receiptId: crypto.randomUUID() }
            : { receiptId: crypto.randomUUID(), observedGeneration };
        await saveReceipt(client, homeId, work, receipt);
        return ok(receipt);
      });
    },

    findReceipt(work: MarketWork, receiptId: string): Promise<Receipt | null> {
      if (!custodyKey.test(receiptId) || !readBoundItemWork(work, homeId)) return Promise.resolve(null);
      return database.read(async (client) => {
        const row = await findReceiptRow(client, homeId, work);
        return row?.matches && row.receiptId === receiptId ? receiptFrom(row) : null;
      });
    },
  };
}
