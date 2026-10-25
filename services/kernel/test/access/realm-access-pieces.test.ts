import { afterAll, beforeAll, expect, test } from 'bun:test';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import type { AuthoritativeTime, CommandAuthorization, CommandTransaction } from '../../src/command/command.ts';
import type { Access, AccessClient, AccessRealmRoleReader, AccountActor, Resource } from '../../src/request/access.ts';

// Root bun test does not load services/kernel/bunfig.toml. Register Reylo before
// any SQL-bearing module; a static import would link before the plugin runs.
await import('reylo/register');
const { createMembershipInverseCommands } = await import('../../src/access/membership-inverse.ts');
const { ResourceAccessWriteDeniedError } = await import('../../src/access/resource-denials.ts');
const { createAccess, endResourceDenial, grantGroupRole, recordResourceDenial } =
  await import('../../src/access/index.ts');
const { authoritativeTimeValue, runCommand } = await import('../../src/command/command.ts');
const { createPool, withConnection } = await import('../../src/database/pool.ts');
const { accessCheck } = await import('../../src/request/access.ts');
const { newId, partitionOf, routeOf } = await import('../../src/route/route.ts');

const issuer = 'https://realm-access.example.test';
const audience = 'https://api.example.test';
const join = 'realm:join';
const participate = 'realm:participate';
const resourceRole = 'realm.member';
const actions = new Map([
  [join, { anonymous: false }],
  [participate, { anonymous: false }],
]);
const resourceRoles = { roles: { [resourceRole]: [participate] }, types: {} };
const event = { type: 'com.rezics.access.time-probe.v1', data: {} };
const pool = createPool(process.env.DATABASE_URL!);
let keys: Awaited<ReturnType<typeof generateKeyPair>>;
let installedJwks: object;

beforeAll(async () => {
  keys = await generateKeyPair('ES256');
  installedJwks = { keys: [{ ...(await exportJWK(keys.publicKey)), kid: 'fixture', alg: 'ES256' }] };
  await pool.query('DROP SCHEMA IF EXISTS realm_access_piece CASCADE');
  await pool.query('CREATE SCHEMA realm_access_piece');
  await pool.query(`CREATE TABLE realm_access_piece.membership (
    route integer NOT NULL, realm_id uuid NOT NULL, account_id uuid NOT NULL,
    role text NOT NULL, valid tstzrange NOT NULL,
    PRIMARY KEY (route, realm_id, account_id, role, valid WITHOUT OVERLAPS))`);
  await pool.query(`CREATE INDEX realm_access_piece_next_role ON realm_access_piece.membership
    (route, realm_id, account_id, role, lower(valid)) WHERE NOT lower_inf(valid)`);
}, 30000);
afterAll(async () => {
  await pool.query('DROP SCHEMA IF EXISTS realm_access_piece CASCADE');
  await pool.end();
});

function installedAccess(realmRoleReader?: AccessRealmRoleReader): Access {
  return createAccess({
    actions,
    auth: {
      issuer,
      audience,
      jwksUrl: `${issuer}/jwks`,
      fetch: async () => Response.json(installedJwks),
    },
    resourceRoles,
    ...(realmRoleReader ? { realmRoleReader } : {}),
  });
}

type RoleProof = { role: 'owner' | 'member'; member: boolean; valid: string };
function realmReader(seen: string[]): AccessRealmRoleReader {
  return async (client: AccessClient, input): Promise<RoleProof[] | null> => {
    seen.push(`${input.realmId}/${input.accountId}`);
    const result = await client.query(
      `SELECT r.role, m.valid IS NOT NULL AS member,
        COALESCE(m.valid, tstzrange($4::timestamptz, n.starts_at, '[)'))::text AS valid
       FROM (VALUES ('owner'), ('member')) r(role)
       LEFT JOIN realm_access_piece.membership m ON m.route = $1 AND m.realm_id = $2 AND m.account_id = $3
         AND m.role = r.role AND m.valid @> $4::timestamptz
       LEFT JOIN LATERAL (
         SELECT lower(f.valid) AS starts_at FROM realm_access_piece.membership f
         WHERE f.route = $1 AND f.realm_id = $2 AND f.account_id = $3 AND f.role = r.role
           AND NOT lower_inf(f.valid) AND lower(f.valid) > $4::timestamptz
         ORDER BY lower(f.valid) LIMIT 1
       ) n ON m.valid IS NULL`,
      [routeOf(input.realmId), input.realmId, input.accountId, input.at],
    );
    return result.rows as RoleProof[];
  };
}

async function insertActor(route: number): Promise<string> {
  const id = newId(route);
  await pool.query(
    `INSERT INTO access.account (route, account_id, kind, state, transaction_id)
     VALUES ($1, $2, 'actor', 'active', $2)`,
    [routeOf(id), id],
  );
  return id;
}

async function signed(accountId: string): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({
    iss: issuer,
    aud: audience,
    sub: accountId,
    client_id: 'fixture',
    scope: `${join} ${participate}`,
    authn_epoch: 1,
    iat: now,
    exp: now + 300,
    auth_time: now,
    amr: ['pwd'],
  })
    .setProtectedHeader({ alg: 'ES256', typ: 'at+jwt', kid: 'fixture' })
    .sign(keys.privateKey);
}

async function actor(installed: Access, accountId: string): Promise<AccountActor> {
  return installed.authenticate(await signed(accountId), { pool, deadline: Date.now() + 15_000 });
}

function allow(resource: Resource, action = participate): CommandAuthorization {
  return {
    action,
    resource,
    denied: () => new Error('denied'),
    authorize: async () => 'execute',
  };
}

async function execute<T>(
  resource: Resource,
  body: (tx: CommandTransaction, time: AuthoritativeTime) => Promise<T>,
  options: { clock?: () => Date; authorization?: CommandAuthorization | null } = {},
): Promise<T> {
  const authorization = options.authorization === null ? undefined : (options.authorization ?? allow(resource));
  const result = await runCommand(
    pool,
    {
      partition: partitionOf(resource.route),
      deadline: Date.now() + 10_000,
      ...(options.clock ? { clock: options.clock } : {}),
      ...(authorization ? { authorization } : {}),
    },
    async (tx, context) => ({ value: await body(tx, context.time), events: [event] }),
  );
  return result.value;
}

async function allowed(installed: Access, person: AccountActor, action: string, resource: Resource, clock?: Date) {
  const check = await accessCheck(installed, person, action, resource, { pool, deadline: Date.now() + 15_000 });
  return execute(
    resource,
    async (tx) => check(tx),
    clock ? { clock: () => clock, authorization: null } : { authorization: null },
  );
}

test('production createAccess forwards realmRoleReader to the formula', async () => {
  const accountId = await insertActor(0x3a12);
  const realmId = newId(0x3a13);
  const resource = { route: 0x3a14, id: newId(0x3a14) };
  await createMembershipInverseCommands({ pool }).reserve({
    accountId,
    principal: { kind: 'realm', id: realmId },
    key: `realm-forward-${accountId}`,
  });
  await pool.query(
    `INSERT INTO access.resource_role_grant
      (route, resource_id, subject_kind, subject_id, subject_role, grant_role, valid, transaction_id)
     VALUES ($1, $2, 'identity', $3, 'member', $4, '(,)', $2)`,
    [resource.route, resource.id, realmId, resourceRole],
  );
  await pool.query(
    `INSERT INTO realm_access_piece.membership (route, realm_id, account_id, role, valid)
     VALUES ($1, $2, $3, 'member', tstzrange(clock_timestamp() - interval '1 hour', NULL, '[)'))`,
    [routeOf(realmId), realmId, accountId],
  );
  const seen: string[] = [];
  const blind = installedAccess();
  const wired = installedAccess(realmReader(seen));
  expect(await allowed(blind, await actor(blind, accountId), participate, resource)).toBe(false);
  expect(seen).toEqual([]);
  expect(await allowed(wired, await actor(wired, accountId), participate, resource)).toBe(true);
  expect(seen).toEqual([`${realmId}/${accountId}`]);
}, 60000);

test('a recorded realm_ban denial on the realm denies exactly that action from T and ending it restores the grant from T', async () => {
  const accountId = await insertActor(0x3a11);
  const realm = { route: 0x3a10, id: newId(0x3a10) };
  for (const action of [join, participate])
    await pool.query(
      `INSERT INTO access.resource_grant
        (route, resource_id, subject_id, subject_role, action, valid, transaction_id)
       VALUES ($1, $2, $3, '', $4, '(,)', $2)`,
      [realm.route, realm.id, accountId, action],
    );
  const installed = installedAccess();
  const person = await actor(installed, accountId);
  const origin = new Date();
  const tPast = new Date(origin.getTime() - 2_000);
  const tBan = new Date(origin.getTime());
  const tEnd = new Date(origin.getTime() + 200);
  const ban = {
    resource: realm,
    subjectId: accountId,
    subjectRole: '' as const,
    action: join,
    reason: 'realm_ban' as const,
  };
  const opened = await execute(
    realm,
    async (tx, time) => {
      await recordResourceDenial(tx, { ...ban, at: time });
      return authoritativeTimeValue(time);
    },
    { clock: () => tBan },
  );
  await execute(realm, async (tx, time) => recordResourceDenial(tx, { ...ban, at: time }), { clock: () => tBan });
  const openRows = await pool.query(
    `SELECT action, reason, valid = tstzrange($2::timestamptz, NULL, '[)') AS open
     FROM access.resource_denial WHERE resource_id = $1 AND subject_id = $3`,
    [realm.id, opened, accountId],
  );
  // The second record is the same open key, so the lower bound stays T.
  expect(openRows.rows).toEqual([{ action: join, reason: 'realm_ban', open: true }]);
  const closed = await execute(
    realm,
    async (tx, time) => {
      await endResourceDenial(tx, { ...ban, at: time });
      return authoritativeTimeValue(time);
    },
    { clock: () => tEnd },
  );
  const closedRows = await pool.query(
    `SELECT valid = tstzrange($2::timestamptz, $3::timestamptz, '[)') AS closed
     FROM access.resource_denial WHERE resource_id = $1 AND subject_id = $4 AND action = $5`,
    [realm.id, opened, closed, accountId, join],
  );
  expect(closedRows.rows).toEqual([{ closed: true }]);
  expect(await allowed(installed, person, join, realm, tPast)).toBe(true);
  expect(await allowed(installed, person, join, realm, tBan)).toBe(false);
  expect(await allowed(installed, person, participate, realm, tBan)).toBe(true);
  expect(await allowed(installed, person, join, realm, tEnd)).toBe(true);
  expect(await allowed(installed, person, participate, realm, tEnd)).toBe(true);
}, 60000);

test('denial writes outside a command authorized on the same resource are refused and write nothing', async () => {
  const realm = { route: 0x3a1a, id: newId(0x3a1a) };
  const other = { route: realm.route, id: newId(realm.route) };
  const accountId = await insertActor(0x3a1b);
  const realmId = newId(0x3a1c);
  const ban = {
    resource: realm,
    subjectId: accountId,
    subjectRole: '' as const,
    action: join,
    reason: 'realm_ban' as const,
  };
  const grant = {
    resource: realm,
    principal: { kind: 'realm' as const, id: realmId },
    role: 'member' as const,
    resourceRole,
  };
  async function rows() {
    const denials = await pool.query('SELECT subject_id::text FROM access.resource_denial WHERE resource_id = $1', [
      realm.id,
    ]);
    const grants = await pool.query('SELECT subject_id::text FROM access.resource_role_grant WHERE resource_id = $1', [
      realm.id,
    ]);
    return { denials: denials.rows, grants: grants.rows };
  }
  const before = await rows();
  await expect(
    execute(other, async (tx, time) => recordResourceDenial(tx, { ...ban, at: time }), { authorization: allow(other) }),
  ).rejects.toBeInstanceOf(ResourceAccessWriteDeniedError);
  await expect(
    execute(realm, async (tx, time) => recordResourceDenial(tx, { ...ban, at: time }), { authorization: null }),
  ).rejects.toBeInstanceOf(ResourceAccessWriteDeniedError);
  await expect(
    execute(realm, async (tx) => recordResourceDenial(tx, { ...ban, at: {} as AuthoritativeTime })),
  ).rejects.toBeInstanceOf(ResourceAccessWriteDeniedError);
  await expect(
    execute(other, async (tx, time) => endResourceDenial(tx, { ...ban, at: time }), { authorization: allow(other) }),
  ).rejects.toBeInstanceOf(ResourceAccessWriteDeniedError);
  await expect(
    execute(other, async (tx) => grantGroupRole(tx, grant), { authorization: allow(other) }),
  ).rejects.toBeInstanceOf(ResourceAccessWriteDeniedError);
  await withConnection(pool, async (client) => {
    await expect(recordResourceDenial(client, { ...ban, at: {} as AuthoritativeTime })).rejects.toBeInstanceOf(
      ResourceAccessWriteDeniedError,
    );
    await expect(endResourceDenial(client, { ...ban, at: {} as AuthoritativeTime })).rejects.toBeInstanceOf(
      ResourceAccessWriteDeniedError,
    );
    await expect(grantGroupRole(client, grant)).rejects.toBeInstanceOf(ResourceAccessWriteDeniedError);
  });
  expect(await rows()).toEqual(before);
  expect(before).toEqual({ denials: [], grants: [] });
}, 60000);

test('a realm member group grant on a resource lets current members act through one grant and former members not', async () => {
  const board = { route: 0x3a15, id: newId(0x3a15) };
  const realmId = newId(0x3a16);
  const currentA = await insertActor(0x3a17);
  const currentB = await insertActor(0x3a18);
  const former = await insertActor(0x3a19);
  const inverse = createMembershipInverseCommands({ pool });
  for (const accountId of [currentA, currentB, former])
    await inverse.reserve({ accountId, principal: { kind: 'realm', id: realmId }, key: `realm-grant-${accountId}` });
  await pool.query(
    `INSERT INTO realm_access_piece.membership (route, realm_id, account_id, role, valid) VALUES
      ($1, $2, $3, 'member', tstzrange(clock_timestamp() - interval '1 hour', NULL, '[)')),
      ($1, $2, $4, 'member', tstzrange(clock_timestamp() - interval '1 hour', NULL, '[)')),
      ($1, $2, $5, 'member', tstzrange(clock_timestamp() - interval '2 hours', clock_timestamp() - interval '1 hour', '[)'))`,
    [routeOf(realmId), realmId, currentA, currentB, former],
  );
  const grant = {
    resource: board,
    principal: { kind: 'realm' as const, id: realmId },
    role: 'member' as const,
    resourceRole,
  };
  await execute(board, async (tx) => grantGroupRole(tx, grant));
  await execute(board, async (tx) => grantGroupRole(tx, grant));
  const grants = await pool.query(
    `SELECT subject_kind, subject_id::text, subject_role, grant_role, upper_inf(valid) AS open
     FROM access.resource_role_grant WHERE resource_id = $1`,
    [board.id],
  );
  expect(grants.rows).toEqual([
    { subject_kind: 'identity', subject_id: realmId, subject_role: 'member', grant_role: resourceRole, open: true },
  ]);
  const directs = await pool.query('SELECT action FROM access.resource_grant WHERE resource_id = $1', [board.id]);
  expect(directs.rows).toEqual([]);
  const seen: string[] = [];
  const installed = installedAccess(realmReader(seen));
  expect(await allowed(installed, await actor(installed, currentA), participate, board)).toBe(true);
  expect(await allowed(installed, await actor(installed, currentB), participate, board)).toBe(true);
  expect(await allowed(installed, await actor(installed, former), participate, board)).toBe(false);
  expect(seen).toEqual([`${realmId}/${currentA}`, `${realmId}/${currentB}`, `${realmId}/${former}`]);
}, 60000);
