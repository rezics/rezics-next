import { afterAll, beforeAll, expect, test } from 'bun:test';
import { Pool } from 'pg';
import { exportJWK, generateKeyPair } from 'jose';
import { createAuthService } from '@rezics/auth';
import { createAccess } from '../../src/access/index.ts';
import { readAccount } from '../../src/access/account-data.ts';
import { createGrantCommands } from '../../src/access/grant-commands.ts';
import { PLATFORM_RESOURCE } from '../../src/access/bootstrap-governance.ts';
import { createPool } from '../../src/database/pool.ts';
import { createKernel } from '../../src/http/kernel.ts';
import { newId, routeOf } from '../../src/route/route.ts';
import { trustedAccessPorts } from '../support/trusted-access.ts';
import { dropTestDatabase } from '../support/drop-test-database.ts';

const root = new URL('../../../../', import.meta.url).pathname;
const script = 'services/kernel/scripts/bootstrap-governance.ts';
const url = process.env.DATABASE_URL!;
if (!url) throw new Error('DATABASE_URL must name the migrated test database');
const pool = createPool(url);
pool.options.max = 1;
const reader = new Pool({ connectionString: url, max: 1 });
const issuer = 'https://auth.example.test';
const audience = 'https://api.rezics.test';
const password = 'correct horse battery staple';
const actions = ['access:grant', 'offer:create', 'payout_statement:mark_paid', 'exposure:open'];
const operator = newId(0x7101);
const seller = newId(0x7102);
const other = newId(0x7103);
const accounts = [operator, seller, other];
const approvals = new Set(accounts);
const tokens = new Map<string, string>();
const authDatabase = `commerce_governance_${Bun.randomUUIDv7().replaceAll('-', '')}`;
const authUrl = new URL(url);
authUrl.pathname = `/${authDatabase}`;
let auth: Awaited<ReturnType<typeof createAuthService>>;
let authPool: Pool;
let access: ReturnType<typeof createAccess> | undefined;
let app: ReturnType<typeof createKernel>;
let statementId: string;

async function authenticate(id: string) {
  const signedIn = await auth.handler(
    new Request(`${issuer}/signin`, {
      method: 'POST',
      headers: { origin: issuer, 'content-type': 'application/json' },
      body: JSON.stringify({ email: `${id}@example.test`, password, client_id: 'commerce-test', scope: actions }),
    }),
  );
  expect(signedIn.status).toBe(200);
  const cookie = signedIn.headers
    .getSetCookie()
    .map((value) => value.split(';')[0])
    .join('; ');
  const issued = await auth.handler(
    new Request(`${issuer}/token`, {
      method: 'POST',
      headers: { origin: issuer, cookie, 'content-type': 'application/json' },
      body: '{}',
    }),
  );
  expect(issued.status).toBe(200);
  return ((await issued.json()) as { access_token: string }).access_token;
}

function bootstrap(id: string) {
  return Bun.spawn(['bun', script, '--account', id], {
    cwd: root,
    env: { ...process.env, DATABASE_URL: url },
    stdout: 'pipe',
    stderr: 'pipe',
  });
}

async function request(path: string, account: string | null, body?: unknown) {
  return app.handle(
    new Request(`https://kernel.test${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: {
        ...(account ? { authorization: `Bearer ${tokens.get(account)!}` } : {}),
        ...(body === undefined
          ? {}
          : {
              'content-type': 'application/json',
              'idempotency-key': JSON.stringify(Bun.randomUUIDv7()),
            }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
  );
}

async function stableProblem(response: Response) {
  const { request_id: _requestId, ...body } = (await response.json()) as Record<string, unknown>;
  return body;
}

beforeAll(async () => {
  await reader.query(`CREATE DATABASE ${authDatabase}`);
  const { migrate } = await import(new URL('../../../auth/scripts/database.ts', import.meta.url).href);
  migrate(authUrl.toString());
  authPool = new Pool({ connectionString: authUrl.toString() });
  const key = {
    ...(await exportJWK((await generateKeyPair('ES256', { extractable: true })).privateKey)),
    kid: 'commerce-governance-test',
    alg: 'ES256',
  };
  auth = await createAuthService({
    database: authPool,
    issuer,
    audience,
    secret: 'commerce-governance-test-secret-at-least-thirty-two-bytes',
    signing: { activeKid: key.kid, privateKeys: [key] },
    trustedAccess: trustedAccessPorts({
      async readAccount(id) {
        const account = await readAccount(pool, routeOf(id)!, id);
        return (
          account && {
            accountId: account.accountId,
            kind: account.kind,
            state: account.state,
            authnEpoch: Number(account.minimumAuthnEpoch),
            automated: account.operatorAccountId !== null,
          }
        );
      },
      async authorizeProvisioning(reference) {
        if (!approvals.delete(reference)) throw new Error('Unknown fixture provisioning reference');
        return { accountId: reference };
      },
    }),
  });
  await auth.internal.registerClient({ clientId: 'commerce-test', firstParty: true, scopes: actions });
  for (const id of accounts) {
    await reader.query(
      "INSERT INTO access.account(route,account_id,kind,state,transaction_id) VALUES ($1,$2,'actor','pending',$2)",
      [routeOf(id), id],
    );
    await auth.internal.provisionPassword({ authorization: id, email: `${id}@example.test`, password });
    await reader.query("UPDATE access.account SET state='active' WHERE route=$1 AND account_id=$2", [routeOf(id), id]);
    tokens.set(id, await authenticate(id));
  }
  statementId = newId(routeOf(seller)!);
  await reader.query(
    "INSERT INTO commerce.payout_statement(route,statement_id,creator_account_id,period,currency) VALUES ($1,$2,$3,'2025-12','usd')",
    [routeOf(seller), statementId, seller],
  );
  app = createKernel({
    pool,
    routeKey: new Uint8Array(32),
    writeRate: {
      async spend() {
        return { allowed: true as const };
      },
    },
    access: (config) => {
      const catalogue = new Map(config.actions);
      catalogue.set('access:grant', { anonymous: false });
      return (access = createAccess({
        ...config,
        actions: catalogue,
        auth: {
          issuer,
          audience,
          jwksUrl: `${issuer}/.well-known/jwks.json`,
          fetch: async () => auth.handler(new Request(`${issuer}/.well-known/jwks.json`)),
        },
      }));
    },
  });
}, 60_000);

afterAll(async () => {
  await authPool?.end();
  await dropTestDatabase(reader, authDatabase);
  await pool.end();
  await reader.end();
});

test('platform governance delegates offer creation and pays an ended statement through mounted commerce routes', async () => {
  const child = bootstrap(operator);
  const [code, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  expect({ code, stdout, stderr }).toEqual({ code: 0, stdout: '', stderr: '' });
  for (const group of ['purchases', 'selling']) {
    const opened = await app.handle(
      new Request(`https://kernel.test/v1/platform/exposure/${group}:open`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${tokens.get(operator)!}`,
          'idempotency-key': JSON.stringify(Bun.randomUUIDv7()),
        },
      }),
    );
    if (opened.status !== 200) throw new Error(`Opening ${group} failed: ${opened.status} ${await opened.text()}`);
  }

  const input = {
    targetSubjectId: newId(0x7104),
    title: 'Governed offer',
    currency: 'usd',
    unitAmountMinor: 1200,
    taxCode: 'txcd_10302000',
  };
  expect((await request('/v1/offers', seller, input)).status).toBe(403);

  const currentAccess = access;
  if (!currentAccess) throw new Error('Kernel did not compose Access');
  const deadline = Date.now() + 10_000;
  const actor = await currentAccess.authenticate(tokens.get(operator)!, { pool, deadline });
  const grants = createGrantCommands({ pool, access: currentAccess, managementAction: 'access:grant' });
  await grants.create(
    { pool, deadline, actor },
    {
      resource: PLATFORM_RESOURCE,
      subject: { kind: 'account', id: seller },
      actions: ['offer:create'],
      valid: '(,)',
      key: 'delegate-offer-creation',
    },
  );

  const created = await request('/v1/offers', seller, input);
  expect(created.status).toBe(201);
  expect((await created.json()).offer.title).toBe(input.title);
  expect((await request('/v1/offers', other, input)).status).toBe(403);

  const paid = await request(`/v1/payoutStatements/${statementId}:markPaid`, operator, {
    paidReference: 'bank:ended-statement',
  });
  expect(paid.status).toBe(200);
  expect((await paid.json()).statement).toMatchObject({ state: 'paid', paidReference: 'bank:ended-statement' });

  const sellerDenial = await request(`/v1/payoutStatements/${statementId}:markPaid`, seller, {
    paidReference: 'bank:unauthorized',
  });
  const anonymousDenial = await request(`/v1/payoutStatements/${statementId}:markPaid`, null, {
    paidReference: 'bank:unauthorized',
  });
  expect(sellerDenial.status).toBe(404);
  expect(anonymousDenial.status).toBe(404);
  expect(await stableProblem(sellerDenial)).toEqual(await stableProblem(anonymousDenial));
});
