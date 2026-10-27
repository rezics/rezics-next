import { afterAll, beforeAll, expect, spyOn, test } from 'bun:test';
import {
  capture,
  checkGrowth,
  openGrowthDatabase,
  type GrowthDatabase,
  type GrowthReport,
} from '../../support/growth.ts';

await import('reylo/register');
const { actorFixture } = await import('../actor-side-fixture.ts');
const { createAccess, visibleOperations } = await import('../../../src/access/index.ts');
const { newId, routeOf } = await import('../../../src/route/route.ts');
const { createKernel } = await import('../../../src/http/kernel.ts');
const { actionCatalogue } = await import('../../../src/http/request.ts');
const appModule = await import('../../../src/http/app.ts');

const fixedTime = new Date('2026-01-15T12:00:00.000Z');
const rowsPerScaleUnit = 500;
const routeKey = new Uint8Array(32).fill(103);
const tag = Array.from(crypto.getRandomValues(new Uint8Array(8)), (byte) => String.fromCharCode(97 + (byte % 26))).join(
  '',
);
const group = `gd${tag}_fixture`;
const groupAction = `gate:${group}`;
let db: GrowthDatabase;
let kernel: ReturnType<typeof createKernel>;
let access: ReturnType<typeof createAccess>;
let actorId: string;
let accountRoute: number;
let accountGrowthIds: string[];
let grantSubjectIds: string[];
let openingNames: string[];

function alpha(index: number): string {
  let value = index;
  let result = '';
  do {
    result = String.fromCharCode(97 + (value % 26)) + result;
    value = Math.floor(value / 26);
  } while (value > 0);
  return result;
}

function expectBounded(report: GrowthReport, routeCount: number): void {
  for (const sample of report.samples) {
    expect(sample.cost.rows).toBeGreaterThan(0);
    expect(sample.cost.statements).toBeLessThan(routeCount);
  }
}

function expectIndex(plans: readonly unknown[], expected: string): void {
  let found = false;
  const visit = (node: unknown): void => {
    if (typeof node !== 'object' || node === null) return;
    if (Array.isArray(node)) {
      for (const child of node) visit(child);
      return;
    }
    const plan = node as Record<string, unknown>;
    if (typeof plan['Index Name'] === 'string' && plan['Index Name'].startsWith(expected)) found = true;
    if (typeof plan.Plan === 'object' && plan.Plan !== null) visit(plan.Plan);
    if (Array.isArray(plan.Plans)) for (const child of plan.Plans) visit(child);
  };
  for (const plan of plans) visit(plan);
  expect(found, `plan should use ${expected}`).toBe(true);
}

beforeAll(async () => {
  db = await openGrowthDatabase();
  const fixture = await actorFixture(db.pool, db.admin);
  actorId = fixture.actorId;
  const route = routeOf(actorId);
  if (route === null) throw new Error('Fixture actor must have a route');
  accountRoute = route;
  await db.admin.query(
    `INSERT INTO access.resource_grant
       (route, resource_id, subject_id, action, valid, transaction_id)
     VALUES (0, '00000000-0000-8000-8000-000000000000', $1, $2, '(,)', $3)`,
    [actorId, groupAction, fixture.transactionId],
  );

  const original = appModule.createApp;
  const composition = spyOn(appModule, 'createApp').mockImplementation((dependencies) => {
    const app = original(dependencies);
    const detail = {
      operationId: 'fixture.growth_read',
      'x-action': 'fixture:read',
      'x-exposure': `gate:${group}`,
      security: [{ bearerAuth: [] }],
    };
    app.get('/v1/growth-discovery-fixture', { detail }, () => ({ ok: true }));
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
  });
  composition.mockRestore();
  access = createAccess({ actions: actionCatalogue(kernel) });

  accountGrowthIds = Array.from({ length: 64 * rowsPerScaleUnit }, () => newId(accountRoute));
  grantSubjectIds = Array.from({ length: 64 * rowsPerScaleUnit }, () => newId(accountRoute));
  openingNames = Array.from({ length: 64 * rowsPerScaleUnit }, (_, index) => `gd${tag}_o${alpha(index)}`);
}, 120_000);

afterAll(async () => {
  await db?.close();
});

async function discover(): Promise<void> {
  const visible = await visibleOperations({
    viewer: {
      kind: 'account',
      accountId: actorId,
      clientId: 'growth-discovery',
      scopes: ['fixture:read'],
      requestedBy: null,
      authnEpoch: 1,
    },
    pool: db.pool,
    access,
    routes: kernel.routes,
    deadline: Date.now() + 15_000,
    clock: () => new Date(fixedTime),
  });
  if (!visible.some((operation) => operation.operationId === 'fixture.growth_read')) {
    throw new Error('The fixed viewer grant was not visible');
  }
}

test('discovery stays bounded as unrelated accounts, gate grants, and openings grow', async () => {
  // The route catalogue is fixed-size. Discovery receives the viewer identity directly and does not read
  // access.account; account, resource-grant, role-grant, denial, and opening rows grow in their declared checks.
  const routeCount = kernel.routes.filter((route) => route.hooks?.detail?.hide !== true).length;
  expect(routeCount).toBeGreaterThan(1);
  const bounds = { rows: 'constant', statements: 'constant', blocks: 'logarithmic' } as const;

  const accounts = await checkGrowth(db, {
    name: 'Operation discovery with unrelated account growth',
    bounds,
    repetitions: 1,
    warmups: 1,
    async grow(database, scale, previous) {
      const ids = accountGrowthIds.slice(previous * rowsPerScaleUnit, scale * rowsPerScaleUnit);
      await database.admin.query(
        `INSERT INTO access.account (route, account_id, kind, state, transaction_id)
         SELECT $1, id, 'actor', 'active', $3 FROM unnest($2::uuid[]) id`,
        [accountRoute, ids, Bun.randomUUIDv7()],
      );
      await database.admin.query('ANALYZE access.account');
    },
    operation: discover,
  });
  expectBounded(accounts, routeCount);

  const grants = await checkGrowth(db, {
    name: 'Operation discovery with unrelated gate grant growth',
    bounds,
    repetitions: 1,
    warmups: 1,
    async grow(database, scale, previous) {
      const ids = grantSubjectIds.slice(previous * rowsPerScaleUnit, scale * rowsPerScaleUnit);
      await database.admin.query(
        `INSERT INTO access.account (route, account_id, kind, state, transaction_id)
         SELECT $1, id, 'actor', 'active', $3 FROM unnest($2::uuid[]) id`,
        [accountRoute, ids, Bun.randomUUIDv7()],
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
           (route, resource_id, subject_kind, subject_id, subject_role, grant_role, valid, transaction_id)
         SELECT 0, '00000000-0000-8000-8000-000000000000', 'identity', id, '', 'growth_unrelated', '(,)', $2
         FROM unnest($1::uuid[]) id`,
        [ids, Bun.randomUUIDv7()],
      );
      await database.admin.query(
        `INSERT INTO access.resource_denial
           (route, resource_id, subject_id, subject_role, action, reason, valid, transaction_id)
         SELECT 0, '00000000-0000-8000-8000-000000000000', id, '', 'gate:unrelated', 'resource', '(,)', $2
         FROM unnest($1::uuid[]) id`,
        [ids, Bun.randomUUIDv7()],
      );
      await database.admin.query('ANALYZE access.account');
      await database.admin.query('ANALYZE access.resource_grant');
      await database.admin.query('ANALYZE access.resource_role_grant');
      await database.admin.query('ANALYZE access.resource_denial');
    },
    operation: discover,
  });
  expectBounded(grants, routeCount);
  const grantPlans = await capture(db, discover);
  expectIndex(grantPlans.capture.plans, 'resource_grant_pkey');
  expectIndex(grantPlans.capture.plans, 'resource_role_grant_pkey');
  expectIndex(grantPlans.capture.plans, 'resource_denial_permission');

  const openings = await checkGrowth(db, {
    name: 'Operation discovery with other exposure opening growth',
    bounds,
    repetitions: 1,
    warmups: 1,
    async grow(database, scale, previous) {
      const names = openingNames.slice(previous * rowsPerScaleUnit, scale * rowsPerScaleUnit);
      await database.admin.query(
        `INSERT INTO access.exposure_opening ("group", valid, transaction_id)
         SELECT group_name, tstzrange('2000-01-01T00:00:00Z'::timestamptz, NULL, '[)'), $2
         FROM unnest($1::text[]) AS group_name`,
        [names, Bun.randomUUIDv7()],
      );
      await database.admin.query('ANALYZE access.exposure_opening');
    },
    operation: discover,
  });
  expectBounded(openings, routeCount);
  const openingPlans = await capture(db, discover);
  expectIndex(openingPlans.capture.plans, 'exposure_opening_pkey');
});
