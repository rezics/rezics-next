import { suspendAccount } from '../support/native-suspension-driver.ts';
import { createCredentialCapability } from '../../src/access/auth-credential-capability.ts';
import { credentialWorkflowApprovals, createWorkflowApprovals } from '../../src/access/workflow-approvals.ts';
import {
  createAuthService,
  type AuthService,
  type CredentialEffectBinding,
  type CredentialAuthorizationInput,
  type CredentialEffectAuthorization,
} from '@rezics/auth';
import { exportJWK, generateKeyPair } from 'jose';
import type { Pool, PoolClient } from 'pg';
import { migrate as migrateAuth } from '../../../auth/scripts/database.ts';
import { createAccess } from '../../src/access/index.ts';
import { readAccount } from '../../src/access/account-data.ts';
import { createAuthBindings } from '../../src/access/auth-bindings.ts';
import { createOperatorSessionCapability } from '../../src/access/auth-session-capability.ts';
import { createLifecycleInternals } from '../../src/access/lifecycle.ts';
import { createOperatorCommands } from '../../src/access/operator.ts';
import { createRegistrationProofBindings } from '../../src/access/registration-proof.ts';
import { newId, routeOf } from '../../src/route/route.ts';

const issuer = 'https://operator.auth.test';
const password = 'correct horse battery staple';
const cookies = (response: Response) =>
  new Headers({
    cookie: response.headers
      .getSetCookie()
      .map((c) => c.split(';')[0])
      .join('; '),
  });
async function fixture(pool: Pool, authPool: Pool, url: string) {
  migrateAuth(url);
  let service: AuthService;
  let sequence = 0;
  const key = () => `session-${++sequence}`;
  const actions = new Map([['account:manage', { anonymous: false }]]);
  const access = createAccess({
    actions,
    auth: {
      issuer,
      audience: 'https://operator.api.test',
      jwksUrl: `${issuer}/.well-known/jwks.json`,
      fetch: async () => service.handler(new Request(`${issuer}/.well-known/jwks.json`)),
    },
  });
  const operators = createOperatorCommands({ pool, access, actions, managementAction: 'account:manage' });
  const referenceKeys = { current: 1, keys: new Map([[1, new Uint8Array(32).fill(83)]]) };
  const session = createOperatorSessionCapability({
    pool,
    access,
    operators,
    referenceKeys,
    accessTokenForProof: (proof) => service.internal.accessTokenForProof(proof),
  });
  const approvals = createWorkflowApprovals({ pool, access, actions, referenceKeys });
  let verified: CredentialEffectBinding;
  let pending: Omit<CredentialAuthorizationInput, 'human'>;
  let result: { authorization: CredentialEffectAuthorization };
  const capability = createCredentialCapability({
    pool,
    access,
    operators,
    workflowApprovals: approvals,
    referenceKeys,
    accessTokenForProof: (proof) => service.internal.accessTokenForProof(proof),
    // Trusted host closure for a single staged effect. No caller digest establishes provenance.
    verifyCredentialEffect: async () => structuredClone(verified),
  });
  const registration = createRegistrationProofBindings({ pool, referenceKeys });
  const internal = createLifecycleInternals({
    pool,
    routeKey: new Uint8Array(32).fill(32),
    provisioningEvidence: async () => null,
    recoveryEvidence: async () => null,
  });
  const pair = await generateKeyPair('ES256', { extractable: true });
  const vehicleJwk = { ...(await exportJWK(pair.publicKey)), alg: 'ES256' };
  service = await createAuthService({
    database: authPool,
    issuer,
    audience: 'https://operator.api.test',
    secret: 'operator-session-persistent-secret-at-least-32-bytes',
    signing: {
      activeKid: 'operator-key',
      privateKeys: [{ ...(await exportJWK(pair.privateKey)), kid: 'operator-key' }],
    },
    trustedAccess: {
      ...createAuthBindings({ pool, ...registration }),
      async revalidateCredentialEffect() {
        throw new Error('kernel-test-complete');
      },
      async consumeAuthorization(input) {
        result = await capability.consumeAuthAuthorization({ ...pending, human: input.human });
        // Stop before Auth writes: these tests prove kernel checks only.
        throw new Error('kernel-test-complete');
      },
    },
  });
  await service.internal.registerClient({
    clientId: 'operator-web',
    firstParty: true,
    scopes: ['account:manage', 'read'],
  });
  await service.internal.registerClient({
    clientId: 'other-web',
    firstParty: true,
    scopes: ['account:manage', 'read'],
  });
  const request = (path: string, body?: unknown, headers = new Headers()) =>
    service.handler(
      new Request(`${issuer}${path}`, {
        method: body === undefined ? 'GET' : 'POST',
        headers: { origin: issuer, 'content-type': 'application/json', cookie: headers.get('cookie') ?? '' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
    );
  async function person() {
    const id = newId(0x9200 + (sequence++ % 32) * 16);
    const handle = `session_person_${key().replaceAll('-', '_')}`;
    const held = await internal.reserveHandle({ accountId: id, handle, key: key() });
    const input = { accountId: id, handle, reservationId: held.value.reservationId, key: key() };
    const outcome = await internal.createPending(input);
    const authorization = (await registration.createProvisioningReference({ input, outcome }))!;
    await service.internal.provisionPassword({ authorization, email: `${id}@session.test`, password });
    // Trusted fixture activation only; all opening authorization and consumption is native.
    await authPool.query("UPDATE access.account SET state='active' WHERE account_id=$1", [id]);
    await operators.provisionManagementDefaults({ operatorAccountId: id, key: key() });
    return id;
  }
  const login = async (id: string, scope = ['account:manage'], client_id = 'operator-web') => {
    const response = await request('/signin', { email: `${id}@session.test`, password, client_id, scope });
    expect(response.status).toBe(200);
    return cookies(response);
  };
  async function context(headers: Headers) {
    const response = await request('/token', {}, headers);
    expect(response.status).toBe(200);
    const { access_token } = (await response.json()) as { access_token: string };
    const deadline = Date.now() + 3000;
    const actor = await access.authenticate(access_token, { pool, deadline });
    return { actor, account: await readAccount(pool, routeOf(actor.accountId)!, actor.accountId), deadline };
  }
  async function automate(operatorAccountId: string) {
    const subjectAccountId = await person();
    const hold = await operators.reserveResponsibility({ operatorAccountId, subjectAccountId, key: key() });
    await operators.recordOperatorRelation({
      ...hold.value,
      expectedOperatorAccountId: null,
      expectedVersion: '0',
      key: key(),
    });
    return subjectAccountId;
  }
  async function opening(
    headers: Headers,
    operatorAccountId: string,
    subjectAccountId: string,
    purpose: 'session' | 'credential-management' = 'session',
  ) {
    const outcome = await operators.authorizeOpening(await context(headers), {
      operatorAccountId,
      subjectAccountId,
      purpose,
      key: key(),
    });
    return { outcome, reference: session.createOpeningReference(outcome.value) };
  }
  const open = (authorization: string, subjectAccountId: string, headers: Headers) =>
    service.internal.openAutomatedSession({ authorization, subjectAccountId, headers });
  return {
    stage(subjectAccountId: string, actingHumanId: string, purpose: CredentialEffectBinding['purpose'] = 'add-key') {
      verified = {
        operationKey: key(),
        effectReference: key(),
        effectDigest: 'a'.repeat(64),
        subjectAccountId,
        purpose,
        actingHumanId,
        clientId: 'operator-web',
        scopes: ['account:manage'],
        credentialRowId: purpose === 'add-key' ? null : 'selected-row',
        credentialRowVersion: purpose === 'add-key' ? null : '1',
      };
      return structuredClone(verified);
    },
    verifyAs(binding: CredentialEffectBinding) {
      verified = structuredClone(binding);
    },
    async approve(headers: Headers, binding: CredentialEffectBinding) {
      const ctx = await context(headers);
      const current = await readAccount(pool, routeOf(binding.subjectAccountId)!, binding.subjectAccountId);
      if (current!.operatorAccountId) {
        const outcome = await operators.authorizeOpening(ctx, {
          operatorAccountId: current!.operatorAccountId,
          subjectAccountId: binding.subjectAccountId,
          purpose: 'credential-management',
          key: key(),
          credential: binding,
        });
        return {
          reference: capability.createOpeningReference({
            kind: 'operator-opening',
            operationKey: binding.operationKey,
            effectReference: binding.effectReference,
            effectDigest: binding.effectDigest,
            subjectAccountId: binding.subjectAccountId,
            purpose: binding.purpose,
            operatorAccountId: current!.operatorAccountId,
            receiptId: outcome.value.receiptId,
          }),
          expiresAt: outcome.value.expiresAt,
          receiptId: outcome.value.receiptId,
        };
      }
      const token = (await (await request('/token', {}, headers)).json()) as { access_token: string };
      const approval = await credentialWorkflowApprovals(approvals).approveCredential(token.access_token, binding, {
        pool,
        deadline: Date.now() + 3000,
      });
      return {
        reference: capability.createOpeningReference({
          kind: 'workflow-approval',
          operationKey: binding.operationKey,
          effectReference: binding.effectReference,
          effectDigest: binding.effectDigest,
          subjectAccountId: binding.subjectAccountId,
          purpose: binding.purpose,
          reference: approval.reference,
        }),
        expiresAt: approval.expiresAt,
        receiptId: '',
      };
    },
    async consume(reference: string, binding: CredentialEffectBinding, headers: Headers) {
      pending = {
        authorization: reference,
        subjectAccountId: binding.subjectAccountId,
        purpose: binding.purpose,
        operationKey: binding.operationKey,
        effectReference: binding.effectReference,
      };
      const kid = key();
      const staged = await service.internal.stageCredentialEffect({
        key: key(),
        subjectAccountId: binding.subjectAccountId,
        headers,
        credential: { kind: 'key', kid, publicJwk: { ...vehicleJwk, kid } },
      });
      try {
        await service.internal.applyCredentialEffect({
          authorization: reference,
          effectRef: staged.effectRef,
          key: staged.key,
          subjectAccountId: binding.subjectAccountId,
          headers,
        });
      } catch (error) {
        if (!(error instanceof Error) || error.message !== 'kernel-test-complete') throw error;
      }
      return result;
    },
    approvals,
    session,
    internal,
    service,
    access,
    operators,
    capability,
    referenceKeys,
    request,
    person,
    login,
    context,
    automate,
    opening,
    open,
    key,
  };
}

import { afterAll, beforeAll, expect, test } from 'bun:test';
import { openGrowthDatabase, type GrowthDatabase } from '../support/growth.ts';
let db: GrowthDatabase;
let f: Awaited<ReturnType<typeof fixture>>;
let human: string;
let subject: string;
let headers: Headers;
beforeAll(async () => {
  db = await openGrowthDatabase();
  db.pool.options.max = 1;
  f = await fixture(db.pool, db.openPool({ max: 2 }), db.url);
  human = await f.person();
  subject = await f.automate(human);
  headers = await f.login(human);
});
afterAll(async () => db?.close());

test('operator credential opening binds one purpose operation key and Auth commitment and a broad opening alone fails', async () => {
  const binding = f.stage(subject, human);
  const broad = await f.opening(headers, human, subject, 'credential-management');
  const ref = f.capability.createOpeningReference({
    kind: 'operator-opening',
    operationKey: binding.operationKey,
    effectReference: binding.effectReference,
    effectDigest: binding.effectDigest,
    subjectAccountId: subject,
    purpose: binding.purpose,
    operatorAccountId: human,
    receiptId: broad.outcome.value.receiptId,
  });
  await expect(f.consume(ref, binding, headers)).rejects.toThrow();
  await expect(
    db.admin.query(
      `UPDATE access.operator_opening_receipt
       SET credential_operation_key=$4,credential_effect_reference=$5,credential_effect_digest=$6
       WHERE route=$1 AND operator_account_id=$2 AND receipt_id=$3`,
      [
        routeOf(human)!,
        human,
        broad.outcome.value.receiptId,
        binding.operationKey,
        binding.effectReference,
        binding.effectDigest,
      ],
    ),
  ).rejects.toThrow('credential_binding_closed');
  const exact = await f.approve(headers, binding);
  for (const patch of [
    { purpose: 'remove-key' as const },
    { operationKey: f.key() },
    { effectReference: f.key() },
    { effectDigest: 'b'.repeat(64) },
  ]) {
    f.verifyAs({ ...binding, ...patch });
    await expect(f.consume(exact.reference, { ...binding, ...patch }, headers)).rejects.toThrow();
  }
  f.verifyAs(binding);
  const consumed = await f.consume(exact.reference, binding, headers);
  expect(consumed.authorization).toMatchObject({
    purpose: 'add-key',
    operationKey: binding.operationKey,
    effectDigest: binding.effectDigest,
  });
  await expect(f.consume(exact.reference, binding, headers)).rejects.toThrow();
});

test('own human credential approval uses account manage through the formula and is consumed once within 60 seconds', async () => {
  const binding = f.stage(human, human);
  const opening = await f.approve(headers, binding);
  expect(Date.parse(opening.expiresAt) - Date.now()).toBeLessThanOrEqual(60000);
  const consumed = await f.consume(opening.reference, binding, headers);
  expect(consumed.authorization.operatorAccountId).toBeNull();
  await expect(f.consume(opening.reference, binding, headers)).rejects.toThrow();
  const next = f.stage(human, human);
  const approval = await f.approve(headers, next);
  await db.admin.query(
    "DELETE FROM access.resource_grant WHERE route=$1 AND resource_id=$2 AND action='account:manage'",
    [routeOf(human)!, human],
  );
  await expect(f.consume(approval.reference, next, headers)).rejects.toThrow();
  await expect(f.approve(headers, next)).rejects.toThrow();
  await f.operators.provisionManagementDefaults({ operatorAccountId: human, key: f.key() });
  const noScope = await f.login(human, ['read']);
  await expect(f.approve(noScope, next)).rejects.toThrow();
  const denied = await f.approve(headers, next);
  await db.admin.query(
    `INSERT INTO access.resource_denial
      (route,resource_id,subject_id,subject_role,action,reason,valid,transaction_id)
     VALUES ($1,$2,$2,'','account:manage','resource','(,)',$2)`,
    [routeOf(human)!, human],
  );
  await expect(f.consume(denied.reference, next, headers)).rejects.toThrow();
  await db.admin.query('DELETE FROM access.resource_denial WHERE route=$1 AND resource_id=$2', [
    routeOf(human)!,
    human,
  ]);
});

test('every consume rechecks formula state fence floor and operator relation', async () => {
  for (const [target, change] of [
    ['human', "state='suspended'"],
    ['subject', 'authn_fenced=true'],
    ['subject', 'minimum_authn_epoch=2'],
  ]) {
    const h = await f.person();
    const s = await f.automate(h);
    const cookie = await f.login(h);
    const binding = f.stage(s, h);
    const opening = await f.approve(cookie, binding);
    const id = target === 'human' ? h : s;
    if (change === "state='suspended'") await suspendAccount(db.admin, id);
    else
      await db.admin.query(`UPDATE access.account SET ${change} WHERE route=$1 AND account_id=$2`, [routeOf(id)!, id]);
    await expect(f.consume(opening.reference, binding, cookie)).rejects.toThrow();
  }
  {
    const h = await f.person();
    const s = await f.automate(h);
    const cookie = await f.login(h);
    const binding = f.stage(s, h);
    const opening = await f.approve(cookie, binding);
    const other = await f.person();
    const held = await f.operators.reserveResponsibility({
      operatorAccountId: other,
      subjectAccountId: s,
      key: f.key(),
    });
    await f.operators.recordOperatorRelation({
      ...held.value,
      expectedOperatorAccountId: h,
      expectedVersion: '1',
      key: f.key(),
    });
    await expect(f.consume(opening.reference, binding, cookie)).rejects.toThrow();
  }
  const binding = f.stage(subject, human);
  const opening = await f.approve(headers, binding);
  await db.admin.query(
    "UPDATE access.operator_opening_receipt SET expires_at=clock_timestamp()-interval '1 second' WHERE route=$1 AND operator_account_id=$2 AND receipt_id=$3",
    [routeOf(human)!, human, opening.receiptId],
  );
  await expect(f.consume(opening.reference, binding, headers)).rejects.toThrow();
});

test('credential floor hook requires an exact committed floor receipt', async () => {
  const h = await f.person();
  const s = await f.automate(h);
  const cookie = await f.login(h);
  const binding = f.stage(s, h, 'remove-key');
  const opening = await f.approve(cookie, binding);
  const { authorization } = await f.consume(opening.reference, binding, cookie);
  const input = {
    stage: binding,
    consumedOpening: authorization,
    expectedPreviousFloor: 1,
    key: binding.operationKey,
    purpose: binding.purpose,
  };
  await expect(
    f.capability.advanceCredentialFloor({
      ...input,
      consumedOpening: { ...authorization, receiptId: newId(routeOf(h)!) },
    }),
  ).rejects.toThrow();
  await expect(f.capability.advanceCredentialFloor({ ...input, key: f.key() })).rejects.toThrow();
  const receipt = await f.capability.advanceCredentialFloor(input);
  expect(receipt).toMatchObject({
    accountId: s,
    minimumAuthnEpoch: 2,
    previousFloor: 1,
    openingReceiptId: authorization.receiptId,
    fenced: false,
  });
  expect(await f.capability.advanceCredentialFloor(input)).toEqual(receipt);
  const row = (
    await db.admin.query(
      'SELECT minimum_authn_epoch,authn_fenced FROM access.account WHERE route=$1 AND account_id=$2',
      [routeOf(s)!, s],
    )
  ).rows[0];
  expect(Number(row.minimum_authn_epoch)).toBe(2);
  expect(row.authn_fenced).toBe(false);
  await db.admin.query(
    'DELETE FROM access.credential_floor_receipt WHERE route=$1 AND account_id=$2 AND opening_receipt_id=$3',
    [routeOf(s)!, s, authorization.receiptId],
  );
  await expect(f.capability.advanceCredentialFloor(input)).rejects.toThrow();

  const person = await f.person();
  const ownCookie = await f.login(person);
  const ownBinding = f.stage(person, person, 'remove-password');
  const ownApproval = await f.approve(ownCookie, ownBinding);
  const own = await f.consume(ownApproval.reference, ownBinding, ownCookie);
  const ownInput = {
    stage: ownBinding,
    consumedOpening: own.authorization,
    expectedPreviousFloor: 1,
    key: ownBinding.operationKey,
    purpose: ownBinding.purpose,
  };
  const ownReceipt = await f.capability.advanceCredentialFloor(ownInput);
  expect(ownReceipt.minimumAuthnEpoch).toBe(2);
  expect(await f.capability.advanceCredentialFloor(ownInput)).toEqual(ownReceipt);
  await db.admin.query(
    "DELETE FROM access.resource_grant WHERE route=$1 AND resource_id=$2 AND action='account:manage'",
    [routeOf(person)!, person],
  );
  await expect(f.capability.advanceCredentialFloor(ownInput)).rejects.toThrow();
  await f.operators.provisionManagementDefaults({ operatorAccountId: person, key: f.key() });
  const authenticatedAgain = await f.login(person);
  await expect(f.approve(authenticatedAgain, { ...ownBinding, effectDigest: 'b'.repeat(64) })).rejects.toThrow();
  const resumed = await f.approve(authenticatedAgain, ownBinding);
  expect((await f.consume(resumed.reference, ownBinding, authenticatedAgain)).authorization.subjectEpoch).toBe(2);
});

test('legacy unbound credential inputs fail unavailable before any I/O in both capabilities', async () => {
  const input = { purpose: 'add-key' as const, authorization: 'legacy', subjectAccountId: subject, human: {} as never };
  await expect(f.capability.consumeAuthAuthorization(input as never)).rejects.toThrow('unavailable');
  await expect(f.session.consumeAuthAuthorization(input as never)).rejects.toThrow('unavailable');
});

test('lost committed credential consumption acknowledgement leaves the opening spent', async () => {
  const binding = f.stage(subject, human);
  const opening = await f.approve(headers, binding);
  let target: PoolClient | undefined;
  let lost = false;
  const client = await db.pool.connect();
  const query = client.query.bind(client);
  client.query = ((...args: Parameters<typeof query>) => {
    const raw = args[0] as string | { text: string };
    const sql = typeof raw === 'string' ? raw : raw.text;
    if (sql.includes('UPDATE access.operator_opening_receipt')) target = client;
    const value = (query as (...args: unknown[]) => Promise<unknown>)(...args);
    return client === target && sql === 'COMMIT' && !lost
      ? value.then(() => {
          lost = true;
          throw new Error('lost acknowledgement');
        })
      : value;
  }) as typeof client.query;
  client.release();
  try {
    await expect(f.consume(opening.reference, binding, headers)).rejects.toThrow();
  } finally {
    client.query = query;
  }
  expect(lost).toBe(true);
  expect(
    (
      await db.admin.query(
        'SELECT consumed_at FROM access.operator_opening_receipt WHERE route=$1 AND operator_account_id=$2 AND receipt_id=$3',
        [routeOf(human)!, human, opening.receiptId],
      )
    ).rows[0].consumed_at,
  ).not.toBeNull();
  await expect(f.consume(opening.reference, binding, headers)).rejects.toThrow();
});

test('activation grants self account manage to persons only', async () => {
  const id = newId(0x9300);
  const handle = `activation_${f.key().replaceAll('-', '_')}`;
  const claim = await f.internal.reserveHandle({ accountId: id, handle, key: f.key() });
  await f.internal.createPending({ accountId: id, handle, reservationId: claim.value.reservationId, key: f.key() });
  const proof = { accountId: id, registrationId: claim.value.reservationId, authIdentityId: id, authnEpoch: 1 };
  const internal = createLifecycleInternals({
    pool: db.pool,
    routeKey: new Uint8Array(32).fill(32),
    provisioningEvidence: async () => proof,
    recoveryEvidence: async () => null,
  });
  await internal.activate({ accountId: id, key: f.key(), evidence: {} });
  const grants = await db.admin.query(
    "SELECT action FROM access.resource_grant WHERE route=$1 AND resource_id=$2 AND subject_id=$2 AND subject_role='' AND action='account:manage'",
    [routeOf(id)!, id],
  );
  expect(grants.rows).toEqual([{ action: 'account:manage' }]);
  const automated = newId(0x9301);
  const held = await f.operators.reserveResponsibility({
    operatorAccountId: human,
    subjectAccountId: automated,
    key: f.key(),
  });
  const autoHandle = `automated_${f.key().replaceAll('-', '_')}`;
  const registration = await f.internal.reserveHandle({ accountId: automated, handle: autoHandle, key: f.key() });
  await f.internal.createPending({
    accountId: automated,
    handle: autoHandle,
    reservationId: registration.value.reservationId,
    key: f.key(),
  });
  await f.operators.recordOperatorRelation({
    ...held.value,
    expectedOperatorAccountId: null,
    expectedVersion: '0',
    key: f.key(),
  });
  const autoProof = {
    accountId: automated,
    registrationId: registration.value.reservationId,
    authIdentityId: automated,
    authnEpoch: 1,
  };
  const autoInternal = createLifecycleInternals({
    pool: db.pool,
    routeKey: new Uint8Array(32).fill(32),
    provisioningEvidence: async () => autoProof,
    recoveryEvidence: async () => null,
  });
  await autoInternal.activate({ accountId: automated, key: f.key(), evidence: {} });
  expect(
    (
      await db.admin.query(
        "SELECT action FROM access.resource_grant WHERE route=$1 AND resource_id=$2 AND subject_id=$2 AND subject_role='' AND action='account:manage'",
        [routeOf(automated)!, automated],
      )
    ).rows,
  ).toEqual([]);
  const organization = newId(0x9310);
  const owner = await f.internal.reserveCoordination({
    accountId: human,
    relatedAccountId: organization,
    purpose: 'membership',
    key: f.key(),
  });
  await f.internal.createOrganization({
    organizationId: organization,
    ownerAccountId: human,
    ownerReservationId: owner.value.reservationId,
    key: f.key(),
  });
  expect(
    (
      await db.admin.query(
        "SELECT action FROM access.resource_grant WHERE route=$1 AND resource_id=$2 AND subject_id=$2 AND subject_role='' AND action='account:manage'",
        [routeOf(organization)!, organization],
      )
    ).rows,
  ).toEqual([]);
});

test('native bindings install the credential capability beside the unchanged session capability', async () => {
  const { createNativeAccountBindings } = await import('../../src/access/native-account-bindings.ts');
  const bindings = createNativeAccountBindings({
    pool: db.pool,
    access: f.access,
    actions: new Map([['account:manage', { anonymous: false }]]),
    routeKey: new Uint8Array(32).fill(32),
    referenceKeys: f.referenceKeys,
    auth: () => f.service,
    proofs: {
      provisioning: { resolve: async () => null } as never,
      barriers: { verify: async () => null } as never,
      workflow: {
        recordPending: async () => {},
        pendingReference: async () => null,
        provisioningEvidence: async () => null,
      },
    },
  });
  expect(typeof bindings.trustedAccess.advanceCredentialFloor).toBe('function');
  await expect(
    bindings.trustedAccess.consumeAuthorization!({
      purpose: 'add-key',
      authorization: 'legacy',
      subjectAccountId: subject,
      human: {} as never,
    } as never),
  ).rejects.toThrow('unavailable');
});
