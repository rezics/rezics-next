import { t } from 'elysia';
import type { Pool } from 'pg';
import { throwAccessUnavailable } from '../access/unavailable.ts';
import { withBoundedReadConnection } from '../database/pool.ts';
import type { createApp } from '../http/app.ts';
import { ProblemError, problemSchema } from '../http/problem.ts';
import { IDEMPOTENCY_HEADER, idempotencyKeyOf, type Admission, type JobContext } from '../http/request.ts';
import { AuthenticationError, type AccessCheck, type Actor, type Resource } from '../request/access.ts';
import { routeOf } from '../route/route.ts';
import { decodeListCursor, encodeListCursor, type ListCursorBinding } from '../tokens/list-cursor.ts';
import type { KeyRing } from '../tokens/seal.ts';

type MarketScope = {
  actor: Actor;
  authorize(resource: Resource): Promise<AccessCheck>;
  admission: Admission;
  job: JobContext;
};
type Request = Readonly<{ accountId: string; deadline: number }>;
type Command = Request & Readonly<{ operationId: string }>;
type PrivateListing = Readonly<{
  listingId: string;
  itemId: string;
  generation: string;
  assetId: string;
  amount: string;
  expiresAt: string;
  revision: string;
  status: 'open' | 'cancelled' | 'purchased';
}>;
type PrivateTrade = Readonly<{
  tradeId: string;
  listingId: string;
  status: 'preparing' | 'committing' | 'aborting' | 'completed' | 'aborted';
  assetId: string;
  amount: string;
  fee: string;
  sellerNet: string;
}>;
type MarketTradePosition = readonly [startedAt: string, tradeId: string];
type ListedTrade = PrivateTrade & Readonly<{ startedAt: string }>;

/** The mounted transport accepts a caller identity. The native port proves it again before each owner operation. */
export interface EconomyMarketPort {
  readonly bookId: string;
  readonly itemHomeId: string;
  readListing(input: Request & { listingId: string }): Promise<PrivateListing>;
  readTrade(input: Request & { tradeId: string }): Promise<PrivateTrade>;
  listTrades(
    input: Request & { limit: number; after: MarketTradePosition | null },
  ): Promise<{ trades: ListedTrade[]; after: MarketTradePosition | null }>;
  createListing(
    input: Command & { itemId: string; generation: string; assetId: string; amount: string },
  ): Promise<{ listingId: string }>;
  buy(input: Command & { listingId: string; revision: string }): Promise<{ tradeId: string }>;
  cancel(input: Command & { listingId: string; revision: string }): Promise<{ listingId: string }>;
}

const closed = { additionalProperties: false } as const;
const nativeId = t.String({ minLength: 1, maxLength: 64, pattern: '^[A-Za-z0-9][A-Za-z0-9._:-]*$' });
const marketId = t.String({ minLength: 64, maxLength: 64, pattern: '^[0-9a-f]+$' });
const amount = t.String({ maxLength: 19, pattern: '^(?:0|[1-9][0-9]*)$' });
const positive = t.String({ maxLength: 19, pattern: '^[1-9][0-9]*$' });
const listingParams = t.Object({ listingId: marketId }, closed);
const listingReceipt = t.Object({ listingId: marketId }, closed);
const revisionRequest = t.Object({ revision: amount }, closed);
const listing = t.Object(
  {
    listingId: marketId,
    itemId: nativeId,
    generation: positive,
    assetId: nativeId,
    amount: positive,
    expiresAt: positive,
    revision: amount,
    status: t.Union([t.Literal('open'), t.Literal('cancelled'), t.Literal('purchased')]),
  },
  closed,
);
const tradeFields = {
  tradeId: marketId,
  listingId: marketId,
  assetId: nativeId,
  amount: positive,
  fee: amount,
  sellerNet: amount,
  status: t.Union([
    t.Literal('preparing'),
    t.Literal('committing'),
    t.Literal('aborting'),
    t.Literal('completed'),
    t.Literal('aborted'),
  ]),
};
const trade = t.Object(tradeFields, closed);
const tradesPath = '/v1/economy/market/trades';
const maxPage = 100;
const cursor = t.String({ minLength: 1, maxLength: 4096 });
const tradePage = t.Object(
  {
    trades: t.Array(t.Object({ ...tradeFields, startedAt: amount }, closed), { maxItems: maxPage }),
    next: t.Union([cursor, t.Null()]),
  },
  closed,
);

function isTradePosition(value: readonly (string | number)[]): value is MarketTradePosition {
  const [startedAt, tradeId] = value;
  return (
    value.length === 2 &&
    typeof startedAt === 'string' &&
    /^(0|[1-9][0-9]{0,18})$/.test(startedAt) &&
    BigInt(startedAt) <= (1n << 63n) - 1n &&
    typeof tradeId === 'string' &&
    /^[0-9a-f]{64}$/.test(tradeId)
  );
}

function detail(operation: string, action: 'market:read' | 'market:list' | 'market:buy' | 'market:cancel') {
  return {
    operationId: operation,
    'x-exposure': 'gate:economy',
    'x-action': action,
    'x-authority-anchor': 'own-account',
    'x-authority-resource-types': ['access.account'],
    security: [{ bearerAuth: [] }],
  };
}

function failures() {
  return {
    400: problemSchema('invalid_request'),
    401: problemSchema('authentication_required', 'invalid_credentials'),
    403: problemSchema('forbidden', 'platform_closed', 'account_suspended'),
    404: problemSchema('not_found'),
    409: problemSchema('conflict'),
    422: problemSchema('idempotency_conflict'),
    429: problemSchema('rate_limited'),
    503: problemSchema('dependency_unavailable', 'deadline_exceeded', 'overloaded', 'partition_unavailable'),
  };
}

export function economyMarketRoutes(
  app: ReturnType<typeof createApp>,
  deps: { pool: Pool; cursorKeys: KeyRing; clock: () => Date; market?: EconomyMarketPort },
) {
  const headers = t.Object({ [IDEMPOTENCY_HEADER]: t.String() });
  async function run<Value>(ctx: MarketScope, work: (port: EconomyMarketPort, request: Request) => Promise<Value>) {
    const { actor, authorize, admission, job } = ctx;
    if (actor.kind !== 'account') throw new AuthenticationError(401, 'Bearer');
    const route = routeOf(actor.accountId);
    if (route === null) throw new ProblemError('forbidden');
    try {
      const check = await authorize({ route, id: actor.accountId });
      return await admission.run('normal', job, async () => {
        if (!(await withBoundedReadConnection(deps.pool, job.deadline, check))) throw new ProblemError('forbidden');
        if (!deps.market) throw new ProblemError('dependency_unavailable');
        return work(deps.market, { accountId: actor.accountId, deadline: job.deadline });
      });
    } catch (error) {
      throwAccessUnavailable(error, job.deadline);
      throw error;
    }
  }

  return app
    .post(
      '/v1/economy/market/listings',
      {
        headers,
        body: t.Object({ itemId: nativeId, generation: positive, assetId: nativeId, amount: positive }, closed),
        response: { 200: listingReceipt, ...failures() },
        detail: detail('market.list', 'market:list'),
      },
      async (ctx) => {
        ctx.set.headers['cache-control'] = 'private, no-store';
        return run(ctx, (port, request) =>
          port.createListing({
            ...request,
            ...ctx.body,
            operationId: idempotencyKeyOf(ctx.headers[IDEMPOTENCY_HEADER]),
          }),
        );
      },
    )
    .get(
      '/v1/economy/market/listings/:listingId',
      {
        params: listingParams,
        response: { 200: listing, ...failures() },
        detail: detail('market.read_listing', 'market:read'),
      },
      async (ctx) => {
        ctx.set.headers['cache-control'] = 'private, no-store';
        return run(ctx, (port, request) => port.readListing({ ...request, listingId: ctx.params.listingId }));
      },
    )
    .post(
      '/v1/economy/market/listings/:listingId/purchases',
      {
        headers,
        params: listingParams,
        body: revisionRequest,
        response: { 200: t.Object({ tradeId: marketId }, closed), ...failures() },
        detail: detail('market.buy', 'market:buy'),
      },
      async (ctx) => {
        ctx.set.headers['cache-control'] = 'private, no-store';
        return run(ctx, (port, request) =>
          port.buy({
            ...request,
            ...ctx.body,
            listingId: ctx.params.listingId,
            operationId: idempotencyKeyOf(ctx.headers[IDEMPOTENCY_HEADER]),
          }),
        );
      },
    )
    .post(
      '/v1/economy/market/listings/:listingId/cancel',
      {
        headers,
        params: listingParams,
        body: revisionRequest,
        response: { 200: listingReceipt, ...failures() },
        detail: detail('market.cancel', 'market:cancel'),
      },
      async (ctx) => {
        ctx.set.headers['cache-control'] = 'private, no-store';
        return run(ctx, (port, request) =>
          port.cancel({
            ...request,
            ...ctx.body,
            listingId: ctx.params.listingId,
            operationId: idempotencyKeyOf(ctx.headers[IDEMPOTENCY_HEADER]),
          }),
        );
      },
    )
    .get(
      tradesPath,
      {
        query: t.Object(
          {
            limit: t.Optional(t.Numeric({ minimum: 1, maximum: maxPage, multipleOf: 1 })),
            cursor: t.Optional(cursor),
          },
          closed,
        ),
        response: { 200: tradePage, ...failures(), 400: problemSchema('invalid_request', 'invalid_cursor') },
        detail: detail('market.read_trades', 'market:read'),
      },
      async (ctx) => {
        ctx.set.headers['cache-control'] = 'private, no-store';
        return run(ctx, async (port, request) => {
          const limit = ctx.query.limit ?? 20;
          const binding: ListCursorBinding = {
            route: `GET ${tradesPath}`,
            viewer: request.accountId.toLowerCase(),
            query: { bookId: port.bookId, itemHomeId: port.itemHomeId, limit },
          };
          const at = deps.clock();
          let after: MarketTradePosition | null = null;
          if (ctx.query.cursor !== undefined) {
            const decoded = await decodeListCursor(deps.cursorKeys, binding, ctx.query.cursor, at);
            if (!decoded.ok || decoded.epoch !== 1 || !isTradePosition(decoded.after))
              throw new ProblemError('invalid_cursor');
            after = decoded.after;
          }
          const page = await port.listTrades({ ...request, limit, after });
          return {
            trades: page.trades,
            next:
              page.after === null
                ? null
                : await encodeListCursor(deps.cursorKeys, binding, { epoch: 1, after: page.after }, at),
          };
        });
      },
    )
    .get(
      '/v1/economy/market/trades/:tradeId',
      {
        params: t.Object({ tradeId: marketId }, closed),
        response: { 200: trade, ...failures() },
        detail: detail('market.read_trade', 'market:read'),
      },
      async (ctx) => {
        ctx.set.headers['cache-control'] = 'private, no-store';
        return run(ctx, (port, request) => port.readTrade({ ...request, tradeId: ctx.params.tradeId }));
      },
    );
}
