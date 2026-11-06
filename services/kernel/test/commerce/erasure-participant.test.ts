import { afterAll, beforeAll, expect, setDefaultTimeout, test } from 'bun:test';
import { RELEASE_FORMAT, type Release } from '@rezics/definitions';
import { PLATFORM_RESOURCE } from '../../src/access/bootstrap-governance.ts';
import { createWriteRateLimiter } from '../../src/access/write-rate.ts';
import { readErasureStatus } from '../../src/access/erasure.ts';
import { GrantDeniedError } from '../../src/access/grant-commands.ts';
import { createCommerceCommands } from '../../src/commerce/commands.ts';
import {
  advanceCommerceErasure,
  commerceErasureWorkflowId,
  FINANCIAL_ERASURE_BLOCKER,
} from '../../src/commerce/erasure-participant.ts';
import { createCommerceWork } from '../../src/commerce/enqueue.ts';
import { createStripePort } from '../../src/commerce/stripe.ts';
import { createPool } from '../../src/database/pool.ts';
import { partitionOf, routeOf } from '../../src/route/route.ts';
import { bootstrapRelease, GLOBAL_CONTEXT } from '../../src/semantic/definitions.ts';
import { createWorkClient } from '../../src/work/client.ts';
import { nativeFixture } from '../access/native-account-bindings-fixture.ts';
import { deletePersona, drainEffects } from '../support/account-deletion.ts';
import { createPersonas, type Persona } from '../support/personas.ts';
import { testKernel, type TestKernel } from '../support/test-kernel.ts';
import { workerTestEnv } from '../support/worker-env.ts';
import { until } from './support/work-fixture.ts';
import { startWorkStripe } from './support/work-stripe.ts';

setDefaultTimeout(90_000);
const pool = createPool(process.env.DATABASE_URL!);
let auth: Awaited<ReturnType<typeof nativeFixture>>;
let kernel: TestKernel;
let personas: Awaited<ReturnType<typeof createPersonas>>;
let worker: ReturnType<typeof Bun.spawn> | undefined;
let targetSubjectId: string;
let client: Awaited<ReturnType<typeof createWorkClient>>;
let provider: ReturnType<typeof startWorkStripe>;
let stripe: ReturnType<typeof createStripePort>;
let commands: ReturnType<typeof createCommerceCommands>;
const urls = { successUrl: 'https://example.test/success', cancelUrl: 'https://example.test/cancel' };
// Released native metadata supplies the real subject used by both purchase cases.
const targetRelease: Release = {
  format: RELEASE_FORMAT,
  catalogue: { id: 'https://kernel.test/commerce-erasure', version: '1' },
  generator: { name: 'commerce-erasure-native-fixture', version: '1' },
  prefixes: { schema: 'http://schema.org/' },
  types: {
    'schema:Book': {
      iri: 'http://schema.org/Book',
      labels: { en: 'Book' },
      mappings: [],
      bases: [],
      properties: [],
      facets: [],
    },
  },
  properties: {},
};

async function request(persona: Persona, path: string, body?: unknown) {
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
async function accepted(persona: Persona, path: string, body: unknown) {
  const response = await request(persona, path, body);
  const value = await response.json();
  if (!response.ok) throw new Error(`${path}: ${response.status} ${JSON.stringify(value)}`);
  return value;
}
async function erase(persona: Persona) {
  const barrier = await deletePersona({ version: 1, pool, auth }, persona);
  await drainEffects(pool, partitionOf(routeOf(persona.accountId)!));
  const id = commerceErasureWorkflowId(persona.accountId);
  await until(
    () => client.getWorkflow(id),
    (row) => row !== null && row !== undefined,
  );
  await client.retrieveWorkflow(id).getResult();
  return barrier;
}
async function event(type: string, sessionId: string) {
  const signed = await provider.fake.event(type, sessionId);
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

beforeAll(async () => {
  auth = await nativeFixture(pool);
  client = await createWorkClient(process.env.DATABASE_URL!);
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
  const service = auth.host.service;
  kernel = testKernel({
    pool,
    auth: { ...service.verifier, fetch: (url, init) => service.handler(new Request(url, init)) },
    writeRate: createWriteRateLimiter({ secret: 'commerce-erasure-native-secret-32-bytes' }),
    commerce: { stripe, ...urls, webhookSecrets: [provider.fake.webhookSecret], work: createCommerceWork(client) },
  });
  personas = await createPersonas(kernel, { version: 1, pool, auth });
  for (const group of ['purchases', 'selling'])
    await accepted(personas.staff, `/v1/platform/exposure/${group}:open`, {});
  for (const [resource, actions] of [
    [PLATFORM_RESOURCE, ['offer:create']],
    [{ route: 0, id: GLOBAL_CONTEXT }, ['subject:create']],
  ] as const)
    await accepted(personas.staff, '/v1/grants', {
      resource,
      subject: { kind: 'account', id: personas.staff.accountId },
      actions,
      valid: '(,)',
    });
  await bootstrapRelease(pool, targetRelease);
  targetSubjectId = (
    await accepted(personas.staff, '/v1/subjects', { type: 'schema:Book', labels: { en: 'Commerce erasure book' } })
  ).subject.id;
  commands = createCommerceCommands({ clock: () => new Date(), pool, access: kernel.testAccess });
  const env = {
    ...process.env,
    ...workerTestEnv({
      DATABASE_URL: process.env.DATABASE_URL!,
      STRIPE_SECRET_KEY: 'sk_test_erasure',
      STRIPE_MANAGED_PAYMENTS: 'false',
      STRIPE_API_HOST: `http://127.0.0.1:${provider.port}`,
      CHECKOUT_SUCCESS_URL: urls.successUrl,
      CHECKOUT_CANCEL_URL: urls.cancelUrl,
    }),
  };
  // Auth owns the parent's DBOS singleton. The kernel's default executor runs in
  // its own process against this same database and the parent's loopback provider.
  worker = Bun.spawn([process.execPath, `${import.meta.dir}/support/erasure-participant-runtime.ts`], {
    env,
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const running = worker;
  let output = '',
    errors = '';
  void (async () => {
    for await (const bytes of running.stdout as ReadableStream<Uint8Array>) output += new TextDecoder().decode(bytes);
  })();
  void (async () => {
    for await (const bytes of running.stderr as ReadableStream<Uint8Array>) errors += new TextDecoder().decode(bytes);
  })();
  await until(
    async () => {
      if (running.exitCode !== null) throw new Error(`Kernel worker ${running.pid} exited: ${errors}`);
      return output;
    },
    (value) => value.includes('Commerce erasure worker ready'),
  );
}, 360_000);

afterAll(async () => {
  try {
    worker?.kill('SIGTERM');
    await worker?.exited;
  } finally {
    await client?.close();
    provider?.stop();
    await auth?.close();
    await pool.end();
  }
});

test('the default financial commerce terminal effect acknowledges only native no-data or actual policy-complete minimization while late provider work never restores private benefits', async () => {
  // Bob has no commerce, delegation or operator history. Auth approval/execute commits T.
  const unused = personas.bob;
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
  await expect(advanceCommerceErasure(pool, personas.orgOwner.accountId)).rejects.toThrow('committed native');

  // The real seller creates a root and the buyer obtains both a paid and an unsettled order.
  const seller = personas.orgOwner;
  await accepted(personas.staff, '/v1/grants', {
    resource: PLATFORM_RESOURCE,
    subject: { kind: 'account', id: seller.accountId },
    actions: ['offer:create'],
    valid: '(,)',
  });
  const offer = (
    await accepted(seller, '/v1/offers', {
      targetSubjectId,
      title: 'Native erasure book',
      currency: 'usd',
      unitAmountMinor: 1200,
      taxCode: 'txcd_10302000',
    })
  ).offer as { id: string; revision: number };
  const buyer = personas.alice;
  const initialOffer = (
    await accepted(personas.staff, '/v1/offers', {
      targetSubjectId,
      title: 'Initial paid book',
      currency: 'usd',
      unitAmountMinor: 1200,
      taxCode: 'txcd_10302000',
    })
  ).offer as { id: string; revision: number };
  await accepted(personas.staff, '/v1/grants', {
    resource: { route: routeOf(initialOffer.id)!, id: initialOffer.id },
    subject: { kind: 'account', id: buyer.accountId },
    actions: ['offer:manage'],
    valid: '(,)',
  });
  const typedBuyer = await kernel.testAccess.authenticate(buyer.bearer, { pool, deadline: Date.now() + 90_000 });
  const first = (
    await accepted(buyer, '/v1/orders', { offerId: initialOffer.id, expectedOfferRevision: initialOffer.revision })
  ).order as { id: string };
  const firstNative = (await commands.readOrderForAccount(buyer.accountId, first.id))!;
  provider.fake.pay(firstNative.checkoutSessionId!);
  await finish(await event('checkout.session.completed', firstNative.checkoutSessionId!));
  await drainEffects(pool, partitionOf(routeOf(buyer.accountId)!));
  const entitlement = (await entitlementRows(buyer.accountId))[0]!.entitlement_id as string;
  const second = (await accepted(buyer, '/v1/orders', { offerId: offer.id, expectedOfferRevision: offer.revision }))
    .order as { id: string };
  const secondNative = (await commands.readOrderForAccount(buyer.accountId, second.id))!;
  provider.fake.pay(secondNative.checkoutSessionId!);
  const held = provider.delayRead();
  const latePaid = await event('checkout.session.completed', secondNative.checkoutSessionId!);
  await held.captured;
  const purgeBarrier = await pool.connect();
  try {
    await purgeBarrier.query('BEGIN');
    // A real row lock delays physical deletion, without inventing lifecycle or workflow state.
    await purgeBarrier.query(
      'SELECT entitlement_id FROM commerce.entitlement WHERE route=$1 AND account_id=$2 FOR UPDATE',
      [routeOf(buyer.accountId), buyer.accountId],
    );
    await deletePersona({ version: 1, pool, auth }, buyer);
    await drainEffects(pool, partitionOf(routeOf(buyer.accountId)!));
    expect(await entitlementRows(buyer.accountId)).toHaveLength(1);
    expect(await commerceOutcome(buyer.accountId)).toEqual({ outcome: 'pending', retained: [] });
    // Private transport and native read/list consumers obey T while the entitlement still exists.
    for (const path of [`/v1/orders/${first.id}`, `/v1/entitlements/${entitlement}`, '/v1/entitlements'])
      expect((await request(buyer, path)).status).toBe(401);
    expect(await commands.readOrderForAccount(buyer.accountId, first.id)).toBeNull();
    expect(await commands.readEntitlementForAccount(buyer.accountId, entitlement)).toBeNull();
    expect(await commands.listEntitlementsForAccount(buyer.accountId, { after: null, limit: 100 })).toEqual([]);
    expect((await request(buyer, '/v1/orders', { offerId: offer.id })).status).toBe(401);
    await purgeBarrier.query('ROLLBACK');
    const buyerErasureId = commerceErasureWorkflowId(buyer.accountId);
    await until(
      () => client.getWorkflow(buyerErasureId),
      (row) => row !== null && row !== undefined,
    );
    await finish(buyerErasureId);
    await expect(commands.createOrder(typedBuyer, offer.id, offer.revision, crypto.randomUUID())).rejects.toThrow(
      GrantDeniedError,
    );
    await erase(seller);
    await expect(commands.delistOffer(typedBuyer, initialOffer.id, crypto.randomUUID())).rejects.toThrow(
      GrantDeniedError,
    );
    await expect(
      commands.reviseOffer(typedBuyer, initialOffer.id, { unitAmountMinor: 1300 }, crypto.randomUUID()),
    ).rejects.toThrow(GrantDeniedError);
    expect((await request(personas.staff, '/v1/orders', { offerId: offer.id })).status).toBe(409);
    expect(await commerceOutcome(buyer.accountId)).toEqual({ outcome: 'pending', retained: [] });
    expect(await commerceOutcome(seller.accountId)).toEqual({ outcome: 'pending', retained: [] });
    expect(await entitlementRows(buyer.accountId)).toHaveLength(0);
    expect(
      (
        await pool.query('SELECT phase,blocker FROM commerce.erasure_progress WHERE route=$1 AND account_id=$2', [
          routeOf(buyer.accountId),
          buyer.accountId,
        ])
      ).rows,
    ).toEqual([{ phase: 'pending', blocker: FINANCIAL_ERASURE_BLOCKER }]);
  } finally {
    try {
      await purgeBarrier.query('ROLLBACK');
    } finally {
      purgeBarrier.release();
      held.release();
    }
  }
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
  expect(await commerceOutcome(buyer.accountId)).toEqual({ outcome: 'pending', retained: [] });
  // Replay of the exact original event identity finds the existing workflow and immutable native outcome.
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
});

test('historical acting-human and operator responsibilities cannot be attested as native no-data', async () => {
  // Native deletion retires/releases the live responsibility; the historical slot remains proof of use.
  await deletePersona({ version: 1, pool, auth }, personas.software, { actingHuman: personas.operator });
  await drainEffects(pool, partitionOf(routeOf(personas.software.accountId)!));
  await erase(personas.operator);
  expect(await commerceOutcome(personas.operator!.accountId)).toEqual({ outcome: 'pending', retained: [] });
});
