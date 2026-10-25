import { createAuthService } from '@rezics/auth';
import { exportJWK, generateKeyPair } from 'jose';
import { Pool } from 'pg';
import type { CommerceDriver, Inspection, Persona, StripeCreate } from '../../../../../specs/commerce-driver.ts';
import { migrate as migrateAuth } from '../../../../auth/scripts/database.ts';
import { createAccess } from '../../../src/access/index.ts';
import { readAccount } from '../../../src/access/account-data.ts';
import { createCommerceCommands } from '../../../src/commerce/commands.ts';
import { createCommerceWork } from '../../../src/commerce/enqueue.ts';
import { createStripePort } from '../../../src/commerce/stripe.ts';
import * as store from '../../../src/commerce/store.ts';
import { createKernel } from '../../../src/http/kernel.ts';
import { actionCatalogue } from '../../../src/http/request.ts';
import { newId, partitionOf, routeOf } from '../../../src/route/route.ts';
import { GLOBAL_CONTEXT } from '../../../src/semantic/definitions.ts';
import { createWorkClient } from '../../../src/work/client.ts';
import { KERNEL_WORK_MODULES } from '../../../src/work/modules.ts';
import { startWorker } from '../../../src/worker.ts';
import { measure, openGrowthDatabase } from '../../support/growth.ts';
import { startFakeStripe } from './fake-stripe.ts';

// A separate process owns DBOS's process-global registrations for each isolated driver.
// Only its scheduling clock advances: command T and snapshot ordering still come from PostgreSQL.
if (import.meta.main) {
  const instant = Number(process.env.COMMERCE_OUTCOME_TIME);
  const realNow = Date.now;
  const offset = instant - realNow();
  Date.now = () => realNow() + offset;
  await startWorker(
    { databaseUrl: process.env.DATABASE_URL!, poolSize: 10, executorId: 'commerce-outcomes' },
    KERNEL_WORK_MODULES,
    process.env,
  );
  process.send?.('ready');
}

export async function createCommerceDriver(): Promise<CommerceDriver> {
  const base = process.env.DATABASE_URL;
  if (!base) throw new Error('DATABASE_URL must name the migrated test database');
  const suffix = Bun.randomUUIDv7().replaceAll('-', '');
  const kernelName = `commerce_${suffix}`;
  const authName = `commerce_auth_${suffix}`;
  const url = new URL(base);
  const template = decodeURIComponent(url.pathname.slice(1));
  url.pathname = '/postgres';
  const owner = new Pool({ connectionString: url.toString(), max: 1 });
  // Clone the check's migrated, empty database, not another driver's mutable database.
  await owner.query(`CREATE DATABASE ${kernelName} TEMPLATE "${template.replaceAll('"', '""')}"`);
  url.pathname = `/${kernelName}`;
  const databaseUrl = url.toString();
  const db = await openGrowthDatabase(databaseUrl);
  db.pool.options.max = 1;
  await owner.query(`CREATE DATABASE ${authName}`);
  url.pathname = `/${authName}`;
  migrateAuth(url.toString());
  const authPool = new Pool({ connectionString: url.toString(), max: 2 });
  const fake = startFakeStripe();
  const configuration = {
    webhookSecret: fake.webhookSecret,
    successUrl: 'https://web.example.test/checkout?session={CHECKOUT_SESSION_ID}',
    cancelUrl: 'https://web.example.test/checkout/cancel',
  };
  let instant = new Date().toISOString();
  let managedPayments = false;
  const workPool = db.openPool({ max: 2 });
  const client = await createWorkClient(databaseUrl, workPool);
  const work = createCommerceWork(client);
  const account = (route: number) => ({ id: newId(route), route, partition: partitionOf(route) });
  const accounts = {
    buyer: account(0x3300),
    other: account(0x3300),
    refunded: account(0x4410),
    suspended: account(0x5520),
  };
  const seller = account(0x2200);
  const seedAccounts = [account(0x3300), account(0x6610)];
  const people = [...Object.values(accounts), seller, ...seedAccounts];
  const approvals = new Set(people.map(({ id }) => id));
  const issuer = 'https://auth.example.test';
  const audience = 'https://api.rezics.test';
  const password = 'commerce fixture password with enough entropy';
  const signingKey = {
    ...(await exportJWK((await generateKeyPair('ES256', { extractable: true })).privateKey)),
    kid: 'commerce-outcomes',
    alg: 'ES256',
  };
  const auth = await createAuthService({
    database: authPool,
    issuer,
    audience,
    secret: 'commerce-fixture-secret-with-at-least-32-bytes',
    signing: { activeKid: signingKey.kid, privateKeys: [signingKey] },
    trustedAccess: {
      async readAccount(id) {
        const row = await readAccount(db.admin, routeOf(id)!, id);
        return (
          row && {
            accountId: row.accountId,
            kind: row.kind,
            state: row.state,
            authnEpoch: Number(row.minimumAuthnEpoch),
            automated: row.operatorAccountId !== null,
          }
        );
      },
      async authorizeProvisioning(reference) {
        if (!approvals.delete(reference)) throw new Error('No fixture provisioning approval');
        return { accountId: reference };
      },
    },
  });
  let access: ReturnType<typeof createAccess>;
  function kernel() {
    // The webhook composition captures Date.now as its trusted clock. Install that
    // clock only during composition, leaving Auth, deadlines and all other code alone.
    const realNow = Date.now;
    Date.now = () => Date.parse(instant);
    try {
      return createKernel({
        pool: db.pool,
        routeKey: new Uint8Array(32).fill(7),
        tokens: { current: 1, keys: new Map([[1, new Uint8Array(32).fill(8)]]) },
        access: (config) =>
          (access = createAccess({
            ...config,
            auth: {
              issuer,
              audience,
              jwksUrl: `${issuer}/.well-known/jwks.json`,
              fetch: async (location, init) => auth.handler(new Request(location, init)),
            },
          })),
        commerce: {
          ...configuration,
          webhookSecrets: [configuration.webhookSecret],
          stripe: createStripePort({
            apiKey: 'sk_test_commerce',
            managedPayments,
            host: '127.0.0.1',
            port: fake.port,
            protocol: 'http',
            maxNetworkRetries: 0,
            clock: () => new Date(instant),
          }),
          work,
        },
      });
    } finally {
      Date.now = realNow;
    }
  }
  let app = kernel();
  const scopes = [...actionCatalogue(app).keys()];
  await auth.internal.registerClient({ clientId: 'web', firstParty: true, scopes });
  const tokens = new Map<string, string>();
  for (const person of people) {
    await db.admin.query(
      "INSERT INTO access.account(route,account_id,kind,state,transaction_id) VALUES ($1,$2,'actor','pending',$2)",
      [person.route, person.id],
    );
    await auth.internal.provisionPassword({ authorization: person.id, email: `${person.id}@example.test`, password });
    await db.admin.query("UPDATE access.account SET state='active' WHERE route=$1 AND account_id=$2", [
      person.route,
      person.id,
    ]);
    const signedIn = await auth.handler(
      new Request(`${issuer}/signin`, {
        method: 'POST',
        headers: { origin: issuer, 'content-type': 'application/json' },
        body: JSON.stringify({ email: `${person.id}@example.test`, password, client_id: 'web', scope: scopes }),
      }),
    );
    if (signedIn.status !== 200) throw new Error(`Fixture sign-in failed: ${signedIn.status}`);
    const cookie = signedIn.headers
      .getSetCookie()
      .map((value) => value.split(';')[0])
      .join('; ');
    const issued = await auth.handler(
      new Request(`${issuer}/token`, {
        method: 'POST',
        headers: { origin: issuer, 'content-type': 'application/json', cookie },
        body: '{}',
      }),
    );
    if (issued.status !== 200) throw new Error(`Fixture token issuance failed: ${issued.status}`);
    tokens.set(person.id, ((await issued.json()) as { access_token: string }).access_token);
  }
  await db.admin.query("UPDATE access.account SET state='suspended' WHERE route=$1 AND account_id=$2", [
    accounts.suspended.route,
    accounts.suspended.id,
  ]);
  await db.admin.query(
    "INSERT INTO access.resource_grant(route,resource_id,subject_id,action,valid,transaction_id) VALUES (0,$1,$2,'offer:create','(,)',$2)",
    [GLOBAL_CONTEXT, seller.id],
  );
  // Resolve the same mounted Access catalogue used by the HTTP boundary for trusted commands.
  await app.handle(
    new Request('http://kernel.test/v1/entitlements', {
      headers: { authorization: `Bearer ${tokens.get(accounts.buyer.id)!}` },
    }),
  );
  const actor = (id: string) => access.authenticate(tokens.get(id)!, { pool: db.pool, deadline: Date.now() + 5000 });
  const commands = () => createCommerceCommands({ pool: db.pool, access });
  let child: ReturnType<typeof Bun.spawn> | undefined;
  let held = true;
  const disputes = new Map<string, string>();
  let seeded = 0;
  let seedOffer: string | undefined;
  async function stopWorker() {
    if (!child) return;
    child.kill('SIGKILL');
    await child.exited;
    child = undefined;
    held = true;
  }
  async function startExecutor() {
    if (child) {
      if (held) child.kill('SIGCONT');
      held = false;
      return;
    }
    let ready!: () => void;
    const readiness = new Promise<void>((resolve) => {
      ready = resolve;
    });
    child = Bun.spawn([process.execPath, import.meta.filename], {
      env: {
        ...process.env,
        DATABASE_URL: databaseUrl,
        STRIPE_SECRET_KEY: 'sk_test_commerce',
        STRIPE_MANAGED_PAYMENTS: String(managedPayments),
        STRIPE_API_HOST: `http://127.0.0.1:${fake.port}`,
        CHECKOUT_SUCCESS_URL: configuration.successUrl,
        CHECKOUT_CANCEL_URL: configuration.cancelUrl,
        COMMERCE_OUTCOME_TIME: String(Date.parse(instant)),
      },
      stdout: 'ignore',
      stderr: 'pipe',
      ipc(message) {
        if (message === 'ready') ready();
      },
    });
    const running = child;
    await Promise.race([
      readiness,
      running.exited.then(async (code) => {
        throw new Error(
          `Commerce executor exited ${code}: ${await new Response(running.stderr as ReadableStream<Uint8Array>).text()}`,
        );
      }),
    ]);
    held = false;
  }
  const driver: CommerceDriver = {
    accounts,
    unknown: {
      offerId: newId(seller.route),
      orderId: newId(accounts.buyer.route),
      entitlementId: newId(accounts.buyer.route),
    },
    configuration,
    async setTime(value) {
      instant = new Date(value).toISOString();
    },
    now: () => instant,
    async configureCheckout(input) {
      managedPayments = input.managedPayments;
      app = kernel();
    },
    async provisionOffer(input = {}) {
      return (
        await commands().createOffer(
          await actor(seller.id),
          {
            targetSubjectId: newId(0x7700),
            title: 'Commerce outcome book',
            currency: 'usd',
            unitAmountMinor: input.unitAmountMinor ?? 1200,
            taxCode: 'txcd_10302000',
          },
          Bun.randomUUIDv7(),
        )
      ).value;
    },
    async reviseOffer(id, input) {
      let offer = await store.readOffer(db.pool, routeOf(id)!, id);
      if (!offer) throw new Error('Unknown fixture offer');
      const sellerActor = await actor(offer.creatorAccountId);
      if (input.unitAmountMinor !== undefined)
        offer = (
          await commands().reviseOffer(sellerActor, id, { unitAmountMinor: input.unitAmountMinor }, Bun.randomUUIDv7())
        ).value;
      if (input.state === 'delisted') offer = (await commands().delistOffer(sellerActor, id, Bun.randomUUIDv7())).value;
      return offer;
    },
    async request(as: Persona, input) {
      const headers = new Headers(input.headers);
      if (as !== 'anonymous') headers.set('authorization', `Bearer ${tokens.get(accounts[as].id)!}`);
      if (input.body !== undefined && !headers.has('content-type')) headers.set('content-type', 'application/json');
      return app.handle(
        new Request(`http://kernel.test${input.path}`, {
          method: input.method,
          headers,
          ...(input.rawBody === undefined
            ? input.body === undefined
              ? {}
              : { body: JSON.stringify(input.body) }
            : { body: Uint8Array.from(input.rawBody) }),
        }),
      );
    },
    async inspect(): Promise<Inspection> {
      const orders = (
        await db.admin.query(`SELECT order_id AS id, buyer_account_id AS "buyerAccountId", route,
        (route >> 4) AS partition, offer_id AS "offerId", offer_revision AS "offerRevision",
        creator_account_id AS "creatorAccountId", title, currency, unit_amount_minor::integer AS "unitAmountMinor",
        tax_code AS "taxCode", royalty_basis_points AS "royaltyBasisPoints", settlement,
        checkout_session_id AS "checkoutSessionId", checkout_url AS "checkoutUrl"
        FROM commerce.purchase_order ORDER BY order_id`)
      ).rows;
      const entitlements = (
        await db.admin.query(`SELECT entitlement_id AS id, account_id AS "accountId", route,
        (route >> 4) AS partition, offer_id AS "offerId", order_id AS "orderId", target_subject_id AS "targetSubjectId",
        granted_at AS "grantedAt", revoked_at AS "revokedAt", revoke_reason AS "revokeReason", revoked_at IS NULL AS active
        FROM commerce.entitlement ORDER BY entitlement_id`)
      ).rows.map((row) => ({
        ...row,
        grantedAt: row.grantedAt.toISOString(),
        revokedAt: row.revokedAt?.toISOString() ?? null,
      }));
      const events = (
        await db.admin.query('SELECT id,type,data FROM core.outbox ORDER BY partition_no,position,event_seq')
      ).rows;
      const transactions = (
        await db.admin.query(`SELECT balance_transaction_id AS id,order_id AS "orderId",kind,
        amount_minor::integer AS "amountMinor" FROM commerce.order_transaction ORDER BY balance_transaction_id`)
      ).rows;
      const workflows = (await client.listWorkflows({ limit: 10000 }))
        .map((row) => ({ id: row.workflowID, name: row.workflowName, status: row.status }))
        .sort((a, b) => a.id.localeCompare(b.id));
      return { orders, entitlements, events, transactions, workflows };
    },
    async holdWork() {
      if (child && !held) {
        child.kill('SIGSTOP');
        held = true;
      }
    },
    async settle() {
      await startExecutor();
      for (;;) {
        const pending = (await client.listWorkflows({ limit: 10000 })).filter((row) => row.status !== 'SUCCESS');
        if (!pending.length) break;
        for (const row of pending) await client.retrieveWorkflow(row.workflowID).getResult();
      }
    },
    stripe: {
      async creates() {
        return fake.requests
          .filter((r) => r.method === 'POST' && r.path === '/v1/checkout/sessions')
          .map((r): StripeCreate => {
            const p = r.params;
            const session = [...fake.sessions.values()].find(
              (s) => s.client_reference_id === p.get('client_reference_id'),
            );
            if (!session) throw new Error('Captured create has no Stripe session');
            return {
              sessionId: session.id,
              idempotencyKey: r.headers.get('idempotency-key')!,
              parameters: {
                mode: p.get('mode')!,
                client_reference_id: p.get('client_reference_id')!,
                metadata: { order_id: p.get('metadata[order_id]')!, account_id: p.get('metadata[account_id]')! },
                payment_intent_data: { metadata: { order_id: p.get('payment_intent_data[metadata][order_id]')! } },
                line_items: [
                  {
                    quantity: Number(p.get('line_items[0][quantity]')),
                    price_data: {
                      currency: p.get('line_items[0][price_data][currency]')!,
                      unit_amount: Number(p.get('line_items[0][price_data][unit_amount]')),
                      product_data: {
                        name: p.get('line_items[0][price_data][product_data][name]')!,
                        tax_code: p.get('line_items[0][price_data][product_data][tax_code]')!,
                      },
                    },
                  },
                ],
                expires_at: Number(p.get('expires_at')),
                success_url: p.get('success_url')!,
                cancel_url: p.get('cancel_url')!,
                ...(p.has('managed_payments[enabled]')
                  ? { managed_payments: { enabled: p.get('managed_payments[enabled]') === 'true' } }
                  : {}),
                ...(p.has('automatic_tax[enabled]')
                  ? { automatic_tax: { enabled: p.get('automatic_tax[enabled]') === 'true' } }
                  : {}),
              },
            };
          });
      },
      async sessions() {
        return [...fake.sessions.keys()].map((id) => ({ id }));
      },
      async failNextCreate(mode) {
        fake.nextCreateFault = mode === 'reject' ? 'rejected' : 'lost';
      },
      async pay(id) {
        fake.pay(id);
      },
      async completeUnpaid(id) {
        fake.pay(id, 'async');
      },
      async asyncPay(id) {
        fake.succeedPayment(id);
      },
      async failPayment(id) {
        fake.failPayment(id);
      },
      async expire(id) {
        fake.expire(id);
      },
      async refund(id, amount) {
        fake.refundRemaining(id, amount);
      },
      async dispute(id, status) {
        const current = disputes.get(id);
        if (current) fake.updateDispute(current, status);
        else disputes.set(id, fake.dispute(id, { status, withdraw: status !== 'warning_needs_response' }));
      },
      async event(input) {
        const objectId = input.type.startsWith('checkout.session.')
          ? input.sessionId
          : input.type.startsWith('charge.dispute.')
            ? disputes.get(input.sessionId)!
            : fake.chargeId(input.sessionId);
        const event = JSON.parse((await fake.event(input.type, objectId)).bytes);
        event.id = input.id;
        event.created = Math.floor(Date.parse(instant) / 1000);
        if (input.payloadPaymentStatus !== undefined) event.data.object.payment_status = input.payloadPaymentStatus;
        return new TextEncoder().encode(JSON.stringify(event));
      },
    },
    async seedUnrelatedOrders(total) {
      if (!seedOffer && total > 0) seedOffer = (await driver.provisionOffer()).id;
      // Use the same createOrder command (including its snapshot, grants, receipt and events)
      // as HTTP checkout. Seeding creates no provider sessions and does not settle anything.
      while (seeded < total) {
        const person = seedAccounts[seeded % seedAccounts.length]!;
        await commands().createOrder(await actor(person.id), seedOffer!, Bun.randomUUIDv7());
        seeded++;
      }
    },
    async measure(operation) {
      await driver.holdWork();
      const result = await measure(db, operation);
      return {
        value: result.value,
        statements: result.cost.statements + result.cost.controlStatements,
        buffers: result.cost.blocks,
      };
    },
    async close() {
      await stopWorker();
      fake.stop();
      tokens.clear();
      approvals.clear();
      await client.close();
      await authPool.end();
      await db.close();
      try {
        await owner.query(`DROP DATABASE ${authName} WITH (FORCE)`);
        await owner.query(`DROP DATABASE ${kernelName} WITH (FORCE)`);
      } finally {
        await owner.end();
      }
    },
  };
  return driver;
}
