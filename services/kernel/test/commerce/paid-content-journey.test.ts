import { afterAll, beforeAll, expect, test } from 'bun:test';
import { createCurrentConsentReader } from '@rezics/auth/current-consent';
import { bundledRelease } from '@rezics/definitions/bundled';
import { fromPlainText } from '@rezics/document';
import { bootstrapLocalShowcaseBoardCreation } from '../../src/access/bootstrap-governance.ts';
import { createGrantCommands } from '../../src/access/grant-commands.ts';
import { createWriteRateLimiter } from '../../src/access/write-rate.ts';
import { checkout } from '../../src/commerce/checkout.ts';
import { createCommerceCommands } from '../../src/commerce/commands.ts';
import type { SubjectOffersPage } from '../../src/commerce/model.ts';
import { projectSubjectOffer } from '../../src/commerce/subject-offer-work.ts';
import { createStripePort } from '../../src/commerce/stripe.ts';
import { createKernel, realmAwareContentAccess, type Kernel } from '../../src/http/kernel.ts';
import { prepareContentEditionSale } from '../../src/content/edition-sale.ts';
import { permissionEvidenceDeadline } from '../../src/content/access-port.ts';
import { editionSnapshot, withEditionReadTime } from '../../src/content/edition-store.ts';
import { deadlineFor, withRequestDeadline } from '../../src/request/deadline.ts';
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
let editions: Awaited<ReturnType<typeof createNativeEditionFixture>>;

function requestAs(bearer: string | null): NativeEditionRequest {
  return (method, path, body, extraHeaders = {}) => {
    const headers = new Headers(extraHeaders);
    if (bearer) headers.set('authorization', `Bearer ${bearer}`);
    if (body !== undefined && !headers.has('content-type')) headers.set('content-type', 'application/json');
    if (method !== 'GET' && !headers.has('idempotency-key'))
      headers.set('idempotency-key', JSON.stringify(crypto.randomUUID()));
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
  const deadline = deadlineFor(30_000);
  const actor = await native.access.authenticate(governance.bearer, { pool: native.database.pool, deadline });
  await grant.create(
    { pool: native.database.pool, actor, deadline },
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
  const deadline = deadlineFor(TEST_REQUEST_DEADLINE_MS);
  const seller = await native.access.authenticate(native.actors.author.bearer, {
    pool: native.database.pool,
    deadline,
  });
  const created = (
    await withRequestDeadline(deadline, () =>
      commands.createOffer(
        seller,
        {
          contentEditionId: edition.contentEditionId,
          targetSubjectId: edition.targetSubjectId,
          title: edition.title,
          currency: 'usd',
          unitAmountMinor: 1200,
          taxCode: 'txcd_10302000',
        },
        crypto.randomUUID(),
      ),
    ).catch((cause: unknown) => {
      throw new Error('Native journey offer:create admission failed before discovery', { cause });
    })
  ).value;
  // Parent readability is separate from entitlement to the captured edition bytes.
  await seedGovernanceAuthority(
    native.database.pool,
    routeOf(edition.threadId)!,
    edition.threadId,
    buyer.actor.accountId,
    ['thread:read'],
  );
  await seedGovernanceAuthority(
    native.database.pool,
    routeOf(edition.boardId)!,
    edition.boardId,
    buyer.actor.accountId,
    ['board:read'],
  );
  await projectSubjectOffer(native.database.pool, created.id, deadlineFor(30_000));
  const discovered = await json<SubjectOffersPage>(
    await requestAs(buyer.bearer)('GET', `/v1/subjects/${edition.targetSubjectId}/offers`),
    200,
  );
  expect(discovered.offers).toHaveLength(1);
  const offer = discovered.offers[0]!;
  expect(offer).toMatchObject({
    id: created.id,
    revision: created.revision,
    targetSubjectId: edition.targetSubjectId,
    currency: 'usd',
    unitAmountMinor: 1200,
    contentEdition: {
      benefit: {
        resource: { id: edition.contentEditionId },
        version: { revisionId: edition.revisionId, sha256: edition.sha256 },
      },
    },
  });
  expect((await protectedRevision(buyer.bearer, edition)).status).toBe(404);
  await grantAccess(buyer.actor.accountId, { route: routeOf(offer.id)!, id: offer.id }, ['order:create']);
  // Native actors are bounded to the authentication operation's deadline.
  const checkoutActor = await native.access.authenticate(buyer.bearer, {
    pool: native.database.pool,
    deadline: deadlineFor(TEST_REQUEST_DEADLINE_MS),
  });
  const order = await checkout(
    {
      pool: native.database.pool,
      commands,
      stripe,
      successUrl: 'https://web.example.test/orders/{ORDER_ID}',
      cancelUrl: 'https://web.example.test/orders/{ORDER_ID}',
    },
    checkoutActor,
    offer.id,
    offer.revision,
    crypto.randomUUID(),
  );
  expect(order.offerRevision).toBe(offer.revision);
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
      secret: crypto.randomUUID() + crypto.randomUUID(),
      overrides: HIGH_RATE_OVERRIDES,
    }),
    content: {
      readConsent,
    },
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
  editions = await createNativeEditionFixture(requestAs(native.actors.author.bearer), { home: 'realm' });
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

test('Realm adapter preserves native permission evidence and a current Realm denial', async () => {
  // This case installs a current Realm denial; give it a separate home.
  const fixture = await createNativeEditionFixture(requestAs(native.actors.author.bearer), { home: 'realm' });
  const edition = await fixture.publish({ title: 'Realm evidence', body: 'Protected adapter source' });
  const resource = { route: routeOf(edition.threadId)!, id: edition.threadId };
  const access = realmAwareContentAccess(native.access);
  const dependencies = { pool: native.database.pool, clock: () => new Date() };
  const decide = async () => {
    const deadline = deadlineFor(30_000);
    const actor = await native.access.authenticate(native.actors.author.bearer, { pool: dependencies.pool, deadline });
    return withEditionReadTime(dependencies, { deadline }, async (time) => {
      const context = { pool: dependencies.pool, deadline, time };
      const prepare = native.access.prepare!;
      let primary: unknown;
      native.access.prepare = async (...args) => {
        const evidence = await prepare(...args);
        if (args[1] === 'thread:read') primary = evidence;
        return evidence;
      };
      let evidence: unknown;
      try {
        evidence = await access.prepare!(actor, 'thread:read', resource, context);
      } finally {
        native.access.prepare = prepare;
      }
      expect(evidence).toBe(primary);
      expect(permissionEvidenceDeadline(evidence)).toBeGreaterThan(Date.now());
      return (
        await editionSnapshot(dependencies, resource.id, { deadline }, async (client) => {
          expect(await native.access.authorize(client, actor, 'thread:read', resource, primary, time)).toBe(true);
          return access.authorize(client, actor, 'thread:read', resource, evidence, time);
        })
      ).value;
    });
  };
  expect(await decide()).toBe(true);
  const realm = await dependencies.pool.query<{ realm_id: string }>(
    'SELECT realm_id FROM content.board WHERE route=$1 AND board_id=$2',
    [routeOf(edition.boardId), edition.boardId],
  );
  const realmId = realm.rows[0]!.realm_id;
  await seedResourceDenial(dependencies.pool, routeOf(realmId)!, realmId, native.actors.author.actor.accountId, [
    'realm:read',
  ]);
  expect(await decide()).toBe(false);
});

test('publisher restoration preserves exact actions and the buyer Realm denial', async () => {
  const fixture = await createNativeEditionFixture(requestAs(native.actors.author.bearer), { home: 'realm' });
  const edition = await fixture.publish({ title: 'Publisher binding', body: 'Independently restored source' });
  const pool = native.database.pool;
  const buyer = native.actors.other;
  for (const [id, action] of [
    [edition.threadId, 'thread:read'],
    [edition.boardId, 'board:read'],
  ] as const) {
    await seedGovernanceAuthority(pool, routeOf(id)!, id, buyer.actor.accountId, [action]);
  }
  const consent = createCurrentConsentReader({ database: native.database.authPool });
  const dependencies = {
    pool,
    clock: () => new Date(),
    access: realmAwareContentAccess(native.access),
    editionPublisherAccess: native.access,
    readConsent: ({ actorAccountId, clientId }: { actorAccountId: string; clientId: string }) =>
      consent.readCurrentConsent({ actorAccountId, clientId }),
  };
  const prepare = async () => {
    const deadline = deadlineFor(1000);
    const actor = await native.access.authenticate(buyer.bearer, { pool, deadline });
    return withEditionReadTime(dependencies, { deadline }, async (time) => {
      const sale = await prepareContentEditionSale(dependencies, edition.contentEditionId, { actor, deadline }, time);
      return sale && (await sale.final()) ? sale.authority : null;
    });
  };
  expect((await prepare())?.benefit.version).toEqual({ revisionId: edition.revisionId, sha256: edition.sha256 });
  const realm = await pool.query<{ realm_id: string }>(
    'SELECT realm_id FROM content.board WHERE route=$1 AND board_id=$2',
    [routeOf(edition.boardId), edition.boardId],
  );
  const realmId = realm.rows[0]!.realm_id;
  await seedResourceDenial(pool, routeOf(realmId)!, realmId, buyer.actor.accountId, ['realm:read']);
  expect(await prepare()).toBeNull();
});

test('publicly discovered paid Content editions navigate to exact captured bytes and lose access only after independent refund or Source loss', async () => {
  const buyer = native.actors.other;
  const foreign = native.actors.moderator;
  const authored = await editions.publish({
    title: 'Paid edition',
    subjectTitle: 'Paid edition source',
    body: 'Exact paid edition bytes',
  });
  const paid = await purchase(authored);

  const orderRead = await json<{
    order: {
      id: string;
      offerId: string;
      settlement: string;
      entitlementId: string | null;
      contentEdition: SubjectOffersPage['offers'][number]['contentEdition'];
    };
  }>(await requestAs(buyer.bearer)('GET', `/v1/orders/${paid.order.id}`), 200);
  expect(orderRead.order).toMatchObject({
    id: paid.order.id,
    offerId: paid.offer.id,
    contentEdition: paid.offer.contentEdition,
    settlement: 'paid',
    entitlementId: expect.any(String),
  });
  const owned = await json<{
    entitlements: { id: string; orderId: string; targetSubjectId: string; active: boolean }[];
  }>(await requestAs(buyer.bearer)('GET', '/v1/entitlements'), 200);
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
    await requestAs(native.actors.author.bearer)(
      'POST',
      `/v1/posts/${authored.postId}/revisions`,
      {
        body: fromPlainText('Newer source publication bytes'),
      },
      { 'if-match': JSON.stringify(authored.revisionId) },
    ),
    200,
  );
  const newerDraft = await json<{ editionId: string; editionRevision: string }>(
    await requestAs(native.actors.author.bearer)('POST', '/v1/contentEditions', {
      postId: authored.postId,
      revisionId: newer.post.revisionId,
      targetSubjectId: authored.targetSubjectId,
    }),
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
  await commands.applyCheckoutSnapshot(
    await stripe.readCheckout(refunded.order.checkoutSessionId!),
    crypto.randomUUID(),
  );
  expect((await protectedRevision(buyer.bearer, refundedEdition)).status).toBe(404);

  const sourceLostEdition = await editions.publish({
    title: 'Source loss edition',
    subjectTitle: 'Source loss source',
    body: 'Independently paid before Source removal',
  });
  await purchase(sourceLostEdition);
  expect((await protectedRevision(buyer.bearer, sourceLostEdition)).status).toBe(200);
  expect((await requestAs(native.actors.author.bearer)('DELETE', `/v1/posts/${sourceLostEdition.postId}`)).status).toBe(
    204,
  );
  expect((await protectedRevision(buyer.bearer, sourceLostEdition)).status).toBe(404);
});
