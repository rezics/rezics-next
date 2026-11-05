import { afterAll, beforeAll, expect, test } from 'bun:test';
import { Pool } from 'pg';
import { exportJWK, generateKeyPair } from 'jose';
import { createAuthService } from '@rezics/auth';
import { createAccess } from '../../src/access/index.ts';
import { readAccount } from '../../src/access/account-data.ts';
import { PLATFORM_RESOURCE } from '../../src/access/bootstrap-governance.ts';
import { GLOBAL_CONTEXT } from '../../src/semantic/definitions.ts';
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
const actions = ['payout_statement:mark_paid'];
const scopes = [...actions, 'exposure:open'];
const operator = newId(0x7101);
const creator = newId(0x7102);
const other = newId(0x7103);
const accounts = [operator, creator, other];
const approvals = new Set(accounts);
const tokens = new Map<string, string>();
const authDatabase = `payout_mark_paid_${Bun.randomUUIDv7().replaceAll('-', '')}`;
const authUrl = new URL(url);
authUrl.pathname = `/${authDatabase}`;
let auth: Awaited<ReturnType<typeof createAuthService>>;
let authPool: Pool;
let app: ReturnType<typeof createKernel>;
let statementId: string;
let openStatementId: string;

async function authenticate(id: string) {
  const signedIn = await auth.handler(
    new Request(`${issuer}/signin`, {
      method: 'POST',
      headers: { origin: issuer, 'content-type': 'application/json' },
      body: JSON.stringify({ email: `${id}@example.test`, password, client_id: 'commerce-test', scope: scopes }),
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

async function request(id: string, account: string | null, paidReference = 'bank:ended', key = Bun.randomUUIDv7()) {
  return app.handle(
    new Request(`https://kernel.test/v1/payoutStatements/${id}:markPaid`, {
      method: 'POST',
      headers: {
        ...(account ? { authorization: `Bearer ${tokens.get(account)!}` } : {}),
        'content-type': 'application/json',
        'idempotency-key': JSON.stringify(key),
      },
      body: JSON.stringify({ paidReference }),
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
    kid: 'payout-mark-paid-test',
    alg: 'ES256',
  };
  auth = await createAuthService({
    database: authPool,
    issuer,
    audience,
    secret: 'payout-mark-paid-test-secret-at-least-thirty-two-bytes',
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
  await auth.internal.registerClient({ clientId: 'commerce-test', firstParty: true, scopes });
  for (const id of accounts) {
    await reader.query(
      "INSERT INTO access.account(route,account_id,kind,state,transaction_id) VALUES ($1,$2,'actor','pending',$2)",
      [routeOf(id), id],
    );
    await auth.internal.provisionPassword({ authorization: id, email: `${id}@example.test`, password });
    await reader.query("UPDATE access.account SET state='active' WHERE route=$1 AND account_id=$2", [routeOf(id), id]);
    tokens.set(id, await authenticate(id));
  }
  statementId = newId(routeOf(creator)!);
  await reader.query(
    "INSERT INTO commerce.payout_statement(route,statement_id,creator_account_id,period,currency) VALUES ($1,$2,$3,'2025-12','usd')",
    [routeOf(creator), statementId, creator],
  );
  openStatementId = newId(routeOf(creator)!);
  await reader.query(
    "INSERT INTO commerce.payout_statement(route,statement_id,creator_account_id,period,currency) VALUES ($1,$2,$3,$4,'usd')",
    [routeOf(creator), openStatementId, creator, new Date().toISOString().slice(0, 7)],
  );
  const child = bootstrap(operator);
  const [code, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  expect({ code, stdout, stderr }).toEqual({ code: 0, stdout: '', stderr: '' });
  app = createKernel({
    pool,
    routeKey: new Uint8Array(32),
    writeRate: {
      async spend() {
        return { allowed: true as const };
      },
    },
    access: (config) =>
      createAccess({
        ...config,
        auth: {
          issuer,
          audience,
          jwksUrl: `${issuer}/.well-known/jwks.json`,
          fetch: async () => auth.handler(new Request(`${issuer}/.well-known/jwks.json`)),
        },
      }),
  });
  const opened = await app.handle(
    new Request('https://kernel.test/v1/platform/exposure/selling:open', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${tokens.get(operator)!}`,
        'idempotency-key': JSON.stringify(Bun.randomUUIDv7()),
      },
    }),
  );
  if (opened.status !== 200) throw new Error(`Opening selling failed: ${opened.status} ${await opened.text()}`);
}, 60_000);

afterAll(async () => {
  await authPool?.end();
  await dropTestDatabase(reader, authDatabase);
  await pool.end();
  await reader.end();
});

test('creator, other account, anonymous, unknown and malformed statements share the same 404 problem', async () => {
  let expected: Record<string, unknown> | undefined;
  for (const [id, account] of [
    [statementId, creator],
    [statementId, other],
    [statementId, null],
    [newId(routeOf(creator)!), operator],
    ['not-a-uuid', operator],
  ] as const) {
    const response = await request(id, account);
    expect(response.status).toBe(404);
    const problem = await stableProblem(response);
    expected ??= problem;
    expect(problem).toEqual(expected);
  }
});

test('the operator cannot mark the current month paid', async () => {
  expect((await request(openStatementId, operator)).status).toBe(409);
  const current = await reader.query(
    'SELECT state, revision FROM commerce.payout_statement WHERE route=$1 AND statement_id=$2',
    [routeOf(creator), openStatementId],
  );
  expect(current.rows).toEqual([{ state: 'open', revision: 1 }]);
});

test('the platform operator pays once; replay needs current authority before reading its receipt', async () => {
  expect(PLATFORM_RESOURCE).toEqual({ route: 0, id: GLOBAL_CONTEXT });
  const key = Bun.randomUUIDv7();
  const first = await request(statementId, operator, 'bank:ended', key);
  expect(first.status).toBe(200);
  const paid = await first.json();
  expect(paid.statement).toMatchObject({ id: statementId, state: 'paid', paidReference: 'bank:ended', revision: 2 });
  expect(Number.isFinite(Date.parse(paid.statement.paidAt))).toBe(true);
  const replay = await request(statementId, operator, 'bank:ended', key);
  expect(replay.status).toBe(200);
  expect(await replay.json()).toEqual(paid);
  expect((await request(statementId, operator, 'bank:changed', key)).status).toBe(422);
  expect((await request(statementId, operator, 'bank:second')).status).toBe(409);
  const count = await reader.query(
    "SELECT count(*)::int n FROM core.outbox WHERE type='com.rezics.commerce.payout_statement.paid.v1' AND subject=$1",
    [statementId],
  );
  expect(count.rows).toEqual([{ n: 1 }]);
  const revoked = await reader.query(
    'DELETE FROM access.resource_role_grant WHERE route=0 AND resource_id=$1 AND subject_id=$2',
    [GLOBAL_CONTEXT, operator],
  );
  expect(revoked.rowCount).toBe(1);
  const deniedReplay = await request(statementId, operator, 'bank:ended', key);
  const anonymous = await request(statementId, null);
  expect(deniedReplay.status).toBe(404);
  expect(anonymous.status).toBe(404);
  expect(await stableProblem(deniedReplay)).toEqual(await stableProblem(anonymous));
});
