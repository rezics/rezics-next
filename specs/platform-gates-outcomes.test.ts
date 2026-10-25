import { afterEach, beforeEach, expect, setDefaultTimeout, test } from 'bun:test';
import { checkGrowth } from '../services/kernel/test/support/growth.ts';
import { isAbsolute } from 'node:path';
import { pathToFileURL } from 'node:url';
import { GLOBAL_CONTEXT_ID } from './platform-gates-driver.ts';
import type {
  Account,
  Operation,
  PlatformGatesDriver,
  PlatformGatesFixture,
  StoredGrant,
  Viewer,
} from './platform-gates-driver.ts';

setDefaultTimeout(120_000);

const missingDriver = 'Missing platform gates driver';
let driver: PlatformGatesDriver | undefined;
let fixture: PlatformGatesFixture | undefined;

const d = () => {
  if (!driver) throw new Error('Platform gates driver was not initialized');
  return driver;
};
const f = () => {
  if (!fixture) throw new Error('Platform gates fixture was not initialized');
  return fixture;
};
const anonymous: Viewer = { kind: 'anonymous' };
const viewer = (account: Account): Viewer => ({ kind: 'account', account });
const invalidBearer = (bearer = 'not-a-valid-native-token'): Viewer => ({ kind: 'invalid-bearer', bearer });

beforeEach(async () => {
  const location = process.env.PLATFORM_GATES_DRIVER_MODULE;
  if (!location) throw new Error(missingDriver);
  if (!isAbsolute(location) && !location.startsWith('file:')) {
    throw new Error('PLATFORM_GATES_DRIVER_MODULE must be an absolute path or file URL');
  }
  const url = isAbsolute(location) ? pathToFileURL(location) : new URL(location);
  if (url.protocol !== 'file:') throw new Error('Platform gates driver must use a file URL');
  const binding = await import(url.href);
  if (typeof binding.createPlatformGatesDriver !== 'function') {
    throw new Error('Platform gates driver must export createPlatformGatesDriver');
  }
  const created = await binding.createPlatformGatesDriver();
  driver = created;
  fixture = await created.seed();
}, 120_000);

afterEach(async () => {
  const current = driver;
  fixture = undefined;
  driver = undefined;
  await current?.close();
});

function operationRequest(who: Viewer, operation: Operation) {
  return d().request(who, operation.method, operation.path);
}

async function successful(response: Response) {
  expect(response.status).toBeGreaterThanOrEqual(200);
  expect(response.status).toBeLessThan(300);
  return response;
}

async function problem(response: Response, status: number, code: string) {
  expect(response.status).toBe(status);
  expect(response.headers.get('content-type')).toContain('application/problem+json');
  const body = (await response.clone().json()) as Record<string, unknown>;
  expect(body.status).toBe(status);
  expect(body.code).toBe(code);
  return body;
}

async function closed(response: Response) {
  const body = await problem(response, 403, 'platform_closed');
  expect(body.type).toBe('https://rezics.com/problems/platform_closed');
  expect(typeof body.request_id).toBe('string');
  const { request_id: _requestId, ...stableBody } = body;
  return {
    status: response.status,
    contentType: response.headers.get('content-type'),
    body: stableBody,
  };
}

function activeAction(rows: readonly StoredGrant[], accountId: string, action: string) {
  return rows.some(
    (row) =>
      row.subjectAccountId === accountId &&
      row.resourceId === GLOBAL_CONTEXT_ID &&
      row.effect === 'allow' &&
      row.active &&
      row.actions.includes(action),
  );
}

async function expectGlobalAction(account: Account, action: string) {
  expect(activeAction(await d().grantsFor(account.id), account.id, action)).toBe(true);
}

function groupOf(operation: Operation) {
  expect(operation.exposure.startsWith('gate:')).toBe(true);
  return operation.exposure.slice('gate:'.length);
}

function hasOperation(operations: readonly Operation[], wanted: Operation) {
  return operations.some((operation) => operation.id === wanted.id);
}

async function openApiPaths(who: Viewer) {
  const response = await d().request(who, 'GET', '/v1/openapi.json');
  expect(response.status).toBe(200);
  const document = (await response.clone().json()) as {
    paths?: Record<string, Record<string, unknown>>;
  };
  expect(document.paths).toBeDefined();
  return document.paths!;
}

function expectOpenApiOperation(
  paths: Record<string, Record<string, unknown>>,
  operation: Operation,
  visible: boolean,
) {
  const path = paths[operation.openApiPath];
  const present = path !== undefined && Object.hasOwn(path, operation.method.toLowerCase());
  expect(present).toBe(visible);
}

test('a route without a valid x-exposure is refused when the kernel is built', async () => {
  const invalidRoutes: readonly { exposure?: unknown }[] = [
    {},
    { exposure: null },
    { exposure: '' },
    { exposure: 'private' },
    { exposure: 'public ' },
    { exposure: 'gate:' },
    { exposure: 'gate:Upper' },
    { exposure: 'gate:two-words' },
    { exposure: 'gate:any' },
    { exposure: 'gate:open' },
    { exposure: 'gate:close' },
    { exposure: `gate:${'a'.repeat(64)}` },
  ];
  for (const route of invalidRoutes) await expect(d().buildWithRoute(route)).rejects.toThrow();
  await expect(d().buildWithRoute({ exposure: 'public' })).resolves.toBeUndefined();
  await expect(d().buildWithRoute({ exposure: 'gate:spec_fixture' })).resolves.toBeUndefined();
});

test('every route of the production kernel declares a valid x-exposure', async () => {
  const routes = await d().productionRoutes();
  const mounted = routes.filter((route) => !route.hidden);
  expect(mounted.length).toBeGreaterThan(0);
  for (const route of mounted) {
    expect(route.exposure).toBeDefined();
    if (route.exposure === 'public') continue;
    expect(route.exposure).toMatch(/^gate:[a-z][a-z_]{0,62}$/);
    expect(['gate:any', 'gate:open', 'gate:close']).not.toContain(route.exposure);
  }
});

test('a closed operation answers the same 403 platform_closed to anonymous callers and ordinary accounts', async () => {
  const fixture = f();
  expect(await d().exposureOpenAt('spec_fixture')).toBe(false);
  const readsBefore = await d().fixtureDomainReadCount(fixture.gatedOperation.id);
  const anonymousReply = await operationRequest(anonymous, fixture.gatedOperation);
  const ordinaryReply = await operationRequest(viewer(fixture.accounts.ordinary), fixture.gatedOperation);
  expect(await closed(anonymousReply)).toEqual(await closed(ordinaryReply));
  expect(await d().fixtureDomainReadCount(fixture.gatedOperation.id)).toBe(readsBefore);

  const invalid = await operationRequest(invalidBearer(), fixture.gatedOperation);
  expect(invalid.status).toBe(401);
  expect(await d().fixtureDomainReadCount(fixture.gatedOperation.id)).toBe(readsBefore);

  await successful(await operationRequest(anonymous, fixture.publicOperation));

  await successful(await d().grant(fixture.accounts.staff, fixture.accounts.tester, 'gate:spec_fixture', 'allow'));
  await successful(
    await d().grant(fixture.accounts.staff, fixture.accounts.testerPrincipal, 'gate:spec_fixture', 'allow'),
  );
  await successful(await operationRequest(viewer(fixture.accounts.tester), fixture.gatedOperation));
  await successful(await operationRequest(viewer(fixture.accounts.staff), fixture.gatedOperation));
  expect(await d().fixtureDomainReadCount(fixture.gatedOperation.id)).toBeGreaterThan(readsBefore);
});

test("a gated tester with the group's gate on the Global Context succeeds and loses it at revocation", async () => {
  const { accounts, gatedOperation } = f();
  expect(accounts.tester.principalId).toBe(accounts.testerPrincipal.id);
  const action = `gate:${groupOf(gatedOperation)}`;
  const initialReads = await d().fixtureDomainReadCount(gatedOperation.id);
  await successful(await d().grant(accounts.staff, accounts.tester, action, 'allow'));
  await expectGlobalAction(accounts.tester, action);
  await closed(await operationRequest(viewer(accounts.tester), gatedOperation));
  expect(await d().fixtureDomainReadCount(gatedOperation.id)).toBe(initialReads);

  await successful(await d().grant(accounts.staff, accounts.testerPrincipal, action, 'allow'));
  await expectGlobalAction(accounts.tester, action);
  await expectGlobalAction(accounts.testerPrincipal, action);
  await successful(await operationRequest(viewer(accounts.tester), gatedOperation));
  expect(await d().fixtureDomainReadCount(gatedOperation.id)).toBeGreaterThan(initialReads);

  await successful(await d().grant(accounts.staff, accounts.testerPrincipal, action, 'revoke'));
  expect(await closed(await operationRequest(viewer(accounts.tester), gatedOperation))).toMatchObject({
    status: 403,
    body: { code: 'platform_closed' },
  });
  const readsBeforeActorRevocation = await d().fixtureDomainReadCount(gatedOperation.id);

  await successful(await d().grant(accounts.staff, accounts.testerPrincipal, action, 'allow'));
  await successful(await d().grant(accounts.staff, accounts.tester, action, 'revoke'));
  await closed(await operationRequest(viewer(accounts.tester), gatedOperation));
  expect(await d().fixtureDomainReadCount(gatedOperation.id)).toBe(readsBeforeActorRevocation);
});

test('platform staff holding gate any use every closed group and grant one gate to another account', async () => {
  const fixture = f();
  const { staff, recipient } = fixture.accounts;
  await expectGlobalAction(staff, 'gate:any');
  await expectGlobalAction(staff, 'access:grant');
  expect(fixture.closedOperations.some((operation) => operation.exposure === 'gate:spec_fixture')).toBe(true);

  const groups = fixture.closedOperations.map(groupOf);
  expect(new Set(groups).size).toBe(groups.length);
  for (const operation of fixture.closedOperations) {
    const group = groupOf(operation);
    expect(await d().exposureOpenAt(group)).toBe(false);
    await successful(await operationRequest(viewer(staff), operation));
  }

  await successful(await d().grant(staff, recipient, 'gate:spec_fixture', 'allow'));
  const recipientRows = await d().grantsFor(recipient.id);
  expect(activeAction(recipientRows, recipient.id, 'gate:spec_fixture')).toBe(true);
  expect(
    recipientRows.some(
      (row) =>
        row.subjectAccountId === recipient.id &&
        row.resourceId === GLOBAL_CONTEXT_ID &&
        row.effect === 'allow' &&
        row.active &&
        row.actions.includes('gate:spec_fixture'),
    ),
  ).toBe(true);
  await successful(await operationRequest(viewer(recipient), fixture.gatedOperation));
});

test('an account cannot grant a gate it does not hold', async () => {
  const { accounts, gatedOperation } = f();
  const { ordinary, recipient, staff } = accounts;
  await successful(await d().grant(staff, ordinary, 'access:grant', 'allow'));
  await expectGlobalAction(ordinary, 'access:grant');
  expect(activeAction(await d().grantsFor(ordinary.id), ordinary.id, 'gate:spec_fixture')).toBe(false);
  expect(activeAction(await d().grantsFor(ordinary.id), ordinary.id, 'gate:any')).toBe(false);

  const denied = await d().grant(ordinary, recipient, 'gate:spec_fixture', 'allow');
  expect(denied.status).toBe(403);
  expect(denied.headers.get('content-type')).toContain('application/problem+json');
  expect(activeAction(await d().grantsFor(recipient.id), recipient.id, 'gate:spec_fixture')).toBe(false);
  await closed(await operationRequest(viewer(ordinary), gatedOperation));
});

test('opening a group in the exposure catalogue makes it public with no code change and closing it restores the denial', async () => {
  const { accounts, gatedOperation } = f();
  const group = groupOf(gatedOperation);
  const originalPath = gatedOperation.path;
  const originalExposure = gatedOperation.exposure;
  expect(originalExposure).toBe(`gate:${group}`);
  expect(await d().exposureOpenAt(group)).toBe(false);
  await closed(await operationRequest(anonymous, gatedOperation));

  const opened = await d().request(viewer(accounts.staff), 'POST', `/v1/platform/exposure/${group}:open`);
  await successful(opened);
  expect(await d().exposureOpenAt(group)).toBe(true);
  expect(gatedOperation.path).toBe(originalPath);
  expect(gatedOperation.exposure).toBe(originalExposure);
  await successful(await operationRequest(anonymous, gatedOperation));

  const closedAgain = await d().request(viewer(accounts.staff), 'POST', `/v1/platform/exposure/${group}:close`);
  await successful(closedAgain);
  expect(await d().exposureOpenAt(group)).toBe(false);
  await closed(await operationRequest(anonymous, gatedOperation));
});

test('the served OpenAPI and visibleOperations omit operations the viewer cannot use', async () => {
  const { accounts, operations, publicOperation, gatedOperation } = f();
  const anonymousViewers: Viewer[] = [anonymous, viewer(accounts.ordinary)];
  for (const who of anonymousViewers) {
    const paths = await openApiPaths(who);
    expectOpenApiOperation(paths, publicOperation, true);
    const visible = await d().visibleOperations(who);
    expect(hasOperation(visible, publicOperation)).toBe(true);
    for (const operation of operations.filter((item) => item.exposure.startsWith('gate:'))) {
      expectOpenApiOperation(paths, operation, false);
      expect(hasOperation(visible, operation)).toBe(false);
    }
  }

  await successful(await d().grant(accounts.staff, accounts.tester, 'gate:spec_fixture', 'allow'));
  await successful(await d().grant(accounts.staff, accounts.testerPrincipal, 'gate:spec_fixture', 'allow'));
  const tester = viewer(accounts.tester);
  const testerPaths = await openApiPaths(tester);
  const testerVisible = await d().visibleOperations(tester);
  for (const operation of operations) {
    const canUse = operation.exposure === 'public' || operation.id === gatedOperation.id;
    expectOpenApiOperation(testerPaths, operation, canUse);
    expect(hasOperation(testerVisible, operation)).toBe(canUse);
  }

  const staff = viewer(accounts.staff);
  const staffPaths = await openApiPaths(staff);
  const staffVisible = await d().visibleOperations(staff);
  for (const operation of operations) {
    expectOpenApiOperation(staffPaths, operation, true);
    expect(hasOperation(staffVisible, operation)).toBe(true);
  }
});

test('gate checks stay bounded as unrelated grants and openings grow', async () => {
  for (const axis of ['unrelated-grants', 'unrelated-openings'] as const) {
    const growth = await d().growthFixture(axis);
    try {
      const report = await checkGrowth(growth.database, {
        name: `closed platform gate with ${axis}`,
        scales: [1, 8, 64],
        bounds: { rows: 'constant', statements: 'constant', blocks: 'logarithmic' },
        repetitions: 3,
        warmups: 1,
        grow: async (_database, scale, previous) => growth.grow(scale, previous),
        operation: async (_database, _scale, repetition) => {
          await closed(await growth.request(repetition));
        },
      });
      expect(report.samples.map((sample) => sample.scale)).toEqual([1, 8, 64]);
      expect(report.bounds).toEqual({ rows: 'constant', statements: 'constant', blocks: 'logarithmic' });
      for (const sample of report.samples) {
        expect(Number.isSafeInteger(sample.cost.rows)).toBe(true);
        expect(sample.cost.rows).toBeGreaterThan(0);
        expect(Number.isSafeInteger(sample.cost.statements)).toBe(true);
        expect(sample.cost.statements).toBeGreaterThan(0);
        expect(Number.isSafeInteger(sample.cost.blocks)).toBe(true);
        expect(sample.cost.blocks).toBeGreaterThan(0);
      }
    } finally {
      await growth.close();
    }
  }
});
