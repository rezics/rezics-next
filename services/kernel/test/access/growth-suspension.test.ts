import { afterAll, beforeAll, expect, test } from 'bun:test';
import { Pool } from 'pg';
import {
  createAuthHost,
  createProvisioningEvidenceVerifier,
  createNativeWorkflowProofPorts,
  type AuthService,
} from '@rezics/auth';
import { exportJWK, generateKeyPair } from 'jose';
import { testDatabase } from '../../../auth/scripts/database.ts';
import { createAccess } from '../../src/access/index.ts';
import { createLifecycleInternals } from '../../src/access/lifecycle.ts';
import { createAuthBindings } from '../../src/access/auth-bindings.ts';
import { createRegistrationProofBindings } from '../../src/access/registration-proof.ts';
import { createWriteRateLimiter } from '../../src/access/write-rate.ts';
import { newId, routeOf } from '../../src/route/route.ts';
import { capture, checkGrowth, openGrowthDatabase } from '../support/growth.ts';
import { createKernel } from '../../src/http/kernel.ts';
import { actionCatalogue } from '../../src/http/request.ts';

const issuer = 'https://suspension-growth.auth.test';
const audience = 'https://suspension-growth.api.test';
const password = 'native grant routes registration password';
const routeKey = new Uint8Array(32).fill(71);
const tokens = { current: 1, keys: new Map([[1, new Uint8Array(32).fill(72)]]) };
const accountsPerScale = 500;
const seedConcurrency = 8;
// Every batch performs handle reservation and pending-account creation through
// native commands. Budget 500 ms per batch under concurrent workspace gates,
// plus the mounted requests in three warm-ups, captures and the final proof.
const growthTimeout = Math.ceil((64 * accountsPerScale) / seedConcurrency) * 500 + 7 * 5 * 3_000;
let db: Awaited<ReturnType<typeof openGrowthDatabase>>;
let authDatabase: ReturnType<typeof testDatabase>;
let authPool: Pool;
let host: Awaited<ReturnType<typeof createAuthHost>>;
let service: AuthService;
let access: ReturnType<typeof createAccess>;
let kernel: ReturnType<typeof createKernel>;
let signingKey: Awaited<ReturnType<typeof exportJWK>> & { kid: string };
let root: { accountId: string; bearer: string };
let grantor: typeof root;
let recipient: typeof root;
let scopes: string[];
let now = Date.now();
const positives: { accountId: string; bearer: string }[] = [];
let replayKey: string;
let lifecycle: ReturnType<typeof createLifecycleInternals>;
let seedPool: Pool;
let seedLifecycle: ReturnType<typeof createLifecycleInternals>;

async function issue(email: string, scope = scopes) {
  const signed = await service.handler(
    new Request(`${issuer}/signin`, {
      method: 'POST',
      headers: { origin: issuer, 'content-type': 'application/json' },
      body: JSON.stringify({ email, password, client_id: 'suspension-growth-client', scope }),
    }),
  );
  expect(signed.status).toBe(200);
  const cookie = signed.headers
    .getSetCookie()
    .map((value) => value.split(';')[0])
    .join('; ');
  const response = await service.handler(
    new Request(`${issuer}/token`, {
      method: 'POST',
      headers: { origin: issuer, 'content-type': 'application/json', cookie },
      body: '{}',
    }),
  );
  expect(response.status).toBe(200);
  return ((await response.json()) as { access_token: string }).access_token;
}
async function person(name: string) {
  const result = await host.workflows.register({
    key: name,
    handle: name,
    email: `${name}@suspension-growth.test`,
    password,
  });
  return { accountId: result.accountId, bearer: await issue(`${name}@suspension-growth.test`) };
}
async function call(
  bearer: string,
  path: string,
  body: unknown,
  key = Bun.randomUUIDv7(),
  extra: Record<string, string> = {},
) {
  now = Date.now();
  const response = await kernel.handle(
    new Request(`http://kernel.test${path}`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${bearer}`,
        'content-type': 'application/json',
        'idempotency-key': JSON.stringify(key),
        ...extra,
      },
      body: JSON.stringify(body),
    }),
  );
  return { response, value: await response.json() };
}
beforeAll(async () => {
  db = await openGrowthDatabase();
  db.pool.options.max = 1;
  seedPool = new Pool({ connectionString: db.url, max: 8 });
  seedLifecycle = createLifecycleInternals({
    pool: seedPool,
    routeKey,
    provisioningEvidence: async () => null,
    recoveryEvidence: async () => null,
  });
  const limiter = createWriteRateLimiter({
    secret: 'suspension-growth-private-write-rate-secret-32bytes',
    overrides: JSON.stringify({ 'new-account': { write: { maximum: 100000, seconds: 86400 } } }),
  });
  kernel = createKernel({
    pool: db.pool,
    routeKey,
    tokens,
    clock: () => new Date(now),
    access: (config) => {
      expect([...config.actions]).toEqual([...actionCatalogue(kernel)]);
      return access;
    },
    writeRate: {
      async spend(...args) {
        return limiter.spend(...args);
      },
    },
  });
  const actions = actionCatalogue(kernel);
  scopes = [...actions.keys()].filter((action) => action !== 'media:complete');
  authDatabase = testDatabase();
  authPool = new Pool({ connectionString: authDatabase.url });
  signingKey = {
    ...(await exportJWK((await generateKeyPair('ES256', { extractable: true })).privateKey)),
    kid: 'suspension-growth',
  };
  access = createAccess({
    actions,
    auth: {
      issuer,
      audience,
      jwksUrl: `${issuer}/.well-known/jwks.json`,
      fetch: async () => service.handler(new Request(`${issuer}/.well-known/jwks.json`)),
    },
  });
  const proofs = createNativeWorkflowProofPorts({ database: authPool });
  // Compose the existing native human registration ports directly. The full
  // account binding also requires unmounted operator-management routes, which
  // belong to a separate module. No action is added to the mounted catalogue.
  const registration = createRegistrationProofBindings({ pool: db.pool, referenceKeys: tokens });
  const provisioning = createProvisioningEvidenceVerifier({ database: authPool });
  const internal = createLifecycleInternals({
    pool: db.pool,
    routeKey,
    provisioningEvidence: (evidence) => provisioning.resolve(evidence),
    recoveryEvidence: async () => null,
  });
  lifecycle = internal;
  const registrationPorts = {
    ...internal,
    async createPending(input: Parameters<typeof internal.createPending>[0]) {
      const outcome = await internal.createPending(input);
      const pair = { accountId: input.accountId, reservationId: input.reservationId };
      if (!(await proofs.pendingReference(pair))) {
        const reference = await registration.createProvisioningReference({ input, outcome });
        if (!reference) throw new Error('Missing native registration reference');
        await proofs.recordPending({ ...pair, reference });
      }
      return outcome;
    },
    async provisioningReference(input: { accountId: string; reservationId: string }) {
      const reference = await proofs.pendingReference(input);
      if (!reference) throw new Error('Missing persisted registration reference');
      return reference;
    },
    provisioningEvidence: (input: { accountId: string; reservationId: string }) => proofs.provisioningEvidence(input),
  };
  host = await createAuthHost({
    database: authPool,
    systemDatabasePool: authPool,
    issuer,
    audience,
    secret: 'suspension-growth-auth-persistent-secret-32bytes',
    signing: { activeKid: signingKey.kid, privateKeys: [signingKey] },
    trustedAccess: createAuthBindings({
      pool: db.pool,
      ...registration,
      verifyPendingIdentity: registration.verifyNativePendingIdentity,
    }),
    access: registrationPorts,
    stagingKey: new Uint8Array(32).fill(73),
    maintenanceSchedule: '0 0 1 1 *',
    executorId: 'suspension-growth-executor',
  });
  service = host.service;
  await service.internal.registerClient({ clientId: 'suspension-growth-client', firstParty: true, scopes });
  await host.start();
  root = await person('grant_root');
  grantor = await person('grant_grantor');
  recipient = await person('grant_recipient');
  const bootstrap = Bun.spawn(['bun', 'scripts/bootstrap-governance.ts', '--account', root.accountId], {
    env: { ...process.env, DATABASE_URL: db.url },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  expect(await bootstrap.exited).toBe(0);
  for (let i = 0; i < 7; i++) positives.push(await person(`positive_${i}`));
  await lifecycle.reserveCoordination({
    accountId: grantor.accountId,
    relatedAccountId: newId(0x7311),
    purpose: 'operator',
    key: Bun.randomUUIDv7(),
  });
  replayKey = Bun.randomUUIDv7();
  expect((await call(root.bearer, `/v1/accounts/${recipient.accountId}:suspend`, {}, replayKey)).response.status).toBe(
    200,
  );
}, 60000);
afterAll(async () => {
  await host?.stop();
  authDatabase?.close();
  await seedPool?.end();
  await db?.close();
});

test(
  'mounted suspension keeps full native formula, stage and counter cost bounded at 1/8/64 x 500',
  async () => {
    let positive = positives[0]!;
    const exercise = async () => {
      expect(
        (await call(root.bearer, `/v1/accounts/${positive.accountId}:suspend`, {}, 'growth-positive')).response.status,
      ).toBe(200);
      expect(
        (await call(root.bearer, `/v1/accounts/${recipient.accountId}:suspend`, {}, replayKey)).response.status,
      ).toBe(200);
      expect((await call(root.bearer, `/v1/accounts/${recipient.accountId}:suspend`, {})).response.status).toBe(403);
      // Coordination does not block suspension. Its exact success replay stays
      // available; a fresh command against the now-suspended account is refused.
      expect(
        (await call(root.bearer, `/v1/accounts/${grantor.accountId}:suspend`, {}, 'growth-coordinated')).response
          .status,
      ).toBe(200);
      expect((await call(root.bearer, `/v1/accounts/${grantor.accountId}:suspend`, {})).response.status).toBe(403);
    };
    const report = await checkGrowth(db, {
      name: 'mounted native suspension',
      bounds: { rows: 'constant', statements: 'constant', blocks: 'logarithmic' },
      repetitions: 1,
      warmups: 1,
      async grow(database, scale, previous) {
        positive = positives[[1, 8, 64].indexOf(scale) * 2]!;
        // Unrelated account rows are produced by native pending registration;
        // no SQL fixture writes an account state, floor, fence or measured outcome.
        for (let start = previous * accountsPerScale; start < scale * accountsPerScale; start += seedConcurrency) {
          await Promise.all(
            Array.from({ length: Math.min(seedConcurrency, scale * accountsPerScale - start) }, async (_, offset) => {
              const i = start + offset;
              const accountId = newId((i * 17) % 65536);
              const handle = `noise_${i}`;
              const reserved = await seedLifecycle.reserveHandle({ accountId, handle, key: `noise-reserve-${i}` });
              await seedLifecycle.createPending({
                accountId,
                handle,
                reservationId: reserved.value.reservationId,
                key: `noise-create-${i}`,
              });
            }),
          );
        }
        const ids = Array.from({ length: (scale - previous) * accountsPerScale }, () =>
          newId(routeOf(grantor.accountId)!),
        );
        // Cardinality-only history and mixed-purpose holds are never used to
        // establish authority, a successful response, or a suspension state.
        await database.admin.query(
          `INSERT INTO access.lifecycle_coordination(route,account_id,reservation_id,related_account_id,purpose,transaction_id)
        SELECT $1,$2,id,id,CASE WHEN n%2=0 THEN 'membership' ELSE 'operator' END,$3
        FROM unnest($4::uuid[]) WITH ORDINALITY a(id,n)`,
          [routeOf(grantor.accountId), grantor.accountId, Bun.randomUUIDv7(), ids],
        );
        for (const subject of [recipient, ...positives]) {
          await database.admin.query(
            `INSERT INTO access.lifecycle_fence_receipt(route,account_id,receipt_id,minimum_authn_epoch,kind,transaction_id)
          SELECT $1,$2,id,1,'fence',$3 FROM unnest($4::uuid[]) id`,
            [routeOf(subject.accountId), subject.accountId, Bun.randomUUIDv7(), ids],
          );
          await database.admin.query(
            `INSERT INTO core.receipt(partition_no,principal_kind,principal_id,command_kind,idempotency_key,request_digest,epoch,position,transaction_id,response)
          SELECT $1,'account',$2,'access.authentication-fenced',id::text,$3,1,1,$4,'{}' FROM unnest($5::uuid[]) id`,
            [routeOf(subject.accountId)! >>> 4, root.accountId, Buffer.alloc(32), Bun.randomUUIDv7(), ids],
          );
        }
        now = Date.now();
        root.bearer = await issue('grant_root@suspension-growth.test');
        for (const table of [
          'access.account',
          'access.lifecycle_coordination',
          'access.lifecycle_fence_receipt',
          'core.receipt',
        ])
          await database.admin.query(`VACUUM (ANALYZE) ${table}`);
        // Native seeding can outlast the pool's idle lifetime. Warm the real
        // mounted path after seeding so per-connection SQL type discovery does
        // not enter only the largest sample. The positive mutation remains fresh.
        expect(
          (await call(root.bearer, `/v1/accounts/${grantor.accountId}:suspend`, {}, 'growth-coordinated')).response
            .status,
        ).toBe(200);
        expect(
          (await call(root.bearer, `/v1/accounts/${recipient.accountId}:suspend`, {}, replayKey)).response.status,
        ).toBe(200);
      },
      async warmup(_database, scale) {
        const measured = positive;
        positive = positives[[1, 8, 64].indexOf(scale) * 2 + 1]!;
        try {
          await exercise();
        } finally {
          positive = measured;
        }
      },
      operation: exercise,
    });
    positive = positives[6]!;
    const observed = await capture(db, exercise);
    for (const fragment of [
      'access.account',
      'access.lifecycle_coordination',
      'access.lifecycle_fence_receipt',
      'access.resource_role_grant',
      'access.write_rate_counter',
      'core.receipt',
      'core.outbox',
    ])
      expect(observed.capture.statements.some((sql) => sql.includes(fragment))).toBe(true);
    expect(report.samples.map(({ scale }) => scale)).toEqual([1, 8, 64]);
    expect(report.samples.every(({ cost }) => cost.rows > 0 && cost.blocks > 0)).toBe(true);
    console.info(report.name, report.samples);
  },
  growthTimeout,
);
