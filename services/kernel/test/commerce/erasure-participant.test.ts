import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test';
import { createCurrentConsentReader } from '@rezics/auth/current-consent';
import { bundledRelease } from '@rezics/definitions/bundled';
import { bootstrapLocalShowcaseBoardCreation, PLATFORM_RESOURCE } from '../../src/access/bootstrap-governance.ts';
import { GrantDeniedError } from '../../src/access/grant-commands.ts';
import { createWriteRateLimiter } from '../../src/access/write-rate.ts';
import { readErasureStatus, resolveRetention } from '../../src/access/erasure.ts';
import { createCommerceCommands } from '../../src/commerce/commands.ts';
import {
  advanceCommerceErasure,
  commerceErasureWorkflowId,
  COMMERCE_CUSTODY_BLOCKER,
  FINANCIAL_ERASURE_BLOCKER,
  NATIVE_TEST_ORDER_RETENTION_FIELDS,
  NATIVE_TEST_ORDER_RETENTION_PURPOSE,
  ORDER_RETENTION_STORE,
} from '../../src/commerce/erasure-participant.ts';
import { createCommerceWork } from '../../src/commerce/enqueue.ts';
import { createStripePort } from '../../src/commerce/stripe.ts';
import { createPool } from '../../src/database/pool.ts';
import { createKernel } from '../../src/http/kernel.ts';
import { partitionOf, routeOf } from '../../src/route/route.ts';
import { bootstrapRelease } from '../../src/semantic/definitions.ts';
import { createWorkClient } from '../../src/work/client.ts';
import { nativeFixture } from '../access/native-account-bindings-fixture.ts';
import { accountDeletionRuntime, deletePersona, drainEffects } from '../support/account-deletion.ts';
import { createPersonas } from '../support/personas.ts';
import { testReceiptKeys } from '../support/receipt-keys.ts';
import { testKernel, type TestKernel } from '../support/test-kernel.ts';
import { workerTestEnv } from '../support/worker-env.ts';
import { createNativeEditionFixture, type NativeContentEdition } from './support/native-edition-fixture.ts';
import {
  encodeNativeKeyRing,
  encodeNativeRouteKey,
  inspectNativeRetainedOrder,
  prepareNativeRetainedOrder,
} from './support/order-retention-fixture.ts';
import { startWorkStripe } from './support/work-stripe.ts';
import { HIGH_RATE_OVERRIDES, seedGovernanceAuthority } from '../content/support/disclosure-fixtures.ts';
import {
  createNativeContentSystemWithWriteRateOverrides,
  type NativeContentSystem,
} from '../content/support/native-system.ts';

async function waitUntil<T>(read: () => Promise<T>, accept: (value: T) => boolean, ms = 90_000): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = await read();
    if (accept(value)) return value;
    if (Date.now() > deadline) throw new Error(`Timed out: ${JSON.stringify(value)}`);
    await Bun.sleep(25);
  }
}

setDefaultTimeout(120_000);

describe('native genuine-order retention', () => {
  const urls = { successUrl: 'https://example.test/success', cancelUrl: 'https://example.test/cancel' };
  let native: NativeContentSystem;
  let kernel: ReturnType<typeof createKernel>;
  let pool: NativeContentSystem['database']['pool'];
  let databaseUrl: string;
  let client: Awaited<ReturnType<typeof createWorkClient>>;
  let worker: ReturnType<typeof Bun.spawn> | undefined;
  let provider: ReturnType<typeof startWorkStripe>;
  let stripe: ReturnType<typeof createStripePort>;
  let commands: ReturnType<typeof createCommerceCommands>;
  let contentEdition: NativeContentEdition;
  let seller: { accountId: string; bearer: string };
  let buyer: { accountId: string; bearer: string };
  let unused: { accountId: string; bearer: string };
  let governance: Awaited<ReturnType<NativeContentSystem['auth']['issue']>>;

  async function request(persona: { bearer: string }, path: string, body?: unknown) {
    return kernel.handle(
      new Request(`http://kernel.test${path}`, {
        method: body === undefined ? 'GET' : 'POST',
        headers: {
          authorization: `Bearer ${persona.bearer}`,
          ...(body === undefined
            ? {}
            : {
                'content-type': 'application/json',
                'idempotency-key': JSON.stringify(crypto.randomUUID()),
              }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
    );
  }
  async function accepted(persona: { bearer: string }, path: string, body: unknown) {
    const response = await request(persona, path, body);
    const value = await response.json();
    if (!response.ok) throw new Error(`${path}: ${response.status} ${JSON.stringify(value)}`);
    return value;
  }
  async function grant(subjectId: string, resource: { route: number; id: string }, actions: string[]) {
    const response = await native.kernel.handle(
      new Request('http://kernel.test/v1/grants', {
        method: 'POST',
        headers: {
          authorization: `Bearer ${governance.bearer}`,
          'content-type': 'application/json',
          'idempotency-key': JSON.stringify(crypto.randomUUID()),
        },
        body: JSON.stringify({
          resource,
          subject: { kind: 'account', id: subjectId },
          actions,
          valid: '(,)',
        }),
      }),
    );
    if (response.status !== 201)
      throw new Error(`grant ${actions.join(',')}: ${response.status} ${await response.text()}`);
  }
  async function erase(persona: { accountId: string; bearer: string }) {
    const barrier = await deletePersona({ version: 1, pool, auth: accountDeletionRuntime(native).auth }, persona);
    await drainEffects(pool, partitionOf(routeOf(persona.accountId)!));
    const id = commerceErasureWorkflowId(persona.accountId);
    await waitUntil(
      () => client.getWorkflow(id),
      (row) => row !== null && row !== undefined,
    );
    await client.retrieveWorkflow(id).getResult();
    return barrier;
  }
  async function event(type: string, sessionId: string) {
    return postSignedEvent(await provider.fake.event(type, sessionId));
  }
  async function postSignedEvent(signed: { bytes: string; headers: Record<string, string> }) {
    const response = await kernel.handle(
      new Request('http://kernel.test/v1/webhooks/stripe', {
        method: 'POST',
        headers: signed.headers,
        body: signed.bytes,
      }),
    );
    expect(response.status).toBe(200);
    const eventId = (JSON.parse(signed.bytes) as { id: string }).id;
    return `stripe:${eventId}`;
  }
  async function finish(id: string) {
    await client.retrieveWorkflow(id).getResult();
  }
  async function entitlementRows(accountId: string) {
    return (
      await pool.query('SELECT entitlement_id FROM commerce.entitlement WHERE route=$1 AND account_id=$2', [
        routeOf(accountId),
        accountId,
      ])
    ).rows;
  }
  async function commerceOutcome(accountId: string) {
    return (await readErasureStatus(pool, accountId))?.participants.commerce;
  }

  async function startCommerceWorker() {
    const env = {
      ...process.env,
      ...workerTestEnv({
        DATABASE_URL: databaseUrl,
        STRIPE_SECRET_KEY: 'sk_test_erasure',
        STRIPE_MANAGED_PAYMENTS: 'false',
        STRIPE_API_HOST: `http://127.0.0.1:${provider.port}`,
        CHECKOUT_SUCCESS_URL: urls.successUrl,
        CHECKOUT_CANCEL_URL: urls.cancelUrl,
        KERNEL_ROUTE_KEY: encodeNativeRouteKey(native.routeKey),
        KERNEL_SESSION_KEYS: encodeNativeKeyRing(native.tokenKeys),
        KERNEL_WORKER_POOL_SIZE: '10',
        KERNEL_EXECUTOR_ID: `commerce-erasure-${crypto.randomUUID()}`,
      }),
    };
    const running = Bun.spawn([process.execPath, `${import.meta.dir}/support/erasure-participant-runtime.ts`], {
      env,
      stdout: 'pipe',
      stderr: 'pipe',
    });
    worker = running;
    let output = '',
      errors = '';
    void (async () => {
      for await (const bytes of running.stdout as ReadableStream<Uint8Array>) output += new TextDecoder().decode(bytes);
    })();
    void (async () => {
      for await (const bytes of running.stderr as ReadableStream<Uint8Array>) errors += new TextDecoder().decode(bytes);
    })();
    await waitUntil(
      async () => {
        if (running.exitCode !== null) throw new Error(`Kernel worker ${running.pid} exited: ${errors}`);
        return output;
      },
      (value) => value.includes('Commerce erasure worker ready'),
    );
  }

  async function stopCommerceWorker() {
    const running = worker;
    if (!running) return;
    running.kill('SIGTERM');
    await running.exited;
    worker = undefined;
  }

  beforeAll(async () => {
    native = await createNativeContentSystemWithWriteRateOverrides(
      { databaseUrl: process.env.DATABASE_URL! },
      HIGH_RATE_OVERRIDES,
    );
    pool = native.database.pool;
    databaseUrl = pool.options.connectionString!;
    if (!databaseUrl) throw new Error('Native Commerce isolation database URL is missing');
    await bootstrapRelease(pool, bundledRelease);
    const bootstrap = await pool.query<{ accountId: string }>(
      'SELECT account_id::text AS "accountId" FROM access.governance_bootstrap',
    );
    const governanceId = bootstrap.rows[0]?.accountId;
    if (!governanceId) throw new Error('Native governance account is missing');
    governance = await native.auth.issue({
      accountId: governanceId,
      clientId: native.auth.ordinaryClient.id,
      scopes: native.auth.ordinaryScopes,
    });
    client = await createWorkClient(databaseUrl);
    provider = startWorkStripe();
    stripe = createStripePort({
      apiKey: 'sk_test_erasure',
      managedPayments: false,
      host: '127.0.0.1',
      port: provider.port,
      protocol: 'http',
      maxNetworkRetries: 0,
      clock: () => new Date(),
    });
    const consent = createCurrentConsentReader({ database: native.database.authPool });
    kernel = createKernel({
      pool,
      routeKey: native.routeKey,
      tokens: native.tokenKeys,
      receiptKeys: testReceiptKeys(),
      access: native.access,
      writeRate: createWriteRateLimiter({
        secret: 'commerce-erasure-native-secret-32-bytes',
        overrides: HIGH_RATE_OVERRIDES,
      }),
      content: {
        cursorNow: () => Date.now(),
        readConsent: ({ actorAccountId, clientId }) => consent.readCurrentConsent({ actorAccountId, clientId }),
      },
      commerce: { stripe, ...urls, webhookSecrets: [provider.fake.webhookSecret], work: createCommerceWork(client) },
      workClient: client,
    });
    seller = { accountId: native.actors.author.actor.accountId, bearer: native.actors.author.bearer };
    buyer = { accountId: native.actors.other.actor.accountId, bearer: native.actors.other.bearer };
    unused = await accountDeletionRuntime(native).person();
    await bootstrapLocalShowcaseBoardCreation(pool, governance.actor.accountId);
    await grant(seller.accountId, PLATFORM_RESOURCE, ['board:create']);
    await grant(seller.accountId, PLATFORM_RESOURCE, ['offer:create']);
    for (const group of ['personal_library', 'purchases', 'selling'])
      await accepted(governance, `/v1/platform/exposure/${group}:open`, {});
    const editions = await createNativeEditionFixture(async (method, path, body, headers = {}) => {
      return native.kernel.handle(
        new Request(`http://kernel.test${path}`, {
          method,
          headers: { authorization: `Bearer ${seller.bearer}`, ...headers },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        }),
      );
    });
    contentEdition = await editions.publish({
      title: 'Native erasure book',
      subjectTitle: 'Native erasure source',
      body: 'Exact native content edition bytes',
    });
    commands = createCommerceCommands({ pool, access: native.access });
    await startCommerceWorker();
  }, 360_000);

  afterAll(async () => {
    try {
      await stopCommerceWorker();
    } finally {
      await client?.close();
      provider?.stop();
      await native?.close();
    }
  });

  test('the native financial participant minimizes an explicitly retained real order, expires it durably, and preserves late financial truth without restoring private benefits', async () => {
    const barrier = await erase(unused);
    expect(await commerceOutcome(unused.accountId)).toEqual({ outcome: 'none', retained: [] });
    expect((await readErasureStatus(pool, unused.accountId))?.at).toBe(barrier.at);
    expect(await advanceCommerceErasure(pool, unused.accountId)).toBe('none');
    expect(await commerceOutcome(unused.accountId)).toEqual({ outcome: 'none', retained: [] });
    expect(
      (
        await pool.query('SELECT phase,had_data FROM commerce.erasure_progress WHERE route=$1 AND account_id=$2', [
          routeOf(unused.accountId),
          unused.accountId,
        ])
      ).rows,
    ).toEqual([{ phase: 'none', had_data: false }]);
    await expect(advanceCommerceErasure(pool, seller.accountId)).rejects.toThrow('committed native');

    const offer = (
      await accepted(seller, '/v1/offers', {
        targetSubjectId: contentEdition.targetSubjectId,
        contentEditionId: contentEdition.contentEditionId,
        title: 'Native erasure book',
        currency: 'usd',
        unitAmountMinor: 1200,
        taxCode: 'txcd_10302000',
      })
    ).offer as { id: string; revision: number };
    await seedGovernanceAuthority(pool, routeOf(offer.id)!, offer.id, governance.actor.accountId, ['order:create']);
    await grant(buyer.accountId, { route: routeOf(offer.id)!, id: offer.id }, ['order:create']);
    const typedBuyer = await native.access.authenticate(buyer.bearer, { pool, deadline: Date.now() + 90_000 });
    const first = (await accepted(buyer, '/v1/orders', { offerId: offer.id, expectedOfferRevision: offer.revision }))
      .order as { id: string };
    const firstNative = (await commands.readOrderForAccount(buyer.accountId, first.id))!;
    provider.fake.pay(firstNative.checkoutSessionId!);
    await finish(await event('checkout.session.completed', firstNative.checkoutSessionId!));
    await drainEffects(pool, partitionOf(routeOf(buyer.accountId)!));
    const entitlement = (await entitlementRows(buyer.accountId))[0]!.entitlement_id as string;
    const second = (await accepted(buyer, '/v1/orders', { offerId: offer.id, expectedOfferRevision: offer.revision }))
      .order as { id: string };
    const secondNative = (await commands.readOrderForAccount(buyer.accountId, second.id))!;
    const expiresAt = new Date(Date.now() + 15_000);
    const firstRetention = await prepareNativeRetainedOrder(pool, first.id, expiresAt);
    const secondRetention = await prepareNativeRetainedOrder(pool, second.id, expiresAt);
    expect(firstRetention).toMatchObject({
      store: ORDER_RETENTION_STORE,
      fields: [...NATIVE_TEST_ORDER_RETENTION_FIELDS],
      purpose: NATIVE_TEST_ORDER_RETENTION_PURPOSE,
      expiresAt: expiresAt.toISOString(),
    });
    expect(secondRetention).toMatchObject({
      store: ORDER_RETENTION_STORE,
      fields: [...NATIVE_TEST_ORDER_RETENTION_FIELDS],
      purpose: NATIVE_TEST_ORDER_RETENTION_PURPOSE,
      expiresAt: expiresAt.toISOString(),
    });
    provider.fake.pay(secondNative.checkoutSessionId!);
    const held = provider.delayRead();
    const latePaidSigned = await provider.fake.event('checkout.session.completed', secondNative.checkoutSessionId!);
    const latePaid = await postSignedEvent(latePaidSigned);
    const buyerErasureId = commerceErasureWorkflowId(buyer.accountId);
    await held.captured;
    const purgeBarrier = await pool.connect();
    try {
      await purgeBarrier.query('BEGIN');
      await purgeBarrier.query(
        'SELECT entitlement_id FROM commerce.entitlement WHERE route=$1 AND account_id=$2 FOR UPDATE',
        [routeOf(buyer.accountId), buyer.accountId],
      );
      const buyerBarrier = await deletePersona({ version: 1, pool, auth: accountDeletionRuntime(native).auth }, buyer);
      await drainEffects(pool, partitionOf(routeOf(buyer.accountId)!));
      expect(await entitlementRows(buyer.accountId)).toHaveLength(1);
      expect(await commerceOutcome(buyer.accountId)).toEqual({ outcome: 'pending', retained: [] });
      for (const path of [`/v1/orders/${first.id}`, `/v1/entitlements/${entitlement}`, '/v1/entitlements'])
        expect((await request(buyer, path)).status).toBe(401);
      expect(await commands.readOrderForAccount(buyer.accountId, first.id)).toBeNull();
      expect(await commands.readEntitlementForAccount(buyer.accountId, entitlement)).toBeNull();
      expect(await commands.listEntitlementsForAccount(buyer.accountId, { after: null, limit: 100 })).toEqual([]);
      expect((await request(buyer, '/v1/orders', { offerId: offer.id })).status).toBe(401);
      await purgeBarrier.query('ROLLBACK');
      await waitUntil(
        () => client.getWorkflow(buyerErasureId),
        (row) => row !== null && row !== undefined,
      );
      await waitUntil(
        async () => (await commerceOutcome(buyer.accountId)) ?? null,
        (row) => row?.outcome === 'erased' && row.retained.length === 1 && row.retained[0]?.resolvedAt === null,
      );
      const retainedFirst = await inspectNativeRetainedOrder(pool, first.id);
      const retainedSecond = await inspectNativeRetainedOrder(pool, second.id);
      expect(retainedFirst).toMatchObject({
        orderId: first.id,
        buyerAccountId: buyer.accountId,
        checkoutUrl: firstNative.checkoutUrl,
      });
      expect(retainedSecond).toMatchObject({
        orderId: second.id,
        buyerAccountId: buyer.accountId,
        checkoutUrl: secondNative.checkoutUrl,
      });
      expect(Date.parse(retainedFirst!.expiresAt)).toBe(expiresAt.getTime());
      expect(Date.parse(retainedSecond!.expiresAt)).toBe(expiresAt.getTime());
      const minimizedOrders = (
        await pool.query(
          `SELECT order_id,checkout_session_id,checkout_url,checkout_expires_at,checkout_minimized_at,
                  settlement,unit_amount_minor::text AS unit_amount_minor,currency
           FROM commerce.purchase_order WHERE route=$1 AND order_id=ANY($2::uuid[]) ORDER BY order_id`,
          [routeOf(buyer.accountId), [first.id, second.id]],
        )
      ).rows;
      expect(minimizedOrders).toHaveLength(2);
      for (const order of minimizedOrders) {
        const source = order.order_id === first.id ? firstNative : secondNative;
        expect(order).toMatchObject({
          order_id: source.id,
          checkout_session_id: source.checkoutSessionId,
          checkout_url: null,
          checkout_expires_at: null,
          unit_amount_minor: '1200',
          currency: 'usd',
          settlement: source.id === first.id ? 'paid' : 'pending',
        });
        expect(Date.parse(order.checkout_minimized_at)).toBe(Date.parse(buyerBarrier.at));
      }
      expect(
        (
          await pool.query('SELECT order_id FROM commerce.money_observation WHERE route=$1 AND buyer_account_id=$2', [
            routeOf(buyer.accountId),
            buyer.accountId,
          ])
        ).rows,
      ).toEqual([]);
      expect(await entitlementRows(buyer.accountId)).toHaveLength(0);
      await expect(commands.createOrder(typedBuyer, offer.id, offer.revision, crypto.randomUUID())).rejects.toThrow(
        GrantDeniedError,
      );
      await erase(seller);
      await expect(commands.delistOffer(typedBuyer, offer.id, crypto.randomUUID())).rejects.toThrow(GrantDeniedError);
      await expect(
        commands.reviseOffer(typedBuyer, offer.id, { unitAmountMinor: 1300 }, crypto.randomUUID()),
      ).rejects.toThrow(GrantDeniedError);
      expect((await request(governance, '/v1/orders', { offerId: offer.id })).status).toBe(409);
      expect(await commerceOutcome(buyer.accountId)).toMatchObject({
        outcome: 'erased',
        retained: [
          {
            store: ORDER_RETENTION_STORE,
            fields: [...NATIVE_TEST_ORDER_RETENTION_FIELDS],
            purpose: NATIVE_TEST_ORDER_RETENTION_PURPOSE,
            expiresAt: expiresAt.toISOString(),
            resolvedAt: null,
          },
        ],
      });
      expect(await commerceOutcome(seller.accountId)).toEqual({ outcome: 'pending', retained: [] });
      expect(
        (
          await pool.query('SELECT phase,blocker FROM commerce.erasure_progress WHERE route=$1 AND account_id=$2', [
            routeOf(seller.accountId),
            seller.accountId,
          ])
        ).rows,
      ).toEqual([{ phase: 'pending', blocker: FINANCIAL_ERASURE_BLOCKER }]);
      expect(
        (
          await pool.query('SELECT phase,blocker FROM commerce.erasure_progress WHERE route=$1 AND account_id=$2', [
            routeOf(buyer.accountId),
            buyer.accountId,
          ])
        ).rows,
      ).toEqual([{ phase: 'retained', blocker: COMMERCE_CUSTODY_BLOCKER }]);
    } finally {
      try {
        await purgeBarrier.query('ROLLBACK');
      } finally {
        purgeBarrier.release();
        held.release();
      }
    }
    await stopCommerceWorker();
    await Bun.sleep(Math.max(0, expiresAt.getTime() - Date.now() + 25));
    expect(await advanceCommerceErasure(pool, buyer.accountId)).toBe('resolve');
    expect(await inspectNativeRetainedOrder(pool, first.id)).toBeNull();
    expect(await inspectNativeRetainedOrder(pool, second.id)).toBeNull();
    const purgedBeforeResolve = await readErasureStatus(pool, buyer.accountId);
    expect(purgedBeforeResolve?.participants.commerce?.retained[0]?.resolvedAt).toBeNull();
    await startCommerceWorker();
    await finish(buyerErasureId);
    expect(await inspectNativeRetainedOrder(pool, first.id)).toBeNull();
    expect(await inspectNativeRetainedOrder(pool, second.id)).toBeNull();
    const resolvedStatus = await readErasureStatus(pool, buyer.accountId);
    expect(resolvedStatus?.participants.commerce).toMatchObject({
      outcome: 'erased',
      retained: [
        {
          store: ORDER_RETENTION_STORE,
          fields: [...NATIVE_TEST_ORDER_RETENTION_FIELDS],
          purpose: NATIVE_TEST_ORDER_RETENTION_PURPOSE,
          expiresAt: expiresAt.toISOString(),
        },
      ],
    });
    const resolvedAt = resolvedStatus?.participants.commerce?.retained[0]?.resolvedAt;
    expect(resolvedAt).not.toBeNull();
    expect(Date.parse(resolvedAt!)).toBeGreaterThanOrEqual(expiresAt.getTime());
    await resolveRetention(
      { pool },
      { accountId: buyer.accountId, participant: 'commerce', store: ORDER_RETENTION_STORE },
    );
    expect((await readErasureStatus(pool, buyer.accountId))?.participants.commerce?.retained[0]?.resolvedAt).toBe(
      resolvedAt,
    );
    await finish(await postSignedEvent(latePaidSigned));
    await finish(latePaid);
    await drainEffects(pool, partitionOf(routeOf(buyer.accountId)!));
    expect(
      (
        await pool.query('SELECT settlement FROM commerce.purchase_order WHERE route=$1 AND order_id=$2', [
          routeOf(second.id),
          second.id,
        ])
      ).rows,
    ).toEqual([{ settlement: 'paid' }]);
    expect(await entitlementRows(buyer.accountId)).toHaveLength(0);
    expect(await inspectNativeRetainedOrder(pool, second.id)).toBeNull();
    expect(
      (
        await pool.query('SELECT order_id FROM commerce.money_observation WHERE route=$1 AND buyer_account_id=$2', [
          routeOf(buyer.accountId),
          buyer.accountId,
        ])
      ).rows,
    ).toEqual([]);

    const refund = provider.fake.refund(firstNative.checkoutSessionId!, { amount: 1200 });
    await finish(await event('charge.refunded', provider.fake.chargeId(firstNative.checkoutSessionId!)));
    provider.fake.failRefund(refund);
    await finish(await event('refund.updated', refund));
    await drainEffects(pool, partitionOf(routeOf(buyer.accountId)!));
    expect(await entitlementRows(buyer.accountId)).toHaveLength(0);
    expect(
      (
        await pool.query('SELECT kind FROM commerce.order_transaction WHERE route=$1 AND order_id=$2 ORDER BY kind', [
          routeOf(first.id),
          first.id,
        ])
      ).rows,
    ).toEqual([{ kind: 'charge' }, { kind: 'refund' }, { kind: 'refund_reversal' }]);
    expect(
      (
        await pool.query(
          `SELECT 1 FROM access.resource_role_grant WHERE route=$1 AND resource_id=$2
      AND grant_role='commerce.payout.owner' AND upper_inf(valid)`,
          [routeOf(seller.accountId), seller.accountId],
        )
      ).rows,
    ).toEqual([]);
    expect(await advanceCommerceErasure(pool, buyer.accountId)).toBe('pending');
    expect((await commerceOutcome(buyer.accountId))?.retained[0]?.resolvedAt).toBe(resolvedAt);
    const replay = await client.enqueue(
      {
        workflowName: 'commerce.eraseAccount',
        queueName: 'workflows',
        workflowID: commerceErasureWorkflowId(unused.accountId),
        workflowIDReusePolicy: 'return-existing',
      },
      unused.accountId,
    );
    await replay.getResult();
    expect(await commerceOutcome(unused.accountId)).toEqual({ outcome: 'none', retained: [] });
  }, 180_000);
});

describe('historical operator commerce custody', () => {
  const pool = { current: null as Awaited<ReturnType<typeof nativeFixture>>['pool'] | null };
  let auth: Awaited<ReturnType<typeof nativeFixture>>;
  let kernel: TestKernel;
  let personas: Awaited<ReturnType<typeof createPersonas>>;
  let worker: ReturnType<typeof Bun.spawn> | undefined;
  let client: Awaited<ReturnType<typeof createWorkClient>>;
  let provider: ReturnType<typeof startWorkStripe>;

  async function startCommerceWorker() {
    const env = {
      ...process.env,
      ...workerTestEnv({
        DATABASE_URL: process.env.DATABASE_URL!,
        STRIPE_SECRET_KEY: 'sk_test_erasure',
        STRIPE_MANAGED_PAYMENTS: 'false',
        STRIPE_API_HOST: `http://127.0.0.1:${provider.port}`,
        CHECKOUT_SUCCESS_URL: 'https://example.test/success',
        CHECKOUT_CANCEL_URL: 'https://example.test/cancel',
        KERNEL_WORKER_POOL_SIZE: '10',
        KERNEL_EXECUTOR_ID: `commerce-erasure-operator-${crypto.randomUUID()}`,
      }),
    };
    const running = Bun.spawn([process.execPath, `${import.meta.dir}/support/erasure-participant-runtime.ts`], {
      env,
      stdout: 'pipe',
      stderr: 'pipe',
    });
    worker = running;
    let output = '',
      errors = '';
    void (async () => {
      for await (const bytes of running.stdout as ReadableStream<Uint8Array>) output += new TextDecoder().decode(bytes);
    })();
    void (async () => {
      for await (const bytes of running.stderr as ReadableStream<Uint8Array>) errors += new TextDecoder().decode(bytes);
    })();
    await waitUntil(
      async () => {
        if (running.exitCode !== null) throw new Error(`Kernel worker ${running.pid} exited: ${errors}`);
        return output;
      },
      (value) => value.includes('Commerce erasure worker ready'),
    );
  }

  beforeAll(async () => {
    const kernelPool = createPool(process.env.DATABASE_URL!);
    pool.current = kernelPool;
    await bootstrapRelease(kernelPool, bundledRelease);
    auth = await nativeFixture(kernelPool);
    client = await createWorkClient(process.env.DATABASE_URL!);
    provider = startWorkStripe();
    const service = auth.host.service;
    kernel = testKernel({
      pool: kernelPool,
      auth: { ...service.verifier, fetch: (url, init) => service.handler(new Request(url, init)) },
      writeRate: createWriteRateLimiter({ secret: 'commerce-erasure-operator-secret-32-bytes' }),
    });
    personas = await createPersonas(kernel, { version: 1, pool: kernelPool, auth });
    await startCommerceWorker();
    await drainEffects(kernelPool, partitionOf(routeOf(personas.software.accountId)!));
    await drainEffects(kernelPool, partitionOf(routeOf(personas.operator.accountId)!));
  }, 360_000);

  afterAll(async () => {
    try {
      worker?.kill('SIGTERM');
      if (worker) await worker.exited;
    } finally {
      await client?.close();
      provider?.stop();
      await auth?.close();
      await pool.current?.end();
    }
  });

  test('historical acting-human and operator responsibilities cannot be attested as native no-data', async () => {
    const kernelPool = pool.current!;
    await deletePersona({ version: 1, pool: kernelPool, auth }, personas.software, { actingHuman: personas.operator });
    await drainEffects(kernelPool, partitionOf(routeOf(personas.software.accountId)!));
    const barrier = await deletePersona({ version: 1, pool: kernelPool, auth }, personas.operator);
    await drainEffects(kernelPool, partitionOf(routeOf(personas.operator.accountId)!));
    const id = commerceErasureWorkflowId(personas.operator.accountId);
    await waitUntil(
      () => client.getWorkflow(id),
      (row) => row !== null && row !== undefined,
    );
    await client.retrieveWorkflow(id).getResult();
    expect((await readErasureStatus(kernelPool, personas.operator.accountId))?.participants.commerce).toEqual({
      outcome: 'pending',
      retained: [],
    });
    expect(barrier.at).toBeDefined();
  });
});
