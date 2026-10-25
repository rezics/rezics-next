import { afterAll, beforeAll, expect, test } from 'bun:test';
import { Pool } from 'pg';
import { readAccount } from '../../src/access/account-data.ts';
import { GrantDeniedError } from '../../src/access/grant-commands.ts';
import {
  createAccountsWorkModule,
  createMembershipWorkPorts,
  enqueueMembership,
} from '../../src/access/membership-work.ts';
import { createAccess } from '../../src/access/permission.ts';
import type { LifecycleRequest } from '../../src/access/lifecycle.ts';
import { createRealmMembership, RealmMembershipRoleError } from '../../src/community/membership.ts';
import { createPool, withConnection } from '../../src/database/pool.ts';
import { accessCheck, type AccountActor } from '../../src/request/access.ts';
import { newId, routeOf } from '../../src/route/route.ts';
import { GLOBAL_CONTEXT } from '../../src/semantic/definitions.ts';
import { createWorkClient } from '../../src/work/client.ts';
import { composeWork } from '../../src/work/registry.ts';

const routeKey = Buffer.alloc(32, 59).toString('base64url');
const actions = ['realm:join', 'realm:manage', 'realm:participate', 'realm:read', 'realm:publish', 'access:grant'];
const scopes = [...new Set(actions)];

let admin: Pool;
let pool: ReturnType<typeof createPool>;
let client: Awaited<ReturnType<typeof createWorkClient>>;
let runtime: Awaited<ReturnType<typeof composeWork>>;
let membership: ReturnType<typeof createRealmMembership>;
let access: ReturnType<typeof createAccess>;

type Installed = {
  realmId: string;
  route: number;
  managerId: string;
  memberId: string;
  strangerId: string;
};

function actor(accountId: string): AccountActor {
  return {
    kind: 'account',
    accountId,
    clientId: 'realm-membership',
    scopes,
    requestedBy: null,
    authnEpoch: 1,
  };
}

async function requestFor(accountId: string): Promise<LifecycleRequest> {
  const account = await withConnection(pool, (connection) => readAccount(connection, routeOf(accountId)!, accountId));
  if (!account) throw new Error('Missing account');
  return { actor: actor(accountId), account, deadline: Date.now() + 60_000 };
}

async function account(id: string) {
  await admin.query(
    "INSERT INTO access.account (route, account_id, kind, state, transaction_id) VALUES ($1,$2,'actor','active',$2)",
    [routeOf(id), id],
  );
}

async function install(memberRoute = 0x2140): Promise<Installed> {
  const route = 0x2130;
  const realmId = newId(route);
  const spaceId = newId(route);
  const spaceRevision = newId(route);
  const realmRevision = newId(route);
  const managerId = newId(route);
  const memberId = newId(memberRoute);
  const strangerId = newId(0x2150);
  const at = '2020-01-01T00:00:00.000Z';
  for (const id of [managerId, memberId, strangerId]) await account(id);
  const connection = await admin.connect();
  try {
    await connection.query('BEGIN');
    await connection.query(
      `INSERT INTO community.space (route, space_id, state, head_revision_id, created_at, creator)
       VALUES ($1,$2,'active',$3,$4,$5)`,
      [route, spaceId, spaceRevision, at, managerId],
    );
    await connection.query(
      `INSERT INTO community.space_revision (route, space_id, revision_id, predecessor, title, summary, created_at, author)
       VALUES ($1,$2,$3,NULL,'Host','', $4,$5)`,
      [route, spaceId, spaceRevision, at, managerId],
    );
    await connection.query(
      `INSERT INTO community.realm
         (route, realm_id, space_id, state, visibility, context_id, head_revision_id, created_at, creator)
       VALUES ($1,$2,$3,'active','protected',$4,$5,$6,$7)`,
      [route, realmId, spaceId, GLOBAL_CONTEXT, realmRevision, at, managerId],
    );
    await connection.query(
      `INSERT INTO community.realm_revision
         (route, realm_id, revision_id, predecessor, title, summary, visibility, context_id, created_at, author)
       VALUES ($1,$2,$3,NULL,'Realm','','protected',$4,$5,$6)`,
      [route, realmId, realmRevision, GLOBAL_CONTEXT, at, managerId],
    );
    await connection.query('COMMIT');
  } catch (error) {
    await connection.query('ROLLBACK');
    throw error;
  } finally {
    connection.release();
  }
  await admin.query(
    `INSERT INTO access.resource_grant (route, resource_id, subject_id, action, valid, transaction_id)
     VALUES ($1,$2,$3,'realm:manage','(,)',$3), ($1,$2,$4,'realm:join','(,)',$4)`,
    [route, realmId, managerId, memberId],
  );
  return { realmId, route, managerId, memberId, strangerId };
}

async function reference(accountId: string) {
  return `authenticated-fixture.${accountId}`;
}

type RealmMembership = ReturnType<typeof createRealmMembership>;

beforeAll(async () => {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is required');
  admin = new Pool({ connectionString: url });
  pool = createPool(url);
  pool.options.max = 10;
  pool.options.connectionTimeoutMillis = 10_000;
  client = await createWorkClient(url);
  // The reader is installed before publication so a later member grant can use it.
  let roleReader: RealmMembership['roleReader'] = async () => null;
  access = createAccess({
    actions: new Map(scopes.map((action) => [action, { anonymous: false }])),
    accountEvidence: (_actor, context) => context.account,
    realmRoleReader: (connection, input) => roleReader(connection, input),
  });
  membership = createRealmMembership({ pool, access });
  roleReader = membership.roleReader;
  runtime = await composeWork([createAccountsWorkModule({ realm: membership, access, authorize })], {
    databaseUrl: url,
    pool,
    client,
    env: { KERNEL_ROUTE_KEY: routeKey },
  });
  await runtime.launch();

  async function authorize(ref: string) {
    const accountId = /^authenticated-fixture\.(.+)$/.exec(ref)?.[1];
    if (!accountId || routeOf(accountId) === null) throw new Error('No approval');
    return requestFor(accountId);
  }
}, 120_000);

afterAll(async () => {
  await runtime?.shutdown();
  await client?.close();
  await pool?.end();
  await admin?.end();
});

async function authorize(ref: string) {
  const accountId = /^authenticated-fixture\.(.+)$/.exec(ref)?.[1];
  if (!accountId || routeOf(accountId) === null) throw new Error('No approval');
  return requestFor(accountId);
}

test("accounts' membership workflow with the community Realm adapter joins an account to a Realm, and the role reader proves membership from T with a valid range", async () => {
  const installed = await install();
  const selfId = `realm-membership-self-${crypto.randomUUID()}`;
  const self = await enqueueMembership(client, selfId, {
    kind: 'membership',
    principal: { kind: 'realm', id: installed.realmId },
    memberAccountId: installed.memberId,
    role: 'member',
    authorization: await reference(installed.memberId),
  });
  const joined = await self.getResult();
  expect(joined).toEqual({ status: 'completed', accountId: installed.memberId, reservationId: expect.any(String) });
  if (joined.status !== 'completed') throw new Error('Join did not complete');
  expect(routeOf(joined.reservationId)).toBe(routeOf(installed.memberId));

  const managedMember = newId(0x2160);
  await account(managedMember);
  await admin.query(
    `INSERT INTO access.resource_grant (route, resource_id, subject_id, action, valid, transaction_id)
       VALUES ($1,$2,$3,'realm:manage','(,)',$3) ON CONFLICT DO NOTHING`,
    [installed.route, installed.realmId, installed.managerId],
  );
  const managed = await (
    await enqueueMembership(client, `realm-membership-managed-${crypto.randomUUID()}`, {
      kind: 'membership',
      principal: { kind: 'realm', id: installed.realmId },
      memberAccountId: managedMember,
      role: 'member',
      authorization: await reference(installed.managerId),
    })
  ).getResult();
  expect(managed).toMatchObject({ status: 'completed', accountId: managedMember });

  const stored = (
    await admin.query<{ open: boolean; valid: string; at: string; transaction_id: string }>(
      `SELECT upper_inf(valid) AS open, valid::text AS valid, lower(valid)::text AS at, transaction_id::text AS transaction_id
         FROM community.realm_member WHERE route = $1 AND realm_id = $2 AND account_id = $3`,
      [installed.route, installed.realmId, installed.memberId],
    )
  ).rows;
  expect(stored).toHaveLength(1);
  expect(stored[0]!.open).toBe(true);

  const proofs = await withConnection(pool, (connection) =>
    membership.roleReader(connection, {
      realmId: installed.realmId,
      accountId: installed.memberId,
      at: stored[0]!.at,
    }),
  );
  expect(proofs?.map((proof) => proof.role)).toEqual(['owner', 'member']);
  const owner = proofs!.find((proof) => proof.role === 'owner')!;
  const member = proofs!.find((proof) => proof.role === 'member')!;
  expect(owner.member).toBe(false);
  expect(member).toEqual({ role: 'member', member: true, valid: stored[0]!.valid });
  expect(
    (await admin.query('SELECT $1::tstzrange @> $2::timestamptz AS covers', [owner.valid, stored[0]!.at])).rows[0]
      .covers,
  ).toBe(true);
  expect(
    (await admin.query('SELECT $1::tstzrange @> $2::timestamptz AS covers', [member.valid, stored[0]!.at])).rows[0]
      .covers,
  ).toBe(true);

  const before = (
    await admin.query<{ at: string }>(`SELECT ($1::timestamptz - interval '1 microsecond')::text AS at`, [
      stored[0]!.at,
    ])
  ).rows[0]!.at;
  const earlier = await withConnection(pool, (connection) =>
    membership.roleReader(connection, { realmId: installed.realmId, accountId: installed.memberId, at: before }),
  );
  const earlierMember = earlier!.find((proof) => proof.role === 'member')!;
  expect(earlierMember.member).toBe(false);
  expect(
    (await admin.query('SELECT $1::tstzrange @> $2::timestamptz AS covers', [earlierMember.valid, stored[0]!.at]))
      .rows[0].covers,
  ).toBe(false);
  expect(
    await withConnection(pool, (connection) =>
      membership.roleReader(connection, {
        realmId: newId(installed.route),
        accountId: installed.memberId,
        at: stored[0]!.at,
      }),
    ),
  ).toBeNull();
  const future = (
    await admin.query<{ at: string }>(
      `SELECT (created_at - interval '1 microsecond')::text AS at FROM community.realm WHERE realm_id = $1`,
      [installed.realmId],
    )
  ).rows[0]!.at;
  expect(
    await withConnection(pool, (connection) =>
      membership.roleReader(connection, { realmId: installed.realmId, accountId: installed.memberId, at: future }),
    ),
  ).toBeNull();

  const held = {
    accountId: installed.memberId,
    principal: { kind: 'realm' as const, id: installed.realmId },
    reservationId: joined.reservationId,
  };
  const stranger = await requestFor(installed.strangerId);
  const ownerRejection = await membership
    .publish(
      stranger,
      {
        kind: 'membership',
        principal: held.principal,
        memberAccountId: installed.strangerId,
        role: 'owner',
        authorization: await reference(installed.strangerId),
      },
      { ...held, accountId: installed.strangerId, reservationId: newId(routeOf(installed.strangerId)!) },
      `owner-${crypto.randomUUID()}`,
    )
    .catch((error: unknown) => error);
  expect(ownerRejection).toBeInstanceOf(RealmMembershipRoleError);
  expect(ownerRejection).toMatchObject({ code: 'realm_owner_membership', message: 'Realm owners are identity grants' });
  await expect(
    membership.publish(
      stranger,
      {
        kind: 'membership',
        principal: held.principal,
        memberAccountId: installed.strangerId,
        role: 'member',
        authorization: await reference(installed.strangerId),
      },
      { ...held, accountId: installed.strangerId, reservationId: newId(routeOf(installed.strangerId)!) },
      `stranger-${crypto.randomUUID()}`,
    ),
  ).rejects.toBeInstanceOf(GrantDeniedError);

  await admin.query(
    `INSERT INTO access.resource_grant
         (route, resource_id, subject_id, subject_role, action, valid, transaction_id)
       VALUES ($1,$2,$2,'member','realm:participate','(,)',$3)`,
    [installed.route, installed.realmId, newId(installed.route)],
  );
  const memberRequest = await requestFor(installed.memberId);
  const participate = await accessCheck(
    access,
    memberRequest.actor,
    'realm:participate',
    { route: installed.route, id: installed.realmId },
    { ...memberRequest, pool },
  );
  expect(await withConnection(pool, (connection) => participate(connection))).toBe(true);

  const replay = await membership.publish(
    await requestFor(installed.memberId),
    {
      kind: 'membership',
      principal: held.principal,
      memberAccountId: installed.memberId,
      role: 'member',
      authorization: await reference(installed.memberId),
    },
    held,
    `wf:${selfId}:publish`,
  );
  expect(replay.replayed).toBe(true);
  expect(replay.transactionId).toBe(stored[0]!.transaction_id);
  expect(
    (
      await admin.query(
        'SELECT count(*)::int AS n FROM community.realm_member WHERE realm_id = $1 AND account_id = $2',
        [installed.realmId, installed.memberId],
      )
    ).rows[0].n,
  ).toBe(1);
  const change = await withConnection(pool, (connection) =>
    membership.authority.readChange(connection, {
      accountId: installed.memberId,
      principal: held.principal,
      key: 'join-change',
      sourceTransactionId: stored[0]!.transaction_id,
    }),
  );
  expect(change).toEqual({
    accountId: installed.memberId,
    principal: held.principal,
    key: 'join-change',
    sourceTransactionId: stored[0]!.transaction_id,
    reservationId: joined.reservationId,
  });
  expect(
    await withConnection(pool, (connection) =>
      membership.authority.readChange(connection, {
        accountId: installed.memberId,
        principal: held.principal,
        key: 'missing-change',
        sourceTransactionId: newId(installed.route),
      }),
    ),
  ).toBeNull();
}, 120_000);

test('leave commits a terminal slot so release completes, terminalize closes only an unpublished reservation, and every step replays by its key', async () => {
  const installed = await install(0x2240);
  const joinId = `realm-membership-join-${crypto.randomUUID()}`;
  const principal = { kind: 'realm' as const, id: installed.realmId };
  const joined = await (
    await enqueueMembership(client, joinId, {
      kind: 'membership',
      principal,
      memberAccountId: installed.memberId,
      role: 'member',
      authorization: await reference(installed.memberId),
    })
  ).getResult();
  if (joined.status !== 'completed') throw new Error('Join did not complete');
  const held = { accountId: installed.memberId, principal, reservationId: joined.reservationId };
  expect(await withConnection(pool, (connection) => membership.authority.readTerminal(connection, held))).toBeNull();
  const joinedRow = (
    await admin.query<{ transaction_id: string }>(
      'SELECT transaction_id::text AS transaction_id FROM community.realm_member WHERE realm_id = $1 AND account_id = $2',
      [installed.realmId, installed.memberId],
    )
  ).rows[0]!;
  const joinReplay = await membership.publish(
    await requestFor(installed.memberId),
    {
      kind: 'membership',
      principal,
      memberAccountId: installed.memberId,
      role: 'member',
      authorization: await reference(installed.memberId),
    },
    held,
    `wf:${joinId}:publish`,
  );
  expect(joinReplay.replayed).toBe(true);
  expect(joinReplay.transactionId).toBe(joinedRow.transaction_id);
  const reserveReplay = await ports().reserve({
    accountId: installed.memberId,
    principal,
    key: `wf:${joinId}:reserve`,
  });
  expect(reserveReplay.replayed).toBe(true);
  expect(reserveReplay.value.reservationId).toBe(joined.reservationId);

  const leaveId = `realm-membership-leave-${crypto.randomUUID()}`;
  const left = await (
    await enqueueMembership(client, leaveId, {
      kind: 'membership',
      principal,
      memberAccountId: installed.memberId,
      role: null,
      reservationId: joined.reservationId,
      authorization: await reference(installed.memberId),
    })
  ).getResult();
  expect(left).toEqual({ status: 'completed', accountId: installed.memberId, reservationId: joined.reservationId });
  const interval = (
    await admin.query<{ open: boolean; transaction_id: string }>(
      `SELECT upper_inf(valid) AS open, transaction_id::text AS transaction_id
         FROM community.realm_member WHERE realm_id = $1 AND account_id = $2`,
      [installed.realmId, installed.memberId],
    )
  ).rows;
  expect(interval).toHaveLength(1);
  expect(interval[0]!.open).toBe(false);
  const terminal = await withConnection(pool, (connection) => membership.authority.readTerminal(connection, held));
  expect(terminal?.reservationId).toBe(joined.reservationId);
  expect(typeof terminal?.transactionId).toBe('string');
  expect(routeOf(terminal!.transactionId)).not.toBeNull();
  expect(
    (
      await admin.query('SELECT count(*)::int AS n FROM access.membership_inverse WHERE account_id = $1', [
        installed.memberId,
      ])
    ).rows[0].n,
  ).toBe(0);
  const leaveChange = await withConnection(pool, (connection) =>
    membership.authority.readChange(connection, {
      accountId: installed.memberId,
      principal,
      key: 'leave-change',
      sourceTransactionId: interval[0]!.transaction_id,
    }),
  );
  expect(leaveChange?.reservationId).toBe(joined.reservationId);
  const leaveReplay = await membership.publish(
    await requestFor(installed.memberId),
    {
      kind: 'membership',
      principal,
      memberAccountId: installed.memberId,
      role: null,
      reservationId: joined.reservationId,
      authorization: await reference(installed.memberId),
    },
    held,
    `wf:${leaveId}:publish`,
  );
  expect(leaveReplay.replayed).toBe(true);
  expect(leaveReplay.transactionId).toBe(interval[0]!.transaction_id);
  const releaseReplay = await ports().release({ ...held, key: `wf:${leaveId}:release` });
  expect(releaseReplay.replayed).toBe(true);
  const repeated = await (
    await enqueueMembership(client, leaveId, {
      kind: 'membership',
      principal,
      memberAccountId: installed.memberId,
      role: null,
      reservationId: joined.reservationId,
      authorization: await reference(installed.memberId),
    })
  ).getResult();
  expect(repeated).toEqual(left);
  await expect(membership.terminalize(held, `terminal-published-${crypto.randomUUID()}`)).rejects.toThrow();
  expect(
    (
      await admin.query(
        'SELECT count(*)::int AS n FROM community.realm_member WHERE realm_id = $1 AND account_id = $2',
        [installed.realmId, installed.memberId],
      )
    ).rows[0].n,
  ).toBe(1);

  const freshId = newId(0x2250);
  await account(freshId);
  const freshHeld = (
    await ports().reserve({ accountId: freshId, principal, key: `direct-reserve-${crypto.randomUUID()}` })
  ).value;
  const terminalKey = `direct-terminal-${crypto.randomUUID()}`;
  const first = await ports().terminalize(freshHeld, terminalKey);
  const second = await ports().terminalize(freshHeld, terminalKey);
  expect(second.replayed).toBe(true);
  expect(second.transactionId).toBe(first.transactionId);
  await expect(ports().terminalize(freshHeld, `direct-terminal-${crypto.randomUUID()}`)).rejects.toThrow();
  await ports().release({ ...freshHeld, key: `direct-release-${crypto.randomUUID()}` });
  expect(
    (await admin.query('SELECT count(*)::int AS n FROM access.membership_inverse WHERE account_id = $1', [freshId]))
      .rows[0].n,
  ).toBe(0);
  expect(
    (await admin.query('SELECT count(*)::int AS n FROM community.realm_member WHERE account_id = $1', [freshId]))
      .rows[0].n,
  ).toBe(0);

  const blockedId = newId(0x2260);
  await account(blockedId);
  const failedId = `realm-membership-failed-${crypto.randomUUID()}`;
  const failed = await enqueueMembership(client, failedId, {
    kind: 'membership',
    principal,
    memberAccountId: blockedId,
    role: 'member',
    authorization: await reference(blockedId),
  });
  await expect(failed.getResult()).rejects.toThrow('Membership workflow step failed: publish');
  expect(
    (await admin.query('SELECT count(*)::int AS n FROM community.realm_member WHERE account_id = $1', [blockedId]))
      .rows[0].n,
  ).toBe(0);
  const blockedTerminal = (
    await admin.query<{ reservation_id: string }>(
      'SELECT reservation_id::text AS reservation_id FROM community.realm_member_terminal WHERE account_id = $1',
      [blockedId],
    )
  ).rows;
  expect(blockedTerminal).toHaveLength(1);
  expect(
    (await admin.query('SELECT count(*)::int AS n FROM access.membership_inverse WHERE account_id = $1', [blockedId]))
      .rows[0].n,
  ).toBe(0);
  const blockedHeld = { accountId: blockedId, principal, reservationId: blockedTerminal[0]!.reservation_id };
  const reservedAgain = await ports().reserve({ accountId: blockedId, principal, key: `wf:${failedId}:reserve` });
  expect(reservedAgain.replayed).toBe(true);
  expect(reservedAgain.value.reservationId).toBe(blockedHeld.reservationId);
  const terminalAgain = await membership.terminalize(blockedHeld, `wf:${failedId}:terminalize`);
  expect(terminalAgain.replayed).toBe(true);
  const releasedAgain = await ports().release({ ...blockedHeld, key: `wf:${failedId}:release` });
  expect(releasedAgain.replayed).toBe(true);
}, 120_000);

function ports() {
  return createMembershipWorkPorts(
    { pool, env: { KERNEL_ROUTE_KEY: routeKey } },
    { realm: membership, access, authorize },
  );
}
