import { DBOS } from '@dbos-inc/dbos-sdk';
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { Pool } from 'pg';
import { createInitiatorRestorer } from '../../src/access/durable-initiator.ts';
import { createAccountsWorkModule } from '../../src/access/membership-work.ts';
import { createRealmMembership, readMembershipInitiator } from '../../src/community/membership.ts';
import { communityWorkModule } from '../../src/community/work.ts';
import { createKernel } from '../../src/http/kernel.ts';
import { IDEMPOTENCY_HEADER } from '../../src/http/request.ts';
import { newId, partitionOf, routeOf } from '../../src/route/route.ts';
import { GLOBAL_CONTEXT } from '../../src/semantic/definitions.ts';
import { systemClock } from '../../src/clock.ts';
import { registerEffects, type Effect } from '../../src/events/effects.ts';
import { DBOS_SCHEMA, WORK_APPLICATION, createWorkClient, type WorkClient } from '../../src/work/client.ts';
import { WORK_QUEUES } from '../../src/work/queues.ts';
import type { WorkContext, WorkService } from '../../src/work/registry.ts';
import { createWriteRateLimiter } from '../../src/access/write-rate.ts';
import resourceRoles from '../../src/access/resource-roles.json';
import { checkGrowth, openGrowthDatabase, seed, type GrowthDatabase, type Population } from '../support/growth.ts';
import { createProductionAccess, type ProductionAccess } from './membership-fixture.ts';
import { encodeCursor } from '../../src/tokens/cursor.ts';

const route = 0x2130;
const hotPartition = partitionOf(route);
const routeKey = new Uint8Array(32).fill(91);
const sessionKeys = { current: 1, keys: new Map([[1, new Uint8Array(32).fill(92)]]) };
const accessActions = [...new Set(Object.values(resourceRoles.roles).flat())];
const ownerScopes = ['realm:manage', 'realm:read', 'realm:ban'];
const memberScopes = ['realm:join', 'realm:read'];
const scales = [256, 1024, 4096] as const;
const bounds = { rows: 'constant', statements: 'constant', blocks: 'logarithmic' } as const;
const created = '2020-01-01 00:00:00+00';
const historyStart = Date.UTC(2000, 0, 1);

type Realm = { realmId: string; spaceId: string };
type Person = { accountId: string; bearer: string };
type CallOptions = { bearer?: string; body?: unknown; key?: string };
type PopulationMode = 'neighbor' | 'cursor' | 'history';

let db: GrowthDatabase;
let systemPool: Pool;
let work: WorkClient;
let workServices: WorkService[] = [];
let serviceStarters: Array<() => WorkService | Promise<WorkService>> = [];
let kernel: ReturnType<typeof createKernel>;
let production: ProductionAccess;
let ownerId: string;
let owner: Person;
let realm: Realm;
let neighbor: Realm;
let populationOrdinal = 0;

function idAt(idRoute: number, milliseconds: number, sequence: number): string {
  const bytes = Buffer.alloc(16);
  let timestamp = BigInt(milliseconds);
  for (let index = 5; index >= 0; index--) {
    bytes[index] = Number(timestamp & 0xffn);
    timestamp >>= 8n;
  }
  bytes[6] = 0x70;
  bytes[7] = (sequence >>> 24) & 0xff;
  bytes[8] = 0x80 | ((sequence >>> 16) & 0x3f);
  bytes[9] = (sequence >>> 8) & 0xff;
  bytes[10] = idRoute >>> 8;
  bytes[11] = idRoute & 0xff;
  bytes[12] = sequence & 0xff;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

async function prepareRealm(target: Realm, creator: string, revisionId: string): Promise<void> {
  const spaceRevisionId = newId(route);
  const transactionId = newId(route);
  const client = await db.admin.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `INSERT INTO community.space (route, space_id, state, head_revision_id, created_at, creator)
       VALUES ($1,$2,'active',$3,$4,$5)`,
      [route, target.spaceId, spaceRevisionId, created, creator],
    );
    await client.query(
      `INSERT INTO community.space_revision
         (route, space_id, revision_id, predecessor, title, summary, created_at, author)
       VALUES ($1,$2,$3,NULL,'Growth host','',$4,$5)`,
      [route, target.spaceId, spaceRevisionId, created, creator],
    );
    await client.query(
      `INSERT INTO community.realm
         (route, realm_id, space_id, state, visibility, context_id, head_revision_id, created_at, creator)
       VALUES ($1,$2,$3,'active','protected',$4,$5,$6,$7)`,
      [route, target.realmId, target.spaceId, GLOBAL_CONTEXT, revisionId, created, creator],
    );
    await client.query(
      `INSERT INTO community.realm_revision
         (route, realm_id, revision_id, predecessor, title, summary, visibility, context_id, created_at, author)
       VALUES ($1,$2,$3,NULL,'Growth Realm','', 'protected',$4,$5,$6)`,
      [route, target.realmId, revisionId, GLOBAL_CONTEXT, created, creator],
    );
    await client.query(
      `INSERT INTO access.resource_initialization
         (route, resource_id, resource_type, creator_id, initialized_at)
       VALUES ($1,$2,'community.space',$3,$4),($1,$5,'community.realm',$3,$4)`,
      [route, target.spaceId, creator, created, target.realmId],
    );
    await client.query(
      `INSERT INTO access.resource_role_grant
         (route, resource_id, subject_kind, subject_id, subject_role, grant_role, valid, transaction_id)
       VALUES
         ($1,$2,'active_accounts',$3,'','community.realm.standing','(,)',$4),
         ($1,$2,'identity',$5,'','community.realm.owner','(,)',$4)`,
      [route, target.realmId, '00000000-0000-0000-0000-000000000000', transactionId, creator],
    );
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

async function createPerson(scopes: readonly string[], accountId = newId(route)): Promise<Person> {
  await db.admin.query(
    `INSERT INTO access.account (route, account_id, kind, state, transaction_id)
     VALUES ($1,$2,'actor','active',$2)`,
    [routeOf(accountId), accountId],
  );
  return { accountId, bearer: await production.mint(accountId, scopes, 'realm-ban-boundary') };
}

async function call(method: string, path: string, options: CallOptions = {}) {
  const headers = new Headers();
  if (options.bearer) headers.set('authorization', `Bearer ${options.bearer}`);
  if (options.body !== undefined) headers.set('content-type', 'application/json');
  if (options.key !== undefined) headers.set(IDEMPOTENCY_HEADER, JSON.stringify(options.key));
  const response = await kernel.handle(
    new Request(`http://kernel.test${path}`, {
      method,
      headers,
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
    }),
  );
  const text = await response.text();
  let value: Record<string, unknown> = {};
  try {
    value = text ? (JSON.parse(text) as Record<string, unknown>) : {};
  } catch {
    value = { body: text };
  }
  return { response, value };
}

async function complete(workflowId: string): Promise<void> {
  expect(await work.retrieveWorkflow(workflowId).getResult()).toBeUndefined();
}

async function startWorker(): Promise<void> {
  workServices = [];
  for (const start of serviceStarters) workServices.push(await start());
}

async function stopWorker(): Promise<void> {
  for (let index = workServices.length - 1; index >= 0; index--) await workServices[index]!.stop();
  workServices = [];
}

async function verifyMembership(accountId: string, present: boolean): Promise<void> {
  const result = await db.pool.query(
    `SELECT 1 FROM community.realm_member
     WHERE route=$1 AND realm_id=$2 AND account_id=$3 AND upper_inf(valid)`,
    [route, realm.realmId, accountId],
  );
  expect(result.rowCount === 1).toBe(present);
}

async function verifyFollow(accountId: string): Promise<void> {
  const result = await db.pool.query<{ target_type: string; state: string; reason: string }>(
    `SELECT target_type, state, reason FROM library.follow
     WHERE route=$1 AND account_id=$2 AND target_id=$3`,
    [routeOf(accountId), accountId, realm.spaceId],
  );
  expect(result.rows).toEqual([{ target_type: 'space', state: 'following', reason: 'membership' }]);
}

async function addMember(): Promise<Person> {
  const member = await createPerson(memberScopes);
  const result = await call('POST', `/v1/realms/${realm.realmId}/members`, {
    bearer: owner.bearer,
    key: crypto.randomUUID(),
    body: { accountId: member.accountId },
  });
  expect(result.response.status, JSON.stringify(result.value)).toBe(202);
  const workflowId = String(result.value.workflowId);
  expect(workflowId).toMatch(/^community\.join:[0-9a-f]{32}$/);
  await complete(workflowId);
  await db.admin.query(
    `INSERT INTO access.resource_grant
       (route,resource_id,subject_id,action,valid,transaction_id)
     VALUES ($1,$2,$3,'realm:read','(,)',$3)`,
    [route, realm.realmId, member.accountId],
  );
  expect((await call('GET', `/v1/realms/${realm.realmId}`, { bearer: member.bearer })).response.status).toBe(200);
  await verifyMembership(member.accountId, true);
  await verifyFollow(member.accountId);
  return member;
}

async function banWhilePending(member: Person): Promise<void> {
  let workflowId = '';
  try {
    await stopWorker();
    const result = await call('PUT', `/v1/realms/${realm.realmId}/bans/${member.accountId}`, {
      bearer: owner.bearer,
      key: crypto.randomUUID(),
      body: { reason: 'Growth boundary' },
    });
    expect(result.response.status, JSON.stringify(result.value)).toBe(200);
    const ban = result.value.ban as { workflowId: string | null };
    expect(ban.workflowId).toMatch(/^community\.leave:[0-9a-f]{32}$/);
    workflowId = ban.workflowId!;
    await verifyMembership(member.accountId, true);
    expect((await call('GET', `/v1/realms/${realm.realmId}`, { bearer: member.bearer })).response.status).toBe(404);
  } finally {
    await startWorker();
  }
  await complete(workflowId);
  await verifyMembership(member.accountId, false);
  await verifyFollow(member.accountId);
}

function banPopulation(name: string, target: Realm, mode: PopulationMode): Population {
  const targetRoute = routeOf(target.realmId)!;
  const salt = ++populationOrdinal;
  const historyKey = idAt(targetRoute, Date.UTC(2020, 0, 1), salt);
  const historyBase = historyStart + salt * 20_000_000;
  return {
    name,
    hotPartition: partitionOf(targetRoute),
    hotShare: 1,
    rows({ ordinal }) {
      if (mode === 'history') {
        const start = historyBase + ordinal * 2000;
        return {
          'community.realm_ban': [
            {
              route: targetRoute,
              realm_id: target.realmId,
              account_id: historyKey,
              valid: `[${new Date(start).toISOString()},${new Date(start + 1000).toISOString()})`,
              reason: 'Retained history',
              actor: ownerId,
              transaction_id: newId(targetRoute),
            },
          ],
        };
      }
      const accountId = idAt(targetRoute, Date.UTC(2027, 0, 1), salt * 10_000 + ordinal);
      return {
        'community.realm_ban': [
          {
            route: targetRoute,
            realm_id: mode === 'neighbor' ? target.realmId : realm.realmId,
            account_id: accountId,
            valid: '[2020-01-01,)',
            reason: 'Unrelated population',
            actor: ownerId,
            transaction_id: newId(targetRoute),
          },
        ],
      };
    },
  };
}

async function assertReport(report: Awaited<ReturnType<typeof checkGrowth>>): Promise<void> {
  expect(report.samples.map((sample) => sample.scale)).toEqual([...scales]);
  expect(new Set(report.samples.map((sample) => sample.cost.statements)).size).toBe(1);
  for (const sample of report.samples) {
    const relations = Object.entries(sample.cost.relations ?? {}).filter(([name]) => name.startsWith('community.'));
    expect(relations.length).toBeGreaterThan(0);
    for (const [, relation] of relations) expect(relation.sequentialScans).toBe(0);
  }
}

async function measure(
  name: string,
  population: Population,
  operation: () => Promise<void>,
  options: { prepare?: () => Promise<void>; warmup?: () => Promise<void> } = {},
): Promise<void> {
  const report = await checkGrowth(db, {
    name,
    scales,
    rule: 'series',
    bounds,
    async grow(_database, scale, previous) {
      await seed(db, population, { from: previous, to: scale });
    },
    ...(options.prepare === undefined ? {} : { prepare: async () => options.prepare!() }),
    ...(options.warmup === undefined ? {} : { warmup: async () => options.warmup!() }),
    operation,
  });
  await assertReport(report);
}

beforeAll(async () => {
  db = await openGrowthDatabase();
  db.pool.options.max = 10;
  db.pool.options.connectionTimeoutMillis = 10_000;
  let roleReader: ReturnType<typeof createRealmMembership>['roleReader'] = async () => null;
  production = await createProductionAccess({
    actions: accessActions,
    realmRoleReader: (client, input) => roleReader(client, input),
  });
  const apiMembership = createRealmMembership({ pool: db.pool, access: production.access, referenceKeys: sessionKeys });
  roleReader = apiMembership.roleReader;
  const workerMembership = createRealmMembership({
    pool: db.pool,
    access: production.access,
    referenceKeys: sessionKeys,
    restorer: createInitiatorRestorer({
      pool: db.pool,
      access: production.access,
      readOperation: readMembershipInitiator,
      async readConsent() {
        return accessActions;
      },
    }),
  });
  systemPool = new Pool({ connectionString: db.url, max: 10 });
  work = await createWorkClient(db.url, systemPool);
  DBOS.setConfig({
    name: WORK_APPLICATION,
    systemDatabaseUrl: db.url,
    systemDatabaseSchemaName: DBOS_SCHEMA,
    systemDatabasePool: systemPool,
    runMigrations: false,
    logLevel: 'warn',
    executorID: 'realm-ban-boundaries-check',
  });
  for (const [name, parameters] of Object.entries(WORK_QUEUES)) await work.registerQueue(name, parameters);
  const effects: Effect[] = [];
  serviceStarters = [];
  const workContext: WorkContext = Object.freeze({
    pool: db.pool,
    queues: WORK_QUEUES,
    client: work,
    env: {
      KERNEL_ROUTE_KEY: Buffer.from(routeKey).toString('base64url'),
      KERNEL_SESSION_KEYS: `1:${Buffer.from(sessionKeys.keys.get(1)!).toString('base64url')}`,
      AUTH_ISSUER: 'https://realm-growth.auth.test',
      AUTH_AUDIENCE: 'https://realm-growth.api.test',
      AUTH_JWKS_URL: 'https://realm-growth.auth.test/.well-known/jwks.json',
    },
    clock: systemClock,
    getAuthorization() {
      throw new Error('Ban boundary fixture supplies its membership adapter directly');
    },
    addEffects(items) {
      effects.push(...items);
    },
    addService(start) {
      serviceStarters.push(start);
    },
  });
  await createAccountsWorkModule({ realm: workerMembership }).register(workContext);
  await communityWorkModule.register(workContext);
  registerEffects(effects);
  await DBOS.launch();
  await startWorker();
  kernel = createKernel({
    pool: db.pool,
    routeKey,
    tokens: sessionKeys,
    workClient: work,
    access: production.access,
    writeRate: createWriteRateLimiter({ secret: 'realm-ban-boundaries-write-rate-secret-32' }),
  });
  ownerId = newId(route);
  await db.admin.query(
    `INSERT INTO access.account (route, account_id, kind, state, transaction_id)
     VALUES ($1,$2,'actor','active',$2)`,
    [routeOf(ownerId), ownerId],
  );
  owner = { accountId: ownerId, bearer: await production.mint(ownerId, ownerScopes, 'realm-ban-boundary') };
  realm = { realmId: newId(route), spaceId: newId(route) };
  neighbor = { realmId: newId(route), spaceId: newId(route) };
  await prepareRealm(realm, ownerId, newId(route));
  await prepareRealm(neighbor, ownerId, newId(route));
});

afterAll(async () => {
  try {
    await stopWorker();
    if (DBOS.isInitialized()) await DBOS.shutdown({ workflowCompletionTimeoutMS: 2_147_483_647 });
  } finally {
    await work?.close();
    await systemPool?.end();
    await db?.close();
  }
});

test.serial(
  'empty, denied, deep-cursor and pending-removal ban operations stay bounded across population and retained history',
  async () => {
    const empty = async () => {
      const result = await call('GET', `/v1/realms/${realm.realmId}/bans?limit=1`, { bearer: owner.bearer });
      expect(result.response.status).toBe(200);
      expect(result.value).toMatchObject({ items: [], next: null });
    };
    for (const [axis, target, mode] of [
      ['population', neighbor, 'neighbor'],
      ['history', realm, 'history'],
    ] as const) {
      await measure(`Realm ban empty list ${axis}`, banPopulation(`ban-empty-${axis}`, target, mode), empty);
    }

    const first = idAt(route, Date.UTC(2030, 0, 1), 1);
    const second = idAt(route, Date.UTC(2030, 0, 1), 2);
    for (const accountId of [first, second]) {
      await createPerson(memberScopes, accountId);
      const result = await call('PUT', `/v1/realms/${realm.realmId}/bans/${accountId}`, {
        bearer: owner.bearer,
        key: crypto.randomUUID(),
        body: { reason: 'Deep cursor fixture' },
      });
      expect(result.response.status).toBe(200);
      expect((result.value.ban as { workflowId: string | null }).workflowId).toBeNull();
    }
    const marker = idAt(route, Date.UTC(2028, 0, 1), 0);
    const epoch = Number(
      (await db.admin.query('SELECT epoch FROM core.partition WHERE partition_no=$1', [hotPartition])).rows[0]!.epoch,
    );
    const cursor = encodeCursor(
      sessionKeys,
      {
        operation: 'community.realm.bans',
        parameters: { realmId: realm.realmId, limit: 1, viewer: ownerId },
      },
      { epoch, after: [marker] },
    );
    const deepPage = async () => {
      const result = await call(
        'GET',
        `/v1/realms/${realm.realmId}/bans?limit=1&cursor=${encodeURIComponent(cursor)}`,
        { bearer: owner.bearer },
      );
      expect(result.response.status).toBe(200);
      expect(result.value).toMatchObject({ items: [{ accountId: first }], next: expect.any(String) });
    };
    for (const [axis, mode] of [
      ['population', 'cursor'],
      ['history', 'history'],
    ] as const) {
      await measure(`Realm ban deep cursor ${axis}`, banPopulation(`ban-deep-${axis}`, realm, mode), deepPage);
    }

    const outsider = await createPerson(memberScopes);
    const denied = async () => {
      const list = await call('GET', `/v1/realms/${realm.realmId}/bans?limit=1`, { bearer: outsider.bearer });
      expect(list.response.status).toBe(403);
      const mutation = await call('PUT', `/v1/realms/${realm.realmId}/bans/${outsider.accountId}`, {
        bearer: outsider.bearer,
        key: crypto.randomUUID(),
        body: { reason: 'Denied growth operation' },
      });
      expect(mutation.response.status).toBe(403);
    };
    for (const [axis, target, mode] of [
      ['population', neighbor, 'neighbor'],
      ['history', realm, 'history'],
    ] as const) {
      await measure(`Realm ban denied operations ${axis}`, banPopulation(`ban-denied-${axis}`, target, mode), denied);
    }

    let pendingMember: Person;
    const prepare = async () => {
      pendingMember = await addMember();
    };
    const warmup = async () => banWhilePending(await addMember());
    for (const [axis, target, mode] of [
      ['population', neighbor, 'neighbor'],
      ['history', realm, 'history'],
    ] as const) {
      await measure(
        `Realm ban pending removal and settlement ${axis}`,
        banPopulation(`ban-removal-${axis}`, target, mode),
        async () => banWhilePending(pendingMember!),
        { prepare, warmup },
      );
    }
  },
  1_200_000,
);
