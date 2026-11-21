import { createHash } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { lockNativeEconomyAdmission } from '../access/index.ts';
import { ConfigError } from '../commerce/config.ts';
import { withBoundedCommandConnection, withBoundedReadConnection } from '../database/pool.ts';
import { isEconomyBookId } from '../economy/contract.ts';
import { createEconomyLedger } from '../economy/ledger.ts';
import type { EconomyMarketPort } from '../economy/market-routes.ts';
import { marketTradeStatus, type MarketListing, type MarketTrade } from '../economy/market/trade.ts';
import { createNativeMarket } from '../economy/storage/market-runner.ts';
import { ProblemError } from '../http/problem-error.ts';

const maxInt64 = (1n << 63n) - 1n;
const feeAccountPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const issuer = '00000000-0000-0000-0000-000000000000';
const listingTtl = 30n * 60_000n;
const preparationTtl = 2n * 60_000n;
const workBudget = 2_000;

type MarketConfig = Readonly<{ itemHomeId: string; feeAccountId: string; feeBps: bigint; policyVersion: bigint }>;
type NativeMarket = ReturnType<typeof createNativeMarket>;

type ActorRequest = Readonly<{ accountId: string; deadline: number }>;

function integer(input: string): bigint | null {
  if (!/^(0|[1-9][0-9]{0,18})$/.test(input)) return null;
  const value = BigInt(input);
  return value <= maxInt64 ? value : null;
}

function requireInteger(input: string, min: bigint): bigint {
  const value = integer(input);
  if (value === null || value < min) throw new ProblemError('invalid_request');
  return value;
}

function validFeeAccount(value: string): boolean {
  return feeAccountPattern.test(value) && value !== issuer;
}

export function readEconomyMarketConfig(env: NodeJS.ProcessEnv): MarketConfig | undefined {
  const itemHomeId = env.KERNEL_ECONOMY_MARKET_ITEM_HOME_ID;
  const feeAccountId = env.KERNEL_ECONOMY_MARKET_FEE_ACCOUNT_ID;
  const configuredFeeBps = env.KERNEL_ECONOMY_MARKET_FEE_BPS;
  const configuredPolicyVersion = env.KERNEL_ECONOMY_MARKET_POLICY_VERSION;
  if ([itemHomeId, feeAccountId, configuredFeeBps, configuredPolicyVersion].every((value) => value === undefined))
    return;
  if (itemHomeId === undefined || !isEconomyBookId(itemHomeId))
    throw new ConfigError('KERNEL_ECONOMY_MARKET_ITEM_HOME_ID');
  if (feeAccountId === undefined || !validFeeAccount(feeAccountId))
    throw new ConfigError('KERNEL_ECONOMY_MARKET_FEE_ACCOUNT_ID');
  const feeBps = integer(configuredFeeBps ?? '');
  if (feeBps === null || feeBps > 10_000n) throw new ConfigError('KERNEL_ECONOMY_MARKET_FEE_BPS');
  const policyVersion = integer(configuredPolicyVersion ?? '');
  if (policyVersion === null || policyVersion < 1n) throw new ConfigError('KERNEL_ECONOMY_MARKET_POLICY_VERSION');
  return { itemHomeId, feeAccountId, feeBps, policyVersion };
}

function transaction<Value>(pool: Pool, deadline: number, work: (client: PoolClient) => Promise<Value>) {
  return withBoundedCommandConnection(pool, deadline, async (client) => {
    await client.query('BEGIN');
    const result = await work(client);
    await client.query('COMMIT');
    return result;
  });
}

function fixedDatabase(client: PoolClient) {
  return {
    read: <Value>(work: (connection: PoolClient) => Promise<Value>) => work(client),
    transaction: <Value>(work: (connection: PoolClient) => Promise<Value>) => work(client),
  };
}

async function requireAdmission(client: PoolClient, node: string, accountId: string, recipientId?: string) {
  const result = await lockNativeEconomyAdmission(client, {
    node,
    accountId,
    ...(recipientId === undefined ? {} : { recipientId }),
  });
  if (result === 'unavailable') throw new ProblemError('dependency_unavailable');
  if (result === 'source_denied') throw new ProblemError('platform_closed');
  if (result === 'recipient_denied') throw new ProblemError('not_found');
}

function operationKey(
  bookId: string,
  kind: 'listing' | 'purchase' | 'cancel',
  accountId: string,
  operationId: string,
  listingId?: string,
) {
  return createHash('sha256')
    .update(JSON.stringify([bookId, kind, accountId, operationId, listingId]))
    .digest('hex');
}

async function fenceOperation(client: PoolClient, key: string) {
  await client.query(`SELECT pg_advisory_xact_lock(hashtextextended('private-market:' || $1::text, 0))`, [key]);
}

async function nativeNow(client: PoolClient): Promise<bigint> {
  const { rows } = await client.query<{ now: string }>(
    'SELECT floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint::text AS now',
  );
  return BigInt(rows[0]!.now);
}

function marketValue<Value>(result: { kind: 'ok'; value: Value } | { kind: string }): Value {
  if (result.kind === 'ok' && 'value' in result) return result.value;
  switch (result.kind) {
    case 'invalid_listing':
    case 'invalid_purchase':
    case 'invalid_request':
    case 'invalid_amount':
      throw new ProblemError('invalid_request');
    case 'not_found':
    case 'item_missing':
    case 'not_eligible':
    case 'asset_missing':
      throw new ProblemError('not_found');
    case 'conflict':
    case 'operation_conflict':
      throw new ProblemError('idempotency_conflict');
    case 'item_reserved':
    case 'asset_not_transferable':
    case 'insufficient_funds':
    case 'expired':
    case 'stale_revision':
    case 'listing_unavailable':
      throw new ProblemError('conflict');
    default:
      throw new ProblemError('dependency_unavailable');
  }
}

function visibleListing(listing: MarketListing, accountId: string): boolean {
  return (
    listing.status === 'open' ||
    listing.item.holderId === accountId ||
    (listing.status === 'purchased' && listing.buyer.buyerId === accountId)
  );
}

function listingView(listing: MarketListing) {
  return {
    listingId: listing.listingId,
    itemId: listing.item.itemId,
    generation: listing.item.generation.toString(),
    assetId: listing.price.assetId,
    amount: listing.price.units.toString(),
    expiresAt: listing.expiresAt.toString(),
    revision: listing.revision.toString(),
    status: listing.status,
  };
}

function tradeReceipt(trade: MarketTrade) {
  const { price } = trade.terms;
  return {
    tradeId: trade.buyer.tradeId,
    listingId: trade.terms.listingId,
    status: marketTradeStatus(trade),
    assetId: price.assetId,
    amount: price.units.toString(),
    fee: price.feeUnits.toString(),
    sellerNet: price.sellerUnits.toString(),
  };
}

/** Local request and owner-worker bindings remain separate. Each request first locks the current native account grant. */
export function createNativeEconomyMarket(pool: Pool, config: MarketConfig & { bookId: string; node: string }) {
  const { bookId, node, itemHomeId, feeAccountId, feeBps, policyVersion } = config;
  if (
    !node.trim() ||
    node.length > 255 ||
    !validFeeAccount(feeAccountId) ||
    feeBps < 0n ||
    feeBps > 10_000n ||
    policyVersion < 1n ||
    policyVersion > maxInt64
  )
    throw new TypeError('Invalid native market bindings');
  const runtime = createNativeMarket(
    {
      transaction: (work) => transaction(pool, Date.now() + workBudget, work),
      read: (work) => withBoundedReadConnection(pool, Date.now() + workBudget, work),
    },
    config,
  );

  function request<Value>(
    input: ActorRequest,
    work: (client: PoolClient, runtime: NativeMarket, accountId: string) => Promise<Value>,
  ) {
    const accountId = input.accountId.toLowerCase();
    return transaction(pool, input.deadline, async (client) => {
      await requireAdmission(client, node, accountId);
      return work(client, createNativeMarket(fixedDatabase(client), config), accountId);
    });
  }

  const port: EconomyMarketPort = {
    bookId,
    itemHomeId,
    readListing: (input) =>
      request(input, async (_, { market }, accountId) => {
        const listing = await market.readListing(input.listingId);
        if (!listing || !visibleListing(listing, accountId)) throw new ProblemError('not_found');
        return listingView(listing);
      }),
    listListings: (input) =>
      request(input, async (_, { market }) => {
        const { listings, more } = await market.readOpenListings({
          itemHomeId,
          limit: input.limit,
          after: input.after,
        });
        const page = listings.map(listingView);
        const last = page.at(-1);
        return { listings: page, after: more && last ? [last.expiresAt, last.listingId] : null };
      }),
    readTrade: (input) =>
      request(input, async (_, { market }, accountId) => {
        const trade = await market.readTrade(input.tradeId);
        if (!trade || (trade.buyer.buyerId !== accountId && trade.terms.item.holderId !== accountId))
          throw new ProblemError('not_found');
        return tradeReceipt(trade);
      }),
    listTrades: (input) =>
      request(input, async (_, { market }, accountId) => {
        const { trades, more } = await market.readParticipantTrades({
          accountId,
          itemHomeId,
          limit: input.limit,
          after: input.after,
        });
        const receipts = trades.map((trade) => ({
          ...tradeReceipt(trade),
          startedAt: trade.buyer.startedAt.toString(),
        }));
        const last = receipts.at(-1);
        return { trades: receipts, after: more && last ? [last.startedAt, last.tradeId] : null };
      }),
    createListing: (input) =>
      request(input, async (client, { market, item }, accountId) => {
        const units = requireInteger(input.amount, 1n);
        const generation = requireInteger(input.generation, 1n);
        const listingId = operationKey(bookId, 'listing', accountId, input.operationId);
        await fenceOperation(client, listingId);
        const retained = await market.readListing(listingId);
        if (retained) {
          if (
            retained.item.holderId !== accountId ||
            retained.item.itemId !== input.itemId ||
            retained.item.generation !== generation ||
            retained.price.assetId !== input.assetId ||
            retained.price.units !== units
          )
            throw new ProblemError('idempotency_conflict');
          return { listingId };
        }
        if (accountId === feeAccountId) throw new ProblemError('invalid_request');
        const ledger = createEconomyLedger(fixedDatabase(client), bookId);
        const balance = marketValue(await ledger.readBalance({ accountId, assetId: input.assetId }));
        if (!balance.asset.transferable) throw new ProblemError('conflict');
        const expiresAt = (await nativeNow(client)) + listingTtl;
        const claim = {
          itemId: input.itemId,
          homeId: itemHomeId,
          holderId: accountId,
          generation,
          reservationId: listingId,
        };
        marketValue(await item.reserveListing({ ...claim, bookId, listingId, protectedUntil: expiresAt }));
        return marketValue(
          await market.open({
            item: claim,
            listingId,
            expiresAt,
            price: { ledgerBookId: bookId, assetId: input.assetId, units, feeAccountId, feeBps, policyVersion },
          }),
        );
      }),
    buy: (input) =>
      request(input, async (client, { market }, accountId) => {
        const revision = requireInteger(input.revision, 0n);
        const tradeId = operationKey(bookId, 'purchase', accountId, input.operationId);
        await fenceOperation(client, tradeId);
        const listing = await market.readListing(input.listingId);
        if (!listing || !visibleListing(listing, accountId)) throw new ProblemError('not_found');
        if (
          listing.status === 'purchased' &&
          listing.buyer.tradeId === tradeId &&
          listing.buyer.buyerId === accountId
        ) {
          if (revision !== listing.revision - 1n) throw new ProblemError('idempotency_conflict');
          return { tradeId };
        }
        if (await market.readTrade(tradeId)) throw new ProblemError('idempotency_conflict');
        if (listing.status !== 'open' || listing.revision !== revision) throw new ProblemError('conflict');
        if (accountId === listing.item.holderId || accountId === listing.price.feeAccountId)
          throw new ProblemError('invalid_request');
        await requireAdmission(client, node, accountId, listing.item.holderId);
        const ledger = createEconomyLedger(fixedDatabase(client), bookId);
        const balance = marketValue(await ledger.readBalance({ accountId, assetId: listing.price.assetId }));
        if (!balance.asset.transferable || BigInt(balance.available) < listing.price.units)
          throw new ProblemError('conflict');
        const now = await nativeNow(client);
        if (now >= listing.expiresAt) throw new ProblemError('conflict');
        const prepareUntil = now + preparationTtl;
        return marketValue(
          await market.purchase(listing.listingId, revision, {
            tradeId,
            buyerId: accountId,
            prepareUntil: prepareUntil < listing.expiresAt ? prepareUntil : listing.expiresAt,
          }),
        );
      }),
    cancel: (input) =>
      request(input, async (client, { market }, accountId) => {
        const revision = requireInteger(input.revision, 0n);
        const operationId = operationKey(bookId, 'cancel', accountId, input.operationId, input.listingId);
        await fenceOperation(client, operationId);
        const listing = await market.readListing(input.listingId);
        if (!listing || listing.item.holderId !== accountId) throw new ProblemError('not_found');
        if (
          listing.status === 'cancelled' &&
          (operationId !== listing.operationId || revision !== listing.revision - 1n)
        )
          throw new ProblemError('idempotency_conflict');
        marketValue(await market.cancel(input.listingId, revision, accountId, operationId));
        return { listingId: input.listingId };
      }),
  };
  return { port, custody: runtime.item, sweep: runtime.sweep };
}
