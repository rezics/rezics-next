import { AuthenticationError } from '../../src/request/access.ts';
import { suspendAccount } from '../support/native-suspension-driver.ts';
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
import { accessCheck, type AccountActor } from '../../src/request/access.ts';
import { anchorRoute, newId, partitionOf, routeOf } from '../../src/route/route.ts';
import { GLOBAL_CONTEXT } from '../../src/semantic/definitions.ts';
import { trustedAccessPorts } from '../support/trusted-access.ts';
import { dropTestDatabase } from '../support/drop-test-database.ts';

const routeKey = new Uint8Array(32).fill(37);
const root = { route: 0, id: GLOBAL_CONTEXT };
const input = { title: 'First community', summary: 'A shared place' };
const context = (idempotencyKey = randomUUID()) => ({ idempotencyKey, deadline: Date.now() + 90_000 });

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
  const actions = ['space:create', 'space:manage', 'space:read'];
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

let pool: Pool;
let admin: Pool;
let f: Awaited<ReturnType<typeof fixture>>;
let space: typeof import('../../src/community/space.ts');
beforeAll(async () => {
  pool = createPool(process.env.DATABASE_URL!);
  pool.options.max = 1;
  admin = new Pool({ connectionString: process.env.DATABASE_URL });
  f = await fixture(pool, admin);
  space = await import('../../src/community/space.ts');
});
beforeEach(async () => {
  await admin.query(
    'TRUNCATE community.space, community.space_revision, access.resource_initialization, access.resource_role_grant, access.resource_grant, core.receipt, core.outbox, editorial.write_basis CASCADE',
  );
  await admin.query("UPDATE access.account SET state='active' WHERE account_id=ANY($1::uuid[])", [
    [f.actor.accountId, f.other.accountId],
  ]);
});
afterAll(async () => {
  await f?.close();
  await pool?.end();
  await admin?.end();
});
const deps = () => ({ pool, access: f.access, routeKey });
async function snapshot() {
  return (
    await admin.query(`SELECT
    (SELECT count(*)::integer FROM community.space) AS spaces,
    (SELECT count(*)::integer FROM community.space_revision) AS revisions,
    (SELECT count(*)::integer FROM access.resource_initialization) AS initialized,
    (SELECT count(*)::integer FROM access.resource_role_grant) AS roles,
    (SELECT count(*)::integer FROM core.receipt) AS receipts,
    (SELECT count(*)::integer FROM core.outbox) AS events,
    (SELECT count(*)::integer FROM editorial.write_basis) AS bases,
    (SELECT sum(position)::text FROM core.partition) AS position`)
  ).rows;
}

test('Global create grant creates the first head and seeds only the Space owner and standing roles exactly once', async () => {
  await f.grant(f.actor.accountId);
  const request = context();
  const created = await space.createSpace(deps(), f.actor, input, request);
  const { spaceId, revisionId } = created.value;
  const route = anchorRoute(routeKey, `${f.actor.accountId}\ncommunity.space.create\n${request.idempotencyKey}`);
  expect(routeOf(spaceId)).toBe(route);
  expect(routeOf(revisionId)).toBe(route);
  expect(created.partition).toBe(partitionOf(route));
  expect(created.replayed).toBe(false);
  const row = await space.readSpace(pool, spaceId, new Date().toISOString());
  expect(row).toMatchObject({
    spaceId,
    headRevisionId: revisionId,
    title: input.title,
    summary: input.summary,
    predecessor: null,
    creator: f.actor.accountId,
    author: f.actor.accountId,
    state: 'active',
  });
  const owner = await accessCheck(
    f.access,
    f.actor,
    'space:manage',
    { route, id: spaceId },
    { pool, deadline: Date.now() + 5000 },
  );
  expect(await owner(pool)).toBe(true);
  const before = await snapshot();
  const replay = await space.createSpace(deps(), f.actor, input, context(request.idempotencyKey));
  expect(replay).toEqual({ ...created, replayed: true });
  expect(await snapshot()).toEqual(before);
  const grants = (
    await admin.query(
      'SELECT resource_id, subject_kind, subject_id, grant_role AS role FROM access.resource_role_grant ORDER BY grant_role',
    )
  ).rows;
  expect(grants).toEqual([
    { resource_id: spaceId, subject_kind: 'identity', subject_id: f.actor.accountId, role: 'community.space.owner' },
    {
      resource_id: spaceId,
      subject_kind: 'active_accounts',
      subject_id: '00000000-0000-0000-0000-000000000000',
      role: 'community.space.standing',
    },
  ]);
  expect((await admin.query('SELECT resource_id, action FROM access.resource_grant')).rows).toEqual([
    { resource_id: GLOBAL_CONTEXT, action: 'space:create' },
  ]);
  expect((await admin.query('SELECT resource_id, resource_type FROM access.resource_initialization')).rows).toEqual([
    { resource_id: spaceId, resource_type: 'community.space' },
  ]);
  expect(
    (
      await admin.query(
        'SELECT s.xmin = r.xmin AS same_transaction FROM community.space s JOIN community.space_revision r USING(route, space_id)',
      )
    ).rows,
  ).toEqual([{ same_transaction: true }]);
});

test('missing Global grant, a grant on another resource, and a suspended actor deny creation without writes', async () => {
  for (const mode of ['missing', 'other-resource', 'suspended']) {
    if (mode === 'other-resource') await f.grant(f.other.accountId, { route: 7, id: newId(7) });
    if (mode === 'suspended') {
      await f.grant(f.other.accountId);
      await suspendAccount(admin, f.other.accountId);
    }
    const before = await snapshot();
    expect(await space.createSpace(deps(), f.other, input, context()).catch((e) => e)).toBeInstanceOf(
      mode === 'suspended' ? AuthenticationError : GrantDeniedError,
    );
    expect(await snapshot()).toEqual(before);
    expect((await admin.query('SELECT count(*)::integer AS n FROM community.space')).rows[0].n).toBe(0);
  }
});

test('owner updates append a revision, preserve omitted fields, and stale heads leave no writes', async () => {
  await f.grant(f.actor.accountId);
  const first = await space.createSpace(deps(), f.actor, input, context());
  const request = context();
  const update = { spaceId: first.value.spaceId, expectedHead: first.value.revisionId, title: 'Changed title' };
  const second = await space.updateSpace(deps(), f.actor, update, request);
  expect(second.value.spaceId).toBe(first.value.spaceId);
  expect(second.value.revisionId).not.toBe(first.value.revisionId);
  expect(await space.readSpace(pool, first.value.spaceId, new Date().toISOString())).toMatchObject({
    title: 'Changed title',
    summary: input.summary,
    predecessor: first.value.revisionId,
    headRevisionId: second.value.revisionId,
  });
  const before = await snapshot();
  expect(await space.updateSpace(deps(), f.actor, update, context(request.idempotencyKey))).toEqual({
    ...second,
    replayed: true,
  });
  expect(
    await space.updateSpace(deps(), f.actor, { ...update, summary: 'Stale' }, context()).catch((e) => e),
  ).toBeInstanceOf(space.SpaceConflictError);
  expect(await snapshot()).toEqual(before);
  expect((await admin.query('SELECT count(*)::integer AS n FROM community.space_revision')).rows[0].n).toBe(2);
  const third = await space.updateSpace(
    deps(),
    f.actor,
    { spaceId: first.value.spaceId, expectedHead: second.value.revisionId, summary: '' },
    context(),
  );
  expect(await space.readSpace(pool, first.value.spaceId, new Date().toISOString())).toMatchObject({
    title: 'Changed title',
    summary: '',
    headRevisionId: third.value.revisionId,
  });
});

test('unrelated and suspended accounts cannot manage a Space, including receipt replay after suspension', async () => {
  await f.grant(f.actor.accountId);
  const request = context();
  const first = await space.createSpace(deps(), f.actor, input, request);
  const update = { spaceId: first.value.spaceId, expectedHead: first.value.revisionId, summary: 'Denied' };
  let before = await snapshot();
  expect(await space.updateSpace(deps(), f.other, update, context()).catch((e) => e)).toBeInstanceOf(GrantDeniedError);
  expect(await snapshot()).toEqual(before);
  await suspendAccount(admin, f.actor.accountId);
  before = await snapshot();
  expect(await space.updateSpace(deps(), f.actor, update, context()).catch((e) => e)).toBeInstanceOf(
    AuthenticationError,
  );
  expect(
    await space.createSpace(deps(), f.actor, input, context(request.idempotencyKey)).catch((e) => e),
  ).toBeInstanceOf(AuthenticationError);
  expect(await snapshot()).toEqual(before);
});

test('public read eligibility prepares real evidence and active standing grants only read', async () => {
  await f.grant(f.actor.accountId);
  const first = await space.createSpace(deps(), f.actor, input, context());
  const resource = { route: routeOf(first.value.spaceId)!, id: first.value.spaceId };
  for (const actor of [{ kind: 'anonymous' } as const, f.other]) {
    const check = await accessCheck(
      f.access,
      actor,
      'space:read',
      { ...resource, eligibility: space.spaceReadEligibility(resource) },
      { pool, deadline: Date.now() + 5000 },
    );
    expect(await check(pool)).toBe(true);
  }
  const standing = await accessCheck(f.access, f.other, 'space:read', resource, { pool, deadline: Date.now() + 5000 });
  expect(await standing(pool)).toBe(true);
  const missing = { route: resource.route, id: newId(resource.route) };
  const check = await accessCheck(
    f.access,
    { kind: 'anonymous' },
    'space:read',
    { ...missing, eligibility: space.spaceReadEligibility(missing) },
    { pool, deadline: Date.now() + 5000 },
  );
  expect(await check(pool)).toBe(false);
  expect(await space.readSpace(pool, missing.id, new Date().toISOString())).toBeNull();
  expect(await space.readSpace(pool, 'invalid', new Date().toISOString())).toBeNull();
});

test('metadata caps and append-only revisions are enforced by commands and PostgreSQL', async () => {
  await f.grant(f.actor.accountId);
  for (const invalid of [{ title: '' }, { title: 'x'.repeat(1025) }, { summary: 'x'.repeat(4097) }]) {
    const before = await snapshot();
    expect(
      await space.createSpace(deps(), f.actor, { ...input, ...invalid }, context()).catch((e) => e),
    ).toBeInstanceOf(space.SpaceInputError);
    expect(await snapshot()).toEqual(before);
  }
  const first = await space.createSpace(
    deps(),
    f.actor,
    { title: '😀'.repeat(1024), summary: '😀'.repeat(4096) },
    context(),
  );
  const route = routeOf(first.value.spaceId)!;
  for (const query of [
    "UPDATE community.space_revision SET title='Changed' WHERE route=$1 AND space_id=$2",
    'DELETE FROM community.space_revision WHERE route=$1 AND space_id=$2',
  ])
    expect(await admin.query(query, [route, first.value.spaceId]).catch((e) => e)).toMatchObject({ code: '23514' });
  const before = await snapshot();
  expect(
    await space
      .updateSpace(
        deps(),
        f.actor,
        { spaceId: first.value.spaceId, expectedHead: first.value.revisionId, title: '' },
        context(),
      )
      .catch((e) => e),
  ).toBeInstanceOf(space.SpaceInputError);
  expect(await snapshot()).toEqual(before);
  expect(
    await admin
      .query(
        `INSERT INTO community.space_revision (route,space_id,revision_id,predecessor,title,summary,created_at,author) VALUES ($1,$2,$3,NULL,'','',now(),$4)`,
        [route, first.value.spaceId, newId(route), f.actor.accountId],
      )
      .catch((e) => e),
  ).toMatchObject({ code: '23514' });
  expect(
    await admin
      .query(
        `INSERT INTO community.space_revision (route,space_id,revision_id,predecessor,title,summary,created_at,author) VALUES ($1,$2,$3,NULL,'Wrong route','',now(),$4)`,
        [route, first.value.spaceId, newId((route + 1) % 65536), f.actor.accountId],
      )
      .catch((e) => e),
  ).toMatchObject({ code: '23514' });
});
