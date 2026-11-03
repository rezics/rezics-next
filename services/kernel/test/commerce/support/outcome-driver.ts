import { suspendAccount } from '../../support/native-suspension-driver.ts';
import { DBOS } from '@dbos-inc/dbos-sdk';
import { createAuthService } from '@rezics/auth';
import { bundledRelease } from '@rezics/definitions/bundled';
import { exportJWK, generateKeyPair } from 'jose';
import { Pool } from 'pg';
import type { CommerceDriver, Inspection, Persona, StripeCreate } from '../../../../../specs/commerce-driver.ts';
import { createAccess } from '../../../src/access/index.ts';
import { readAccount } from '../../../src/access/account-data.ts';
import { bootstrapGovernance, PLATFORM_RESOURCE } from '../../../src/access/bootstrap-governance.ts';
import { readExposure } from '../../../src/access/gates/catalogue.ts';
import { createGrantCommands } from '../../../src/access/grant-commands.ts';
import { createWriteRateLimiter } from '../../../src/access/write-rate.ts';
import { createCommerceCommands } from '../../../src/commerce/commands.ts';
import { createCommerceWork } from '../../../src/commerce/enqueue.ts';
import { createStripePort } from '../../../src/commerce/stripe.ts';
import * as store from '../../../src/commerce/store.ts';
import { createKernel } from '../../../src/http/kernel.ts';
import { actionCatalogue } from '../../../src/http/request.ts';
import { bootstrapRelease, GLOBAL_CONTEXT } from '../../../src/semantic/definitions.ts';
import { derivedId, newId, partitionOf, routeOf } from '../../../src/route/route.ts';
import { createWorkClient } from '../../../src/work/client.ts';
import { KERNEL_WORK_MODULES } from '../../../src/work/modules.ts';
import { readWorkerConfig, startWorker } from '../../../src/worker.ts';
import { createAuthDatabase } from '../../support/auth-database.ts';
import { dropTestDatabase } from '../../support/drop-test-database.ts';
import { capture, costOf, openGrowthDatabase, withoutCatalogStatements } from '../../support/growth.ts';
import { workerTestEnv } from '../../support/worker-env.ts';
import { startFakeStripe } from './fake-stripe.ts';
import { createNativeEditionFixture, type NativeEditionFixture } from './native-edition-fixture.ts';
import { trustedAccessPorts } from '../../support/trusted-access.ts';
import { seedUnrelatedOrders as seedOrderFixtures } from './seed-unrelated-orders.ts';

// A separate process owns DBOS's process-global registrations for each isolated driver.
// Only its scheduling clock advances: command T and snapshot ordering still come from PostgreSQL.
if (import.meta.main) {
  const instant = Number(process.env.COMMERCE_OUTCOME_TIME);
  const realNow = Date.now;
  const RealDate = Date;
  let offset = instant - realNow();
  const shiftedNow = () => realNow() + offset;
  // DBOS schedules its crons from `new Date()` and decides they are due with `Date.now()`.
  // Moving only `Date.now` to the fixture instant makes every cron from real time until that
  // instant look already due, and each content collection then walks every partition.
  class ShiftedDate extends RealDate {
    constructor(...args: (string | number | Date)[]) {
      if (args.length === 0) super(shiftedNow());
      else super(args[0] as string | number);
    }
  }
  ShiftedDate.now = shiftedNow;
  globalThis.Date = ShiftedDate as unknown as DateConstructor;
  process.on('message', (message: unknown) => {
    if (
      typeof message === 'object' &&
      message !== null &&
      'advanceTo' in message &&
      typeof message.advanceTo === 'number' &&
      Number.isFinite(message.advanceTo)
    )
      offset = Math.max(offset, message.advanceTo - realNow());
  });
  const workerEnv = workerTestEnv(process.env);
  const worker = await startWorker(readWorkerConfig(workerEnv), KERNEL_WORK_MODULES, workerEnv);
  // This executor only drains commerce. A deadline jump must not run the host's content crons.
  for (const schedule of await DBOS.listSchedules()) await DBOS.deleteSchedule(schedule.scheduleName);
  // Shorten scheduling latency while preserving the production queues' concurrency policies.
  for (const queue of await DBOS.listQueues()) await queue.setMinPollingIntervalMs(5);
  process.on('message', (message) => {
    if (message === 'stop')
      void worker.stop().then(
        () => process.exit(0),
        (error) => {
          console.error(error);
          process.exit(1);
        },
      );
  });
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
  await bootstrapRelease(db.admin, bundledRelease);
  const authPool = new Pool({ connectionString: await createAuthDatabase(base, authName), max: 2 });
  authPool.on('error', () => {});
  authPool.on('connect', (client) => client.on('error', () => {}));
  const fake = startFakeStripe();
  const configuration = {
    webhookSecret: fake.webhookSecret,
    successUrl: 'https://web.example.test/checkout?session={CHECKOUT_SESSION_ID}',
    cancelUrl: 'https://web.example.test/checkout/cancel',
  };
  let instant = new Date().toISOString();
  let managedPayments = false;
  const workPool = db.openPool({ max: 2 });
  // Seeding is outside statement capture. Its own pool keeps the measured pool at one connection.
  const seedPool = new Pool({ connectionString: databaseUrl, max: 8, connectionTimeoutMillis: 10_000 });
  seedPool.on('error', () => {});
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
  const governor = account(0x1100);
  const seedAccounts = [accounts.buyer.route, 0x1010, 0x6610].map((route) => ({
    id: derivedId('00000000-0000-8000-8000-000000000001', `commerce-outcome-account:${route}`, route),
    route,
    partition: partitionOf(route),
  }));
  const people = [...Object.values(accounts), seller, governor, ...seedAccounts];
  const approvals = new Set(people.map(({ id }) => id));
  // All registered work modules share the real fixture issuer, including the
  // executor process, which cannot use the HTTP process's in-process transport.
  const authServer = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: (request) => auth.handler(request) });
  const issuer = `http://127.0.0.1:${authServer.port}`;
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
    trustedAccess: trustedAccessPorts({
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
    }),
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
        requestDeadlineMs: 30_000,
        writeRate: createWriteRateLimiter({ secret: 'commerce-fixture-write-rate-secret-with-at-least-32-bytes' }),
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
  const scopes = [...actionCatalogue(app).keys(), 'access:grant'].filter((scope) => scope !== 'media:complete');
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
  await suspendAccount(db.admin, accounts.suspended.id);
  // Resolve the same mounted Access catalogue used by the HTTP boundary for trusted commands.
  await app.handle(
    new Request('http://kernel.test/v1/entitlements', {
      headers: { authorization: `Bearer ${tokens.get(accounts.buyer.id)!}` },
    }),
  );
  // The measured pool stays out of fixture setup; admin is outside statement capture.
  await bootstrapGovernance(db.admin, governor.id);
  for (const group of ['purchases', 'selling']) {
    const opened = await app.handle(
      new Request(`http://kernel.test/v1/platform/exposure/${group}:open`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${tokens.get(governor.id)!}`,
          'idempotency-key': JSON.stringify(Bun.randomUUIDv7()),
        },
      }),
    );
    if (opened.status !== 200) throw new Error(`Opening ${group} failed: ${opened.status} ${await opened.text()}`);
  }
  const actor = (id: string) => access.authenticate(tokens.get(id)!, { pool: db.pool, deadline: Date.now() + 30_000 });
  const commands = () => createCommerceCommands({ pool: db.pool, access });
  // Grant administration is an internal command, with its management action
  // declared by this trusted composition just as in Access's governance tests.
  const grantAccess = createAccess({
    actions: new Map([...actionCatalogue(app), ['access:grant', { anonymous: false }]]),
    auth: {
      issuer,
      audience,
      jwksUrl: `${issuer}/.well-known/jwks.json`,
      fetch: async (location, init) => auth.handler(new Request(location, init)),
    },
  });
  let sellerAuthority: Promise<void> | undefined;
  let editionFixture: Promise<NativeEditionFixture> | undefined;
  async function contentRequest(
    method: 'DELETE' | 'GET' | 'POST' | 'PUT',
    path: string,
    body?: unknown,
    headers: Readonly<Record<string, string>> = {},
  ) {
    const requestHeaders = new Headers(headers);
    requestHeaders.set('authorization', `Bearer ${tokens.get(seller.id)!}`);
    if (body !== undefined && !requestHeaders.has('content-type')) requestHeaders.set('content-type', 'application/json');
    if (!requestHeaders.has('idempotency-key')) requestHeaders.set('idempotency-key', JSON.stringify(Bun.randomUUIDv7()));
    return app.handle(
      new Request(`http://kernel.test${path}`, {
        method,
        headers: requestHeaders,
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
    );
  }
  async function authorizeSeller() {
    const context = { pool: db.pool, deadline: Date.now() + 30_000 };
    const actor = await grantAccess.authenticate(tokens.get(governor.id)!, context);
    const grants = createGrantCommands({ pool: db.pool, access: grantAccess, managementAction: 'access:grant' });
    await grants.create({ ...context, actor }, {
      resource: PLATFORM_RESOURCE,
      subject: { kind: 'account', id: seller.id },
      actions: ['offer:create', 'subject:create'],
      valid: '(,)',
      key: Bun.randomUUIDv7(),
    });
    await grants.create({ ...context, actor }, {
      resource: GLOBAL_CONTEXT,
      subject: { kind: 'account', id: seller.id },
      actions: ['subject:create', 'board:create'],
      valid: '(,)',
      key: Bun.randomUUIDv7(),
    });
  }
  let child: ReturnType<typeof Bun.spawn> | undefined;
  let workerFailure: string | undefined;
  let diagnostics = '';
  let readDiagnostics: Promise<void> = Promise.resolve();
  let held = true;
  const disputes = new Map<string, string>();
  let seeded = 0;
  let seedOffer: string | undefined;
  const measurements: { seeded: number; statements: readonly string[]; buffers: number }[] = [];
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
    // Search indexing is optional and would share this executor. The outcome suite does not configure it.
    const childEnv = {
      ...process.env,
      ...workerTestEnv({
        DATABASE_URL: databaseUrl,
        KERNEL_WORKER_POOL_SIZE: '10',
        KERNEL_EXECUTOR_ID: 'commerce-outcomes',
        AUTH_ISSUER: issuer,
        AUTH_AUDIENCE: audience,
        AUTH_JWKS_URL: `${issuer}/.well-known/jwks.json`,
        STRIPE_SECRET_KEY: 'sk_test_commerce',
        STRIPE_MANAGED_PAYMENTS: String(managedPayments),
        STRIPE_API_HOST: `http://127.0.0.1:${fake.port}`,
        CHECKOUT_SUCCESS_URL: configuration.successUrl,
        CHECKOUT_CANCEL_URL: configuration.cancelUrl,
        COMMERCE_OUTCOME_TIME: String(Date.parse(instant)),
      }),
    };
    delete childEnv.OPENSEARCH_URL;
    child = Bun.spawn([process.execPath, import.meta.filename], {
      env: childEnv,
      stdout: 'ignore',
      stderr: 'pipe',
      ipc(message) {
        if (message === 'ready') ready();
      },
    });
    const running = child;
    diagnostics = '';
    readDiagnostics = (async () => {
      const decoder = new TextDecoder();
      for await (const chunk of running.stderr as ReadableStream<Uint8Array>) {
        diagnostics += decoder.decode(chunk, { stream: true });
        workerFailure ??= diagnostics.match(/Relay effects stopped[^\n]*\n/)?.[0]?.trim();
      }
      diagnostics += decoder.decode();
    })();
    await Promise.race([
      readiness,
      running.exited.then(async (code) => {
        await readDiagnostics;
        throw new Error(`Commerce executor exited ${code}: ${diagnostics}`);
      }),
    ]);
    held = false;
  }
  async function waitForWork(
    parked: ReadonlySet<string>,
    partitions: readonly number[] | null,
    stillSeeding: () => boolean = () => false,
  ) {
    let quiet = 0;
    for (;;) {
      if (workerFailure) throw new Error(`Production commerce executor: ${workerFailure}`);
      // One grouped read. Listing every seeded workflow on each pass dominates the suite budget.
      const pending = await db.admin.query<{
        status: string;
        count: number;
        delay_until: string | null;
        failed_id: string | null;
      }>(
        `SELECT status, count(*)::int AS count, max(delay_until_epoch_ms)::text AS delay_until,
           (array_agg(workflow_uuid) FILTER (
             WHERE status IN ('ERROR', 'CANCELLED', 'MAX_RECOVERY_ATTEMPTS_EXCEEDED')
           ))[1] AS failed_id
         FROM dbos.workflow_status
         WHERE status <> 'SUCCESS' AND NOT (workflow_uuid = ANY($1::text[]))
         GROUP BY status`,
        [[...parked]],
      );
      const failed = pending.rows.find((row) => row.failed_id);
      if (failed?.failed_id) {
        await client.retrieveWorkflow(failed.failed_id).getResult();
        throw new Error(`Commerce workflow ended ${failed.status}`);
      }
      const delayed = pending.rows.filter((row) => row.status === 'DELAYED');
      if (pending.rows.length && delayed.length === pending.rows.length) {
        // Jump to the latest queued deadline so this wave runs together. One millisecond
        // at a time cannot drain the seeded reconciliations inside the suite budget.
        // Workflows these start are a later wave with later deadlines. PostgreSQL still
        // supplies command and provider observation times.
        const delayedUntil = Math.max(...delayed.map((row) => Number(row.delay_until ?? Number.NaN)));
        if (!Number.isFinite(delayedUntil)) throw new Error('Delayed workflow has no durable deadline');
        child!.send({ advanceTo: delayedUntil });
      }
      const backlog = await db.admin.query(
        `SELECT 1 FROM core.partition AS partition
         LEFT JOIN core.consumer_checkpoint AS checkpoint
           ON checkpoint.partition_no = partition.partition_no AND checkpoint.consumer = 'effects'
         WHERE partition.position > COALESCE(checkpoint.position, 0)
           AND ($1::int[] IS NULL OR partition.partition_no = ANY($1::int[]))
         LIMIT 1`,
        [partitions],
      );
      if (!pending.rows.length && !backlog.rowCount && !stillSeeding()) {
        // The relay enqueues after it commits. A single empty read can land in that gap.
        if (++quiet >= 3) break;
      } else quiet = 0;
      await Bun.sleep(50);
    }
  }
  async function databaseIsIdle() {
    const active = await db.admin.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM pg_stat_activity
       WHERE datname = current_database() AND pid <> pg_backend_pid() AND state <> 'idle'`,
    );
    return active.rows[0]?.count === '0';
  }
  async function pauseExecutor() {
    if (child) {
      // Production shutdown drains in-flight relay transactions before closing its pools.
      child.send('stop');
      const code = await child.exited;
      await readDiagnostics;
      child = undefined;
      held = true;
      if (code !== 0) throw new Error(`Commerce executor exited ${code}: ${diagnostics}`);
    }
    if (!(await databaseIsIdle())) throw new Error('Commerce executor still holds a database transaction');
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
      await (sellerAuthority ??= authorizeSeller());
      const publisher = await (editionFixture ??= createNativeEditionFixture(contentRequest));
      const edition = await publisher.publish({
        title: 'Commerce outcome book',
        subjectTitle: 'Commerce outcome book',
        body: 'Commerce outcome edition bytes',
      });
      return (
        await commands().createOffer(
          await actor(seller.id),
          {
            targetSubjectId: edition.targetSubjectId,
            contentEditionId: edition.contentEditionId,
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
      await pauseExecutor();
    },
    async settle() {
      await startExecutor();
      // Surface the production relay's stop reason instead of waiting forever
      // for a checkpoint it explicitly refused to advance. Never skip its events.
      await waitForWork(new Set(), null);
      // Drain the executor between ticks before holding the next measured operations.
      await pauseExecutor();
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
      if (seeded >= total) return;
      if (!seedOffer) seedOffer = (await driver.provisionOffer()).id;
      await driver.holdWork();
      await seedOrderFixtures(seedPool, seedOffer, seedAccounts, seeded, total, instant);
      seeded = total;
    },
    async measure(operation) {
      await driver.holdWork();
      // The exposure probe is once per connection. Warm it before capture so a
      // connection replaced while seeding does not add its catalogue read to one scale.
      await readExposure(db.pool, 'purchases', new Date(), Date.now() + 30_000);
      const result = await capture(db, operation);
      // Reylo rechecks table shape every minute. That catalog read is not part of the request and
      // lands on whichever scale crosses the minute; the support classifier removes it.
      const { statements } = withoutCatalogStatements('commerce outcome', result.capture);
      const cost = costOf(result.capture);
      measurements.push({ seeded, statements, buffers: cost.blocks });
      // Keep the actual SQL available for comparing scales and runs when the
      // frozen suite reports a count mismatch. Trace I/O is outside the capture.
      await Bun.write(
        new URL(`../../../../../.temp/commerce-outcome-${suffix}.json`, import.meta.url),
        JSON.stringify(measurements, null, 2),
      );
      return {
        value: result.value,
        statements: statements.length,
        buffers: cost.blocks,
      };
    },
    async close() {
      await stopWorker();
      await authServer.stop(true);
      fake.stop();
      tokens.clear();
      approvals.clear();
      await client.close();
      await authPool.end();
      await seedPool.end();
      await db.close();
      try {
        await dropTestDatabase(owner, authName);
        await dropTestDatabase(owner, kernelName);
      } finally {
        await owner.end();
      }
    },
  };
  return driver;
}
