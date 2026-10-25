import { afterAll, beforeAll, expect, test } from 'bun:test';
import {
  createAuthHost,
  createNativeWorkflowProofPorts,
  createProvisioningEvidenceVerifier,
  type AuthService,
} from '@rezics/auth';
import { bundledRelease } from '@rezics/definitions/bundled';
import { exportJWK, generateKeyPair } from 'jose';
import { Pool } from 'pg';
import { migrate as migrateAuth } from '../../../auth/scripts/database.ts';
import { createAuthBindings } from '../../src/access/auth-bindings.ts';
import { bootstrapGovernance, PLATFORM_RESOURCE } from '../../src/access/bootstrap-governance.ts';
import { createAccess } from '../../src/access/index.ts';
import { createLifecycleInternals } from '../../src/access/lifecycle.ts';
import { createRegistrationProofBindings } from '../../src/access/registration-proof.ts';
import { createWriteRateLimiter } from '../../src/access/write-rate.ts';
import { createPool, withConnection } from '../../src/database/pool.ts';
import { createKernel } from '../../src/http/kernel.ts';
import { actionCatalogue, IDEMPOTENCY_HEADER } from '../../src/http/request.ts';
import { anchorRoute, newId, partitionOf, routeOf } from '../../src/route/route.ts';
import { bootstrapRelease, GLOBAL_CONTEXT } from '../../src/semantic/definitions.ts';
import { capture, checkGrowth, openGrowthDatabase, seed, type Population } from '../support/growth.ts';

const issuer = 'https://realm-votes.auth.test';
const audience = 'https://realm-votes.api.test';
const password = 'realm votes registration password with enough entropy';
const routeKey = new Uint8Array(32).fill(97);
const tokens = { current: 1, keys: new Map([[1, new Uint8Array(32).fill(98)]]) };
const scales = [2048, 8192, 32768] as const;
const bounds = { rows: 'constant', blocks: 'logarithmic', statements: 'constant' } as const;

let admin: Pool;
let pool: Pool;
let authPool: Pool;
let authDatabaseName = '';
let host: Awaited<ReturnType<typeof createAuthHost>>;
let service: AuthService;
let kernel: ReturnType<typeof createKernel>;
let governance: Person;
let contextAuthor: Person;
let createHolder: Person;
let updateHolder: Person;
let growthHolder: Person;
let classificationContext: { id: string };

type Person = { accountId: string; bearer: string };
type RealmBody = { realmId: string; headRevisionId: string; predecessor: string | null };
type Call = { bearer?: string; body?: unknown; key?: string; headers?: Record<string, string> };
type Placed = { key: string; route: number; partition: number };

async function issue(email: string, scope: string[]) {
  const signed = await service.handler(
    new Request(`${issuer}/signin`, {
      method: 'POST',
      headers: { origin: issuer, 'content-type': 'application/json' },
      body: JSON.stringify({ email, password, client_id: 'realm-votes-client', scope }),
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

async function person(name: string, scope: string[]): Promise<Person> {
  const result = await host.workflows.register({
    key: name,
    handle: name,
    email: `${name}@realm-votes.test`,
    password,
  });
  return { accountId: result.accountId, bearer: await issue(`${name}@realm-votes.test`, scope) };
}

async function call(method: string, path: string, options: Call = {}) {
  const headers = new Headers(options.headers);
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
    value = { raw: text };
  }
  return { response, value };
}

async function grant(accountId: string, actions: string[]) {
  const body = {
    resource: PLATFORM_RESOURCE,
    subject: { kind: 'account' as const, id: accountId },
    actions,
    valid: '(,)',
  };
  const result = await call('POST', '/v1/grants', { bearer: governance.bearer, key: crypto.randomUUID(), body });
  expect(result.response.status).toBe(201);
  expect(result.value).toEqual({ grant: body });
}

async function createSpace(holder: Person, title: string, key: string = crypto.randomUUID()) {
  const result = await call('POST', '/v1/spaces', {
    bearer: holder.bearer,
    key,
    body: { title, summary: `${title} summary` },
  });
  if (result.response.status !== 201) throw new Error(`space create failed: ${JSON.stringify(result.value)}`);
  return result.value.space as { spaceId: string };
}

async function createRealm(holder: Person, spaceId: string, title: string) {
  const result = await call('POST', '/v1/realms', {
    bearer: holder.bearer,
    key: crypto.randomUUID(),
    body: {
      spaceId,
      title,
      summary: `${title} summary`,
      visibility: 'public',
      contextId: classificationContext.id,
    },
  });
  if (result.response.status !== 201) throw new Error(`realm create failed: ${JSON.stringify(result.value)}`);
  return result.value.realm as RealmBody;
}

async function updateRealm(holder: Person, realm: RealmBody, summary: string) {
  const result = await call('PATCH', `/v1/realms/${realm.realmId}`, {
    bearer: holder.bearer,
    key: crypto.randomUUID(),
    headers: { 'if-match': JSON.stringify(realm.headRevisionId) },
    body: { summary },
  });
  if (result.response.status !== 200) throw new Error(`realm update failed: ${JSON.stringify(result.value)}`);
  return result.value.realm as RealmBody;
}

async function readVotes(realmIds: readonly string[]) {
  const { readRealmVotes } = await import('../../src/community/realm-votes.ts');
  return withConnection(pool, (client) => readRealmVotes(client, realmIds));
}

function placedKeys(accountId: string): Placed[] {
  const byPartition = new Map<number, Placed[]>();
  for (let n = 0; n < 200_000; n++) {
    const key = `realm-votes-growth-${n}`;
    const route = anchorRoute(routeKey, `${accountId}\ncommunity.space.create\n${key}`);
    const partition = partitionOf(route);
    const group = byPartition.get(partition) ?? [];
    group.push({ key, route, partition });
    byPartition.set(partition, group);
    const shared = [...byPartition.values()].find((items) => items.length >= 2);
    if (!shared) continue;
    const others = [...byPartition.values()].filter((items) => items !== shared && items.length >= 1);
    if (others.length >= 2) return [shared[0]!, shared[1]!, others[0]![0]!, others[1]![0]!];
  }
  throw new Error('Could not place Realm routes across three partitions');
}

beforeAll(async () => {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is required');
  admin = new Pool({ connectionString: url });
  pool = createPool(url);
  pool.options.max = 1;
  authDatabaseName = `realm_votes_auth_${process.pid}`;
  await admin.query(`CREATE DATABASE ${authDatabaseName}`);
  const authUrl = new URL(url);
  authUrl.pathname = `/${authDatabaseName}`;
  migrateAuth(authUrl.href);
  authPool = new Pool({ connectionString: authUrl.href });
  const signingKey = {
    ...(await exportJWK((await generateKeyPair('ES256', { extractable: true })).privateKey)),
    kid: 'realm-votes',
  };
  kernel = createKernel({
    pool,
    routeKey,
    tokens,
    access: (config) =>
      createAccess({
        ...config,
        auth: {
          issuer,
          audience,
          jwksUrl: `${issuer}/.well-known/jwks.json`,
          fetch: async () => service.handler(new Request(`${issuer}/.well-known/jwks.json`)),
        },
      }),
    writeRate: createWriteRateLimiter({
      secret: 'realm-votes-private-write-rate-secret-32b',
      overrides: JSON.stringify({
        anonymous: { write: { maximum: 100000, seconds: 86400 } },
        'new-account': { write: { maximum: 100000, seconds: 86400 } },
      }),
    }),
  });
  const scopes = [...actionCatalogue(kernel).keys()].filter((scope) => scope !== 'media:complete');
  const proofs = createNativeWorkflowProofPorts({ database: authPool });
  const registration = createRegistrationProofBindings({ pool, referenceKeys: tokens });
  const provisioning = createProvisioningEvidenceVerifier({ database: authPool });
  const internal = createLifecycleInternals({
    pool,
    routeKey,
    provisioningEvidence: (evidence) => provisioning.resolve(evidence),
    recoveryEvidence: async () => null,
  });
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
    secret: 'realm-votes-auth-persistent-secret-32bytes',
    signing: { activeKid: signingKey.kid, privateKeys: [signingKey] },
    trustedAccess: createAuthBindings({
      pool,
      ...registration,
      verifyPendingIdentity: registration.verifyNativePendingIdentity,
    }),
    access: registrationPorts,
    stagingKey: new Uint8Array(32).fill(99),
    maintenanceSchedule: '0 0 1 1 *',
    executorId: 'realm-votes-executor',
  });
  service = host.service;
  await service.internal.registerClient({ clientId: 'realm-votes-client', firstParty: true, scopes });
  await host.start();
  governance = await person('realm_votes_governance', scopes);
  contextAuthor = await person('realm_votes_context', scopes);
  createHolder = await person('realm_votes_create', scopes);
  updateHolder = await person('realm_votes_update', scopes);
  growthHolder = await person('realm_votes_growth', scopes);
  await bootstrapGovernance(pool, governance.accountId);
  await bootstrapRelease(pool, bundledRelease);
  await grant(contextAuthor.accountId, ['context:create']);
  const context = await call('POST', '/v1/contexts', {
    bearer: contextAuthor.bearer,
    key: crypto.randomUUID(),
    body: { labels: { en: 'Realm vote classification' } },
  });
  expect(context.response.status).toBe(201);
  classificationContext = (context.value as { context: { id: string } }).context;
}, 120_000);

afterAll(async () => {
  await host?.stop();
  if (authDatabaseName) await admin?.query(`DROP DATABASE IF EXISTS ${authDatabaseName} WITH (FORCE)`);
  await pool?.end();
  await admin?.end();
});

test.serial('a new Realm counts upvote as +1 and downvote as -1', async () => {
  await grant(createHolder.accountId, ['realm:create', 'space:create']);
  const space = await createSpace(createHolder, 'Vote create host');
  const realm = await createRealm(createHolder, space.spaceId, 'Counted Realm');
  const route = routeOf(realm.realmId);
  expect(route).not.toBeNull();
  const unknown = newId(route!);
  const votes = await readVotes([realm.realmId, unknown]);
  expect(votes.get(realm.realmId)).toEqual({ upvote: 1, downvote: -1 });
  expect(votes.has(unknown)).toBe(false);

  await expect(
    admin.query(`UPDATE community.realm SET votes = '{"upvote": 2}'::jsonb WHERE realm_id = $1`, [realm.realmId]),
  ).rejects.toMatchObject({ code: '23514' });
  await expect(
    admin.query(`UPDATE community.realm SET votes = '{"nope": 1}'::jsonb WHERE realm_id = $1`, [realm.realmId]),
  ).rejects.toMatchObject({ code: '23514' });
  await expect(
    admin.query(`UPDATE community.realm SET votes = '[]'::jsonb WHERE realm_id = $1`, [realm.realmId]),
  ).rejects.toMatchObject({ code: '23514' });
  const unchanged = await readVotes([realm.realmId]);
  expect(unchanged.get(realm.realmId)).toEqual({ upvote: 1, downvote: -1 });

  await admin.query(`UPDATE community.realm SET votes = '{}'::jsonb WHERE realm_id = $1`, [realm.realmId]);
  const cleared = await readVotes([realm.realmId]);
  expect(cleared.get(realm.realmId)).toEqual({});
});

test.serial('a Realm update keeps its votes on the new head', async () => {
  await grant(updateHolder.accountId, ['realm:create', 'space:create']);
  const space = await createSpace(updateHolder, 'Vote update host');
  const created = await createRealm(updateHolder, space.spaceId, 'Updated Realm');
  const moved = await updateRealm(updateHolder, created, 'Head moved once');
  expect(moved.headRevisionId).not.toBe(created.headRevisionId);
  expect(moved.predecessor).toBe(created.headRevisionId);

  const kept = await readVotes([created.realmId]);
  expect(kept.get(created.realmId)).toEqual({ upvote: 1, downvote: -1 });
  const firstHead = await admin.query(`SELECT votes FROM community.realm_revision WHERE revision_id = $1`, [
    moved.headRevisionId,
  ]);
  expect(firstHead.rows[0]?.votes).toEqual({ upvote: 1, downvote: -1 });

  const route = routeOf(created.realmId);
  expect(route).not.toBeNull();
  const customRevisionId = newId(route!);
  const custom = { insightful: 1, downvote: -1 };
  const installed = await admin.query(
    `WITH head AS (
       SELECT route, realm_id, revision_id, title, summary, visibility, context_id, created_at, author
       FROM community.realm_revision
       WHERE route = $1 AND realm_id = $2 AND revision_id = $3
     ), inserted AS (
       INSERT INTO community.realm_revision (
         route, realm_id, revision_id, predecessor, title, summary, visibility, context_id, created_at, author, votes
       )
       SELECT route, realm_id, $4::uuid, revision_id, title, summary, visibility, context_id, created_at, author, $5::jsonb
       FROM head
       RETURNING revision_id
     )
     UPDATE community.realm AS realm
     SET head_revision_id = inserted.revision_id, votes = $5::jsonb
     FROM inserted, head
     WHERE realm.route = head.route
       AND realm.realm_id = head.realm_id
       AND realm.head_revision_id = head.revision_id
     RETURNING realm.head_revision_id::text AS head_revision_id`,
    [route, created.realmId, moved.headRevisionId, customRevisionId, JSON.stringify(custom)],
  );
  expect(installed.rows[0]?.head_revision_id).toBe(customRevisionId);

  const again = await updateRealm(updateHolder, { ...created, headRevisionId: customRevisionId }, 'Head moved twice');
  expect(again.headRevisionId).not.toBe(customRevisionId);
  expect(again.predecessor).toBe(customRevisionId);
  const stored = await readVotes([created.realmId]);
  expect(stored.get(created.realmId)).toEqual({ insightful: 1, downvote: -1 });
  const realmRow = await admin.query(`SELECT votes FROM community.realm WHERE realm_id = $1`, [created.realmId]);
  const revisionRow = await admin.query(`SELECT votes FROM community.realm_revision WHERE revision_id = $1`, [
    again.headRevisionId,
  ]);
  expect(realmRow.rows[0]?.votes).toEqual({ insightful: 1, downvote: -1 });
  expect(revisionRow.rows[0]?.votes).toEqual({ insightful: 1, downvote: -1 });
});

test.serial(
  'readRealmVotes reads many Realms with one statement per partition and stays within its bound as Realms grow',
  async () => {
    await grant(growthHolder.accountId, ['realm:create', 'space:create']);
    const placed = placedKeys(growthHolder.accountId);
    const realms: RealmBody[] = [];
    for (const [index, slot] of placed.entries()) {
      const space = await createSpace(growthHolder, `Vote growth host ${index}`, slot.key);
      const realm = await createRealm(growthHolder, space.spaceId, `Vote growth Realm ${index}`);
      expect(routeOf(realm.realmId)).toBe(slot.route);
      realms.push(realm);
    }
    const partitions = new Set(placed.map((slot) => slot.partition));
    expect(partitions.size).toBe(3);
    const shared = placed[0]!.partition;
    expect(placed.filter((slot) => slot.partition === shared)).toHaveLength(2);
    const unknown = newId(placed[0]!.route);
    const ids = [...realms.map((realm) => realm.realmId), unknown];

    const { readRealmVotes } = await import('../../src/community/realm-votes.ts');
    const db = await openGrowthDatabase();
    try {
      const found = await withConnection(db.pool, (client) => readRealmVotes(client, ids));
      expect(found.size).toBe(realms.length);
      expect(found.has(unknown)).toBe(false);
      for (const realm of realms) expect(found.get(realm.realmId)).toEqual({ upvote: 1, downvote: -1 });
      const empty = await capture(db, () => withConnection(db.pool, (client) => readRealmVotes(client, [])));
      expect(empty.value.size).toBe(0);
      expect(empty.capture.statements).toHaveLength(0);

      const population: Population = {
        name: `realm-votes-${crypto.randomUUID()}`,
        hotPartition: shared,
        hotShare: 1,
        rows: ({ route }) => {
          const spaceId = newId(route);
          const realmId = newId(route);
          const revisionId = newId(route);
          const at = '2026-10-25T00:00:00.000Z';
          return {
            'community.space': [
              {
                route,
                space_id: spaceId,
                state: 'active',
                head_revision_id: revisionId,
                created_at: at,
                creator: growthHolder.accountId,
              },
            ],
            'community.space_revision': [
              {
                route,
                space_id: spaceId,
                revision_id: revisionId,
                predecessor: null,
                title: 'Neighbour',
                summary: '',
                created_at: at,
                author: growthHolder.accountId,
              },
            ],
            'community.realm': [
              {
                route,
                realm_id: realmId,
                space_id: spaceId,
                state: 'active',
                visibility: 'public',
                context_id: GLOBAL_CONTEXT,
                head_revision_id: revisionId,
                created_at: at,
                creator: growthHolder.accountId,
              },
            ],
            'community.realm_revision': [
              {
                route,
                realm_id: realmId,
                revision_id: revisionId,
                predecessor: null,
                title: 'Neighbour',
                summary: '',
                visibility: 'public',
                context_id: GLOBAL_CONTEXT,
                created_at: at,
                author: growthHolder.accountId,
              },
            ],
          };
        },
      };
      const report = await checkGrowth(db, {
        name: 'Read Realm votes',
        scales: [...scales],
        bounds,
        async grow(database, scale, previous) {
          const from = previous === 0 ? 0 : previous - realms.length;
          await seed({ pool: database.pool, admin: database.admin }, population, { from, to: scale - realms.length });
        },
        async operation(database) {
          return withConnection(database.pool, async (client) => {
            const votes = await readRealmVotes(client, ids);
            expect(votes.size).toBe(realms.length);
            expect(votes.has(unknown)).toBe(false);
            for (const realm of realms) expect(votes.get(realm.realmId)).toEqual({ upvote: 1, downvote: -1 });
            return votes.size;
          });
        },
      });
      expect(report.samples.map((sample) => sample.scale)).toEqual([...scales]);
      for (const sample of report.samples) {
        expect(sample.cost.statements).toBe(partitions.size);
        expect(sample.cost.statements).toBeLessThan(ids.length);
        expect(sample.cost.rows).toBe(realms.length);
        const relation = sample.cost.relations?.['community.realm'];
        expect(relation).toBeDefined();
        expect(relation?.sequentialScans).toBe(0);
      }
      const counted = await db.admin.query<{ realms: number }>(
        'SELECT count(*)::integer AS realms FROM community.realm',
      );
      expect(counted.rows[0]!.realms).toBeGreaterThanOrEqual(scales[2]);
    } finally {
      await db.close();
    }
  },
  180_000,
);
