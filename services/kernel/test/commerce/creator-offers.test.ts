import { afterAll, beforeAll, expect, test } from 'bun:test';
import { createWriteRateLimiter } from '../../src/access/write-rate.ts';
import { actionCatalogue } from '../../src/http/request.ts';
import { insertOffer, setOfferState } from '../../src/commerce/store.ts';
import type { CapturedContentEdition, Offer } from '../../src/commerce/model.ts';
import { readCommerceMoneyPolicy, validateOfferAmount } from '../../src/commerce/money.ts';
import { newId, partitionOf, routeOf } from '../../src/route/route.ts';
import { encodeCursor } from '../../src/tokens/cursor.ts';
import { cookies, nativeFixture, password } from '../access/native-account-bindings-fixture.ts';
import { openGrowthDatabase } from '../support/growth.ts';
import { createPersonas } from '../support/personas.ts';
import { registerTestClient, testKernel, testTokens } from '../support/test-kernel.ts';

let db: Awaited<ReturnType<typeof openGrowthDatabase>>;
let auth: Awaited<ReturnType<typeof nativeFixture>>;
let app: ReturnType<typeof testKernel>;
let people: Awaited<ReturnType<typeof createPersonas>>;
let peer: { accountId: string; bearer: string };
const offers: Offer[] = [];
const context = () => ({ transactionId: newId(0), time: new Date().toISOString() });
async function request(path = '/v1/offers', as: { bearer: string | null } = people.alice, body?: unknown) {
  return app.handle(
    new Request(`http://kernel.test${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: {
        ...(as.bearer ? { authorization: `Bearer ${as.bearer}` } : {}),
        ...(body === undefined
          ? {}
          : { 'content-type': 'application/json', 'idempotency-key': JSON.stringify(crypto.randomUUID()) }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
  );
}
async function signIn(accountId: string, scopes = ['offer:list']) {
  const signed = await auth.request('/signin', {
    account_id: accountId,
    password,
    client_id: 'creator-offers',
    scope: scopes,
  });
  expect(signed.status).toBe(200);
  const token = await auth.request('/token', {}, cookies(signed));
  expect(token.status).toBe(200);
  return { accountId, bearer: (await token.json()).access_token as string };
}
async function seed(creator: string, edition: boolean) {
  const route = routeOf(creator)!;
  const targetSubjectId = newId(0x5500);
  const capture: CapturedContentEdition | null = edition
    ? {
        benefit: {
          kind: 'content-edition',
          resourceType: 'content.edition',
          resource: { route: 0x3300, id: newId(0x3300) },
          version: { revisionId: newId(0x3300), sha256: 'a'.repeat(64) },
          action: 'edition:read',
        },
        creatorAccountId: creator,
        targetSubjectId,
        source: { threadId: newId(0x3300), postId: newId(0x3300), licence: 'CC-BY-4.0' },
        saleTermsReference: 'captured-publication',
        delivery: 'fixed-content-edition',
        acquisition: 'one-time-account-bound',
        quantity: 1,
      }
    : null;
  const offer: Offer = {
    id: newId(route),
    creatorAccountId: creator,
    targetSubjectId,
    title: 'Captured creator title',
    currency: 'usd',
    unitAmountMinor: 1200,
    ...(edition ? validateOfferAmount({ currency: 'usd', amountMinor: 1200 }, readCommerceMoneyPolicy({})) : {}),
    taxCode: 'txcd_10302000',
    royaltyBasisPoints: 9000,
    state: 'active',
    revision: 1,
    contentEdition: capture,
  };
  await insertOffer(db.pool, route, offer, context());
  return offer;
}
beforeAll(async () => {
  db = await openGrowthDatabase();
  auth = await nativeFixture(db.pool);
  const service = auth.host.service;
  app = testKernel({
    pool: db.pool,
    auth: { ...service.verifier, fetch: (url, init) => service.handler(new Request(url, init)) },
    writeRate: createWriteRateLimiter({ secret: 'creator-offers-native-test-rate-secret' }),
  });
  people = await createPersonas(app, { version: 1, pool: db.pool, auth });
  await registerTestClient(service, {
    clientId: 'creator-offers',
    firstParty: true,
    scopes: ['offer:list', 'offer:read'],
  });
  for (let n = 0; n < 2_000_000; n++) {
    const candidate = `creator_offers_peer_${people.alice.accountId.replaceAll('-', '')}_${n}`;
    if (routeOf(auth.COMMANDS.internalLifecycle.registrationTarget(candidate)) === routeOf(people.alice.accountId)) {
      peer = await signIn((await auth.person(candidate)).accountId);
      break;
    }
  }
  expect(peer).toBeDefined();
  for (const group of ['selling', 'purchases'])
    expect((await request(`/v1/platform/exposure/${group}:open`, people.staff, {})).status).toBe(200);
  for (let n = 0; n < 22; n++) offers.push(await seed(people.alice.accountId, n === 0));
  await seed(peer.accountId, false);
  await seed(people.delegated.accountId, false);
  await setOfferState(db.pool, routeOf(offers[0]!.id)!, offers[0]!.id, 'delisted', context());
}, 120_000);
afterAll(async () => {
  await auth?.close();
  await db?.close();
});

test('creator sees bounded own active and delisted history without source identities or live target reads', async () => {
  const first = await request();
  expect(first.status).toBe(200);
  expect(first.headers.get('cache-control')).toBe('private, no-store');
  const page = await first.json();
  expect(page.offers).toHaveLength(20);
  const next = await request(`/v1/offers?cursor=${encodeURIComponent(page.next)}`);
  expect(next.status).toBe(200);
  const tail = await next.json();
  expect(tail.offers).toHaveLength(2);
  expect(tail.next).toBeNull();
  expect([...page.offers, ...tail.offers].map((row: Offer) => row.id)).toEqual(
    offers
      .map((offer) => offer.id)
      .sort()
      .reverse(),
  );
  const history = tail.offers.find((row: Offer) => row.id === offers[0]!.id);
  expect(history).toMatchObject({
    state: 'delisted',
    title: 'Captured creator title',
    contentEdition: { source: { licence: 'CC-BY-4.0' } },
    moneyUnit: { system: 'stripe-api', exponent: 2, factsVersion: 'stripe-money-v1' },
    taxBehavior: 'exclusive',
  });
  expect(Object.keys(history).sort()).toEqual(
    [
      'contentEdition',
      'currency',
      'id',
      'moneyUnit',
      'revision',
      'royaltyBasisPoints',
      'state',
      'targetSubjectId',
      'taxCode',
      'taxBehavior',
      'title',
      'unitAmountMinor',
    ].sort(),
  );
  expect(JSON.stringify(history)).not.toContain('threadId');
  expect(JSON.stringify(history)).not.toContain('postId');
  expect(page.offers[0].contentEdition).toBeNull();
  expect(page.offers[0].moneyUnit).toBeNull();
  expect(page.offers[0].taxBehavior).toBeNull();
  expect((await request(`/v1/offers/${offers[0]!.id}`)).status).toBe(404);
  expect(await (await request('/v1/offers?limit=100')).json()).toMatchObject({ next: null });
  // Repeating a read has no receipt/replay dependency.
  expect(await (await request(`/v1/offers?cursor=${encodeURIComponent(page.next)}`)).json()).toEqual(tail);
});

test('same-route creator, anonymous, missing exact consent and distinct principal cannot disclose another creator list', async () => {
  expect(routeOf(peer.accountId)).toBe(routeOf(people.alice.accountId));
  const own = await (await request('/v1/offers', peer)).json();
  expect(own.offers).toHaveLength(1);
  expect(offers.some((offer) => offer.id === own.offers[0].id)).toBe(false);
  expect(await (await request('/v1/offers', people.bob)).json()).toEqual({ offers: [], next: null });
  const selector = await request(`/v1/offers?creatorAccountId=${people.alice.accountId}`, peer);
  if (selector.status === 200) expect(await selector.json()).toEqual(own);
  else expect(selector.status).toBe(400);
  expect((await request('/v1/offers', people.anonymous)).status).toBe(401);
  expect((await request('/v1/offers', await signIn(people.alice.accountId, ['offer:read']))).status).toBe(403);
  expect((await request('/v1/offers', people.delegated)).status).toBe(403);
  expect((await request('/v1/offers', people.suspended)).status).toBe(401);
  const granted = await request('/v1/grants', people.staff, {
    resource: { route: routeOf(people.delegated.accountId)!, id: people.delegated.accountId },
    subject: { kind: 'account', id: people.alice.accountId },
    actions: ['offer:list'],
    valid: '(,)',
  });
  expect(granted.status).toBe(201);
  const delegatedOwn = await request('/v1/offers', people.delegated);
  expect(delegatedOwn.status).toBe(200);
  expect((await delegatedOwn.json()).offers).toHaveLength(1);
});

test('signed seller cursor binds viewer operation view and native epoch; unavailable source is not empty', async () => {
  const first = await (await request('/v1/offers?limit=1')).json();
  expect((await request(`/v1/offers?cursor=${encodeURIComponent(first.next)}`, peer)).status).toBe(400);
  expect((await request('/v1/offers?cursor=bad-signature')).status).toBe(400);
  const route = routeOf(people.alice.accountId)!;
  const foreign = encodeCursor(
    testTokens(),
    { operation: 'offer.get', parameters: { accountId: people.alice.accountId } },
    { epoch: 1, after: [offers[0]!.id] },
  );
  expect((await request(`/v1/offers?cursor=${encodeURIComponent(foreign)}`)).status).toBe(400);
  const partition = partitionOf(route);
  await db.pool.query('UPDATE core.partition SET epoch = epoch + 1 WHERE partition_no = $1', [partition]);
  try {
    expect((await request(`/v1/offers?cursor=${encodeURIComponent(first.next)}`)).status).toBe(409);
  } finally {
    await db.pool.query('UPDATE core.partition SET epoch = epoch - 1 WHERE partition_no = $1', [partition]);
  }
  for (const limit of [0, 101, -1, 1.5]) expect((await request(`/v1/offers?limit=${limit}`)).status).toBe(400);
  await db.pool.query("UPDATE core.partition SET write_state = 'fenced' WHERE partition_no = $1", [partition]);
  try {
    expect((await request()).status).toBe(503);
  } finally {
    await db.pool.query("UPDATE core.partition SET write_state = 'active' WHERE partition_no = $1", [partition]);
  }
  expect(actionCatalogue(app).get('offer:list')).toMatchObject({ anonymous: false, authority: 'own-account' });
});
