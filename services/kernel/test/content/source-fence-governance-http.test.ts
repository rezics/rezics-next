import { suspendAccount, reinstateAccount } from '../support/native-suspension-driver.ts';
import { Pool } from 'pg';
import { exportJWK, generateKeyPair } from 'jose';
import { createAuthService, createProvisioningEvidenceVerifier } from '@rezics/auth';
import { createAccess } from '../../src/access/index.ts';
import { createLifecycleInternals } from '../../src/access/lifecycle.ts';
import { createAuthBindings } from '../../src/access/auth-bindings.ts';
import { createRegistrationProofBindings } from '../../src/access/registration-proof.ts';
import { PLATFORM_RESOURCE } from '../../src/access/bootstrap-governance.ts';
import { createGrantCommands } from '../../src/access/grant-commands.ts';
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { createPool } from '../../src/database/pool.ts';
import { createKernel } from '../../src/http/kernel.ts';
import { openApiDocument } from '../../src/http/openapi.ts';
import { actionCatalogue } from '../../src/http/request.ts';
import { readAccount } from '../../src/access/account-data.ts';
import { createWriteRateLimiter } from '../../src/access/write-rate.ts';
import { authoritativeTimeValue } from '../../src/command/command.ts';
import { tupleRoute } from '../../src/content/imported-contract.ts';
import { readPartition } from '../../src/partition/partition.ts';
import { partitionOf, routeOf } from '../../src/route/route.ts';
import { decodeSession } from '../../src/tokens/session.ts';
import { SESSION_HEADER } from '../../src/http/request.ts';
import { checkGrowth, openGrowthDatabase, seed } from '../support/growth.ts';
import { observeSql } from './support/sql-observer.ts';
import { createKernelClient } from '@rezics/client';
import type { AccountActor, Access } from '../../src/request/access.ts';
import type { ImportedFieldGroup } from '../../src/content/imported-contract.ts';
import { dropTestDatabase } from '../support/drop-test-database.ts';

const contractPool = createPool('postgres://kernel.invalid/source-fence-contract');
afterAll(() => contractPool.end());

test('generated custom route uses literal colon and shared rate stage', () => {
  const app = createKernel({ pool: contractPool, routeKey: new Uint8Array(32) });
  expect(app.routes.filter((route) => route.path === '/v1/sourceFences/$takedown')).toHaveLength(1);
  const operation = openApiDocument(app).paths['/v1/sourceFences:takedown']?.post;
  expect(operation?.['x-action']).toBe('source_fence:takedown');
  expect(operation?.['x-rate-limit']).toEqual({ family: 'write', units: 1 });
  expect(operation?.security).toEqual([{ bearerAuth: [] }]);
  expect(actionCatalogue(app).get('source_fence:takedown')?.anonymous).toBe(false);
});

const action = 'source_fence:takedown';
const platform = PLATFORM_RESOURCE;
const routeKey = new Uint8Array(32).fill(7);
const tokens = { current: 1, keys: new Map([[1, new Uint8Array(32).fill(8)]]) };
let db: Awaited<ReturnType<typeof openGrowthDatabase>>;
let f: { actorId: string };
let auth: Awaited<ReturnType<typeof createAuthService>>;
let authPool: Pool;
let authDatabase: string;
let grantAccess: Access;
let grantor: string;
let bearer: string;
let noScopeBearer: string;
const issuer = 'https://auth.example.test';
const password = 'correct horse battery staple';
const scopes = [action, 'access:grant'];
async function issue(id: string, scope = scopes) {
  const response = await auth.handler(
    new Request(`${issuer}/signin`, {
      method: 'POST',
      headers: { origin: issuer, 'content-type': 'application/json' },
      body: JSON.stringify({ email: `${id}@example.test`, password, client_id: 'governance-test', scope }),
    }),
  );
  expect(response.status).toBe(200);
  const cookie = response.headers
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
async function grantContext() {
  const context = { pool: db.pool, deadline: Date.now() + 10000 };
  return { ...context, actor: await grantAccess.authenticate(await issue(grantor), context) };
}
let observer: ReturnType<typeof observeSql>;
let app: ReturnType<typeof createKernel>;
let actor: AccountActor;
let permissions: ReturnType<typeof createAccess>;
const checks: { resource: unknown; action: string; at: string; allowed: boolean }[] = [];
let spends = 0;
let refuseRate = false;
const input = (externalId = Bun.randomUUIDv7(), fieldGroup: ImportedFieldGroup = 'summary') => ({
  source: 'catalogue',
  externalId,
  fieldGroup,
  reason: 'private governance evidence',
});
const home = (body: ReturnType<typeof input>) => ({
  route: tupleRoute(routeKey, body.source, body.externalId),
  source: body.source,
  external_id: body.externalId,
  field_group: body.fieldGroup,
});
async function grant() {
  return createGrantCommands({ pool: db.pool, access: grantAccess, managementAction: 'access:grant' }).create(
    await grantContext(),
    {
      resource: platform,
      subject: { kind: 'account', id: f.actorId },
      actions: [action],
      valid: '(,)',
      key: Bun.randomUUIDv7(),
    },
  );
}
async function revoke() {
  return createGrantCommands({ pool: db.pool, access: grantAccess, managementAction: 'access:grant' }).revoke(
    await grantContext(),
    {
      resource: platform,
      subject: { kind: 'account', id: f.actorId },
      actions: [action],
      valid: '(,)',
      key: Bun.randomUUIDv7(),
    },
  );
}
beforeAll(async () => {
  db = await openGrowthDatabase();
  db.pool.options.max = 1;
  authDatabase = `fence_auth_${process.pid}`;
  const authUrl = new URL(db.url);
  authUrl.pathname = `/${authDatabase}`;
  await db.admin.query(`CREATE DATABASE ${authDatabase}`);
  const { migrate } = await import(new URL('../../../auth/scripts/database.ts', import.meta.url).href);
  migrate(authUrl.toString());
  authPool = new Pool({ connectionString: authUrl.toString() });
  const evidence = createProvisioningEvidenceVerifier({ database: authPool });
  const lifecycle = createLifecycleInternals({
    pool: db.pool,
    routeKey,
    provisioningEvidence: evidence.resolve,
    recoveryEvidence: async () => null,
  });
  const proofs = createRegistrationProofBindings({ pool: db.pool, referenceKeys: tokens });
  const key = {
    ...(await exportJWK((await generateKeyPair('ES256', { extractable: true })).privateKey)),
    kid: 'source-fence-test',
    alg: 'ES256',
  };
  const bindings = createAuthBindings({ pool: db.pool, ...proofs });
  auth = await createAuthService({
    database: authPool,
    issuer,
    audience: 'https://api.rezics.test',
    secret: 'source-fence-auth-private-test-secret-at-least-32-bytes',
    signing: { activeKid: key.kid, privateKeys: [key] },
    trustedAccess: {
      ...bindings,
      async authorizeProvisioning(reference) {
        const approval = await bindings.authorizeProvisioning(reference);
        const receipt = await proofs.verifyProvisioningReceipt(reference);
        const account = await readAccount(db.pool, routeOf(approval.accountId)!, approval.accountId);
        if (!receipt || !account) throw new Error('Missing committed registration');
        return {
          ...approval,
          receipt: {
            registrationId: receipt.registrationId,
            reservationId: receipt.registrationId,
            expiresAt: receipt.expiresAt,
            authnEpoch: Number(account.minimumAuthnEpoch),
          },
        };
      },
    },
  });
  await auth.internal.registerClient({ clientId: 'governance-test', firstParty: true, scopes });
  async function human(handle: string) {
    const key = `source-fence-${handle}`;
    const accountId = lifecycle.registrationTarget(key);
    const reservation = await lifecycle.reserveHandle({ accountId, handle, key });
    const input = { accountId, handle, key, reservationId: reservation.value.reservationId };
    const outcome = await lifecycle.createPending(input);
    const authorization = await proofs.createProvisioningReference({ input, outcome });
    if (!authorization) throw new Error('Missing native provisioning reference');
    const result = await auth.internal.provisionPassword({
      authorization,
      email: `${accountId}@example.test`,
      password,
    });
    await lifecycle.claimHandle({ ...input, key: `${key}-claim`, evidence: result.provisioningEvidence });
    await lifecycle.activate({ accountId, key: `${key}-activate`, evidence: result.provisioningEvidence });
    return accountId;
  }
  grantor = await human('fence_governor');
  f = { actorId: await human('fence_operator') };
  const child = Bun.spawn(['bun', 'services/kernel/scripts/bootstrap-governance.ts', '--account', grantor], {
    cwd: new URL('../../../../', import.meta.url).pathname,
    env: { ...process.env, DATABASE_URL: db.url },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [code, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
  expect({ code, stderr }).toEqual({ code: 0, stderr: '' });
  const catalogue = actionCatalogue(createKernel({ pool: db.pool, routeKey }));
  const authentication = {
    issuer,
    audience: 'https://api.rezics.test',
    jwksUrl: `${issuer}/.well-known/jwks.json`,
    fetch: async () => auth.handler(new Request(`${issuer}/.well-known/jwks.json`)),
  };
  // Permission HTTP composition is outside this route's ownership. Setup uses the
  // actual native grant commands, authorized by the operator's bootstrapped role.
  grantAccess = createAccess({
    actions: new Map([...catalogue, ['access:grant', { anonymous: false }]]),
    auth: authentication,
  });
  permissions = createAccess({ actions: catalogue, auth: authentication });
  const access: Access = {
    ...permissions,
    async authorize(client, identity, verb, resource, evidence, time) {
      const allowed = await permissions.authorize(client, identity, verb, resource, evidence, time);
      checks.push({ resource, action: verb, at: authoritativeTimeValue(time!), allowed });
      return allowed;
    },
  };
  bearer = await issue(f.actorId, [action]);
  noScopeBearer = await issue(f.actorId, ['access:grant']);
  actor = await permissions.authenticate(bearer, { pool: db.pool, deadline: Date.now() + 10000 });
  const limiter = createWriteRateLimiter({
    secret: 'source-fence-http-private-test-secret-at-least-32-bytes',
    overrides: '{"new-account":{"write":{"maximum":1000,"seconds":60}}}',
  });
  app = createKernel({
    pool: db.pool,
    routeKey,
    tokens,
    access,
    ratePeer: () => '127.0.0.1',
    writeRate: {
      async spend(context, family, units) {
        spends++;
        expect(family).toBe('write');
        expect(units).toBe(1);
        return refuseRate ? { allowed: false, retryAfter: 1 } : limiter.spend(context, family, units);
      },
    },
  });
  observer = observeSql(db.pool);
  await grant();
}, 90000);
afterAll(async () => {
  await observer?.close();
  await authPool?.end();
  if (authDatabase) await dropTestDatabase(db.admin, authDatabase);
  await db?.close();
});
async function call(
  body: unknown = input(),
  key = Bun.randomUUIDv7(),
  options: {
    path?: string;
    authenticated?: boolean;
    idempotency?: string;
    method?: string;
    bearer?: string;
  } = {},
) {
  const response = await app.handle(
    new Request(`http://kernel.test${options.path ?? '/v1/sourceFences:takedown'}`, {
      method: options.method ?? 'POST',
      headers: {
        ...(options.authenticated === false ? {} : { authorization: `Bearer ${options.bearer ?? bearer}` }),
        'content-type': 'application/json',
        'idempotency-key': options.idempotency ?? JSON.stringify(key),
      },
      ...(options.method === 'GET' ? {} : { body: JSON.stringify(body) }),
    }),
  );
  return { response, body: await response.json() };
}
async function effects() {
  return Promise.all(
    [
      'SELECT to_jsonb(row) AS value FROM content.source_fences row ORDER BY to_jsonb(row)::text',
      "SELECT to_jsonb(row) AS value FROM core.receipt row WHERE command_kind='content.source-fence.takedown' ORDER BY to_jsonb(row)::text",
      "SELECT to_jsonb(row) AS value FROM core.outbox row WHERE type='com.rezics.content.source_fence.taken_down.v1' ORDER BY to_jsonb(row)::text",
    ].map(async (sql) => (await db.admin.query(sql)).rows),
  );
}
function denied(result: Awaited<ReturnType<typeof call>>, status: number) {
  expect(result.response.status).toBe(status);
  expect(result.response.headers.get('cache-control')).toBe('private, no-store');
  expect(result.response.headers.get('content-type')).toBe('application/problem+json');
  expect(result.body).not.toHaveProperty('securityRevision');
  expect(result.body).toHaveProperty('effect_status', 'not_applied');
  expect(result.response.headers.get(SESSION_HEADER)).toBeNull();
}

test('actual protected source-fence governance route writes one tuple partition after Global root check at T', async () => {
  const body = input('http-global-anchor-target');
  const target = home(body);
  const partition = partitionOf(target.route);
  expect(partition).not.toBe(0);
  const before = await readPartition(db.admin, partition);
  const root = await readPartition(db.admin, 0);
  const key = Bun.randomUUIDv7();
  const start = observer.records.length;
  const checked = checks.length;
  const spent = spends;
  const result = await call(body, key);
  expect(result.response.status).toBe(200);
  expect(Object.keys(result.body)).toEqual(['securityRevision']);
  expect(result.body.securityRevision).toMatch(/^[1-9][0-9]*$/);
  expect(result.response.headers.get('cache-control')).toBe('private, no-store');
  expect(spends - spent).toBe(1);
  const receipt = (
    await db.admin.query('SELECT * FROM core.receipt WHERE actor_account_id=$1 AND idempotency_key=$2', [
      actor.accountId,
      key,
    ])
  ).rows;
  expect(receipt).toHaveLength(1);
  expect(receipt[0].response).toEqual(result.body);
  const events = (
    await db.admin.query('SELECT * FROM core.outbox WHERE partition_no=$1 AND position=$2', [
      partition,
      before!.position + 1n,
    ])
  ).rows;
  expect(events).toHaveLength(1);
  const storedProvenance = (
    await db.admin.query(
      `SELECT taken_down_at::text AS "takenDownAt", takedown_id AS "takedownId"
      FROM content.source_fences WHERE route=$1 AND source=$2 AND external_id=$3 AND field_group=$4`,
      Object.values(target),
    )
  ).rows[0];
  expect(events[0].data).toEqual({
    ...target,
    securityRevision: result.body.securityRevision,
    ...storedProvenance,
  });
  expect(checks.slice(checked)).toEqual([{ resource: platform, action, at: checks[checked]!.at, allowed: true }]);
  const trace = observer.records.slice(start);
  expect(JSON.stringify(trace, (_, value) => (typeof value === 'bigint' ? value.toString() : value))).toContain(
    checks[checked]!.at,
  );
  const anchor = trace.findIndex((r) => /FROM semantic.context/.test(r.statement));
  const begin = trace.findIndex((r) => /^BEGIN ISOLATION LEVEL SERIALIZABLE/.test(r.statement));
  expect(anchor).toBeGreaterThanOrEqual(0);
  expect(anchor).toBeLessThan(begin);
  expect(trace[anchor]!.parameters).toEqual([0, platform.id]);
  expect(trace.slice(begin).some((r) => /(?:FROM|JOIN) (?:access\.|semantic\.)/.test(r.statement))).toBe(false);
  const writes = trace.filter((r) => /INSERT INTO content.source_fences/.test(r.statement));
  expect(writes.map((r) => r.parameters)).toEqual([
    [...Object.values(target), storedProvenance.takenDownAt, storedProvenance.takedownId],
  ]);
  expect(await readPartition(db.admin, 0)).toEqual(root);
  const session = decodeSession(tokens, `account:${actor.accountId}`, result.response.headers.get(SESSION_HEADER)!);
  expect(session).toContainEqual({ partition, epoch: before!.epoch, position: before!.position + 1n });
});

test('revoked replay discloses no receipt or new effect', async () => {
  const body = input();
  const key = Bun.randomUUIDv7();
  const first = await call(body, key);
  expect(first.response.status).toBe(200);
  const before = await effects();
  expect((await call(body, key)).body).toEqual(first.body);
  expect(await effects()).toEqual(before);
  denied(await call({ ...body, reason: 'changed' }, key), 422);
  await revoke();
  try {
    const start = observer.records.length;
    denied(await call(body, key), 403);
    expect(
      observer.records.slice(start).some((r) => /core.receipt|INSERT INTO content.source_fences/.test(r.statement)),
    ).toBe(false);
    expect(await effects()).toEqual(before);
  } finally {
    await grant();
  }
});

test('no grant, no scope, suspended and anonymous cannot mutate or disclose', async () => {
  const body = input();
  let before = await effects();
  await revoke();
  try {
    denied(await call(body), 403);
  } finally {
    await grant();
  }
  denied(await call(body, undefined, { bearer: noScopeBearer }), 403);
  expect(await effects()).toEqual(before);
  await suspendAccount(db.admin, actor.accountId);
  before = await effects();
  try {
    denied(await call(body), 401);
    expect(await effects()).toEqual(before);
  } finally {
    await reinstateAccount(db.admin, actor.accountId);
    bearer = await issue(actor.accountId, [action]);
    noScopeBearer = await issue(actor.accountId, ['access:grant']);
    actor = await permissions.authenticate(bearer, { pool: db.pool, deadline: Date.now() + 10000 });
    before = await effects();
  }
  denied(await call(body, undefined, { authenticated: false }), 401);
  expect(await effects()).toEqual(before);
  expect(
    (await call(undefined, undefined, { path: '/v1/sourceFences', method: 'GET', authenticated: false })).response
      .status,
  ).toBe(404);
  const preflight = await call(undefined, undefined, {
    path: '/v1/sourceFences:check',
    method: 'GET',
    authenticated: false,
  });
  expect([401, 403, 404]).toContain(preflight.response.status);
  expect(preflight.body).not.toHaveProperty('securityRevision');
  expect(preflight.body).not.toHaveProperty('fenced');
});

test('closed bounded wire inputs and internal routes fail without command effects', async () => {
  const body = input();
  const before = await effects();
  const patches = [
    ...['', 'Upper', 'catalogue\n', 'x'.repeat(33)].map((source) => ({ source })),
    ...['', '\ud800', 'a\nb', 'a\u0080b', 'x'.repeat(1025), 'é'.repeat(513)].map((externalId) => ({ externalId })),
    ...['', '\ud800', 'x'.repeat(1025)].map((reason) => ({ reason })),
    { fieldGroup: 'unknown' },
    { route: 0 },
    { actor: actor.accountId },
    { permission: true },
    { securityRevision: '1' },
    { external_id: body.externalId },
  ];
  for (const patch of patches) denied(await call({ ...body, ...patch }), 400);
  denied(await call(body, undefined, { idempotency: 'unquoted' }), 400);
  denied(await call({ ...body, reason: 'x'.repeat(20000) }), 413);
  for (const path of ['/v1/sourceFences/$takedown', '/v1/sourceFences/%24takedown']) {
    const result = await call(body, undefined, { path });
    expect(result.response.status).toBe(404);
    expect(result.body.code).toBe('not_found');
    expect(result.response.headers.get(SESSION_HEADER)).toBeNull();
  }
  expect(await effects()).toEqual(before);
});

test('all groups retain one tuple home and opaque revisions survive the actual client and session', async () => {
  const body = input('é'.repeat(512));
  let clientRequests = 0;
  const client = createKernelClient('http://kernel.test', {
    headers: {
      authorization: `Bearer ${bearer}`,
    },
    fetch: (async (request, init) => {
      const native = new Request(request, init);
      expect(new URL(native.url).pathname).toBe('/v1/sourceFences:takedown');
      if (clientRequests++ === 0) expect(native.headers.get(SESSION_HEADER)).toBeNull();
      else expect(native.headers.get(SESSION_HEADER)).toBeTruthy();
      return app.handle(native);
    }) as typeof fetch,
  });
  for (const fieldGroup of ['facts', 'summary', 'cover'] as const) {
    const result = await client.sourceFences.$takedown.post(
      { ...body, fieldGroup, reason: '😀'.repeat(512) },
      { headers: { 'idempotency-key': JSON.stringify(Bun.randomUUIDv7()) } },
    );
    expect(result.status).toBe(200);
    expect(result.data?.securityRevision).toMatch(/^[1-9][0-9]*$/);
  }
  const target = home(body);
  await db.admin.query(
    'UPDATE content.source_fences SET security_revision=9007199254740993 WHERE route=$1 AND source=$2 AND external_id=$3 AND field_group=$4',
    Object.values(target),
  );
  const result = await call(body);
  expect(result.body.securityRevision).toBe('9007199254740994');
  const rows = (
    await db.admin.query(
      'SELECT route, field_group FROM content.source_fences WHERE route=$1 AND source=$2 AND external_id=$3',
      Object.values(target).slice(0, 3),
    )
  ).rows;
  expect(rows).toHaveLength(3);
  expect(new Set(rows.map((row) => row.route)).size).toBe(1);
});

test('shared rate refusal prevents the actual handler command', async () => {
  const before = await effects();
  const spent = spends;
  refuseRate = true;
  try {
    denied(await call(), 429);
  } finally {
    refuseRate = false;
  }
  expect(spends - spent).toBe(1);
  expect(await effects()).toEqual(before);
});

test('checkGrowth observes actual HTTP pool costs with same-partition unrelated tuples', async () => {
  const body = input('http-growth-target');
  const target = home(body);
  const partition = partitionOf(target.route);
  // Put the receipt relation beyond PostgreSQL's small-table scan crossover before
  // measuring. Each fresh request adds history, which must remain an indexed seek.
  await db.admin.query(
    `INSERT INTO core.receipt
    (partition_no,principal_kind,principal_id,command_kind,idempotency_key,request_digest,epoch,position,transaction_id,response)
    SELECT $1,'account',$2,'content.source-fence.takedown','unused-growth-' || n,
      decode(repeat('00',32),'hex'),1,1,$3,'{"securityRevision":"1"}'::jsonb
    FROM generate_series(1,4096) n`,
    [partition, actor.accountId, Bun.randomUUIDv7()],
  );
  let ordinal = 0;
  const seeded: number[] = [];
  const report = await checkGrowth(db, {
    name: 'source fence governance HTTP',
    scales: [32, 256, 2048],
    bounds: { rows: 'constant', statements: 'constant', blocks: 'logarithmic' },
    grow: async (_db, scale, previous) => {
      seeded.push(scale);
      await seed(
        db,
        {
          name: 'source-fence-http',
          hotPartition: partition,
          hotShare: 1,
          rows: () => {
            let row;
            do {
              row = home(input(`http-distractor-${ordinal++}`));
            } while (partitionOf(row.route) !== partition);
            return { 'content.source_fences': [{ ...row, taken_down: true, security_revision: '1' }] };
          },
        },
        { from: previous, to: scale },
      );
    },
    operation: async () => {
      expect((await call(body)).response.status).toBe(200);
    },
  });
  expect(seeded).toEqual([32, 256, 2048]);
  expect(new Set(report.samples.map((sample) => sample.cost.rows)).size).toBe(1);
  expect(new Set(report.samples.map((sample) => sample.cost.statements)).size).toBe(1);
  expect(
    report.samples.every(
      (sample) => sample.cost.blocks > 0 && Object.hasOwn(sample.cost.relations ?? {}, 'content.source_fences'),
    ),
  ).toBe(true);
}, 90_000);
