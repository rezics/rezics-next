import { Elysia, t } from 'elysia';
import { authorizedReadProblems, writeProblems } from '../api-responses.ts';
import { problemResult } from '../api-contract.ts';
import type { FusekiClient } from '../infrastructure/fuseki.ts';
import { COMMERCE_SCOPE, CommerceDenied, CommerceInvalid, CommerceKeyConflict, CommerceSignatureInvalid,
  CommerceStale, CommerceStateConflict, CommerceUnavailable, commerceIntentDigest,
  type CommerceStore } from '../modules/commerce/store.ts';
import type { FixedSiteStore } from '../modules/pro-site/store.ts';
import type { QuotaStore } from '../modules/quota/store.ts';
import type { MainWorkDependencies } from './dependencies.ts';
import { commandError, problem } from './problems.ts';
import { fixedSiteRoutes } from './pro-sites.ts';
import { quotaRoutes } from './quota.ts';

/** Owners this domain adds beside the shared Main dependencies. */
export interface CommerceRouteDependencies {
  commerce?: CommerceStore;
  quota?: QuotaStore;
  sites?: FixedSiteStore;
}

const agent = t.String({ pattern: '^https://rezics\\.com/id/[0-9a-f-]{36}$' });
const uuid = t.String({ pattern: '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' });
const generation = t.String({ pattern: '^(0|[1-9][0-9]{0,18})$' });
const slug = t.String({ pattern: '^[a-z][a-z0-9-]{0,62}$' });
const digest = t.String({ pattern: '^[0-9a-f]{64}$' });
const amount = t.String({ pattern: '^(0|[1-9][0-9]{0,18})$' });
const instant = t.String({ format: 'date-time' });
const noStore = { headers: { 'cache-control': 'no-store' } };

const quoteCommon = { profile: t.Literal('subscription-quote-v1'), beneficiary: agent,
  offeringId: uuid, offeringRevision: generation };
const quoteBody = t.Union([
  t.Object({ ...quoteCommon, operation: t.Literal('purchase'), planKey: slug, priceKey: slug },
    { additionalProperties: false }),
  t.Object({ ...quoteCommon, operation: t.Literal('change'), planKey: slug, priceKey: slug,
    subscriptionId: uuid, expectedGeneration: generation }, { additionalProperties: false }),
  t.Object({ ...quoteCommon, operation: t.Literal('cancel'), subscriptionId: uuid,
    expectedGeneration: generation }, { additionalProperties: false }),
]);
const operation = t.Union([t.Literal('purchase'), t.Literal('change'), t.Literal('cancel')]);
const quoteResult = t.Object({ profile: t.Literal('subscription-quote-v1'), quoteId: uuid, operation,
  beneficiary: agent, offeringId: uuid, offeringRevision: generation, planKey: t.Nullable(slug),
  priceKey: t.Nullable(slug), subscriptionId: t.Nullable(uuid), expectedGeneration: t.Nullable(generation),
  amountMinor: amount, currency: t.String({ pattern: '^[A-Z]{3}$' }), benefitEpoch: generation,
  quoteDigest: digest, expiresAt: instant, replayed: t.Boolean() });
const settlementView = t.Object({ id: uuid, state: t.String(), generation, providerReference: t.String() });
const changeBody = t.Object({ profile: t.Literal('subscription-change-v1'), quoteId: uuid, quoteDigest: digest },
  { additionalProperties: false });
const changeResult = t.Object({ profile: t.Literal('subscription-change-v1'), changeId: uuid, quoteId: uuid,
  operation, subscriptionId: uuid, subscriptionGeneration: generation, settlement: t.Nullable(settlementView),
  replayed: t.Boolean() });
const callbackResult = t.Object({ profile: t.Literal('subscription-settlement-callback-v1'),
  provider: slug, eventId: t.String(), disposition: t.Union([t.Literal('applied'), t.Literal('no-effect'),
    t.Literal('unmatched')]), settlementId: t.Nullable(uuid), settlementState: t.Nullable(t.String()),
  replayed: t.Boolean() });
const reconcileBody = t.Object({ profile: t.Literal('subscription-reconciliation-v1'), settlementId: uuid,
  expectedGeneration: generation }, { additionalProperties: false });
const reconcileResult = t.Object({ profile: t.Literal('subscription-reconciliation-v1'), reconciliationId: uuid,
  settlementId: uuid, observed: t.String(), outcome: t.Union([t.Literal('applied'), t.Literal('no-change'),
    t.Literal('still-unknown')]), settlementState: t.String(), settlementGeneration: generation,
  replayed: t.Boolean() });
const reason = t.String({ minLength: 1, maxLength: 128 });
const giftBody = t.Union([
  t.Object({ profile: t.Literal('subscription-gift-v1'), operation: t.Literal('issue'), issuerSubject: agent,
    beneficiary: agent, offeringId: uuid, offeringRevision: generation, planKey: slug, validUntil: instant,
    reason }, { additionalProperties: false }),
  t.Object({ profile: t.Literal('subscription-gift-v1'), operation: t.Literal('revoke'), issuerSubject: agent,
    entitlementId: uuid, expectedGeneration: generation, reason }, { additionalProperties: false }),
]);
const giftResult = t.Object({ profile: t.Literal('subscription-gift-v1'),
  operation: t.Union([t.Literal('issue'), t.Literal('revoke')]), entitlementId: uuid, beneficiary: agent,
  state: t.Union([t.Literal('active'), t.Literal('revoked')]), generation, validUntil: instant,
  benefitEpoch: generation, replayed: t.Boolean() });
const benefitResult = t.Object({ profile: t.Literal('subscription-benefits-v1'), beneficiary: agent,
  benefitEpoch: generation, freshUntil: t.Nullable(instant), benefits: t.Array(t.Object({
    benefitKey: t.String(), level: t.Integer(), grants: t.Array(t.Object({ entitlementId: uuid,
      source: t.Union([t.Literal('purchase'), t.Literal('gift')]), offeringId: uuid, planKey: slug,
      level: t.Integer(), validUntil: instant, generation })) }), { maxItems: 256 }) });
const subscriptionResult = t.Object({ profile: t.Literal('subscription-v1'), subscriptionId: uuid,
  beneficiary: agent, offeringId: uuid, groupKey: slug, groupSemantics: t.String(),
  offeringRevision: generation, planKey: slug, priceKey: slug, state: t.String(), generation,
  currentPeriodEnd: t.Nullable(instant), settlements: t.Array(settlementView, { maxItems: 20 }) });

/** Map commerce owner outcomes; account and shared errors use the Main mapping. */
export function commerceError(error: unknown): Response {
  if (error instanceof CommerceInvalid) return problem(400, 'invalid_commerce_request', error.message);
  if (error instanceof CommerceSignatureInvalid) return problem(401, 'callback_unverified', 'Callback signature is not verified');
  if (error instanceof CommerceDenied) return problem(403, 'commerce_denied', 'Commerce authority is missing');
  if (error instanceof CommerceKeyConflict) {
    return problem(409, 'idempotency_conflict', 'Idempotency key binds another request');
  }
  if (error instanceof CommerceStale) return problem(409, 'commerce_stale', error.message);
  if (error instanceof CommerceStateConflict) return problem(409, 'commerce_state_conflict', error.message);
  if (error instanceof CommerceUnavailable) return problem(503, 'commerce_unavailable', 'Commerce owner is unavailable');
  return commandError(error);
}

function idempotencyKey(request: Request): string | null {
  const key = request.headers.get('idempotency-key');
  return key && key.length <= 128 && !key.includes('\0') ? key : null;
}
const missingKey = () => problem(400, 'invalid_idempotency_key', 'A bounded idempotency key is required');
const unavailable = () => problem(503, 'commerce_unavailable', 'Commerce owner is unavailable');

/** Subscriptions, settlements and benefits; also mounts the quota and fixed-site plugins. */
export function commerceRoutes(fuseki: FusekiClient, work: MainWorkDependencies & CommerceRouteDependencies) {
  return new Elysia()
    .post('/v1/subscriptions/quotes', {
      body: quoteBody, response: { 200: quoteResult, ...writeProblems },
    }, async ({ request, body }) => {
      try {
        const principal = await work.account.verify(request, [COMMERCE_SCOPE]);
        if (!work.commerce) return unavailable();
        const key = idempotencyKey(request);
        if (!key) return missingKey();
        const { profile: _profile, ...input } = body;
        const result = await work.commerce.quote(principal, input,
          { idempotencyKey: key, requestDigest: commerceIntentDigest(body) });
        return Response.json({ profile: 'subscription-quote-v1', ...result }, noStore);
      } catch (error) { return commerceError(error); }
    })
    .post('/v1/subscriptions/changes', {
      body: changeBody, response: { 200: changeResult, ...writeProblems },
    }, async ({ request, body }) => {
      try {
        const principal = await work.account.verify(request, [COMMERCE_SCOPE]);
        if (!work.commerce) return unavailable();
        const key = idempotencyKey(request);
        if (!key) return missingKey();
        const result = await work.commerce.change(principal, body,
          { idempotencyKey: key, requestDigest: commerceIntentDigest(body) });
        return Response.json({ profile: 'subscription-change-v1', ...result }, noStore);
      } catch (error) { return commerceError(error); }
    })
    // Provider-to-Main callback: authenticated by its body signature, not an Account token.
    .post('/v1/subscriptions/settlements', {
      parse: 'text', body: t.String({ minLength: 2, maxLength: 8192 }),
      response: { 200: callbackResult, 400: problemResult(400), 401: problemResult(401),
        409: problemResult(409), 500: problemResult(500), 503: problemResult(503) },
    }, async ({ request, body }) => {
      try {
        if (!work.commerce) return unavailable();
        const result = await work.commerce.recordCallback(body,
          request.headers.get('rezics-provider-signature'));
        return Response.json({ profile: 'subscription-settlement-callback-v1', ...result }, noStore);
      } catch (error) { return commerceError(error); }
    })
    .post('/v1/subscriptions/reconciliations', {
      body: reconcileBody, response: { 200: reconcileResult, ...writeProblems },
    }, async ({ request, body }) => {
      try {
        const principal = await work.account.verify(request, [COMMERCE_SCOPE]);
        if (!work.commerce) return unavailable();
        const key = idempotencyKey(request);
        if (!key) return missingKey();
        const result = await work.commerce.reconcile(principal, body,
          { idempotencyKey: key, requestDigest: commerceIntentDigest(body) });
        return Response.json({ profile: 'subscription-reconciliation-v1', ...result }, noStore);
      } catch (error) { return commerceError(error); }
    })
    .post('/v1/subscriptions/gifts', {
      body: giftBody, response: { 200: giftResult, ...writeProblems },
    }, async ({ request, body }) => {
      try {
        const principal = await work.account.verify(request, [COMMERCE_SCOPE]);
        if (!work.commerce) return unavailable();
        const key = idempotencyKey(request);
        if (!key) return missingKey();
        const { profile: _profile, ...input } = body;
        const result = await work.commerce.gift(principal, input,
          { idempotencyKey: key, requestDigest: commerceIntentDigest(body) });
        return Response.json({ profile: 'subscription-gift-v1', ...result }, noStore);
      } catch (error) { return commerceError(error); }
    })
    .get('/v1/subscriptions/benefits', {
      query: t.Object({ beneficiary: agent }, { additionalProperties: false }),
      response: { 200: benefitResult, ...authorizedReadProblems },
    }, async ({ request, query }) => {
      try {
        const principal = await work.account.verify(request, [COMMERCE_SCOPE]);
        if (!work.commerce) return unavailable();
        const result = await work.commerce.benefits(principal, query.beneficiary);
        return Response.json({ profile: 'subscription-benefits-v1', ...result }, noStore);
      } catch (error) { return commerceError(error); }
    })
    .get('/v1/subscriptions/:subscriptionId', {
      params: t.Object({ subscriptionId: uuid }),
      response: { 200: subscriptionResult, ...authorizedReadProblems },
    }, async ({ request, params }) => {
      try {
        const principal = await work.account.verify(request, [COMMERCE_SCOPE]);
        if (!work.commerce) return unavailable();
        const result = await work.commerce.subscription(principal, params.subscriptionId);
        return Response.json({ profile: 'subscription-v1', ...result }, noStore);
      } catch (error) { return commerceError(error); }
    })
    .use(quotaRoutes(work))
    .use(fixedSiteRoutes(fuseki, work));
}

export const openApiOperations = {
  '/v1/subscriptions/{subscriptionId}': { get: { exposure: 'platform:commerce' } },
  '/v1/subscriptions/benefits': { get: { exposure: 'platform:commerce' } },
  '/v1/subscriptions/gifts': { post: { exposure: 'platform:commerce' } },
  '/v1/subscriptions/reconciliations': { post: { exposure: 'platform:commerce' } },
  '/v1/subscriptions/settlements': { post: { exposure: 'platform:commerce' } },
  '/v1/subscriptions/changes': { post: { exposure: 'platform:commerce' } },
  '/v1/subscriptions/quotes': { post: { exposure: 'platform:commerce' } },
} as const;
