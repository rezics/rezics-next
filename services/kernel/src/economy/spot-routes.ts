import { createHash } from 'node:crypto';
import { t } from 'elysia';
import type { Pool } from 'pg';
import { throwAccessUnavailable } from '../access/unavailable.ts';
import { withBoundedReadConnection } from '../database/pool.ts';
import type { createApp } from '../http/app.ts';
import { ProblemError, problemSchema } from '../http/problem.ts';
import { IDEMPOTENCY_HEADER, idempotencyKeyOf, type Admission, type JobContext } from '../http/request.ts';
import { AuthenticationError, type AccessCheck, type Actor, type Resource } from '../request/access.ts';
import { routeOf } from '../route/route.ts';
import {
  decodeListCursor,
  encodeListCursor,
  LIST_CURSOR_BOUNDS,
  type ListCursorBinding,
} from '../tokens/list-cursor.ts';
import type { KeyRing } from '../tokens/seal.ts';
import {
  isSpotTradePosition,
  SPOT_TRADE_PAGE_LIMIT,
  type EconomyFailure,
  type SpotTradePage,
  type SpotTradePosition,
} from './contract.ts';
import type { SpotBook, SpotOrder, SpotOrderTerms, matchSpotOrder } from './exchange/order-book.ts';

type CoreFailure = Exclude<ReturnType<typeof matchSpotOrder>['kind'], 'ok'>;
export type SpotAccessResult<T> =
  | Readonly<{ kind: 'ok'; value: T }>
  | Readonly<{ kind: EconomyFailure | CoreFailure | 'not_found' | 'idle' | 'stale_claim' }>;
type RequestScope = Readonly<{ accountId: string; instrumentId: string; deadline: number }>;
type OrderScope = RequestScope & Readonly<{ orderId: string }>;
type OrderReceipt = Readonly<{ orderId: string; sequence: bigint }>;
export interface SpotAccessPort {
  readonly bookId: string;
  readInstrument(input: RequestScope): Promise<SpotAccessResult<SpotBook>>;
  readTrades(
    input: RequestScope & Readonly<{ limit: number; after: SpotTradePosition | null }>,
  ): Promise<SpotAccessResult<SpotTradePage>>;
  readOrder(input: OrderScope): Promise<SpotAccessResult<SpotOrder>>;
  place(input: OrderScope & SpotOrderTerms): Promise<SpotAccessResult<OrderReceipt>>;
  cancel(input: OrderScope): Promise<SpotAccessResult<OrderReceipt>>;
}

type ActorContext = {
  actor: Actor;
  authorize(resource: Resource): Promise<AccessCheck>;
  admission: Admission;
  job: JobContext;
};

const closed = { additionalProperties: false } as const;
const key = t.String({ pattern: '^[a-zA-Z0-9_-]{1,64}$' });
const unsigned = t.String({ maxLength: 19, pattern: '^(?:0|[1-9][0-9]*)$' });
const positive = t.String({ maxLength: 19, pattern: '^[1-9][0-9]*$' });
const side = t.Union([t.Literal('buy'), t.Literal('sell')]);
const state = t.Union([t.Literal('matching'), t.Literal('resting'), t.Literal('filled'), t.Literal('cancelled')]);
const instrumentParams = t.Object({ instrumentId: key }, closed);
const orderParams = t.Object({ instrumentId: key, orderId: key }, closed);
const instrumentSchema = t.Object(
  {
    instrumentId: key,
    baseAssetId: key,
    quoteAssetId: key,
    policyVersion: positive,
    baseUnitsPerLot: positive,
    quoteUnitsPerPriceTick: positive,
    makerFeeBps: unsigned,
    takerFeeBps: unsigned,
    revision: unsigned,
  },
  closed,
);
const tradesPath = '/v1/economy/spot/:instrumentId/trades';
const receiptSchema = t.Object({ orderId: key, sequence: positive }, closed);
const orderSchema = t.Object(
  {
    instrumentId: key,
    policyVersion: positive,
    orderId: key,
    sequence: positive,
    side,
    price: positive,
    lots: positive,
    remainingLots: unsigned,
    status: state,
  },
  closed,
);

function detail(operationId: string, action: 'spot:read' | 'spot:place' | 'spot:cancel') {
  return {
    operationId,
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

function valueOf<T>(result: SpotAccessResult<T>): T {
  switch (result.kind) {
    case 'ok':
      return result.value;
    case 'asset_missing':
    case 'not_found':
      throw new ProblemError('not_found');
    case 'operation_conflict':
      throw new ProblemError('idempotency_conflict');
    case 'insufficient_funds':
      throw new ProblemError('conflict', { detail: 'Insufficient available balance.' });
    case 'book_busy':
      throw new ProblemError('conflict', { detail: 'The instrument has an order awaiting matching.' });
    case 'invalid_order':
    case 'invalid_instrument':
    case 'invalid_amount':
    case 'invalid_operation':
      throw new ProblemError('invalid_request');
    case 'asset_not_transferable':
    case 'hold_closed':
      throw new ProblemError('conflict');
    default:
      throw new ProblemError('dependency_unavailable');
  }
}

async function requireActor(pool: Pool, { actor, authorize, job, admission }: ActorContext): Promise<string> {
  if (actor.kind !== 'account') throw new AuthenticationError(401, 'Bearer');
  const route = routeOf(actor.accountId);
  if (route === null) throw new ProblemError('forbidden');
  try {
    const check = await authorize({ route, id: actor.accountId });
    const permitted = await admission.run('normal', job, () => withBoundedReadConnection(pool, job.deadline, check));
    if (!permitted) throw new ProblemError('forbidden');
    return actor.accountId;
  } catch (error) {
    throwAccessUnavailable(error, job.deadline);
    throw error;
  }
}

function instrumentView(book: SpotBook) {
  const policy = book.instrument;
  return {
    instrumentId: policy.id,
    baseAssetId: policy.baseAssetId,
    quoteAssetId: policy.quoteAssetId,
    policyVersion: policy.policyVersion.toString(),
    baseUnitsPerLot: policy.baseUnitsPerLot.toString(),
    quoteUnitsPerPriceTick: policy.quoteUnitsPerPriceTick.toString(),
    makerFeeBps: policy.makerFeeBps.toString(),
    takerFeeBps: policy.takerFeeBps.toString(),
    revision: book.revision.toString(),
  };
}

function receiptView(receipt: OrderReceipt) {
  return { orderId: receipt.orderId, sequence: receipt.sequence.toString() };
}

function orderView(order: SpotOrder) {
  return {
    ...receiptView(order),
    instrumentId: order.instrumentId,
    policyVersion: order.policyVersion.toString(),
    side: order.side,
    price: order.price.toString(),
    lots: order.lots.toString(),
    remainingLots: order.remainingLots.toString(),
    status: order.status,
  };
}

function deriveOrderId(accountId: string, instrumentId: string, operationId: string): string {
  return createHash('sha256')
    .update(JSON.stringify(['economy-spot-order-v1', accountId.toLowerCase(), instrumentId, operationId]))
    .digest('hex');
}

export function economySpotRoutes(
  app: ReturnType<typeof createApp>,
  deps: { pool: Pool; spot?: SpotAccessPort; cursorKeys: KeyRing; clock: () => Date },
) {
  const cursor = t.String({ minLength: 1, maxLength: LIST_CURSOR_BOUNDS.default.maxTokenLength });
  const tradesSchema = t.Object(
    {
      trades: t.Array(
        t.Object(
          {
            price: positive,
            lots: positive,
            baseUnits: positive,
            quoteUnits: positive,
            settledAt: t.String({ format: 'date-time' }),
          },
          closed,
        ),
        { maxItems: SPOT_TRADE_PAGE_LIMIT },
      ),
      next: t.Union([cursor, t.Null()]),
    },
    closed,
  );

  async function privateCall<T>(
    ctx: ActorContext,
    instrumentId: string,
    work: (port: SpotAccessPort, scope: RequestScope) => Promise<T>,
  ) {
    const accountId = await requireActor(deps.pool, ctx);
    return ctx.admission.run('normal', ctx.job, () => {
      if (!deps.spot) throw new ProblemError('dependency_unavailable');
      return work(deps.spot, { accountId, instrumentId, deadline: ctx.job.deadline });
    });
  }
  return app
    .get(
      '/v1/economy/spot/:instrumentId',
      {
        params: instrumentParams,
        response: { 200: instrumentSchema, ...failures() },
        detail: detail('spot.read_instrument', 'spot:read'),
      },
      async (ctx) => {
        ctx.set.headers['cache-control'] = 'private, no-store';
        return privateCall(ctx, ctx.params.instrumentId, async (spot, scope) =>
          instrumentView(valueOf(await spot.readInstrument(scope))),
        );
      },
    )
    .get(
      tradesPath,
      {
        params: instrumentParams,
        query: t.Object(
          {
            limit: t.Optional(t.Numeric({ minimum: 1, maximum: SPOT_TRADE_PAGE_LIMIT, multipleOf: 1 })),
            cursor: t.Optional(cursor),
          },
          closed,
        ),
        response: { 200: tradesSchema, ...failures(), 400: problemSchema('invalid_request', 'invalid_cursor') },
        detail: detail('spot.read_trades', 'spot:read'),
      },
      async (ctx) => {
        ctx.set.headers['cache-control'] = 'private, no-store';
        return privateCall(ctx, ctx.params.instrumentId, async (spot, scope) => {
          const limit = ctx.query.limit ?? 20;
          const at = deps.clock();
          const binding: ListCursorBinding = {
            route: `GET ${tradesPath}`,
            viewer: scope.accountId.toLowerCase(),
            query: { bookId: spot.bookId, instrumentId: scope.instrumentId, limit },
          };
          let after: SpotTradePosition | null = null;
          if (ctx.query.cursor !== undefined) {
            const decoded = await decodeListCursor(deps.cursorKeys, binding, ctx.query.cursor, at);
            if (!decoded.ok || decoded.epoch !== 1 || !isSpotTradePosition(decoded.after))
              throw new ProblemError('invalid_cursor');
            after = decoded.after;
          }
          const page = valueOf(await spot.readTrades({ ...scope, limit, after }));
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
      '/v1/economy/spot/:instrumentId/orders/:orderId',
      {
        params: orderParams,
        response: { 200: orderSchema, ...failures() },
        detail: detail('spot.read_order', 'spot:read'),
      },
      async (ctx) => {
        ctx.set.headers['cache-control'] = 'private, no-store';
        return privateCall(ctx, ctx.params.instrumentId, async (spot, scope) =>
          orderView(valueOf(await spot.readOrder({ ...scope, orderId: ctx.params.orderId }))),
        );
      },
    )
    .post(
      '/v1/economy/spot/:instrumentId/orders',
      {
        params: instrumentParams,
        headers: t.Object({ [IDEMPOTENCY_HEADER]: t.String() }),
        body: t.Object({ side, price: positive, lots: positive }, closed),
        response: { 200: receiptSchema, ...failures() },
        detail: detail('spot.place_order', 'spot:place'),
      },
      async (ctx) => {
        ctx.set.headers['cache-control'] = 'private, no-store';
        return privateCall(ctx, ctx.params.instrumentId, async (spot, scope) => {
          const idempotency = idempotencyKeyOf(ctx.headers[IDEMPOTENCY_HEADER]);
          const orderId = deriveOrderId(scope.accountId, scope.instrumentId, idempotency);
          const result = await spot.place({
            ...scope,
            orderId,
            side: ctx.body.side,
            price: BigInt(ctx.body.price),
            lots: BigInt(ctx.body.lots),
          });
          return receiptView(valueOf(result));
        });
      },
    )
    .post(
      '/v1/economy/spot/:instrumentId/orders/:orderId/cancel',
      {
        params: orderParams,
        response: { 200: receiptSchema, ...failures() },
        detail: detail('spot.cancel_order', 'spot:cancel'),
      },
      async (ctx) => {
        ctx.set.headers['cache-control'] = 'private, no-store';
        return privateCall(ctx, ctx.params.instrumentId, async (spot, scope) => {
          const result = await spot.cancel({ ...scope, orderId: ctx.params.orderId });
          if (result.kind === 'invalid_order')
            throw new ProblemError('conflict', { detail: 'The order cannot be cancelled.' });
          return receiptView(valueOf(result));
        });
      },
    );
}
