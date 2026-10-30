import { expect } from 'bun:test';
import { createKernelClient } from '@rezics/client';
import { createWriteRateLimiter } from '../../../src/access/write-rate.ts';
import { createGrantCommands } from '../../../src/access/grant-commands.ts';
import { createCommerceCommands } from '../../../src/commerce/commands.ts';
import { createCommerceWork } from '../../../src/commerce/enqueue.ts';
import { createStripePort } from '../../../src/commerce/stripe.ts';
import { newId, routeOf } from '../../../src/route/route.ts';
import { GLOBAL_CONTEXT } from '../../../src/semantic/definitions.ts';
import { createWorkClient } from '../../../src/work/client.ts';
import { cookies, password, nativeFixture } from '../../access/native-account-bindings-fixture.ts';
import { openGrowthDatabase } from '../../support/growth.ts';
import { createPersonas, type Persona } from '../../support/personas.ts';
import { registerTestClient, testKernel, testTokens } from '../../support/test-kernel.ts';
import { workerTestEnv } from '../../support/worker-env.ts';
import { startFakeStripe } from './fake-stripe.ts';
import { until } from './work-fixture.ts';

/** All identities, grants and purchases use native commands; Stripe is the official loopback adapter. */
export async function purchaseHistoryFixture() {
  const db = await openGrowthDatabase();
  db.pool.options.max = 1;
  const auth = await nativeFixture(db.pool);
  const fake = startFakeStripe();
  const stripe = createStripePort({
    apiKey: 'sk_test_history',
    managedPayments: false,
    host: '127.0.0.1',
    port: fake.port,
    protocol: 'http',
    maxNetworkRetries: 0,
    clock: () => new Date(),
  });
  const workClient = await createWorkClient(db.url);
  const service = auth.host.service;
  const app = testKernel({
    pool: db.pool,
    writeRate: createWriteRateLimiter({
      secret: 'purchase-history-native-rate-secret-32-bytes',
      overrides: JSON.stringify({ 'new-account': { write: { maximum: 100000, seconds: 86400 } } }),
    }),
    auth: { ...service.verifier, fetch: (url, init) => service.handler(new Request(url, init)) },
    commerce: {
      stripe,
      successUrl: 'https://web.test/orders/{ORDER_ID}',
      cancelUrl: 'https://web.test/orders/{ORDER_ID}',
      webhookSecrets: [fake.webhookSecret],
      work: createCommerceWork(workClient),
    },
  });
  const personas = await createPersonas(app, { version: 1, pool: db.pool, auth });
  const scopes = ['order:create', 'order:read', 'entitlement:read', 'entitlement:list', 'account:delete'];
  await registerTestClient(service, {
    clientId: 'history',
    firstParty: true,
    scopes,
  });
  async function signIn(accountId: string, consentedScopes = scopes): Promise<Persona> {
    const signedIn = await auth.request('/signin', {
      account_id: accountId,
      password,
      client_id: 'history',
      scope: consentedScopes,
    });
    expect(signedIn.status).toBe(200);
    const issued = await auth.request('/token', {}, cookies(signedIn));
    expect(issued.status).toBe(200);
    return { accountId, bearer: (await issued.json()).access_token as string };
  }
  const people = {
    ...personas,
    // Owner-self reads need no resource grant. Omit consent on the actual buyer instead
    // of granting a fictitious order permission on the shared persona's account resource.
    async unscoped(action: string) {
      if (!scopes.includes(action)) throw new Error(`Unmounted history action: ${action}`);
      return signIn(
        personas.alice.accountId,
        scopes.filter((scope) => scope !== action),
      );
    },
  };
  // Choose a registration key before registration; placement still comes from the native lifecycle.
  async function sameRoutePerson(label: string) {
    for (let n = 0; n < 2_000_000; n++) {
      const candidate = `history_${label}_${people.alice.accountId.replaceAll('-', '')}_${n}`;
      if (routeOf(auth.COMMANDS.internalLifecycle.registrationTarget(candidate)) === routeOf(people.alice.accountId)) {
        const registered = await auth.person(candidate);
        return signIn(registered.accountId);
      }
    }
    throw new Error('No same-route registration key found');
  }
  const peer = await sameRoutePerson('peer');
  expect(routeOf(peer.accountId)).toBe(routeOf(people.alice.accountId));
  async function request(
    path: string,
    as: { bearer: string | null } = people.alice,
    body?: unknown,
    key = Bun.randomUUIDv7(),
  ) {
    return app.handle(
      new Request(`http://kernel.test${path}`, {
        method: body === undefined ? 'GET' : 'POST',
        headers: {
          ...(as.bearer === null ? {} : { authorization: `Bearer ${as.bearer}` }),
          ...(body === undefined ? {} : { 'content-type': 'application/json', 'idempotency-key': JSON.stringify(key) }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
    );
  }
  for (const group of ['purchases', 'selling'])
    expect((await request(`/v1/platform/exposure/${group}:open`, people.staff, {})).status).toBe(200);
  const access = app.testAccess;
  const context = () => ({ pool: db.pool, deadline: Date.now() + 30_000 });
  const actor = (person: Persona) => access.authenticate(person.bearer, context());
  const commands = createCommerceCommands({ pool: db.pool, access });
  await createGrantCommands({ pool: db.pool, access, managementAction: 'access:grant' }).create(
    { ...context(), actor: await actor(people.staff) },
    {
      resource: { route: 0, id: GLOBAL_CONTEXT },
      subject: { kind: 'account', id: people.staff.accountId },
      actions: ['offer:create'],
      valid: '(,)',
      key: Bun.randomUUIDv7(),
    },
  );
  const offer = (
    await commands.createOffer(
      await actor(people.staff),
      {
        targetSubjectId: newId(0x5500),
        title: 'Captured purchase',
        currency: 'usd',
        unitAmountMinor: 1200,
        taxCode: 'txcd_10302000',
      },
      Bun.randomUUIDv7(),
    )
  ).value;
  // Include an older, unrelated native history in this route before measuring growing
  // buyer histories. A nearly empty partition otherwise makes a sequential scan cheaper
  // than any B-tree seek, and cannot exercise the production buyer-leading access path.
  const background = await sameRoutePerson('background');
  for (let i = 0; i < 4096; i++) await commands.createOrder(await actor(background), offer.id, Bun.randomUUIDv7());
  const worker = Bun.spawn([process.execPath, `${import.meta.dir}/purchase-history-runtime.ts`], {
    env: { ...process.env, ...workerTestEnv({ DATABASE_URL: db.url, WORK_STRIPE_PORT: String(fake.port) }) },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  let output = '',
    errors = '';
  void (async () => {
    for await (const bytes of worker.stdout as ReadableStream<Uint8Array>) output += new TextDecoder().decode(bytes);
  })();
  void (async () => {
    for await (const bytes of worker.stderr as ReadableStream<Uint8Array>) errors += new TextDecoder().decode(bytes);
  })();
  await until(
    async () => {
      if (worker.exitCode !== null) throw new Error(`History worker exited: ${errors}`);
      return output;
    },
    (value) => value.includes('ready'),
  );
  const client = (as: { bearer: string | null } = people.alice) =>
    createKernelClient('http://kernel.test', {
      headers: as.bearer === null ? {} : { authorization: `Bearer ${as.bearer}` },
      fetch: ((input, init) => app.handle(new Request(input, init))) as typeof fetch,
    });
  async function checkout(as: Persona = people.alice, key = Bun.randomUUIDv7()) {
    const response = await request('/v1/orders', as, { offerId: offer.id }, key);
    expect(response.status).toBe(201);
    const order = (await response.json()).order;
    const stored = await commands.readOrderForAccount(as.accountId, order.id);
    expect(stored?.checkoutSessionId).toBeString();
    return stored!;
  }
  async function event(type: string, objectId: string) {
    const signed = await fake.event(type, objectId);
    const response = await app.handle(
      new Request('http://kernel.test/v1/webhooks/stripe', {
        method: 'POST',
        headers: signed.headers,
        body: signed.bytes,
      }),
    );
    expect([200, 202]).toContain(response.status);
    const id = `stripe:${JSON.parse(signed.bytes).id}`;
    await until(
      () => workClient.getWorkflow(id),
      (row) => row?.status === 'SUCCESS' || row?.status === 'ERROR',
    );
    await workClient.retrieveWorkflow(id).getResult();
  }
  // Exercise entitlement point probes among unrelated real grants, rather than a
  // tiny entitlement table where repeated sequential scans can win the cost estimate.
  // Each payment still crosses the official Stripe port and signed native webhook.
  for (let offset = 0; offset < 512; offset += 8) {
    const orders = await Promise.all(Array.from({ length: 8 }, () => checkout(background)));
    for (const order of orders) fake.pay(order.checkoutSessionId!);
    await Promise.all(orders.map((order) => event('checkout.session.completed', order.checkoutSessionId!)));
  }
  return {
    db,
    auth,
    fake,
    stripe,
    app,
    people,
    peer,
    actor,
    commands,
    offer,
    request,
    client,
    checkout,
    event,
    keys: testTokens(),
    async close() {
      worker.kill('SIGKILL');
      await worker.exited;
      fake.stop();
      await workClient.close();
      await auth.close();
      await db.close();
    },
  };
}
export type HistoryFixture = Awaited<ReturnType<typeof purchaseHistoryFixture>>;
