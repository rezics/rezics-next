import { productionActions } from '../support/production-actions.ts';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { checkGrowth, openGrowthDatabase, seed, type GrowthDatabase, type Population } from '../support/growth.ts';
import { createAuthService } from '@rezics/auth';
import { exportJWK, generateKeyPair } from 'jose';
import { Pool } from 'pg';
import { migrate as migrateAuth } from '../../../auth/scripts/database.ts';
import { createAccess } from '../../src/access/index.ts';
import { readAccount } from '../../src/access/account-data.ts';
import { type AccountActor } from '../../src/request/access.ts';
import { newId, partitionOf, routeOf } from '../../src/route/route.ts';
import { GLOBAL_CONTEXT } from '../../src/semantic/definitions.ts';
import { trustedAccessPorts } from '../support/trusted-access.ts';
import { dropTestDatabase } from '../support/drop-test-database.ts';

const routeKey = new Uint8Array(32).fill(37);
const root = { route: 0, id: GLOBAL_CONTEXT };
const input = {
  title: 'First Realm',
  summary: 'A community',
  visibility: 'protected' as const,
  contextId: GLOBAL_CONTEXT,
};
const context = (idempotencyKey: string = randomUUID()) => ({ idempotencyKey, deadline: Date.now() + 90_000 });
const pageLimit = 2;

// Privileged setup only; commands use genuine Auth tokens and production Access.
async function fixture(pool: Pool, admin: Pool) {
  const url = new URL(process.env.DATABASE_URL!);
  const database = `community_auth_${process.pid}`;
  await admin.query(`CREATE DATABASE ${database}`);
  url.pathname = `/${database}`;
  migrateAuth(url.href);
  const authPool = new Pool({ connectionString: url.href });
  const issuer = 'https://community.auth.test';
  const signingKey = {
    ...(await exportJWK((await generateKeyPair('ES256', { extractable: true })).privateKey)),
    kid: 'community',
  };
  const ids = [newId(0x1234), newId(0x2345)];
  const approvals = new Set(ids);
  const actions = [
    'space:create',
    'space:manage',
    'space:read',
    'realm:create',
    'realm:manage',
    'realm:read',
    'realm:publish',
    'context:read',
    'subject:read',
  ];
  const password = 'community test password with enough entropy';
  const auth = await createAuthService({
    database: authPool,
    issuer,
    audience: 'https://community.api.test',
    secret: 'community-test-secret-with-at-least-32-bytes',
    signing: { activeKid: signingKey.kid, privateKeys: [signingKey] },
    trustedAccess: trustedAccessPorts({
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
        if (!approvals.delete(reference)) throw new Error('Unknown fixture provisioning reference');
        return { accountId: reference };
      },
    }),
  });
  await auth.internal.registerClient({ clientId: 'community-test', firstParty: true, scopes: actions });
  const access = createAccess({
    actions: productionActions(),
    auth: {
      issuer,
      audience: 'https://community.api.test',
      jwksUrl: `${issuer}/.well-known/jwks.json`,
      fetch: async (url, init) => auth.handler(new Request(url, init)),
    },
  });
  const actors: AccountActor[] = [];
  const tokens: string[] = [];
  for (const id of ids) {
    await admin.query(
      "INSERT INTO access.account (route, account_id, kind, state, transaction_id) VALUES ($1,$2,'actor','pending',$2)",
      [routeOf(id), id],
    );
    await auth.internal.provisionPassword({ authorization: id, email: `${id}@community.test`, password });
    await admin.query("UPDATE access.account SET state='active' WHERE route=$1 AND account_id=$2", [routeOf(id), id]);
    const signin = await auth.handler(
      new Request(`${issuer}/signin`, {
        method: 'POST',
        headers: { origin: issuer, 'content-type': 'application/json' },
        body: JSON.stringify({ email: `${id}@community.test`, password, client_id: 'community-test', scope: actions }),
      }),
    );
    expect(signin.status).toBe(200);
    const cookie = signin.headers
      .getSetCookie()
      .map((value) => value.split(';')[0])
      .join('; ');
    const issued = await auth.handler(
      new Request(`${issuer}/token`, {
        method: 'POST',
        headers: { origin: issuer, 'content-type': 'application/json', cookie },
        body: '{}',
      }),
    );
    expect(issued.status).toBe(200);
    const token = ((await issued.json()) as { access_token: string }).access_token;
    tokens.push(token);
    const actor = await access.authenticate(token, { pool, deadline: Date.now() + 600_000 });
    if (actor.kind !== 'account') throw new Error('Auth did not issue an account actor');
    actors.push(actor);
  }
  async function grant(id: string, target = root, action = 'space:create') {
    await admin.query(
      "INSERT INTO access.resource_grant (route,resource_id,subject_id,action,valid,transaction_id) VALUES ($1,$2,$3,$4,'(,)'::tstzrange,$3) ON CONFLICT DO NOTHING",
      [target.route, target.id, id, action],
    );
  }
  return {
    access,
    actor: actors[0]!,
    token: tokens[0]!,
    grant,
    async close() {
      await authPool.end();
      await dropTestDatabase(admin, database);
    },
  };
}

let db: GrowthDatabase;
let f: Awaited<ReturnType<typeof fixture>>;
let publisher: AccountActor;
let space: typeof import('../../src/community/space.ts');
let realm: typeof import('../../src/community/realm.ts');
let publication: typeof import('../../src/community/publication.ts');
const scales: [number, number, number] = [256, 1024, 4096];
// Keep 2,048 seeded rows per relation at the smallest growth scale.
const populationMultiplier = 8;
const bounds = { rows: 'constant', blocks: 'logarithmic', statements: 'constant' } as const;
beforeAll(async () => {
  db = await openGrowthDatabase();
  db.pool.options.max = 1;
  f = await fixture(db.pool, db.admin);
  publisher = f.actor;
  await f.grant(publisher.accountId);
  space = await import('../../src/community/space.ts');
  realm = await import('../../src/community/realm.ts');
  publication = await import('../../src/community/publication.ts');
  await f.grant(publisher.accountId, root, 'realm:create');
});
afterAll(async () => {
  await f?.close();
  await db?.close();
});
const deps = () => ({ pool: db.pool, access: f.access, routeKey });

function population(name: string, hotPartition: number, positionBase: number): Population {
  return {
    name,
    hotPartition,
    hotShare: 1,
    rows: ({ route, ordinal }) => {
      const spaceId = newId(route);
      const realmId = newId(route);
      const revisionId = newId(route);
      const subjectRoute = (route + 1 + (ordinal % 64)) % 65_536;
      const subjectId = newId(subjectRoute);
      const publicationId = newId(route);
      const at = new Date(Date.UTC(2024, 0, 1) + ordinal * 1000).toISOString();
      const transactionId = randomUUID();
      const position = positionBase + ordinal * 100 + 1;
      const value = { realmId, subjectId, publicationId };
      return {
        'community.space': [
          {
            route,
            space_id: spaceId,
            state: 'active',
            head_revision_id: revisionId,
            created_at: at,
            creator: publisher.accountId,
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
            author: publisher.accountId,
          },
        ],
        'community.realm': [
          {
            route,
            realm_id: realmId,
            space_id: spaceId,
            state: 'active',
            visibility: 'protected',
            context_id: GLOBAL_CONTEXT,
            head_revision_id: revisionId,
            created_at: at,
            creator: publisher.accountId,
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
            visibility: 'protected',
            context_id: GLOBAL_CONTEXT,
            created_at: at,
            author: publisher.accountId,
          },
        ],
        'semantic.subject': [
          { route: subjectRoute, subject_id: subjectId, type: 'schema:Book', recorded_transaction_id: subjectId },
        ],
        'community.publication': [
          {
            route,
            publication_id: publicationId,
            realm_id: realmId,
            subject_id: subjectId,
            verdict: 'adopt',
            predecessor: null,
            subject_revision_id: null,
            actor: publisher.accountId,
            created_at: at,
          },
        ],
        'community.publication_head': [
          {
            route,
            realm_id: realmId,
            subject_id: subjectId,
            publication_id: publicationId,
            verdict: 'adopt',
            published_at: at,
          },
        ],
        'core.receipt': [
          {
            partition_no: hotPartition,
            principal_kind: 'account',
            principal_id: publisher.accountId,
            command_kind: 'community.publication.publish',
            idempotency_key: `seed-${name}-${ordinal}`,
            request_digest: Buffer.alloc(32),
            epoch: 1,
            position,
            transaction_id: transactionId,
            response: value,
          },
        ],
        'core.outbox': [
          {
            partition_no: hotPartition,
            position,
            event_seq: 0,
            event_count: 1,
            epoch: 1,
            id: randomUUID(),
            type: 'com.rezics.community.publication.adopted.v1',
            subject: realmId,
            data: value,
          },
        ],
        'editorial.write_basis': [
          {
            partition_no: hotPartition,
            transaction_id: transactionId,
            epoch: 1,
            position,
            principal_kind: 'account',
            principal_id: publisher.accountId,
            client_id: publisher.clientId,
            requested_by: null,
            recorded_at: at,
          },
        ],
      };
    },
    async finish(admin) {
      await admin.query(
        'UPDATE core.partition SET position=(SELECT max(position) FROM core.outbox WHERE partition_no=$1) WHERE partition_no=$1',
        [hotPartition],
      );
    },
  };
}

async function refreshPublisher() {
  const actor = await f.access.authenticate(f.token, { pool: db.pool, deadline: Date.now() + 600_000 });
  if (actor.kind !== 'account') throw new Error('Auth did not issue an account actor');
  publisher = actor;
}
async function positionOf(partition: number) {
  return Number(
    (await db.admin.query('SELECT position FROM core.partition WHERE partition_no=$1', [partition])).rows[0].position,
  );
}

test(`publication writes and pages stay within their bound across growth scales ${scales.join(', ')}`, async () => {
  await db.admin.query(
    'TRUNCATE community.publication_head, community.publication, community.realm, community.realm_revision, community.space, community.space_revision, access.resource_initialization, access.resource_role_grant, core.receipt, core.outbox, editorial.write_basis CASCADE',
  );
  const host = await space.createSpace(deps(), publisher, { title: 'Host' }, context());
  const probe = await realm.createRealm(deps(), publisher, { ...input, spaceId: host.value.spaceId }, context());
  const realmId = probe.value.realmId;
  const route = routeOf(realmId)!;
  const hotPartition = partitionOf(route);
  await f.grant(publisher.accountId, { route, id: realmId }, 'realm:publish');
  const pageSubjects = [newId(0x4100), newId(0x4200), newId(0x4300)];
  for (const subjectId of pageSubjects) {
    await db.admin.query(
      "INSERT INTO semantic.subject (route, subject_id, type, recorded_transaction_id) VALUES ($1,$2,'schema:Book',$2)",
      [routeOf(subjectId), subjectId],
    );
    await publication.publish(deps(), publisher, { realmId, subjectId }, context());
  }
  const writeSubject = newId(0x4400);
  await db.admin.query(
    "INSERT INTO semantic.subject (route, subject_id, type, recorded_transaction_id) VALUES ($1,$2,'schema:Book',$2)",
    [routeOf(writeSubject), writeSubject],
  );
  let head = (await publication.publish(deps(), publisher, { realmId, subjectId: writeSubject }, context())).value
    .publicationId;

  const pageReport = await checkGrowth(db, {
    name: 'community publication page',
    scales,
    bounds,
    async grow(_database, scale, previous) {
      await seed(
        db,
        population(`community-publication-page-${realmId}`, hotPartition, await positionOf(hotPartition)),
        {
          from: previous * populationMultiplier,
          to: scale * populationMultiplier,
        },
      );
      await refreshPublisher();
    },
    async operation() {
      const page = await publication.listPublications(
        deps(),
        realmId,
        { actor: publisher, deadline: Date.now() + 30_000 },
        { limit: pageLimit },
      );
      if (!page || page.items.length !== pageLimit || page.next === null)
        throw new Error('Probe publication page changed');
      return page;
    },
  });
  expect(pageReport.samples.map((sample) => sample.scale)).toEqual(scales);
  for (const sample of pageReport.samples) {
    const relations = Object.entries(sample.cost.relations!).filter(([name]) => name.startsWith('community.'));
    expect(relations.length).toBeGreaterThan(0);
    for (const [, cost] of relations) expect(cost.sequentialScans).toBe(0);
  }
  expect(new Set(pageReport.samples.map((sample) => sample.cost.statements)).size).toBe(1);

  const writeReport = await checkGrowth(db, {
    name: 'community publication write',
    scales,
    bounds,
    async grow(_database, scale, previous) {
      await seed(
        db,
        population(`community-publication-write-${realmId}`, hotPartition, await positionOf(hotPartition)),
        { from: previous * populationMultiplier, to: scale * populationMultiplier },
      );
      await refreshPublisher();
    },
    async operation() {
      const result = await publication.publish(
        deps(),
        publisher,
        { realmId, subjectId: writeSubject, expectedHead: head },
        context(),
      );
      head = result.value.publicationId;
      return result;
    },
  });
  expect(writeReport.samples.map((sample) => sample.scale)).toEqual(scales);
  for (const sample of writeReport.samples) {
    const relations = Object.entries(sample.cost.relations!).filter(([name]) => name.startsWith('community.'));
    expect(relations.length).toBeGreaterThan(0);
    for (const [, cost] of relations) expect(cost.sequentialScans).toBe(0);
  }
  expect(new Set(writeReport.samples.map((sample) => sample.cost.statements)).size).toBe(1);
}, 300_000);
