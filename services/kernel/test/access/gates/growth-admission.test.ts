import { afterAll, beforeAll, expect, spyOn, test } from 'bun:test';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import { checkGrowth, openGrowthDatabase, type GrowthDatabase, type GrowthReport } from '../../support/growth.ts';
import { actorFixture } from '../actor-side-fixture.ts';

await import('reylo/register');
const { createAccess } = await import('../../../src/access/index.ts');
const { newId, routeOf } = await import('../../../src/route/route.ts');
const { createKernel } = await import('../../../src/http/kernel.ts');
const appModule = await import('../../../src/http/app.ts');

const issuer = 'https://gate-growth.auth.test';
const audience = 'https://gate-growth.api.test';
const group = 'growth_fixture';
const groupAction = `gate:${group}`;
const fixtureAction = 'fixture:read';
const fixedTime = new Date('2026-01-15T12:00:00.000Z');
let db: GrowthDatabase;
let kernel: ReturnType<typeof createKernel>;
let actorId: string;
let transactionId: string;
let token: string;
let accountGrowthIds: string[];
let grantSubjectIds: string[];
const routeKey = new Uint8Array(32).fill(101);

function alpha(index: number): string {
  let value = index;
  let result = '';
  do {
    result = String.fromCharCode(97 + (value % 26)) + result;
    value = Math.floor(value / 26);
  } while (value > 0);
  return result;
}

function expectNoAccessScans(report: GrowthReport): void {
  for (const sample of report.samples) {
    for (const [relation, cost] of Object.entries(sample.cost.relations ?? {})) {
      if (relation.startsWith('access.')) expect(cost.sequentialScans, `${relation} at ${sample.scale}`).toBe(0);
    }
  }
}

beforeAll(async () => {
  db = await openGrowthDatabase();
  const fixture = await actorFixture(db.pool, db.admin);
  actorId = fixture.actorId;
  transactionId = fixture.transactionId;
  await db.admin.query(
    `INSERT INTO access.resource_grant (route, resource_id, subject_id, action, valid, transaction_id)
     VALUES ($1, $2, $3, $4, '(,)', $5)`,
    [0, '00000000-0000-8000-8000-000000000000', actorId, groupAction, transactionId],
  );

  const keys = await generateKeyPair('ES256');
  const jwks = { keys: [{ ...(await exportJWK(keys.publicKey)), kid: 'gate-growth', alg: 'ES256' }] };
  const now = Math.floor(Date.now() / 1000);
  token = await new SignJWT({
    iss: issuer,
    aud: audience,
    sub: actorId,
    client_id: 'gate-growth-client',
    scope: fixtureAction,
    authn_epoch: 1,
    iat: now,
    exp: now + 300,
    auth_time: now,
    amr: ['pwd'],
  })
    .setProtectedHeader({ alg: 'ES256', typ: 'at+jwt', kid: 'gate-growth' })
    .sign(keys.privateKey);

  const original = appModule.createApp;
  const composition = spyOn(appModule, 'createApp').mockImplementation((dependencies) => {
    const app = original(dependencies);
    app.get(
      '/v1/growth-fixture',
      {
        detail: {
          operationId: 'fixture.growth_read',
          'x-action': fixtureAction,
          'x-exposure': `gate:${group}`,
          security: [{ bearerAuth: [] }],
        },
      },
      () => ({ ok: true }),
    );
    return app;
  });
  kernel = createKernel({
    pool: db.pool,
    routeKey,
    clock: () => new Date(fixedTime),
    writeRate: { async spend() { return { allowed: true as const }; } },
    access: (config) =>
      createAccess({
        actions: new Map(config.actions),
        auth: {
          issuer,
          audience,
          jwksUrl: `${issuer}/jwks`,
          async fetch() {
            return Response.json(jwks);
          },
        },
      }),
  });
  composition.mockRestore();

  const route = routeOf(actorId);
  if (route === null) throw new Error('Fixture actor must have a route');
  accountGrowthIds = Array.from({ length: 64 }, () => newId(route));
  grantSubjectIds = Array.from({ length: 64 }, () => newId(route));
  const timestamp = Bun.randomUUIDv7();
  await db.admin.query(
    `INSERT INTO access.account (route, account_id, kind, state, transaction_id)
     SELECT $1, id, 'actor', 'active', $3 FROM unnest($2::uuid[]) id`,
    [route, grantSubjectIds, timestamp],
  );
  await db.admin.query('ANALYZE access.account');
}, 60_000);

afterAll(async () => {
  await db?.close();
});

async function fixedRequest(): Promise<void> {
  const response = await kernel.handle(
    new Request('http://kernel.test/v1/growth-fixture', {
      headers: { authorization: `Bearer ${token}` },
    }),
  );
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ ok: true });
}

test('checkGrowth keeps gate admission bounded as unrelated accounts, grants, and other openings grow separately', async () => {
  const route = routeOf(actorId);
  if (route === null) throw new Error('Fixture actor must have a route');

  const accounts = await checkGrowth(db, {
    name: 'Gate admission with unrelated account growth',
    bounds: { rows: 'constant', statements: 'constant', blocks: 'logarithmic' },
    repetitions: 1,
    warmups: 1,
    async grow(database, scale, previous) {
      const ids = accountGrowthIds.slice(previous, scale);
      await database.admin.query(
        `INSERT INTO access.account (route, account_id, kind, state, transaction_id)
         SELECT $1, id, 'actor', 'active', $3 FROM unnest($2::uuid[]) id`,
        [route, ids, Bun.randomUUIDv7()],
      );
      await database.admin.query('ANALYZE access.account');
    },
    operation: fixedRequest,
  });
  expectNoAccessScans(accounts);

  const grants = await checkGrowth(db, {
    name: 'Gate admission with unrelated gate grant growth',
    bounds: { rows: 'constant', statements: 'constant', blocks: 'logarithmic' },
    repetitions: 1,
    warmups: 1,
    async grow(database, scale, previous) {
      const ids = grantSubjectIds.slice(previous, scale);
      await database.admin.query(
        `INSERT INTO access.resource_grant
           (route, resource_id, subject_id, action, valid, transaction_id)
         SELECT 0, '00000000-0000-8000-8000-000000000000', id, 'gate:unrelated', '(,)', $2
         FROM unnest($1::uuid[]) id`,
        [ids, Bun.randomUUIDv7()],
      );
      await database.admin.query('ANALYZE access.resource_grant');
    },
    operation: fixedRequest,
  });
  expectNoAccessScans(grants);

  const openings = await checkGrowth(db, {
    name: 'Gate admission with other exposure opening growth',
    bounds: { rows: 'constant', statements: 'constant', blocks: 'logarithmic' },
    repetitions: 1,
    warmups: 1,
    async grow(database, scale, previous) {
      const rows = Array.from({ length: scale - previous }, (_, index) => ({
        name: `other_${alpha(previous + index)}`,
        transactionId: Bun.randomUUIDv7(),
      }));
      await database.admin.query(
        `INSERT INTO access.exposure_opening ("group", valid, transaction_id)
         SELECT group_name, tstzrange('2000-01-01T00:00:00Z'::timestamptz, NULL, '[)'), transaction_id
         FROM unnest($1::text[], $2::uuid[]) AS item(group_name, transaction_id)`,
        [rows.map(({ name }) => name), rows.map(({ transactionId: id }) => id)],
      );
      await database.admin.query('ANALYZE access.exposure_opening');
    },
    operation: fixedRequest,
  });
  expectNoAccessScans(openings);
});
