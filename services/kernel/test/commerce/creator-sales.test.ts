import { afterAll, beforeAll, expect, test } from 'bun:test';
import { createWriteRateLimiter } from '../../src/access/write-rate.ts';
import { authoritativeTimeValue, runCommand } from '../../src/command/command.ts';
import { runOperationalTransaction } from '../../src/command/operational.ts';
import {
  admitCreatorSale,
  advanceCreatorSale,
  backfillCreatorSales,
  prepareCreatorSaleDelivery,
  recoverCreatorSale,
  readCreatorSaleSource,
  writeCreatorSaleProjection,
} from '../../src/commerce/creator-sales-work.ts';
import { liveCopyLocator, readLiveCopyResult } from '../../src/access/live-copy.ts';
import { readCreatorSaleReceiving } from '../../src/commerce/creator-sales-receiving.ts';
import { commerceWorkModule } from '../../src/commerce/work-module.ts';
import { advanceCommerceErasure } from '../../src/commerce/erasure-participant.ts';
import { insertOrder } from '../../src/commerce/store.ts';
import type { Offer, Order } from '../../src/commerce/model.ts';
import { actionCatalogue } from '../../src/http/request.ts';
import { openApiDocument } from '../../src/http/openapi.ts';
import type { CloudEvent } from '../../src/events/log.ts';
import { newId, partitionOf, routeOf } from '../../src/route/route.ts';
import { createWorkClient } from '../../src/work/client.ts';
import { composeWork, type WorkContext } from '../../src/work/registry.ts';
import { decodeCursor, encodeCursor } from '../../src/tokens/cursor.ts';
import { cookies, nativeFixture, password } from '../access/native-account-bindings-fixture.ts';
import { deletePersona } from '../support/account-deletion.ts';
import { openGrowthDatabase } from '../support/growth.ts';
import { createPersonas } from '../support/personas.ts';
import { registerTestClient, testKernel, testTokens } from '../support/test-kernel.ts';

let db: Awaited<ReturnType<typeof openGrowthDatabase>>;
let auth: Awaited<ReturnType<typeof nativeFixture>>;
let app: ReturnType<typeof testKernel>;
let people: Awaited<ReturnType<typeof createPersonas>>;
let peer: { accountId: string; bearer: string };
let client: Awaited<ReturnType<typeof createWorkClient>>;
let worker: Awaited<ReturnType<typeof composeWork>>;
let context: WorkContext;
const orders: Order[] = [];

async function request(path = '/v1/commerceSales', as: { bearer: string | null } = people.alice, body?: unknown) {
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
async function signIn(accountId: string, scopes = ['commerce_sale:list']) {
  const signed = await auth.request('/signin', {
    account_id: accountId,
    password,
    client_id: 'creator-sales',
    scope: scopes,
  });
  expect(signed.status).toBe(200);
  const token = await auth.request('/token', {}, cookies(signed));
  expect(token.status).toBe(200);
  return { accountId, bearer: (await token.json()).access_token as string };
}
// Native order fixtures use the original command log and the default effects admission.
async function seed(creatorAccountId: string, buyerAccountId = people.bob.accountId) {
  const route = routeOf(buyerAccountId)!;
  const offer: Offer = {
    id: newId(routeOf(creatorAccountId)!),
    creatorAccountId,
    targetSubjectId: newId(0x5500),
    title: 'Captured accounting title',
    currency: 'usd',
    unitAmountMinor: 1200,
    taxCode: 'txcd_10302000',
    royaltyBasisPoints: 9000,
    state: 'active',
    revision: 1,
    contentEdition: null,
  };
  const id = newId(route);
  const result = await runCommand(
    db.pool,
    {
      partition: partitionOf(route),
      basis: { actorAccountId: buyerAccountId, clientId: 'creator-sales-source-fixture', requestedBy: null },
    },
    async (tx, command) => ({
      value: await insertOrder(
        tx,
        route,
        { id, buyerAccountId, offer },
        {
          transactionId: command.transactionId,
          time: authoritativeTimeValue(command.time),
        },
      ),
      events: [{ type: 'com.rezics.commerce.order.created.v1', subject: id, data: { orderId: id } }],
    }),
  );
  const event = await eventAt(partitionOf(route), result.position);
  await admit(event);
  return { order: result.value, event };
}
async function eventAt(partition: number, position: bigint): Promise<CloudEvent> {
  const row = (
    await db.pool.query<{ id: string; type: string; subject: string; data: unknown; epoch: number }>(
      'SELECT id,type,subject,data,epoch FROM core.outbox WHERE partition_no=$1 AND position=$2 AND event_seq=0',
      [partition, position.toString()],
    )
  ).rows[0]!;
  return {
    specversion: '1.0',
    id: row.id,
    type: row.type,
    subject: row.subject,
    data: row.data,
    source: `urn:rezics:log:${partition}.${row.epoch}`,
    time: new Date().toISOString(),
    datacontenttype: 'application/json',
    sequence: position.toString().padStart(19, '0'),
  };
}
async function admit(event: CloudEvent) {
  const source = /^urn:rezics:log:(\d+)\.\d+$/.exec(event.source);
  if (!source) throw new Error('Invalid native fixture event source');
  await runOperationalTransaction(
    db.pool,
    {
      mode: 'work-step',
      partition: Number(source[1]),
      kind: 'commerce.creatorSales.fixtureAdmission',
      accounts: [],
      workClient: client,
    },
    (tx) => admitCreatorSale(tx, event),
  );
}
// Only the terminal-refusal case attempts an unadmitted lower-level write.
async function attemptUnadmittedProjection(source: NonNullable<Awaited<ReturnType<typeof readCreatorSaleSource>>>) {
  return runOperationalTransaction(
    db.pool,
    {
      mode: 'work-step',
      partition: partitionOf(routeOf(source.creatorAccountId)!),
      kind: 'commerce.creatorSales.fixture',
      accounts: [source.creatorAccountId],
      workClient: client,
    },
    (tx) => writeCreatorSaleProjection(tx, source),
  );
}

beforeAll(async () => {
  db = await openGrowthDatabase();
  auth = await nativeFixture(db.pool);
  const service = auth.host.service;
  app = testKernel({
    pool: db.pool,
    auth: { ...service.verifier, fetch: (url, init) => service.handler(new Request(url, init)) },
    writeRate: createWriteRateLimiter({ secret: 'creator-sales-native-fixture-secret' }),
  });
  people = await createPersonas(app, { version: 1, pool: db.pool, auth });
  client = await createWorkClient(db.url, db.pool);
  worker = await composeWork(
    [
      {
        name: 'capture_creator_sales_context',
        register(value) {
          context = value;
        },
      },
      commerceWorkModule,
    ],
    { pool: db.pool, client, databaseUrl: db.url, env: {} },
  );
  await registerTestClient(service, {
    clientId: 'creator-sales',
    firstParty: true,
    scopes: ['commerce_sale:list', 'offer:read'],
  });
  for (let n = 0; n < 2_000_000; n++) {
    const handle = `creator_sales_peer_${people.alice.accountId.replaceAll('-', '')}_${n}`;
    if (routeOf(auth.COMMANDS.internalLifecycle.registrationTarget(handle)) === routeOf(people.alice.accountId)) {
      peer = await signIn((await auth.person(handle)).accountId);
      break;
    }
  }
  expect(peer).toBeDefined();
  expect((await request('/v1/platform/exposure/selling:open', people.staff, {})).status).toBe(200);
  for (const creator of [people.alice.accountId, people.alice.accountId, peer.accountId]) {
    const { order } = await seed(creator);
    const source = await readCreatorSaleSource(db.pool, { route: routeOf(order.id)!, orderId: order.id });
    expect(source).not.toBeNull();
    await advanceCreatorSale(context, { route: routeOf(order.id)!, orderId: order.id });
    orders.push(order);
  }
}, 120_000);
afterAll(async () => {
  await worker?.shutdown();
  await client?.close();
  await auth?.close();
  await db?.close();
});

test('Minimal native creator sales accounting view, source-backed and private', async () => {
  const response = await request();
  expect(response.status).toBe(200);
  expect(response.headers.get('cache-control')).toBe('private, no-store');
  const page = await response.json();
  expect(Object.keys(page).sort()).toEqual(['next', 'projectionState', 'sales']);
  expect(page.projectionState).toBe('preparing');
  expect(page.next).toBeNull();
  const exposure = await (await request('/v1/platform/exposure')).json();
  expect(exposure.admitted).toContain('selling');
  expect(exposure.admitted).toContain('commerce_sale.list');
  expect(page.sales.map((row: { orderId: string }) => row.orderId)).toEqual(
    orders
      .slice(0, 2)
      .map((row) => row.id)
      .sort()
      .reverse(),
  );
  expect(Object.keys(page.sales[0]).sort()).toEqual(
    [
      'orderId',
      'offerId',
      'title',
      'targetSubjectId',
      'currency',
      'unitAmountMinor',
      'moneyUnit',
      'taxBehavior',
      'settlement',
      'createdAt',
    ].sort(),
  );
  expect(page.sales[0]).toMatchObject({
    title: 'Captured accounting title',
    unitAmountMinor: 1200,
    currency: 'usd',
    moneyUnit: null,
    taxBehavior: null,
    settlement: 'pending',
  });
  const operation = openApiDocument(app).paths['/v1/commerceSales']!.get!;
  expect(operation).toMatchObject({
    operationId: 'commerce_sale.list',
    'x-action': 'commerce_sale:list',
    'x-exposure': 'gate:selling',
    'x-authority-anchor': 'own-account',
    'x-authority-resource-types': ['access.account'],
    security: [{ bearerAuth: [] }],
  });
  expect(actionCatalogue(app).get('commerce_sale:list')).toMatchObject({ anonymous: false, authority: 'own-account' });
});

test('same-route foreign creator, scope and principal are evaluated on the actual actor account', async () => {
  expect(routeOf(peer.accountId)).toBe(routeOf(people.alice.accountId));
  const own = await (await request('/v1/commerceSales', peer)).json();
  expect(own.sales.map((row: { orderId: string }) => row.orderId)).toEqual([orders[2]!.id]);
  const selector = await request(`/v1/commerceSales?creatorAccountId=${people.alice.accountId}`, peer);
  if (selector.status === 200) expect(await selector.json()).toEqual(own);
  else expect(selector.status).toBe(400);
  expect((await request('/v1/commerceSales', people.anonymous)).status).toBe(401);
  expect((await request('/v1/commerceSales', await signIn(people.alice.accountId, ['offer:read']))).status).toBe(403);
  expect((await request('/v1/commerceSales', people.delegated)).status).toBe(403);
  expect((await request('/v1/commerceSales', people.suspended)).status).toBe(401);
  // No verified local rows does not establish complete or empty source coverage.
  expect(await (await request('/v1/commerceSales', people.bob)).json()).toEqual({
    sales: [],
    next: null,
    projectionState: 'preparing',
  });
});

test('duplicate and late events use fresh exact source revisions and cannot roll accounting back', async () => {
  const { order, event } = await seed(people.alice.accountId);
  const locator = { route: routeOf(order.id)!, orderId: order.id };
  const old = await readCreatorSaleSource(db.pool, locator);
  expect(old?.revision).toBe(1);
  await advanceCreatorSale(context, locator);
  const originalCopy = (await prepareCreatorSaleDelivery(context, locator, people.alice.accountId))!;
  const originalResult = await readLiveCopyResult(db.pool, originalCopy);
  expect(originalResult).toMatchObject({ outcome: 'applied' });
  await admit(event);
  const generation = (
    await db.pool.query('SELECT generation::text FROM commerce.creator_sale_work WHERE route=$1 AND order_id=$2', [
      locator.route,
      locator.orderId,
    ])
  ).rows[0];
  expect(generation.generation).toBe('1');
  const update = await runCommand(
    db.pool,
    {
      partition: partitionOf(locator.route),
      basis: { actorAccountId: people.bob.accountId, clientId: 'creator-sales-source-fixture', requestedBy: null },
    },
    async (tx, command) => {
      await tx.query(
        `UPDATE commerce.purchase_order SET settlement='paid',revision=revision+1,transaction_id=$3,updated_at=$4
      WHERE route=$1 AND order_id=$2`,
        [locator.route, locator.orderId, command.transactionId, authoritativeTimeValue(command.time)],
      );
      return {
        value: null,
        events: [
          { type: 'com.rezics.commerce.order.updated.v1', subject: order.id, data: { orderId: order.id, revision: 2 } },
        ],
      };
    },
  );
  await admit(await eventAt(partitionOf(locator.route), update.position));
  // Copied wake-up JSON is ignored as truth, even with a forged larger revision.
  await admit({ ...event, data: { orderId: order.id, revision: 999 } });
  const current = await readCreatorSaleSource(db.pool, locator);
  expect(current).toMatchObject({ revision: 2, view: { settlement: 'paid' } });
  await advanceCreatorSale(context, locator);
  const currentCopy = (await prepareCreatorSaleDelivery(context, locator, people.alice.accountId))!;
  expect(currentCopy.transition_id).not.toBe(originalCopy.transition_id);
  const currentResult = await readLiveCopyResult(db.pool, currentCopy);
  const beforeReplay = (
    await db.pool.query(
      'SELECT * FROM commerce.creator_sale WHERE route=$1 AND creator_account_id=$2 AND order_id=$3',
      [routeOf(people.alice.accountId), people.alice.accountId, order.id],
    )
  ).rows;
  // Replay the original immutable effect, then the current effect through the real recovery body.
  await recoverCreatorSale(context, liveCopyLocator(originalCopy));
  await recoverCreatorSale(context, liveCopyLocator(currentCopy));
  await advanceCreatorSale(context, locator);
  expect(await readLiveCopyResult(db.pool, originalCopy)).toEqual(originalResult);
  expect(await readLiveCopyResult(db.pool, currentCopy)).toEqual(currentResult);
  expect(
    (
      await db.pool.query(
        'SELECT * FROM commerce.creator_sale WHERE route=$1 AND creator_account_id=$2 AND order_id=$3',
        [routeOf(people.alice.accountId), people.alice.accountId, order.id],
      )
    ).rows,
  ).toEqual(beforeReplay);
  expect(
    (
      await db.pool.query('SELECT generation::text FROM commerce.creator_sale_work WHERE route=$1 AND order_id=$2', [
        locator.route,
        locator.orderId,
      ])
    ).rows,
  ).toEqual([{ generation: '2' }]);
  const projected = (
    await db.pool.query(
      'SELECT settlement,source_revision FROM commerce.creator_sale WHERE route=$1 AND creator_account_id=$2 AND order_id=$3',
      [routeOf(people.alice.accountId), people.alice.accountId, order.id],
    )
  ).rows;
  expect(projected).toEqual([{ settlement: 'paid', source_revision: 2 }]);
  expect(projected).toHaveLength(1);
});

test('default native delivery succeeds and a fenced receiving home retains the exact pending obligation', async () => {
  const { order } = await seed(people.alice.accountId);
  const locator = { route: routeOf(order.id)!, orderId: order.id };
  await advanceCreatorSale(context, locator);
  expect(readCreatorSaleReceiving(context)).toEqual({ state: 'available' });
  expect(
    (
      await db.pool.query(
        'SELECT state,gap,observed_revision FROM commerce.creator_sale_work WHERE route=$1 AND order_id=$2',
        [locator.route, locator.orderId],
      )
    ).rows,
  ).toEqual([{ state: 'verified', gap: null, observed_revision: 1 }]);
  expect(
    (
      await db.pool.query(
        'SELECT order_id FROM commerce.creator_sale WHERE route=$1 AND creator_account_id=$2 AND order_id=$3',
        [routeOf(people.alice.accountId), people.alice.accountId, order.id],
      )
    ).rows,
  ).toEqual([{ order_id: order.id }]);

  const home = partitionOf(locator.route);
  const foreignCreator = [people.alice, people.staff, people.operator, people.orgOwner].find(
    (person) => partitionOf(routeOf(person.accountId)!) !== home,
  )!;
  expect(foreignCreator).toBeDefined();
  const pending = await seed(foreignCreator.accountId);
  const pendingLocator = { route: routeOf(pending.order.id)!, orderId: pending.order.id };
  const originalWork = (
    await db.pool.query(
      'SELECT route,order_id,generation::text FROM commerce.creator_sale_work WHERE route=$1 AND order_id=$2',
      [pendingLocator.route, pendingLocator.orderId],
    )
  ).rows[0];
  const receiverHome = partitionOf(routeOf(foreignCreator.accountId)!);
  await db.pool.query("UPDATE core.partition SET write_state='fenced' WHERE partition_no=$1", [receiverHome]);
  try {
    await advanceCreatorSale(context, pendingLocator);
  } finally {
    await db.pool.query("UPDATE core.partition SET write_state='active' WHERE partition_no=$1", [receiverHome]);
  }
  expect(
    (
      await db.pool.query(
        'SELECT route,order_id,generation::text,state,gap,observed_revision FROM commerce.creator_sale_work WHERE route=$1 AND order_id=$2',
        [pendingLocator.route, pendingLocator.orderId],
      )
    ).rows,
  ).toEqual([
    {
      ...originalWork,
      state: 'pending',
      gap: 'commerce-creator-sale-live-copy-home-unavailable',
      observed_revision: 1,
    },
  ]);
  expect(
    (
      await db.pool.query(
        'SELECT order_id FROM commerce.creator_sale WHERE route=$1 AND creator_account_id=$2 AND order_id=$3',
        [routeOf(foreignCreator.accountId), foreignCreator.accountId, pending.order.id],
      )
    ).rows,
  ).toEqual([]);
  expect(
    (
      await db.pool.query(
        'SELECT event_id,source_revision,state FROM commerce.creator_sale_receipt WHERE route=$1 AND order_id=$2',
        [pendingLocator.route, pendingLocator.orderId],
      )
    ).rows,
  ).toEqual([{ event_id: pending.event.id, source_revision: 1, state: 'pending' }]);
  await db.pool.query("UPDATE core.partition SET write_state='fenced' WHERE partition_no=$1", [home]);
  try {
    await expect(advanceCreatorSale(context, pendingLocator)).rejects.toThrow();
  } finally {
    await db.pool.query("UPDATE core.partition SET write_state='active' WHERE partition_no=$1", [home]);
  }
  expect(
    (
      await db.pool.query('SELECT state FROM commerce.creator_sale_work WHERE route=$1 AND order_id=$2', [
        pendingLocator.route,
        pendingLocator.orderId,
      ])
    ).rows[0].state,
  ).toBe('pending');
  await advanceCreatorSale(context, pendingLocator);
  expect(
    (
      await db.pool.query('SELECT state,gap FROM commerce.creator_sale_work WHERE route=$1 AND order_id=$2', [
        pendingLocator.route,
        pendingLocator.orderId,
      ])
    ).rows,
  ).toEqual([{ state: 'verified', gap: null }]);
  expect(
    (
      await db.pool.query(
        'SELECT event_id,source_revision,state FROM commerce.creator_sale_receipt WHERE route=$1 AND order_id=$2',
        [pendingLocator.route, pendingLocator.orderId],
      )
    ).rows,
  ).toEqual([{ event_id: pending.event.id, source_revision: 1, state: 'pending' }]);
  expect(await backfillCreatorSales(context, home)).toBe(true);
  expect(await backfillCreatorSales(context, home)).toBe(true);
  expect(
    (await db.pool.query('SELECT phase FROM commerce.creator_sales_frontier WHERE partition_no=$1', [home])).rows[0]
      .phase,
  ).toBe('covered');
});

test('signed keysets bind viewer operation query and native creator epoch; unavailable pages are not empty', async () => {
  const first = await (await request('/v1/commerceSales?limit=1')).json();
  expect(first.sales).toHaveLength(1);
  expect(first.next).toBeString();
  expect((await request(`/v1/commerceSales?limit=1&cursor=${encodeURIComponent(first.next)}`)).status).toBe(200);
  expect((await request(`/v1/commerceSales?limit=1&cursor=${encodeURIComponent(first.next)}`, peer)).status).toBe(400);
  expect((await request(`/v1/commerceSales?limit=2&cursor=${encodeURIComponent(first.next)}`)).status).toBe(400);
  expect((await request(`/v1/offers?limit=1&cursor=${encodeURIComponent(first.next)}`)).status).toBe(400);
  expect((await request('/v1/commerceSales?cursor=forged')).status).toBe(400);
  for (const limit of [0, 101, -1, 1.5]) expect((await request(`/v1/commerceSales?limit=${limit}`)).status).toBe(400);
  const home = partitionOf(routeOf(people.alice.accountId)!);
  const binding = {
    operation: 'commerce_sale.list',
    parameters: {
      accountId: people.alice.accountId,
      route: routeOf(people.alice.accountId)!,
      view: 'creator-sales-v1',
      order: 'order-id-desc',
      limit: 1,
    },
  };
  const decoded = decodeCursor(testTokens(), binding, first.next);
  expect(decoded.ok).toBe(true);
  if (!decoded.ok) throw new Error('Expected the actual native creator cursor');
  const partition = (await db.pool.query('SELECT epoch FROM core.partition WHERE partition_no=$1', [home])).rows[0]!;
  expect(decoded.epoch).toBe(partition.epoch);
  // Epoch 1 has no older valid token epoch; a signed noncurrent epoch still exercises the same 409 fence.
  const stale = encodeCursor(testTokens(), binding, {
    epoch: decoded.epoch > 1 ? decoded.epoch - 1 : decoded.epoch + 1,
    after: decoded.after,
  });
  expect((await request(`/v1/commerceSales?limit=1&cursor=${encodeURIComponent(stale)}`)).status).toBe(409);
  await expect(db.pool.query('UPDATE core.partition SET epoch=epoch+1 WHERE partition_no=$1', [home])).rejects.toThrow(
    'Live copy domain requires native lineage reconciliation before activation',
  );
  expect((await db.pool.query('SELECT epoch FROM core.partition WHERE partition_no=$1', [home])).rows).toEqual([
    partition,
  ]);
  await db.pool.query("UPDATE core.partition SET write_state='fenced' WHERE partition_no=$1", [home]);
  try {
    expect((await request()).status).toBe(503);
  } finally {
    await db.pool.query("UPDATE core.partition SET write_state='active' WHERE partition_no=$1", [home]);
  }
});

test('native terminal fences stop source payload and creator writes; derived cleanup does not ACK financial custody', async () => {
  const { order } = await seed(peer.accountId);
  const locator = { route: routeOf(order.id)!, orderId: order.id };
  const source = await readCreatorSaleSource(db.pool, locator);
  expect(source).not.toBeNull();
  await advanceCreatorSale(context, locator);
  const copy = (await prepareCreatorSaleDelivery(context, locator, peer.accountId))!;
  expect(await readLiveCopyResult(db.pool, copy)).toMatchObject({ outcome: 'applied' });
  // Peer has the same real route as Alice, but remains a distinct native terminal anchor.
  // Sign in once through the ordinary fixture client with account:delete consent.
  const signed = await auth.request('/signin', {
    account_id: peer.accountId,
    password,
    client_id: (
      await auth.authPool.query(
        `SELECT client_id FROM auth_client WHERE 'account:delete'=ANY(scopes) ORDER BY client_id LIMIT 1`,
      )
    ).rows[0].client_id,
    scope: ['account:delete'],
  });
  expect(signed.status).toBe(200);
  await deletePersona({ pool: db.pool, auth }, peer);
  expect((await request('/v1/commerceSales', peer)).status).toBe(401);
  await expect(attemptUnadmittedProjection(source!)).rejects.toThrow();
  await recoverCreatorSale(context, liveCopyLocator(copy));
  let progress = await advanceCommerceErasure(db.pool, peer.accountId);
  if (progress === 'more') progress = await advanceCommerceErasure(db.pool, peer.accountId);
  expect(progress).toBe('pending');
  expect(
    (
      await db.pool.query(
        "SELECT outcome FROM access.erasure_acknowledgement WHERE route=$1 AND account_id=$2 AND participant='commerce'",
        [routeOf(peer.accountId), peer.accountId],
      )
    ).rows,
  ).toEqual([]);
  // The already terminal receiving result survives local projection erasure and cannot revive it.
  await recoverCreatorSale(context, liveCopyLocator(copy));
  expect(
    (
      await db.pool.query('SELECT order_id FROM commerce.creator_sale WHERE route=$1 AND creator_account_id=$2', [
        routeOf(peer.accountId),
        peer.accountId,
      ])
    ).rows,
  ).toHaveLength(0);
  await deletePersona({ pool: db.pool, auth }, people.bob);
  expect(await readCreatorSaleSource(db.pool, locator)).toBeNull();
});
