import { afterAll, beforeAll, expect, test } from 'bun:test';
import { createCurrentConsentReader } from '@rezics/auth/current-consent';
import { bundledRelease } from '@rezics/definitions/bundled';
import { fromPlainText } from '@rezics/document';
import { randomUUID } from 'node:crypto';
import { GrantDeniedError } from '../../src/access/grant-commands.ts';
import { IdempotencyConflictError } from '../../src/command/command.ts';
import { checkout } from '../../src/commerce/checkout.ts';
import { createCommerceCommands, OfferRevisionConflictError } from '../../src/commerce/commands.ts';
import { ContentEditionUnavailableError } from '../../src/commerce/benefit.ts';
import { StripeUnavailableError, type Offer } from '../../src/commerce/model.ts';
import { createStripePort } from '../../src/commerce/stripe.ts';
import { createKernel } from '../../src/http/kernel.ts';
import { newId, routeOf } from '../../src/route/route.ts';
import { bootstrapRelease, GLOBAL_CONTEXT } from '../../src/semantic/definitions.ts';
import {
  contentGovernanceCredential,
  createContentSystem,
  type ContentCredential,
  type ContentSystem,
} from '../content/support/system.ts';
import { testReceiptKeys } from '../support/receipt-keys.ts';
import { startFakeStripe } from './support/fake-stripe.ts';
import { retainPreRevisionOrder } from './support/legacy-order-receipts.ts';

let system: ContentSystem;
let app: ReturnType<typeof createKernel>;
let commands: ReturnType<typeof createCommerceCommands>;
let governance: ContentCredential;
let fake: ReturnType<typeof startFakeStripe>;
let offer: Offer;
let second: Offer;
let editionId: string;
const seller = () => system.actors.author;
const buyer = () => system.actors.other;

async function wire(person: ContentCredential, path: string, method = 'POST', body: unknown = {}, revision?: string) {
  return app.handle(
    new Request(`https://content.test${path}`, {
      method,
      headers: {
        authorization: `Bearer ${person.bearer}`,
        'content-type': 'application/json',
        'idempotency-key': JSON.stringify(randomUUID()),
        ...(revision ? { 'if-match': JSON.stringify(revision) } : {}),
      },
      ...(method === 'GET' ? {} : { body: JSON.stringify(body) }),
    }),
  );
}
async function value<T>(response: Promise<Response>, status = 201): Promise<T> {
  const result = await response;
  const body = await result.json();
  expect({ status: result.status, error: result.status === status ? null : body }).toEqual({ status, error: null });
  return body as T;
}

beforeAll(async () => {
  // Reuse native Auth registration, governance and Content APIs. Only the old
  // immutable order/receipt are fixture data; today's sale authority is real.
  system = await createContentSystem({ databaseUrl: process.env.DATABASE_URL! });
  const pool = system.database.pool;
  await bootstrapRelease(pool, bundledRelease);
  const consent = createCurrentConsentReader({ database: system.database.authPool });
  app = createKernel({
    pool,
    routeKey: system.routeKey,
    tokens: system.tokenKeys,
    receiptKeys: testReceiptKeys(),
    access: system.access,
    content: {
      readConsent: ({ actorAccountId, clientId }) => consent.readCurrentConsent({ actorAccountId, clientId }),
    },
  });
  commands = createCommerceCommands({ clock: () => new Date(), pool, access: system.access });
  governance = await contentGovernanceCredential(system);
  for (const group of ['selling', 'purchases'])
    await value(wire(governance, `/v1/platform/exposure/${group}:open`), 200);
  await value(
    wire(governance, '/v1/grants', 'POST', {
      resource: { route: 0, id: GLOBAL_CONTEXT },
      subject: { kind: 'account', id: seller().actor.accountId },
      actions: ['offer:create'],
      valid: '(,)',
    }),
  );
  const scheme = await value<{ subject: { id: string } }>(
    wire(seller(), '/v1/subjects', 'POST', {
      type: 'skos:ConceptScheme',
      labels: { en: 'Historical order subjects' },
    }),
  );
  const subject = await value<{ subject: { id: string } }>(
    wire(seller(), '/v1/subjects', 'POST', {
      type: 'skos:Concept',
      labels: { en: 'Native edition' },
      statements: {
        'skos:inScheme': [
          {
            property: { id: 'skos:inScheme' },
            value: { type: 'value', content: scheme.subject.id },
          },
        ],
      },
    }),
  );
  const space = await value<{ space: { spaceId: string } }>(
    wire(seller(), '/v1/spaces', 'POST', { title: 'Sale home' }),
  );
  const realm = await value<{ realm: { realmId: string; headRevisionId: string } }>(
    wire(seller(), '/v1/realms', 'POST', {
      spaceId: space.space.spaceId,
      title: 'Sale realm',
      visibility: 'public',
      contextId: GLOBAL_CONTEXT,
    }),
  );
  await value(
    wire(
      seller(),
      `/v1/realms/${realm.realm.realmId}/boardScheme`,
      'PUT',
      {
        schemeId: scheme.subject.id,
      },
      realm.realm.headRevisionId,
    ),
    200,
  );
  const board = await value<{ board: { id: string } }>(
    wire(seller(), `/v1/realms/${realm.realm.realmId}/boards`, 'POST', {
      conceptId: subject.subject.id,
      title: 'Sale board',
      visibility: 'published',
    }),
  );
  const source = await value<{ thread: { id: string; firstPost: { id: string; revisionId: string } } }>(
    wire(seller(), '/v1/threads', 'POST', {
      title: 'Native source',
      body: fromPlainText('Immutable sale revision'),
      licence: 'CC0-1.0',
      subjectIds: [subject.subject.id],
      boardId: board.board.id,
      visibility: 'published',
    }),
  );
  const edition = await value<{ editionId: string }>(
    wire(seller(), '/v1/contentEditions', 'POST', {
      postId: source.thread.firstPost.id,
      revisionId: source.thread.firstPost.revisionId,
      targetSubjectId: subject.subject.id,
    }),
  );
  editionId = edition.editionId;
  await value(wire(seller(), `/v1/contentEditions/${editionId}:publish`, 'POST', {}, '1'), 200);
  const terms = {
    contentEditionId: editionId,
    title: 'Captured sale',
    currency: 'usd',
    unitAmountMinor: 1200,
    taxCode: 'txcd_10302000',
  };
  offer = (await commands.createOffer(seller().actor, terms, randomUUID())).value;
  second = (await commands.createOffer(seller().actor, { ...terms, title: 'Another native offer' }, randomUUID()))
    .value;
  expect(routeOf(offer.id)).toBe(routeOf(second.id));
  fake = startFakeStripe();
}, 120_000);

afterAll(async () => {
  fake?.stop();
  await system?.close();
});

async function footprint() {
  const pool = system.database.pool;
  return {
    orders: (await pool.query('SELECT to_jsonb(o) AS row FROM commerce.purchase_order o ORDER BY route,order_id')).rows,
    receipts: (
      await pool.query(
        'SELECT to_jsonb(r) AS row FROM core.receipt r ORDER BY partition_no,principal_id,command_kind,idempotency_key',
      )
    ).rows,
    events: (await pool.query('SELECT to_jsonb(e) AS row FROM core.outbox e ORDER BY partition_no,position,event_seq'))
      .rows,
    attempts: (
      await pool.query('SELECT to_jsonb(a) AS row FROM commerce.checkout_creation_attempt a ORDER BY route,order_id')
    ).rows,
    acquisitions: (
      await pool.query(
        'SELECT to_jsonb(a) AS row FROM commerce.benefit_acquisition a ORDER BY route,buyer_account_id,slot_id',
      )
    ).rows,
    entitlements: (
      await pool.query('SELECT to_jsonb(e) AS row FROM commerce.entitlement e ORDER BY route,entitlement_id')
    ).rows,
    transactions: (
      await pool.query(
        'SELECT to_jsonb(t) AS row FROM commerce.order_transaction t ORDER BY route,order_id,balance_transaction_id',
      )
    ).rows,
    provider: fake.requests.length,
  };
}

test('A retained pre-revision order receipt can replay only its exact captured offer revision after full current authorization and can never create an old-format fresh order', async () => {
  const historical = await retainPreRevisionOrder(system.database.pool, buyer().actor, offer, randomUUID(), true);
  const revised = await commands.reviseOffer(seller().actor, offer.id, { unitAmountMinor: 2400 }, randomUUID());
  const before = await footprint();
  expect(await commands.createOrder(buyer().actor, offer.id, offer.revision, historical.key)).toEqual(
    historical.replay,
  );
  await expect(
    commands.createOrder(buyer().actor, offer.id, revised.value.revision, historical.key),
  ).rejects.toBeInstanceOf(IdempotencyConflictError);
  await expect(commands.createOrder(buyer().actor, second.id, second.revision, historical.key)).rejects.toBeInstanceOf(
    IdempotencyConflictError,
  );
  // No legacy receipt exists for the new key: the normal fresh revision guard remains mandatory.
  await expect(commands.createOrder(buyer().actor, offer.id, offer.revision, randomUUID())).rejects.toBeInstanceOf(
    OfferRevisionConflictError,
  );
  await expect(
    commands.createOrder(buyer().actor, offer.id, undefined as never, historical.key),
  ).rejects.toBeInstanceOf(TypeError);
  expect(await footprint()).toEqual(before);
  // This real buyer has no unresolved acquisition of the historical buyer's exact benefit.
  const fresh = await commands.createOrder(
    system.actors.moderator.actor,
    offer.id,
    revised.value.revision,
    randomUUID(),
  );
  expect(fresh.value).toMatchObject({ offerRevision: revised.value.revision, unitAmountMinor: 2400 });
  expect(fresh.value.contentEdition).toEqual(offer.contentEdition);
  expect(historical.replay.value.contentEdition).toEqual(offer.contentEdition);
}, 120_000);

test('modern receipt conflicts stay conflicts and foreign principal or key cannot disclose historical native responses', async () => {
  const key = randomUUID();
  const modernBuyer = seller().actor;
  const modern = await commands.createOrder(modernBuyer, second.id, second.revision, key);
  const historical = await retainPreRevisionOrder(system.database.pool, buyer().actor, second);
  // A second real principal may buy the same offer but cannot see this buyer's receipt.
  const before = await footprint();
  expect(await commands.createOrder(modernBuyer, second.id, second.revision, key)).toEqual({
    ...modern,
    replayed: true,
  });
  await expect(commands.createOrder(modernBuyer, second.id, second.revision + 1, key)).rejects.toBeInstanceOf(
    IdempotencyConflictError,
  );
  await expect(
    commands.createOrder(seller().actor, second.id, second.revision + 1, historical.key),
  ).rejects.toBeInstanceOf(OfferRevisionConflictError);
  await expect(
    commands.createOrder(buyer().actor, second.id, second.revision + 1, randomUUID()),
  ).rejects.toBeInstanceOf(OfferRevisionConflictError);
  expect(await footprint()).toEqual(before);
}, 120_000);

test('historical replay retains UNKNOWN benefit and current checkout state while unavailable sale truth and revoked buyer never create a charge', async () => {
  const pool = system.database.pool;
  const historical = await retainPreRevisionOrder(pool, buyer().actor, second);
  await commands.recordCheckout(historical.order.id, {
    session: { id: 'cs_retained_native', url: 'https://checkout.test/retained', expiresAt: '2026-01-02T00:00:00.000Z' },
  });
  // Delisting and native unpublication affect fresh sales, not immutable receipt identity.
  await commands.delistOffer(seller().actor, second.id, randomUUID());
  await value(wire(seller(), `/v1/contentEditions/${editionId}:unpublish`, 'POST', {}, '2'), 200);
  const stripe = createStripePort({
    apiKey: 'sk_test_old_receipt',
    managedPayments: false,
    host: '127.0.0.1',
    port: fake.port,
    protocol: 'http',
    maxNetworkRetries: 0,
    timeoutMs: 1000,
    clock: () => new Date(),
  });
  const dependencies = {
    pool,
    commands,
    stripe,
    successUrl: 'https://web.test/success',
    cancelUrl: 'https://web.test/cancel',
  };
  const ambiguous = await retainPreRevisionOrder(pool, buyer().actor, second);
  const providerBefore = fake.requests.length;
  await expect(checkout(dependencies, buyer().actor, second.id, second.revision, ambiguous.key)).rejects.toBeInstanceOf(
    StripeUnavailableError,
  );
  expect(await commands.readOrderForAccount(buyer().actor.accountId, ambiguous.order.id)).toMatchObject({
    settlement: 'unknown',
    contentEdition: null,
    moneyUnit: null,
    taxBehavior: null,
    checkoutSessionId: null,
  });
  expect(
    (
      await pool.query('SELECT order_id FROM commerce.checkout_creation_attempt WHERE route=$1 AND order_id=$2', [
        routeOf(ambiguous.order.id),
        ambiguous.order.id,
      ])
    ).rows,
  ).toEqual([]);
  expect(fake.requests.length).toBe(providerBefore);
  expect(await commands.createOrder(buyer().actor, second.id, second.revision, ambiguous.key)).toEqual(
    ambiguous.replay,
  );
  const before = await footprint();
  expect(await commands.createOrder(buyer().actor, second.id, second.revision, historical.key)).toEqual(
    historical.replay,
  );
  expect(await checkout(dependencies, buyer().actor, second.id, second.revision, historical.key)).toMatchObject({
    id: historical.order.id,
    checkoutSessionId: 'cs_retained_native',
    contentEdition: null,
    unitAmountMinor: 1200,
  });
  // Current parent existence is mandatory, including when the request key names a retained receipt.
  await expect(
    commands.createOrder(buyer().actor, newId(routeOf(second.id)!), second.revision, historical.key),
  ).rejects.toBeInstanceOf(GrantDeniedError);
  // The other active offer has the same unavailable Content source. Fresh execution cannot use history as authority.
  const active = await commands.readOffer(offer.id);
  await expect(commands.createOrder(buyer().actor, offer.id, active!.revision, randomUUID())).rejects.toBeInstanceOf(
    ContentEditionUnavailableError(),
  );
  expect(await footprint()).toEqual(before);
  const unscoped = await system.auth.issue({
    accountId: buyer().actor.accountId,
    clientId: system.auth.ordinaryClient.id,
    scopes: ['order:read'],
  });
  const afterConsent = await footprint();
  await expect(commands.createOrder(unscoped.actor, second.id, second.revision, historical.key)).rejects.toBeInstanceOf(
    GrantDeniedError,
  );
  expect(await footprint()).toEqual(afterConsent);
  await value(
    wire(governance, `/v1/accounts/${buyer().actor.accountId}:suspend`, 'POST', { reason: 'Revoke current buyer' }),
    200,
  );
  const afterSuspension = await footprint();
  await expect(commands.createOrder(buyer().actor, second.id, second.revision, historical.key)).rejects.toBeInstanceOf(
    GrantDeniedError,
  );
  expect(await footprint()).toEqual(afterSuspension);
}, 120_000);
