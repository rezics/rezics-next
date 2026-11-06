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
    clock: () => new Date(),
    deadlineNow: () => Date.now(),
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

test('closed authorization does not write membership', async () => {
  const { join, reservation, input, carrier } = await prepare();
  const bare = createRealmMembership({
    clock: () => new Date(),
    deadlineNow: () => Date.now(),
    pool,
    access,
    referenceKeys: tokens,
  });
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
  for (const role of ['community.realm.owner', 'community.realm.moderator']) {
    const pending = await removal();
    await admin.query(
      `INSERT INTO access.resource_role_grant (route, resource_id, subject_id, grant_role, valid, transaction_id)
       VALUES ($1,$2,$3,$4,'(,)',$3)`,
      [installed.route, installed.realmId, installed.memberId, role],
    );
    await expect(removal()).rejects.toThrow('Remove the Realm owner or moderator role first');
    await expect(runSealed(installed, pending)).rejects.toThrow('Membership workflow step failed: publish');
    expect(await memberRows(installed.realmId, installed.memberId)).toEqual([{ open: true }]);
    await admin.query('DELETE FROM access.resource_role_grant WHERE resource_id=$1 AND subject_id=$2', [
      installed.realmId,
      installed.memberId,
    ]);
  }
  expect(await runSealed(installed, await removal())).toMatchObject({ status: 'completed' });
  expect(await memberRows(installed.realmId, installed.memberId)).toEqual([{ open: false }]);
}, 120_000);

test('a join accepted before a ban cannot publish membership when delivered later or repeated', async () => {
  const installed = await install(0x2390, 'public');
  consent.set(installed.memberId, scopes);
  const pending = await accept(installed, installed.memberId);
  await admin.query(
    `INSERT INTO community.realm_ban (route, realm_id, account_id, valid, reason, actor, transaction_id)
     VALUES ($1,$2,$3,'(,)','Late ban',$4,$4)`,
    [installed.route, installed.realmId, installed.memberId, installed.managerId],
  );
  for (let delivery = 0; delivery < 2; delivery++) {
    await expect(runSealed(installed, pending)).rejects.toThrow('Membership workflow step failed: publish');
    expect(await memberRows(installed.realmId, installed.memberId)).toEqual([]);
  }
}, 120_000);
