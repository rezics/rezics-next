import { createHash, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { createAuthService } from '@rezics/auth';
import { exportJWK, generateKeyPair } from 'jose';
import { Pool } from 'pg';
import { migrate as migrateAuth } from '../../../auth/scripts/database.ts';
import { readAccount } from '../../src/access/account-data.ts';
import { createAccess } from '../../src/access/index.ts';
import { createWriteRateLimiter } from '../../src/access/write-rate.ts';
import { createPool } from '../../src/database/pool.ts';
import { createKernel } from '../../src/http/kernel.ts';
import { actionCatalogue, IDEMPOTENCY_HEADER } from '../../src/http/request.ts';
import { newId, routeOf } from '../../src/route/route.ts';
import { GLOBAL_CONTEXT } from '../../src/semantic/definitions.ts';
import { checkGrowth, openGrowthDatabase, seed, type GrowthDatabase, type Population } from '../support/growth.ts';

const issuer = 'https://growth-space-address.auth.test';
const audience = 'https://growth-space-address.api.test';
const routeKey = new Uint8Array(32).fill(93);
const tokens = { current: 1, keys: new Map([[1, new Uint8Array(32).fill(94)]]) };
const password = 'growth space address test password with enough entropy';
const scales: [number, number, number] = [2048, 8192, 32768];

type ProbeSpace = { spaceId: string; etag: string; address?: string };
type Person = { accountId: string; bearer: string };

let db: GrowthDatabase;
let auth: Awaited<ReturnType<typeof createAuthService>>;
let authPool: Pool;
let authDatabase = '';
let kernel: ReturnType<typeof createKernel>;
let actor: Person;

function hashRoute(value: string) {
  return createHash('sha256').update(value).digest().readUInt16BE(0);
}

async function issue(email: string, scopes: string[]) {
  const signin = await auth.handler(
    new Request(`${issuer}/signin`, {
      method: 'POST',
      headers: { origin: issuer, 'content-type': 'application/json' },
      body: JSON.stringify({ email, password, client_id: 'growth-space-address-test', scope: scopes }),
    }),
  );
  expect(signin.status).toBe(200);
  const cookie = signin.headers
    .getSetCookie()
    .map((value) => value.split(';')[0])
    .join('; ');
  const response = await auth.handler(
    new Request(`${issuer}/token`, {
      method: 'POST',
      headers: { origin: issuer, 'content-type': 'application/json', cookie },
      body: '{}',
    }),
  );
  expect(response.status).toBe(200);
  return ((await response.json()) as { access_token: string }).access_token;
}

async function call(
  method: string,
  path: string,
  options: { bearer?: string; body?: unknown; key?: string; etag?: string } = {},
) {
  const headers = new Headers();
  if (options.bearer) headers.set('authorization', `Bearer ${options.bearer}`);
  if (options.body !== undefined) headers.set('content-type', 'application/json');
  if (options.key !== undefined) headers.set(IDEMPOTENCY_HEADER, JSON.stringify(options.key));
  if (options.etag !== undefined) headers.set('if-match', options.etag);
  const response = await kernel.handle(
    new Request(`http://kernel.test${path}`, {
      method,
      headers,
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
    }),
  );
  const text = await response.text();
  return { response, value: text ? (JSON.parse(text) as Record<string, unknown>) : {} };
}

async function createProbe(address?: string): Promise<ProbeSpace> {
  const created = await call('POST', '/v1/spaces', {
    bearer: actor.bearer,
    key: randomUUID(),
    body: { title: 'Growth probe', summary: '' },
  });
  expect(created.response.status).toBe(201);
  const space = created.value.space as Record<string, unknown>;
  const probe = { spaceId: String(space.spaceId), etag: created.response.headers.get('etag')! };
  if (address === undefined) return probe;
  const claim = await call('PUT', `/v1/spaces/${probe.spaceId}/address`, {
    bearer: actor.bearer,
    key: randomUUID(),
    etag: probe.etag,
    body: { address },
  });
  expect(claim.response.status).toBe(200);
  return { ...probe, etag: claim.response.headers.get('etag')!, address };
}

function population(name: string): Population {
  return {
    name,
    hotPartition: 173,
    hotShare: 1,
    rows: ({ route, ordinal }) => {
      const spaceId = newId(route);
      const revisionId = newId(route);
      const address = `population-${ordinal.toString(36)}`;
      const handle = `population-handle-${ordinal.toString(36)}`;
      const at = '2026-10-25T00:00:00.000Z';
      const transactionId = spaceId;
      return {
        'community.space': [
          {
            route,
            space_id: spaceId,
            state: 'active',
            head_revision_id: revisionId,
            created_at: at,
            creator: actor.accountId,
          },
        ],
        'community.space_revision': [
          {
            route,
            space_id: spaceId,
            revision_id: revisionId,
            predecessor: null,
            address,
            title: 'Growth neighbour',
            summary: '',
            created_at: at,
            author: actor.accountId,
          },
        ],
        'community.space_address_claim': [
          {
            route: hashRoute(address),
            normalized_address: address,
            space_id: spaceId,
            state: 'active',
            expires_at: null,
            reserved_until: null,
            transaction_id: transactionId,
          },
        ],
        'access.handle_claim': [
          {
            route: hashRoute(handle),
            normalized_handle: handle,
            account_id: actor.accountId,
            state: 'active',
            expires_at: null,
            reserved_until: null,
            transaction_id: transactionId,
          },
        ],
      };
    },
  };
}

beforeAll(async () => {
  db = await openGrowthDatabase();
  db.pool.options.max = 1;
  const url = new URL(db.url);
  const admin = db.admin;
  authDatabase = `growth_space_address_auth_${process.pid}`;
  await admin.query(`CREATE DATABASE ${authDatabase}`);
  url.pathname = `/${authDatabase}`;
  migrateAuth(url.href);
  authPool = new Pool({ connectionString: url.href });
  const signingKey = {
    ...(await exportJWK((await generateKeyPair('ES256', { extractable: true })).privateKey)),
    kid: 'growth-space-address',
  };
  const accountId = newId(0x3300);
  auth = await createAuthService({
    database: authPool,
    issuer,
    audience,
    secret: 'growth-space-address-auth-secret-with-at-least-32-bytes',
    signing: { activeKid: signingKey.kid, privateKeys: [signingKey] },
    trustedAccess: {
      async readAccount(id) {
        const row = await readAccount(admin, routeOf(id)!, id);
        return (
          row && {
            accountId: row.accountId,
            kind: row.kind,
            state: row.state,
            authnEpoch: Number(row.minimumAuthnEpoch),
            automated: false,
          }
        );
      },
      async authorizeProvisioning(reference) {
        if (reference !== accountId) throw new Error('Unknown fixture provisioning reference');
        return { accountId: reference };
      },
    },
  });
  await admin.query(
    "INSERT INTO access.account (route, account_id, kind, state, transaction_id) VALUES ($1,$2,'actor','pending',$2)",
    [routeOf(accountId), accountId],
  );
  await auth.internal.provisionPassword({ authorization: accountId, email: 'growth@space-address.test', password });
  await admin.query("UPDATE access.account SET state='active' WHERE route=$1 AND account_id=$2", [
    routeOf(accountId),
    accountId,
  ]);
  const writeRate = createWriteRateLimiter({
    secret: 'growth-space-address-private-write-rate-secret',
    overrides: JSON.stringify({
      anonymous: { write: { maximum: 100_000, seconds: 86_400 } },
      'new-account': { write: { maximum: 100_000, seconds: 86_400 } },
    }),
  });
  kernel = createKernel({
    pool: db.pool,
    routeKey,
    tokens,
    writeRate,
    access: (config) =>
      createAccess({
        ...config,
        auth: {
          issuer,
          audience,
          jwksUrl: `${issuer}/.well-known/jwks.json`,
          fetch: async (url, init) => auth.handler(new Request(url, init)),
        },
      }),
  });
  const scopes = [...actionCatalogue(kernel).keys()].filter((scope) => scope !== 'media:complete');
  await auth.internal.registerClient({ clientId: 'growth-space-address-test', firstParty: true, scopes });
  actor = { accountId, bearer: await issue('growth@space-address.test', scopes) };
  await admin.query(
    `INSERT INTO access.resource_grant
      (route, resource_id, subject_id, action, valid, transaction_id)
     VALUES (0,$1,$2,'space:create','(,)'::tstzrange,$2)`,
    [GLOBAL_CONTEXT, accountId],
  );
}, 60_000);

afterAll(async () => {
  if (authDatabase) await db?.admin.query(`DROP DATABASE IF EXISTS ${authDatabase} WITH (FORCE)`);
  await authPool?.end();
  await db?.close();
});

test('address claim, change and resolve stay bounded as addresses, Spaces and handles grow', async () => {
  const probes = new Map<number, { claim: ProbeSpace; change: ProbeSpace; resolve: ProbeSpace }>();
  for (const scale of scales) {
    probes.set(scale, {
      claim: await createProbe(),
      change: await createProbe(`change-start-${scale}`),
      resolve: await createProbe(`resolve-start-${scale}`),
    });
  }
  const data = population(`space-address-growth-${randomUUID()}`);
  const report = await checkGrowth(db, {
    name: 'community space address claim change resolve',
    scales,
    repetitions: 1,
    warmups: 0,
    bounds: { rows: 'constant', blocks: 'logarithmic', statements: 'constant' },
    async grow(database, scale, previous) {
      await seed({ pool: database.pool, admin: database.admin }, data, { from: previous, to: scale });
    },
    async operation(_database, scale) {
      const probe = probes.get(scale)!;
      const claimAddress = `claim-${scale}-${randomUUID().replaceAll('-', '').slice(0, 12)}`;
      const claimed = await call('PUT', `/v1/spaces/${probe.claim.spaceId}/address`, {
        bearer: actor.bearer,
        key: randomUUID(),
        etag: probe.claim.etag,
        body: { address: claimAddress },
      });
      expect(claimed.response.status).toBe(200);

      const changedAddress = `change-${scale}-${randomUUID().replaceAll('-', '').slice(0, 12)}`;
      const changed = await call('PUT', `/v1/spaces/${probe.change.spaceId}/address`, {
        bearer: actor.bearer,
        key: randomUUID(),
        etag: probe.change.etag,
        body: { address: changedAddress },
      });
      expect(changed.response.status).toBe(200);

      const resolved = await call('GET', `/v1/spaceAddresses/${probe.resolve.address}`);
      expect(resolved.response.status).toBe(200);
      expect(resolved.value).toEqual({ spaceId: probe.resolve.spaceId });
    },
  });
  expect(report.samples.map((sample) => sample.scale)).toEqual(scales);
  for (const sample of report.samples) {
    for (const relation of [
      'community.space_address_claim',
      'community.space',
      'community.space_revision',
      'access.handle_claim',
    ]) {
      expect(sample.cost.relations[relation]?.sequentialScans ?? 0).toBe(0);
    }
  }
  expect(new Set(report.samples.map((sample) => sample.cost.statements)).size).toBe(1);
});
