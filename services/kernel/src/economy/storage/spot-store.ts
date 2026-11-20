import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import type { EconomyFailure, EconomyLedger, SpotFillSettlement } from '../contract.ts';
import {
  acceptSpotOrder,
  cancelSpotOrder,
  matchSpotOrder,
  openSpotBook,
  quoteSpotReservation,
  SPOT_MATCH_WINDOW_LIMIT,
  type SpotBook,
  type SpotFill,
  type SpotInstrument,
  type SpotOrder,
  type SpotOrderRequest,
  type SpotRelease,
} from '../exchange/order-book.ts';
import { createEconomyLedger, type EconomyDatabase } from '../ledger.ts';

type Query = Pick<PoolClient, 'query'>;
type CoreFailure = Exclude<ReturnType<typeof matchSpotOrder>['kind'], 'ok'>;
type Failure = EconomyFailure | CoreFailure | 'not_found' | 'idle' | 'stale_claim';
type Result<T> = Readonly<{ kind: 'ok'; value: T }> | Readonly<{ kind: Failure }>;
type Terms = SpotInstrument & Readonly<{ feeAccountId: string }>;
type Instrument = Readonly<{ book: SpotBook; feeAccountId: string }>;
type InstrumentRow = Omit<
  Terms,
  'policyVersion' | 'baseUnitsPerLot' | 'quoteUnitsPerPriceTick' | 'makerFeeBps' | 'takerFeeBps'
> & {
  policyVersion: string;
  baseUnitsPerLot: string;
  quoteUnitsPerPriceTick: string;
  makerFeeBps: string;
  takerFeeBps: string;
  revision: string;
  matchingSequence: string | null;
};
type OrderRow = Omit<
  SpotOrder,
  'policyVersion' | 'sequence' | 'price' | 'lots' | 'remainingLots' | 'reservedUnitsPerLot'
> & {
  sequence: string;
  price: string;
  lots: string;
  remainingLots: string;
  reservedUnitsPerLot: string;
};
type MatchReceipt = Readonly<{
  revision: bigint;
  orderId: string;
  status: SpotOrder['status'];
  fillIds: readonly string[];
}>;
type FillRow = SpotFillSettlement & Readonly<{ token: string | null; dueAt: Date; settledAt: Date | null }>;
type Claim = Readonly<{ fillId: string; token: string; until: string }>;
type OrderReceipt = Readonly<{ orderId: string; sequence: bigint }>;

const key = /^[a-zA-Z0-9_-]{1,64}$/;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const nilAccount = '00000000-0000-0000-0000-000000000000';
const maximumRevision = (1n << 63n) - 1n;
const leaseSeconds = 30;
const readyLimit = 32;
// This order owner keeps good-until-cancelled holds. Cancellation releases the unallocated remainder.
const orderExpiry = '9999-12-31T23:59:59.999Z';

const instrumentColumns = `instrument_id AS id, book_id AS "ledgerBookId", policy_version::text AS "policyVersion",
  base_asset_id AS "baseAssetId", quote_asset_id AS "quoteAssetId", base_units_per_lot::text AS "baseUnitsPerLot",
  quote_units_per_price_tick::text AS "quoteUnitsPerPriceTick", maker_fee_bps::text AS "makerFeeBps",
  taker_fee_bps::text AS "takerFeeBps", fee_account_id::text AS "feeAccountId", revision::text,
  matching_sequence::text AS "matchingSequence"`;
const orderColumns = `instrument_id AS "instrumentId", order_id AS "orderId", account_id::text AS "accountId",
  sequence::text, side, price::text, lots::text, remaining_lots::text AS "remainingLots", status,
  reservation_id::text AS "reservationId", reserved_units_per_lot::text AS "reservedUnitsPerLot"`;

function ok<T>(value: T): Result<T> & { kind: 'ok' } {
  return { kind: 'ok', value };
}

function failure<K extends Failure>(kind: K): Readonly<{ kind: K }> {
  return { kind };
}

function accountId(value: string): string | null {
  return uuid.test(value) && value !== nilAccount ? value.toLowerCase() : null;
}

function validFillId(value: string): boolean {
  return /^[a-zA-Z0-9_/-]{1,255}$/.test(value);
}

async function readInstrument(tx: Query, bookId: string, id: string, lock = false): Promise<Instrument | null> {
  const { rows } = await tx.query<InstrumentRow>(
    `SELECT ${instrumentColumns} FROM economy.spot_instrument
     WHERE book_id = $1 AND instrument_id = $2 ${lock ? 'FOR UPDATE' : ''}`,
    [bookId, id],
  );
  const row = rows[0];
  if (!row) return null;
  const {
    feeAccountId,
    revision,
    matchingSequence,
    policyVersion,
    baseUnitsPerLot,
    quoteUnitsPerPriceTick,
    makerFeeBps,
    takerFeeBps,
    ...identity
  } = row;
  return {
    feeAccountId,
    book: {
      modelVersion: 1,
      revision: BigInt(revision),
      matchingSequence: matchingSequence === null ? null : BigInt(matchingSequence),
      instrument: {
        ...identity,
        policyVersion: BigInt(policyVersion),
        baseUnitsPerLot: BigInt(baseUnitsPerLot),
        quoteUnitsPerPriceTick: BigInt(quoteUnitsPerPriceTick),
        makerFeeBps: BigInt(makerFeeBps),
        takerFeeBps: BigInt(takerFeeBps),
      },
    },
  };
}

function orderOf(row: OrderRow, policyVersion: bigint): SpotOrder {
  return {
    ...row,
    policyVersion,
    sequence: BigInt(row.sequence),
    price: BigInt(row.price),
    lots: BigInt(row.lots),
    remainingLots: BigInt(row.remainingLots),
    reservedUnitsPerLot: BigInt(row.reservedUnitsPerLot),
  };
}

async function readOrder(tx: Query, book: SpotBook, orderId: string): Promise<SpotOrder | null> {
  const { rows } = await tx.query<OrderRow>(
    `SELECT ${orderColumns} FROM economy.spot_order WHERE book_id = $1 AND instrument_id = $2 AND order_id = $3`,
    [book.instrument.ledgerBookId, book.instrument.id, orderId],
  );
  return rows[0] ? orderOf(rows[0], book.instrument.policyVersion) : null;
}

async function matchOrders(tx: Query, book: SpotBook): Promise<readonly [SpotOrder, SpotOrder[]]> {
  const { ledgerBookId, id, policyVersion } = book.instrument;
  const { rows } = await tx.query<OrderRow>(
    `SELECT ${orderColumns} FROM economy.spot_order WHERE book_id = $1 AND instrument_id = $2 AND sequence = $3`,
    [ledgerBookId, id, book.matchingSequence!.toString()],
  );
  const taker = rows[0];
  if (!taker || taker.status !== 'matching') throw new Error('Economy spot continuation has no matching order');
  const priority =
    taker.side === 'buy'
      ? "side = 'sell' ORDER BY resting.price, resting.sequence"
      : "side = 'buy' ORDER BY resting.price DESC, resting.sequence";
  const makerRows = await tx.query<OrderRow>(
    `SELECT ${orderColumns} FROM economy.spot_order AS resting
     WHERE book_id = $1 AND instrument_id = $2 AND status = 'resting' AND ${priority} LIMIT $3`,
    [ledgerBookId, id, SPOT_MATCH_WINDOW_LIMIT],
  );
  return [orderOf(taker, policyVersion), makerRows.rows.map((row) => orderOf(row, policyVersion))];
}

async function writeBook(tx: Query, book: SpotBook): Promise<void> {
  await tx.query(
    `UPDATE economy.spot_instrument SET revision = $3, matching_sequence = $4 WHERE book_id = $1 AND instrument_id = $2`,
    [
      book.instrument.ledgerBookId,
      book.instrument.id,
      book.revision.toString(),
      book.matchingSequence?.toString() ?? null,
    ],
  );
}

async function updateOrder(tx: Query, bookId: string, order: SpotOrder): Promise<void> {
  await tx.query(
    `UPDATE economy.spot_order SET remaining_lots = $4, status = $5 WHERE book_id = $1 AND instrument_id = $2 AND order_id = $3`,
    [bookId, order.instrumentId, order.orderId, order.remainingLots.toString(), order.status],
  );
}

async function insertFill(tx: Query, fill: SpotFill): Promise<void> {
  await tx.query(
    `INSERT INTO economy.spot_fill (book_id, fill_id, instrument_id, maker_order_id, taker_order_id, buyer_id, seller_id,
       buyer_hold_id, seller_hold_id, lots, price, base_units, quote_units, buyer_fee_units, seller_fee_units)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)`,
    [
      fill.ledgerBookId,
      fill.id,
      fill.instrumentId,
      fill.makerOrderId,
      fill.takerOrderId,
      fill.buyer.accountId,
      fill.seller.accountId,
      fill.buyer.reservationId,
      fill.seller.reservationId,
      fill.lots.toString(),
      fill.price.toString(),
      fill.baseUnits.toString(),
      fill.quoteUnits.toString(),
      fill.buyerFeeUnits.toString(),
      fill.sellerFeeUnits.toString(),
    ],
  );
}

function releaseFunds(ledger: EconomyLedger, release: SpotRelease) {
  return ledger.releaseAmount({
    accountId: release.accountId,
    assetId: release.assetId,
    holdId: release.reservationId,
    operationId: release.id,
    amount: release.units.toString(),
  });
}

function sortWalletKeys(a: { assetId: string; accountId: string }, b: { assetId: string; accountId: string }): number {
  if (a.assetId !== b.assetId) return a.assetId < b.assetId ? -1 : 1;
  return a.accountId === b.accountId ? 0 : a.accountId < b.accountId ? -1 : 1;
}

async function save<T>(tx: Query, work: () => Promise<Result<T>>): Promise<Result<T>> {
  await tx.query('SAVEPOINT economy_spot_book');
  const result = await work();
  if (result.kind !== 'ok') await tx.query('ROLLBACK TO SAVEPOINT economy_spot_book');
  await tx.query('RELEASE SAVEPOINT economy_spot_book');
  return result;
}

/** Private owner port. All ledger calls participate in the book's native transaction. */
export function createSpotStore(database: EconomyDatabase, bookId: string) {
  if (!key.test(bookId)) throw new TypeError('Invalid Economy spot book ID');

  async function run<T>(
    operation: 'transaction' | 'read',
    work: (tx: Query) => Promise<Result<T>>,
  ): Promise<Result<T>> {
    const result = await database[operation](async (tx) => ok(await work(tx)));
    return result.kind === 'ok' ? result.value : result;
  }

  function ledgerOn(tx: Query): EconomyLedger {
    return createEconomyLedger({ transaction: (work) => work(tx), read: (work) => work(tx) }, bookId);
  }

  return {
    provision(terms: Terms): Promise<Result<SpotBook>> {
      const { feeAccountId: rawFeeAccountId, ...policy } = terms;
      const feeAccountId = accountId(rawFeeAccountId);
      if (feeAccountId === null || policy.ledgerBookId !== bookId || openSpotBook(policy).kind !== 'ok')
        return Promise.resolve(failure('invalid_instrument'));
      return run('transaction', async (tx) => {
        const assets = await tx.query(
          'SELECT asset_id FROM economy.asset WHERE book_id = $1 AND asset_id = ANY($2::text[]) AND transferable',
          [bookId, [policy.baseAssetId, policy.quoteAssetId]],
        );
        if (assets.rowCount !== 2) return failure('invalid_instrument');
        await tx.query(
          `INSERT INTO economy.spot_instrument (book_id, instrument_id, policy_version, base_asset_id, quote_asset_id,
             base_units_per_lot, quote_units_per_price_tick, maker_fee_bps, taker_fee_bps, fee_account_id)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) ON CONFLICT DO NOTHING`,
          [
            bookId,
            policy.id,
            policy.policyVersion.toString(),
            policy.baseAssetId,
            policy.quoteAssetId,
            policy.baseUnitsPerLot.toString(),
            policy.quoteUnitsPerPriceTick.toString(),
            policy.makerFeeBps.toString(),
            policy.takerFeeBps.toString(),
            feeAccountId,
          ],
        );
        const installed = await readInstrument(tx, bookId, policy.id);
        if (!installed) throw new Error('Provisioned Economy spot book is missing');
        const prior = installed.book.instrument;
        return installed.feeAccountId === feeAccountId &&
          prior.policyVersion === policy.policyVersion &&
          prior.baseAssetId === policy.baseAssetId &&
          prior.quoteAssetId === policy.quoteAssetId &&
          prior.baseUnitsPerLot === policy.baseUnitsPerLot &&
          prior.quoteUnitsPerPriceTick === policy.quoteUnitsPerPriceTick &&
          prior.makerFeeBps === policy.makerFeeBps &&
          prior.takerFeeBps === policy.takerFeeBps
          ? ok(installed.book)
          : failure('operation_conflict');
      });
    },

    readBook(instrumentId: string): Promise<Result<SpotBook>> {
      return run('read', async (tx) => {
        const instrument = key.test(instrumentId) ? await readInstrument(tx, bookId, instrumentId) : null;
        return instrument ? ok(instrument.book) : failure('not_found');
      });
    },

    readOwnOrder(instrumentId: string, orderId: string, owner: string): Promise<Result<SpotOrder>> {
      const ownerId = accountId(owner);
      return run('read', async (tx) => {
        if (!ownerId || !key.test(instrumentId) || !key.test(orderId)) return failure('not_found');
        const instrument = await readInstrument(tx, bookId, instrumentId);
        const order = instrument && (await readOrder(tx, instrument.book, orderId));
        return order && order.accountId === ownerId ? ok(order) : failure('not_found');
      });
    },

    place(instrumentId: string, input: SpotOrderRequest): Promise<Result<OrderReceipt>> {
      const ownerId = accountId(input.accountId);
      if (!ownerId || !key.test(instrumentId) || !key.test(input.orderId))
        return Promise.resolve(failure('invalid_order'));
      const request = { ...input, accountId: ownerId };
      return run('transaction', async (tx) => {
        const installed = await readInstrument(tx, bookId, instrumentId, true);
        if (!installed) return failure('not_found');
        const { book, feeAccountId } = installed;
        const prior = await readOrder(tx, book, request.orderId);
        if (prior)
          return prior.accountId === ownerId &&
            prior.side === request.side &&
            prior.price === request.price &&
            prior.lots === request.lots
            ? ok({ orderId: prior.orderId, sequence: prior.sequence })
            : failure('operation_conflict');
        if (book.revision >= maximumRevision || feeAccountId === ownerId) return failure('invalid_order');
        if (book.matchingSequence !== null) return failure('book_busy');
        const required = quoteSpotReservation(book.instrument, request);
        if (required.kind !== 'ok') return required;
        // A continuation always consumes a lot. Preserve room to finish every accepted order.
        if (request.lots >= maximumRevision - book.revision) return failure('invalid_order');
        const { assetId, units } = required.value;
        const reservationId = randomUUID();
        const accepted = acceptSpotOrder(book, book.revision, request, {
          reservationId,
          ledgerBookId: bookId,
          instrumentId,
          policyVersion: book.instrument.policyVersion,
          accountId: ownerId,
          orderId: request.orderId,
          assetId,
          units,
        });
        if (accepted.kind !== 'ok') return accepted;
        const order = accepted.value.order;
        return save(tx, async () => {
          const reserved = await ledgerOn(tx).reserve({
            accountId: ownerId,
            assetId,
            holdId: reservationId,
            operationId: `spot-v1/${instrumentId}/${order.sequence}/reserve`,
            amount: units.toString(),
            expiresAt: orderExpiry,
          });
          if (reserved.kind !== 'ok') return reserved;
          await tx.query(
            `INSERT INTO economy.spot_order (book_id, instrument_id, order_id, account_id, sequence, side, price, lots, remaining_lots,
              status, reservation_id, reserved_units_per_lot) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $8, 'matching', $9, $10)`,
            [
              bookId,
              instrumentId,
              order.orderId,
              ownerId,
              order.sequence.toString(),
              order.side,
              order.price.toString(),
              order.lots.toString(),
              reservationId,
              order.reservedUnitsPerLot.toString(),
            ],
          );
          await writeBook(tx, accepted.value.book);
          return ok({ orderId: order.orderId, sequence: order.sequence });
        });
      });
    },

    readyMatches(after?: string): Promise<Result<Readonly<{ instrumentId: string; revision: bigint }>[]>> {
      if (after !== undefined && !key.test(after)) return Promise.resolve(failure('invalid_operation'));
      return run('read', async (tx) => {
        const { rows } = await tx.query<{ instrumentId: string; revision: string }>(
          `SELECT instrument_id AS "instrumentId", revision::text FROM economy.spot_instrument
           WHERE book_id = $1 AND instrument_id > $2 AND matching_sequence IS NOT NULL ORDER BY instrument_id LIMIT $3`,
          [bookId, after ?? '', readyLimit],
        );
        return ok(rows.map((row) => ({ ...row, revision: BigInt(row.revision) })));
      });
    },

    match(instrumentId: string, expectedRevision: bigint): Promise<Result<MatchReceipt>> {
      if (!key.test(instrumentId) || expectedRevision < 0n || expectedRevision >= maximumRevision)
        return Promise.resolve(failure('invalid_operation'));
      return run('transaction', async (tx) => {
        const installed = await readInstrument(tx, bookId, instrumentId, true);
        if (!installed) return failure('not_found');
        const { book } = installed;
        const prior = await tx.query<Omit<MatchReceipt, 'revision'>>(
          `SELECT order_id AS "orderId", status, fill_ids AS "fillIds" FROM economy.spot_match_step
           WHERE book_id = $1 AND instrument_id = $2 AND from_revision = $3`,
          [bookId, instrumentId, expectedRevision.toString()],
        );
        if (prior.rows[0]) return ok({ ...prior.rows[0], revision: expectedRevision + 1n });
        if (book.revision !== expectedRevision) return failure('stale_book');
        if (book.matchingSequence === null) return failure('idle');
        const [taker, makers] = await matchOrders(tx, book);
        const result = matchSpotOrder(book, expectedRevision, taker, makers);
        if (result.kind !== 'ok') return result;
        const { order, book: next, fills, releases } = result.value;
        return save(tx, async () => {
          const ledger = ledgerOn(tx);
          const allocations = fills
            .flatMap((fill) =>
              [fill.buyer, fill.seller].map((party) => ({
                accountId: party.accountId,
                assetId: party.allocatedAssetId,
                holdId: party.reservationId,
                reference: fill.id,
                operationId: `${fill.id}/protect`,
                amount: party.allocatedUnits.toString(),
              })),
            )
            .sort(sortWalletKeys);
          for (const allocation of allocations) {
            const protectedLeg = await ledger.allocate({ ...allocation, purpose: 'spot_fill' });
            if (protectedLeg.kind !== 'ok') return protectedLeg;
          }
          for (const release of [...releases].sort(sortWalletKeys)) {
            const released = await releaseFunds(ledger, release);
            if (released.kind !== 'ok') return released;
          }
          await updateOrder(tx, bookId, order);
          for (const maker of result.value.makers) await updateOrder(tx, bookId, maker);
          for (const fill of fills) await insertFill(tx, fill);
          await writeBook(tx, next);
          const receipt = {
            revision: next.revision,
            orderId: order.orderId,
            status: order.status,
            fillIds: fills.map((fill) => fill.id),
          };
          await tx.query(
            `INSERT INTO economy.spot_match_step (book_id, instrument_id, from_revision, order_id, status, fill_ids)
             VALUES ($1, $2, $3, $4, $5, $6)`,
            [bookId, instrumentId, expectedRevision.toString(), receipt.orderId, receipt.status, receipt.fillIds],
          );
          return ok(receipt);
        });
      });
    },

    cancel(instrumentId: string, orderId: string, owner: string): Promise<Result<OrderReceipt>> {
      const ownerId = accountId(owner);
      if (!ownerId || !key.test(instrumentId) || !key.test(orderId)) return Promise.resolve(failure('not_found'));
      return run('transaction', async (tx) => {
        const installed = await readInstrument(tx, bookId, instrumentId, true);
        if (!installed) return failure('not_found');
        const { book } = installed;
        const order = await readOrder(tx, book, orderId);
        if (!order || order.accountId !== ownerId) return failure('not_found');
        const receipt = { orderId, sequence: order.sequence };
        if (order.status === 'cancelled') return ok(receipt);
        if (book.revision >= maximumRevision) return failure('invalid_order');
        const cancelled = cancelSpotOrder(book, book.revision, order, ownerId);
        if (cancelled.kind !== 'ok') return cancelled;
        return save(tx, async () => {
          const released = await releaseFunds(ledgerOn(tx), cancelled.value.release);
          if (released.kind !== 'ok') return released;
          await updateOrder(tx, bookId, cancelled.value.order);
          await writeBook(tx, cancelled.value.book);
          return ok(receipt);
        });
      });
    },

    readyFills(): Promise<Result<string[]>> {
      return run('read', async (tx) => {
        const { rows } = await tx.query<{ id: string }>(
          `SELECT fill_id AS id FROM economy.spot_fill WHERE book_id = $1 AND settled_at IS NULL
           AND due_at <= statement_timestamp() ORDER BY due_at, fill_id LIMIT $2`,
          [bookId, readyLimit],
        );
        return ok(rows.map((row) => row.id));
      });
    },

    claimFill(fillId: string): Promise<Result<Claim>> {
      if (!validFillId(fillId)) return Promise.resolve(failure('not_found'));
      return run('transaction', async (tx) => {
        const token = randomUUID();
        const { rows } = await tx.query<{ until: Date }>(
          `UPDATE economy.spot_fill SET claim_id = $3, due_at = clock_timestamp() + $4 * interval '1 second'
           WHERE book_id = $1 AND fill_id = $2 AND settled_at IS NULL AND due_at <= clock_timestamp() RETURNING due_at AS until`,
          [bookId, fillId, token, leaseSeconds],
        );
        return rows[0] ? ok({ fillId, token, until: rows[0].until.toISOString() }) : failure('idle');
      });
    },

    settleFill(fillId: string, token: string): Promise<Result<Readonly<{ operationId: string }>>> {
      if (!validFillId(fillId) || !uuid.test(token)) return Promise.resolve(failure('invalid_operation'));
      return run('transaction', async (tx) => {
        const { rows } = await tx.query<FillRow>(
          `SELECT fill.fill_id AS "fillId", fill.instrument_id AS "instrumentId", instrument.policy_version::text AS "policyVersion",
             fill.buyer_id::text AS "buyerId", fill.seller_id::text AS "sellerId", fill.buyer_hold_id::text AS "buyerHoldId",
             fill.seller_hold_id::text AS "sellerHoldId", instrument.base_asset_id AS "baseAssetId",
             instrument.quote_asset_id AS "quoteAssetId", fill.base_units::text AS "baseUnits", fill.quote_units::text AS "quoteUnits",
             fill.buyer_fee_units::text AS "buyerFeeUnits", fill.seller_fee_units::text AS "sellerFeeUnits",
             instrument.fee_account_id::text AS "feeAccountId", fill.claim_id::text AS token, fill.due_at AS "dueAt",
             fill.settled_at AS "settledAt"
           FROM economy.spot_fill AS fill JOIN economy.spot_instrument AS instrument USING (book_id, instrument_id)
           WHERE fill.book_id = $1 AND fill.fill_id = $2 FOR UPDATE OF fill`,
          [bookId, fillId],
        );
        const fill = rows[0];
        if (!fill) return failure('not_found');
        if (fill.token !== token.toLowerCase()) return failure('stale_claim');
        if (fill.settledAt !== null) return ok({ operationId: fillId });
        const clock = await tx.query<{ now: Date }>('SELECT clock_timestamp() AS now');
        if (fill.dueAt <= clock.rows[0]!.now) return failure('stale_claim');
        return save(tx, async () => {
          const result = await ledgerOn(tx).settleSpotFill(fill);
          if (result.kind !== 'ok') return result;
          await tx.query(
            'UPDATE economy.spot_fill SET settled_at = clock_timestamp() WHERE book_id = $1 AND fill_id = $2',
            [bookId, fillId],
          );
          return result;
        });
      });
    },
  };
}
