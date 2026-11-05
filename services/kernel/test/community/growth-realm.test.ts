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
    'context:read',
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
    other: actors[1]!,
    grant,
    async close() {
      await authPool.end();
      await dropTestDatabase(admin, database);
    },
  };
}

let db: GrowthDatabase;
let f: Awaited<ReturnType<typeof fixture>>;
let space: typeof import('../../src/community/space.ts');
let realm: typeof import('../../src/community/realm.ts');
const scales: [number, number, number] = [256, 1024, 4096];
// Keep 2,048 seeded rows per relation at the smallest growth scale.
const populationMultiplier = 8;
const bounds = { rows: 'constant', blocks: 'logarithmic', statements: 'constant' } as const;
beforeAll(async () => {
  db = await openGrowthDatabase();
  db.pool.options.max = 1;
  f = await fixture(db.pool, db.admin);
  await f.grant(f.actor.accountId);
  space = await import('../../src/community/space.ts');
  realm = await import('../../src/community/realm.ts');
  await f.grant(f.actor.accountId, root, 'realm:create');
});
afterAll(async () => {
  await f?.close();
  await db?.close();
});
const deps = () => ({ pool: db.pool, access: f.access, routeKey });

for (const operation of ['create', 'read', 'public-read', 'update'] as const)
  test(`Realm ${operation} stays bounded across growth scales ${scales.join(', ')}`, async () => {
    await db.admin.query(
      'TRUNCATE community.realm, community.realm_revision, community.space, community.space_revision, access.resource_initialization, access.resource_role_grant, core.receipt, core.outbox, editorial.write_basis CASCADE',
    );
    const host = await space.createSpace(deps(), f.actor, { title: 'Host' }, context());
    const probe = await realm.createRealm(
      deps(),
      f.actor,
      { ...input, spaceId: host.value.spaceId, visibility: operation === 'public-read' ? 'public' : 'protected' },
      context(),
    );
    const route = routeOf(probe.value.realmId)!;
    const hotPartition = partitionOf(route);
    let head = probe.value.revisionId;
    const positionBase = Number(
      (await db.admin.query('SELECT position FROM core.partition WHERE partition_no=$1', [hotPartition])).rows[0]
        .position,
    );
    const population: Population = {
      name: `community-${operation}-${randomUUID()}`,
      hotPartition,
      hotShare: 1,
      rows: ({ route, ordinal }) => {
        const spaceId = newId(route),
          realmId = newId(route),
          revisionId = newId(route);
        const at = '2026-10-25T00:00:00.000Z';
        const transactionId = randomUUID();
        const position = positionBase + ordinal * 100 + 1;
        const value = { realmId, revisionId };
        return {
          'community.space': [
            {
              route,
              space_id: spaceId,
              state: 'active',
              head_revision_id: revisionId,
              created_at: at,
              creator: f.actor.accountId,
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
              author: f.actor.accountId,
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
              creator: f.actor.accountId,
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
              author: f.actor.accountId,
            },
          ],
          'access.resource_initialization': [
            {
              route,
              resource_id: realmId,
              resource_type: 'community.realm',
              creator_id: f.actor.accountId,
              initialized_at: at,
            },
          ],
          // Mirror the command records as well as domain rows so new probe commands
          // do not grow a tiny, sequentially scanned receipt table between samples.
          'core.receipt': [
            {
              partition_no: hotPartition,
              principal_kind: 'account',
              principal_id: f.actor.accountId,
              command_kind: 'community.realm.create',
              idempotency_key: `seed-${operation}-${ordinal}`,
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
              type: 'com.rezics.community.realm.created.v1',
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
              principal_id: f.actor.accountId,
              client_id: f.actor.clientId,
              requested_by: null,
              recorded_at: at,
            },
          ],
          'access.resource_role_grant': [
            {
              route,
              resource_id: realmId,
              subject_kind: 'identity',
              subject_id: f.actor.accountId,
              grant_role: 'community.realm.owner',
              valid: '(,)',
              transaction_id: transactionId,
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
    const slots: string[] = [];
    const report = await checkGrowth(db, {
      name: `community Realm ${operation}`,
      scales,
      bounds,
      async grow(_, scale, previous) {
        // Other identities grow; the probe is never replaced or lengthened by seeding.
        await seed({ pool: db.pool, admin: db.admin }, population, {
          from: previous * populationMultiplier,
          to: scale * populationMultiplier,
        });
        if (operation === 'create') {
          slots.length = 0;
          for (let i = 0; i < 6; i++) {
            const spaceId = newId(route),
              revisionId = newId(route);
            await db.admin.query('BEGIN');
            await db.admin.query("INSERT INTO community.space VALUES($1,$2,'active',$3,now(),$4)", [
              route,
              spaceId,
              revisionId,
              f.actor.accountId,
            ]);
            await db.admin.query("INSERT INTO community.space_revision VALUES($1,$2,$3,NULL,'Slot','',now(),$4)", [
              route,
              spaceId,
              revisionId,
              f.actor.accountId,
            ]);
            await db.admin.query(
              "INSERT INTO access.resource_role_grant(route,resource_id,subject_kind,subject_id,grant_role,valid,transaction_id) VALUES($1,$2,'identity',$3,'community.space.owner','(,)',$3)",
              [route, spaceId, f.actor.accountId],
            );
            await db.admin.query('COMMIT');
            slots.push(spaceId);
          }
        }
      },
      async operation() {
        if (operation === 'create')
          return realm.createRealm(deps(), f.actor, { ...input, spaceId: slots.shift()! }, context());
        if (operation === 'read' || operation === 'public-read')
          return realm.readRealm(
            deps(),
            operation === 'public-read' ? { kind: 'anonymous' } : f.actor,
            probe.value.realmId,
            { deadline: Date.now() + 5000 },
          );
        const result = await realm.updateRealm(
          deps(),
          f.actor,
          { realmId: probe.value.realmId, expectedHead: head, summary: 'Fixed update' },
          context(),
        );
        head = result.value.revisionId;
        return result;
      },
    });
    expect(report.samples.map((sample) => sample.scale)).toEqual(scales);
    for (const sample of report.samples) {
      if (operation === 'create' || operation === 'update') {
        const account = sample.cost.relations?.['access.account'];
        const baseline = report.samples[0]!.cost.relations?.['access.account'];
        if (!account || !baseline) throw new Error('Missing access.account cost');
        expect(account.rows).toBe(baseline.rows);
      }
      const relations = Object.entries(sample.cost.relations!).filter(([name]) => name.startsWith('community.'));
      expect(relations.length).toBeGreaterThan(0);
      for (const [, cost] of relations) expect(cost.sequentialScans).toBe(0);
    }
    expect(new Set(report.samples.map((sample) => sample.cost.statements)).size).toBe(1);
  }, 120_000);
