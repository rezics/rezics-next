import { BenefitAcquisitionError } from './acquisition.ts';
import { listSubjectOffers } from './subject-offers.ts';
import { readCommerceMoneyPolicy, type CommerceMoneyPolicy } from './money.ts';
import { ContentEditionUnavailableError, contentEditionTermsView, decodeCapturedContentEdition } from './benefit.ts';
import { readSubjectSummaries, type SubjectSummary } from '../semantic/summaries.ts';
import { SubjectSummarySchema } from '../semantic/http/summaries.ts';
import { t } from 'elysia';
import type { Pool } from 'pg';
import { GrantDeniedError } from '../access/grant-commands.ts';
import { readPartition } from '../partition/partition.ts';
import { withConnection } from '../database/pool.ts';
import type { createApp } from '../http/app.ts';
import type { definitionRoutes } from '../semantic/http/definitions.ts';
import { customMethod } from '../http/custom-method.ts';
import { defineRateLimit } from '../http/rate-limit.ts';
import { ProblemError, problemSchema } from '../http/problem.ts';
import { IDEMPOTENCY_HEADER, idempotencyKeyOf } from '../http/request.ts';
import { AuthenticationError, type Access, type Actor } from '../request/access.ts';
import { partitionOf, routeOf } from '../route/route.ts';
import { decodeCursor, encodeCursor } from '../tokens/cursor.ts';
import type { KeyRing } from '../tokens/seal.ts';
import { checkout } from './checkout.ts';
import { reconcileOrder } from './order-reconcile.ts';
import { listCreatorOffers } from './creator-offers.ts';
import { listCreatorSales } from './creator-sales.ts';
import { createCommerceCommands, OfferRevisionConflictError, OfferUnavailableError } from './commands.ts';
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
  routeKey: Uint8Array;
  tokens: KeyRing;
  access: () => Access;
  commerce?: CommerceDependencies;
  moneyPolicy?: CommerceMoneyPolicy;
};
const object = { additionalProperties: false } as const;
const id = t.String();
const nullableId = t.Union([id, t.Null()]);
/** Published Commerce capture DTO; this is not Accounts' opaque fact ABI. */
const contentEditionSchema = t.Union([
  t.Null(),
  t.Object(
    {
      benefit: t.Object(
        {
          kind: t.Literal('content-edition'),
          resourceType: t.Literal('content.edition'),
          resource: t.Object({ route: t.Integer({ minimum: 0, maximum: 65535 }), id }, object),
          version: t.Object({ revisionId: id, sha256: t.String({ pattern: '^[a-f0-9]{64}$' }) }, object),
          action: t.Literal('edition:read'),
        },
        object,
      ),
      creatorAccountId: id,
      targetSubjectId: id,
      source: t.Object({ licence: t.String({ minLength: 1, maxLength: 256 }) }, object),
      saleTermsReference: t.String({ minLength: 1, maxLength: 256 }),
      delivery: t.Literal('fixed-content-edition'),
      acquisition: t.Literal('one-time-account-bound'),
      quantity: t.Literal(1),
    },
    object,
  ),
]);
const moneyUnitSchema = t.Object(
  {
    system: t.Literal('stripe-api'),
    exponent: t.Union([t.Literal(0), t.Literal(2)]),
    factsVersion: t.Literal('stripe-money-v1'),
  },
  object,
);
const capturedMoneySchemas = {
  moneyUnit: t.Union([moneyUnitSchema, t.Null()]),
  taxBehavior: t.Union([t.Literal('exclusive'), t.Null()]),
};
const moneySchema = t.Object(
  {
    factsVersion: t.Literal('stripe-money-v1'),
    taxBehavior: t.Literal('exclusive'),
    configuredSaleCurrencies: t.Array(
      t.Object(
        {
          currency: t.Union([t.Literal('usd'), t.Literal('eur')]),
          unit: moneyUnitSchema,
          minAmountMinor: t.Literal(50),
          maxAmountMinor: t.Literal(99999999),
          chargeMultiple: t.Literal(1),
        },
        object,
      ),
    ),
  },
  object,
);
const offerSchema = t.Object(
  {
    ...capturedMoneySchemas,
    contentEdition: contentEditionSchema,
    id,
    targetSubjectId: id,
    summary: t.Union([SubjectSummarySchema, t.Null()]),
    title: t.String(),
    currency: t.String(),
    unitAmountMinor: t.Integer(),
    state: t.Union([t.Literal('active'), t.Literal('delisted')]),
  },
  object,
);
const offerReadSchema = t.Object(
  {
    ...capturedMoneySchemas,
    contentEdition: contentEditionSchema,
    id,
    revision: t.Integer({ minimum: 1 }),
    targetSubjectId: id,
    subject: t.Union([SubjectSummarySchema, t.Null()]),
    title: t.String(),
    currency: t.String(),
    unitAmountMinor: t.Integer(),
    state: t.Union([t.Literal('active'), t.Literal('delisted')]),
  },
  object,
);
const sellerOfferSchema = t.Object(
  {
    ...capturedMoneySchemas,
    id,
    targetSubjectId: id,
    title: t.String(),
    currency: t.String(),
    unitAmountMinor: t.Integer(),
    taxCode: t.String(),
    royaltyBasisPoints: t.Integer(),
    state: t.Union([t.Literal('active'), t.Literal('delisted')]),
    revision: t.Integer({ minimum: 1 }),
    contentEdition: contentEditionSchema,
  },
  object,
);
const orderSchema = t.Object(
  {
    ...capturedMoneySchemas,
    contentEdition: contentEditionSchema,
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
const creatorSaleSchema = t.Object(
  {
    orderId: id,
    offerId: id,
    title: t.String({ maxLength: 512 }),
    targetSubjectId: id,
    currency: t.String(),
    unitAmountMinor: t.Integer(),
    ...capturedMoneySchemas,
    settlement: t.Union([t.Literal('pending'), t.Literal('paid'), t.Literal('failed'), t.Literal('unknown')]),
    createdAt: t.String(),
  },
  object,
);
const orderReadSchema = t.Object(
  {
    ...capturedMoneySchemas,
    contentEdition: contentEditionSchema,
    id,
    offerId: id,
    title: t.String(),
    currency: t.String(),
    unitAmountMinor: t.Integer(),
    taxCode: t.String(),
    amountTaxMinor: t.Union([t.Integer(), t.Null()]),
    recordedCharge: t.Union([
      t.Null(),
      t.Object(
        {
          currency: t.String(),
          moneyUnit: moneyUnitSchema,
          amountTotalMinor: t.Integer(),
          amountTaxMinor: t.Union([t.Integer(), t.Null()]),
        },
        object,
      ),
    ]),
    recordedPresentment: t.Union([
      t.Null(),
      t.Object({ currency: t.String(), moneyUnit: moneyUnitSchema, amountTotalMinor: t.Integer() }, object),
    ]),
    targetSubjectId: id,
    subject: t.Union([SubjectSummarySchema, t.Null()]),
    settlement: t.Union([t.Literal('pending'), t.Literal('paid'), t.Literal('failed'), t.Literal('unknown')]),
    checkoutUrl: nullableId,
    checkoutExpiresAt: nullableId,
    entitlementId: nullableId,
    createdAt: t.String(),
  },
  object,
);
// History contains captured purchase terms; live catalogue/subject reads are unnecessary.
const orderHistorySchema = t.Object(
  {
    ...orderSchema.properties,
    title: t.String(),
    targetSubjectId: id,
    offerRevision: t.Integer(),
    currency: t.String(),
    unitAmountMinor: t.Integer(),
    taxCode: t.String(),
    amountTaxMinor: t.Union([t.Integer(), t.Null()]),
  },
  object,
);
const entitlementSchema = t.Object(
  {
    contentEdition: contentEditionSchema,
    id,
    offerId: id,
    orderId: id,
    targetSubjectId: id,
    summary: t.Union([SubjectSummarySchema, t.Null()]),
    grantedAt: t.String(),
    revokedAt: nullableId,
    revokeReason: t.Union([t.Literal('refund'), t.Literal('dispute'), t.Null()]),
    active: t.Boolean(),
  },
  object,
);
const offerResponse = t.Object({ offer: offerSchema }, object);
const offerReadResponse = t.Object({ offer: offerReadSchema }, object);
const orderResponse = t.Object({ order: orderSchema }, object);
const orderReadResponse = t.Object({ order: orderReadSchema }, object);
const entitlementResponse = t.Object({ entitlement: entitlementSchema }, object);
const headers = t.Object({ [IDEMPOTENCY_HEADER]: t.String({ minLength: 3, maxLength: 1024 }) });
const languageQuery = t.Object({ languages: t.Optional(t.String()) }, object);
const languageTag = /^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{1,8})*$/;
const unauthorized = problemSchema('authentication_required', 'invalid_credentials');
const unavailable = problemSchema(
  'dependency_unavailable',
  'overloaded',
  'partition_unavailable',
  'transaction_retry_exhausted',
  'deadline_exceeded',
);
// Literal discriminants and private locator fields are published for the purchase UI.
const acquisitionPendingProblem = t.Object(
  {
    ...problemSchema('acquisition_pending').properties,
    code: t.Literal('acquisition_pending'),
    effect_status: t.Literal('not_applied'),
    orderId: t.Optional(id),
  },
  object,
);
const benefitAlreadyOwnedProblem = t.Object(
  {
    ...problemSchema('benefit_already_owned').properties,
    code: t.Literal('benefit_already_owned'),
    effect_status: t.Literal('not_applied'),
    orderId: t.Optional(id),
    entitlementId: t.Optional(id),
  },
  object,
);
const offerConflictProblem = t.Object(
  {
    ...problemSchema('offer_unavailable', 'offer_revision_conflict').properties,
    code: t.Union([t.Literal('offer_unavailable'), t.Literal('offer_revision_conflict')]),
  },
  object,
);
const bearer = [{ bearerAuth: [] }];
function detail(operationId: string, action: string, exposure: 'gate:purchases' | 'gate:selling', anonymous = false) {
  return { operationId, 'x-exposure': exposure, 'x-action': action, security: anonymous ? [...bearer, {}] : bearer };
}
function offerView(offer: Offer, summary: SubjectSummary | null) {
  const { id, targetSubjectId, title, currency, unitAmountMinor, state } = offer;
  return {
    id,
    targetSubjectId,
    title,
    currency,
    unitAmountMinor,
    state,
    summary,
    moneyUnit: offer.moneyUnit ?? null,
    taxBehavior: offer.taxBehavior ?? null,
    contentEdition: contentEditionTermsView(offer.contentEdition),
  };
}
function offerReadView(offer: Offer, subject: SubjectSummary | null) {
  const { id, revision, targetSubjectId, title, currency, unitAmountMinor, state } = offer;
  return {
    id,
    revision,
    targetSubjectId,
    subject,
    title,
    currency,
    unitAmountMinor,
    state,
    moneyUnit: offer.moneyUnit ?? null,
    taxBehavior: offer.taxBehavior ?? null,
    contentEdition: contentEditionTermsView(offer.contentEdition),
  };
}
function entitlementView(entitlement: Entitlement, summary: SubjectSummary | null) {
  const { id, offerId, orderId, targetSubjectId, grantedAt, revokedAt, revokeReason } = entitlement;
  return {
    id,
    offerId,
    orderId,
    targetSubjectId,
    grantedAt,
    revokedAt,
    revokeReason,
    active: revokedAt === null,
    contentEdition: contentEditionTermsView(entitlement.contentEdition),
    summary,
  };
}
async function orderView(pool: Pool, order: Order) {
  const entitlement = await store.readOrderEntitlement(pool, routeOf(order.id)!, order.id);
  const { id, offerId, settlement, checkoutUrl, checkoutExpiresAt, createdAt } = order;
  return {
    id,
    offerId,
    settlement,
    checkoutUrl,
    checkoutExpiresAt,
    entitlementId: entitlement?.id ?? null,
    moneyUnit: order.moneyUnit ?? null,
    taxBehavior: order.taxBehavior ?? null,
    contentEdition: contentEditionTermsView(order.contentEdition),
    createdAt,
  };
}
function requireAccount(actor: Actor) {
  if (actor.kind !== 'account') throw new AuthenticationError(401, 'Bearer');
  return actor;
}
function languagePreferences(value: string | string[] | undefined): readonly string[] | undefined {
  if (value === undefined) return undefined;
  const languages = typeof value === 'string' ? value.split(',') : value;
  if (languages.length < 1 || languages.length > 8)
    throw new ProblemError('invalid_request', { errors: [{ pointer: '/languages', code: 'out_of_range' }] });
  const seen = new Set<string>();
  languages.forEach((language, index) => {
    if (language.length > 35 || !languageTag.test(language) || seen.has(language))
      throw new ProblemError('invalid_request', {
        errors: [{ pointer: `/languages/${index}`, code: 'invalid_format' }],
      });
    seen.add(language);
  });
  return languages;
}
function scoped(actor: Actor, action: string): boolean {
  return actor.kind === 'account' && actor.scopes.includes(action);
}
async function command<T>(run: () => Promise<T>, denied: 'forbidden' | 'not_found'): Promise<T> {
  try {
    return await run();
  } catch (error) {
    if (error instanceof BenefitAcquisitionError)
      throw new ProblemError(error.code, { effectStatus: 'not_applied', extensions: error.locators });
    if (error instanceof GrantDeniedError) throw new ProblemError(denied);
    if (error instanceof RangeError && error.message === 'Invalid configured sale amount')
      throw new ProblemError('invalid_request');
    if (error instanceof OfferUnavailableError) throw new ProblemError('offer_unavailable');
    if (error instanceof ContentEditionUnavailableError) throw new ProblemError('dependency_unavailable');
    if (error instanceof OfferRevisionConflictError) throw new ProblemError('offer_revision_conflict');
    if (error instanceof StripeUnavailableError) throw new ProblemError('dependency_unavailable');
    throw error;
  }
}

/** Mounted even for contract generation; provider operations require explicit dependencies. */
export function commerceRoutes(app: ReturnType<typeof definitionRoutes>, deps: Dependencies) {
  const { pool, tokens } = deps;
  const moneyPolicy = deps.moneyPolicy ?? readCommerceMoneyPolicy(process.env);
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
      '/v1/subjects/:id/offers',
      {
        params: t.Object({ id }),
        query: t.Object(
          {
            cursor: t.Optional(t.String({ maxLength: 4096 })),
            limit: t.Optional(t.Integer({ minimum: 1, maximum: 20, default: 10 })),
          },
          object,
        ),
        response: {
          200: t.Object(
            {
              offers: t.Array(
                t.Object(
                  {
                    id,
                    targetSubjectId: id,
                    title: t.String(),
                    currency: t.String(),
                    unitAmountMinor: t.Integer(),
                    ...capturedMoneySchemas,
                    revision: t.Integer({ minimum: 1 }),
                    contentEdition: contentEditionSchema,
                  },
                  object,
                ),
              ),
              next: nullableId,
              projectionState: t.Union([t.Literal('ready'), t.Literal('preparing')]),
            },
            object,
          ),
          400: problemSchema('invalid_request', 'invalid_cursor'),
          401: unauthorized,
          404: problemSchema('not_found'),
          409: problemSchema('stale_cursor'),
          503: unavailable,
        },
        detail: detail('subject_offers.list', 'subject:read', 'gate:purchases', true),
      },
      async ({ params, query, actor, admission, job, set }) => {
        set.headers['cache-control'] = 'private, no-store';
        return admission.run('normal', job, () =>
          listSubjectOffers(
            {
              pool,
              tokens,
              routeKey: deps.routeKey,
              access: deps.access(),
            },
            actor,
            params.id,
            { ...query, deadline: job.deadline },
          ),
        );
      },
    )
    .get(
      '/v1/commerceMoney',
      {
        response: { 200: moneySchema, 401: unauthorized, 503: unavailable },
        // Reuse the existing anonymous offer-read label; static configuration is no grant or selling permission.
        detail: detail('commerce.money_schema', 'offer:read', 'gate:selling', true),
      },
      () => ({
        factsVersion: 'stripe-money-v1' as const,
        taxBehavior: moneyPolicy.taxBehavior,
        configuredSaleCurrencies: moneyPolicy.configuredSaleCurrencies.map((rule) => ({ ...rule })),
      }),
    )
    .get(
      '/v1/commerceSales',
      {
        query: t.Object(
          {
            cursor: t.Optional(t.String({ maxLength: 4096 })),
            limit: t.Optional(t.Integer({ minimum: 1, maximum: 100, default: 20 })),
          },
          object,
        ),
        response: {
          200: t.Object(
            {
              sales: t.Array(creatorSaleSchema, { maxItems: 100 }),
              next: nullableId,
              projectionState: t.Union([t.Literal('ready'), t.Literal('preparing')]),
            },
            object,
          ),
          400: problemSchema('invalid_request', 'invalid_cursor'),
          401: unauthorized,
          403: problemSchema('forbidden'),
          409: problemSchema('stale_cursor'),
          503: unavailable,
        },
        detail: {
          ...detail('commerce_sale.list', 'commerce_sale:list', 'gate:selling'),
          'x-authority-anchor': 'own-account',
          'x-authority-resource-types': ['access.account'],
        },
      },
      async ({ actor, authorize, query, admission, job, session, set }) => {
        set.headers['cache-control'] = 'private, no-store';
        set.headers['x-robots-tag'] = 'noindex, nofollow';
        const account = requireAccount(actor);
        const check = await authorize({ route: routeOf(account.accountId)!, id: account.accountId });
        return admission.run('normal', job, () =>
          listCreatorSales(pool, tokens, actor, check, {
            ...query,
            deadline: job.deadline,
            seen: session.components,
          }),
        );
      },
    )
    .get(
      '/v1/offers',
      {
        query: t.Object(
          {
            cursor: t.Optional(t.String({ maxLength: 4096 })),
            limit: t.Optional(t.Integer({ minimum: 1, maximum: 100, default: 20 })),
          },
          object,
        ),
        response: {
          200: t.Object({ offers: t.Array(sellerOfferSchema), next: nullableId }, object),
          400: problemSchema('invalid_request', 'invalid_cursor'),
          401: unauthorized,
          403: problemSchema('forbidden'),
          409: problemSchema('stale_cursor'),
          503: unavailable,
        },
        detail: {
          ...detail('offer.list', 'offer:list', 'gate:selling'),
          'x-authority-anchor': 'own-account',
          'x-authority-resource-types': ['access.account'],
        },
      },
      async ({ actor, authorize, query, admission, job, session, set }) => {
        set.headers['cache-control'] = 'private, no-store';
        const account = requireAccount(actor);
        const check = await authorize({ route: routeOf(account.accountId)!, id: account.accountId });
        return admission.run('normal', job, () =>
          listCreatorOffers(pool, tokens, actor, check, {
            ...query,
            deadline: job.deadline,
            seen: session.components,
          }),
        );
      },
    )
    .get(
      '/v1/offers/:offerId',
      {
        params: t.Object({ offerId: id }),
        query: languageQuery,
        response: {
          200: offerReadResponse,
          400: problemSchema('invalid_request'),
          401: unauthorized,
          404: problemSchema('not_found'),
          503: unavailable,
        },
        detail: detail('offer.get', 'offer:read', 'gate:purchases', true),
      },
      async ({ params, query, actor, admission, job }) => {
        const route = routeOf(params.offerId);
        if (route === null) throw new ProblemError('not_found');
        const languages = languagePreferences(query.languages);
        return admission.run('normal', job, async () => {
          const offer = await store.readOffer(pool, route, params.offerId);
          if (!offer || offer.state === 'delisted') throw new ProblemError('not_found');
          const summaryDependencies = {
            pool,
            routeKey: deps.routeKey,
            access: deps.access(),
            actor,
            deadline: job.deadline,
          };
          const summaries =
            languages === undefined
              ? await readSubjectSummaries(summaryDependencies, [offer.targetSubjectId])
              : await readSubjectSummaries(summaryDependencies, [offer.targetSubjectId], { languages });
          return { offer: offerReadView(offer, summaries.get(offer.targetSubjectId) ?? null) };
        });
      },
    )
    .post(
      '/v1/offers',
      {
        headers,
        body: t.Union([
          t.Object(
            {
              contentEditionId: id,
              title: t.String({ minLength: 1, maxLength: 1024, pattern: '\\S' }),
              currency: t.String({ pattern: '^[a-z]{3}$' }),
              unitAmountMinor: t.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
              taxCode: t.String({ minLength: 1, maxLength: 256 }),
            },
            object,
          ),
          // Preserve the exact old request digest for authorized historical receipt replay only.
          // Its fresh command body always fails unavailable; no subject creates a native benefit.
          t.Object(
            {
              targetSubjectId: id,
              title: t.String({ minLength: 1, maxLength: 1024, pattern: '\\S' }),
              currency: t.String({ pattern: '^[a-z]{3}$' }),
              unitAmountMinor: t.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
              taxCode: t.String({ minLength: 1, maxLength: 256 }),
            },
            { ...object, description: 'Historical offer receipt replay only; fresh sales require contentEditionId.' },
          ),
        ]),
        response: {
          201: offerResponse,
          400: problemSchema('invalid_request'),
          401: unauthorized,
          403: problemSchema('forbidden'),
          422: problemSchema('idempotency_conflict'),
          503: unavailable,
        },
        detail: { ...detail('offer.create', 'offer:create', 'gate:selling'), 'x-resource-types': ['commerce.offer'] },
      },
      async ({ body, headers, actor, admission, job, session, set }) => {
        requireAccount(actor);
        if (routeOf('contentEditionId' in body ? body.contentEditionId : body.targetSubjectId) === null)
          throw new ProblemError('invalid_request');
        const key = idempotencyKeyOf(headers[IDEMPOTENCY_HEADER]);
        const result = await admission.run('normal', job, () =>
          command(
            () => createCommerceCommands({ pool, access: deps.access(), moneyPolicy }).createOffer(actor, body, key),
            'forbidden',
          ),
        );
        session.record({ partition: result.partition, epoch: result.epoch, position: result.position });
        set.status = 201;
        return {
          offer: offerView(
            result.value,
            (
              await readSubjectSummaries(
                { pool, routeKey: deps.routeKey, access: deps.access(), actor, deadline: job.deadline },
                [result.value.targetSubjectId],
              )
            ).get(result.value.targetSubjectId) ?? null,
          ),
        };
      },
    )
    .patch(
      '/v1/offers/:offerId',
      {
        params: t.Object({ offerId: id }),
        headers,
        body: t.Object({ unitAmountMinor: t.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }) }, object),
        response: {
          200: offerResponse,
          400: problemSchema('invalid_request'),
          401: unauthorized,
          403: problemSchema('forbidden', 'platform_closed'),
          404: problemSchema('not_found'),
          409: problemSchema('offer_unavailable'),
          422: problemSchema('idempotency_conflict'),
          503: unavailable,
        },
        detail: detail('offer.revise', 'offer:manage', 'gate:selling'),
      },
      async ({ params, body, headers, actor, admission, job, session }) => {
        requireAccount(actor);
        if (!scoped(actor, 'offer:manage')) throw new ProblemError('forbidden');
        if (routeOf(params.offerId) === null) throw new ProblemError('not_found');
        const key = idempotencyKeyOf(headers[IDEMPOTENCY_HEADER]);
        const result = await admission.run('normal', job, () =>
          command(
            () =>
              createCommerceCommands({ pool, access: deps.access(), moneyPolicy }).reviseOffer(
                actor,
                params.offerId,
                body,
                key,
              ),
            'not_found',
          ),
        );
        session.record({ partition: result.partition, epoch: result.epoch, position: result.position });
        return {
          offer: offerView(
            result.value,
            (
              await readSubjectSummaries(
                { pool, routeKey: deps.routeKey, access: deps.access(), actor, deadline: job.deadline },
                [result.value.targetSubjectId],
              )
            ).get(result.value.targetSubjectId) ?? null,
          ),
        };
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
        detail: detail('offer.delist', 'offer:manage', 'gate:selling'),
      },
      async ({ params, headers, actor, admission, job, session }) => {
        requireAccount(actor);
        if (routeOf(params.offerId) === null) throw new ProblemError('not_found');
        const key = idempotencyKeyOf(headers[IDEMPOTENCY_HEADER]);
        const result = await admission.run('normal', job, () =>
          command(
            () =>
              createCommerceCommands({ pool, access: deps.access(), moneyPolicy }).delistOffer(
                actor,
                params.offerId,
                key,
              ),
            'not_found',
          ),
        );
        session.record({ partition: result.partition, epoch: result.epoch, position: result.position });
        return {
          offer: offerView(
            result.value,
            (
              await readSubjectSummaries(
                { pool, routeKey: deps.routeKey, access: deps.access(), actor, deadline: job.deadline },
                [result.value.targetSubjectId],
              )
            ).get(result.value.targetSubjectId) ?? null,
          ),
        };
      },
    )
    .post(
      '/v1/orders',
      {
        headers,
        body: t.Object(
          { offerId: id, expectedOfferRevision: t.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }) },
          object,
        ),
        response: {
          201: orderResponse,
          400: problemSchema('invalid_request'),
          401: unauthorized,
          404: problemSchema('not_found'),
          409: t.Union([offerConflictProblem, acquisitionPendingProblem, benefitAlreadyOwnedProblem]),
          422: problemSchema('idempotency_conflict'),
          503: unavailable,
        },
        detail: {
          ...detail('order.create', 'order:create', 'gate:purchases'),
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
                { pool, commands: createCommerceCommands({ pool, access: deps.access(), moneyPolicy }), ...commerce },
                actor,
                body.offerId,
                body.expectedOfferRevision,
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
      '/v1/orders',
      {
        query: t.Object(
          {
            limit: t.Optional(t.Integer({ minimum: 1, maximum: 100, default: 20 })),
            cursor: t.Optional(t.String({ maxLength: 4096 })),
          },
          object,
        ),
        response: {
          200: t.Object({ orders: t.Array(orderHistorySchema), next: nullableId }, object),
          400: problemSchema('invalid_request', 'invalid_cursor'),
          401: unauthorized,
          403: problemSchema('forbidden'),
          409: problemSchema('stale_cursor'),
          503: unavailable,
        },
        detail: detail('order.list', 'order:read', 'gate:purchases'),
      },
      async ({ query, actor, admission, job }) => {
        const account = requireAccount(actor);
        if (!scoped(actor, 'order:read')) throw new ProblemError('forbidden');
        const route = routeOf(account.accountId)!;
        // No account selector: both the SQL equality and cursor scope use the verified viewer.
        // Page size can change between requests, as on the entitlement list.
        const binding = { operation: 'order.list', parameters: { accountId: account.accountId } };
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
              const rows = await store.listBuyerOrders(client, route, account.accountId, {
                after,
                limit: size + 1,
              });
              await client.query('COMMIT');
              const orders = rows.slice(0, size);
              const last = orders.at(-1);
              return {
                orders: orders.map((order) => ({
                  ...order,
                  moneyUnit: order.moneyUnit ?? null,
                  taxBehavior: order.taxBehavior ?? null,
                  contentEdition: contentEditionTermsView(order.contentEdition),
                })),
                next:
                  rows.length > size && last && partition
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
      '/v1/orders/:orderId',
      {
        params: t.Object({ orderId: id }),
        query: languageQuery,
        response: {
          200: orderReadResponse,
          400: problemSchema('invalid_request'),
          401: unauthorized,
          404: problemSchema('not_found'),
          503: unavailable,
        },
        detail: detail('order.get', 'order:read', 'gate:purchases'),
      },
      async ({ params, query, actor, admission, job }) => {
        const route = routeOf(params.orderId);
        if (
          actor.kind !== 'account' ||
          !scoped(actor, 'order:read') ||
          route === null ||
          route !== routeOf(actor.accountId)
        )
          throw new ProblemError('not_found');
        const languages = languagePreferences(query.languages);
        return admission.run('normal', job, async () => {
          const receipt = await store.readBuyerOrder(pool, route, params.orderId);
          if (!receipt || receipt.order.buyerAccountId !== actor.accountId) throw new ProblemError('not_found');
          const { order, recordedCharge, recordedPresentment } = receipt;
          const summaryDependencies = {
            pool,
            routeKey: deps.routeKey,
            access: deps.access(),
            actor,
            deadline: job.deadline,
          };
          const summaries =
            languages === undefined
              ? await readSubjectSummaries(summaryDependencies, [order.targetSubjectId])
              : await readSubjectSummaries(summaryDependencies, [order.targetSubjectId], { languages });
          return {
            order: {
              ...(await orderView(pool, order)),
              title: order.title,
              currency: order.currency,
              unitAmountMinor: order.unitAmountMinor,
              taxCode: order.taxCode,
              amountTaxMinor: order.amountTaxMinor ?? null,
              recordedCharge,
              recordedPresentment,
              targetSubjectId: order.targetSubjectId,
              subject: summaries.get(order.targetSubjectId) ?? null,
            },
          };
        });
      },
    )
    .post(
      customMethod('/v1/orders/:orderId', 'reconcile'),
      {
        params: t.Object({ orderId: id }),
        headers,
        body: t.Object({}, object),
        response: {
          202: t.Object({ orderId: id, reconciliation: t.Literal('queued') }, object),
          400: problemSchema('invalid_request'),
          401: unauthorized,
          403: problemSchema('forbidden', 'platform_closed'),
          404: problemSchema('not_found'),
          422: problemSchema('idempotency_conflict'),
          503: unavailable,
        },
        detail: {
          ...detail('order.reconcile', 'order:reconcile', 'gate:purchases'),
          'x-authority-anchor': 'own-account',
          'x-authority-resource-types': ['access.account'],
          'x-rate-limit': defineRateLimit({ family: 'write', units: 1 }),
        },
      },
      async ({ params, headers, actor, admission, job, session, set }) => {
        requireAccount(actor);
        if (!scoped(actor, 'order:reconcile')) throw new ProblemError('forbidden');
        if (routeOf(params.orderId) === null) throw new ProblemError('not_found');
        const key = idempotencyKeyOf(headers[IDEMPOTENCY_HEADER]);
        const result = await admission.run('normal', job, () =>
          command(
            () =>
              reconcileOrder(
                { pool, access: deps.access(), deadline: job.deadline, repairAvailable: deps.commerce !== undefined },
                actor,
                params.orderId,
                key,
              ),
            'not_found',
          ),
        );
        session.record({ partition: result.partition, epoch: result.epoch, position: result.position });
        set.status = 202;
        return result.value;
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
        detail: detail('entitlement.list', 'entitlement:list', 'gate:purchases'),
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
        return admission.run('normal', job, async () => {
          const page = await withConnection(pool, async (client) => {
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
                contentEdition: decodeCapturedContentEdition(row.contentEdition),
                grantedAt: new Date(row.grantedAt).toISOString(),
                revokedAt: row.revokedAt === null ? null : new Date(row.revokedAt).toISOString(),
              }));
              await client.query('COMMIT');
              const shown = entitlements.slice(0, size);
              const last = shown.at(-1);
              return {
                entitlements: shown,
                next:
                  entitlements.length > size && last && partition
                    ? encodeCursor(tokens, binding, { epoch: partition.epoch, after: [last.id] })
                    : null,
              };
            } catch (error) {
              await client.query('ROLLBACK');
              throw error;
            }
          });
          const summaries = await readSubjectSummaries(
            { pool, routeKey: deps.routeKey, access: deps.access(), actor, deadline: job.deadline },
            page.entitlements.map((row) => row.targetSubjectId),
          );
          return {
            ...page,
            entitlements: page.entitlements.map((row) =>
              entitlementView(row, summaries.get(row.targetSubjectId) ?? null),
            ),
          };
        });
      },
    )
    .get(
      '/v1/entitlements/:entitlementId',
      {
        params: t.Object({ entitlementId: id }),
        response: { 200: entitlementResponse, 401: unauthorized, 404: problemSchema('not_found'), 503: unavailable },
        detail: detail('entitlement.get', 'entitlement:read', 'gate:purchases'),
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
        return {
          entitlement: entitlementView(
            entitlement,
            (
              await readSubjectSummaries(
                { pool, routeKey: deps.routeKey, access: deps.access(), actor, deadline: job.deadline },
                [entitlement.targetSubjectId],
              )
            ).get(entitlement.targetSubjectId) ?? null,
          ),
        };
      },
    );
  return routes as typeof routes & typeof webhook;
}
