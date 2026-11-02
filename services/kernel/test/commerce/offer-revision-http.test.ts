import { afterAll, beforeAll, expect, test } from 'bun:test';
import pg from 'pg';
import { createGrantCommands } from '../../src/access/grant-commands.ts';
import { checkout } from '../../src/commerce/checkout.ts';
import { createCommerceCommands } from '../../src/commerce/commands.ts';
import type { Offer, Order } from '../../src/commerce/model.ts';
import { createStripePort } from '../../src/commerce/stripe.ts';
import { PROBLEMS, type ProblemCode } from '../../src/http/problem.ts';
import { SESSION_HEADER } from '../../src/http/request.ts';
import { deadlineFor } from '../../src/request/deadline.ts';
import { partitionOf, routeOf } from '../../src/route/route.ts';
import { GLOBAL_CONTEXT } from '../../src/semantic/definitions.ts';
import {
  createProfileEntryFixture,
  entryKey,
  type NativeProfileFixture,
} from '../library/support/profile-entry-fixture.ts';
import { accountToken } from '../support/admitted-access.ts';
import { startFakeStripe } from './support/fake-stripe.ts';

let f: NativeProfileFixture;
let fake: ReturnType<typeof startFakeStripe>;
const reader = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  max: 1,
  options: '-c default_transaction_read_only=on',
});

beforeAll(async () => {
  // This fixture mounts the production createKernel and authenticates real native
  // actors. Its only trusted identity adapter is at the provisioning boundary.
  f = await createProfileEntryFixture();
  fake = startFakeStripe();
}, 120_000);

afterAll(async () => {
  fake?.stop();
  await f?.close();
  await reader.end();
});

async function problem(response: Response, status: number, code: ProblemCode | 'platform_closed') {
  expect(response.status).toBe(status);
  expect(response.headers.get('content-type')).toBe('application/problem+json');
  const body = await response.json();
  expect(body).toEqual({
    type: `https://rezics.com/problems/${code}`,
    title: code === 'platform_closed' ? 'Platform Closed' : PROBLEMS[code].title,
    status,
    code,
    retryable: false,
    effect_status: 'not_applied',
    request_id: expect.any(String),
    ...(code === 'invalid_request' && body.errors ? { errors: expect.any(Array) } : {}),
  });
  const { request_id: _requestId, ...stable } = body;
  return stable;
}

test('seller price revision through HTTP binds target intent preserves captured purchases and reauthorizes replay', async () => {
  const scopes = ['offer:create', 'offer:manage', 'offer:read', 'subject:read'];
  const seller = await f.identity(scopes);
  const bob = await f.identity(scopes);
  const buyer = await f.identity(['order:create', 'order:read', 'entitlement:read']);
  const grants = createGrantCommands({ pool: f.pool, access: f.access, managementAction: 'access:grant' });
  for (const person of [seller, bob]) {
    await grants.create(
      { pool: f.pool, actor: f.steward.actor, deadline: deadlineFor(30_000) },
      {
        resource: { route: 0, id: GLOBAL_CONTEXT },
        subject: { kind: 'account', id: person.actor.accountId },
        actions: ['offer:create'],
        valid: '(,)',
        key: entryKey(),
      },
    );
  }
  for (const group of ['selling', 'purchases']) {
    expect((await f.send('steward', 'POST', `/v1/platform/exposure/${group}:open`)).status).toBe(200);
  }
  const commands = createCommerceCommands({ pool: f.pool, access: f.access });
  const targetSubjectId = await f.createSubject('game');
  const input = {
    targetSubjectId,
    title: 'Captured price',
    currency: 'usd',
    unitAmountMinor: 1200,
    taxCode: 'txcd_10302000',
  };
  const a = await commands.createOffer(seller.actor, input, entryKey());
  // Native offers admit unresolved subject references; this independently pins
  // the mutation view's explicit nullable summary without changing disclosure.
  const b = await commands.createOffer(
    seller.actor,
    { ...input, targetSubjectId: f.unknownSubject(), title: 'Second owned offer' },
    entryKey(),
  );
  const foreign = await commands.createOffer(bob.actor, { ...input, title: 'Bob owns this' }, entryKey());
  expect(a.partition).toBe(b.partition);
  expect(routeOf(a.value.id)).toBe(routeOf(b.value.id));
  expect(a.value.creatorAccountId).toBe(seller.actor.accountId);
  expect(b.value.creatorAccountId).toBe(seller.actor.accountId);

  const stripe = createStripePort({
    apiKey: 'sk_test_offer_revision',
    managedPayments: false,
    host: '127.0.0.1',
    port: fake.port,
    protocol: 'http',
    maxNetworkRetries: 0,
    timeoutMs: 1000,
    clock: () => new Date(),
  });
  const captured: Order[] = [];
  for (let i = 0; i < 2; i++) {
    captured.push(
      await checkout(
        {
          pool: f.pool,
          commands,
          stripe,
          successUrl: 'https://web.example.test/orders/{ORDER_ID}',
          cancelUrl: 'https://web.example.test/cancel',
        },
        buyer.actor,
        a.value.id,
        a.value.revision,
        entryKey(),
      ),
    );
  }
  for (const order of captured) {
    expect(order).toMatchObject({ offerRevision: a.value.revision, unitAmountMinor: 1200, targetSubjectId });
    expect(fake.sessions.get(order.checkoutSessionId!)?.amount_subtotal).toBe(1200);
  }
  fake.pay(captured[1]!.checkoutSessionId!);
  const paidSnapshot = await stripe.readCheckout(captured[1]!.checkoutSessionId!);
  await commands.applyCheckoutSnapshot(paidSnapshot, entryKey());

  const requestKey = entryKey();
  const laterKey = entryKey();
  const secondKey = entryKey();
  const deniedKey = entryKey();
  const keys = [requestKey, laterKey, secondKey, deniedKey];
  const personas = [seller, bob, buyer];
  const partitions = [...new Set([0, ...personas.map((p) => partitionOf(routeOf(p.actor.accountId)!))])].sort();
  const offers = [a.value, b.value, foreign.value];
  async function inspect() {
    const client = await reader.connect();
    try {
      await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
      const rows = async (sql: string, args: unknown[]) => (await client.query(sql, args)).rows;
      const offerRows = [];
      for (const offer of offers) {
        offerRows.push(
          ...(await rows('SELECT to_jsonb(o) AS row FROM commerce.offer o WHERE route=$1 AND offer_id=$2', [
            routeOf(offer.id),
            offer.id,
          ])),
        );
      }
      const orders = [];
      const entitlements = [];
      for (const order of captured) {
        orders.push(
          ...(await rows('SELECT to_jsonb(o) AS row FROM commerce.purchase_order o WHERE route=$1 AND order_id=$2', [
            routeOf(order.id),
            order.id,
          ])),
        );
        entitlements.push(
          ...(await rows('SELECT to_jsonb(e) AS row FROM commerce.entitlement e WHERE route=$1 AND order_id=$2', [
            routeOf(order.id),
            order.id,
          ])),
        );
      }
      const receipts = [];
      const events = [];
      for (const person of personas) {
        const partition = partitionOf(routeOf(person.actor.accountId)!);
        const found = await rows(
          `SELECT to_jsonb(r) AS row FROM core.receipt r
           WHERE partition_no=$1 AND principal_kind='account' AND principal_id=$2
             AND command_kind='commerce.offer.revise' AND idempotency_key=ANY($3::text[])
           ORDER BY idempotency_key`,
          [partition, person.actor.accountId, keys],
        );
        receipts.push(...found);
        for (const receipt of found) {
          events.push(
            ...(await rows(
              'SELECT to_jsonb(e) AS row FROM core.outbox e WHERE partition_no=$1 AND position=$2 ORDER BY event_seq',
              [partition, receipt.row.position],
            )),
          );
        }
      }
      const counters = await rows(
        'SELECT to_jsonb(p) AS row FROM core.partition p WHERE partition_no=ANY($1::int[]) ORDER BY partition_no',
        [partitions],
      );
      const transactions = await rows(
        `SELECT to_jsonb(t) AS row FROM commerce.order_transaction t
         WHERE route=$1 AND balance_transaction_id=ANY($2::text[]) ORDER BY balance_transaction_id`,
        [routeOf(captured[1]!.id), paidSnapshot.transactions.map((t) => t.id)],
      );
      await client.query('COMMIT');
      return {
        offers: offerRows,
        orders,
        entitlements,
        receipts,
        events,
        counters,
        transactions,
        sessions: structuredClone([...fake.sessions.entries()]),
        providerRequests: fake.requests.map((r) => [r.method, r.path, r.params.toString()]),
      };
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }
  const patch = (
    bearer: string,
    id: string,
    body: unknown = { unitAmountMinor: 2400, expectedRevision: a.value.revision },
    key = requestKey,
  ) => f.send(bearer, 'PATCH', `/v1/offers/${id}`, body, key);
  const get = (id: string) => f.send('anonymous', 'GET', `/v1/offers/${id}`);
  const before = await inspect();
  expect(before.entitlements).toHaveLength(1);
  expect(before.entitlements[0]!.row.revoked_at).toBeNull();
  expect(before.receipts).toEqual([]);
  const sellerRead = await f.send(seller.bearer, 'GET', `/v1/offers/${a.value.id}`);
  expect(sellerRead.status).toBe(200);
  const summary = (await sellerRead.json()).offer.subject;
  const view = (offer: Offer, unitAmountMinor: number, requestSummary: unknown = summary) => ({
    offer: {
      id: offer.id,
      targetSubjectId: offer.targetSubjectId,
      summary: requestSummary,
      title: offer.title,
      currency: offer.currency,
      unitAmountMinor,
      state: 'active',
    },
  });

  // The first missing capability must fail at the actual HTTP boundary, after
  // genuine native purchases, owner grants and same-partition controls succeed.
  const first = await patch(seller.bearer, a.value.id);
  const accepted = await first.json();
  expect({ status: first.status, body: accepted }).toEqual({ status: 200, body: view(a.value, 2400) });
  expect(first.headers.get(SESSION_HEADER)).toBeTruthy();
  const after = await inspect();
  expect(after.offers[0]!.row).toEqual({
    ...before.offers[0]!.row,
    unit_amount_minor: 2400,
    revision: a.value.revision + 1,
    updated_at: expect.any(String),
    transaction_id: expect.any(String),
  });
  expect(after.offers.slice(1)).toEqual(before.offers.slice(1));
  expect(after.counters).toEqual(
    before.counters.map(({ row }) => ({
      row: { ...row, position: row.position + (row.partition_no === a.partition ? 1 : 0) },
    })),
  );
  for (const field of ['orders', 'entitlements', 'transactions', 'sessions', 'providerRequests'] as const)
    expect(after[field]).toEqual(before[field]);
  expect(after.receipts).toHaveLength(1);
  expect(after.receipts[0]!.row.response).toMatchObject({ id: a.value.id, unitAmountMinor: 2400 });
  expect(after.receipts[0]!.row.transaction_id).toBe(after.offers[0]!.row.transaction_id);
  expect(after.events.map((e) => ({ type: e.row.type, subject: e.row.subject, data: e.row.data }))).toEqual([
    { type: 'com.rezics.commerce.offer.revised.v1', subject: a.value.id, data: { offerId: a.value.id } },
  ]);
  const publicRead = await get(a.value.id);
  expect(publicRead.status).toBe(200);
  const publicOffer = (await publicRead.json()).offer;
  expect(publicOffer).toMatchObject({ id: a.value.id, revision: a.value.revision + 1, unitAmountMinor: 2400 });
  expect(Object.keys(publicOffer).sort()).toEqual([
    'currency',
    'id',
    'revision',
    'state',
    'subject',
    'targetSubjectId',
    'title',
    'unitAmountMinor',
  ]);

  async function unchanged(run: () => Promise<void>) {
    const beforeAttempt = await inspect();
    await run();
    expect(await inspect()).toEqual(beforeAttempt);
  }
  const replay = async (bearer = seller.bearer) => {
    const response = await patch(bearer, a.value.id);
    expect({ status: response.status, body: await response.json() }).toEqual({ status: 200, body: accepted });
  };
  await unchanged(() => replay());
  await unchanged(async () => {
    await problem(await patch(seller.bearer, b.value.id), 422, 'idempotency_conflict');
    await problem(
      await patch(seller.bearer, a.value.id, { unitAmountMinor: 2500, expectedRevision: a.value.revision }),
      422,
      'idempotency_conflict',
    );
  });
  const later = await patch(
    seller.bearer,
    a.value.id,
    { unitAmountMinor: 3600, expectedRevision: a.value.revision + 1 },
    laterKey,
  );
  expect({ status: later.status, body: await later.json() }).toEqual({ status: 200, body: view(a.value, 3600) });
  expect((await inspect()).offers[0]!.row.revision).toBe(a.value.revision + 2);
  await unchanged(() => replay());
  const refreshed = await accountToken({ ...seller.actor, scopes });
  await unchanged(() => replay(refreshed));
  expect((await (await get(a.value.id)).json()).offer.unitAmountMinor).toBe(3600);
  await unchanged(async () => {
    await problem(
      await patch(seller.bearer, a.value.id, { unitAmountMinor: 2400, expectedRevision: a.value.revision }, entryKey()),
      409,
      'offer_revision_conflict',
    );
  });
  const second = await patch(
    seller.bearer,
    b.value.id,
    { unitAmountMinor: 2400, expectedRevision: a.value.revision },
    secondKey,
  );
  expect({ status: second.status, body: await second.json() }).toEqual({
    status: 200,
    body: view(b.value, 2400, null),
  });

  await unchanged(async () => {
    for (const body of [
      {},
      { unitAmountMinor: 2400 },
      ...[0, -1, 1.5, '1', null, Number.MAX_SAFE_INTEGER + 1].map((expectedRevision) => ({
        unitAmountMinor: 2400,
        expectedRevision,
      })),
      null,
      [],
      '2400',
      ...[0, -1, 1.5, '2400', null, Number.MAX_SAFE_INTEGER + 1].map((unitAmountMinor) => ({ unitAmountMinor })),
      { unitAmountMinor: 2400, revision: 1 },
      { unitAmountMinor: 2400, offerId: b.value.id },
    ])
      await problem(await patch(seller.bearer, a.value.id, body, secondKey), 400, 'invalid_request');
    await problem(
      await f.send(seller.bearer, 'PATCH', `/v1/offers/${a.value.id}`, undefined, deniedKey),
      400,
      'invalid_request',
    );
  });
  const unscoped = await accountToken({ ...seller.actor, scopes: ['offer:read'] });
  await unchanged(async () => {
    const hidden = await problem(await patch(seller.bearer, f.unknownSubject()), 404, 'not_found');
    for (const key of [requestKey, deniedKey]) {
      expect(
        await problem(
          await patch(bob.bearer, a.value.id, { unitAmountMinor: 2400, expectedRevision: a.value.revision }, key),
          404,
          'not_found',
        ),
      ).toEqual(hidden);
      expect(
        await problem(
          await patch(
            seller.bearer,
            foreign.value.id,
            { unitAmountMinor: 2400, expectedRevision: a.value.revision },
            key,
          ),
          404,
          'not_found',
        ),
      ).toEqual(hidden);
      await problem(
        await patch(unscoped, a.value.id, { unitAmountMinor: 2400, expectedRevision: a.value.revision }, key),
        403,
        'forbidden',
      );
      for (const bearer of ['anonymous', 'invalid.token.bytes']) {
        const response = await patch(
          bearer,
          a.value.id,
          { unitAmountMinor: 2400, expectedRevision: a.value.revision },
          key,
        );
        expect(response.headers.get('www-authenticate')).toBe(
          bearer === 'anonymous' ? 'Bearer' : 'Bearer error="invalid_token"',
        );
        await problem(response, 401, bearer === 'anonymous' ? 'authentication_required' : 'invalid_credentials');
      }
    }
    await problem(await patch(seller.bearer, 'not-an-offer'), 404, 'not_found');
  });
  expect((await f.send('steward', 'POST', '/v1/platform/exposure/selling:close')).status).toBe(200);
  await unchanged(async () => {
    await problem(await patch(seller.bearer, a.value.id), 403, 'platform_closed');
  });
  expect((await f.send('steward', 'POST', '/v1/platform/exposure/selling:open')).status).toBe(200);
  await f.revokeIdentity(seller.actor.accountId);
  await unchanged(async () => {
    for (const key of [requestKey, deniedKey]) {
      const response = await patch(
        seller.bearer,
        a.value.id,
        { unitAmountMinor: 2400, expectedRevision: a.value.revision },
        key,
      );
      expect(response.headers.get('www-authenticate')).toBe('Bearer error="invalid_token"');
      await problem(response, 401, 'invalid_credentials');
    }
  });
  const final = await inspect();
  expect(final.receipts).toHaveLength(3);
  expect(final.events).toHaveLength(3);
  expect(final.offers[0]!.row.unit_amount_minor).toBe(3600);
  expect(final.offers[1]!.row).toMatchObject({ unit_amount_minor: 2400, revision: b.value.revision + 1 });
  for (const field of ['orders', 'entitlements', 'transactions', 'sessions', 'providerRequests'] as const)
    expect(final[field]).toEqual(before[field]);
}, 120_000);
