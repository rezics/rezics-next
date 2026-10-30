import { expect } from 'bun:test';
import { Pool, type PoolClient } from 'pg';
import Stripe from 'stripe';
import { PLATFORM_RESOURCE } from '../../../src/access/bootstrap-governance.ts';
import { createGrantCommands } from '../../../src/access/grant-commands.ts';
import {
  createCheckoutAnchorResolver,
  type CheckoutAnchorResolver,
} from '../../../src/commerce/checkout-anchor.ts';
import { createCommerceCommands } from '../../../src/commerce/commands.ts';
import type { Order } from '../../../src/commerce/model.ts';
import { createStripePort } from '../../../src/commerce/stripe.ts';
import { classifyStripeEvent, verifyStripeEvent } from '../../../src/commerce/webhook.ts';
import { partitionOf, routeOf } from '../../../src/route/route.ts';
import { createProfileEntryFixture, entryKey } from '../../library/support/profile-entry-fixture.ts';
import { dropTestDatabase } from '../../support/drop-test-database.ts';
import { openGrowthDatabase } from '../../support/growth.ts';
import { startFakeStripe } from './fake-stripe.ts';

export type NativeAnchorFixture = Awaited<ReturnType<typeof nativeAnchorFixture>>;
type QueryTrace = { text: string; values: unknown[]; backend: number; result?: unknown; error?: unknown };
// Observe real resolver output as unknown for deep equality against independently inferred expectations.
// Preserve the production method inputs and implementation; no result is transformed or error caught.
type ObservedAnchorResolver = {
  [Operation in keyof CheckoutAnchorResolver]: (
    ...input: Parameters<CheckoutAnchorResolver[Operation]>
  ) => Promise<unknown>;
};

/** Lower-level native service fixture, not Auth deletion/persona/HTTP admission evidence. */
export async function nativeAnchorFixture() {
  const original = process.env.DATABASE_URL;
  if (!original) throw new Error('DATABASE_URL must name the migrated test database');
  const url = new URL(original);
  url.pathname = '/postgres';
  const owner = new Pool({ connectionString: url.toString(), max: 1 });
  const cleanup: (() => unknown | Promise<unknown>)[] = [() => owner.end()];
  async function close() {
    for (const dispose of cleanup.splice(0).reverse()) await dispose();
  }
  try {
    const name = `anchor_${entryKey().replaceAll('-', '')}`;
    await owner.query(`CREATE DATABASE ${name} TEMPLATE rezics`);
    cleanup.push(() => dropTestDatabase(owner, name));
    url.pathname = `/${name}`;
    const db = await openGrowthDatabase(url.toString());
    cleanup.push(() => db.close());
    process.env.DATABASE_URL = url.toString();
    let f;
    try {
      f = await createProfileEntryFixture({ pool: db.pool });
    } finally {
      process.env.DATABASE_URL = original;
    }
    cleanup.push(() => f.close());
    const reader = new Pool({
      connectionString: url.toString(),
      max: 1,
      options: '-c default_transaction_read_only=on',
    });
    cleanup.push(() => reader.end());
    const service = db.openPool({ max: 2, options: '-c statement_timeout=200 -c lock_timeout=100' });
    const trace: QueryTrace[] = [];
    let active = 0;
    let maximum = 0;
    service.on('acquire', () => {
      active++;
      maximum = Math.max(maximum, active);
    });
    service.on('release', () => {
      active--;
    });
    service.on('connect', (client: PoolClient) => {
      const query = client.query.bind(client);
      client.query = ((...args: unknown[]) => {
        const config = args[0] as { text?: string; values?: unknown[] };
        const row: QueryTrace = {
          text: typeof args[0] === 'string' ? args[0] : (config.text ?? ''),
          values: (Array.isArray(args[1]) ? args[1] : config.values) ?? [],
          backend: (client as PoolClient & { processID: number }).processID,
        };
        trace.push(row);
        const last = args.length - 1;
        if (typeof args[last] === 'function') {
          const callback = args[last] as (error: unknown, result: unknown) => void;
          args[last] = (error: unknown, result: unknown) => {
            row.error = error;
            row.result = result;
            callback(error, result);
          };
        }
        const result = (query as (...a: unknown[]) => unknown)(...args);
        if (result instanceof Promise)
          return result.then(
            (value) => {
              row.result = value;
              return value;
            },
            (error) => {
              row.error = error;
              throw error;
            },
          );
        return result;
      }) as PoolClient['query'];
    });
    const fake = startFakeStripe();
    cleanup.push(() => fake.stop());
    const requests: {
      method: string;
      path: string;
      params: string;
      requestBytes: number;
      responseBytes: number;
      active: number;
    }[] = [];
    const control = { status: 0, listSession: null as string | null, emptyList: false, checkReleased: false };
    const proxy = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      async fetch(request) {
        const u = new URL(request.url);
        const body = request.method === 'POST' ? await request.text() : undefined;
        const response = control.status
          ? Response.json(
              { error: { type: 'api_error', message: 'fixture unavailable' } },
              {
                status: control.status,
                headers: { 'stripe-should-retry': 'false' },
              },
            )
          : await fetch(`http://127.0.0.1:${fake.port}${u.pathname}${u.search}`, {
              method: request.method,
              headers: request.headers,
              ...(body === undefined ? {} : { body }),
            });
        let bytes = await response.text();
        // Adversarial provider response; no native fact or SDK method is replaced.
        if (control.listSession && u.pathname === '/v1/checkout/sessions' && request.method === 'GET')
          bytes = JSON.stringify({
            object: 'list',
            data: [fake.sessions.get(control.listSession)],
            has_more: false,
            url: u.pathname,
          });
        if (control.emptyList && u.pathname === '/v1/checkout/sessions' && request.method === 'GET')
          bytes = JSON.stringify({ object: 'list', data: [], has_more: false, url: u.pathname });
        requests.push({
          method: request.method,
          path: u.pathname,
          params: u.searchParams.toString(),
          requestBytes: Buffer.byteLength(u.pathname + u.search + (body ?? '')),
          responseBytes: Buffer.byteLength(bytes),
          active,
        });
        if (control.checkReleased) expect(active).toBe(0);
        return new Response(bytes, { status: response.status, headers: response.headers });
      },
    });
    cleanup.push(() => proxy.stop(true));
    const stripe = createStripePort({
      apiKey: 'sk_test_native_anchor',
      managedPayments: false,
      host: '127.0.0.1',
      port: proxy.port!,
      protocol: 'http',
      maxNetworkRetries: 0,
      clock: () => new Date(),
    });
    const commands = createCommerceCommands({ pool: db.pool, access: f.access });
    const buyer = await f.identity(['order:create', 'order:read']);
    const seller = await f.identity(['offer:create', 'offer:manage']);
    for (const group of ['selling', 'purchases'])
      expect((await f.send('steward', 'POST', `/v1/platform/exposure/${group}:open`, {})).status).toBe(200);
    await createGrantCommands({ pool: db.pool, access: f.access, managementAction: 'access:grant' }).create(
      { pool: db.pool, actor: f.steward.actor, deadline: Date.now() + 30_000 },
      {
        resource: PLATFORM_RESOURCE,
        subject: { kind: 'account', id: seller.actor.accountId },
        actions: ['offer:create'],
        valid: '(,)',
        key: entryKey(),
      },
    );
    const offer = (
      await commands.createOffer(
        seller.actor,
        {
          targetSubjectId: await f.createSubject('game'),
          title: 'Native anchor captured book',
          currency: 'usd',
          unitAmountMinor: 1200,
          taxCode: 'txcd_10302000',
        },
        entryKey(),
      )
    ).value;
    async function checkout(bound = true, paid = false): Promise<Order> {
      const order = (await commands.createOrder(buyer.actor, offer.id, entryKey())).value;
      if (!bound) return order;
      const session = await stripe.createCheckoutSession(
        {
          orderId: order.id,
          buyerAccountId: order.buyerAccountId,
          title: order.title,
          currency: order.currency,
          unitAmountMinor: order.unitAmountMinor,
          taxCode: order.taxCode,
          successUrl: 'https://web.test/success',
          cancelUrl: 'https://web.test/cancel',
          expiresAt: Math.floor(Date.now() / 1000) + 3600,
        },
        `order:${order.id}`,
      );
      await commands.recordCheckout(order.id, { session });
      if (paid) {
        fake.pay(session.id);
        const claim = await commands.beginCheckoutRefresh({
          orderId: order.id,
          sessionId: session.id,
          workflowId: `wf:${entryKey()}`,
        });
        if (claim.kind !== 'claimed') throw new Error('Expected native paid setup admission');
        expect(
          (await commands.applyClaimedCheckoutSnapshot(await stripe.readCheckout(session.id), claim.command.value))
            .changed,
        ).toBe(true);
      }
      const recorded = (await commands.readOrderForAccount(buyer.actor.accountId, order.id))!;
      expect(recorded.checkoutSessionId).toBe(session.id);
      expect(recorded.settlement).toBe(paid ? 'paid' : 'pending');
      return recorded;
    }
    async function event(order: Order, pi = false, livemode = false) {
      const delivery = await fake.event(
        pi ? 'charge.refunded' : 'checkout.session.completed',
        pi ? fake.chargeId(order.checkoutSessionId!) : order.checkoutSessionId!,
      );
      const body = JSON.parse(delivery.bytes);
      body.livemode = livemode;
      const bytes = JSON.stringify(body);
      const signature = await new Stripe('sk_test_signing_fixture').webhooks.generateTestHeaderStringAsync({
        payload: bytes,
        secret: fake.webhookSecret,
        cryptoProvider: Stripe.createSubtleCryptoProvider(),
      });
      const ref = classifyStripeEvent(
        await verifyStripeEvent(Buffer.from(bytes), signature, [fake.webhookSecret], Date.now()),
      );
      if (!ref) throw new Error('Native fixture event must verify and classify');
      return ref;
    }
    async function state(order: Order) {
      const route = routeOf(order.id)!;
      const point = [route, order.id];
      return {
        order: (
          await reader.query(
            'SELECT to_jsonb(o) AS row FROM commerce.purchase_order o WHERE route=$1 AND order_id=$2',
            point,
          )
        ).rows,
        receipts: (
          await reader.query(
            'SELECT to_jsonb(r) AS row FROM core.receipt r WHERE partition_no=$1 AND principal_id=$2 ORDER BY command_kind,idempotency_key',
            [partitionOf(route), order.buyerAccountId],
          )
        ).rows,
        events: (
          await reader.query(
            'SELECT to_jsonb(o) AS row FROM core.outbox o WHERE partition_no=$1 AND subject=$2 ORDER BY position,event_seq',
            [partitionOf(route), order.id],
          )
        ).rows,
        head: (
          await reader.query('SELECT epoch,position FROM core.partition WHERE partition_no=$1', [partitionOf(route)])
        ).rows,
      };
    }
    const resolver = (livemode = false): ObservedAnchorResolver =>
      createCheckoutAnchorResolver({
        pool: service,
        stripe,
        provider: { accountNamespace: 'direct-fixture-account', livemode },
      });
    function reset() {
      trace.length = 0;
      requests.length = 0;
      maximum = active;
      control.checkReleased = true;
    }
    function assertWork(order: Order, providerCalls: number, points = 1) {
      expect(requests).toHaveLength(providerCalls);
      expect(requests.every((r) => r.method === 'GET' && r.active === 0 && r.responseBytes > 0)).toBe(true);
      expect(
        requests.every((r) => /^\/v1\/checkout\/sessions(?:\/[^/]+)?$/.test(r.path) && !r.params.includes('expand')),
      ).toBe(true);
      expect(trace).toHaveLength(points);
      for (const row of trace) {
        expect(row.text).toMatch(/FROM commerce\.purchase_order.*WHERE route\s*=\s*\$1 AND order_id\s*=\s*\$2/is);
        expect(row.text).not.toMatch(/FOR UPDATE|FOR SHARE|JOIN|INSERT|UPDATE|DELETE/i);
        expect(row.values).toEqual([routeOf(order.id), order.id]);
        expect(row.error).toBeFalsy();
        expect(row.result).toBeDefined();
      }
      expect(active).toBe(0);
      expect(maximum).toBeLessThanOrEqual(1);
    }
    return {
      db,
      service,
      reader,
      f,
      commands,
      buyer,
      seller,
      offer,
      stripe,
      fake,
      requests,
      trace,
      control,
      checkout,
      event,
      state,
      resolver,
      reset,
      assertWork,
      maximum: () => maximum,
      close,
    };
  } catch (error) {
    await close();
    throw error;
  }
}
