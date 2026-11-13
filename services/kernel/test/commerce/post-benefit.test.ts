import { afterAll, beforeAll, expect, test } from 'bun:test';
import { createCurrentConsentReader } from '@rezics/auth/current-consent';
import { bundledRelease } from '@rezics/definitions/bundled';
import { fromPlainText } from '@rezics/document';
import { randomUUID } from 'node:crypto';
import { bootstrapLocalShowcaseBoardCreation } from '../../src/access/bootstrap-governance.ts';
import { createGrantCommands } from '../../src/access/grant-commands.ts';
import { createWriteRateLimiter } from '../../src/access/write-rate.ts';
import { checkout } from '../../src/commerce/checkout.ts';
import { createCommerceCommands } from '../../src/commerce/commands.ts';
import { createStripePort } from '../../src/commerce/stripe.ts';
import { createKernel, type Kernel } from '../../src/http/kernel.ts';
import { routeOf } from '../../src/route/route.ts';
import { bootstrapRelease, GLOBAL_CONTEXT } from '../../src/semantic/definitions.ts';
import {
  HIGH_RATE_OVERRIDES,
  seedGovernanceAuthority,
  seedResourceDenial,
} from '../content/support/disclosure-fixtures.ts';
import { createNativeContentSystem, type NativeContentSystem } from '../content/support/native-system.ts';
import { TEST_REQUEST_DEADLINE_MS } from '../support/test-kernel.ts';
import { testReceiptKeys } from '../support/receipt-keys.ts';
import { startFakeStripe } from './support/fake-stripe.ts';
import {
  createNativeEditionFixture,
  type NativeContentEdition,
  type NativeEditionRequest,
} from './support/native-edition-fixture.ts';

let native: NativeContentSystem;
let app: Kernel;
let commands: ReturnType<typeof createCommerceCommands>;
let grant: ReturnType<typeof createGrantCommands>;
let governance: Awaited<ReturnType<NativeContentSystem['auth']['issue']>>;
let fake: ReturnType<typeof startFakeStripe>;
let stripe: ReturnType<typeof createStripePort>;
let fixture: Awaited<ReturnType<typeof createNativeEditionFixture>>;

function requestAs(bearer: string | null): NativeEditionRequest {
  return (method, path, body, extraHeaders = {}) => {
    const headers = new Headers(extraHeaders);
    if (bearer) headers.set('authorization', `Bearer ${bearer}`);
    if (body !== undefined && !headers.has('content-type')) headers.set('content-type', 'application/json');
    if (method !== 'GET' && !headers.has('idempotency-key'))
      headers.set('idempotency-key', JSON.stringify(randomUUID()));
    return app.handle(
      new Request(`http://kernel.test${path}`, {
        method,
        headers,
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
    );
  };
}

async function json<T>(response: Response, status: number): Promise<T> {
  const text = await response.text();
  expect({ status: response.status, body: response.status === status ? null : text }).toEqual({ status, body: null });
  return JSON.parse(text) as T;
}

async function grantAccess(accountId: string, resource: { route: number; id: string }, actions: string[]) {
  const deadline = Date.now() + 30_000;
  const actor = await native.access.authenticate(governance.bearer, { pool: native.database.pool, deadline });
  await grant.create(
    { pool: native.database.pool, actor, deadline },
    { resource, subject: { kind: 'account', id: accountId }, actions, valid: '(,)', key: randomUUID() },
  );
}

async function grantContainerReads(edition: NativeContentEdition, accountIds: string[]) {
  for (const accountId of accountIds) {
    await seedGovernanceAuthority(native.database.pool, routeOf(edition.threadId)!, edition.threadId, accountId, [
      'thread:read',
    ]);
    await seedGovernanceAuthority(native.database.pool, routeOf(edition.boardId)!, edition.boardId, accountId, [
      'board:read',
    ]);
  }
}

async function readPost(bearer: string | null, postId: string, revisionId: string) {
  return requestAs(bearer)('GET', `/v1/posts/${postId}/revisions/${revisionId}`);
}

async function buy(offerId: string, revision: number, buyerBearer: string, orderKey = randomUUID()) {
  const deadline = Date.now() + TEST_REQUEST_DEADLINE_MS;
  const buyer = await native.access.authenticate(buyerBearer, { pool: native.database.pool, deadline });
  return checkout(
    {
      pool: native.database.pool,
      commands,
      stripe,
      successUrl: 'https://web.example.test/orders/{ORDER_ID}',
      cancelUrl: 'https://web.example.test/orders/{ORDER_ID}',
    },
    buyer,
    offerId,
    revision,
    orderKey,
  );
}

async function revise(postId: string, revisionId: string, body: string) {
  return json<{ post: { revisionId: string } }>(
    await requestAs(native.actors.author.bearer)(
      'POST',
      `/v1/posts/${postId}/revisions`,
      { body: fromPlainText(body) },
      { 'if-match': JSON.stringify(revisionId) },
    ),
    200,
  );
}

beforeAll(async () => {
  native = await createNativeContentSystem({ databaseUrl: process.env.DATABASE_URL! });
  await bootstrapRelease(native.database.pool, bundledRelease);
  const consent = createCurrentConsentReader({ database: native.database.authPool });
  const readConsent = ({ actorAccountId, clientId }: { actorAccountId: string; clientId: string }) =>
    consent.readCurrentConsent({ actorAccountId, clientId });
  app = createKernel({
    pool: native.database.pool,
    routeKey: native.routeKey,
    tokens: native.tokenKeys,
    receiptKeys: testReceiptKeys(),
    access: native.access,
    requestDeadlineMs: TEST_REQUEST_DEADLINE_MS,
    writeRate: createWriteRateLimiter({
      secret: randomUUID() + randomUUID(),
      overrides: HIGH_RATE_OVERRIDES,
    }),
    content: { readConsent },
  });
  commands = createCommerceCommands({
    clock: () => new Date(),
    pool: native.database.pool,
    access: native.access,
    readConsent,
  });
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
  await bootstrapLocalShowcaseBoardCreation(native.database.pool, governance.actor.accountId);
  await grantAccess(native.actors.author.actor.accountId, { route: 0, id: GLOBAL_CONTEXT }, [
    'board:create',
    'offer:create',
  ]);
  for (const group of ['purchases', 'selling']) {
    await json(await requestAs(governance.bearer)('POST', `/v1/platform/exposure/${group}:open`, {}), 200);
  }
  fixture = await createNativeEditionFixture(requestAs(native.actors.author.bearer), { home: 'realm' });
  fake = startFakeStripe();
  stripe = createStripePort({
    apiKey: 'sk_test_post_benefit',
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

test('one Post purchase covers eligible history and future revisions while fixed editions and native denials stay separate', async () => {
  const buyer = native.actors.other;
  const foreign = native.actors.moderator;
  const authored = await fixture.publish({
    title: 'Post-wide offer',
    subjectTitle: 'Post-wide source',
    body: 'First captured revision',
  });
  await grantContainerReads(authored, [buyer.actor.accountId, foreign.actor.accountId]);

  const postOfferResult = await json<{
    offer: {
      id: string;
      revision: number;
      contentPost: {
        benefit: { kind: string; action: string; resource: { route: number; id: string } };
        saleTermsReference: string;
        delivery: string;
        quantity: number;
      };
      contentEdition: null;
    };
  }>(
    await requestAs(native.actors.author.bearer)('POST', '/v1/offers', {
      postId: authored.postId,
      title: 'Eligible Post revisions',
      currency: 'usd',
      unitAmountMinor: 1200,
      taxCode: 'txcd_10302000',
    }),
    201,
  );
  const postOffer = postOfferResult.offer;
  expect(postOffer).toMatchObject({
    contentPost: {
      benefit: {
        kind: 'content-post',
        action: 'post:read',
        resource: { route: routeOf(authored.postId), id: authored.postId },
      },
      saleTermsReference: 'content-post-revisions-v1',
      delivery: 'eligible-post-revisions',
      quantity: 1,
    },
    contentEdition: null,
  });
  expect(JSON.stringify(postOffer.contentPost)).not.toContain(authored.revisionId);
  expect((await readPost(buyer.bearer, authored.postId, authored.revisionId)).status).toBe(404);

  const postOrderKey = randomUUID();
  const postOrder = await buy(postOffer.id, postOffer.revision, buyer.bearer, postOrderKey);
  const replay = await buy(postOffer.id, postOffer.revision, buyer.bearer, postOrderKey);
  expect(replay.id).toBe(postOrder.id);
  expect(replay.contentPost).toEqual(postOffer.contentPost);
  expect(replay.contentEdition).toBeNull();
  fake.pay(postOrder.checkoutSessionId!);
  await commands.applyCheckoutSnapshot(await stripe.readCheckout(postOrder.checkoutSessionId!), randomUUID());

  const fixedOfferResult = await json<{
    offer: {
      id: string;
      revision: number;
      contentPost: null;
      contentEdition: { benefit: { resource: { id: string }; version: { revisionId: string; sha256: string } } };
    };
  }>(
    await requestAs(native.actors.author.bearer)('POST', '/v1/offers', {
      contentEditionId: authored.contentEditionId,
      title: 'Deliberate fixed edition',
      currency: 'usd',
      unitAmountMinor: 1200,
      taxCode: 'txcd_10302000',
    }),
    201,
  );
  const fixedOffer = fixedOfferResult.offer;
  expect(fixedOffer).toMatchObject({
    contentPost: null,
    contentEdition: {
      benefit: {
        resource: { id: authored.contentEditionId },
        version: { revisionId: authored.revisionId, sha256: authored.sha256 },
      },
    },
  });
  await grantAccess(buyer.actor.accountId, { route: routeOf(fixedOffer.id)!, id: fixedOffer.id }, ['order:create']);
  expect(
    (await requestAs(buyer.bearer)('GET', `/v1/contentEditions/${authored.contentEditionId}/revision`)).status,
  ).toBe(404);
  const fixedOrder = await buy(fixedOffer.id, fixedOffer.revision, buyer.bearer);
  fake.pay(fixedOrder.checkoutSessionId!);
  await commands.applyCheckoutSnapshot(await stripe.readCheckout(fixedOrder.checkoutSessionId!), randomUUID());

  expect((await readPost(buyer.bearer, authored.postId, authored.revisionId)).status).toBe(200);
  expect((await readPost(foreign.bearer, authored.postId, authored.revisionId)).status).toBe(404);
  const orderRead = await json<{
    order: { settlement: string; contentPost: typeof postOffer.contentPost; contentEdition: null };
  }>(await requestAs(buyer.bearer)('GET', `/v1/orders/${postOrder.id}`), 200);
  expect(orderRead.order).toMatchObject({
    settlement: 'paid',
    contentPost: postOffer.contentPost,
    contentEdition: null,
  });

  const v2 = await revise(authored.postId, authored.revisionId, 'Second captured revision');
  expect((await readPost(buyer.bearer, authored.postId, authored.revisionId)).status).toBe(200);
  expect((await readPost(buyer.bearer, authored.postId, v2.post.revisionId)).status).toBe(200);
  const v3 = await revise(authored.postId, v2.post.revisionId, 'Third future revision');
  for (const revisionId of [authored.revisionId, v2.post.revisionId, v3.post.revisionId]) {
    expect((await readPost(buyer.bearer, authored.postId, revisionId)).status).toBe(200);
  }
  const fixedRead = await json<{ editionId: string; revisionId: string; sha256: string }>(
    await requestAs(buyer.bearer)('GET', `/v1/contentEditions/${authored.contentEditionId}/revision`),
    200,
  );
  expect(fixedRead).toMatchObject({
    editionId: authored.contentEditionId,
    revisionId: authored.revisionId,
    sha256: authored.sha256,
  });

  const unrelated = await fixture.publish({ title: 'Another Post', body: 'Not covered by this purchase' });
  await grantContainerReads(unrelated, [buyer.actor.accountId]);
  expect((await readPost(buyer.bearer, unrelated.postId, unrelated.revisionId)).status).toBe(404);
  const draft = await json<{ thread: { id: string; firstPost: { id: string; revisionId: string } } }>(
    await requestAs(native.actors.author.bearer)('POST', '/v1/threads', {
      title: 'Unpublished draft',
      body: fromPlainText('Draft bytes remain private'),
      licence: 'CC0-1.0',
      subjectIds: [authored.targetSubjectId],
      boardId: authored.boardId,
      visibility: 'draft',
    }),
    201,
  );
  await seedGovernanceAuthority(
    native.database.pool,
    routeOf(draft.thread.id)!,
    draft.thread.id,
    buyer.actor.accountId,
    ['thread:read'],
  );
  expect((await readPost(buyer.bearer, draft.thread.firstPost.id, draft.thread.firstPost.revisionId)).status).toBe(404);

  await seedResourceDenial(native.database.pool, routeOf(authored.postId)!, authored.postId, buyer.actor.accountId, [
    'post:read',
  ]);
  for (const revisionId of [authored.revisionId, v2.post.revisionId, v3.post.revisionId]) {
    expect((await readPost(buyer.bearer, authored.postId, revisionId)).status).toBe(404);
  }
  await native.database.pool.query(
    `DELETE FROM access.resource_denial
     WHERE route=$1 AND resource_id=$2 AND subject_id=$3 AND subject_role='' AND action='post:read' AND reason='resource'`,
    [routeOf(authored.postId), authored.postId, buyer.actor.accountId],
  );
  expect((await readPost(buyer.bearer, authored.postId, v3.post.revisionId)).status).toBe(200);

  fake.refundRemaining(postOrder.checkoutSessionId!, 'remaining');
  await commands.applyCheckoutSnapshot(await stripe.readCheckout(postOrder.checkoutSessionId!), randomUUID());
  for (const revisionId of [authored.revisionId, v2.post.revisionId, v3.post.revisionId]) {
    expect((await readPost(buyer.bearer, authored.postId, revisionId)).status).toBe(404);
  }
  expect(
    await json<{ editionId: string; revisionId: string }>(
      await requestAs(buyer.bearer)('GET', `/v1/contentEditions/${authored.contentEditionId}/revision`),
      200,
    ),
  ).toMatchObject({ editionId: authored.contentEditionId, revisionId: authored.revisionId });
});
