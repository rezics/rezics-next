import { afterAll, beforeAll, expect, test } from 'bun:test';
import { exportJWK, generateKeyPair } from 'jose';
import { migrate as migrateAuth } from '../../../auth/scripts/database.ts';
import { createPool } from '../../src/database/pool.ts';
import { newId, routeOf } from '../../src/route/route.ts';
import { ACCESS_EVENTS } from '../../src/access/events.ts';
import { readBatch } from '../../src/events/log.ts';

// The focused acceptance command also runs from the repository root.
await import('reylo/register');
const { readAccount } = await import('../../src/access/account-data.ts');
const { bootstrapGovernance, PLATFORM_RESOURCE } = await import('../../src/access/bootstrap-governance.ts');
const { createDelegationCommands } = await import('../../src/access/delegation-commands.ts');
const { createLifecycleCommands, createLifecycleInternals, LIFECYCLE_ACTIONS } =
  await import('../../src/access/lifecycle.ts');
const { createMembershipInverseCommands } = await import('../../src/access/membership-inverse.ts');
const { createSuspensionCommands } = await import('../../src/access/suspension.ts');
const { installResourceRoleCatalogue, resolveResourceRoles } = await import('../../src/access/resource-roles.ts');
const { installStandingParentGrant } = await import('../../src/access/standing-parent.ts');
const { sweepWorkflowApprovals } = await import('../../src/access/workflow-approvals.ts');
const { createAccess } = await import('../../src/access/index.ts');
const { createAccess: createPermissionAccess } = await import('../../src/access/permission.ts');
const { accessCommandAuthorization } = await import('../../src/request/access.ts');
const { cookies, issuer, nativeFixture, password, scopes } = await import('./native-account-bindings-fixture.ts');

const url = process.env.DATABASE_URL!;
const pool = createPool(url);
const catalogueScopes = [...scopes, 'account:update', 'account:delete', 'organization:membership', 'account:suspend'];
let f: Awaited<ReturnType<typeof nativeFixture>>;
let bearer = '';
let headers = new Headers();
const key = () => Bun.randomUUIDv7();
const proofs = new Map<
  string,
  { accountId: string; registrationId: string; authIdentityId: string; authnEpoch: number }
>();
let recovery: {
  accountId: string;
  receiptId: string;
  minimumAuthnEpoch: string;
  authnEpoch: number;
  establishmentId: string;
} | null = null;

beforeAll(async () => {
  migrateAuth(url);
  const pair = await generateKeyPair('ES256', { extractable: true });
  f = await nativeFixture(pool, undefined, {
    database: { url, container: '', close() {} },
    privateKey: { ...(await exportJWK(pair.privateKey)), kid: 'access-event-catalogue' },
  });
  await f.host.service.internal.registerClient({
    clientId: 'catalogue-client',
    firstParty: true,
    scopes: catalogueScopes,
  });
}, 60_000);

afterAll(async () => {
  try {
    await f?.close();
  } finally {
    await pool.end();
  }
});

async function accountOf(id: string) {
  const account = await readAccount(pool, routeOf(id)!, id);
  if (!account) throw new Error(`missing account ${id}`);
  return account;
}

async function governorRequest() {
  const deadline = Date.now() + 20_000;
  const actor = await f.access.authenticate(bearer, { pool, deadline });
  return { actor, account: await accountOf(actor.accountId), deadline };
}

async function step<T>(name: string, run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`${name} failed: ${message}`, { cause: error });
  }
}

test('real access commands cover every registered event and the log reader accepts them', async () => {
  const governor = await step('register', () => f.person('catalogue_governor'));
  const signed = await f.request('/signin', {
    email: 'catalogue_governor@ordinary.test',
    password,
    client_id: 'catalogue-client',
    scope: catalogueScopes,
  });
  expect(signed.status).toBe(200);
  headers = cookies(signed);
  const token = await f.request('/token', {}, headers);
  expect(token.status).toBe(200);
  bearer = ((await token.json()) as { access_token: string }).access_token;

  const internal = f.bindings.internalLifecycle;
  const operators = f.bindings.operators;
  const evidenced = createLifecycleInternals({
    pool,
    routeKey: new Uint8Array(32).fill(77),
    provisioningEvidence: async (proof) => proofs.get(String(proof)) ?? null,
    recoveryEvidence: async () => recovery,
  });
  async function activated(handle: string) {
    const accountId = internal.registrationTarget(key());
    const claim = (await internal.reserveHandle({ handle, accountId, key: key() })).value;
    await internal.createPending({
      accountId,
      handle: claim.handle,
      reservationId: claim.reservationId,
      key: key(),
    });
    const evidence = key();
    proofs.set(evidence, {
      accountId,
      registrationId: claim.reservationId,
      authIdentityId: accountId,
      authnEpoch: 1,
    });
    await evidenced.claimHandle({
      accountId,
      handle: claim.handle,
      reservationId: claim.reservationId,
      evidence,
      key: key(),
    });
    await evidenced.activate({ accountId, evidence, key: key() });
    return { accountId, handle: claim.handle, reservationId: claim.reservationId };
  }

  const victim = await step('victim', () => activated('catalogue_victim'));
  const departed = await step('departed', () => activated('catalogue_departed'));
  const robotId = internal.registrationTarget(key());
  const robotClaim = await step('robot reserve', () =>
    internal.reserveHandle({ handle: 'catalogue_robot', accountId: robotId, key: key() }),
  );
  await step('robot pending', () =>
    internal.createPending({
      accountId: robotId,
      handle: robotClaim.value.handle,
      reservationId: robotClaim.value.reservationId,
      key: key(),
    }),
  );
  const linked = await step('responsibility', () =>
    operators.reserveResponsibility({ operatorAccountId: governor.accountId, subjectAccountId: robotId, key: key() }),
  );
  await step('relation', () =>
    operators.recordOperatorRelation({
      operatorAccountId: governor.accountId,
      subjectAccountId: robotId,
      reservationId: linked.value.reservationId,
      expectedOperatorAccountId: null,
      expectedVersion: '0',
      key: key(),
    }),
  );
  const robotEvidence = key();
  proofs.set(robotEvidence, {
    accountId: robotId,
    registrationId: robotClaim.value.reservationId,
    authIdentityId: robotId,
    authnEpoch: 1,
  });
  await step('robot claim', () =>
    evidenced.claimHandle({
      accountId: robotId,
      handle: robotClaim.value.handle,
      reservationId: robotClaim.value.reservationId,
      evidence: robotEvidence,
      key: key(),
    }),
  );
  await step('robot activate', () => evidenced.activate({ accountId: robotId, evidence: robotEvidence, key: key() }));
  const spare = await step('spare responsibility', () =>
    operators.reserveResponsibility({ operatorAccountId: governor.accountId, subjectAccountId: robotId, key: key() }),
  );
  await step('retire', () => operators.retireResponsibility({ ...spare.value, key: key() }));
  await step('release responsibility', () => operators.releaseResponsibility({ ...spare.value, key: key() }));
  const opening = await step('opening', async () =>
    operators.authorizeOpening(await governorRequest(), {
      operatorAccountId: governor.accountId,
      subjectAccountId: robotId,
      purpose: 'session',
      key: key(),
    }),
  );
  await step('consume opening', async () =>
    operators.consumeOpening(await governorRequest(), {
      operatorAccountId: governor.accountId,
      subjectAccountId: robotId,
      receiptId: opening.value.receiptId,
      purpose: 'session',
      key: key(),
    }),
  );

  await step('bootstrap', () => bootstrapGovernance(pool, governor.accountId));
  const mounted = new Map([...LIFECYCLE_ACTIONS, ...scopes.map((scope) => [scope, { anonymous: false }] as const)]);
  installResourceRoleCatalogue(
    f.access,
    resolveResourceRoles(mounted, {
      roles: { 'catalogue.reader': ['subject:create'], 'catalogue.writer': ['subject:batch_write'] },
      types: {},
    }),
  );
  const grantContext = async () => {
    const live = await governorRequest();
    return { actor: live.actor, pool, deadline: live.deadline };
  };
  const resource = PLATFORM_RESOURCE;
  const subject = { kind: 'account' as const, id: governor.accountId };
  await step('grant create', async () =>
    f.bindings.grants.create(await grantContext(), {
      resource,
      subject,
      actions: ['subject:create'],
      valid: '(,)',
      key: key(),
    }),
  );
  await step('grant change', async () =>
    f.bindings.grants.change(await grantContext(), {
      resource,
      subject,
      actions: ['subject:batch_write'],
      valid: '(,)',
      previous: { actions: ['subject:create'], valid: '(,)' },
      key: key(),
    }),
  );
  await step('grant revoke', async () =>
    f.bindings.grants.revoke(await grantContext(), {
      resource,
      subject,
      actions: ['subject:batch_write'],
      valid: '(,)',
      key: key(),
    }),
  );
  await step('role create', async () =>
    f.bindings.grants.createRole(await grantContext(), {
      resource,
      subject,
      role: 'catalogue.reader',
      valid: '(,)',
      key: key(),
    }),
  );
  await step('role change', async () =>
    f.bindings.grants.changeRole(await grantContext(), {
      resource,
      subject,
      role: 'catalogue.writer',
      valid: '(,)',
      previous: { role: 'catalogue.reader', valid: '(,)' },
      key: key(),
    }),
  );
  await step('role revoke', async () =>
    f.bindings.grants.revokeRole(await grantContext(), {
      resource,
      subject,
      role: 'catalogue.writer',
      valid: '(,)',
      key: key(),
    }),
  );
  const delegations = createDelegationCommands({ pool, access: f.access, action: 'account:manage' });
  const requestId = newId(routeOf(victim.accountId)!);
  await step('assignment create', async () =>
    delegations.create(await grantContext(), {
      principalId: governor.accountId,
      assignedActorId: victim.accountId,
      requestId,
      valid: '(,)',
      key: key(),
    }),
  );
  await step('standing parent', async () => {
    const live = await governorRequest();
    const authority = await accessCommandAuthorization(
      f.access,
      live.actor,
      'access:grant',
      PLATFORM_RESOURCE,
      { pool, deadline: live.deadline },
      () => new Error('standing parent denied'),
    );
    return installStandingParentGrant({
      access: f.access,
      parent: { resource: PLATFORM_RESOURCE, validate: async () => true },
      authority,
      context: { actor: live.actor, pool, deadline: live.deadline },
      actions: ['subject:create'],
    });
  });

  const organizationId = newId(routeOf(governor.accountId)!);
  const ownerHold = await step('owner hold', () =>
    internal.reserveCoordination({
      accountId: governor.accountId,
      relatedAccountId: organizationId,
      purpose: 'membership',
      key: key(),
    }),
  );
  await step('create organization', () =>
    internal.createOrganization({
      organizationId,
      ownerAccountId: governor.accountId,
      ownerReservationId: ownerHold.value.reservationId,
      key: key(),
    }),
  );
  const orgReserved = await step('org handle reserve', () =>
    internal.reserveHandle({ handle: 'catalogue_org', accountId: organizationId, key: key() }),
  );
  const orgHandle = await step('org handle hold', () =>
    internal.holdHandle({
      accountId: organizationId,
      handle: 'catalogue_org',
      reservationId: orgReserved.value.reservationId,
      operationId: key(),
      expectedHandle: null,
      key: key(),
    }),
  );
  await step('publish org handle', () =>
    internal.bootstrapOrganizationHandle({
      ...orgHandle.value,
      ownerAccountId: governor.accountId,
      ownerReservationId: ownerHold.value.reservationId,
      expectedHandle: null,
      key: key(),
    }),
  );
  const memberHold = await step('member hold', () =>
    internal.reserveCoordination({
      accountId: victim.accountId,
      relatedAccountId: organizationId,
      purpose: 'membership',
      key: key(),
    }),
  );
  await step('add member', async () =>
    f.bindings.lifecycle.setMembership(await governorRequest(), {
      organizationId,
      memberAccountId: victim.accountId,
      reservationId: memberHold.value.reservationId,
      role: 'member',
      key: key(),
    }),
  );
  const source = await pool.query<{ id: string }>(
    `SELECT transaction_id::text AS id FROM access.organization_member
     WHERE organization_id = $1 AND member_account_id = $2 ORDER BY lower(valid) DESC LIMIT 1`,
    [organizationId, victim.accountId],
  );
  await step('bootstrap inverse', () =>
    createMembershipInverseCommands({ pool }).bootstrapStep({
      accountId: victim.accountId,
      principal: { kind: 'organization', id: organizationId },
      key: key(),
      sourceTransactionId: source.rows[0]!.id,
    }),
  );
  await step('remove member', async () =>
    f.bindings.lifecycle.setMembership(await governorRequest(), {
      organizationId,
      memberAccountId: victim.accountId,
      reservationId: memberHold.value.reservationId,
      role: null,
      key: key(),
    }),
  );
  await step('release coordination', () =>
    internal.releaseMembershipCoordination({
      organizationId,
      memberAccountId: victim.accountId,
      reservationId: memberHold.value.reservationId,
      key: key(),
    }),
  );
  const unpublished = newId(4);
  const inverse = createMembershipInverseCommands({ pool });
  const unpublishedHold = await step('unpublished reserve', () =>
    inverse.reserve({
      accountId: victim.accountId,
      principal: { kind: 'organization', id: unpublished },
      key: key(),
    }),
  );
  await step('terminalize', () =>
    internal.terminalizeMembership({
      organizationId: unpublished,
      memberAccountId: victim.accountId,
      reservationId: unpublishedHold.value.reservationId,
      key: key(),
    }),
  );
  await step('inverse release', () =>
    inverse.release({
      accountId: victim.accountId,
      principal: { kind: 'organization', id: unpublished },
      reservationId: unpublishedHold.value.reservationId,
      key: key(),
    }),
  );

  await step('self read', () => internal.installSelfReadGrant({ accountId: governor.accountId, key: key() }));
  await step('update account', async () =>
    f.bindings.lifecycle.updateAccount(await governorRequest(), {
      accountId: governor.accountId,
      key: key(),
      patch: { displayName: 'Catalogue' },
    }),
  );
  await step('operator coordination', () =>
    internal.reserveCoordination({
      accountId: governor.accountId,
      relatedAccountId: victim.accountId,
      purpose: 'operator',
      key: key(),
    }),
  );
  const cancelled = {
    accountId: governor.accountId,
    handle: 'catalogue_cancel',
    reservationId: '',
    operationId: key(),
    expectedHandle: 'catalogue_governor',
    key: key(),
  };
  cancelled.reservationId = (
    await step('cancel reserve', () =>
      internal.reserveHandle({ handle: cancelled.handle, accountId: governor.accountId, key: key() }),
    )
  ).value.reservationId;
  await step('cancel hold', () => internal.holdHandle(cancelled));
  await step('cancel transition', () => internal.cancelHandleTransition({ ...cancelled, key: key() }));
  await step('release transition', () => internal.releaseHandleTransition({ ...cancelled, key: key() }));
  const renamed = {
    accountId: governor.accountId,
    handle: 'catalogue_renamed',
    reservationId: '',
    operationId: key(),
    expectedHandle: 'catalogue_governor',
    key: key(),
  };
  renamed.reservationId = (
    await step('rename reserve', () =>
      internal.reserveHandle({ handle: renamed.handle, accountId: governor.accountId, key: key() }),
    )
  ).value.reservationId;
  await step('rename hold', () => internal.holdHandle({ ...renamed, key: key() }));
  await step('publish rename', async () =>
    f.bindings.lifecycle.transitionAccountHandle(await governorRequest(), renamed),
  );
  await step('claim rename', () => internal.finalizeHandleTransition({ ...renamed, key: key() }));
  await step('redirect rename', () => internal.redirectTransitionHandle({ ...renamed, key: key() }));
  await step('complete rename', () => internal.completeHandleTransition({ ...renamed, key: key() }));

  const expiredId = internal.registrationTarget(key());
  const expiredClaim = await step('expiry reserve', () =>
    internal.reserveHandle({ handle: 'catalogue_expired', accountId: expiredId, key: key() }),
  );
  await step('expiry pending', () =>
    internal.createPending({
      accountId: expiredId,
      handle: expiredClaim.value.handle,
      reservationId: expiredClaim.value.reservationId,
      key: key(),
    }),
  );
  await pool.query(
    `UPDATE access.account SET registration_expires_at = '2000-01-01T00:00:00.000Z' WHERE account_id = $1`,
    [expiredId],
  );
  await step('expire registration', () =>
    internal.expireRegistration({
      accountId: expiredId,
      handle: expiredClaim.value.handle,
      reservationId: expiredClaim.value.reservationId,
      key: key(),
    }),
  );
  await step('release expired handle', () =>
    internal.releaseExpiredRegistrationHandle({
      accountId: expiredId,
      handle: expiredClaim.value.handle,
      reservationId: expiredClaim.value.reservationId,
      key: key(),
    }),
  );
  const spareHandle = internal.registrationTarget(key());
  await step('expire reserve', () =>
    internal.reserveHandle({ handle: 'catalogue_expire', accountId: spareHandle, key: key() }),
  );
  await pool.query(
    `UPDATE access.handle_claim SET expires_at = '2000-01-01T00:00:00.000Z' WHERE normalized_handle = 'catalogue_expire'`,
  );
  await step('expire handle', () => internal.expireHandle({ handle: 'catalogue_expire', key: key() }));

  const floor = Number((await accountOf(victim.accountId)).minimumAuthnEpoch);
  await step('advance floor', () =>
    internal.advanceAuthenticationFloor(
      {
        accountId: victim.accountId,
        key: key(),
        purpose: 'consent-reduction',
        expectedMinimumAuthnEpoch: floor,
        proofReference: 'ab'.repeat(32),
        proofDigest: 'cd'.repeat(32),
        proofExpiresAt: new Date(Date.now() + 60_000).toISOString(),
      },
      async () => true,
    ),
  );
  const fenced = await step('raise fence', () => internal.raiseFence({ accountId: victim.accountId, key: key() }));
  recovery = {
    accountId: victim.accountId,
    receiptId: fenced.value.receiptId,
    minimumAuthnEpoch: fenced.value.minimumAuthnEpoch,
    authnEpoch: Number(fenced.value.minimumAuthnEpoch),
    establishmentId: newId(routeOf(victim.accountId)!),
  };
  await step('clear fence', () =>
    evidenced.clearFence({ accountId: victim.accountId, evidence: 'recovery', key: key() }),
  );

  const suspendAccess = createAccess({
    actions: new Map([...mounted, ['account:suspend', { anonymous: false }]]),
    auth: {
      issuer,
      audience: 'https://ordinary.api.test',
      jwksUrl: `${issuer}/.well-known/jwks.json`,
      fetch: async () => f.host.service.handler(new Request(`${issuer}/.well-known/jwks.json`)),
    },
  });
  await step('suspend', async () => {
    const deadline = Date.now() + 20_000;
    const actor = await suspendAccess.authenticate(bearer, { pool, deadline });
    return createSuspensionCommands({ pool, access: suspendAccess, clock: () => new Date() }).suspend(
      { actor, pool, deadline },
      { accountId: victim.accountId, key: key(), reason: 'catalogue' },
    );
  });
  await step('redirect departed', () =>
    internal.redirectHandle({ handle: departed.handle, accountId: departed.accountId, key: key() }),
  );
  const tombstoneAccess = createPermissionAccess({
    actions: LIFECYCLE_ACTIONS,
    accountEvidence: (_actor, context) => context.account,
  });
  await step('tombstone', async () =>
    createLifecycleCommands({ pool, access: tombstoneAccess }).tombstone(
      {
        actor: {
          kind: 'account',
          accountId: departed.accountId,
          clientId: 'catalogue-client',
          requestedBy: null,
          authnEpoch: 1,
          scopes: ['account:delete'],
        },
        account: await accountOf(departed.accountId),
        deadline: Date.now() + 20_000,
      },
      { accountId: departed.accountId, key: key() },
    ),
  );

  const publicJwk = {
    ...(await exportJWK((await generateKeyPair('ES256', { extractable: true })).publicKey)),
    kid: 'catalogue-key',
  };
  async function credential(
    body:
      | { kind: 'key'; kid: string; publicJwk: typeof publicJwk; remove?: undefined }
      | {
          kind: 'key';
          kid: string;
          remove: true;
        },
  ) {
    const staged = await f.host.service.internal.stageCredentialEffect({
      key: key(),
      subjectAccountId: governor.accountId,
      headers,
      credential: body,
    });
    const approved = await f.host.service.internal.approveCredentialEffect({
      effectRef: staged.effectRef,
      key: staged.key,
      subjectAccountId: governor.accountId,
      headers,
    });
    await f.host.service.internal.applyCredentialEffect({
      authorization: approved.reference,
      effectRef: staged.effectRef,
      key: staged.key,
      subjectAccountId: governor.accountId,
      headers,
    });
  }
  await step('add key', () => credential({ kind: 'key', kid: publicJwk.kid, publicJwk }));
  await step('remove key', () => credential({ kind: 'key', kid: publicJwk.kid, remove: true }));
  await step('sweep', () => sweepWorkflowApprovals(pool, routeOf(governor.accountId)!, 1000));

  const seen = new Set<string>();
  const partitions = await pool.query<{ partition_no: number }>(
    'SELECT partition_no FROM core.partition WHERE position > 0 ORDER BY partition_no',
  );
  expect(partitions.rows.length).toBeGreaterThan(0);
  for (const row of partitions.rows) {
    for (;;) {
      const result = await readBatch(pool, {
        consumer: 'access_event_catalogue',
        partition: row.partition_no,
        apply: async (envelopes) => {
          for (const envelope of envelopes) for (const event of envelope.events) seen.add(event.type);
        },
      });
      if (result.status === 'busy') continue;
      if (result.status === 'stopped') {
        const failed = await pool.query(
          `SELECT position::text, event_seq, type, data FROM core.outbox
           WHERE partition_no = $1 AND position > $2 ORDER BY position, event_seq LIMIT 3`,
          [row.partition_no, result.position.toString()],
        );
        throw new Error(
          `${result.reason} on partition ${row.partition_no} after ${result.position}: ${JSON.stringify(failed.rows)}`,
        );
      }
      if (result.envelopes === 0) break;
    }
  }
  const missing = Object.keys(ACCESS_EVENTS).filter((type) => !seen.has(type));
  expect(missing).toEqual([]);
}, 60_000);
