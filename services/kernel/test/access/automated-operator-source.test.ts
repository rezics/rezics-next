import { afterAll, beforeAll, expect, test } from 'bun:test';
import { AUTH_MANAGEMENT_CLIENT_ID } from '@rezics/auth-contract';
import { createPool } from '../../src/database/pool.ts';
import { newId, routeOf } from '../../src/route/route.ts';
await import('reylo/register');
const { cookies, nativeFixture, password, issuer } = await import('./native-account-bindings-fixture.ts');
const { readAutomatedCreationOperator } = await import('../../src/access/automated-operator-source.ts');
const { createManagementRead } = await import('../../src/access/account-management.ts');

const pool = createPool(process.env.DATABASE_URL!);
let f: Awaited<ReturnType<typeof nativeFixture>>;
beforeAll(async () => {
  f = await nativeFixture(pool);
}, 60000);
afterAll(async () => {
  try {
    await f?.close();
  } finally {
    await pool.end();
  }
});
const key = () => Bun.randomUUIDv7();
async function person(name: string) {
  const registered = await f.person(name);
  const signed = await f.request('/signin', {
    email: `${name}@ordinary.test`,
    password,
    client_id: AUTH_MANAGEMENT_CLIENT_ID,
    scope: ['account:manage'],
  });
  expect(signed.status).toBe(200);
  const headers = cookies(signed);
  const issued = await f.request('/token', {}, headers);
  expect(issued.status).toBe(200);
  const { access_token } = (await issued.json()) as { access_token: string };
  return { ...registered, headers, bearer: access_token };
}
async function context(human: Awaited<ReturnType<typeof person>>) {
  const deadline = Date.now() + 10000;
  return { actor: await f.access.authenticate(human.bearer, { pool, deadline }), deadline };
}
function point(human: Awaited<ReturnType<typeof person>>, operatorAccountId: string, extra = {}) {
  return f.host.handler(
    new Request(`${issuer}/account-management/automated/operator`, {
      method: 'POST',
      headers: { origin: issuer, cookie: human.headers.get('cookie')!, 'content-type': 'application/json' },
      body: JSON.stringify({ operatorAccountId, ...extra }),
    }),
  );
}

test('Existing credentialless automated creation loads minimal current operator command metadata under exact native account manage authority without broad private account-read scopes or actor impersonation', async () => {
  const owner = await person('metadata_owner');
  const outsider = await person('metadata_outsider');
  const own = await point(owner, owner.accountId);
  expect(own.status).toBe(200);
  expect(own.headers.get('cache-control')).toBe('private, no-store');
  expect(await own.json()).toMatchObject({
    viewer: { accountId: owner.accountId },
    readiness: 'review',
    action: 'confirm',
    operator: { id: owner.accountId, kind: 'actor', handle: 'metadata_owner', displayName: null },
  });
  const org = newId(0x9422);
  const hold = await f.bindings.internalLifecycle.reserveCoordination({
    accountId: owner.accountId,
    relatedAccountId: org,
    purpose: 'membership',
    key: key(),
  });
  await f.bindings.internalLifecycle.createOrganization({
    organizationId: org,
    ownerAccountId: owner.accountId,
    ownerReservationId: hold.value.reservationId,
    key: key(),
  });
  await f.bindings.operators.provisionManagementDefaults({ operatorAccountId: org, key: key() });
  const organization = await point(owner, org);
  expect(organization.status).toBe(200);
  expect(await organization.json()).toMatchObject({
    readiness: 'review',
    operator: { id: org, kind: 'organization', handle: null, displayName: null },
  });
  const refused = await (await point(outsider, org)).json();
  expect(refused).toMatchObject({ readiness: 'refused', operator: null, action: 'none' });
  expect(await (await point(owner, outsider.accountId)).json()).toMatchObject({ readiness: 'refused', operator: null });
  expect((await point(owner, owner.accountId, { accountId: outsider.accountId })).status).toBe(400);
  const missing = await point(owner, newId(0x9422));
  expect(missing.status).toBe(200);
  expect(await missing.json()).toMatchObject({ readiness: 'refused', operator: null });
  expect(await (await point(outsider, org)).json()).toEqual(await (await point(outsider, newId(0x9422))).json());
  // Ordinary real Auth sessions obtain safe advice without resolving any private target.
  const ordinary = await f.request('/signin', {
    email: 'metadata_owner@ordinary.test',
    password,
    client_id: 'ordinary-test-client',
    scope: [],
  });
  expect(ordinary.status).toBe(200);
  const ordinaryCaller = { ...owner, headers: cookies(ordinary) };
  const advice = await (await point(ordinaryCaller, org)).json();
  expect(advice).toMatchObject({
    viewer: { accountId: owner.accountId },
    readiness: 'authentication-needed',
    operator: null,
    action: 'authenticate',
  });
  expect(await (await point(ordinaryCaller, newId(0x9422))).json()).toEqual(advice);
  const ctx = await context(owner);
  await expect(
    createManagementRead(
      { pool, access: () => f.access, tokens: f.referenceKeys, clock: () => new Date() },
      ctx.actor,
      ctx.deadline,
    ),
  ).rejects.toThrow();
  // Metadata is not an approval: native creation still requires its own reference.
  await expect(
    f.host.workflows.createAutomated({
      key: key(),
      authorization: 'not-an-approval',
      operatorAccountId: org,
      handle: 'not_created',
    }),
  ).rejects.toThrow();
  await expect(
    readAutomatedCreationOperator(
      { pool, access: f.access },
      ctx.actor,
      { operatorAccountId: owner.accountId },
      { deadline: Date.now() - 1 },
    ),
  ).rejects.toMatchObject({ reason: 'deadline' });
  // Equality with the selected account never substitutes for its current grant.
  await f.bindings.grants.revoke(
    { ...(await context(owner)), pool },
    {
      resource: { route: routeOf(owner.accountId)!, id: owner.accountId },
      subjectId: owner.accountId,
      subjectRole: '',
      actions: ['account:manage'],
      valid: '(,)',
      key: key(),
    },
  );
  expect(await (await point(owner, owner.accountId)).json()).toMatchObject({ readiness: 'refused', operator: null });
  // A real current floor change invalidates the genuine previously authenticated actor.
  await pool.query(
    'UPDATE access.account SET minimum_authn_epoch=minimum_authn_epoch+1 WHERE route=$1 AND account_id=$2',
    [routeOf(owner.accountId), owner.accountId],
  );
  await expect(
    readAutomatedCreationOperator(
      { pool, access: f.access },
      ctx.actor,
      { operatorAccountId: org },
      { deadline: Date.now() + 10000 },
    ),
  ).rejects.toMatchObject({ status: 403 });
}, 60000);

for (const kind of ['actor', 'organization'] as const)
  test(`review does not authorize creation after account:manage is revoked on the ${kind} operator`, async () => {
    const owner = await person(`review_revoke_${kind}`);
    let operatorAccountId = owner.accountId;
    if (kind === 'organization') {
      operatorAccountId = newId(0x9422);
      const hold = await f.bindings.internalLifecycle.reserveCoordination({
        accountId: owner.accountId,
        relatedAccountId: operatorAccountId,
        purpose: 'membership',
        key: key(),
      });
      await f.bindings.internalLifecycle.createOrganization({
        organizationId: operatorAccountId,
        ownerAccountId: owner.accountId,
        ownerReservationId: hold.value.reservationId,
        key: key(),
      });
      await f.bindings.operators.provisionManagementDefaults({ operatorAccountId, key: key() });
    }
    expect(await (await point(owner, operatorAccountId)).json()).toMatchObject({ readiness: 'review' });
    const operationKey = key();
    const operation = {
      kind: 'automated' as const,
      registrationId: '',
      operationKey,
      operatorAccountId,
      handle: `revoked_${kind}_bot`,
      authorization: 'approval-request',
    };
    const approved = await f
      .approval()
      .approve(owner.bearer, { operationKey, operation }, { pool, deadline: Date.now() + 10000 });
    await f.bindings.grants.revoke(
      { ...(await context(owner)), pool },
      {
        resource: { route: routeOf(operatorAccountId)!, id: operatorAccountId },
        subjectId: owner.accountId,
        subjectRole: '',
        actions: ['account:manage'],
        valid: '(,)',
        key: key(),
      },
    );
    expect(await (await point(owner, operatorAccountId)).json()).toMatchObject({
      readiness: 'refused',
      operator: null,
    });
    await expect(
      f.approval().approve(owner.bearer, { operationKey, operation }, { pool, deadline: Date.now() + 10000 }),
    ).rejects.toThrow();
    await expect(
      f.host.workflows.createAutomated({
        key: operationKey,
        authorization: approved.reference,
        operatorAccountId,
        handle: operation.handle,
      }),
    ).rejects.toThrow();
  }, 60000);

test('signed-out and operated callers cannot obtain human review; unavailable dependencies never become refusal', async () => {
  expect((await f.request('/account-management/automated/operator', { operatorAccountId: null })).status).toBe(401);
  const owner = await person('review_operated_owner');
  const subject = await f.automated('review-operated-bot', owner);
  const operation = {
    kind: 'opening' as const,
    operatorAccountId: owner.accountId,
    subjectAccountId: subject.accountId,
    authorization: 'approval-request',
  };
  const operationKey = key();
  const approved = await f
    .approval()
    .approve(owner.bearer, { operationKey, operation }, { pool, deadline: Date.now() + 10000 });
  const opened = await f.host.workflows.openOperatorSession({
    key: operationKey,
    authorization: approved.reference,
    operatorAccountId: owner.accountId,
    subjectAccountId: subject.accountId,
    headers: owner.headers,
  });
  expect(opened.status).toBe(200);
  expect((await point({ ...owner, headers: cookies(opened) }, owner.accountId)).status).toBe(403);
  const ctx = await context(owner);
  const disconnected = new Proxy(pool, {
    get(target, property, receiver) {
      if (property === 'connect')
        return async () => {
          throw new Error('Dependency unavailable');
        };
      return Reflect.get(target, property, receiver);
    },
  });
  await expect(
    readAutomatedCreationOperator(
      { pool: disconnected, access: f.access },
      ctx.actor,
      { operatorAccountId: owner.accountId },
      { deadline: Date.now() + 10000 },
    ),
  ).rejects.toMatchObject({ status: 503 });
  await f.bindings.internalLifecycle.raiseFence({ accountId: owner.accountId, key: key() });
  expect((await point(owner, owner.accountId)).status).toBe(403);
}, 60000);
