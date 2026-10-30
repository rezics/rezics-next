import { suspendAccount, reinstateAccount } from '../support/native-suspension-driver.ts';
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { exportJWK, generateKeyPair } from 'jose';
import { Pool } from 'pg';
import { createAuthService } from '@rezics/auth';
import { createKernelClient } from '@rezics/client';
import { readAccount } from '../../src/access/account-data.ts';
import { createAccess } from '../../src/access/index.ts';
import { tupleRoute } from '../../src/content/imported-contract.ts';
import fenceRead from '../../src/content/read-source-fences.sql';
import permissionRead from '../../src/access/permission-check.sql';
import contextRead from '../../src/semantic/read-context.sql';
import { createKernel } from '../../src/http/kernel.ts';
import { isProblemSchema, openApiDocument } from '../../src/http/openapi.ts';
import { actionCatalogue, SESSION_HEADER } from '../../src/http/request.ts';
import { newId, partitionOf, routeOf } from '../../src/route/route.ts';
import { GLOBAL_CONTEXT } from '../../src/semantic/definitions.ts';
import { decodeSession } from '../../src/tokens/session.ts';
import { capture, checkGrowth, openGrowthDatabase, seed, type Population } from '../support/growth.ts';
import { observeSql, permissionResourceId } from './support/sql-observer.ts';
import { trustedAccessPorts } from '../support/trusted-access.ts';
import { dropTestDatabase } from '../support/drop-test-database.ts';

const action = 'source_fence:read';
const routeKey = new Uint8Array(32).fill(7);
const tokens = { current: 1, keys: new Map([[1, new Uint8Array(32).fill(8)]]) };
const query = { source: 'catalogue', externalId: 'preflight-record', fieldGroup: 'summary' as const };
const route = tupleRoute(routeKey, query.source, query.externalId);
const partition = partitionOf(route);
let db: Awaited<ReturnType<typeof openGrowthDatabase>>;
let observer: ReturnType<typeof observeSql>;
let app: ReturnType<typeof createKernel>;
let authPool: Pool;
let bulk: string;
let renewBulk: () => Promise<void>;
let governance: string;
let noScope: string;
let ordinary: string;
const bulkId = newId(0x1234);
const governanceId = newId(0x2345);
const ordinaryId = newId(0x3456);
const authDatabase = `source_fence_auth_${process.pid}`;

// Genuine Auth issuance and the mounted production Access factory. Only privileged
// fixture setup writes Access rows; no evaluator or authorization result is replaced.
beforeAll(async () => {
  db = await openGrowthDatabase();
  db.pool.options.max = 1;
  observer = observeSql(db.pool);
  const authUrl = new URL(db.url);
  authUrl.pathname = `/${authDatabase}`;
  await db.admin.query(`CREATE DATABASE ${authDatabase}`);
  const { migrate } = await import(new URL('../../../auth/scripts/database.ts', import.meta.url).href);
  migrate(authUrl.toString());
  authPool = new Pool({ connectionString: authUrl.toString() });
  const signing = {
    ...(await exportJWK((await generateKeyPair('ES256', { extractable: true })).privateKey)),
    kid: 'source-fence-http',
    alg: 'ES256',
  };
  const issuer = 'https://auth.example.test';
  const password = 'correct horse battery staple';
  const approvals = new Set([bulkId, governanceId, ordinaryId]);
  const auth = await createAuthService({
    database: authPool,
    issuer,
    audience: 'https://api.rezics.test',
    secret: 'source-fence-test-only-secret-at-least-32-bytes',
    signing: { activeKid: signing.kid, privateKeys: [signing] },
    trustedAccess: trustedAccessPorts({
      async readAccount(id) {
        const account = await readAccount(db.admin, routeOf(id)!, id);
        return (
          account && {
            accountId: id,
            kind: account.kind,
            state: account.state,
            authnEpoch: Number(account.minimumAuthnEpoch),
            automated: false,
          }
        );
      },
      async authorizeProvisioning(reference) {
        if (!approvals.delete(reference)) throw new Error('No fixture provisioning approval');
        return { accountId: reference };
      },
    }),
  });
  for (const clientId of ['bulk-import', 'governance'])
    await auth.internal.registerClient({ clientId, firstParty: true, scopes: [action] });
  for (const id of [bulkId, governanceId, ordinaryId]) {
    await db.admin.query(
      `INSERT INTO access.account(route,account_id,kind,state,transaction_id)
      VALUES ($1,$2,'actor','pending',$2)`,
      [routeOf(id), id],
    );
    await auth.internal.provisionPassword({ authorization: id, email: `${id}@example.test`, password });
    await db.admin.query("UPDATE access.account SET state='active' WHERE route=$1 AND account_id=$2", [
      routeOf(id),
      id,
    ]);
  }
  async function issue(id: string, client_id: string, scope = [action]) {
    const signed = await auth.handler(
      new Request(`${issuer}/signin`, {
        method: 'POST',
        headers: { origin: issuer, 'content-type': 'application/json' },
        body: JSON.stringify({ email: `${id}@example.test`, password, client_id, scope }),
      }),
    );
    expect(signed.status).toBe(200);
    const cookie = signed.headers
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
    expect(issued.status).toBe(200);
    return ((await issued.json()) as { access_token: string }).access_token;
  }
  renewBulk = async () => {
    bulk = await issue(bulkId, 'bulk-import');
    noScope = await issue(bulkId, 'bulk-import', []);
  };
  bulk = await issue(bulkId, 'bulk-import');
  governance = await issue(governanceId, 'governance');
  noScope = await issue(bulkId, 'bulk-import', []);
  ordinary = await issue(ordinaryId, 'bulk-import');
  app = createKernel({
    pool: db.pool,
    routeKey,
    tokens,
    access: (config) =>
      createAccess({
        ...config,
        auth: {
          issuer,
          audience: 'https://api.rezics.test',
          jwksUrl: `${issuer}/.well-known/jwks.json`,
          fetch: (url, init) => auth.handler(new Request(url, init)),
        },
      }),
  });
  await grant(bulkId);
  await grant(governanceId);
  await db.admin.query(`INSERT INTO content.source_fences VALUES ($1,$2,$3,$4,true,9007199254740993)`, [
    route,
    query.source,
    query.externalId,
    query.fieldGroup,
  ]);
});

afterAll(async () => {
  await observer?.close();
  await authPool?.end();
  if (db) {
    await dropTestDatabase(db.admin, authDatabase);
    await db.close();
  }
});

async function grant(id: string, resource = { route: 0, id: GLOBAL_CONTEXT }, valid = '(,)') {
  await db.admin.query(
    `INSERT INTO access.resource_grant
    (route,resource_id,subject_id,action,valid,transaction_id) VALUES ($1,$2,$3,$4,$5,$3)
    ON CONFLICT DO NOTHING`,
    [resource.route, resource.id, id, action, valid],
  );
}
const revoke = () =>
  db.admin.query('DELETE FROM access.resource_grant WHERE route=0 AND resource_id=$1 AND subject_id=$2 AND action=$3', [
    GLOBAL_CONTEXT,
    bulkId,
    action,
  ]);
async function call(
  bearer: string | null = bulk,
  fields: Record<string, string> = query,
  path = '/v1/sourceFences:check',
) {
  const response = await app.handle(
    new Request(`http://kernel.test${path}?${new URLSearchParams(fields)}`, {
      headers: bearer === null ? {} : { authorization: `Bearer ${bearer}` },
    }),
  );
  return { response, body: await response.json() };
}
function refused(result: Awaited<ReturnType<typeof call>>, status: number) {
  expect(result.response.status).toBe(status);
  expect(result.response.headers.get('content-type')).toBe('application/problem+json');
  expect(result.response.headers.get(SESSION_HEADER)).toBeNull();
  expect(result.body).toMatchObject({ status, effect_status: 'not_applicable', retryable: false });
  expect(result.body).not.toHaveProperty('fenced');
  expect(result.body).not.toHaveProperty('securityRevision');
  expect(JSON.stringify(result.body)).not.toContain('9007199254740993');
}

test('actual generated sourceFences custom check route requires protected read grant on sole Global root', async () => {
  for (const bearer of [bulk, governance]) {
    const start = observer.records.length;
    const result = await call(bearer);
    expect(result.response.status).toBe(200);
    expect(result.body).toEqual({ fenced: true, securityRevision: '9007199254740993' });
    expect(result.response.headers.get('cache-control')).toBe('private, no-store');
    const id = bearer === bulk ? bulkId : governanceId;
    expect(decodeSession(tokens, `account:${id}`, result.response.headers.get(SESSION_HEADER)!)).toEqual(
      expect.arrayContaining([expect.objectContaining({ partition })]),
    );
    const rows = observer.records.slice(start);
    const checks = rows.filter((row) => row.statement === permissionRead.sql);
    expect(checks.length).toBeGreaterThanOrEqual(2);
    for (const check of checks) {
      const parameters = Object.fromEntries(permissionRead.params.map((key, index) => [key, check.parameters[index]]));
      expect({ ...parameters, resource_ids: [permissionResourceId(check, permissionRead.params)] }).toMatchObject({
        route: 0,
        resource_ids: [GLOBAL_CONTEXT],
        action,
        floor: false,
        anonymous: false,
      });
      expect(parameters.at).toEqual(expect.any(String));
    }
    const tupleIndex = rows.findIndex((row) => row.statement === fenceRead.sql);
    expect(tupleIndex).toBeGreaterThan(rows.findIndex((row) => row.statement === permissionRead.sql));
    expect(rows.slice(0, tupleIndex).some((row) => row.statement === 'COMMIT')).toBe(true);
    const begin = rows.slice(0, tupleIndex).findLastIndex((row) => row.statement.startsWith('BEGIN'));
    expect(
      rows
        .slice(begin, tupleIndex)
        .some((row) => row.statement === contextRead.sql || row.statement === permissionRead.sql),
    ).toBe(false);
    const fenceReads = rows.filter((row) => row.statement === fenceRead.sql);
    expect(fenceReads.map((row) => row.parameters[0])).toEqual([partition]);
    expect(fenceReads.map((row) => JSON.parse(row.parameters[1] as string))).toEqual([
      [{ route, source: query.source, external_id: query.externalId, field_group: query.fieldGroup }],
    ]);
    expect(rows.some((row) => /INSERT|UPDATE|core\.receipt|core\.outbox|write_rate/.test(row.statement))).toBe(false);
  }
  refused(await call(noScope), 403);
  refused(await call(ordinary), 403);
  // A grant on a different global-like Context must not authorize this root.
  await grant(ordinaryId, { route: 0x4567, id: newId(0x4567) });
  refused(await call(ordinary), 403);
});

test('unknown tuple is open with opaque string or null security revision', async () => {
  for (const fieldGroup of ['facts', 'cover'])
    expect((await call(bulk, { ...query, fieldGroup })).body).toEqual({ fenced: false, securityRevision: null });
  expect((await call(bulk, { ...query, externalId: 'unknown' })).body).toEqual({
    fenced: false,
    securityRevision: null,
  });
  // Subject history in a different partition cannot move or clear the source tuple.
  const subject = newId(0x6789);
  await db.admin.query(`INSERT INTO semantic.subject VALUES ($1,$2,'schema:Book',$3)`, [
    routeOf(subject),
    subject,
    randomUUID(),
  ]);
  await db.admin.query(`INSERT INTO semantic.revision VALUES ($1,$2,1,'merge',$3,$4)`, [
    routeOf(subject),
    subject,
    `sha256:${'a'.repeat(64)}`,
    randomUUID(),
  ]);
  expect((await call()).body).toEqual({ fenced: true, securityRevision: '9007199254740993' });
  refused(await call(bulk, {}, `/v1/threads/${newId(0x789a)}`), 404);
});

test('anonymous and revoked callers receive no fence facts', async () => {
  for (const bearer of [null, 'invalid.jwt.token']) {
    const start = observer.records.length;
    refused(await call(bearer), 401);
    expect(observer.records.slice(start).some((row) => row.statement === fenceRead.sql)).toBe(false);
  }
  await revoke();
  try {
    refused(await call(), 403);
  } finally {
    await grant(bulkId);
  }
  await suspendAccount(db.admin, bulkId);
  try {
    refused(await call(), 401);
  } finally {
    await reinstateAccount(db.admin, bulkId);
    await renewBulk();
  }
  for (const reason of ['resource', 'suspension', 'realm_ban']) {
    await db.admin.query(
      `INSERT INTO access.resource_denial
      (route,resource_id,subject_id,action,reason,valid,transaction_id) VALUES (0,$1,$2,$3,$4,'(,)',$2)`,
      [GLOBAL_CONTEXT, bulkId, action, reason],
    );
    try {
      refused(await call(), 403);
    } finally {
      await db.admin.query(
        'DELETE FROM access.resource_denial WHERE route=0 AND resource_id=$1 AND subject_id=$2 AND action=$3',
        [GLOBAL_CONTEXT, bulkId, action],
      );
    }
  }
});

test('final current authorization rejects revocation after exact tuple read', async () => {
  const barrier = observer.hold({ statement: fenceRead.sql }, 'after');
  const pending = call();
  try {
    await barrier.entered;
    await revoke();
  } finally {
    barrier.release();
  }
  try {
    refused(await pending, 403);
  } finally {
    await grant(bulkId);
  }
});

test('bounded closed tuple query and literal custom transport reject enumeration and internal aliases', async () => {
  for (const fields of [
    { ...query, source: '' },
    { ...query, source: 'Upper' },
    { ...query, source: 'x'.repeat(33) },
    { ...query, externalId: '' },
    { ...query, externalId: 'x'.repeat(1025) },
    { ...query, externalId: 'é'.repeat(513) },
    { ...query, externalId: 'a\nb' },
    { ...query, fieldGroup: 'all' },
    { ...query, subject: newId(0) },
    {},
  ])
    refused(await call(bulk, fields), 400);
  for (const path of ['/v1/sourceFences/$check', '/v1/sourceFences', '/v1/sourceFences:check/extra'])
    refused(await call(bulk, query, path), 404);
});

test('AIP OpenAPI and generated client expose one protected read without write-family cost', async () => {
  const document = openApiDocument(app);
  const operation = document.paths['/v1/sourceFences:check']!.get!;
  expect(operation).toMatchObject({
    operationId: 'source_fence.read',
    'x-action': action,
    security: [{ bearerAuth: [] }],
  });
  expect(operation).not.toHaveProperty('x-rate-limit');
  expect(document.paths).not.toHaveProperty('/v1/sourceFences/$check');
  expect(actionCatalogue(app).get(action)).toEqual({ anonymous: false });
  expect(app.routes.filter((row) => row.path === '/v1/sourceFences/$check' && row.method === 'GET')).toHaveLength(1);
  for (const status of [400, 401, 403, 500, 503])
    expect(
      isProblemSchema(
        operation.responses![status]?.content?.['application/problem+json']?.schema,
        document.components.schemas,
      ),
    ).toBe(true);
  let seen: URL | undefined;
  const client = createKernelClient('http://kernel.test', {
    headers: { authorization: `Bearer ${bulk}` },
    fetch: (async (input, init) => {
      seen = new URL(input instanceof Request ? input.url : String(input));
      return app.handle(new Request(input, init));
    }) as typeof fetch,
  });
  const result = await client.sourceFences.$check.get({ query });
  expect(result.status).toBe(200);
  expect(result.data).toEqual({ fenced: true, securityRevision: '9007199254740993' });
  expect(seen!.pathname).toBe('/v1/sourceFences:check');
  expect(Object.fromEntries(seen!.searchParams)).toEqual(query);
});

test('checkGrowth keeps actual HTTP authorization and exact tuple cost bounded amid same-source partition rows', async () => {
  let ordinal = 0;
  const population: Population = {
    name: 'source-fence-http',
    hotPartition: partition,
    hotShare: 1,
    rows: () => {
      let external_id: string;
      let home: number;
      do {
        external_id = `distractor-${ordinal++}`;
        home = tupleRoute(routeKey, query.source, external_id);
      } while (partitionOf(home) !== partition);
      return {
        'content.source_fences': ['facts', 'summary', 'cover'].map((field_group) => ({
          route: home,
          source: query.source,
          external_id,
          field_group,
          taken_down: true,
          security_revision: '1',
        })),
      };
    },
  };
  const report = await checkGrowth(db, {
    name: 'protected source fence preflight',
    scales: [32, 256, 2048],
    bounds: { rows: 'constant', statements: 'constant', blocks: 'logarithmic' },
    grow: (_db, scale, previous) => seed(db, population, { from: previous, to: scale }),
    operation: async () => {
      const result = await call();
      expect(result.response.status).toBe(200);
      expect(result.body).toEqual({ fenced: true, securityRevision: '9007199254740993' });
    },
  });
  expect(report.samples.map((sample) => sample.scale)).toEqual([32, 256, 2048]);
  expect(new Set(report.samples.map((sample) => sample.cost.statements)).size).toBe(1);
  expect(new Set(report.samples.map((sample) => sample.cost.rows)).size).toBe(1);
  const measured = await capture(db, () => call());
  expect(measured.capture.statements.filter((statement) => statement === fenceRead.sql)).toHaveLength(1);
}, 90_000);
