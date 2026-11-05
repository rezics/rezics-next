import { afterAll, beforeAll, expect, spyOn, test } from 'bun:test';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import { capture, checkGrowth, openGrowthDatabase, type GrowthDatabase } from '../../support/growth.ts';

await import('reylo/register');
const { actorFixture } = await import('../actor-side-fixture.ts');
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
const rowsPerScaleUnit = 500;
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

function expectIndex(plans: readonly unknown[], expected: string): void {
  let found = false;
  const used: string[] = [];
  const visit = (node: unknown): void => {
    if (typeof node !== 'object' || node === null) return;
    if (Array.isArray(node)) {
      for (const child of node) visit(child);
      return;
    }
    const plan = node as Record<string, unknown>;
    if (typeof plan['Index Name'] === 'string') {
      used.push(plan['Index Name']);
      if (plan['Index Name'].startsWith(expected)) found = true;
    }
    if (typeof plan.Plan === 'object' && plan.Plan !== null) visit(plan.Plan);
    if (Array.isArray(plan.Plans)) for (const child of plan.Plans) visit(child);
  };
  for (const plan of plans) visit(plan);
  expect(found, `plan should use ${expected}; observed indexes: ${used.join(', ')}`).toBe(true);
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
    const fixtureDetail = {
      operationId: 'fixture.growth_read',
      'x-action': fixtureAction,
      'x-exposure': `gate:${group}`,
      security: [{ bearerAuth: [] }],
    };
    app.get('/v1/growth-fixture', { detail: fixtureDetail }, () => ({ ok: true }));
    return app;
  });
  kernel = createKernel({
    pool: db.pool,
    routeKey,
    clock: () => new Date(fixedTime),
    writeRate: {
      async spend() {
        return { allowed: true as const };
      },
    },
    access: (config) =>
      createAccess({
        ...config,
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
  accountGrowthIds = Array.from({ length: 64 * rowsPerScaleUnit }, () => newId(route));
  grantSubjectIds = Array.from({ length: 64 * rowsPerScaleUnit }, () => newId(route));
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
  expect(response.status, response.status === 200 ? undefined : await response.clone().text()).toBe(200);
  expect(await response.json()).toEqual({ ok: true });
}

test('checkGrowth keeps gate admission bounded as unrelated accounts, grants, and other openings grow separately', async () => {
  // The mounted route catalogue is fixed-size. Account growth carries other accounts' memberships, while the
  // separate grant growth expands other subjects' ACLs; other exposure openings grow in their own check.
  const route = routeOf(actorId);
  if (route === null) throw new Error('Fixture actor must have a route');

  await checkGrowth(db, {
    name: 'Gate admission with unrelated account growth',
    bounds: { rows: 'constant', statements: 'constant', blocks: 'logarithmic' },
    repetitions: 1,
    warmups: 1,
    async grow(database, scale, previous) {
      const ids = accountGrowthIds.slice(previous * rowsPerScaleUnit, scale * rowsPerScaleUnit);
      await database.admin.query(
        `INSERT INTO access.account (route, account_id, kind, state, transaction_id)
         SELECT $1, id, 'actor', 'active', $3 FROM unnest($2::uuid[]) id`,
        [route, ids, Bun.randomUUIDv7()],
      );
      await database.admin.query(
        `INSERT INTO access.membership_inverse(route,account_id,kind,group_id,reservation_id,transaction_id)
         SELECT $1,id,'organization',id,id,id FROM unnest($2::uuid[]) id`,
        [route, ids],
      );
      await database.admin.query(
        `INSERT INTO access.organization_member(route,organization_id,member_account_id,role,valid,transaction_id)
         SELECT $1,id,id,'member','(,)',id FROM unnest($2::uuid[]) id`,
        [route, ids],
      );
      await database.admin.query('ANALYZE access.account');
      await database.admin.query('ANALYZE access.membership_inverse');
      await database.admin.query('ANALYZE access.organization_member');
    },
    operation: fixedRequest,
  });
  const accountPlans = await capture(db, fixedRequest);
  expectIndex(accountPlans.capture.plans, 'account_pkey');
  expectIndex(accountPlans.capture.plans, 'membership_inverse_pkey');

  await checkGrowth(db, {
    name: 'Gate admission with unrelated gate grant growth',
    bounds: { rows: 'constant', statements: 'constant', blocks: 'logarithmic' },
    repetitions: 1,
    warmups: 1,
    async grow(database, scale, previous) {
      const ids = grantSubjectIds.slice(previous * rowsPerScaleUnit, scale * rowsPerScaleUnit);
      await database.admin.query(
        `INSERT INTO access.account (route, account_id, kind, state, transaction_id)
         SELECT $1, id, 'actor', 'active', $3 FROM unnest($2::uuid[]) id`,
        [route, ids, Bun.randomUUIDv7()],
      );
      await database.admin.query(
        `INSERT INTO access.resource_grant
           (route, resource_id, subject_id, action, valid, transaction_id)
         SELECT 0, '00000000-0000-8000-8000-000000000000', id, 'gate:unrelated', '(,)', $2
         FROM unnest($1::uuid[]) id`,
        [ids, Bun.randomUUIDv7()],
      );
      await database.admin.query(
        `INSERT INTO access.resource_role_grant
           (route, resource_id, subject_id, grant_role, valid, transaction_id)
         SELECT 0, '00000000-0000-8000-8000-000000000000', id, 'unrelated', '(,)', $2
         FROM unnest($1::uuid[]) id`,
        [ids, Bun.randomUUIDv7()],
      );
      await database.admin.query(
        `INSERT INTO access.resource_denial
           (route, resource_id, subject_id, action, reason, valid, transaction_id)
         SELECT 0, '00000000-0000-8000-8000-000000000000', id, 'gate:unrelated', 'resource', '(,)', $2
         FROM unnest($1::uuid[]) id`,
        [ids, Bun.randomUUIDv7()],
      );
      await database.admin.query('ANALYZE access.account');
      await database.admin.query('ANALYZE access.resource_grant');
      await database.admin.query('ANALYZE access.resource_role_grant');
      await database.admin.query('ANALYZE access.resource_denial');
    },
    operation: fixedRequest,
  });
  const grantPlans = await capture(db, fixedRequest);
  expectIndex(grantPlans.capture.plans, 'resource_grant_pkey');
  expectIndex(grantPlans.capture.plans, 'resource_role_grant_pkey');
  expectIndex(grantPlans.capture.plans, 'resource_denial_permission');

  await checkGrowth(db, {
    name: 'Gate admission with other exposure opening growth',
    bounds: { rows: 'constant', statements: 'constant', blocks: 'logarithmic' },
    repetitions: 1,
    warmups: 1,
    async grow(database, scale, previous) {
      const rows = Array.from({ length: (scale - previous) * rowsPerScaleUnit }, (_, index) => ({
        name: `other_${alpha(previous * rowsPerScaleUnit + index)}`,
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
  const openingPlans = await capture(db, fixedRequest);
  expectIndex(openingPlans.capture.plans, 'exposure_opening_pkey');
});
