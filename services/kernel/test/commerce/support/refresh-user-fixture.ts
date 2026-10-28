import { createAuthService } from '@rezics/auth';
import { exportJWK, generateKeyPair } from 'jose';
import { Pool } from 'pg';
import { bootstrapGovernance, PLATFORM_RESOURCE } from '../../../src/access/bootstrap-governance.ts';
import { readAccount } from '../../../src/access/account-data.ts';
import { createAccess } from '../../../src/access/index.ts';
import { createGrantCommands } from '../../../src/access/grant-commands.ts';
import { createWriteRateLimiter } from '../../../src/access/write-rate.ts';
import { createCommerceCommands } from '../../../src/commerce/commands.ts';
import { createCommerceWork } from '../../../src/commerce/enqueue.ts';
import { createStripePort } from '../../../src/commerce/stripe.ts';
import { classifyStripeEvent, verifyStripeEvent } from '../../../src/commerce/webhook.ts';
import { createKernel } from '../../../src/http/kernel.ts';
import { actionCatalogue } from '../../../src/http/request.ts';
import { newId, routeOf, partitionOf } from '../../../src/route/route.ts';
import { createWorkClient } from '../../../src/work/client.ts';
import { createAuthDatabase } from '../../support/auth-database.ts';
import { dropTestDatabase } from '../../support/drop-test-database.ts';
import { trustedAccessPorts } from '../../support/trusted-access.ts';
import { workerTestEnv } from '../../support/worker-env.ts';
import { startFakeStripe } from './fake-stripe.ts';
import { until } from './work-fixture.ts';

export type Boundary = 'read' | 'order-lock' | 'commit';
export type Control =
  | { kind: 'arm'; workflow: string; point: Boundary; token: string }
  | { kind: 'release'; token: string };
export type Notice = {
  kind: 'ready' | 'armed' | 'boundary' | 'released' | 'read' | 'serialization' | 'cancel-signal' | 'checkpoint';
  pid?: number;
  token?: string;
  workflow?: string;
  point?: Boundary;
  session?: string;
  observedAt?: string;
  refunds?: { id: string; status: string; amountMinor: number }[];
  disputes?: { id: string; status: string; amountMinor: number }[];
  transactions?: string[];
};

/** Each file already owns its migrated kernel database. Auth is a separately owned clone. */
export async function refreshUserFixture(provider?: ReturnType<typeof startFakeStripe>) {
  const databaseUrl = process.env.DATABASE_URL!;
  if (!databaseUrl) throw new Error('DATABASE_URL must name the migrated test database');
  const pool = new Pool({ connectionString: databaseUrl, max: 6 });
  pool.on('error', () => {});
  const client = await createWorkClient(databaseUrl);
  const fake = provider ?? startFakeStripe();
  // Legal provider states lacking a balance transaction. Only provider HTTP bytes change.
  const refundBytes = new Map<string, 'pending' | 'canceled'>();
  const proxy = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      const response = await fetch(`http://127.0.0.1:${fake.port}${url.pathname}${url.search}`, {
        method: request.method,
        headers: request.headers,
        ...(request.method === 'POST' ? { body: await request.text() } : {}),
      });
      if (url.pathname !== '/v1/refunds' || !response.ok) return response;
      const body = await response.json();
      for (const refund of body.data)
        if (refundBytes.has(refund.id)) {
          refund.status = refundBytes.get(refund.id);
          refund.balance_transaction = null;
          refund.failure_balance_transaction = null;
        }
      return Response.json(body);
    },
  });
  let instant = new Date().toISOString();
  const stripe = createStripePort({
    apiKey: 'sk_test_refresh',
    managedPayments: false,
    host: '127.0.0.1',
    port: proxy.port!,
    protocol: 'http',
    maxNetworkRetries: 0,
    clock: () => new Date(instant),
  });
  const seller = newId(0x2200),
    buyer = newId(0x3300),
    governor = newId(0x1100);
  const people = [seller, buyer, governor];
  const approvals = new Set(people);
  const authName = `refresh_auth_${Bun.randomUUIDv7().replaceAll('-', '')}`;
  const authPool = new Pool({ connectionString: await createAuthDatabase(databaseUrl, authName), max: 2 });
  const signing = {
    ...(await exportJWK((await generateKeyPair('ES256', { extractable: true })).privateKey)),
    kid: 'refresh',
    alg: 'ES256',
  };
  const authServer = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: (request) => auth.handler(request) });
  const issuer = `http://127.0.0.1:${authServer.port}`,
    audience = 'https://kernel.refresh.test';
  const auth = await createAuthService({
    database: authPool,
    issuer,
    audience,
    secret: 'refresh-fixture-secret-with-at-least-32-bytes',
    signing: { activeKid: signing.kid, privateKeys: [signing] },
    trustedAccess: trustedAccessPorts({
      async readAccount(id) {
        const row = await readAccount(pool, routeOf(id)!, id);
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
  const authentication = {
    issuer,
    audience,
    jwksUrl: `${issuer}/.well-known/jwks.json`,
    fetch: async (location: string | URL | Request, init?: RequestInit) => auth.handler(new Request(location, init)),
  };
  let access!: ReturnType<typeof createAccess>;
  const enqueue = createCommerceWork(client);
  const app = createKernel({
    pool,
    requestDeadlineMs: 15_000,
    clock: () => new Date(instant),
    writeRate: createWriteRateLimiter({ secret: 'refresh-write-rate-secret-with-at-least-32-bytes' }),
    routeKey: new Uint8Array(32).fill(7),
    tokens: { current: 1, keys: new Map([[1, new Uint8Array(32).fill(8)]]) },
    access: (config) => (access = createAccess({ ...config, auth: authentication })),
    commerce: {
      stripe,
      successUrl: 'https://web.test/success',
      cancelUrl: 'https://web.test/cancel',
      webhookSecrets: [fake.webhookSecret],
      work: enqueue,
    },
  });
  const scopes = [...actionCatalogue(app).keys(), 'access:grant'].filter((scope) => scope !== 'media:complete');
  await auth.internal.registerClient({ clientId: 'web', firstParty: true, scopes });
  const tokens = new Map<string, string>();
  const password = 'refresh fixture password with enough entropy';
  for (const id of people) {
    await pool.query(
      "INSERT INTO access.account(route,account_id,kind,state,transaction_id) VALUES ($1,$2,'actor','pending',$2)",
      [routeOf(id), id],
    );
    await auth.internal.provisionPassword({ authorization: id, email: `${id}@example.test`, password });
    await pool.query("UPDATE access.account SET state='active' WHERE route=$1 AND account_id=$2", [routeOf(id), id]);
    const signedIn = await auth.handler(
      new Request(`${issuer}/signin`, {
        method: 'POST',
        headers: { origin: issuer, 'content-type': 'application/json' },
        body: JSON.stringify({ email: `${id}@example.test`, password, client_id: 'web', scope: scopes }),
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
    tokens.set(id, (await issued.json()).access_token);
  }
  // Freeze after real Auth issuance so its issued-at claim is not in this kernel clock's future.
  instant = new Date().toISOString();
  async function request(path: string, as = buyer, body?: unknown) {
    return app.handle(
      new Request(`http://kernel.test${path}`, {
        method: body === undefined ? 'GET' : 'POST',
        headers: {
          authorization: `Bearer ${tokens.get(as)!}`,
          'content-type': 'application/json',
          'idempotency-key': JSON.stringify(Bun.randomUUIDv7()),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
    );
  }
  await request('/v1/entitlements'); // Mount the real Access action catalogue before trusted commands.
  await bootstrapGovernance(pool, governor);
  for (const group of ['purchases', 'selling']) {
    const response = await request(`/v1/platform/exposure/${group}:open`, governor, {});
    if (response.status !== 200) throw new Error(`Opening ${group}: ${response.status} ${await response.text()}`);
  }
  const grantAccess = createAccess({
    actions: new Map([...actionCatalogue(app), ['access:grant', { anonymous: false }]]),
    auth: authentication,
  });
  const grantContext = { pool, deadline: Date.now() + 15_000 };
  await createGrantCommands({ pool, access: grantAccess, managementAction: 'access:grant' }).create(
    { ...grantContext, actor: await grantAccess.authenticate(tokens.get(governor)!, grantContext) },
    {
      resource: PLATFORM_RESOURCE,
      subject: { kind: 'account', id: seller },
      actions: ['offer:create'],
      valid: '(,)',
      key: 'refresh-seller',
    },
  );
  const commands = createCommerceCommands({ pool, access });
  const actor = (id: string) => access.authenticate(tokens.get(id)!, { pool, deadline: Date.now() + 15_000 });
  const offer = (
    await commands.createOffer(
      await actor(seller),
      {
        targetSubjectId: newId(0x5500),
        title: 'Refresh book',
        currency: 'usd',
        unitAmountMinor: 1200,
        taxCode: 'txcd_10302000',
      },
      Bun.randomUUIDv7(),
    )
  ).value;
  let child: ReturnType<typeof Bun.spawn> | undefined;
  let diagnostics = '';
  const notices: Notice[] = [];
  async function notice(accept: (value: Notice) => boolean, after = 0) {
    return until(
      async () => {
        if (child?.exitCode !== null && child?.exitCode !== undefined) throw new Error(`Worker exited: ${diagnostics}`);
        return notices.slice(after).find(accept);
      },
      (value) => value !== undefined,
    ).then((value) => value!);
  }
  async function start() {
    const before = notices.length;
    child = Bun.spawn([process.execPath, `${import.meta.dir}/refresh-user-runtime.ts`], {
      env: {
        ...process.env,
        ...workerTestEnv({
          DATABASE_URL: databaseUrl,
          KERNEL_EXECUTOR_ID: 'commerce-refresh-users',
          AUTH_ISSUER: issuer,
          AUTH_AUDIENCE: audience,
          AUTH_JWKS_URL: authentication.jwksUrl,
          STRIPE_SECRET_KEY: 'sk_test_refresh',
          STRIPE_MANAGED_PAYMENTS: 'false',
          STRIPE_API_HOST: `http://127.0.0.1:${proxy.port}`,
          CHECKOUT_SUCCESS_URL: 'https://web.test/success',
          CHECKOUT_CANCEL_URL: 'https://web.test/cancel',
          REFRESH_TIME: instant,
          OPENSEARCH_URL: undefined,
        }),
      },
      stdout: 'ignore',
      stderr: 'pipe',
      ipc(message: Notice) {
        if (notices.length >= 2000) throw new Error('Fixture notification bound exceeded');
        notices.push(message);
      },
    });
    const running = child;
    void (async () => {
      for await (const bytes of running.stderr as ReadableStream<Uint8Array>)
        diagnostics += new TextDecoder().decode(bytes);
    })();
    return notice((value) => value.kind === 'ready', before);
  }
  async function stop() {
    if (!child) return undefined;
    const owned = child;
    owned.kill('SIGKILL');
    const code = await owned.exited;
    child = undefined;
    return { pid: owned.pid, code, signal: owned.signalCode };
  }
  async function arm(workflow: string, point: Boundary) {
    const token = Bun.randomUUIDv7();
    const after = notices.length;
    child!.send({ kind: 'arm', workflow, point, token } satisfies Control);
    await notice((value) => value.kind === 'armed' && value.token === token, after);
    return {
      token,
      captured: () => notice((value) => value.kind === 'boundary' && value.token === token, after),
      release() {
        child?.send({ kind: 'release', token } satisfies Control);
      },
      released: () => notice((value) => value.kind === 'released' && value.token === token, after),
    };
  }
  async function finish(id: string) {
    await until(
      () => client.getWorkflow(id),
      (row) => row?.status === 'SUCCESS' || row?.status === 'ERROR',
    );
    return client.retrieveWorkflow(id).getResult();
  }
  return {
    pool,
    client,
    fake,
    buyer,
    offer,
    request,
    start,
    stop,
    arm,
    notice,
    notices,
    instant,
    finish,
    async checkout() {
      const response = await request('/v1/orders', buyer, { offerId: offer.id });
      if (response.status !== 201) throw new Error(`Checkout: ${response.status} ${await response.text()}`);
      const order = (await response.json()).order;
      const stored = await commands.readOrderForAccount(buyer, order.id);
      if (!stored?.checkoutSessionId) throw new Error('Checkout has no recorded Session');
      return { order: stored, session: stored.checkoutSessionId };
    },
    async event(type: string, objectId: string) {
      const signed = await fake.event(type, objectId);
      const ref = classifyStripeEvent(
        await verifyStripeEvent(
          new TextEncoder().encode(signed.bytes),
          signed.signature,
          [fake.webhookSecret],
          Date.now(),
        ),
      )!;
      const id = `stripe:${ref.eventId}`;
      return {
        id,
        ref,
        child: `checkout:${ref.sessionId ?? objectId}:${ref.eventId}`,
        async submit() {
          const response = await app.handle(
            new Request('http://kernel.test/v1/webhooks/stripe', {
              method: 'POST',
              headers: signed.headers,
              body: signed.bytes,
            }),
          );
          if (response.status !== 200 && response.status !== 202)
            throw new Error(`Webhook: ${response.status} ${await response.text()}`);
        },
      };
    },
    pendingRefund(session: string) {
      const id = fake.refund(session, { amount: 1200, status: 'pending' });
      refundBytes.set(id, 'pending');
      return {
        id,
        cancel() {
          fake.failRefund(id);
          refundBytes.set(id, 'canceled');
        },
      };
    },
    reads(workflow: string) {
      return notices.filter((n) => n.kind === 'read' && n.workflow === workflow);
    },
    async state(orderId: string) {
      return (
        await pool.query(
          'SELECT revision, settlement, observed_at::text FROM commerce.purchase_order WHERE route=$1 AND order_id=$2',
          [routeOf(orderId), orderId],
        )
      ).rows[0]!;
    },
    async receipts(workflow: string) {
      return (
        await pool.query(
          'SELECT principal_id, partition_no, idempotency_key, transaction_id FROM core.receipt WHERE command_kind=$1 AND idempotency_key=$2',
          ['commerce.checkout.apply', `wf:${workflow}:apply`],
        )
      ).rows;
    },
    async events(orderId: string, suffix: string) {
      return (
        await pool.query("SELECT id, data FROM core.outbox WHERE data->>'orderId'=$1 AND type=$2", [
          orderId,
          `com.rezics.commerce.${suffix}.v1`,
        ])
      ).rows;
    },
    async transactions(orderId: string) {
      return (
        await pool.query(
          'SELECT balance_transaction_id, kind FROM commerce.order_transaction WHERE route=$1 AND order_id=$2 ORDER BY balance_transaction_id',
          [routeOf(orderId), orderId],
        )
      ).rows;
    },
    async ownReceiptEvents(orderId: string, revision: number) {
      // The real outbox event must share the native receipt's committed envelope.
      return (
        await pool.query(
          `SELECT r.command_kind, r.idempotency_key FROM core.outbox o
        JOIN core.receipt r USING (partition_no, epoch, position)
        WHERE o.partition_no=$1 AND o.data->>'orderId'=$2 AND (o.data->>'revision')::int=$3
          AND o.type='com.rezics.commerce.order.updated.v1'`,
          [partitionOf(routeOf(orderId)!), orderId, revision],
        )
      ).rows;
    },
    async close() {
      await stop();
      await proxy.stop(true);
      if (!provider) fake.stop();
      await authServer.stop(true);
      await authPool.end();
      await client.close();
      const url = new URL(databaseUrl);
      url.pathname = '/postgres';
      const owner = new Pool({ connectionString: url.toString(), max: 1 });
      try {
        await dropTestDatabase(owner, authName);
      } finally {
        await owner.end();
        await pool.end();
      }
    },
  };
}
