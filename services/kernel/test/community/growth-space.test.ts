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
import { accessCheck, type AccountActor } from '../../src/request/access.ts';
import { anchorRoute, newId, partitionOf, routeOf } from '../../src/route/route.ts';
import { GLOBAL_CONTEXT } from '../../src/semantic/definitions.ts';
import { trustedAccessPorts } from '../support/trusted-access.ts';
import { dropTestDatabase } from '../support/drop-test-database.ts';

const routeKey = new Uint8Array(32).fill(37);
const root = { route: 0, id: GLOBAL_CONTEXT };
const input = { title: 'First community', summary: 'A shared place' };
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
  const actions = ['space:create', 'space:manage', 'space:read', 'realm:read'];
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
  async function grant(id: string, target = root) {
    await admin.query(
      "INSERT INTO access.resource_grant (route,resource_id,subject_id,action,valid,transaction_id) VALUES ($1,$2,$3,'space:create','(,)'::tstzrange,$3) ON CONFLICT DO NOTHING",
      [target.route, target.id, id],
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
const scales: [number, number, number] = [256, 1024, 4096];
const revisionsPerSpace = 8;
const bounds = { rows: 'constant', blocks: 'logarithmic', statements: 'constant' } as const;
beforeAll(async () => {
  db = await openGrowthDatabase();
  db.pool.options.max = 1;
  f = await fixture(db.pool, db.admin);
  await f.grant(f.actor.accountId);
  space = await import('../../src/community/space.ts');
});
afterAll(async () => {
  await f?.close();
  await db?.close();
});
const deps = () => ({ pool: db.pool, access: f.access, routeKey });

function carriedRealmRows(route: number, spaceId: string, creator: string) {
  const realmId = newId(route);
  const revisions = Array.from({ length: revisionsPerSpace }, () => newId(route));
  const at = '2020-01-01T00:00:00.000Z';
  return {
    'community.realm': [
      {
        route,
        realm_id: realmId,
        space_id: spaceId,
        state: 'active',
        visibility: 'public',
        context_id: GLOBAL_CONTEXT,
        head_revision_id: revisions.at(-1),
        created_at: at,
        creator,
      },
    ],
    'community.realm_revision': revisions.map((revision_id, index) => ({
      route,
      realm_id: realmId,
      revision_id,
      predecessor: index === 0 ? null : revisions[index - 1],
      title: 'Carried Realm',
      summary: '',
      visibility: 'public',
      context_id: GLOBAL_CONTEXT,
      created_at: at,
      author: creator,
    })),
  };
}

for (const operation of ['create', 'read', 'update'] as const)
  test(`Space ${operation} stays bounded at 256, 1024 and 4096 Spaces and their revisions`, async () => {
    await db.admin.query(
      'TRUNCATE community.space, community.space_revision, access.resource_initialization, access.resource_role_grant, core.receipt, core.outbox, editorial.write_basis CASCADE',
    );
    const probe = await space.createSpace(deps(), f.actor, input, context());
    const route = routeOf(probe.value.spaceId)!;
    const hotPartition = partitionOf(route);
    let probeRealmId: string | undefined;
    if (operation === 'read') {
      const probeRealms: Population = {
        name: `probe-realm-${randomUUID()}`,
        hotPartition,
        hotShare: 1,
        rows: () => carriedRealmRows(route, probe.value.spaceId, f.actor.accountId),
      };
      await seed({ pool: db.pool, admin: db.admin }, probeRealms, { from: 0, to: 1 });
      probeRealmId = (
        await db.admin.query('SELECT realm_id FROM community.realm WHERE route=$1 AND space_id=$2', [
          route,
          probe.value.spaceId,
        ])
      ).rows[0].realm_id;
    }
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
        const spaceId = newId(route);
        // A Space keeps a revision chain, so the smallest scale already holds thousands of revision rows
        // and the planner has no reason to scan the relation.
        const revisionIds = Array.from({ length: revisionsPerSpace }, () => newId(route));
        const revisionId = revisionIds[revisionsPerSpace - 1]!;
        const at = '2026-10-25T00:00:00.000Z';
        const transactionId = randomUUID();
        const position = positionBase + ordinal * 100 + 1;
        const value = { spaceId, revisionId };
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
          'community.space_revision': revisionIds.map((id, index) => ({
            route,
            space_id: spaceId,
            revision_id: id,
            predecessor: index === 0 ? null : revisionIds[index - 1],
            title: 'Neighbour',
            summary: '',
            created_at: at,
            author: f.actor.accountId,
          })),
          ...(operation === 'read' ? carriedRealmRows(route, spaceId, f.actor.accountId) : {}),
          'access.resource_initialization': [
            {
              route,
              resource_id: spaceId,
              resource_type: 'community.space',
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
              command_kind: 'community.space.create',
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
              type: 'com.rezics.community.space.created.v1',
              subject: spaceId,
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
              resource_id: spaceId,
              subject_kind: 'identity',
              subject_id: f.actor.accountId,
              grant_role: 'community.space.owner',
              valid: '(,)',
              transaction_id: transactionId,
            },
            {
              route,
              resource_id: spaceId,
              subject_kind: 'active_accounts',
              subject_id: '00000000-0000-0000-0000-000000000000',
              grant_role: 'community.space.standing',
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
    let createdKeys = 0;
    function key() {
      for (;;) {
        const value = `growth-${operation}-${createdKeys++}`;
        if (
          partitionOf(anchorRoute(routeKey, `${f.actor.accountId}\ncommunity.space.create\n${value}`)) === hotPartition
        )
          return value;
      }
    }
    const report = await checkGrowth(db, {
      name: `community Space ${operation}`,
      scales,
      bounds,
      async grow(_, scale, previous) {
        // Other identities grow; the probe is never replaced or lengthened by seeding.
        await seed({ pool: db.pool, admin: db.admin }, population, { from: previous, to: scale });
      },
      async operation() {
        if (operation === 'create') return space.createSpace(deps(), f.actor, input, context(key()));
        if (operation === 'read') {
          const context = { deadline: Date.now() + 90_000 };
          const resource = { route, id: probe.value.spaceId };
          const check = await accessCheck(
            f.access,
            f.actor,
            'space:read',
            { ...resource, eligibility: space.spaceReadEligibility(resource) },
            { pool: db.pool, ...context },
          );
          const value = await space.readSpaceForViewer(
            deps(),
            f.actor,
            probe.value.spaceId,
            new Date().toISOString(),
            context,
            check,
          );
          expect(value?.realmId).toBe(probeRealmId);
          return value;
        }
        const result = await space.updateSpace(
          deps(),
          f.actor,
          { spaceId: probe.value.spaceId, expectedHead: head, summary: 'Fixed update' },
          context(),
        );
        head = result.value.revisionId;
        return result;
      },
    });
    expect(report.samples.map((sample) => sample.scale)).toEqual(scales);
    for (const sample of report.samples) {
      const relations = Object.entries(sample.cost.relations!).filter(([name]) => name.startsWith('community.'));
      expect(relations.length).toBeGreaterThan(0);
      for (const [, cost] of relations) expect(cost.sequentialScans).toBe(0);
    }
    expect(new Set(report.samples.map((sample) => sample.cost.statements)).size).toBe(1);
  }, 120_000);
