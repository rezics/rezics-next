import type { PoolClient } from 'pg';
import { isEconomyBookId } from '../contract.ts';
import {
  acknowledgeMarketTrade,
  cancelMarketListing,
  decideMarketTrade,
  openMarketListing,
  pendingMarketTradeInstructions,
  purchaseMarketListing,
  type MarketListing,
  type MarketListingProof,
  type MarketTrade,
  type MarketTradeAck,
  type MarketTradeInstruction,
} from '../market/trade.ts';
import { decodeMarketRecord, encodeMarketRecord } from './market-codec.ts';

type Query = Pick<PoolClient, 'query'>;

export interface MarketStoreDatabase {
  transaction<Value>(work: (client: Query) => Promise<Value>): Promise<Value>;
  read<Value>(work: (client: Query) => Promise<Value>): Promise<Value>;
}

type ListingInput = Omit<Parameters<typeof openMarketListing>[0], 'now'>;
type PurchaseRequest = Parameters<typeof purchaseMarketListing>[2];
type Decision = NonNullable<MarketTrade['decision']>;
type Receipt = MarketTradeAck['receipt'];

export type MarketWorkOwner = Readonly<{ kind: 'item' | 'ledger'; id: string }>;
export type MarketWork = Readonly<{
  id: string;
  bookId: string;
  listingId: string;
  owner: MarketWorkOwner;
}> &
  (
    | Readonly<{ kind: 'trade'; instruction: MarketTradeInstruction }>
    | Readonly<{ kind: 'cancel_listing'; reservation: MarketListing['item'] }>
  );

/** Authoritative owner lookups of durable proofs. Called outside the coordinator transaction. */
export interface MarketOwnerProofs {
  findListingProof(input: ListingInput): Promise<MarketListingProof | null>;
  findReceipt(work: MarketWork, receiptId: string): Promise<Receipt | null>;
}

export type MarketWorkClaim = Readonly<{ work: MarketWork; claimId: string; availableAt: string }>;

type Failure =
  | Exclude<ReturnType<typeof openMarketListing>, { kind: 'ok' }>['kind']
  | 'not_found'
  | 'not_ready'
  | 'stale_claim'
  | 'invalid_owner_request';
type Result<Value> = Readonly<{ kind: 'ok'; value: Value }> | Readonly<{ kind: Failure }>;

type Payload = { payload: string };
type WorkRow = Payload & {
  status: 'pending' | 'acknowledged' | 'superseded';
  claimId: string | null;
  availableAt: Date;
  receipt: string | null;
};

const ownerKey = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/;
const workKey = /^market:[a-z_]+:[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const claimLeaseMs = 30_000;
const maxPage = 100;

function ok<Value>(value: Value): Result<Value> {
  return { kind: 'ok', value };
}

function validOwner(owner: MarketWorkOwner): boolean {
  return (owner.kind === 'item' || owner.kind === 'ledger') && ownerKey.test(owner.id);
}

async function nativeMillis(client: Query): Promise<bigint> {
  const { rows } = await client.query<{ millis: string }>(
    'SELECT floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint::text AS millis',
  );
  return BigInt(rows[0]!.millis);
}

async function findListing(client: Query, bookId: string, id: string, lock = false): Promise<MarketListing | null> {
  const { rows } = await client.query<Payload>(
    `SELECT payload::text FROM economy.market_listing WHERE book_id = $1 AND listing_id = $2 ${lock ? 'FOR UPDATE' : ''}`,
    [bookId, id],
  );
  return rows[0] ? decodeMarketRecord<MarketListing>(rows[0].payload) : null;
}

async function findTrade(client: Query, bookId: string, id: string, lock = false): Promise<MarketTrade | null> {
  const { rows } = await client.query<Payload>(
    `SELECT payload::text FROM economy.market_trade WHERE book_id = $1 AND trade_id = $2 ${lock ? 'FOR UPDATE' : ''}`,
    [bookId, id],
  );
  return rows[0] ? decodeMarketRecord<MarketTrade>(rows[0].payload) : null;
}

async function findWork(
  client: Query,
  bookId: string,
  owner: MarketWorkOwner,
  id: string,
  lock = false,
): Promise<WorkRow | undefined> {
  const { rows } = await client.query<WorkRow>(
    `SELECT payload::text, status, claim_id AS "claimId", available_at AS "availableAt", receipt::text
     FROM economy.market_work WHERE book_id = $1 AND instruction_id = $2 AND owner_kind = $3 AND owner_id = $4
     ${lock ? 'FOR UPDATE' : ''}`,
    [bookId, id, owner.kind, owner.id],
  );
  return rows[0];
}

function listingReplay(listing: MarketListing, input: ListingInput): Result<{ listingId: string }> {
  const { item, price } = listing;
  if (
    listing.expiresAt !== input.expiresAt ||
    item.homeId !== input.item.homeId ||
    item.itemId !== input.item.itemId ||
    item.holderId !== input.item.holderId ||
    item.generation !== input.item.generation ||
    item.reservationId !== input.item.reservationId ||
    price.ledgerBookId !== input.price.ledgerBookId ||
    price.assetId !== input.price.assetId ||
    price.units !== input.price.units ||
    price.feeAccountId !== input.price.feeAccountId ||
    price.policyVersion !== input.price.policyVersion ||
    price.feeBps !== input.price.feeBps
  )
    return { kind: 'conflict' };
  return ok({ listingId: listing.listingId });
}

async function saveListing(client: Query, bookId: string, previous: MarketListing, next: MarketListing): Promise<void> {
  const { rowCount } = await client.query(
    `UPDATE economy.market_listing SET revision = $3, payload = $4::jsonb
     WHERE book_id = $1 AND listing_id = $2 AND revision = $5`,
    [bookId, previous.listingId, next.revision.toString(), encodeMarketRecord(next), previous.revision.toString()],
  );
  if (rowCount !== 1) throw new Error('Locked market listing revision changed');
}

async function enqueueWork(client: Query, work: MarketWork): Promise<void> {
  await client.query(
    `INSERT INTO economy.market_work (book_id, instruction_id, listing_id, trade_id, owner_kind, owner_id, payload)
     VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb) ON CONFLICT (book_id, instruction_id) DO NOTHING`,
    [
      work.bookId,
      work.id,
      work.listingId,
      work.kind === 'trade' ? work.instruction.tradeId : null,
      work.owner.kind,
      work.owner.id,
      encodeMarketRecord(work),
    ],
  );
}

async function syncTradeWork(client: Query, bookId: string, trade: MarketTrade): Promise<void> {
  const pending = pendingMarketTradeInstructions(trade);
  await client.query(
    `UPDATE economy.market_work SET status = 'superseded'
     WHERE book_id = $1 AND trade_id = $2 AND status = 'pending' AND NOT (instruction_id = ANY($3::text[]))`,
    [bookId, trade.buyer.tradeId, pending.map(({ id }) => id)],
  );
  for (const instruction of pending) {
    await enqueueWork(client, {
      kind: 'trade',
      instruction,
      id: instruction.id,
      bookId,
      listingId: trade.terms.listingId,
      owner: { kind: instruction.item ? 'item' : 'ledger', id: instruction.ownerId },
    });
  }
}

async function advanceTrade(client: Query, bookId: string, previous: MarketTrade, next: MarketTrade): Promise<void> {
  if (next.revision === previous.revision) return;
  const { rowCount } = await client.query(
    `UPDATE economy.market_trade SET revision = $3, payload = $4::jsonb
     WHERE book_id = $1 AND trade_id = $2 AND revision = $5`,
    [bookId, previous.buyer.tradeId, next.revision.toString(), encodeMarketRecord(next), previous.revision.toString()],
  );
  if (rowCount !== 1) throw new Error('Locked market trade revision changed');
  await syncTradeWork(client, bookId, next);
}

/** The coordinator is internal. An installed application binds actor and real owner authority. */
export function createMarketStore(database: MarketStoreDatabase, bookId: string, owners: MarketOwnerProofs) {
  if (!isEconomyBookId(bookId)) throw new Error('Invalid market book ID');

  return {
    readListing: (id: string) => database.read((client) => findListing(client, bookId, id)),
    readTrade: (id: string) => database.read((client) => findTrade(client, bookId, id)),

    async open(input: ListingInput): Promise<Result<{ listingId: string }>> {
      if (input.price.ledgerBookId !== bookId || !ownerKey.test(input.listingId)) return { kind: 'invalid_listing' };
      const prior = await database.read((client) => findListing(client, bookId, input.listingId));
      if (prior) return listingReplay(prior, input);
      const proof = await owners.findListingProof(input);
      if (proof === null) return { kind: 'invalid_listing' };
      return database.transaction(async (client) => {
        const initial = openMarketListing({ ...input, now: await nativeMillis(client) }, proof);
        if (initial.kind !== 'ok') return initial;
        const listing = initial.value;
        const { rowCount } = await client.query(
          `INSERT INTO economy.market_listing (book_id, listing_id, item_home_id, item_id, reservation_id, revision, payload)
           VALUES ($1, $2, $3, $4, $5, 0, $6::jsonb) ON CONFLICT DO NOTHING`,
          [
            bookId,
            listing.listingId,
            listing.item.homeId,
            listing.item.itemId,
            listing.item.reservationId,
            encodeMarketRecord(listing),
          ],
        );
        if (rowCount === 1) return ok({ listingId: listing.listingId });
        const existing = await findListing(client, bookId, input.listingId);
        return existing ? listingReplay(existing, input) : { kind: 'conflict' };
      });
    },

    purchase(id: string, revision: bigint, request: PurchaseRequest): Promise<Result<{ tradeId: string }>> {
      return database.transaction(async (client) => {
        const listing = await findListing(client, bookId, id, true);
        if (!listing) return { kind: 'not_found' };
        const result = purchaseMarketListing(listing, revision, request, await nativeMillis(client));
        if (result.kind !== 'ok') return result;
        if (result.value.replayed) return ok({ tradeId: result.value.tradeId });
        const { initialTrade } = result.value;
        const { rowCount } = await client.query(
          `INSERT INTO economy.market_trade (book_id, trade_id, listing_id, revision, prepare_until, payload)
           VALUES ($1, $2, $3, 0, $4, $5::jsonb) ON CONFLICT DO NOTHING`,
          [bookId, initialTrade.buyer.tradeId, id, request.prepareUntil.toString(), encodeMarketRecord(initialTrade)],
        );
        if (rowCount !== 1) return { kind: 'conflict' };
        await saveListing(client, bookId, listing, result.value.listing);
        await syncTradeWork(client, bookId, initialTrade);
        return ok({ tradeId: initialTrade.buyer.tradeId });
      });
    },

    cancel(
      id: string,
      revision: bigint,
      holderId: string,
      operationId: string,
    ): Promise<Result<{ releaseId: string }>> {
      return database.transaction(async (client) => {
        const listing = await findListing(client, bookId, id, true);
        if (!listing) return { kind: 'not_found' };
        const result = cancelMarketListing(listing, revision, holderId, operationId);
        if (result.kind !== 'ok') return result;
        const { listing: next, release } = result.value;
        if (next.revision !== listing.revision) {
          await saveListing(client, bookId, listing, next);
          await enqueueWork(client, {
            kind: 'cancel_listing',
            reservation: release.reservation,
            id: release.id,
            bookId,
            listingId: id,
            owner: { kind: 'item', id: release.reservation.homeId },
          });
        }
        return ok({ releaseId: release.id });
      });
    },

    decide(id: string, revision: bigint, kind: Decision['kind']): Promise<Result<Decision>> {
      return database.transaction(async (client) => {
        const trade = await findTrade(client, bookId, id, true);
        if (!trade) return { kind: 'not_found' };
        const result = decideMarketTrade(trade, revision, kind, await nativeMillis(client));
        if (result.kind !== 'ok') return result;
        await advanceTrade(client, bookId, trade, result.value);
        return ok(result.value.decision!);
      });
    },

    listDecisionCandidates(
      kind: Decision['kind'],
      limit: number,
    ): Promise<Result<readonly Readonly<{ tradeId: string; revision: bigint }>[]>> {
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > maxPage)
        return Promise.resolve({ kind: 'invalid_owner_request' });
      const condition = kind === 'commit' ? 'prepared AND prepare_until > $2' : 'prepare_until <= $2';
      return database.read(async (client) => {
        const now = await nativeMillis(client);
        const { rows } = await client.query<{ tradeId: string; revision: string }>(
          `SELECT trade_id AS "tradeId", revision::text FROM economy.market_trade
           WHERE book_id = $1 AND decision_pending AND ${condition}
           ORDER BY prepare_until, trade_id LIMIT $3`,
          [bookId, now.toString(), limit],
        );
        return ok(rows.map(({ tradeId, revision }) => ({ tradeId, revision: BigInt(revision) })));
      });
    },

    listReady(owner: MarketWorkOwner, limit: number): Promise<Result<readonly MarketWork[]>> {
      if (!validOwner(owner) || !Number.isSafeInteger(limit) || limit < 1 || limit > maxPage)
        return Promise.resolve({ kind: 'invalid_owner_request' });
      return database.read(async (client) => {
        const { rows } = await client.query<Payload>(
          `SELECT payload::text FROM economy.market_work
           WHERE book_id = $1 AND owner_kind = $2 AND owner_id = $3 AND status = 'pending'
             AND available_at <= statement_timestamp()
           ORDER BY available_at, instruction_id LIMIT $4`,
          [bookId, owner.kind, owner.id, limit],
        );
        return ok(rows.map(({ payload }) => decodeMarketRecord<MarketWork>(payload)));
      });
    },

    claim(owner: MarketWorkOwner, id: string, claimId: string): Promise<Result<MarketWorkClaim>> {
      if (!validOwner(owner) || !workKey.test(id) || !uuid.test(claimId))
        return Promise.resolve({ kind: 'invalid_owner_request' });
      return database.transaction(async (client) => {
        const row = await findWork(client, bookId, owner, id, true);
        if (!row) return { kind: 'not_found' };
        if (row.status !== 'pending') return { kind: 'not_ready' };
        const work = decodeMarketRecord<MarketWork>(row.payload);
        if (row.claimId === claimId) return ok({ work, claimId, availableAt: row.availableAt.toISOString() });
        const { rows } = await client.query<{ availableAt: Date }>(
          `UPDATE economy.market_work SET claim_id = $3, available_at = statement_timestamp() + $4 * interval '1 ms'
           WHERE book_id = $1 AND instruction_id = $2 AND available_at <= statement_timestamp()
           RETURNING available_at AS "availableAt"`,
          [bookId, id, claimId, claimLeaseMs],
        );
        return rows[0] ? ok({ work, claimId, availableAt: rows[0].availableAt.toISOString() }) : { kind: 'not_ready' };
      });
    },

    async acknowledge(
      owner: MarketWorkOwner,
      id: string,
      claimId: string,
      receiptId: string,
    ): Promise<Result<Receipt>> {
      if (!validOwner(owner) || !workKey.test(id) || !uuid.test(claimId) || !ownerKey.test(receiptId))
        return { kind: 'invalid_owner_request' };
      const observed = await database.read((client) => findWork(client, bookId, owner, id));
      if (!observed) return { kind: 'not_found' };
      if (observed.status === 'superseded' || observed.claimId !== claimId) return { kind: 'stale_claim' };
      if (observed.receipt !== null) return replayReceipt(observed.receipt, receiptId);
      const work = decodeMarketRecord<MarketWork>(observed.payload);
      const proof = await owners.findReceipt(work, receiptId);
      if (!proof || proof.receiptId !== receiptId) return { kind: 'invalid_receipt' };
      return database.transaction(async (client) => {
        const trade = work.kind === 'trade' ? await findTrade(client, bookId, work.instruction.tradeId, true) : null;
        const row = await findWork(client, bookId, owner, id, true);
        if (!row || row.status === 'superseded' || row.claimId !== claimId) return { kind: 'stale_claim' };
        if (row.receipt !== null) return replayReceipt(row.receipt, receiptId);
        let next: MarketTrade | null = null;
        if (work.kind === 'trade') {
          if (!trade) throw new Error('Market instruction has no trade');
          const result = acknowledgeMarketTrade(trade, trade.revision, {
            instruction: work.instruction,
            receipt: proof,
          });
          if (result.kind !== 'ok') return result;
          next = result.value;
        } else if (proof.observedGeneration !== undefined) {
          return { kind: 'invalid_receipt' };
        }
        await client.query(
          `UPDATE economy.market_work SET status = 'acknowledged', receipt = $3::jsonb
           WHERE book_id = $1 AND instruction_id = $2`,
          [bookId, id, encodeMarketRecord(proof)],
        );
        if (trade && next) await advanceTrade(client, bookId, trade, next);
        return ok(proof);
      });
    },
  };
}

function replayReceipt(encoded: string, receiptId: string): Result<Receipt> {
  const receipt = decodeMarketRecord<Receipt>(encoded);
  return receipt.receiptId === receiptId ? ok(receipt) : { kind: 'conflict' };
}
