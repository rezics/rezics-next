import { afterAll, beforeAll, expect, test } from 'bun:test';
import { createCurrentConsentReader } from '@rezics/auth/current-consent';
import { bundledRelease } from '@rezics/definitions/bundled';
import { fromPlainText } from '@rezics/document';
import { createGrantCommands } from '../../src/access/grant-commands.ts';
import { checkout } from '../../src/commerce/checkout.ts';
import { createCommerceCommands } from '../../src/commerce/commands.ts';
import { createStripePort } from '../../src/commerce/stripe.ts';
import { createKernel, type Kernel } from '../../src/http/kernel.ts';
import { deadlineFor } from '../../src/request/deadline.ts';
import { routeOf } from '../../src/route/route.ts';
import { bootstrapRelease, GLOBAL_CONTEXT } from '../../src/semantic/definitions.ts';
import { createNativeContentSystem, type NativeContentSystem } from '../content/support/native-system.ts';
import { testReceiptKeys } from '../support/receipt-keys.ts';
import { startFakeStripe } from './support/fake-stripe.ts';
import { createNativeEditionFixture, type NativeContentEdition, type NativeEditionRequest } from './support/native-edition-fixture.ts';

let native: NativeContentSystem;
let app: Kernel;
let commands: ReturnType<typeof createCommerceCommands>;
let grant: ReturnType<typeof createGrantCommands>;
let governance: Awaited<ReturnType<NativeContentSystem['auth']['issue']>>;
let fake: ReturnType<typeof startFakeStripe>;
let stripe: ReturnType<typeof createStripePort>;
let editions: Awaited<ReturnType<typeof createNativeEditionFixture>>;

function requestAs(bearer: string | null): NativeEditionRequest {
  return (method, path, body, extraHeaders = {}) => {
    const headers = new Headers(extraHeaders);
    if (bearer) headers.set('authorization', `Bearer ${bearer}`);
    if (body !== undefined && !headers.has('content-type')) headers.set('content-type', 'application/json');
    if (method !== 'GET' && !headers.has('idempotency-key')) headers.set('idempotency-key', JSON.stringify(crypto.randomUUID()));
    return app.handle(
      new Request(`http://kernel.test${path}`, {
        method,
        headers,
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
    );
  };
}

async function grantAccess(accountId: string, resource: { route: number; id: string }, actions: string[]) {
  await grant.create(
    { pool: native.database.pool, actor: governance.actor, deadline: deadlineFor(30_000) },
    { resource, subject: { kind: 'account', id: accountId }, actions, valid: '(,)', key: crypto.randomUUID() },
  );
}

async function json<T>(response: Response, status: number): Promise<T> {
  const text = await response.text();
  expect({ status: response.status, body: response.status === status ? null : text }).toEqual({ status, body: null });
  return JSON.parse(text) as T;
}

async function purchase(edition: NativeContentEdition) {
  const buyer = native.actors.other;
  const offer = (
    await commands.createOffer(
      native.actors.author.actor,
      {
        contentEditionId: edition.contentEditionId,
        targetSubjectId: edition.targetSubjectId,
        title: edition.title,
        currency: 'usd',
        unitAmountMinor: 1200,
        taxCode: 'txcd_10302000',
      },
      crypto.randomUUID(),
    )
  ).value;
  await grantAccess(buyer.actor.accountId, { route: routeOf(offer.id)!, id: offer.id }, ['order:create']);
  const order = await checkout(
    {
      pool: native.database.pool,
      commands,
      stripe,
      successUrl: 'https://web.example.test/orders/{ORDER_ID}',
      cancelUrl: 'https://web.example.test/orders/{ORDER_ID}',
    },
    buyer.actor,
    offer.id,
    offer.revision,
    crypto.randomUUID(),
  );
  fake.pay(order.checkoutSessionId!);
  await commands.applyCheckoutSnapshot(await stripe.readCheckout(order.checkoutSessionId!), crypto.randomUUID());
  return { offer, order };
}

async function protectedRevision(bearer: string | null, edition: NativeContentEdition) {
  return requestAs(bearer)('GET', `/v1/contentEditions/${edition.contentEditionId}/revision`);
}

beforeAll(async () => {
  native = await createNativeContentSystem({ databaseUrl: process.env.DATABASE_URL! });
  await bootstrapRelease(native.database.pool, bundledRelease);
  const consent = createCurrentConsentReader({ database: native.database.authPool });
  app = createKernel({
    pool: native.database.pool,
    routeKey: native.routeKey,
    tokens: native.tokenKeys,
    receiptKeys: testReceiptKeys(),
    access: native.access,
    content: {
      readConsent: ({ actorAccountId, clientId }) => consent.readCurrentConsent({ actorAccountId, clientId }),
    },
  });
  commands = createCommerceCommands({ pool: native.database.pool, access: native.access });

  const bootstrap = await native.database.pool.query<{ accountId: string }>(
    'SELECT account_id::text AS "accountId" FROM access.governance_bootstrap',
  );
  const governanceId = bootstrap.rows[0]?.accountId;
  if (!governanceId) throw new Error('Native governance account is missing');
  governance = await native.auth.issue({
    accountId: governanceId,
    clientId: native.auth.ordinaryClient.id,
    scopes: native.auth.ordinaryScopes,
  });
  grant = createGrantCommands({ pool: native.database.pool, access: native.access, managementAction: 'access:grant' });
  await grantAccess(native.actors.author.actor.accountId, GLOBAL_CONTEXT, ['subject:create', 'board:create', 'offer:create']);
  for (const group of ['purchases', 'selling']) {
    expect((await requestAs(governance.bearer)('POST', `/v1/platform/exposure/${group}:open`)).status).toBe(200);
  }
  editions = await createNativeEditionFixture(requestAs(native.actors.author.bearer));
  fake = startFakeStripe();
  stripe = createStripePort({
    apiKey: 'sk_test_paid_content_journey',
    managedPayments: false,
    host: '127.0.0.1',
    port: fake.port,
    protocol: 'http',
    maxNetworkRetries: 0,
    timeoutMs: 1000,
    clock: () => new Date(),
  });
}, 120_000);

afterAll(async () => {
  fake?.stop();
  await native?.close();
});

test('paid Content editions navigate to exact captured bytes and lose access only after independent refund or Source loss', async () => {
  const buyer = native.actors.other;
  const foreign = native.actors.moderator;
  const authored = await editions.publish({
    title: 'Paid edition',
    subjectTitle: 'Paid edition source',
    body: 'Exact paid edition bytes',
  });
  const paid = await purchase(authored);

  const orderRead = await json<{ order: { id: string; offerId: string; settlement: string; entitlementId: string | null } }>(
    await requestAs(buyer.bearer)('GET', `/v1/orders/${paid.order.id}`),
    200,
  );
  expect(orderRead.order).toMatchObject({
    id: paid.order.id,
    offerId: paid.offer.id,
    settlement: 'paid',
    entitlementId: expect.any(String),
  });
  const owned = await json<{ entitlements: { id: string; orderId: string; targetSubjectId: string; active: boolean }[] }>(
    await requestAs(buyer.bearer)('GET', '/v1/entitlements'),
    200,
  );
  expect(owned.entitlements).toContainEqual(
    expect.objectContaining({
      id: orderRead.order.entitlementId,
      orderId: paid.order.id,
      targetSubjectId: authored.targetSubjectId,
      active: true,
    }),
  );

  const read = await json<{ editionId: string; revisionId: string; sha256: string; body: unknown }>(
    await protectedRevision(buyer.bearer, authored),
    200,
  );
  expect(read).toMatchObject({
    editionId: authored.contentEditionId,
    revisionId: authored.revisionId,
    sha256: authored.sha256,
    body: authored.body,
  });
  expect((await protectedRevision(foreign.bearer, authored)).status).toBe(404);
  expect((await protectedRevision(null, authored)).status).toBe(401);

  const newer = await json<{ post: { revisionId: string } }>(
    await requestAs(native.actors.author.bearer)('POST', `/v1/posts/${authored.postId}/revisions`, {
      body: fromPlainText('Newer source publication bytes'),
    }, { 'if-match': JSON.stringify(authored.revisionId) }),
    201,
  );
  const newerDraft = await json<{ editionId: string; editionRevision: string }>(
    await requestAs(native.actors.author.bearer)(
      'POST',
      '/v1/contentEditions',
      { postId: authored.postId, revisionId: newer.post.revisionId, targetSubjectId: authored.targetSubjectId },
    ),
    201,
  );
  await json(
    await requestAs(native.actors.author.bearer)(
      'POST',
      `/v1/contentEditions/${newerDraft.editionId}:publish`,
      {},
      { 'if-match': JSON.stringify(newerDraft.editionRevision) },
    ),
    200,
  );
  expect(
    await json<{ editionId: string; revisionId: string; sha256: string; body: unknown }>(
      await protectedRevision(buyer.bearer, authored),
      200,
    ),
  ).toMatchObject({
    editionId: authored.contentEditionId,
    revisionId: authored.revisionId,
    sha256: authored.sha256,
    body: authored.body,
  });

  const refundedEdition = await editions.publish({
    title: 'Refunded edition',
    subjectTitle: 'Refunded source',
    body: 'Independently paid before refund',
  });
  const refunded = await purchase(refundedEdition);
  expect((await protectedRevision(buyer.bearer, refundedEdition)).status).toBe(200);
  fake.refundRemaining(refunded.order.checkoutSessionId!, 'remaining');
  await commands.applyCheckoutSnapshot(await stripe.readCheckout(refunded.order.checkoutSessionId!), crypto.randomUUID());
  expect((await protectedRevision(buyer.bearer, refundedEdition)).status).toBe(404);

  const sourceLostEdition = await editions.publish({
    title: 'Source loss edition',
    subjectTitle: 'Source loss source',
    body: 'Independently paid before Source removal',
  });
  await purchase(sourceLostEdition);
  expect((await protectedRevision(buyer.bearer, sourceLostEdition)).status).toBe(200);
  expect(
    (await requestAs(native.actors.author.bearer)('DELETE', `/v1/posts/${sourceLostEdition.postId}`)).status,
  ).toBe(200);
  expect((await protectedRevision(buyer.bearer, sourceLostEdition)).status).toBe(404);
});
