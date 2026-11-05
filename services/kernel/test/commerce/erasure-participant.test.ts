import { afterAll, beforeAll, expect, setDefaultTimeout, test } from 'bun:test';
import { bundledRelease } from '@rezics/definitions/bundled';
import { PLATFORM_RESOURCE } from '../../src/access/bootstrap-governance.ts';
import { createGrantCommands, GrantDeniedError } from '../../src/access/grant-commands.ts';
import { createWriteRateLimiter } from '../../src/access/write-rate.ts';
import { readErasureStatus, resolveRetention } from '../../src/access/erasure.ts';
import { resourceRoleCatalogue } from '../../src/access/resource-roles.ts';
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
import { readResource } from '../../src/content/reads.ts';
import { createPool } from '../../src/database/pool.ts';
import { accessCheck } from '../../src/request/access.ts';
import { partitionOf, routeOf } from '../../src/route/route.ts';
import { bootstrapRelease } from '../../src/semantic/definitions.ts';
import { createWorkClient } from '../../src/work/client.ts';
import { nativeFixture } from '../access/native-account-bindings-fixture.ts';
import { deletePersona, drainEffects } from '../support/account-deletion.ts';
import { createPersonas, type Persona } from '../support/personas.ts';
import { testKernel, type TestKernel } from '../support/test-kernel.ts';
import { workerTestEnv } from '../support/worker-env.ts';
import { createNativeEditionFixture, type NativeContentEdition } from './support/native-edition-fixture.ts';
import { inspectNativeRetainedOrder, prepareNativeRetainedOrder } from './support/order-retention-fixture.ts';
import { until } from './support/work-fixture.ts';
import { startWorkStripe } from './support/work-stripe.ts';
import { seedGovernanceAuthority } from '../content/support/disclosure-fixtures.ts';

setDefaultTimeout(120_000);
const pool = createPool(process.env.DATABASE_URL!);
let auth: Awaited<ReturnType<typeof nativeFixture>>;
let kernel: TestKernel;
let personas: Awaited<ReturnType<typeof createPersonas>>;
let worker: ReturnType<typeof Bun.spawn> | undefined;
let client: Awaited<ReturnType<typeof createWorkClient>>;
let provider: ReturnType<typeof startWorkStripe>;
let stripe: ReturnType<typeof createStripePort>;
let commands: ReturnType<typeof createCommerceCommands>;
let grants: ReturnType<typeof createGrantCommands>;
let contentEdition: NativeContentEdition;
const urls = { successUrl: 'https://example.test/success', cancelUrl: 'https://example.test/cancel' };

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
async function grant(subject: Persona, resource: { route: number; id: string }, actions: string[]) {
  for (const action of actions) {
    const deadline = Date.now() + 30_000;
    const actor = await kernel.testAccess.authenticate(personas.staff.bearer, { pool, deadline });
    try {
      await grants.create(
        { pool, actor, deadline },
        {
          resource,
          subject: { kind: 'account', id: subject.accountId },
          actions: [action],
          valid: '(,)',
          key: Bun.randomUUIDv7(),
        },
      );
    } catch (error) {
      throw new Error(`Native fixture grant denied for ${action}`, { cause: error });
    }
  }
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
      DATABASE_URL: process.env.DATABASE_URL!,
      STRIPE_SECRET_KEY: 'sk_test_erasure',
      STRIPE_MANAGED_PAYMENTS: 'false',
      STRIPE_API_HOST: `http://127.0.0.1:${provider.port}`,
      CHECKOUT_SUCCESS_URL: urls.successUrl,
      CHECKOUT_CANCEL_URL: urls.cancelUrl,
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
  await until(
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
  await bootstrapRelease(pool, bundledRelease);
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
    content: { cursorNow: () => Date.now() },
    commerce: { stripe, ...urls, webhookSecrets: [provider.fake.webhookSecret], work: createCommerceWork(client) },
  });
  personas = await createPersonas(kernel, { version: 1, pool, auth });
  grants = createGrantCommands({ pool, access: kernel.testAccess, managementAction: 'access:grant' });
  const seller = personas.orgOwner;
  // The existing paid Commerce journey creates native editions with a seller that
  // holds subject, board and offer creation on Global.
  await seedGovernanceAuthority(pool, PLATFORM_RESOURCE.route, PLATFORM_RESOURCE.id, seller.accountId, [
    'subject:create',
    'board:create',
    'offer:create',
  ]);
  for (const group of ['personal_library', 'purchases', 'selling'])
    await accepted(personas.staff, `/v1/platform/exposure/${group}:open`, {});
  const editionPublisher = await createNativeEditionFixture(async (method, path, body, headers = {}) => {
    const response = await kernel.handle(
      new Request(`http://kernel.test${path}`, {
        method,
        headers: { authorization: `Bearer ${seller.bearer}`, ...headers },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
    );
    if (method === 'POST' && path === '/v1/boards' && response.status !== 201) {
      const title = (body as { title: string }).title;
      const diagnostic = await pool.query(
        `SELECT b.route,b.board_id,b.subject_id,b.realm_id,b.visibility,b.title,
          b.security_revision::text,b.purpose,b.created_at,
          (SELECT json_agg(json_build_object('role',grant_role,'valid',valid::text,'current',valid @> clock_timestamp()))
           FROM access.resource_role_grant r
           WHERE r.route=b.route AND r.resource_id=b.board_id AND r.subject_id=$2) AS roles,
          (SELECT array_agg(action) FROM access.resource_grant g
           WHERE g.route=b.route AND g.resource_id=b.board_id AND g.subject_id=$2) AS actions,
          (SELECT state FROM access.account a WHERE a.route=$3 AND a.account_id=$2) AS account_state
         FROM content.board b WHERE b.title=$1 ORDER BY b.created_at DESC LIMIT 1`,
        [title, seller.accountId, routeOf(seller.accountId)],
      );
      const row = diagnostic.rows[0];
      const actor = await kernel.testAccess.authenticate(seller.bearer, { pool, deadline: Date.now() + 30_000 });
      const boardAllowed = await (
        await accessCheck(
          kernel.testAccess,
          actor,
          'board:read',
          { route: row.route, id: row.board_id },
          { pool, deadline: Date.now() + 30_000 },
        )
      )(pool);
      const subjectAllowed = await (
        await accessCheck(
          kernel.testAccess,
          actor,
          'subject:read',
          { route: routeOf(row.subject_id)!, id: row.subject_id },
          { pool, deadline: Date.now() + 30_000 },
        )
      )(pool);
      const boardResource = readResource(
        {
          kind: 'board',
          id: row.board_id,
          thread_id: null,
          board_id: null,
          parent_id: null,
          author_id: null,
          head_id: null,
          first_post_id: null,
          thread_kind: null,
          board_purpose: row.purpose,
          vote_citation: null,
          title: row.title,
          visibility: row.visibility,
          security_revision: row.security_revision,
          availability: 'available',
          created_at: row.created_at,
          licence: null,
          subject_ids: null,
          media_ids: null,
          body: null,
          sha256: null,
          revised_at: null,
          realm_id: row.realm_id,
          deleted_at: null,
          restorable: false,
          decision_id: null,
        } as Parameters<typeof readResource>[0],
        {},
      );
      const disclosedBoardAllowed = await (
        await accessCheck(kernel.testAccess, actor, 'board:read', boardResource, {
          pool,
          deadline: Date.now() + 30_000,
        })
      )(pool);
      console.error(
        'Native board visibility diagnostic',
        JSON.stringify({
          row,
          actor: actor.kind === 'account' ? actor.accountId : actor.kind,
          boardScope: actor.kind === 'account' && actor.scopes.includes('board:read'),
          ownerRoleActions: resourceRoleCatalogue(kernel.testAccess)?.roles.get('content.board.owner'),
          boardAllowed,
          disclosedBoardAllowed,
          subjectAllowed,
        }),
      );
    }
    return response;
  });
  contentEdition = await editionPublisher.publish({
    title: 'Native erasure book',
    subjectTitle: 'Native erasure source',
    body: 'Exact native content edition bytes',
  });
  commands = createCommerceCommands({ pool, access: kernel.testAccess });
  // Auth owns the parent's DBOS singleton. The kernel's default executor runs in
  // its own process against this same database and the parent's loopback provider.
  await startCommerceWorker();
}, 360_000);

afterAll(async () => {
  try {
    await stopCommerceWorker();
  } finally {
    await client?.close();
    provider?.stop();
    await auth?.close();
    await pool.end();
  }
});

test('the native financial participant minimizes an explicitly retained real order, expires it durably, and preserves late financial truth without restoring private benefits', async () => {
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
  const buyer = personas.alice;
  await grant(buyer, { route: routeOf(offer.id)!, id: offer.id }, ['order:create']);
  const typedBuyer = await kernel.testAccess.authenticate(buyer.bearer, { pool, deadline: Date.now() + 90_000 });
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
  const expiresAt = new Date(Date.now() + 60_000);
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
    await until(
      () => client.getWorkflow(buyerErasureId),
      (row) => row !== null && row !== undefined,
    );
    await until(
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
      expect(Date.parse(order.checkout_minimized_at)).toBe(Date.parse(barrier.at));
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
    expect((await request(personas.staff, '/v1/orders', { offerId: offer.id })).status).toBe(409);
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
}, 120_000);

test('historical acting-human and operator responsibilities cannot be attested as native no-data', async () => {
  // Native deletion retires/releases the live responsibility; the historical slot remains proof of use.
  await deletePersona({ version: 1, pool, auth }, personas.software, { actingHuman: personas.operator });
  await drainEffects(pool, partitionOf(routeOf(personas.software.accountId)!));
  await erase(personas.operator);
  expect(await commerceOutcome(personas.operator!.accountId)).toEqual({ outcome: 'pending', retained: [] });
});
