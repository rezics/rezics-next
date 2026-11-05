import { actionDeclarations } from './native-account-bindings-fixture.ts';
import { afterAll, beforeAll, expect, test } from 'bun:test';
import {
  createAuthHost,
  createBarrierProofVerifier,
  createNativeWorkflowProofPorts,
  createProvisioningEvidenceVerifier,
  type AuthService,
} from '@rezics/auth';
import { exportJWK, generateKeyPair, type JWK } from 'jose';
import { Pool } from 'pg';
import { testDatabase } from '../../../auth/scripts/database.ts';
import { accessClock } from '../../src/access/access-clock.ts';
import { bootstrapGovernance } from '../../src/access/bootstrap-governance.ts';
import { GrantDeniedError } from '../../src/access/grant-commands.ts';
import { createAccess } from '../../src/access/index.ts';
import { LIFECYCLE_ACTIONS } from '../../src/access/lifecycle.ts';
import { createNativeAccountBindings } from '../../src/access/native-account-bindings.ts';
import { createSessionRevocationCommands } from '../../src/access/session-revocation.ts';
import { createWorkflowApprovals, WORKFLOW_APPROVAL_ACTIONS } from '../../src/access/workflow-approvals.ts';
import { createPool } from '../../src/database/pool.ts';
import { newId, routeOf } from '../../src/route/route.ts';

const pool = createPool(process.env.DATABASE_URL!);
const issuer = 'https://session-revocation.auth.test';
const audience = 'https://session-revocation.api.test';
const clientId = 'session-revocation-client';
const password = 'session revocation original password';
const nextPassword = 'session revocation replacement password';
const scopes = [...LIFECYCLE_ACTIONS.keys(), 'account:suspend'];
const actions = new Map([...LIFECYCLE_ACTIONS, ...WORKFLOW_APPROVAL_ACTIONS, ...actionDeclarations(scopes)]);
const referenceKeys = { current: 1, keys: new Map([[1, new Uint8Array(32).fill(41)]]) };
const deliveries = new Map<string, ReturnType<typeof Promise.withResolvers<string>>>();
const database = testDatabase();
let authPool: Pool;
let service: AuthService;
let host: Awaited<ReturnType<typeof createAuthHost>>;
let bindings: ReturnType<typeof createNativeAccountBindings>;
let key: JWK & { kid: string };
let governor: { accountId: string; bearer: string };

const access = createAccess({
  actions,
  auth: {
    issuer,
    audience,
    jwksUrl: `${issuer}/.well-known/jwks.json`,
    fetch: async () => service.handler(new Request(`${issuer}/.well-known/jwks.json`)),
  },
});
const revocation = createSessionRevocationCommands({ pool, access, clock: accessClock(access) });
const context = () => ({ pool, deadline: Date.now() + 10_000 });
const approvals = () => createWorkflowApprovals({ pool, access, actions, referenceKeys });
const request = (path: string, body?: unknown, cookie = '') =>
  service.handler(
    new Request(`${issuer}${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { origin: issuer, 'content-type': 'application/json', cookie },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
  );
const cookieOf = (response: Response) =>
  response.headers
    .getSetCookie()
    .map((value) => value.split(';')[0])
    .join('; ');
const emailOf = (name: string) => `${name}@session-revocation.test`;
const signIn = (name: string, secret = password) =>
  request('/signin', { email: emailOf(name), password: secret, client_id: clientId, scope: scopes });

type Person = { name: string; accountId: string; cookie: string; bearer: string };
async function session(name: string): Promise<{ cookie: string; bearer: string }> {
  const signed = await signIn(name);
  expect(signed.status).toBe(200);
  const cookie = cookieOf(signed);
  const token = await request('/token', {}, cookie);
  expect(token.status).toBe(200);
  return { cookie, bearer: ((await token.json()) as { access_token: string }).access_token };
}
async function person(name: string): Promise<Person> {
  const { accountId } = await host.workflows.register({
    key: name,
    handle: name,
    email: emailOf(name),
    password,
  });
  return { name, accountId, ...(await session(name)) };
}
const actorOf = (bearer: string) => access.authenticate(bearer, context());
async function accepted(bearer: string) {
  await actorOf(bearer);
}
async function refused(bearer: string) {
  await expect(actorOf(bearer)).rejects.toBeDefined();
}
const fenceState = (accountId: string) => bindings.internalLifecycle.readFenceState(accountId);
async function authSessions(accountId: string) {
  return Number((await authPool.query('SELECT count(*) FROM session WHERE "userId"=$1', [accountId])).rows[0].count);
}
async function receipts(accountId: string) {
  const command = await pool.query(
    "SELECT count(*)::int AS count FROM core.receipt WHERE command_kind='access.account.revoke-sessions' AND response->>'accountId'=$1",
    [accountId],
  );
  const fences = await pool.query(
    'SELECT count(*)::int AS count FROM access.lifecycle_fence_receipt WHERE account_id=$1',
    [accountId],
  );
  return { command: command.rows[0].count as number, fences: fences.rows[0].count as number };
}

/** Auth's session deletion with the world observed at the instant Auth is asked. */
type Observation = { epoch: string; fenced: boolean; receiptKind: string | undefined; sessions: number };
const calls: { accountId: string; observed: Observation }[] = [];
let failAuth = false;
let beforeAuth: ((accountId: string) => Promise<void>) | undefined;
function instrumentAuth() {
  const revokeSessions = service.internal.revokeSessions.bind(service.internal);
  service.internal.revokeSessions = async (accountId, cleanup) => {
    const state = await fenceState(accountId);
    const receipt = state?.receiptId
      ? await bindings.internalLifecycle.readFenceReceipt(accountId, state.receiptId)
      : null;
    calls.push({
      accountId,
      observed: {
        epoch: state?.minimumAuthnEpoch ?? '',
        fenced: state?.fenced ?? false,
        receiptKind: receipt?.kind,
        sessions: await authSessions(accountId),
      },
    });
    await beforeAuth?.(accountId);
    if (failAuth) throw new Error('Auth revocation unavailable');
    return revokeSessions(accountId, cleanup);
  };
}
const callsFor = (accountId: string) => calls.filter((call) => call.accountId === accountId);

let sequence = 0;
async function approveRevoke(bearer: string, accountId: string) {
  const operationKey = `session-revocation-${++sequence}`;
  const approval = await approvals().approve(
    bearer,
    { operationKey, operation: { kind: 'revoke', accountId, authorization: 'approval-request' } },
    context(),
  );
  return { key: operationKey, accountId, authorization: approval.reference };
}
async function startRecovery(subject: Person) {
  const pending = Promise.withResolvers<string>();
  deliveries.set(subject.accountId, pending);
  try {
    expect((await request('/recovery/start', { email: emailOf(subject.name) })).status).toBe(200);
    return await pending.promise;
  } finally {
    deliveries.delete(subject.accountId);
  }
}
const completeRecovery = (subject: Person, token: string) =>
  request('/recovery/complete', { account_id: subject.accountId, token, new_password: nextPassword });

beforeAll(async () => {
  key = { ...(await exportJWK((await generateKeyPair('ES256', { extractable: true })).privateKey)), kid: 'revocation' };
  authPool = new Pool({ connectionString: database.url });
  const proofs = createNativeWorkflowProofPorts({ database: authPool });
  bindings = createNativeAccountBindings({
    pool,
    access,
    actions,
    routeKey: new Uint8Array(32).fill(42),
    referenceKeys,
    auth: () => service,
    proofs: {
      workflow: proofs,
      provisioning: createProvisioningEvidenceVerifier({ database: authPool }),
      barriers: createBarrierProofVerifier({ database: authPool }),
    },
  });
  host = await createAuthHost({
    database: authPool,
    systemDatabasePool: authPool,
    issuer,
    audience,
    secret: 'session-revocation-persistent-auth-secret-32-bytes',
    signing: { activeKid: key.kid, privateKeys: [key] },
    trustedAccess: bindings.trustedAccess,
    access: bindings.workflowPorts,
    stagingKey: new Uint8Array(32).fill(43),
    recoveryDelivery: {
      async deliver({ accountId, token }) {
        deliveries.get(accountId)?.resolve(token);
      },
    },
    maintenanceSchedule: '0 0 1 1 *',
    executorId: 'session-revocation-executor',
  });
  service = host.service;
  await service.internal.registerClient({ clientId, firstParty: true, scopes });
  await host.start();
  instrumentAuth();
  const staff = await person('platform_staff');
  await bootstrapGovernance(pool, staff.accountId);
  governor = staff;
}, 120_000);
afterAll(async () => {
  try {
    await host?.stop();
  } finally {
    await pool.end();
    database.close();
  }
});

test("revoking a person's sessions commits the Access epoch fence and its durable receipt before Auth revokes anything", async () => {
  const subject = await person('revoke_order');
  const before = await fenceState(subject.accountId);
  expect(before).toMatchObject({ fenced: false });
  expect(await receipts(subject.accountId)).toEqual({ command: 0, fences: 0 });
  await accepted(subject.bearer);
  const ask = await approveRevoke(subject.bearer, subject.accountId);

  expect(await host.workflows.revokeSessions(ask)).toEqual({ accountId: subject.accountId });

  // Auth was asked once, and only after Access held the advanced floor, the fence and the receipt.
  const [call] = callsFor(subject.accountId);
  expect(callsFor(subject.accountId)).toHaveLength(1);
  expect(BigInt(call!.observed.epoch)).toBe(BigInt(before!.minimumAuthnEpoch) + 1n);
  expect(call!.observed).toMatchObject({ fenced: true, receiptKind: 'fence', sessions: 1 });
  const after = await fenceState(subject.accountId);
  expect(after).toMatchObject({ fenced: true, minimumAuthnEpoch: call!.observed.epoch });
  expect(await bindings.internalLifecycle.readFenceReceipt(subject.accountId, after!.receiptId!)).toMatchObject({
    accountId: subject.accountId,
    minimumAuthnEpoch: call!.observed.epoch,
    kind: 'fence',
    priorOperatorAccountId: null,
  });
  expect(await receipts(subject.accountId)).toEqual({ command: 1, fences: 1 });
  expect(await authSessions(subject.accountId)).toBe(0);
});

test('sessions and tokens issued before the fence are refused', async () => {
  const subject = await person('revoke_refused');
  const other = await person('revoke_unrelated');
  await accepted(subject.bearer);
  const ask = await approveRevoke(subject.bearer, subject.accountId);
  // Hold Auth at the moment the fence is committed and Auth has not deleted anything.
  const held = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  beforeAuth = async (accountId) => {
    if (accountId !== subject.accountId) return;
    held.resolve();
    await release.promise;
  };
  const running = host.workflows.revokeSessions(ask);
  await held.promise;
  try {
    expect(await authSessions(subject.accountId)).toBe(1);
    await refused(subject.bearer);
    expect((await request('/token', {}, subject.cookie)).status).not.toBe(200);
    expect((await signIn(subject.name)).status).not.toBe(200);
  } finally {
    beforeAuth = undefined;
    release.resolve();
  }
  await running;
  await refused(subject.bearer);
  expect((await request('/token', {}, subject.cookie)).status).not.toBe(200);
  expect((await signIn(subject.name)).status).not.toBe(200);
  // The fence is the one person's; an unrelated person keeps working.
  await accepted(other.bearer);
  expect((await request('/token', {}, other.cookie)).status).toBe(200);
});

test('a recovery started before the fence cannot complete or undo it', async () => {
  const subject = await person('revoke_recovery');
  const stale = await startRecovery(subject);
  const ask = await approveRevoke(subject.bearer, subject.accountId);
  await host.workflows.revokeSessions(ask);
  const fenced = await fenceState(subject.accountId);
  const receipt = await bindings.internalLifecycle.readFenceReceipt(subject.accountId, fenced!.receiptId!);
  expect(fenced).toMatchObject({ fenced: true });
  const credential = async () =>
    (await authPool.query('SELECT password FROM account WHERE "userId"=$1', [subject.accountId])).rows;
  const original = await credential();

  expect((await completeRecovery(subject, stale)).status).toBe(401);

  // The attempt neither lowered the floor nor cleared the fence, nor changed the credential.
  expect(await fenceState(subject.accountId)).toEqual(fenced);
  expect(await bindings.internalLifecycle.readFenceReceipt(subject.accountId, fenced!.receiptId!)).toEqual(receipt);
  expect(await credential()).toEqual(original);
  expect((await signIn(subject.name, nextPassword)).status).not.toBe(200);

  // A recovery started after the fence is the one that restores the person, at a higher floor. Auth admits one
  // recovery start per person per minute; the earlier start's admission is not what this test is about.
  await authPool.query('DELETE FROM auth_attempt_counter');
  const fresh = await startRecovery(subject);
  expect((await completeRecovery(subject, fresh)).status).toBe(200);
  const recovered = await fenceState(subject.accountId);
  expect(recovered).toMatchObject({ fenced: false });
  expect(BigInt(recovered!.minimumAuthnEpoch)).toBeGreaterThan(BigInt(fenced!.minimumAuthnEpoch));
  await refused(subject.bearer);
  const signed = await signIn(subject.name, nextPassword);
  expect(signed.status).toBe(200);
  await accepted(
    ((await (await request('/token', {}, cookieOf(signed))).json()) as { access_token: string }).access_token,
  );
});

test('an Auth revocation failure answers revocation-failed and leaves the fence', async () => {
  const subject = await person('revoke_failure');
  const before = await fenceState(subject.accountId);
  const ask = await approveRevoke(subject.bearer, subject.accountId);
  failAuth = true;
  try {
    await expect(host.workflows.revokeSessions(ask)).rejects.toMatchObject({ code: 'revocation-failed' });
  } finally {
    failAuth = false;
  }
  expect(callsFor(subject.accountId)).toHaveLength(1);
  const fenced = await fenceState(subject.accountId);
  expect(fenced).toMatchObject({ fenced: true });
  expect(BigInt(fenced!.minimumAuthnEpoch)).toBe(BigInt(before!.minimumAuthnEpoch) + 1n);
  expect(await receipts(subject.accountId)).toEqual({ command: 1, fences: 1 });
  // Auth kept the session, but the fence still refuses every token and every new one.
  expect(await authSessions(subject.accountId)).toBe(1);
  await refused(subject.bearer);
  expect((await request('/token', {}, subject.cookie)).status).not.toBe(200);

  // The same operation resumes under its committed continuation, without the standing the fence ended.
  expect(await host.workflows.resumeOperation(ask.key)).toEqual({ accountId: subject.accountId });
  expect(callsFor(subject.accountId)).toHaveLength(2);
  expect(await authSessions(subject.accountId)).toBe(0);
  expect(await fenceState(subject.accountId)).toEqual(fenced);
  expect(await receipts(subject.accountId)).toEqual({ command: 1, fences: 1 });
});

test('a replay revokes nothing twice', async () => {
  const subject = await person('revoke_replay');
  // Platform governance keeps its standing, so the same request can be replayed in full.
  const ask = await approveRevoke(governor.bearer, subject.accountId);
  expect(await host.workflows.revokeSessions(ask)).toEqual({ accountId: subject.accountId });
  const fenced = await fenceState(subject.accountId);
  expect(await host.workflows.revokeSessions(ask)).toEqual({ accountId: subject.accountId });
  expect(await host.workflows.resumeOperation(ask.key)).toEqual({ accountId: subject.accountId });
  expect(callsFor(subject.accountId)).toHaveLength(1);
  expect(await fenceState(subject.accountId)).toEqual(fenced);
  expect(await receipts(subject.accountId)).toEqual({ command: 1, fences: 1 });

  // The native command alone replays by its key: the stored answer, one receipt and no second advance.
  const direct = await person('revoke_replay_direct');
  const actor = await actorOf(governor.bearer);
  const first = await revocation.revoke({ ...context(), actor }, { accountId: direct.accountId, key: 'direct-replay' });
  const again = await revocation.revoke({ ...context(), actor }, { accountId: direct.accountId, key: 'direct-replay' });
  expect(first.replayed).toBe(false);
  expect(again).toMatchObject({ replayed: true, value: first.value });
  expect(await fenceState(direct.accountId)).toMatchObject({ minimumAuthnEpoch: first.value.minimumAuthnEpoch });
  expect(await receipts(direct.accountId)).toEqual({ command: 1, fences: 1 });

  // The subject's own request is not replayable once its floor has advanced.
  const own = await person('revoke_replay_own');
  const ownAsk = await approveRevoke(own.bearer, own.accountId);
  await host.workflows.revokeSessions(ownAsk);
  const settled = await fenceState(own.accountId);
  await expect(host.workflows.revokeSessions(ownAsk)).rejects.toMatchObject({ status: 403 });
  expect(await fenceState(own.accountId)).toEqual(settled);
  expect(callsFor(own.accountId)).toHaveLength(1);
  expect(await receipts(own.accountId)).toEqual({ command: 1, fences: 1 });
});

test('the subject itself and platform governance may revoke and nobody else may', async () => {
  const subject = await person('revoke_authority');
  const stranger = await person('revoke_stranger');
  const owner = await person('revoke_owner');
  const manager = await person('revoke_manager');

  // An organization's owner who counts the subject among its members.
  const organizationId = newId(routeOf(owner.accountId)!);
  const hold = (
    await bindings.internalLifecycle.reserveCoordination({
      accountId: owner.accountId,
      relatedAccountId: organizationId,
      purpose: 'membership',
      key: 'authority-organization-hold',
    })
  ).value;
  await bindings.internalLifecycle.createOrganization({
    organizationId,
    ownerAccountId: owner.accountId,
    ownerReservationId: hold.reservationId,
    key: 'authority-organization',
  });
  const membership = (
    await bindings.internalLifecycle.reserveCoordination({
      accountId: subject.accountId,
      relatedAccountId: organizationId,
      purpose: 'membership',
      key: 'authority-membership-hold',
    })
  ).value;
  await bindings.lifecycle.setMembership(
    { ...context(), actor: await actorOf(owner.bearer) },
    {
      organizationId,
      memberAccountId: subject.accountId,
      reservationId: membership.reservationId,
      role: 'member',
      key: 'authority-membership',
    },
  );
  // The manager of an automated account that the subject does not operate.
  const bot = await host.workflows.createAutomated({
    key: 'authority-automated',
    handle: 'authority_bot',
    operatorAccountId: manager.accountId,
    authorization: (
      await approvals().approve(
        manager.bearer,
        {
          operationKey: 'authority-automated',
          operation: {
            kind: 'automated',
            registrationId: '',
            operatorAccountId: manager.accountId,
            handle: 'authority_bot',
            operationKey: 'authority-automated',
            authorization: 'approval-request',
          },
        },
        context(),
      )
    ).reference,
  });

  const untouched = await fenceState(subject.accountId);
  for (const intruder of [stranger, owner, manager]) {
    await expect(approveRevoke(intruder.bearer, subject.accountId)).rejects.toMatchObject({ status: 403 });
    const actor = await actorOf(intruder.bearer);
    await expect(
      revocation.revoke({ ...context(), actor }, { accountId: subject.accountId, key: `refused-${intruder.name}` }),
    ).rejects.toBeInstanceOf(GrantDeniedError);
  }
  // Neither the manager of an automated account nor anyone but the account itself reaches it.
  await expect(approveRevoke(manager.bearer, bot.accountId)).rejects.toMatchObject({ status: 403 });
  expect(await fenceState(subject.accountId)).toEqual(untouched);
  expect(await receipts(subject.accountId)).toEqual({ command: 0, fences: 0 });
  expect(callsFor(subject.accountId)).toHaveLength(0);
  await accepted(subject.bearer);

  // Nothing is borrowed from an approval: a reference made for one account cannot revoke another.
  const mine = await approveRevoke(stranger.bearer, stranger.accountId);
  await expect(host.workflows.revokeSessions({ ...mine, accountId: subject.accountId })).rejects.toBeDefined();
  expect(await fenceState(subject.accountId)).toEqual(untouched);

  // The subject itself, then platform governance on another person.
  await host.workflows.revokeSessions(await approveRevoke(subject.bearer, subject.accountId));
  await refused(subject.bearer);
  expect(callsFor(subject.accountId)).toHaveLength(1);
  const target = await person('revoke_authority_target');
  await host.workflows.revokeSessions(await approveRevoke(governor.bearer, target.accountId));
  await refused(target.bearer);
  expect(await fenceState(target.accountId)).toMatchObject({ fenced: true });
  expect(callsFor(target.accountId)).toHaveLength(1);

  // Governance holds the action on the Global Context, not on a person: an automated account stays out of reach.
  const botCall = approveRevoke(governor.bearer, bot.accountId);
  await expect(botCall.then((ask) => host.workflows.revokeSessions(ask))).rejects.toBeDefined();
  expect(callsFor(bot.accountId)).toHaveLength(0);
  expect(await fenceState(bot.accountId)).toMatchObject({ fenced: false });
});
