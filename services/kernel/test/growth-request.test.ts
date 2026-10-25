import { afterAll, beforeAll, expect, test } from 'bun:test';
import { Admission } from '../src/http/admission.ts';
import { createKernel } from '../src/http/kernel.ts';
import { SESSION_HEADER } from '../src/http/request.ts';
import type { AccessFactory, AccountActor } from '../src/request/access.ts';
import { anchorRoute, partitionOf, routeOf } from '../src/route/route.ts';
import { encodeSession } from '../src/tokens/session.ts';
import type { KeyRing } from '../src/tokens/seal.ts';
import { checkGrowth, openGrowthDatabase, seed, type GrowthDatabase, type Population } from './support/growth.ts';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL must name the migrated test database');

const routeKey = new Uint8Array(32).fill(13);
const tokens: KeyRing = { current: 1, keys: new Map([[1, new Uint8Array(32).fill(9)]]) };
const writer: AccountActor = {
  kind: 'account',
  accountId: '019a1b2c-3d4e-7f00-8a00-5ab1ec700001',
  clientId: 'growth',
  scopes: ['subject:create', 'subject:read'],
  requestedBy: null,
  authnEpoch: 1,
};
const rowBounds = { rows: 'constant', blocks: 'constant', statements: 'constant' } as const;
const requestPartition = 40;
let db: GrowthDatabase | undefined;

beforeAll(async () => {
  db = await openGrowthDatabase(databaseUrl);
});

afterAll(async () => {
  await db?.close();
});

function kernel(actions: string[] = []) {
  const access: AccessFactory = () => ({
    async authenticate() {
      return writer;
    },
    async authorize(_client, _actor, action) {
      actions.push(action);
      return true;
    },
  });
  return createKernel({ pool: db!.pool, routeKey, tokens, access, admission: new Admission() });
}

function keyFor(name: string, ordinal: number | string, partition: number): string {
  for (let attempt = 0; ; attempt++) {
    const key = `growth-${name}-${ordinal}-${attempt}`;
    const route = anchorRoute(routeKey, `${writer.accountId}\nsubject.create\n${key}`);
    if (partitionOf(route) === partition) return key;
  }
}

async function createSubject(
  app: ReturnType<typeof kernel>,
  name: string,
  ordinal: number | string,
  partition: number,
): Promise<string> {
  const response = await app.handle(
    new Request('http://kernel.test/v1/subjects', {
      method: 'POST',
      headers: {
        authorization: 'Bearer growth-writer',
        'content-type': 'application/json',
        'idempotency-key': `"${keyFor(name, ordinal, partition)}"`,
      },
      body: JSON.stringify({ labels: { en: `Growth ${name} ${ordinal}` } }),
    }),
  );
  if (response.status !== 201)
    throw new Error(`Could not create ${name} subject: ${response.status} ${await response.text()}`);
  const body = (await response.json()) as { subject: { id: string } };
  const route = routeOf(body.subject.id);
  if (route === null || partitionOf(route) !== partition)
    throw new Error('Created subject did not use its declared partition');
  return body.subject.id;
}

function subjectPopulation(app: ReturnType<typeof kernel>, name: string, hotPartition: number): Population {
  let writes = Promise.resolve();
  return {
    name,
    hotPartition,
    hotShare: 1,
    write: async (_target, { ordinal, partition }) => {
      const next = writes.then(async () => {
        await createSubject(app, name, ordinal, partition);
      });
      writes = next.catch(() => {});
      await next;
    },
  };
}

async function readHealth(app: ReturnType<typeof kernel>): Promise<number> {
  const response = await app.handle(new Request('http://kernel.test/health'));
  if (response.status !== 200) throw new Error(`Health request returned ${response.status}`);
  return response.status;
}

async function readFixedSubject(
  app: ReturnType<typeof kernel>,
  id: string,
  options: { session?: string; bearer?: boolean } = {},
): Promise<Response> {
  const headers = new Headers();
  if (options.session !== undefined) headers.set(SESSION_HEADER, options.session);
  if (options.bearer) headers.set('authorization', 'Bearer growth-writer');
  const response = await app.handle(
    new Request(`http://kernel.test/v1/subjects/${id}`, {
      headers,
    }),
  );
  if (response.status !== 200) throw new Error(`Fixed subject read returned ${response.status}`);
  return response;
}

test('Admission stays within its bound as N grows', async () => {
  const database = db!;
  const app = kernel();
  // Seeded ordinals use POST /v1/subjects, preserving the production subject, receipt, fact and outbox shape.
  const population = subjectPopulation(app, 'admission', 3020);
  await createSubject(app, population.name, 'anchor', population.hotPartition);

  const report = await checkGrowth(database, {
    name: 'Admission stays within its bound as N grows',
    bounds: rowBounds,
    grow: async (growthDb, scale, previous) => {
      await seed({ pool: growthDb.pool, admin: growthDb.admin }, population, { from: previous, to: scale });
    },
    operation: async () => readHealth(app),
  });

  expect(report.samples.map(({ scale }) => scale)).toEqual([1, 8, 64]);
}, 90_000);

test('Request access dispatch stays within its bound as N grows', async () => {
  const database = db!;
  const actions: string[] = [];
  const app = kernel(actions);
  // Seeded ordinals use POST /v1/subjects, preserving the production subject, receipt, fact and outbox shape.
  const population = subjectPopulation(app, 'request-access', 3021);
  await createSubject(app, population.name, 'anchor', population.hotPartition);
  const fixedSubject = await createSubject(app, 'request-access-fixed', 'anchor', requestPartition);

  const report = await checkGrowth(database, {
    name: 'Request access dispatch stays within its bound as N grows',
    bounds: rowBounds,
    grow: async (growthDb, scale, previous) => {
      await seed({ pool: growthDb.pool, admin: growthDb.admin }, population, { from: previous, to: scale });
    },
    operation: async () => {
      const response = await readFixedSubject(app, fixedSubject, { bearer: true });
      return response.status;
    },
  });

  expect(report.samples.map(({ scale }) => scale)).toEqual([1, 8, 64]);
  expect(actions.filter((action) => action === 'subject:read').length).toBeGreaterThan(0);
}, 90_000);

test('Session header stays within its bound as j grows', async () => {
  const database = db!;
  const actions: string[] = [];
  const app = kernel(actions);
  // Seeded ordinals use POST /v1/subjects, preserving the production subject, receipt, fact and outbox shape.
  const population = subjectPopulation(app, 'session-header', 3022);
  await createSubject(app, population.name, 'anchor', population.hotPartition);
  const fixedSubject = await createSubject(app, 'session-header-fixed', 'anchor', requestPartition);
  const scales = [2, 8, 32] as const;
  const headers = new Map<number, string>(
    scales.map((count) => [
      count,
      encodeSession(
        tokens,
        'anonymous',
        Array.from({ length: count }, (_, partition) => ({ partition, epoch: 1, position: BigInt(partition) })),
      ),
    ]),
  );
  let seeded = false;

  const report = await checkGrowth(database, {
    name: 'Session header stays within its bound as j grows',
    scales,
    bounds: rowBounds,
    grow: async (growthDb) => {
      if (seeded) return;
      await seed({ pool: growthDb.pool, admin: growthDb.admin }, population, { from: 0, to: 64 });
      seeded = true;
    },
    operation: async (_growthDb, scale) => {
      const response = await readFixedSubject(app, fixedSubject, { session: headers.get(scale)! });
      if (!response.headers.has(SESSION_HEADER)) throw new Error('Subject read did not return a session header');
      return response.status;
    },
  });

  expect(report.samples.map(({ scale }) => scale)).toEqual([...scales]);
  expect(actions.filter((action) => action === 'subject:read').length).toBeGreaterThan(0);
}, 90_000);
