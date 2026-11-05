import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { exportJWK, generateKeyPair, SignJWT, type JWK } from 'jose';
import { createAccess } from '../src/access/index.ts';
import { createKernel } from '../src/http/kernel.ts';
import { IDEMPOTENCY_HEADER, SESSION_HEADER } from '../src/http/request.ts';
import { itemFacts } from '../src/semantic/item.ts';
import { pageSubjects } from '../src/semantic/page.ts';
import { bootstrapRelease, GLOBAL_CONTEXT } from '../src/semantic/definitions.ts';
import { anchorRoute, newId, partitionOf, routeOf } from '../src/route/route.ts';
import type { AccessFactory, AccountActor } from '../src/request/access.ts';
import { encodeSession, type SessionComponent } from '../src/tokens/session.ts';
import type { KeyRing } from '../src/tokens/seal.ts';
import { checkGrowth, openGrowthDatabase, seed, type GrowthDatabase, type Population } from './support/growth.ts';
import { bundledRelease } from '@rezics/definitions/bundled';
import { dropTestDatabase } from './support/drop-test-database.ts';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL must name the migrated test database');

const issuer = 'https://auth.example.test';
const audience = 'https://api.rezics.test';
const routeKey = new Uint8Array(32).fill(13);
const tokens: KeyRing = { current: 1, keys: new Map([[1, new Uint8Array(32).fill(9)]]) };
const accountId = newId(0x7130);
const accountRoute = routeOf(accountId)!;
const actor: AccountActor = {
  kind: 'account',
  accountId,
  clientId: 'growth-request-client',
  scopes: ['subject:create', 'subject:read'],
  requestedBy: null,
  authnEpoch: 1,
};
const ordinalsPerScale = 500;
const maximumSeed = 64 * ordinalsPerScale;
const seedDigest = Buffer.alloc(32, 7);
const dispatchedActions = new Set<string>();

type Anchor = { readonly id: string; readonly route: number; readonly partition: number };

let db: GrowthDatabase;
let kernel: ReturnType<typeof createKernel>;
let publicJwk: JWK;
let privateKey: CryptoKey;

function requestPopulation(name: string, hotPartition: number): Population {
  // This population matches create-subject, insert-facts, fence and Access account/grant SQL row shapes.
  const seedClient = `growth-seed-${name}`;
  return {
    name,
    hotPartition,
    hotShare: 1,
    rows: ({ ordinal, route }) => {
      const id = newId(route);
      const account = newId(route);
      const resource = newId(route);
      const transaction = newId(route);
      const position = ordinal + 2;
      const idempotencyKey = `${name}-${ordinal}`;
      const facts = itemFacts(id, { labels: { en: `Growth subject ${ordinal}` } }).map((fact) => ({
        route,
        subject_id: id,
        ...fact,
        recorded_transaction_id: transaction,
      }));
      return {
        'core.outbox': [
          {
            partition_no: hotPartition,
            position,
            event_seq: 0,
            event_count: 1,
            epoch: 1,
            id: newId(route),
            type: 'com.rezics.subject.created.v1',
            subject: id,
            data: { id },
          },
        ],
        'core.receipt': [
          {
            partition_no: hotPartition,
            principal_id: accountId,
            principal_kind: 'account',
            command_kind: 'subject.create',
            idempotency_key: idempotencyKey,
            request_digest: seedDigest,
            epoch: 1,
            position,
            transaction_id: transaction,
            response: {
              id,
              type: 'schema:Book',
              labels: { en: `Growth subject ${ordinal}` },
              descriptions: {},
              aliases: {},
              statements: {},
            },
          },
        ],
        'editorial.write_basis': [
          {
            partition_no: hotPartition,
            transaction_id: transaction,
            epoch: 1,
            position,
            principal_id: accountId,
            principal_kind: 'account',
            client_id: seedClient,
            requested_by: null,
          },
        ],
        'access.account': [
          {
            route,
            account_id: account,
            kind: 'actor',
            state: 'active',
            content_preferences: {},
            minimum_authn_epoch: 1,
            transaction_id: transaction,
          },
        ],
        'semantic.subject': [{ route, subject_id: id, type: 'schema:Book', recorded_transaction_id: transaction }],
        'semantic.fact': facts,
        'access.resource_grant': [
          {
            route,
            resource_id: resource,
            subject_id: account,
            subject_role: '',
            action: 'subject:read',
            valid: '(,)',
            transaction_id: transaction,
            subject_kind: 'identity',
          },
        ],
        'access.resource_role_grant': [
          {
            route,
            resource_id: resource,
            subject_kind: 'identity',
            subject_id: account,
            subject_role: 'member',
            grant_role: 'subject_reader',
            valid: '(,)',
            transaction_id: transaction,
          },
        ],
        'access.resource_denial': [
          {
            route,
            resource_id: resource,
            subject_id: account,
            subject_role: '',
            action: 'subject:read',
            reason: 'resource',
            valid: '(,)',
            transaction_id: transaction,
          },
        ],
      };
    },
    finish: async (admin, range) => {
      await admin.query(
        `UPDATE core.partition p SET position = GREATEST(p.position, v.position)
         FROM (SELECT partition_no, max(position)::bigint AS position FROM core.outbox
               WHERE partition_no = $3 AND position >= $1 + 2 AND position < $2 + 2
               GROUP BY partition_no) v
         WHERE p.partition_no = v.partition_no`,
        [range.from, range.to, hotPartition],
      );
    },
  };
}

async function grow(database: GrowthDatabase, population: Population, scale: number, previous: number): Promise<void> {
  await seed({ pool: database.pool, admin: database.admin }, population, {
    from: previous * ordinalsPerScale,
    to: scale * ordinalsPerScale,
  });
}

function hotPartitionFor(anchorPartition: number, accountPartition: number): number {
  let hotPartition = (anchorPartition + 1) % 4096;
  while (hotPartition === accountPartition) hotPartition = (hotPartition + 1) % 4096;
  return hotPartition;
}

function keyForPartition(partition: number): string {
  const prefix = `growth-request-${randomUUID()}`;
  for (let attempt = 0; ; attempt++) {
    const key = `${prefix}-${attempt}`;
    const route = anchorRoute(routeKey, `${actor.accountId}\nsubject.create\n${key}`);
    if (partitionOf(route) === partition) return key;
  }
}

async function createAnchor(label: string, partition: number): Promise<Anchor> {
  const idempotencyKey = keyForPartition(partition);
  const writerKernel = createKernel({
    pool: db.pool,
    access: authenticatedAccess,
    routeKey,
    tokens,
    writeRate: {
      async spend() {
        return { allowed: true };
      },
    },
  });
  const response = await writerKernel.handle(
    new Request('http://kernel.test/v1/subjects', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${await bearerToken('subject:create')}`,
        [IDEMPOTENCY_HEADER]: `"${idempotencyKey}"`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ type: 'schema:Book', labels: { en: label } }),
    }),
  );
  expect(response.status).toBe(201);
  const body = (await response.json()) as { subject: { id: string } };
  const id = body.subject.id;
  const route = routeOf(id);
  if (route === null) throw new Error('The production subject route was not encoded in its id');
  const anchor = { id, route, partition: partitionOf(route) };
  return anchor;
}

async function seedAccount(): Promise<void> {
  // This population matches active actor rows read by account-read.sql.
  const accountPopulation: Population = {
    name: `request-anchor-account-${randomUUID()}`,
    hotPartition: partitionOf(accountRoute),
    hotShare: 1,
    rows: () => ({
      'access.account': [
        {
          route: accountRoute,
          account_id: accountId,
          kind: 'actor',
          state: 'active',
          content_preferences: {},
          minimum_authn_epoch: 1,
          membership_inverse_complete: true,
          transaction_id: accountId,
        },
      ],
    }),
  };
  await seed({ pool: db.pool, admin: db.admin }, accountPopulation, { from: 0, to: 1 });
}

async function seedAnchorAuthorization(anchor: Anchor): Promise<void> {
  // This population matches the direct resource grant row written by grant-create.sql.
  const grantPopulation: Population = {
    name: `request-anchor-grant-${randomUUID()}`,
    hotPartition: anchor.partition,
    hotShare: 1,
    rows: () => ({
      'access.resource_grant': [
        {
          route: anchor.route,
          resource_id: anchor.id,
          subject_id: accountId,
          subject_role: '',
          action: 'subject:read',
          valid: '(,)',
          transaction_id: newId(anchor.route),
          subject_kind: 'identity',
        },
      ],
    }),
  };
  await seed({ pool: db.pool, admin: db.admin }, grantPopulation, { from: 0, to: 1 });
}

async function bearerToken(scope = 'subject:read'): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({
    client_id: actor.clientId,
    scope,
    authn_epoch: actor.authnEpoch,
    auth_time: now,
    amr: ['pwd'],
  })
    .setProtectedHeader({ alg: 'ES256', kid: 'growth-request-key', typ: 'at+jwt' })
    .setIssuer(issuer)
    .setAudience(audience)
    .setSubject(accountId)
    .setIssuedAt(now)
    .setExpirationTime(now + 180)
    .sign(privateKey);
}

async function getSubject(id: string, token: string, session?: string): Promise<Response> {
  const headers: Record<string, string> = { authorization: `Bearer ${token}` };
  if (session !== undefined) headers[SESSION_HEADER] = session;
  return kernel.handle(new Request(`http://kernel.test/v1/subjects/${id}`, { headers }));
}

function sessionInput(anchor: Anchor, count: number): string {
  const components: SessionComponent[] = Array.from({ length: count }, (_, index) => ({
    partition: (anchor.partition + index + 1) % 4096,
    epoch: 1,
    position: BigInt(index + 1),
  }));
  return encodeSession(tokens, `account:${accountId}`, components);
}

const templateUrl = new URL(databaseUrl);
const adminUrl = new URL(databaseUrl);
adminUrl.pathname = '/postgres';
const databases = new pg.Pool({ connectionString: adminUrl.href, max: 1 });
let fixtureDatabase: string | undefined;
const authenticatedAccess: AccessFactory = (config) =>
  createAccess({
    ...config,
    auth: {
      issuer,
      audience,
      jwksUrl: `${issuer}/.well-known/jwks.json`,
      async fetch() {
        return Response.json({ keys: [publicJwk] });
      },
    },
  });

beforeAll(async () => {
  const pair = await generateKeyPair('ES256', { extractable: true });
  privateKey = pair.privateKey;
  publicJwk = { ...(await exportJWK(pair.publicKey)), kid: 'growth-request-key', alg: 'ES256' };
});

beforeEach(async () => {
  // Semantic facts and revisions are immutable. Isolate each population in a migrated database instead of deleting
  // facts between tests or leaving a previous scale's population in the next check.
  const name = `request_growth_${randomUUID().replaceAll('-', '')}`;
  const template = decodeURIComponent(templateUrl.pathname.slice(1)).replaceAll('"', '""');
  await databases.query(`CREATE DATABASE ${name} TEMPLATE "${template}"`);
  fixtureDatabase = name;
  const url = new URL(databaseUrl);
  url.pathname = `/${name}`;
  db = await openGrowthDatabase(url.href);
  await bootstrapRelease(db.pool, bundledRelease);
  await seedAccount();
  await db.admin.query(
    `INSERT INTO access.resource_grant
       (route, resource_id, subject_id, subject_role, action, valid, transaction_id)
     VALUES (0, $1, $2, '', 'subject:create', '(,)', $2)`,
    [GLOBAL_CONTEXT, accountId],
  );
  const access: AccessFactory = (config) => {
    const permissions = authenticatedAccess(config);
    return {
      ...permissions,
      async prepare(preparedActor, action, resource, context) {
        dispatchedActions.add(action);
        return permissions.prepare!(preparedActor, action, resource, context);
      },
      async authorize(client, checkedActor, action, resource, evidence, time) {
        dispatchedActions.add(action);
        // Keep the real Access check in the measured request; the wrapper only records dispatch.
        return permissions.authorize!(client, checkedActor, action, resource, evidence, time);
      },
    };
  };
  kernel = createKernel({ pool: db.pool, access, routeKey, tokens });
});

afterEach(async () => {
  try {
    await db?.close();
  } finally {
    if (fixtureDatabase) {
      await dropTestDatabase(databases, fixtureDatabase);
      fixtureDatabase = undefined;
    }
  }
  dispatchedActions.clear();
});

afterAll(async () => {
  await databases.end();
});

test('Admission stays within its bound as N grows', async () => {
  const population = requestPopulation(`request-admission-${randomUUID()}`, 4095);
  await createAnchor('Admission growth anchor', population.hotPartition);
  const anchor = await kernel.handle(new Request('http://kernel.test/health'));
  expect(anchor.status).toBe(200);
  expect(await anchor.json()).toEqual({ status: 'ok' });
  const report = await checkGrowth(db, {
    name: 'Admission stays within its bound as N grows',
    bounds: { rows: 'constant', blocks: 'constant', statements: 'constant' },
    grow: (growthDb, scale, previous) => grow(growthDb, population, scale, previous),
    operation: async () => {
      const response = await kernel.handle(new Request('http://kernel.test/health'));
      if (!response.ok) throw new Error(`Health request failed with ${response.status}`);
      return response.json();
    },
  });
  expect(report.samples.map(({ scale }) => scale)).toEqual([1, 8, 64]);
}, 90_000);

test('Request access dispatch stays within its bound as N grows', async () => {
  const anchor = await createAnchor('Access dispatch anchor', 40);
  await seedAnchorAuthorization(anchor);
  const token = await bearerToken();
  const hotPartition = hotPartitionFor(anchor.partition, partitionOf(accountRoute));
  const population = requestPopulation(`request-access-${randomUUID()}`, hotPartition);
  await createAnchor('Request access growth anchor', hotPartition);
  const report = await checkGrowth(db, {
    name: 'Request access dispatch stays within its bound as N grows',
    bounds: { rows: 'constant', blocks: 'logarithmic', statements: 'constant' },
    grow: (growthDb, scale, previous) => grow(growthDb, population, scale, previous),
    operation: async () => {
      const response = await getSubject(anchor.id, token);
      if (!response.ok) throw new Error(`Subject request failed with ${response.status}: ${await response.text()}`);
      return response.json();
    },
  });
  expect(report.samples.map(({ scale }) => scale)).toEqual([1, 8, 64]);
  expect(dispatchedActions).toContain('subject:read');
}, 90_000);

test('Session header stays within its bound as j grows', async () => {
  const anchor = await createAnchor('Session header anchor', 40);
  await seedAnchorAuthorization(anchor);
  const token = await bearerToken();
  const population = requestPopulation(
    `request-session-${randomUUID()}`,
    hotPartitionFor(anchor.partition, partitionOf(accountRoute)),
  );
  await createAnchor('Session header growth anchor', population.hotPartition);
  await seed({ pool: db.pool, admin: db.admin }, population, { from: 0, to: maximumSeed });
  const report = await checkGrowth(db, {
    name: 'Session header stays within its bound as j grows',
    scales: [2, 8, 32],
    bounds: { rows: 'constant', blocks: 'constant', statements: 'constant' },
    grow: async () => {},
    operation: async (_growthDb, count) => {
      const response = await getSubject(anchor.id, token, sessionInput(anchor, count));
      if (!response.ok) throw new Error(`Subject request failed with ${response.status}: ${await response.text()}`);
      if (response.headers.get(SESSION_HEADER) === null) throw new Error('The session response header was missing');
      return response.json();
    },
  });
  expect(report.samples.map(({ scale }) => scale)).toEqual([2, 8, 32]);
  expect(dispatchedActions).toContain('subject:read');
}, 90_000);

test('Cursors and seal stays within its bound as N grows', async () => {
  const partition = 40;
  const pagePopulation: Population = {
    name: `request-cursor-page-${randomUUID()}`,
    hotPartition: partition,
    hotShare: 1,
    rows: ({ ordinal, route }) => {
      const id = newId(route);
      const transaction = newId(route);
      return {
        'semantic.subject': [{ route, subject_id: id, type: 'schema:Book', recorded_transaction_id: transaction }],
        'semantic.fact': itemFacts(id, { labels: { en: `Cursor page subject ${ordinal}` } }).map((fact) => ({
          route,
          subject_id: id,
          ...fact,
          recorded_transaction_id: transaction,
        })),
      };
    },
  };
  await seed({ pool: db.pool, admin: db.admin }, pagePopulation, { from: 0, to: 2 });
  const population: Population = {
    name: `request-cursor-growth-${randomUUID()}`,
    hotPartition: (partition + 1) % 4096,
    hotShare: 1,
    rows: ({ ordinal, route }) => {
      const id = newId(route);
      const transaction = newId(route);
      return {
        'semantic.subject': [{ route, subject_id: id, type: 'schema:Book', recorded_transaction_id: transaction }],
        'semantic.fact': itemFacts(id, { labels: { en: `Cursor growth subject ${ordinal}` } }).map((fact) => ({
          route,
          subject_id: id,
          ...fact,
          recorded_transaction_id: transaction,
        })),
      };
    },
  };
  const report = await checkGrowth(db, {
    name: 'Cursors and seal stays within its bound as N grows',
    bounds: { rows: 'constant', blocks: 'constant', statements: 'constant' },
    grow: (growthDb, scale, previous) => grow(growthDb, population, scale, previous),
    operation: async () => {
      const firstPage = await pageSubjects(db.pool, tokens, { partition, size: 1 });
      if (!firstPage?.next) throw new Error('The first subject page did not return a cursor');
      const cursor = firstPage.next;
      const nextPage = await pageSubjects(db.pool, tokens, { partition, size: 1, cursor });
      if (!nextPage || nextPage.subjects.length !== 1) throw new Error('The cursor did not return the next subject');
      return nextPage;
    },
  });
  expect(report.samples.map(({ scale }) => scale)).toEqual([1, 8, 64]);
}, 90_000);
