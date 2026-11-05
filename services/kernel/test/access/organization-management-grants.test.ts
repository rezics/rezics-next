import { afterAll, beforeAll, expect, test } from 'bun:test';
import { exportJWK, generateKeyPair } from 'jose';
import { migrate as migrateAuth } from '../../../auth/scripts/database.ts';
import { createPool } from '../../src/database/pool.ts';
import { newId, routeOf } from '../../src/route/route.ts';

// The focused acceptance command also runs from the repository root.
await import('reylo/register');
const { readAccount } = await import('../../src/access/account-data.ts');
const { createKernel } = await import('../../src/http/kernel.ts');
const { cookies, nativeFixture, password, scopes } = await import('./native-account-bindings-fixture.ts');

const url = process.env.DATABASE_URL!;
const pool = createPool(url);
let f: Awaited<ReturnType<typeof nativeFixture>>;
let kernel: ReturnType<typeof createKernel>;
type Person = Awaited<ReturnType<typeof person>>;
let owner: Person;
let member: Person;
let outsider: Person;
let organizationId: string;
let subjectAccountId: string;
const key = () => Bun.randomUUIDv7();

async function person(name: string) {
  const registered = await f.person(`management_${name}`);
  const signed = await f.request('/signin', {
    email: `management_${name}@ordinary.test`,
    password,
    client_id: 'organization-management',
    scope: [...scopes, 'organization:membership'],
  });
  expect(signed.status).toBe(200);
  const headers = cookies(signed);
  const token = await f.request('/token', {}, headers);
  expect(token.status).toBe(200);
  const { access_token: bearer } = (await token.json()) as { access_token: string };
  return { accountId: registered.accountId, bearer, headers };
}
async function context(human: Person) {
  const deadline = Date.now() + 10000;
  const actor = await f.access.authenticate(human.bearer, { pool, deadline });
  return { actor, account: await readAccount(pool, routeOf(actor.accountId)!, actor.accountId), deadline };
}
async function membership(human: Person, role: 'owner' | 'member') {
  const held = await f.bindings.internalLifecycle.reserveCoordination({
    accountId: human.accountId,
    relatedAccountId: organizationId,
    purpose: 'membership',
    key: key(),
  });
  await f.bindings.lifecycle.setMembership(await context(owner), {
    organizationId,
    memberAccountId: human.accountId,
    reservationId: held.value.reservationId,
    role,
    key: key(),
  });
}
const grantInput = (human: Person, actions = ['account:manage']) => ({
  resource: { route: routeOf(organizationId)!, id: organizationId },
  subject: { kind: 'account', id: human.accountId },
  actions,
  valid: '(,)',
});
async function grant(human: Person, recipient: Person, path = '/v1/grants', actions = ['account:manage']) {
  return kernel.handle(
    new Request(`https://kernel.test${path}`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${human.bearer}`,
        'content-type': 'application/json',
        'idempotency-key': JSON.stringify(key()),
      },
      body: JSON.stringify(grantInput(recipient, actions)),
    }),
  );
}
async function opening(human: Person) {
  return f.bindings.workflowPorts.authorizeOpening!(await context(human), {
    operatorAccountId: organizationId,
    subjectAccountId,
    purpose: 'session',
    key: key(),
  });
}
async function consume(human: Person, authorization: string) {
  return f.host.service.internal.openAutomatedSession({ authorization, subjectAccountId, headers: human.headers });
}
async function manages(human: Person) {
  const approved = await opening(human);
  const response = await consume(human, approved.value.receiptId);
  expect(response.status).toBe(200);
  const token = await f.request('/token', {}, cookies(response));
  expect(token.status).toBe(200);
  const { access_token } = (await token.json()) as { access_token: string };
  const actor = await f.access.authenticate(access_token, { pool, deadline: Date.now() + 10000 });
  expect(actor.accountId).toBe(subjectAccountId);
}

beforeAll(async () => {
  // Use only the caller's isolated test database; no shared-container cleanup.
  migrateAuth(url);
  const pair = await generateKeyPair('ES256', { extractable: true });
  f = await nativeFixture(pool, undefined, {
    database: { url, container: '', close() {} },
    privateKey: { ...(await exportJWK(pair.privateKey)), kid: 'organization-management' },
  });
  await f.host.service.internal.registerClient({
    clientId: 'organization-management',
    firstParty: true,
    scopes: [...scopes, 'organization:membership'],
  });
  kernel = createKernel({
    pool,
    routeKey: new Uint8Array(32).fill(91),
    tokens: f.referenceKeys,
    access: () => f.access,
    writeRate: {
      async spend() {
        return { allowed: true };
      },
    },
  });
  owner = await person('owner');
  member = await person('member');
  outsider = await person('outsider');
  organizationId = newId(0x9200);
  const held = await f.bindings.internalLifecycle.reserveCoordination({
    accountId: owner.accountId,
    relatedAccountId: organizationId,
    purpose: 'membership',
    key: key(),
  });
  await f.bindings.internalLifecycle.createOrganization({
    organizationId,
    ownerAccountId: owner.accountId,
    ownerReservationId: held.value.reservationId,
    key: key(),
  });
  await membership(member, 'member');
  const subject = await f.automated('management_automation', { accountId: organizationId, bearer: owner.bearer });
  subjectAccountId = subject.accountId;
}, 60000);
afterAll(async () => {
  try {
    await f?.close();
  } finally {
    await pool.end();
  }
});

test("a new organization's owners hold account manage and access grant on the organization resource", async () => {
  const grants = await pool.query(
    `SELECT action FROM access.resource_grant
     WHERE route=$1 AND resource_id=$2 AND subject_id=$2 AND subject_role='owner' ORDER BY action`,
    [routeOf(organizationId), organizationId],
  );
  expect(grants.rows.map((row) => row.action)).toEqual([
    'access:grant',
    'account:delete',
    'account:manage',
    'account:update',
    'organization:membership',
  ]);
  await manages(owner);
  const nextOwner = await person('next_owner');
  await membership(nextOwner, 'owner');
  await manages(nextOwner);
  expect((await grant(nextOwner, owner)).status).toBe(201);
});

test('an owner grants a member account manage through the ordinary grant routes and the member can then manage organization-operated automation', async () => {
  await expect(opening(member)).rejects.toThrow();
  expect((await grant(owner, member)).status).toBe(201);
  await manages(member);
});

test('an owner revokes it and the member is denied from T', async () => {
  const approved = await opening(member);
  const revoked = await grant(owner, member, '/v1/grants:revoke');
  expect(revoked.status).toBe(200);
  // Even the opening approved before the committed revocation loses authority.
  await expect(consume(member, approved.value.receiptId)).rejects.toThrow();
  await expect(opening(member)).rejects.toThrow();
});

test('a member without access grant cannot grant management', async () => {
  expect((await grant(owner, member)).status).toBe(201);
  await manages(member);
  expect((await grant(member, outsider)).status).toBe(403);
  expect((await grant(member, member, '/v1/grants', ['access:grant'])).status).toBe(403);
  // Grant administration also checks the grantor's ceiling for the granted action.
  expect((await grant(owner, member, '/v1/grants', ['subject:create'])).status).toBe(403);
});

test("a non-member holding a grant still cannot manage the organization's automation", async () => {
  expect((await grant(owner, outsider)).status).toBe(201);
  await expect(opening(outsider)).rejects.toThrow();
  const pair = await generateKeyPair('ES256', { extractable: true });
  const kid = key();
  const stage = await f.host.service.internal.stageCredentialEffect({
    key: key(),
    subjectAccountId,
    headers: outsider.headers,
    credential: { kind: 'key', kid, publicJwk: { ...(await exportJWK(pair.publicKey)), kid } },
  });
  await expect(
    f.host.service.internal.approveCredentialEffect({
      ...stage,
      subjectAccountId,
      headers: outsider.headers,
    }),
  ).rejects.toThrow();
  expect(
    (await f.authPool.query('SELECT kid FROM auth_public_key WHERE account_id=$1', [subjectAccountId])).rows,
  ).toEqual([]);
});

// Native entry metadata consumes genuine current Auth consent, independently of
// the management reader's existing private disclosure admission.
const entryScopes = [
  'account:read',
  'account:update',
  'account:delete',
  'account:manage',
  'organization:membership',
  'access:grant',
];
let entryClient: Promise<unknown> | undefined;
async function entrySession(name: string, consent = entryScopes) {
  entryClient ??= f.host.service.internal.registerClient({
    clientId: 'management-entries',
    firstParty: true,
    scopes: entryScopes,
  });
  await entryClient;
  const signed = await f.request('/signin', {
    email: `${name}@ordinary.test`,
    password,
    client_id: 'management-entries',
    scope: consent,
  });
  expect(signed.status).toBe(200);
  const headers = cookies(signed);
  const response = await f.request('/token', {}, headers);
  expect(response.status).toBe(200);
  const { access_token: bearer } = (await response.json()) as { access_token: string };
  return { bearer, headers };
}
async function entryFixture() {
  const name = `entry_${key().replaceAll('-', '')}`;
  const human = await f.person(name);
  const session = await entrySession(name);
  const organizationId = newId(0x9200);
  const held = await f.bindings.internalLifecycle.reserveCoordination({
    accountId: human.accountId,
    relatedAccountId: organizationId,
    purpose: 'membership',
    key: key(),
  });
  await f.bindings.internalLifecycle.createOrganization({
    organizationId,
    ownerAccountId: human.accountId,
    ownerReservationId: held.value.reservationId,
    key: key(),
  });
  const subject = await f.automated(`entry_bot_${key().replaceAll('-', '')}`, human);
  return { name, human: { ...human, ...session }, organizationId, subjectId: subject.accountId };
}
const { createManagementRead } = await import('../../src/access/account-management.ts');
const { readManagedAuthActions } = await import('../../src/access/account-management-auth-actions.ts');
const { mintReadTime, releaseOperationalTime } = await import('../../src/command/command.ts');
const { withConnection } = await import('../../src/database/pool.ts');
type Access = typeof f.access;
type EntryPage = Awaited<ReturnType<Awaited<ReturnType<typeof createManagementRead>>['detail']>>;
const positiveEntries = (page: EntryPage) => (page.authActions?.state === 'ready' ? page.authActions.operations : []);
async function entryDetail(bearer: string, accountId: string, access = f.access) {
  const deadline = Date.now() + 10000;
  const actor = await f.access.authenticate(bearer, { pool, deadline });
  const reader = await createManagementRead(
    { pool, access: () => access, tokens: f.referenceKeys, clock: () => new Date() },
    actor,
    deadline,
  );
  return reader.detail(accountId, {});
}
async function entryObservation(bearer: string, accountId: string, access = f.access) {
  const deadline = Date.now() + 10000;
  const actor = await f.access.authenticate(bearer, { pool, deadline });
  const account = await readAccount(pool, routeOf(accountId)!, accountId);
  expect(account).not.toBeNull();
  const row = (
    await pool.query(
      `SELECT operator_account_id, operator_reservation_id, operator_relation_version::text AS version
    FROM access.account WHERE route=$1 AND account_id=$2`,
      [routeOf(accountId), accountId],
    )
  ).rows[0];
  const relation =
    row.operator_account_id && row.operator_reservation_id
      ? {
          operatorAccountId: row.operator_account_id as string,
          reservationId: row.operator_reservation_id as string,
          version: row.version as string,
        }
      : null;
  const time = await withConnection(pool, (client) => mintReadTime(client));
  try {
    return await readManagedAuthActions({ pool, access }, actor, { account: account!, relation }, { deadline, time });
  } finally {
    releaseOperationalTime(time);
  }
}
const observedIds = (actions: Awaited<ReturnType<typeof entryObservation>>) =>
  actions.state === 'ready' ? actions.operations.map((entry) => entry.operationId) : [];
const operationCases = [
  { operationId: 'auth.account.rename', action: 'account:update', target: 'self' },
  { operationId: 'auth.organization.membership', action: 'organization:membership', target: 'organization' },
  { operationId: 'auth.organization.delete', action: 'account:delete', target: 'organization' },
  { operationId: 'auth.operator.transfer', action: 'account:manage', target: 'operated' },
] as const;
function selected(
  fixture: Awaited<ReturnType<typeof entryFixture>>,
  target: (typeof operationCases)[number]['target'],
) {
  return target === 'self'
    ? fixture.human.accountId
    : target === 'organization'
      ? fixture.organizationId
      : fixture.subjectId;
}

test('Managed Account detail exposes only exact current native Auth workflow entry bindings without inferring generic profile or role authority', async () => {
  const c = await entryFixture();
  const self = await entryDetail(c.human.bearer, c.human.accountId);
  expect(self.authActions).toEqual({
    state: 'ready',
    operations: [
      {
        operationId: 'auth.account.rename',
        action: 'account:update',
        resource: { route: routeOf(c.human.accountId)!, id: c.human.accountId },
      },
    ],
  });
  const organization = await entryDetail(c.human.bearer, c.organizationId);
  expect(organization.authActions).toEqual({
    state: 'ready',
    operations: [
      {
        operationId: 'auth.organization.membership',
        action: 'organization:membership',
        resource: { route: routeOf(c.organizationId)!, id: c.organizationId },
      },
      {
        operationId: 'auth.organization.delete',
        action: 'account:delete',
        resource: { route: routeOf(c.organizationId)!, id: c.organizationId },
      },
    ],
  });
  const operated = await entryDetail(c.human.bearer, c.subjectId);
  expect(operated.authActions).toEqual({
    state: 'ready',
    operations: [
      {
        operationId: 'auth.operator.transfer',
        action: 'account:manage',
        resource: { route: routeOf(c.human.accountId)!, id: c.human.accountId },
      },
    ],
  });
  expect(operated.relation?.operatorAccountId).toBe(c.human.accountId);
  const response = await kernel.handle(
    new Request(`https://kernel.test/v1/accounts/${c.human.accountId}/management`, {
      headers: { authorization: `Bearer ${c.human.bearer}` },
    }),
  );
  expect(response.status).toBe(200);
  expect(response.headers.get('cache-control')).toBe('private, no-store');
  expect(await response.json()).toEqual(self);
  const organizationSubject = await f.automated(`entry_org_${key().replaceAll('-', '')}`, {
    accountId: c.organizationId,
    bearer: c.human.bearer,
  });
  expect((await entryDetail(c.human.bearer, organizationSubject.accountId)).authActions).toEqual({
    state: 'ready',
    operations: [
      {
        operationId: 'auth.operator.transfer',
        action: 'account:manage',
        resource: {
          route: routeOf(c.organizationId)!,
          id: c.organizationId,
        },
      },
    ],
  });
  // A grant on another Account cannot turn that selection into Auth's self rename.
  await pool.query(
    `INSERT INTO access.resource_grant(route,resource_id,subject_id,action,valid,transaction_id)
    VALUES ($1,$2,$3,'account:update','(,)',$4)`,
    [routeOf(outsider.accountId), outsider.accountId, c.human.accountId, key()],
  );
  expect(observedIds(await entryObservation(c.human.bearer, outsider.accountId))).toEqual([]);
  // The response contains exactly operation identity and the native action anchor.
  for (const entry of [...positiveEntries(self), ...positiveEntries(organization), ...positiveEntries(operated)])
    expect(Object.keys(entry).sort()).toEqual(['action', 'operationId', 'resource']);
}, 60000);

for (const operation of operationCases) {
  test(`${operation.operationId} independently loses its entry on current scope, grant, denial and actor floor reductions`, async () => {
    const c = await entryFixture();
    const targetId = selected(c, operation.target);
    const authorityId = operation.target === 'organization' ? c.organizationId : c.human.accountId;
    expect(observedIds(await entryObservation(c.human.bearer, targetId))).toContain(operation.operationId);
    const limited = await entrySession(
      c.name,
      entryScopes.filter((scope) => scope !== operation.action),
    );
    expect(observedIds(await entryObservation(limited.bearer, targetId))).not.toContain(operation.operationId);
    if (operation.target === 'operated')
      await pool.query(
        `INSERT INTO access.resource_grant(route,resource_id,subject_id,action,valid,transaction_id)
      VALUES ($1,$2,$3,'account:manage','(,)',$4)`,
        [routeOf(targetId), targetId, c.human.accountId, key()],
      );
    const grants = await pool.query(
      `DELETE FROM access.resource_grant WHERE route=$1 AND resource_id=$2 AND action=$3 RETURNING *`,
      [routeOf(authorityId), authorityId, operation.action],
    );
    expect(grants.rows.length).toBeGreaterThan(0);
    try {
      expect(observedIds(await entryObservation(c.human.bearer, targetId))).not.toContain(operation.operationId);
    } finally {
      for (const row of grants.rows)
        await pool.query(
          `INSERT INTO access.resource_grant(route,resource_id,subject_kind,subject_id,subject_role,action,valid,transaction_id)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
          [
            row.route,
            row.resource_id,
            row.subject_kind,
            row.subject_id,
            row.subject_role,
            row.action,
            row.valid,
            row.transaction_id,
          ],
        );
    }
    expect(observedIds(await entryObservation(c.human.bearer, targetId))).toContain(operation.operationId);
    await pool.query(
      `INSERT INTO access.resource_denial(route,resource_id,subject_id,action,reason,valid,transaction_id)
      VALUES ($1,$2,$3,$4,'resource','(,)',$5)`,
      [routeOf(authorityId), authorityId, c.human.accountId, operation.action, key()],
    );
    try {
      expect(observedIds(await entryObservation(c.human.bearer, targetId))).not.toContain(operation.operationId);
    } finally {
      await pool.query(
        `DELETE FROM access.resource_denial WHERE route=$1 AND resource_id=$2 AND subject_id=$3 AND action=$4`,
        [routeOf(authorityId), authorityId, c.human.accountId, operation.action],
      );
    }
    expect(observedIds(await entryObservation(c.human.bearer, targetId))).toContain(operation.operationId);
    // Advance after genuine authentication, during released action preparation.
    let changed = false;
    const access: Access = {
      ...f.access,
      async prepare(...args) {
        const evidence = await f.access.prepare!(...args);
        if (!changed && args[1] === operation.action) {
          changed = true;
          await pool.query(
            `UPDATE access.account SET minimum_authn_epoch=minimum_authn_epoch+1 WHERE route=$1 AND account_id=$2`,
            [routeOf(c.human.accountId), c.human.accountId],
          );
        }
        return evidence;
      },
    };
    expect(observedIds(await entryObservation(c.human.bearer, targetId, access))).not.toContain(operation.operationId);
    expect(changed).toBe(true);
  }, 60000);
}

test('missing and failed optional action sources preserve independently permitted read-only management detail', async () => {
  const c = await entryFixture();
  const original = await entryDetail(c.human.bearer, c.human.accountId);
  for (const mode of ['missing', 'raw', 'failed'] as const) {
    const access: Access = {
      ...f.access,
      async prepare(...args) {
        if (args[1] === 'account:read') return f.access.prepare!(...args);
        if (mode === 'failed') throw new Error('Optional native action dependency unavailable');
        return mode === 'raw' ? { allowed: true } : null;
      },
      async authorize(...args) {
        return args[2] === 'account:read' ? f.access.authorize(...args) : true;
      },
    };
    const detail = await entryDetail(c.human.bearer, c.human.accountId, access);
    expect(detail).toEqual({ ...original, authActions: { state: 'unavailable' } });
  }
  const readOnly = await entrySession(c.name, ['account:read']);
  const page = await entryDetail(readOnly.bearer, c.human.accountId);
  expect(page.account).toEqual(original.account);
  expect(page.authActions).toEqual({ state: 'ready', operations: [] });
}, 60000);

for (const change of ['target', 'relation', 'membership'] as const) {
  test(`a native ${change} change during released preparation cannot leave stale Auth entries`, async () => {
    const c = await entryFixture();
    const targetId = change === 'membership' ? c.organizationId : c.subjectId;
    let changed = false;
    const access: Access = {
      ...f.access,
      async prepare(...args) {
        const evidence = await f.access.prepare!(...args);
        if (!changed) {
          changed = true;
          if (change === 'target')
            await pool.query(`UPDATE access.account SET authn_fenced=true WHERE route=$1 AND account_id=$2`, [
              routeOf(targetId),
              targetId,
            ]);
          if (change === 'relation')
            await pool.query(
              `UPDATE access.account SET operator_relation_version=operator_relation_version+1 WHERE route=$1 AND account_id=$2`,
              [routeOf(targetId), targetId],
            );
          if (change === 'membership')
            await pool.query(
              `DELETE FROM access.organization_member WHERE route=$1 AND organization_id=$2 AND member_account_id=$3`,
              [routeOf(targetId), targetId, c.human.accountId],
            );
        }
        return evidence;
      },
    };
    expect(observedIds(await entryObservation(c.human.bearer, targetId, access))).toEqual([]);
    expect(changed).toBe(true);
  }, 60000);
}

const { createDelegationCommands } = await import('../../src/access/delegation-commands.ts');
for (const operation of operationCases) {
  test(`${operation.operationId} uses the actual current principal grant and assignment`, async () => {
    const c = await entryFixture();
    const principal = await f.person(`principal_${key().replaceAll('-', '')}`);
    const assignments = createDelegationCommands({ pool, access: f.access, action: 'account:manage' });
    const principalContext = { pool, ...(await context(principal)) };
    const input = {
      principalId: principal.accountId,
      assignedActorId: c.human.accountId,
      requestId: newId(routeOf(principal.accountId)!),
      valid: '(,)',
      key: key(),
    };
    const assignment = await assignments.create(principalContext, input);
    const response = await f.request('/token', { requested_by: assignment.value.requestedBy }, c.human.headers);
    expect(response.status).toBe(200);
    const { access_token: bearer } = (await response.json()) as { access_token: string };
    const targetId = selected(c, operation.target);
    const authorityId = operation.target === 'organization' ? c.organizationId : c.human.accountId;
    expect(observedIds(await entryObservation(bearer, targetId))).not.toContain(operation.operationId);
    // Durable native grant fixture; the real formula still evaluates both people.
    await pool.query(
      `INSERT INTO access.resource_grant(route,resource_id,subject_id,action,valid,transaction_id)
      VALUES ($1,$2,$3,$4,'(,)',$5)`,
      [routeOf(authorityId), authorityId, principal.accountId, operation.action, key()],
    );
    expect(observedIds(await entryObservation(bearer, targetId))).toContain(operation.operationId);
    await pool.query(
      `INSERT INTO access.resource_denial(route,resource_id,subject_id,action,reason,valid,transaction_id)
      VALUES ($1,$2,$3,$4,'resource','(,)',$5)`,
      [routeOf(authorityId), authorityId, principal.accountId, operation.action, key()],
    );
    expect(observedIds(await entryObservation(bearer, targetId))).not.toContain(operation.operationId);
    await pool.query(
      `DELETE FROM access.resource_denial WHERE route=$1 AND resource_id=$2 AND subject_id=$3 AND action=$4`,
      [routeOf(authorityId), authorityId, principal.accountId, operation.action],
    );
    expect(observedIds(await entryObservation(bearer, targetId))).toContain(operation.operationId);
    let changed = false;
    const access: Access = {
      ...f.access,
      async prepare(...args) {
        const evidence = await f.access.prepare!(...args);
        if (!changed && args[1] === operation.action) {
          changed = true;
          // Remove the exact current assignment after preparation; no forged Actor.
          await assignments.revoke({ pool, ...(await context(principal)) }, { ...input, key: key() });
        }
        return evidence;
      },
    };
    expect(observedIds(await entryObservation(bearer, targetId, access))).not.toContain(operation.operationId);
    expect(changed).toBe(true);
  }, 60000);
}
