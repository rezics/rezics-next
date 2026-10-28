import { productionActions } from '../support/production-actions.ts';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, expect, test } from 'bun:test';
import { createPool } from '../../src/database/pool.ts';
import { createAuthService } from '@rezics/auth';
import { exportJWK, generateKeyPair } from 'jose';
import { Pool } from 'pg';
import { migrate as migrateAuth } from '../../../auth/scripts/database.ts';
import { createAccess } from '../../src/access/index.ts';
import { GrantDeniedError } from '../../src/access/grant-commands.ts';
import { readAccount } from '../../src/access/account-data.ts';
import { accessCheck, type AccountActor, type AccessContext } from '../../src/request/access.ts';
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

let pool: Pool;
let admin: Pool;
let f: Awaited<ReturnType<typeof fixture>>;
let realm: typeof import('../../src/community/realm.ts');
let space: typeof import('../../src/community/space.ts');
beforeAll(async () => {
  pool = createPool(process.env.DATABASE_URL!);
  pool.options.max = 1;
  admin = new Pool({ connectionString: process.env.DATABASE_URL });
  f = await fixture(pool, admin);
  space = await import('../../src/community/space.ts');
  realm = await import('../../src/community/realm.ts');
});
beforeEach(async () => {
  await admin.query(
    'TRUNCATE community.realm, community.realm_revision, community.space, community.space_revision, access.resource_initialization, access.resource_role_grant, access.resource_grant, core.receipt, core.outbox, editorial.write_basis CASCADE',
  );
  await admin.query("UPDATE access.account SET state='active' WHERE account_id=ANY($1::uuid[])", [
    [f.actor.accountId, f.other.accountId],
  ]);
  await f.grant(f.actor.accountId);
});
afterAll(async () => {
  await f?.close();
  await pool?.end();
  await admin?.end();
});
const deps = () => ({ pool, access: f.access, routeKey });
async function createSpace() {
  return (await space.createSpace(deps(), f.actor, { title: 'Host Space' }, context())).value.spaceId;
}
async function snapshot() {
  return (
    await admin.query(`SELECT
    (SELECT count(*)::integer FROM community.realm) AS realms,
    (SELECT count(*)::integer FROM community.realm_revision) AS revisions,
    (SELECT count(*)::integer FROM access.resource_initialization) AS initialized,
    (SELECT count(*)::integer FROM access.resource_role_grant) AS roles,
    (SELECT count(*)::integer FROM core.receipt) AS receipts,
    (SELECT count(*)::integer FROM core.outbox) AS events,
    (SELECT count(*)::integer FROM editorial.write_basis) AS bases,
    (SELECT sum(position)::text FROM core.partition) AS position`)
  ).rows;
}
const read = (id: string, actor = f.actor) => realm.readRealm(deps(), actor, id, { deadline: Date.now() + 5000 });

test('Space owner with Global realm:create mints a distinct Realm on the Space route with a head and owner and standing roles', async () => {
  const spaceId = await createSpace();
  await f.grant(f.actor.accountId, root, 'realm:create');
  const request = context();
  const preparations: { action: string; context: AccessContext }[] = [];
  const prepare = f.access.prepare!.bind(f.access);
  f.access.prepare = async (actor, action, resource, context) => {
    preparations.push({ action, context });
    return prepare(actor, action, resource, context);
  };
  let created;
  try {
    created = await realm.createRealm(deps(), f.actor, { ...input, spaceId }, request);
  } finally {
    f.access.prepare = prepare;
  }
  const { realmId, revisionId } = created.value;
  const route = routeOf(spaceId)!;
  expect(realmId).not.toBe(spaceId);
  expect(routeOf(realmId)).toBe(route);
  expect(routeOf(revisionId)).toBe(route);
  expect(created.partition).toBe(partitionOf(route));
  const parent = preparations.find((entry) => entry.action === 'realm:create');
  const owner = preparations.find((entry) => entry.action === 'space:manage');
  expect(parent).toBeDefined();
  expect(owner).toBeDefined();
  expect(owner!.context).toBe(parent!.context);
  expect(await read(realmId)).toMatchObject({
    realmId,
    spaceId,
    title: input.title,
    summary: input.summary,
    visibility: 'protected',
    contextId: GLOBAL_CONTEXT,
    headRevisionId: revisionId,
    predecessor: null,
    creator: f.actor.accountId,
    author: f.actor.accountId,
    state: 'active',
  });
  expect(
    (
      await admin.query(
        'SELECT grant_role,subject_kind,subject_id FROM access.resource_role_grant WHERE route=$1 AND resource_id=$2',
        [route, realmId],
      )
    ).rows,
  ).toEqual([
    {
      grant_role: 'community.realm.standing',
      subject_kind: 'active_accounts',
      subject_id: '00000000-0000-0000-0000-000000000000',
    },
    { grant_role: 'community.realm.owner', subject_kind: 'identity', subject_id: f.actor.accountId },
  ]);
  expect(
    (
      await admin.query('SELECT resource_type FROM access.resource_initialization WHERE route=$1 AND resource_id=$2', [
        route,
        realmId,
      ])
    ).rows,
  ).toEqual([{ resource_type: 'community.realm' }]);
  expect(
    (
      await admin.query(
        'SELECT s.xmin=r.xmin AS same_transaction FROM community.realm s JOIN community.realm_revision r USING(route,realm_id) WHERE s.realm_id=$1',
        [realmId],
      )
    ).rows,
  ).toEqual([{ same_transaction: true }]);
  const before = await snapshot();
  expect(await realm.createRealm(deps(), f.actor, { ...input, spaceId }, context(request.idempotencyKey))).toEqual({
    ...created,
    replayed: true,
  });
  expect(await snapshot()).toEqual(before);
  expect(await realm.createRealm(deps(), f.actor, { ...input, spaceId }, context()).catch((e) => e)).toBeInstanceOf(
    Error,
  );
  expect(await snapshot()).toEqual(before);
});

test('missing Global permission, a non-owner, a missing Space or Context and suspension write nothing', async () => {
  const spaceId = await createSpace();
  for (const mode of ['missing-grant', 'non-owner', 'missing-space', 'missing-context', 'suspended']) {
    if (mode !== 'missing-grant') await f.grant(f.actor.accountId, root, 'realm:create');
    if (mode === 'non-owner') await f.grant(f.other.accountId, root, 'realm:create');
    if (mode === 'suspended')
      await admin.query("UPDATE access.account SET state='suspended' WHERE route=$1 AND account_id=$2", [
        routeOf(f.actor.accountId),
        f.actor.accountId,
      ]);
    const before = await snapshot();
    expect(
      await realm
        .createRealm(
          deps(),
          mode === 'non-owner' ? f.other : f.actor,
          {
            ...input,
            spaceId: mode === 'missing-space' ? newId(routeOf(spaceId)!) : spaceId,
            contextId: mode === 'missing-context' ? newId(7) : GLOBAL_CONTEXT,
          },
          context(),
        )
        .catch((e) => e),
    ).toBeInstanceOf(GrantDeniedError);
    expect(await snapshot()).toEqual(before);
  }
});

test('unreadable classification Context denies both create and context changes without writes', async () => {
  const spaceId = await createSpace();
  await f.grant(f.actor.accountId, root, 'realm:create');
  const prepare = f.access.prepare!.bind(f.access);
  // Simulate an unavailable public Context observation, retaining production Access for all proofs.
  f.access.prepare = (actor, action, resource, context) =>
    action === 'context:read' ? Promise.resolve(null) : prepare(actor, action, resource, context);
  let before = await snapshot();
  try {
    expect(await realm.createRealm(deps(), f.actor, { ...input, spaceId }, context()).catch((e) => e)).toBeInstanceOf(
      GrantDeniedError,
    );
    expect(await snapshot()).toEqual(before);
  } finally {
    f.access.prepare = prepare;
  }
  const first = await realm.createRealm(deps(), f.actor, { ...input, spaceId }, context());
  const contextId = newId(9);
  await admin.query(
    "INSERT INTO semantic.context(route,context_id,kind,labels,recorded_transaction_id) VALUES(9,$1,'community','{}',$1)",
    [contextId],
  );
  f.access.prepare = (actor, action, resource, context) =>
    action === 'context:read' ? Promise.resolve(null) : prepare(actor, action, resource, context);
  before = await snapshot();
  try {
    expect(
      await realm
        .updateRealm(
          deps(),
          f.actor,
          { realmId: first.value.realmId, expectedHead: first.value.revisionId, contextId },
          context(),
        )
        .catch((e) => e),
    ).toBeInstanceOf(GrantDeniedError);
    expect(await snapshot()).toEqual(before);
  } finally {
    f.access.prepare = prepare;
  }
});

test('owner updates append revisions, preserve omitted fields, recheck Context and reject stale heads without writes', async () => {
  const spaceId = await createSpace();
  await f.grant(f.actor.accountId, root, 'realm:create');
  const first = await realm.createRealm(deps(), f.actor, { ...input, spaceId }, context());
  const contextId = newId(8);
  await admin.query(
    "INSERT INTO semantic.context(route,context_id,kind,labels,recorded_transaction_id) VALUES(8,$1,'community','{}',$1)",
    [contextId],
  );
  const request = context();
  const update = {
    realmId: first.value.realmId,
    expectedHead: first.value.revisionId,
    title: 'Changed',
    visibility: 'public' as const,
    contextId,
  };
  const second = await realm.updateRealm(deps(), f.actor, update, request);
  expect(await read(first.value.realmId)).toMatchObject({
    title: 'Changed',
    summary: input.summary,
    visibility: 'public',
    contextId,
    predecessor: first.value.revisionId,
    headRevisionId: second.value.revisionId,
  });
  const before = await snapshot();
  expect(await realm.updateRealm(deps(), f.actor, update, context(request.idempotencyKey))).toEqual({
    ...second,
    replayed: true,
  });
  expect(
    await realm.updateRealm(deps(), f.actor, { ...update, summary: 'Stale' }, context()).catch((e) => e),
  ).toBeInstanceOf(realm.RealmConflictError);
  expect(
    await realm
      .updateRealm(
        deps(),
        f.actor,
        { ...update, expectedHead: second.value.revisionId, contextId: newId(7) },
        context(),
      )
      .catch((e) => e),
  ).toBeInstanceOf(GrantDeniedError);
  expect(
    await realm
      .updateRealm(deps(), f.other, { ...update, expectedHead: second.value.revisionId }, context())
      .catch((e) => e),
  ).toBeInstanceOf(GrantDeniedError);
  expect(await snapshot()).toEqual(before);
  for (const query of [
    "UPDATE community.realm_revision SET title='Changed' WHERE realm_id=$1",
    'DELETE FROM community.realm_revision WHERE realm_id=$1',
  ])
    expect(await admin.query(query, [first.value.realmId]).catch((e) => e)).toMatchObject({ code: '23514' });
});

test('protected reads hide existence from non-members; public eligibility tracks the current visibility', async () => {
  const spaceId = await createSpace();
  await f.grant(f.actor.accountId, root, 'realm:create');
  const first = await realm.createRealm(deps(), f.actor, { ...input, spaceId }, context());
  const realmId = first.value.realmId;
  const resource = { route: routeOf(realmId)!, id: realmId };
  expect(await read(realmId, f.other)).toBeNull();
  expect(await realm.readRealm(deps(), { kind: 'anonymous' }, realmId, { deadline: Date.now() + 5000 })).toBeNull();
  expect(await read(newId(resource.route), f.other)).toBeNull();
  expect(await read('invalid', f.other)).toBeNull();
  expect(await read(realmId)).not.toBeNull();
  const check = await accessCheck(
    f.access,
    { kind: 'anonymous' },
    'realm:read',
    { ...resource, eligibility: realm.realmReadEligibility(resource) },
    { pool, deadline: Date.now() + 5000 },
  );
  expect(await check(pool)).toBe(false);
  const second = await realm.updateRealm(
    deps(),
    f.actor,
    { realmId, expectedHead: first.value.revisionId, visibility: 'public' },
    context(),
  );
  expect(await check(pool)).toBe(true);
  expect(await realm.readRealm(deps(), { kind: 'anonymous' }, realmId, { deadline: Date.now() + 5000 })).toMatchObject({
    visibility: 'public',
  });
  const standing = await accessCheck(f.access, f.other, 'realm:read', resource, { pool, deadline: Date.now() + 5000 });
  expect(await standing(pool)).toBe(false);
  await realm.updateRealm(
    deps(),
    f.actor,
    { realmId, expectedHead: second.value.revisionId, visibility: 'protected' },
    context(),
  );
  expect(await check(pool)).toBe(false);
  await admin.query("UPDATE access.account SET state='suspended' WHERE route=$1 AND account_id=$2", [
    routeOf(f.actor.accountId),
    f.actor.accountId,
  ]);
  const before = await snapshot();
  expect(
    await realm
      .updateRealm(deps(), f.actor, { realmId, expectedHead: second.value.revisionId, title: 'Denied' }, context())
      .catch((e) => e),
  ).toBeInstanceOf(GrantDeniedError);
  expect(await snapshot()).toEqual(before);
});

test('concurrent Realm creation claims exactly one Space slot', async () => {
  const spaceId = await createSpace();
  await f.grant(f.actor.accountId, root, 'realm:create');
  const results = await Promise.allSettled([
    realm.createRealm(deps(), f.actor, { ...input, spaceId }, context()),
    realm.createRealm(deps(), f.actor, { ...input, spaceId }, context()),
  ]);
  expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
  expect(
    (await admin.query('SELECT count(*)::integer AS n FROM community.realm WHERE space_id=$1', [spaceId])).rows,
  ).toEqual([{ n: 1 }]);
  expect((await admin.query('SELECT count(*)::integer AS n FROM community.realm_revision')).rows).toEqual([{ n: 1 }]);
});

test('invalid Realm metadata and visibility leave no writes', async () => {
  const spaceId = await createSpace();
  await f.grant(f.actor.accountId, root, 'realm:create');
  for (const invalid of [
    { title: '' },
    { title: 'x'.repeat(1025) },
    { summary: 'x'.repeat(4097) },
    { visibility: 'private' as 'public' },
  ]) {
    const before = await snapshot();
    expect(
      await realm.createRealm(deps(), f.actor, { ...input, ...invalid, spaceId }, context()).catch((e) => e),
    ).toBeInstanceOf(realm.RealmInputError);
    expect(await snapshot()).toEqual(before);
  }
});
