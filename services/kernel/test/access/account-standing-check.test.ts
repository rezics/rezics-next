import { afterAll, expect, test } from 'bun:test';
import { accountStandingCheck, createResourcePublicEligibility } from '../../src/access/index.ts';
import { readAccount } from '../../src/access/account-data.ts';
import { deriveAccess } from '../../src/access/derived-access.ts';
import { createRealmMembership } from '../../src/community/membership.ts';
import { createPool } from '../../src/database/pool.ts';
import {
  accessCheck,
  type AccountActor,
  type Actor,
  type Resource,
  type ResourcePage,
} from '../../src/request/access.ts';
import { newId, routeOf } from '../../src/route/route.ts';
import { admittedAccess, authenticateAccount } from '../support/admitted-access.ts';
import { actorFixture, type ActorFixture } from './actor-side-fixture.ts';

const pool = createPool(process.env.DATABASE_URL!);
pool.options.max = 1;
const action = 'subject:read';
const actions = new Map([
  [action, { anonymous: true }],
  ['subject:update', { anonymous: false }],
]);
const context = () => ({ pool, deadline: Date.now() + 10000 });
afterAll(async () => pool.end());

async function fixture() {
  const f = await actorFixture(pool);
  const ids = [f.resource.id, ...Array.from({ length: 3 }, () => newId(f.resource.route))];
  const page: ResourcePage = { route: f.resource.route, resourceType: 'fixture.route', ids };
  let realmReader: ReturnType<typeof createRealmMembership>['roleReader'] | undefined;
  const access = admittedAccess({
    actions,
    resourceRoles: f.config.resourceRoles!,
    realmRoleReader: (client, input) => realmReader!(client, input),
  });
  realmReader = createRealmMembership({ pool, access }).roleReader;
  await pool.query('DELETE FROM access.resource_grant WHERE route=$1 AND resource_id=$2', [page.route, ids[0]]);
  async function grant(subject = f.actorId, role = '', kind = 'identity', roleGrant = false) {
    const table = roleGrant ? 'resource_role_grant' : 'resource_grant';
    const column = roleGrant ? 'grant_role' : 'action';
    await pool.query(
      `INSERT INTO access.${table}(route,resource_id,subject_id,subject_role,subject_kind,${column},valid,transaction_id)
       SELECT $1,id,$3,$4,$5,$6,'(,)',$7 FROM unnest($2::uuid[]) id`,
      [page.route, ids, subject, role, kind, roleGrant ? 'fixture.reader' : action, f.transactionId],
    );
  }
  return { f, ids, page, access, grant };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;

async function realm(f: ActorFixture): Promise<string> {
  const route = f.resource.route;
  const id = newId(route);
  const space = newId(route);
  const revision = newId(route);
  const spaceRevision = newId(route);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SET CONSTRAINTS ALL DEFERRED');
    await client.query(
      `INSERT INTO community.space(route,space_id,state,head_revision_id,created_at,creator)
       VALUES ($1,$2,'active',$3,'2020-01-01',$4)`,
      [route, space, spaceRevision, f.actorId],
    );
    await client.query(
      `INSERT INTO community.space_revision(route,space_id,revision_id,title,summary,created_at,author)
       VALUES ($1,$2,$3,'Standing test Space','','2020-01-01',$4)`,
      [route, space, spaceRevision, f.actorId],
    );
    await client.query(
      `INSERT INTO community.realm(route,realm_id,space_id,state,visibility,context_id,head_revision_id,created_at,creator)
       VALUES ($1,$2,$3,'active','protected',$4,$5,'2020-01-01',$6)`,
      [route, id, space, newId(route), revision, f.actorId],
    );
    await client.query(
      `INSERT INTO community.realm_revision(route,realm_id,revision_id,title,summary,visibility,context_id,created_at,author)
       SELECT route,realm_id,head_revision_id,'Standing test Realm','','protected',context_id,created_at,creator
       FROM community.realm WHERE route=$1 AND realm_id=$2`,
      [route, id],
    );
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
  await f.admit(id, f.actorId, 'realm');
  return id;
}

async function differential(f: Fixture, expected: boolean[]) {
  const ctx = context();
  const actor = await authenticateAccount(f.access, ctx, {
    accountId: f.f.actorId,
    clientId: 'first-party',
    scopes: [...actions.keys()],
  });
  const answers: Record<string, boolean> = {};
  for (const [index, id] of f.ids.entries()) {
    const target = { route: f.page.route, id };
    const check = await accessCheck(f.access, actor, action, target, ctx);
    answers[id] = await check(pool);
    expect(answers[id]).toBe(expected[index]!);
    expect(await accountStandingCheck(f.access, { accountId: actor.accountId, action, target, context: ctx })).toEqual({
      [id]: answers[id],
    });
  }
  const decisions = await accountStandingCheck(f.access, {
    accountId: actor.accountId,
    action,
    target: f.page,
    context: ctx,
  });
  expect(decisions).toEqual(answers);
  expect(Object.isFrozen(decisions)).toBe(true);
  const evidence = await f.access.preparePage!(actor, action, f.page, ctx);
  expect(await f.access.authorizePage!(pool, actor, action, f.page, evidence)).toBe(expected.every(Boolean));
}

const cases: [string, boolean, (fixture: Fixture) => Promise<void>][] = [
  ['identity grant', true, async ({ grant }) => grant()],
  ['missing grant', false, async () => {}],
  [
    'active accounts grant',
    true,
    async ({ grant }) => grant('00000000-0000-0000-0000-000000000000', '', 'active_accounts'),
  ],
  ['identity resource role', true, async ({ grant, f }) => grant(f.actorId, '', 'identity', true)],
  ['organization owner role', true, async ({ grant, f }) => grant(f.organizationId, 'owner')],
  ['organization member role', false, async ({ grant, f }) => grant(f.organizationId, 'member')],
  [
    'organization member grant',
    true,
    async ({ grant, f }) => {
      await pool.query(
        "UPDATE access.organization_member SET role='member' WHERE route=$1 AND organization_id=$2 AND member_account_id=$3",
        [routeOf(f.organizationId), f.organizationId, f.actorId],
      );
      await grant(f.organizationId, 'member');
    },
  ],
  ['organization resource role', true, async ({ grant, f }) => grant(f.organizationId, 'owner', 'identity', true)],
  ['stale inverse role', false, async ({ grant, f }) => grant(f.staleId, 'owner')],
  ['organization identity is not its member', false, async ({ grant, f }) => grant(f.organizationId)],
  ['assignment principal supplies no authority', false, async ({ grant, f }) => grant(f.principalId)],
  [
    'incomplete inverse',
    false,
    async ({ grant, f }) => {
      await grant();
      await pool.query('UPDATE access.account SET membership_inverse_complete=false WHERE route=$1 AND account_id=$2', [
        routeOf(f.actorId),
        f.actorId,
      ]);
    },
  ],
  [
    'expired grant',
    false,
    async ({ grant, page }) => {
      await grant();
      await pool.query(
        "UPDATE access.resource_grant SET valid='[2000-01-01,2001-01-01)' WHERE route=$1 AND resource_id=ANY($2::uuid[])",
        [page.route, page.ids],
      );
    },
  ],
  [
    'future grant',
    false,
    async ({ grant, page }) => {
      await grant();
      await pool.query(
        "UPDATE access.resource_grant SET valid='[2100-01-01,)' WHERE route=$1 AND resource_id=ANY($2::uuid[])",
        [page.route, page.ids],
      );
    },
  ],
  [
    'automated account does not inherit organization roles',
    false,
    async ({ grant, f }) => {
      await grant(f.organizationId, 'owner');
      const automatedId = newId(routeOf(f.actorId)!);
      await pool.query(
        `INSERT INTO access.account(route,account_id,kind,state,operator_account_id,transaction_id)
        VALUES($1,$2,'actor','active',$3,$4)`,
        [routeOf(automatedId), automatedId, f.principalId, f.transactionId],
      );
      // Seed retained historical role data; automation must never consume it.
      await pool.query(
        `INSERT INTO access.membership_inverse(route,account_id,kind,group_id,reservation_id,transaction_id)
        SELECT route,$3,kind,group_id,reservation_id,transaction_id FROM access.membership_inverse
        WHERE route=$1 AND account_id=$2`,
        [routeOf(f.actorId), f.actorId, automatedId],
      );
      await pool.query(
        `INSERT INTO access.organization_member(route,organization_id,member_account_id,role,valid,transaction_id)
        SELECT route,organization_id,$3,role,valid,transaction_id FROM access.organization_member
        WHERE route=$1 AND organization_id=$2 AND member_account_id=$4`,
        [routeOf(f.organizationId), f.organizationId, automatedId, f.actorId],
      );
      f.actorId = automatedId;
    },
  ],
  [
    'Realm membership',
    true,
    async ({ f, grant }) => {
      const id = await realm(f);
      await pool.query(
        "INSERT INTO community.realm_member(route,realm_id,account_id,role,valid,reservation_id,transaction_id) VALUES($1,$2,$3,'member','(,)',$4,$5)",
        [routeOf(id), id, f.actorId, newId(routeOf(id)!), f.transactionId],
      );
      await grant(id, 'member');
    },
  ],
  ['Realm owner is not membership', false, async ({ f, grant }) => grant(await realm(f), 'owner')],
  ['Realm missing membership', false, async ({ f, grant }) => grant(await realm(f), 'member')],
  [
    'Realm resource role',
    true,
    async ({ f, grant }) => {
      const id = await realm(f);
      await pool.query(
        "INSERT INTO community.realm_member(route,realm_id,account_id,role,valid,reservation_id,transaction_id) VALUES($1,$2,$3,'member','(,)',$4,$5)",
        [routeOf(id), id, f.actorId, newId(routeOf(id)!), f.transactionId],
      );
      await grant(id, 'member', 'identity', true);
    },
  ],
];
for (const reason of ['resource', 'realm_ban', 'suspension']) {
  cases.push([
    `${reason} denial`,
    false,
    async ({ f, grant, page }) => {
      await grant();
      await pool.query(
        `INSERT INTO access.resource_denial(route,resource_id,subject_id,action,reason,valid,transaction_id)
      SELECT $1,id,$3,$4,$5,'(,)',$6 FROM unnest($2::uuid[]) id`,
        [page.route, page.ids, f.actorId, action, reason, f.transactionId],
      );
    },
  ]);
}
cases.push([
  'organization role denial vetoes direct grant',
  false,
  async ({ f, grant, page }) => {
    await grant();
    await pool.query(
      `INSERT INTO access.resource_denial(route,resource_id,subject_id,subject_role,action,reason,valid,transaction_id)
    SELECT $1,id,$3,'owner',$4,'resource','(,)',$5 FROM unnest($2::uuid[]) id`,
      [page.route, page.ids, f.organizationId, action, f.transactionId],
    );
  },
]);
cases.push([
  'Realm role denial vetoes a direct grant',
  false,
  async ({ f, grant, page }) => {
    const id = await realm(f);
    await pool.query(
      "INSERT INTO community.realm_member(route,realm_id,account_id,role,valid,reservation_id,transaction_id) VALUES($1,$2,$3,'member','(,)',$4,$5)",
      [routeOf(id), id, f.actorId, newId(routeOf(id)!), f.transactionId],
    );
    await grant();
    await pool.query(
      `INSERT INTO access.resource_denial(route,resource_id,subject_id,subject_role,action,reason,valid,transaction_id)
    SELECT $1,id,$3,'member',$4,'realm_ban','(,)',$5 FROM unnest($2::uuid[]) id`,
      [page.route, page.ids, id, action, f.transactionId],
    );
  },
]);
for (const [name, allowed, setup] of cases) {
  test(`${name}: own standing equals the all-scopes first-party session on each resource and page`, async () => {
    const f = await fixture();
    await setup(f);
    await differential(
      f,
      f.ids.map(() => allowed),
    );
  });
}

test('an unresolved Realm role denies only the page targets that hit it', async () => {
  const f = await fixture();
  await f.grant();
  const missingRealm = newId(f.page.route);
  await f.f.admit(missingRealm, f.f.actorId, 'realm');
  await pool.query(
    `INSERT INTO access.resource_grant(route,resource_id,subject_id,subject_role,action,valid,transaction_id)
    VALUES($1,$2,$3,'member',$4,'(,)',$5)`,
    [f.page.route, f.ids[1], missingRealm, action, f.f.transactionId],
  );
  // Whole-page session admission deliberately fails closed, but each standing
  // answer must equal the independently prepared single-resource session check.
  const ctx = context();
  const actor = await authenticateAccount(f.access, ctx, {
    accountId: f.f.actorId,
    clientId: 'first-party',
    scopes: [...actions.keys()],
  });
  const expected: Record<string, boolean> = {};
  for (const id of f.ids) {
    expected[id] = await (await accessCheck(f.access, actor, action, { route: f.page.route, id }, ctx))(pool);
  }
  expect(Object.values(expected)).toEqual([true, false, true, true]);
  expect(
    await accountStandingCheck(f.access, { accountId: actor.accountId, action, target: f.page, context: ctx }),
  ).toEqual(expected);
});

test('a page retains separate allowed and denied answers and adapters resolve the installed port', async () => {
  const f = await fixture();
  await f.grant();
  await f.f.deny(f.f.actorId, '');
  await differential(f, [false, true, true, true]);
  const adapted = deriveAccess(f.access, { authorize: async () => false });
  expect(
    await accountStandingCheck(adapted, { accountId: f.f.actorId, action, target: f.page, context: context() }),
  ).toEqual(Object.fromEntries(f.ids.map((id, index) => [id, index !== 0])));
});

for (const state of ['suspended', 'fenced', 'deleted', 'pending']) {
  test(`${state} account is denied every target, including a public floor`, async () => {
    const f = await fixture();
    const accountId = newId(routeOf(f.f.actorId)!);
    // Seed a completed lifecycle state, with no outstanding membership duties.
    await pool.query(
      `INSERT INTO access.account(route,account_id,kind,state,authn_fenced,transaction_id)
      VALUES($1,$2,'actor',$3,$4,$5)`,
      [routeOf(accountId), accountId, state === 'fenced' ? 'active' : state, state === 'fenced', f.f.transactionId],
    );
    await f.grant(accountId);
    expect(await accountStandingCheck(f.access, { accountId, action, target: f.page, context: context() })).toEqual(
      Object.fromEntries(f.ids.map((id) => [id, false])),
    );
    const target = publicResource(f.f.resource);
    expect(await accountStandingCheck(f.access, { accountId, action, target, context: context() })).toEqual({
      [target.id]: false,
    });
  });
}

function publicResource(resource: Resource) {
  return {
    ...resource,
    eligibility: createResourcePublicEligibility({
      resource,
      action,
      async prepare() {
        return {};
      },
      async verify() {
        return true;
      },
    }),
  };
}

test('public domain eligibility and its denial use the neutral standing actor', async () => {
  const f = await fixture();
  let seen = false;
  const target = {
    ...f.f.resource,
    eligibility: createResourcePublicEligibility({
      resource: f.f.resource,
      action,
      async prepare({ actor }) {
        if (actor.kind === 'account' && actor.clientId.startsWith('\u0000')) {
          expect(Object.isFrozen(actor)).toBe(true);
          expect(Object.isFrozen(actor.scopes)).toBe(true);
          expect(actor.scopes).toEqual(expect.arrayContaining([...actions.keys()]));
          expect(actor.requestedBy).toBeNull();
          expect(actor.authnEpoch).toBe(1);
          expect(actor.accountId).toBe(f.f.actorId);
          seen = true;
        }
        return {};
      },
      async verify() {
        return true;
      },
    }),
  };
  const ctx = context();
  const actor = await authenticateAccount(f.access, ctx, {
    accountId: f.f.actorId,
    clientId: 'first-party',
    scopes: [...actions.keys()],
  });
  const check = await accessCheck(f.access, actor, action, target, ctx);
  expect(await accountStandingCheck(f.access, { accountId: actor.accountId, action, target, context: ctx })).toEqual({
    [target.id]: await check(pool),
  });
  expect(seen).toBe(true);
  await f.f.deny(f.f.actorId, '');
  expect(
    await accountStandingCheck(f.access, { accountId: actor.accountId, action, target, context: context() }),
  ).toEqual({ [target.id]: false });
});

test('no scopes or delegation are accepted, and organization authority cannot be injected', async () => {
  const f = await fixture();
  await f.grant(f.f.organizationId);
  const input = {
    accountId: f.f.actorId,
    action,
    target: f.page,
    context: context(),
    clientId: 'first-party',
    scopes: [...actions.keys()],
    requestedBy: f.f.delegated.requestedBy,
    principalId: f.f.organizationId,
  };
  expect(await accountStandingCheck(f.access, input)).toEqual(Object.fromEntries(f.ids.map((id) => [id, false])));
  expect(await accountStandingCheck(f.access, { ...input, accountId: f.f.organizationId })).toEqual(
    Object.fromEntries(f.ids.map((id) => [id, false])),
  );
  await f.grant();
  const actor = await authenticateAccount(f.access, context(), {
    accountId: f.f.actorId,
    clientId: 'scoped-client',
    scopes: ['subject:update'],
  });
  const check = await accessCheck(f.access, actor, action, f.f.resource, context());
  expect(await check(pool)).toBe(false);
  expect(await accountStandingCheck(f.access, input)).toEqual(Object.fromEntries(f.ids.map((id) => [id, true])));
});

test('a grant revoked before send is denied at this call rather than an earlier effect time', async () => {
  const f = await fixture();
  await f.grant();
  const input = { accountId: f.f.actorId, action, target: f.page, context: context(), at: '2020-01-01' };
  expect(Object.values(await accountStandingCheck(f.access, input))).toEqual(f.ids.map(() => true));
  await pool.query(
    "UPDATE access.resource_grant SET valid=tstzrange(NULL,clock_timestamp(),'[)') WHERE route=$1 AND resource_id=ANY($2::uuid[])",
    [f.page.route, f.ids],
  );
  await differential(
    f,
    f.ids.map(() => false),
  );
  expect(Object.values(await accountStandingCheck(f.access, input))).toEqual(f.ids.map(() => false));
});

test('invalid pages are rejected before account lookup and unregistered actions deny', async () => {
  const f = await fixture();
  await expect(
    accountStandingCheck(f.access, {
      accountId: f.f.actorId,
      action,
      target: { ...f.page, ids: [f.ids[0]!, newId(42)] },
      context: context(),
    }),
  ).rejects.toThrow('Invalid resource page');
  expect(
    await accountStandingCheck(f.access, {
      accountId: f.f.actorId,
      action: 'missing:action',
      target: f.page,
      context: context(),
    }),
  ).toEqual(Object.fromEntries(f.ids.map((id) => [id, false])));
});

test('the session preparation port cannot accept a caller-supplied standing account through extra arguments', async () => {
  const f = await fixture();
  await f.grant();
  const sessionOnly = f.f.permissions({ accountEvidence: () => null });
  const account = await readAccount(pool, routeOf(f.f.actorId)!, f.f.actorId);
  const principal = { kind: 'account', accountId: f.f.actorId };
  const evidence = await Reflect.apply(sessionOnly.prepare!, sessionOnly, [
    principal,
    action,
    f.f.resource,
    context(),
    undefined,
    account,
  ]);
  expect(
    await Reflect.apply(sessionOnly.authorize, sessionOnly, [pool, principal, action, f.f.resource, evidence]),
  ).toBe(false);
});

test('eligibility verification reads an Actor and runs a nested check through the main Access', async () => {
  const f = await fixture();
  const nestedTarget = { route: f.page.route, id: f.ids[1]! };
  await f.grant();
  let captured: AccountActor | undefined;
  let visits = 0;
  const target = {
    ...f.f.resource,
    eligibility: createResourcePublicEligibility({
      resource: f.f.resource,
      action,
      async prepare({ actor }) {
        const typed: Actor = actor;
        return {
          actor: typed,
          nested: await accessCheck(f.access, actor, action, nestedTarget, context()),
          copied: await accessCheck(f.access, { ...actor }, action, nestedTarget, context()),
        };
      },
      async verify({ actor, client, evidence }) {
        expect(actor).toBe(evidence.actor);
        if (actor.kind !== 'account') return false;
        expect(actor.accountId).toBe(f.f.actorId);
        expect(actor.requestedBy).toBeNull();
        expect(actor.scopes.includes(action)).toBe(true);
        if (actor.clientId.startsWith('\u0000')) captured = actor;
        visits++;
        // Preparation consults released anchors; the supplied client runs the
        // nested formula without acquiring another client from the size-one pool.
        const result = await evidence.nested(client);
        // A spread copy cannot borrow the exact actor's account evidence.
        expect(await evidence.copied(client)).toBe(false);
        return result;
      },
    }),
  };
  const actor = await authenticateAccount(f.access, context(), {
    accountId: f.f.actorId,
    clientId: 'first-party',
    scopes: [...actions.keys()],
  });
  // Remove the outer grant, so only successful domain verification can allow it.
  await pool.query('DELETE FROM access.resource_grant WHERE route=$1 AND resource_id=$2', [target.route, target.id]);
  const session = await (await accessCheck(f.access, actor, action, target, context()))(pool);
  expect(session).toBe(true);
  expect(
    await accountStandingCheck(f.access, {
      accountId: actor.accountId,
      action,
      target,
      context: context(),
    }),
  ).toEqual({ [target.id]: session });
  expect(visits).toBe(2);
  expect(captured).toBeDefined();
  // Capturing a callback actor cannot retain authority after the port returns.
  expect(await (await accessCheck(f.access, captured!, action, nestedTarget, context()))(pool)).toBe(false);
  await pool.query('DELETE FROM access.resource_grant WHERE route=$1 AND resource_id=$2', [
    nestedTarget.route,
    nestedTarget.id,
  ]);
  expect(await (await accessCheck(f.access, actor, action, target, context()))(pool)).toBe(false);
  expect(
    await accountStandingCheck(f.access, {
      accountId: actor.accountId,
      action,
      target,
      context: context(),
    }),
  ).toEqual({ [target.id]: false });
});

test('the neutral epoch follows the current account floor without requiring a credential', async () => {
  const f = await fixture();
  await f.grant();
  await pool.query('UPDATE access.account SET minimum_authn_epoch=7 WHERE route=$1 AND account_id=$2', [
    routeOf(f.f.actorId),
    f.f.actorId,
  ]);
  const actor = await authenticateAccount(f.access, context(), {
    accountId: f.f.actorId,
    clientId: 'first-party',
    scopes: [...actions.keys()],
    authnEpoch: 7,
  });
  const check = await accessCheck(f.access, actor, action, f.f.resource, context());
  expect(await check(pool)).toBe(true);
  expect(
    await accountStandingCheck(f.access, {
      accountId: actor.accountId,
      action,
      target: f.f.resource,
      context: context(),
    }),
  ).toEqual({ [f.f.resource.id]: true });
});
