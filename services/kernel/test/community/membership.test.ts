import { suspendAccount } from '../support/native-suspension-driver.ts';
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { Pool } from 'pg';
import { readAccount } from '../../src/access/account-data.ts';
import { GrantDeniedError } from '../../src/access/grant-commands.ts';
import {
  createAccountsWorkModule,
  createMembershipWorkPorts,
  enqueueMembership,
} from '../../src/access/membership-work.ts';
import { deriveAccess } from '../../src/access/derived-access.ts';
import { createInitiatorRestorer, DurableInitiatorUnavailableError } from '../../src/access/durable-initiator.ts';
import type { LifecycleRequest } from '../../src/access/lifecycle.ts';
import {
  createRealmMembership,
  readMembershipInitiator,
  RealmMembershipRoleError,
} from '../../src/community/membership.ts';
import { enqueueRealmJoin, enqueueRealmLeave, enqueueRealmRemoval } from '../../src/community/join.ts';
import { createPool, withConnection } from '../../src/database/pool.ts';
import { accessCheck, type Access, type AccountActor } from '../../src/request/access.ts';
import { withRequestDeadline } from '../../src/request/deadline.ts';
import { newId, routeOf } from '../../src/route/route.ts';
import { GLOBAL_CONTEXT } from '../../src/semantic/definitions.ts';
import { createWorkClient } from '../../src/work/client.ts';
import { composeWork } from '../../src/work/registry.ts';
import { createProductionAccess, type ProductionAccess } from './membership-fixture.ts';

const routeKey = Buffer.alloc(32, 59).toString('base64url');
const actions = [
  'realm:join',
  'realm:manage',
  'realm:ban',
  'realm:participate',
  'realm:read',
  'realm:publish',
  'access:grant',
];
const scopes = [...new Set(actions)];
const authenticationHooks = new Map<string, () => Promise<void>>();
const tokens = { current: 1, keys: new Map([[1, new Uint8Array(32).fill(7)]]) };
/** What Auth's current consent answers per account. Absent means no consent. */
const consent = new Map<string, readonly string[]>();
const consentReads: string[] = [];

let admin: Pool;
let pool: ReturnType<typeof createPool>;
let client: Awaited<ReturnType<typeof createWorkClient>>;
let runtime: Awaited<ReturnType<typeof composeWork>>;
let membership: ReturnType<typeof createRealmMembership>;
let access: Access;
let production: ProductionAccess;

type Installed = {
  realmId: string;
  spaceId: string;
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

/** The request Access authenticated: the actor object is the authenticator's own. */
async function requestFor(accountId: string): Promise<LifecycleRequest> {
  const account = await withConnection(pool, (connection) => readAccount(connection, routeOf(accountId)!, accountId));
  if (!account) throw new Error('Missing account');
  return { actor: await production.authenticate(pool, accountId, scopes), account, deadline: Date.now() + 60_000 };
}

async function account(id: string) {
  await admin.query(
    "INSERT INTO access.account (route, account_id, kind, state, transaction_id) VALUES ($1,$2,'actor','active',$2)",
    [routeOf(id), id],
  );
}

async function install(memberRoute = 0x2140, visibility: 'public' | 'protected' = 'protected'): Promise<Installed> {
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
       VALUES ($1,$2,$3,'active',$8,$4,$5,$6,$7)`,
      [route, realmId, spaceId, GLOBAL_CONTEXT, realmRevision, at, managerId, visibility],
    );
    await connection.query(
      `INSERT INTO community.realm_revision
         (route, realm_id, revision_id, predecessor, title, summary, visibility, context_id, created_at, author)
       VALUES ($1,$2,$3,NULL,'Realm','',$7,$4,$5,$6)`,
      [route, realmId, realmRevision, GLOBAL_CONTEXT, at, managerId, visibility],
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
  return { realmId, spaceId, route, managerId, memberId, strangerId };
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
  // Production composition: its authenticator and command admission refuse every actor it did not produce.
  production = await createProductionAccess({
    actions: scopes,
    realmRoleReader: (connection, input) => roleReader(connection, input),
  });
  access = deriveAccess(production.access, {
    async authenticate(ref, context) {
      const accountId = /^authenticated-fixture\.(.+)$/.exec(ref)?.[1];
      if (!accountId || routeOf(accountId) === null) throw new Error('No approval');
      await authenticationHooks.get(ref)?.();
      return production.access.authenticate(await production.mint(accountId, scopes), context);
    },
  });
  membership = createRealmMembership({
    pool,
    access,
    referenceKeys: tokens,
    restorer: createInitiatorRestorer({
      pool,
      access,
      readOperation: readMembershipInitiator,
      async readConsent({ actorAccountId, clientId }) {
        consentReads.push(actorAccountId);
        const granted = consent.get(actorAccountId);
        return granted ? { actorAccountId, clientId, scopes: granted } : null;
      },
    }),
  });
  roleReader = membership.roleReader;
  runtime = await composeWork([createAccountsWorkModule({ realm: membership, access, authorize })], {
    databaseUrl: url,
    pool,
    client,
    env: { KERNEL_ROUTE_KEY: routeKey },
  });
  await runtime.launch();
}, 120_000);

afterAll(async () => {
  await runtime?.shutdown();
  await client?.close();
  await pool?.end();
  await admin?.end();
});

async function authorize(): Promise<LifecycleRequest> {
  throw new Error('Realm work must use the installed Realm authorization port');
}

test('Realm authorization resolves identity and current self-join or management permission through Access', async () => {
  const installed = await install();
  const input = {
    kind: 'membership' as const,
    principal: { kind: 'realm' as const, id: installed.realmId },
    memberAccountId: installed.memberId,
    role: 'member' as const,
    authorization: await reference(installed.memberId),
  };
  const resolved = await membership.authorize(input.authorization, input);
  expect(resolved.actor).toEqual(actor(installed.memberId));
  expect(resolved.account?.accountId).toBe(installed.memberId);
  expect(resolved.deadline).toBeGreaterThan(Date.now());
  const manager = await membership.authorize(await reference(installed.managerId), input);
  expect(manager.actor.accountId).toBe(installed.managerId);
  await expect(membership.authorize(await reference(installed.strangerId), input)).rejects.toBeInstanceOf(
    GrantDeniedError,
  );
  await expect(membership.authorize('invalid-reference', input)).rejects.toThrow();
  await expect(membership.authorize(input.authorization, { ...input, role: 'owner' })).rejects.toBeInstanceOf(
    RealmMembershipRoleError,
  );
  await expect(
    membership.authorize(input.authorization, { ...input, principal: { kind: 'organization', id: installed.realmId } }),
  ).rejects.toBeInstanceOf(GrantDeniedError);
  await expect(
    membership.authorize(input.authorization, { ...input, memberAccountId: 'invalid' }),
  ).rejects.toBeInstanceOf(GrantDeniedError);
  await admin.query('DELETE FROM access.resource_grant WHERE resource_id = $1 AND subject_id = $2', [
    installed.realmId,
    installed.memberId,
  ]);
  await expect(membership.authorize(input.authorization, input)).rejects.toBeInstanceOf(GrantDeniedError);
});

test('Realm authorization and publication share the enclosing request deadline', async () => {
  const installed = await install();
  const input = {
    kind: 'membership' as const,
    principal: { kind: 'realm' as const, id: installed.realmId },
    memberAccountId: installed.memberId,
    role: 'member' as const,
    authorization: await reference(installed.memberId),
  };
  const requestDeadline = Date.now() + 1000;
  const request = await withRequestDeadline(requestDeadline, () => membership.authorize(input.authorization, input));
  expect(request.deadline).toBe(requestDeadline);
  await new Promise((resolve) => setTimeout(resolve, Math.max(0, requestDeadline - Date.now() + 5)));

  const reservation = {
    accountId: installed.memberId,
    principal: input.principal,
    reservationId: newId(routeOf(installed.memberId)!),
  };
  await expect(
    membership.publish(request, input, reservation, `expired-${crypto.randomUUID()}`),
  ).rejects.toBeInstanceOf(GrantDeniedError);
});

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
  const reserveReplay = command(
    await ports().reserve({
      accountId: installed.memberId,
      principal,
      key: `wf:${joinId}:reserve`,
    }),
  );
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
  const releaseReplay = command(await ports().release({ ...held, key: `wf:${leaveId}:release` }));
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
  const first = command(await ports().terminalize(freshHeld, terminalKey));
  const second = command(await ports().terminalize(freshHeld, terminalKey));
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
  await admin.query(
    `INSERT INTO access.resource_grant (route, resource_id, subject_id, action, valid, transaction_id)
     VALUES ($1,$2,$3,'realm:join','(,)',$3)`,
    [installed.route, installed.realmId, blockedId],
  );
  const blockedReference = await reference(blockedId);
  let resolutions = 0;
  authenticationHooks.set(blockedReference, async () => {
    if (++resolutions === 2) {
      await admin.query('DELETE FROM access.resource_grant WHERE resource_id = $1 AND subject_id = $2', [
        installed.realmId,
        blockedId,
      ]);
      authenticationHooks.delete(blockedReference);
    }
  });
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
  const reservedAgain = command(
    await ports().reserve({ accountId: blockedId, principal, key: `wf:${failedId}:reserve` }),
  );
  expect(reservedAgain.replayed).toBe(true);
  expect(reservedAgain.value.reservationId).toBe(blockedHeld.reservationId);
  const terminalAgain = await membership.terminalize(blockedHeld, `wf:${failedId}:terminalize`);
  expect(terminalAgain.replayed).toBe(true);
  const releasedAgain = command(await ports().release({ ...blockedHeld, key: `wf:${failedId}:release` }));
  expect(releasedAgain.replayed).toBe(true);
}, 120_000);

type CommandResult = {
  replayed: boolean;
  transactionId: string;
  value: { reservationId: string };
};

/** Workflow ports type the step result as unknown. The command outcome still carries the receipt. */
function command(value: unknown): CommandResult {
  if (!value || typeof value !== 'object' || !('replayed' in value) || !('transactionId' in value))
    throw new Error('Missing command result');
  return value as CommandResult;
}

function ports() {
  return createMembershipWorkPorts(
    { pool, env: { KERNEL_ROUTE_KEY: routeKey } },
    { realm: membership, access, authorize },
  );
}

test('publish authorizes with the actor the authenticator produced, never a copy', async () => {
  const installed = await install();
  const input = {
    kind: 'membership' as const,
    principal: { kind: 'realm' as const, id: installed.realmId },
    memberAccountId: installed.memberId,
    role: 'member' as const,
    authorization: await reference(installed.memberId),
  };
  const reservation = (
    await ports().reserve({
      accountId: installed.memberId,
      principal: input.principal,
      key: `copy-${crypto.randomUUID()}`,
    })
  ).value;
  const request = await requestFor(installed.memberId);
  // Same fields, different object: production admission knows only what its authenticator produced.
  const copy = { ...request, actor: { ...request.actor, scopes: [...request.actor.scopes] } };
  await expect(membership.publish(copy, input, reservation, `copy-${crypto.randomUUID()}`)).rejects.toBeInstanceOf(
    GrantDeniedError,
  );
  expect(
    (
      await admin.query('SELECT count(*)::int AS n FROM community.realm_member WHERE account_id = $1', [
        installed.memberId,
      ])
    ).rows[0].n,
  ).toBe(0);
  const published = await membership.publish(request, input, reservation, `copy-${crypto.randomUUID()}`);
  expect(published).toMatchObject({ replayed: false });
  expect(
    (
      await admin.query('SELECT count(*)::int AS n FROM community.realm_member WHERE account_id = $1', [
        installed.memberId,
      ])
    ).rows[0].n,
  ).toBe(1);
}, 120_000);

type Accepted = { authorization: string; workflowId: string; input: Record<string, unknown> };

/** Accept through the native command, but hold the workflow: the step runs when the test says. */
function holdingClient() {
  const stored = new Map<string, { workflowName: string; input: unknown[] }>();
  const client = {
    async getWorkflow(id: string) {
      return stored.get(id);
    },
    async enqueue(options: { workflowName: string; workflowID: string }, body: unknown) {
      stored.set(options.workflowID, { workflowName: options.workflowName, input: [body] });
    },
  };
  return { client: client as unknown as Awaited<ReturnType<typeof createWorkClient>>, stored };
}

function acceptanceDependencies(held: ReturnType<typeof holdingClient>) {
  return { pool, access, tokens, client: held.client };
}

function accepted(held: ReturnType<typeof holdingClient>, workflowId: string): Accepted {
  const stored = held.stored.get(workflowId);
  if (!stored) throw new Error('Nothing was enqueued');
  const input = stored.input[0] as Record<string, unknown>;
  return { authorization: input.authorization as string, workflowId, input };
}

/** Run Accounts' membership workflow with the sealed reference the acceptance produced. */
async function runSealed(installed: Installed, value: Accepted, overrides: Record<string, unknown> = {}) {
  const run = await enqueueMembership(client, `realm-sealed-${crypto.randomUUID()}`, {
    kind: 'membership',
    principal: { kind: 'realm', id: installed.realmId },
    memberAccountId: value.input.memberAccountId as string,
    role: value.input.role as 'member' | null,
    ...(value.input.reservationId === undefined ? {} : { reservationId: value.input.reservationId as string }),
    authorization: value.authorization,
    ...overrides,
  });
  return run.getResult();
}

async function memberRows(realmId: string, accountId: string) {
  return (
    await admin.query<{ open: boolean }>(
      'SELECT upper_inf(valid) AS open FROM community.realm_member WHERE realm_id = $1 AND account_id = $2',
      [realmId, accountId],
    )
  ).rows;
}

async function accept(installed: Installed, accountId: string, memberId = accountId) {
  const held = holdingClient();
  const result = await enqueueRealmJoin(acceptanceDependencies(held), {
    actor: await production.authenticate(pool, accountId, scopes),
    realmId: installed.realmId,
    spaceId: installed.spaceId,
    memberAccountId: memberId,
    idempotencyKey: crypto.randomUUID(),
    deadline: Date.now() + 30_000,
  });
  return accepted(held, result.workflowId);
}

test('the sealed workflow path authorizes with the actor restoreInitiator returns over a committed operation row, never one built from the seal', async () => {
  const installed = await install(0x2340, 'public');
  consent.set(installed.memberId, scopes);
  const join = await accept(installed, installed.memberId);
  // Acceptance committed the operation and its creation receipt; the seal names it and carries no actor.
  const operation = (
    await admin.query<{ kind: string; initiator_account_id: string; actor_scopes: string[] }>(
      'SELECT kind, initiator_account_id, actor_scopes FROM community.realm_membership_operation WHERE realm_id = $1',
      [installed.realmId],
    )
  ).rows;
  expect(operation).toEqual([{ kind: 'join', initiator_account_id: installed.memberId, actor_scopes: scopes }]);
  expect(JSON.stringify(join.input)).not.toContain(installed.memberId.slice(0, 8) + 'actor');
  const readsBefore = consentReads.length;
  const joined = await runSealed(installed, join);
  expect(joined).toMatchObject({ status: 'completed', accountId: installed.memberId });
  // The step restored the initiator from Auth's current consent; the seal alone could not.
  expect(consentReads.length).toBeGreaterThan(readsBefore);
  expect(await memberRows(installed.realmId, installed.memberId)).toEqual([{ open: true }]);

  // Leave restores the same person for realm:join and closes only their own interval.
  const leaving = holdingClient();
  const left = await enqueueRealmLeave(acceptanceDependencies(leaving), {
    actor: await production.authenticate(pool, installed.memberId, scopes),
    realmId: installed.realmId,
    spaceId: installed.spaceId,
    reservationId: (joined as { reservationId: string }).reservationId,
    deadline: Date.now() + 30_000,
  });
  expect(await runSealed(installed, accepted(leaving, left.workflowId))).toMatchObject({ status: 'completed' });
  expect(await memberRows(installed.realmId, installed.memberId)).toEqual([{ open: false }]);

  // A manager adds another account: the manager's own realm:manage is checked at the step.
  consent.set(installed.managerId, scopes);
  const added = await accept(installed, installed.managerId, installed.strangerId);
  expect(await runSealed(installed, added)).toMatchObject({ status: 'completed', accountId: installed.strangerId });
  expect(await memberRows(installed.realmId, installed.strangerId)).toEqual([{ open: true }]);
}, 120_000);

test('a sealed step with no restorer, or a reference for another operation, fails closed', async () => {
  const installed = await install(0x2350, 'public');
  consent.set(installed.memberId, scopes);
  const join = await accept(installed, installed.memberId);
  const principal = { kind: 'realm' as const, id: installed.realmId };
  const input = {
    kind: 'membership' as const,
    principal,
    memberAccountId: installed.memberId,
    role: 'member' as const,
    authorization: join.authorization,
  };
  const carrier = await membership.authorize(join.authorization, input);
  const reservation = (
    await ports().reserve({ accountId: installed.memberId, principal, key: `closed-${crypto.randomUUID()}` })
  ).value;
  // The carrier's actor is a committed snapshot Access never authenticated: another adapter cannot use it.
  const bare = createRealmMembership({ pool, access, referenceKeys: tokens });
  await expect(bare.publish(carrier, input, reservation, `closed-${crypto.randomUUID()}`)).rejects.toBeInstanceOf(
    GrantDeniedError,
  );
  // Without a restorer a sealed step has no identity at all.
  await expect(
    bare
      .authorize(join.authorization, input)
      .then((own) => bare.publish(own, input, reservation, `closed-${crypto.randomUUID()}`)),
  ).rejects.toBeInstanceOf(DurableInitiatorUnavailableError);
  expect(await memberRows(installed.realmId, installed.memberId)).toEqual([]);
  // The seal's facts must match the workflow input.
  await expect(
    membership.authorize(join.authorization, { ...input, memberAccountId: installed.strangerId }),
  ).rejects.toBeInstanceOf(GrantDeniedError);
  await expect(
    membership.authorize(join.authorization, { ...input, role: null, reservationId: reservation.reservationId }),
  ).rejects.toBeInstanceOf(GrantDeniedError);
}, 120_000);

test('a revoked, suspended or fenced initiator is denied at the workflow step with no effect', async () => {
  const cases: { name: string; change: (installed: Installed) => Promise<void> }[] = [
    {
      name: 'consent withdrawn',
      change: async (installed) => void consent.delete(installed.memberId),
    },
    {
      name: 'consent reduced',
      change: async (installed) => void consent.set(installed.memberId, ['realm:read']),
    },
    {
      name: 'grant revoked',
      change: async (installed) => {
        await admin.query('DELETE FROM access.resource_grant WHERE resource_id = $1 AND subject_id = $2', [
          installed.realmId,
          installed.memberId,
        ]);
      },
    },
    {
      name: 'suspended',
      change: async (installed) => {
        await suspendAccount(admin, installed.memberId);
      },
    },
    {
      name: 'fenced',
      change: async (installed) => {
        await admin.query('UPDATE access.account SET authn_fenced = true WHERE account_id = $1', [installed.memberId]);
      },
    },
    {
      name: 'floor raised',
      change: async (installed) => {
        await admin.query('UPDATE access.account SET minimum_authn_epoch = 2 WHERE account_id = $1', [
          installed.memberId,
        ]);
      },
    },
  ];
  for (const [index, { name, change }] of cases.entries()) {
    const installed = await install(0x2360 + index, 'public');
    consent.set(installed.memberId, scopes);
    const join = await accept(installed, installed.memberId);
    await change(installed);
    // An inactive account is already refused when its inverse slot is reserved; the rest fail at publish.
    await expect(runSealed(installed, join), name).rejects.toThrow(
      /^Membership workflow step failed: (reserve|publish)$/,
    );
    expect(await memberRows(installed.realmId, installed.memberId), name).toEqual([]);
    expect(
      (
        await admin.query(
          `SELECT count(*)::int AS n FROM core.receipt WHERE principal_id = $1 AND command_kind = 'community.realm.membership'`,
          [installed.memberId],
        )
      ).rows[0].n,
      name,
    ).toBe(0);
  }
}, 240_000);

test('a ban removal restores the moderator and needs their own realm:ban at the step', async () => {
  const installed = await install(0x2380, 'public');
  consent.set(installed.memberId, scopes);
  consent.set(installed.managerId, scopes);
  const joined = await runSealed(installed, await accept(installed, installed.memberId));
  if (joined.status !== 'completed') throw new Error('Join did not complete');
  const moderatorId = installed.managerId;
  await admin.query(
    `INSERT INTO access.resource_grant (route, resource_id, subject_id, action, valid, transaction_id)
     VALUES ($1,$2,$3,'realm:ban','(,)',$3)`,
    [installed.route, installed.realmId, moderatorId],
  );
  const removal = async () => {
    const held = holdingClient();
    const result = await enqueueRealmRemoval(acceptanceDependencies(held), {
      actor: await production.authenticate(pool, moderatorId, scopes),
      realmId: installed.realmId,
      spaceId: installed.spaceId,
      memberAccountId: installed.memberId,
      reservationId: joined.reservationId,
      banId: newId(installed.route),
      deadline: Date.now() + 30_000,
    });
    return accepted(held, result.workflowId);
  };
  // The member's own permission is irrelevant: the moderator is the initiator.
  const denied = await removal();
  await admin.query('DELETE FROM access.resource_grant WHERE resource_id = $1 AND subject_id = $2 AND action = $3', [
    installed.realmId,
    moderatorId,
    'realm:ban',
  ]);
  await expect(runSealed(installed, denied)).rejects.toThrow('Membership workflow step failed: publish');
  expect(await memberRows(installed.realmId, installed.memberId)).toEqual([{ open: true }]);
  await admin.query(
    `INSERT INTO access.resource_grant (route, resource_id, subject_id, action, valid, transaction_id)
     VALUES ($1,$2,$3,'realm:ban','(,)',$3)`,
    [installed.route, installed.realmId, moderatorId],
  );
  expect(await runSealed(installed, await removal())).toMatchObject({ status: 'completed' });
  expect(await memberRows(installed.realmId, installed.memberId)).toEqual([{ open: false }]);
}, 120_000);
