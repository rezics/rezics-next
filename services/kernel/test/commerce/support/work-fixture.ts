import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import type { Pool } from 'pg';
import { createAccess } from '../../../src/access/index.ts';
import { checkout as httpCheckout } from '../../../src/commerce/checkout.ts';
import { StripeRejectedError, StripeUnavailableError, type StripePort } from '../../../src/commerce/model.ts';
import { createCommerceCommands } from '../../../src/commerce/commands.ts';
import { createCommerceWork as createEnqueue } from '../../../src/commerce/enqueue.ts';
import { createStripePort } from '../../../src/commerce/stripe.ts';
import { verifyStripeEvent, classifyStripeEvent } from '../../../src/commerce/webhook.ts';
import type { Order } from '../../../src/commerce/model.ts';
import { createPool } from '../../../src/database/pool.ts';
import { createWorkClient } from '../../../src/work/client.ts';
import { newId, routeOf } from '../../../src/route/route.ts';
import { GLOBAL_CONTEXT } from '../../../src/semantic/definitions.ts';
import { startWorkStripe } from './work-stripe.ts';

export async function until<T>(read: () => Promise<T>, accept: (value: T) => boolean): Promise<T> {
  const deadline = Date.now() + 15_000;
  for (;;) {
    const value = await read();
    if (accept(value)) return value;
    if (Date.now() > deadline) throw new Error(`Timed out: ${JSON.stringify(value)}`);
    await Bun.sleep(10);
  }
}

export async function workFixture(options: { readonly pool?: Pool } = {}) {
  const databaseUrl = process.env.DATABASE_URL!;
  if (!databaseUrl) throw new Error('DATABASE_URL must name the migrated test database');
  const ownsPool = options.pool === undefined;
  const pool = options.pool ?? createPool(databaseUrl);
  const client = await createWorkClient(databaseUrl);
  const transport = startWorkStripe();
  const providerStripe = createStripePort({
    apiKey: 'sk_test_work',
    managedPayments: false,
    host: '127.0.0.1',
    port: transport.port,
    protocol: 'http',
    maxNetworkRetries: 0,
    clock: () => new Date(),
  });
  const signing = await generateKeyPair('ES256');
  const jwk = { ...(await exportJWK(signing.publicKey)), kid: 'work', alg: 'ES256' };
  const actions = ['access:grant', 'offer:create', 'offer:read', 'offer:manage', 'order:create'];
  const access = createAccess({
    actions: new Map(
      actions.map((action) => [
        action,
        {
          anonymous: false,
          ...(action === 'offer:create' ? { 'x-resource-types': ['commerce.offer'] } : {}),
        },
      ]),
    ),
    auth: {
      issuer: 'https://auth.test',
      audience: 'https://kernel.test',
      jwksUrl: 'https://auth.test/jwks',
      fetch: async () => Response.json({ keys: [jwk] }),
    },
  });
  const commands = createCommerceCommands({ pool, access });
  // Direct fixture setup must admit the same native creation intent as HTTP/work.
  // The provider fixture and its idempotency/error behavior remain unchanged.
  const stripe: StripePort = {
    ...providerStripe,
    async createCheckoutSession(request, providerKey) {
      if (routeOf(request.orderId) === null || providerKey !== `order:${request.orderId}`)
        return providerStripe.createCheckoutSession(request, providerKey);
      const admission = await commands.beginCheckoutCreation(request.orderId, {
        successUrl: request.successUrl,
        cancelUrl: request.cancelUrl,
        managedPayments: providerStripe.managedPayments ?? false,
      });
      if (admission.kind === 'failed') throw new StripeRejectedError('Checkout creation expired');
      if (admission.kind !== 'ready') throw new StripeUnavailableError('Checkout creation unavailable');
      return providerStripe.createCheckoutSession(admission.attempt.request, admission.attempt.providerKey);
    },
  };
  const seller = newId(0x2200),
    buyer = newId(0x3300);
  for (const accountId of [seller, buyer])
    await pool.query(
      "INSERT INTO access.account(route,account_id,kind,state,transaction_id) VALUES ($1,$2,'actor','active',$2)",
      [routeOf(accountId), accountId],
    );
  await pool.query(
    "INSERT INTO access.resource_grant(route,resource_id,subject_id,action,valid,transaction_id) VALUES (0,$1,$2,'offer:create','(,)',$2)",
    [GLOBAL_CONTEXT, seller],
  );
  async function actor(accountId: string) {
    const token = await new SignJWT({
      client_id: 'web',
      scope: actions.join(' '),
      authn_epoch: 1,
      auth_time: Math.floor(Date.now() / 1000),
      amr: ['pwd'],
    })
      .setProtectedHeader({ alg: 'ES256', kid: 'work', typ: 'at+jwt' })
      .setIssuer('https://auth.test')
      .setAudience('https://kernel.test')
      .setSubject(accountId)
      .setIssuedAt()
      .setExpirationTime('5m')
      .sign(signing.privateKey);
    return access.authenticate(token, { pool, deadline: Date.now() + 5000 });
  }
  const offer = (
    await commands.createOffer(
      await actor(seller),
      {
        targetSubjectId: newId(0x5500),
        title: 'Book',
        currency: 'usd',
        unitAmountMinor: 1200,
        taxCode: 'txcd_10302000',
      },
      Bun.randomUUIDv7(),
    )
  ).value;
  let child: ReturnType<typeof Bun.spawn> | undefined;
  let errors = '';
  async function stop() {
    if (!child) return;
    child.kill('SIGKILL');
    await child.exited;
    child = undefined;
  }
  async function start(offset = 0, checkout: { successUrl?: string; cancelUrl?: string } = {}) {
    child = Bun.spawn([process.execPath, `${import.meta.dir}/work-runtime.ts`], {
      env: {
        ...process.env,
        WORK_STRIPE_PORT: String(transport.port),
        WORK_CLOCK_OFFSET: String(offset),
        WORK_SUCCESS_URL: checkout.successUrl ?? 'https://example.test/success',
        WORK_CANCEL_URL: checkout.cancelUrl ?? 'https://example.test/cancel',
      },
      stdout: 'pipe',
      stderr: 'pipe',
    });
    let output = '';
    const running = child;
    void (async () => {
      for await (const bytes of running.stdout as ReadableStream<Uint8Array>) output += new TextDecoder().decode(bytes);
    })();
    void (async () => {
      for await (const bytes of running.stderr as ReadableStream<Uint8Array>) errors += new TextDecoder().decode(bytes);
    })();
    await until(
      async () => {
        if (running.exitCode !== null) throw new Error(`Worker exited: ${errors}`);
        return output;
      },
      (value) => value.includes('ready'),
    );
  }
  return {
    pool,
    client,
    commands,
    stripe,
    providerStripe,
    transport,
    buyer,
    start,
    stop,
    async checkoutRequest(
      requestKey: string,
      options: {
        successUrl?: string;
        cancelUrl?: string;
        stripe?: StripePort;
        clockOffset?: number;
      } = {},
    ) {
      const buyerActor = await actor(buyer);
      const realNow = Date.now;
      const clockOffset = options.clockOffset ?? 0;
      if (clockOffset) Date.now = () => realNow() + clockOffset;
      try {
        return await httpCheckout(
          {
            pool,
            commands,
            stripe: options.stripe ?? providerStripe,
            successUrl: options.successUrl ?? 'https://example.test/success',
            cancelUrl: options.cancelUrl ?? 'https://example.test/cancel',
          },
          buyerActor,
          offer.id,
          offer.revision,
          requestKey,
        );
      } finally {
        Date.now = realNow;
      }
    },
    async orderForRequest(requestKey: string) {
      return (await commands.createOrder(await actor(buyer), offer.id, offer.revision, requestKey)).value;
    },
    async order() {
      return (await commands.createOrder(await actor(buyer), offer.id, offer.revision, Bun.randomUUIDv7())).value;
    },
    request(order: Order) {
      return {
        orderId: order.id,
        buyerAccountId: order.buyerAccountId,
        title: order.title,
        currency: order.currency,
        unitAmountMinor: order.unitAmountMinor,
        taxCode: order.taxCode,
        expiresAt: Math.floor(Date.parse(order.createdAt) / 1000) + 3600,
        successUrl: 'https://example.test/success',
        cancelUrl: 'https://example.test/cancel',
      };
    },
    async checkout() {
      const order = await this.order();
      const session = await stripe.createCheckoutSession(this.request(order), `order:${order.id}`);
      await commands.recordCheckout(order.id, { session });
      return { order, session };
    },
    async deliver(type: string, objectId: string) {
      const event = await transport.fake.event(type, objectId);
      const verified = await verifyStripeEvent(
        new TextEncoder().encode(event.bytes),
        event.signature,
        [transport.fake.webhookSecret],
        Date.now(),
      );
      const ref = classifyStripeEvent(verified)!;
      await createEnqueue(client).enqueueStripeEvent(ref);
      return { id: `stripe:${ref.eventId}`, ref };
    },
    async finish(id: string) {
      await until(
        () => client.getWorkflow(id),
        (row) => row?.status === 'SUCCESS' || row?.status === 'ERROR',
      );
      return client.retrieveWorkflow(id).getResult();
    },
    async state(orderId: string) {
      return (
        await pool.query(
          'SELECT settlement, revision, observed_at::text FROM commerce.purchase_order WHERE route=$1 AND order_id=$2',
          [routeOf(orderId), orderId],
        )
      ).rows[0]!;
    },
    async entitlements(orderId: string) {
      return (
        await pool.query('SELECT * FROM commerce.entitlement WHERE route=$1 AND order_id=$2', [
          routeOf(orderId),
          orderId,
        ])
      ).rows;
    },
    async events(orderId: string, type: string) {
      return (
        await pool.query("SELECT * FROM core.outbox WHERE data->>'orderId'=$1 AND type=$2", [
          orderId,
          `com.rezics.commerce.${type}.v1`,
        ])
      ).rows;
    },
    async schedule(orderId: string) {
      const event = (await this.events(orderId, 'order.created'))[0]!;
      const workflowID = `fx:${event.epoch}:${event.partition_no}:${event.position}:${event.event_seq}:commerce_reconcile_order`;
      await client.enqueue(
        {
          workflowName: 'effect',
          queueName: 'effects',
          queuePartitionKey: String(event.partition_no),
          workflowID,
          workflowIDReusePolicy: 'return-existing',
        },
        'commerce_reconcile_order',
        {
          specversion: '1.0',
          id: event.id,
          source: `urn:rezics:log:${event.partition_no}.${event.epoch}`,
          type: event.type,
          subject: orderId,
          time: event.recorded_at.toISOString(),
          sequence: String(event.position).padStart(19, '0'),
          datacontenttype: 'application/json',
          data: event.data,
        },
      );
      await this.finish(workflowID);
      return `order:${orderId}:reconcile`;
    },
    async close() {
      await stop();
      transport.stop();
      await client.close();
      if (ownsPool) await pool.end();
    },
  };
}
