import { t } from 'elysia';
import type { Pool } from 'pg';
import { GrantDeniedError } from '../access/grant-commands.ts';
import { readPartition } from '../partition/partition.ts';
import { withConnection } from '../database/pool.ts';
import type { createApp } from '../http/app.ts';
import type { definitionRoutes } from '../semantic/http/definitions.ts';
import { customMethod } from '../http/custom-method.ts';
import { ProblemError, problemSchema } from '../http/problem.ts';
import { IDEMPOTENCY_HEADER, idempotencyKeyOf } from '../http/request.ts';
import { AuthenticationError, type Access, type Actor } from '../request/access.ts';
import { partitionOf, routeOf } from '../route/route.ts';
import { decodeCursor, encodeCursor } from '../tokens/cursor.ts';
import type { KeyRing } from '../tokens/seal.ts';
import { checkout } from './checkout.ts';
import { createCommerceCommands, OfferUnavailableError } from './commands.ts';
import { StripeUnavailableError, type Entitlement, type Offer, type Order, type StripePort } from './model.ts';
import * as store from './store.ts';
import entitlementPage from './store-entitlement-list.sql';
import { stripeWebhookRoutes } from './webhook-routes.ts';
import type { CommerceWork } from './work-contract.ts';

export type CommerceDependencies = {
  stripe: StripePort;
  successUrl: string;
  cancelUrl: string;
  webhookSecrets: readonly string[];
  work: CommerceWork;
};

type Dependencies = {
  pool: Pool;
  tokens: KeyRing;
  access: () => Access;
  commerce?: CommerceDependencies;
};
const object = { additionalProperties: false } as const;
const id = t.String();
const nullableId = t.Union([id, t.Null()]);
const offerSchema = t.Object(
  {
    id,
    targetSubjectId: id,
    title: t.String(),
    currency: t.String(),
    unitAmountMinor: t.Integer(),
    state: t.Union([t.Literal('active'), t.Literal('delisted')]),
  },
  object,
);
const orderSchema = t.Object(
  {
    id,
    offerId: id,
    settlement: t.Union([t.Literal('pending'), t.Literal('paid'), t.Literal('failed'), t.Literal('unknown')]),
    checkoutUrl: nullableId,
    checkoutExpiresAt: nullableId,
    entitlementId: nullableId,
    createdAt: t.String(),
  },
  object,
);
const entitlementSchema = t.Object(
  {
    id,
    offerId: id,
    orderId: id,
    targetSubjectId: id,
    grantedAt: t.String(),
    revokedAt: nullableId,
    revokeReason: t.Union([t.Literal('refund'), t.Literal('dispute'), t.Null()]),
    active: t.Boolean(),
  },
  object,
);
const offerResponse = t.Object({ offer: offerSchema }, object);
const orderResponse = t.Object({ order: orderSchema }, object);
const entitlementResponse = t.Object({ entitlement: entitlementSchema }, object);
const headers = t.Object({ [IDEMPOTENCY_HEADER]: t.String({ minLength: 3, maxLength: 1024 }) });
const unauthorized = problemSchema('authentication_required', 'invalid_credentials');
const unavailable = problemSchema(
  'dependency_unavailable',
  'overloaded',
  'partition_unavailable',
  'transaction_retry_exhausted',
  'deadline_exceeded',
);
const bearer = [{ bearerAuth: [] }];
function detail(operationId: string, action: string, anonymous = false) {
  return { operationId, 'x-action': action, security: anonymous ? [...bearer, {}] : bearer };
}
function offerView(offer: Offer) {
  const { id, targetSubjectId, title, currency, unitAmountMinor, state } = offer;
  return { id, targetSubjectId, title, currency, unitAmountMinor, state };
}
function entitlementView(entitlement: Entitlement) {
  const { id, offerId, orderId, targetSubjectId, grantedAt, revokedAt, revokeReason } = entitlement;
  return { id, offerId, orderId, targetSubjectId, grantedAt, revokedAt, revokeReason, active: revokedAt === null };
}
async function orderView(pool: Pool, order: Order) {
  const entitlements = await pool.query<{ id: string }>(
    'SELECT entitlement_id AS id FROM commerce.entitlement WHERE route=$1 AND order_id=$2',
    [routeOf(order.id), order.id],
  );
  const { id, offerId, settlement, checkoutUrl, checkoutExpiresAt, createdAt } = order;
  return {
    id,
    offerId,
    settlement,
    checkoutUrl,
    checkoutExpiresAt,
    entitlementId: entitlements.rows[0]?.id ?? null,
    createdAt,
  };
}
function requireAccount(actor: Actor) {
  if (actor.kind !== 'account') throw new AuthenticationError(401, 'Bearer');
  return actor;
}
function scoped(actor: Actor, action: string): boolean {
  return actor.kind === 'account' && actor.scopes.includes(action);
}
async function command<T>(run: () => Promise<T>, denied: 'forbidden' | 'not_found'): Promise<T> {
  try {
    return await run();
  } catch (error) {
    if (error instanceof GrantDeniedError) throw new ProblemError(denied);
    if (error instanceof OfferUnavailableError) throw new ProblemError('offer_unavailable');
    if (error instanceof StripeUnavailableError) throw new ProblemError('dependency_unavailable');
    throw error;
  }
}

/** Mounted even for contract generation; provider operations require explicit dependencies. */
export function commerceRoutes(app: ReturnType<typeof definitionRoutes>, deps: Dependencies) {
  const { pool, tokens } = deps;
  // The webhook composer accepts the base app. Both composers mutate this
  // instance; retain their route declarations together for the generated client.
  const webhook = stripeWebhookRoutes(app as unknown as ReturnType<typeof createApp>, {
    secrets: deps.commerce?.webhookSecrets ?? [],
    work: deps.commerce?.work ?? {
      async enqueueStripeEvent() {
        throw new ProblemError('dependency_unavailable');
      },
    },
  });
  const routes = app
    .get(
      '/v1/offers/:offerId',
      {
        params: t.Object({ offerId: id }),
        response: { 200: offerResponse, 401: unauthorized, 404: problemSchema('not_found'), 503: unavailable },
        detail: detail('offer.get', 'offer:read', true),
      },
      async ({ params, admission, job }) => {
        const route = routeOf(params.offerId);
        if (route === null) throw new ProblemError('not_found');
        const offer = await admission.run('normal', job, () => store.readOffer(pool, route, params.offerId));
        if (!offer) throw new ProblemError('not_found');
        return { offer: offerView(offer) };
      },
    )
    .post(
      '/v1/offers',
      {
        headers,
        body: t.Object(
          {
            targetSubjectId: id,
            title: t.String({ minLength: 1, maxLength: 1024, pattern: '\\S' }),
            currency: t.String({ pattern: '^[a-z]{3}$' }),
            unitAmountMinor: t.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
            taxCode: t.String({ minLength: 1, maxLength: 256 }),
          },
          object,
        ),
        response: {
          201: offerResponse,
          400: problemSchema('invalid_request'),
          401: unauthorized,
          403: problemSchema('forbidden'),
          422: problemSchema('idempotency_conflict'),
          503: unavailable,
        },
        detail: detail('offer.create', 'offer:create'),
      },
      async ({ body, headers, actor, admission, job, session, set }) => {
        requireAccount(actor);
        if (routeOf(body.targetSubjectId) === null) throw new ProblemError('invalid_request');
        const key = idempotencyKeyOf(headers[IDEMPOTENCY_HEADER]);
        const result = await admission.run('normal', job, () =>
          command(
            () => createCommerceCommands({ pool, access: deps.access() }).createOffer(actor, body, key),
            'forbidden',
          ),
        );
        session.record({ partition: result.partition, epoch: result.epoch, position: result.position });
        set.status = 201;
        return { offer: offerView(result.value) };
      },
    )
    .post(
      customMethod('/v1/offers/:offerId', 'delist'),
      {
        params: t.Object({ offerId: id }),
        headers,
        response: {
          200: offerResponse,
          400: problemSchema('invalid_request'),
          401: unauthorized,
          404: problemSchema('not_found'),
          422: problemSchema('idempotency_conflict'),
          503: unavailable,
        },
        detail: detail('offer.delist', 'offer:manage'),
      },
      async ({ params, headers, actor, admission, job, session }) => {
        requireAccount(actor);
        if (routeOf(params.offerId) === null) throw new ProblemError('not_found');
        const key = idempotencyKeyOf(headers[IDEMPOTENCY_HEADER]);
        const result = await admission.run('normal', job, () =>
          command(
            () => createCommerceCommands({ pool, access: deps.access() }).delistOffer(actor, params.offerId, key),
            'not_found',
          ),
        );
        session.record({ partition: result.partition, epoch: result.epoch, position: result.position });
        return { offer: offerView(result.value) };
      },
    )
    .post(
      '/v1/orders',
      {
        headers,
        body: t.Object({ offerId: id }, object),
        response: {
          201: orderResponse,
          400: problemSchema('invalid_request'),
          401: unauthorized,
          404: problemSchema('not_found'),
          409: problemSchema('offer_unavailable'),
          422: problemSchema('idempotency_conflict'),
          503: unavailable,
        },
        detail: {
          ...detail('order.create', 'order:create'),
          responses: {
            201: {
              description: 'The created order',
              headers: { Location: { schema: { type: 'string' }, required: true } },
            },
          },
        },
      },
      async ({ body, headers, actor, admission, job, set }) => {
        requireAccount(actor);
        if (routeOf(body.offerId) === null) throw new ProblemError('not_found');
        const key = idempotencyKeyOf(headers[IDEMPOTENCY_HEADER]);
        if (!deps.commerce) throw new ProblemError('dependency_unavailable');
        const commerce = deps.commerce;
        const order = await admission.run('normal', job, () =>
          command(
            () =>
              checkout(
                { pool, commands: createCommerceCommands({ pool, access: deps.access() }), ...commerce },
                actor,
                body.offerId,
                key,
              ),
            'not_found',
          ),
        );
        set.status = 201;
        set.headers.location = `/v1/orders/${order.id}`;
        return { order: await orderView(pool, order) };
      },
    )
    .get(
      '/v1/orders/:orderId',
      {
        params: t.Object({ orderId: id }),
        response: { 200: orderResponse, 401: unauthorized, 404: problemSchema('not_found'), 503: unavailable },
        detail: detail('order.get', 'order:read'),
      },
      async ({ params, actor, admission, job }) => {
        const route = routeOf(params.orderId);
        if (
          actor.kind !== 'account' ||
          !scoped(actor, 'order:read') ||
          route === null ||
          route !== routeOf(actor.accountId)
        )
          throw new ProblemError('not_found');
        return admission.run('normal', job, async () => {
          const order = await store.readOrder(pool, route, params.orderId);
          if (!order || order.buyerAccountId !== actor.accountId) throw new ProblemError('not_found');
          return { order: await orderView(pool, order) };
        });
      },
    )
    .get(
      '/v1/entitlements',
      {
        query: t.Object(
          {
            limit: t.Optional(t.Integer({ minimum: 1, maximum: 100, default: 20 })),
            cursor: t.Optional(t.String({ maxLength: 4096 })),
          },
          object,
        ),
        response: {
          200: t.Object({ entitlements: t.Array(entitlementSchema), next: nullableId }, object),
          400: problemSchema('invalid_request', 'invalid_cursor'),
          401: unauthorized,
          403: problemSchema('forbidden'),
          409: problemSchema('stale_cursor'),
          503: unavailable,
        },
        detail: detail('entitlement.list', 'entitlement:list'),
      },
      async ({ query, actor, admission, job }) => {
        const account = requireAccount(actor);
        if (!scoped(actor, 'entitlement:list')) throw new ProblemError('forbidden');
        const route = routeOf(account.accountId)!;
        const binding = { operation: 'entitlement.list', parameters: { accountId: account.accountId } };
        let after: string | null = null,
          epoch: number | null = null;
        if (query.cursor !== undefined) {
          const cursor = decodeCursor(tokens, binding, query.cursor);
          if (
            !cursor.ok ||
            cursor.after.length !== 1 ||
            typeof cursor.after[0] !== 'string' ||
            routeOf(cursor.after[0]) !== route
          )
            throw new ProblemError('invalid_cursor');
          after = cursor.after[0];
          epoch = cursor.epoch;
        }
        const size = query.limit ?? 20;
        return admission.run('normal', job, () =>
          withConnection(pool, async (client) => {
            await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
            try {
              const partition = await readPartition(client, partitionOf(route));
              if (epoch !== null && epoch !== partition?.epoch) throw new ProblemError('stale_cursor');
              const rows = await entitlementPage.run(
                { query: client.query.bind(client) },
                {
                  route,
                  account_id: account.accountId,
                  after: after ?? 'ffffffff-ffff-ffff-ffff-ffffffffffff',
                  limit: size + 1,
                },
              );
              const entitlements = rows.map((row) => ({
                ...row,
                grantedAt: new Date(row.grantedAt).toISOString(),
                revokedAt: row.revokedAt === null ? null : new Date(row.revokedAt).toISOString(),
              }));
              await client.query('COMMIT');
              const shown = entitlements.slice(0, size);
              const last = shown.at(-1);
              return {
                entitlements: shown.map(entitlementView),
                next:
                  entitlements.length > size && last && partition
                    ? encodeCursor(tokens, binding, { epoch: partition.epoch, after: [last.id] })
                    : null,
              };
            } catch (error) {
              await client.query('ROLLBACK');
              throw error;
            }
          }),
        );
      },
    )
    .get(
      '/v1/entitlements/:entitlementId',
      {
        params: t.Object({ entitlementId: id }),
        response: { 200: entitlementResponse, 401: unauthorized, 404: problemSchema('not_found'), 503: unavailable },
        detail: detail('entitlement.get', 'entitlement:read'),
      },
      async ({ params, actor, admission, job }) => {
        const route = routeOf(params.entitlementId);
        if (
          actor.kind !== 'account' ||
          !scoped(actor, 'entitlement:read') ||
          route === null ||
          route !== routeOf(actor.accountId)
        )
          throw new ProblemError('not_found');
        const entitlement = await admission.run('normal', job, () =>
          store.readEntitlement(pool, route, params.entitlementId),
        );
        if (!entitlement || entitlement.accountId !== actor.accountId) throw new ProblemError('not_found');
        return { entitlement: entitlementView(entitlement) };
      },
    );
  return routes as typeof routes & typeof webhook;
}
