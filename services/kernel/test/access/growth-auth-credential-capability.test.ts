import { createCredentialCapability } from '../../src/access/auth-credential-capability.ts';
import { createWorkflowApprovals } from '../../src/access/workflow-approvals.ts';
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
  service = await createAuthService({
    database: authPool,
    issuer,
    audience: 'https://operator.api.test',
    secret: 'operator-session-persistent-secret-at-least-32-bytes',
    signing: {
      activeKid: 'operator-key',
      privateKeys: [{ ...(await exportJWK(pair.privateKey)), kid: 'operator-key' }],
    },
    trustedAccess: createAuthBindings({
      pool,
      ...registration,
      async consumeAuthAuthorization(input) {
        result = await capability.consumeAuthAuthorization({ ...pending, human: input.human });
        // Stop before the legacy Auth mutation: these tests prove kernel checks only.
        throw new Error('kernel-test-complete');
      },
    }),
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
    const id = newId(0x9200);
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
      const approval = await approvals.approveCredential(token.access_token, binding, {
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
      try {
        await service.internal.setCredential({
          authorization: reference,
          subjectAccountId: binding.subjectAccountId,
          headers,
          credential: { kind: 'password', password },
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
import { openGrowthDatabase, checkGrowth, type GrowthDatabase } from '../support/growth.ts';
let db: GrowthDatabase;
let f: Awaited<ReturnType<typeof fixture>>;
let human: string;
let subject: string;
let headers: Headers;
beforeAll(async () => {
  db = await openGrowthDatabase();
  db.pool.options.max = 1;
  f = await fixture(db.pool, db.openPool({ max: 1 }), db.url);
  human = await f.person();
  subject = await f.automate(human);
  headers = await f.login(human);
});
afterAll(async () => db?.close());

test('credential capability growth stays fixed at 1x/8x/64x', async () => {
  const report = await checkGrowth(db, {
    name: 'credential capability',
    bounds: { rows: 'constant', statements: 'constant', blocks: 'logarithmic' },
    repetitions: 3,
    warmups: 1,
    grow: async (database, scale, previous) => {
      for (let i = previous * 4; i < scale * 4; i++) {
        const binding = f.stage(subject, human);
        const opening = await f.approve(headers, binding);
        await f.consume(opening.reference, binding, headers);
        const id = newId(routeOf(human)!);
        await database.admin.query(
          `INSERT INTO access.account(route,account_id,kind,state,transaction_id) VALUES ($1,$2,'actor','active',$2)`,
          [routeOf(id)!, id],
        );
        await database.admin.query(
          `INSERT INTO access.resource_grant(route,resource_id,subject_id,action,valid,transaction_id) VALUES ($1,$2,$2,'account:manage','(,)',$2)`,
          [routeOf(id)!, id],
        );
        await database.admin.query(
          `INSERT INTO access.workflow_approval(route,approval_id,actor_id,client_id,scopes,authn_epoch,operation_key,operation,digest,created_at,expires_at,jwt_expires_at,transaction_id) VALUES ($1,$2,$2,'old','{}',1,$2,'{}',$3,clock_timestamp()-interval '1 day',clock_timestamp()-interval '1 day'+interval '60 seconds',clock_timestamp()+interval '1 day',$2)`,
          [routeOf(id)!, id, 'a'.repeat(64)],
        );
      }
      for (const table of [
        'core.receipt',
        'access.account',
        'access.resource_grant',
        'access.operator_opening_receipt',
        'access.workflow_approval',
      ])
        await database.admin.query(`VACUUM (ANALYZE) ${table}`);
    },
    operation: async () => {
      const binding = f.stage(subject, human);
      const opening = await f.approve(headers, binding);
      const result = await f.consume(opening.reference, binding, headers);
      expect(result.authorization.operationKey).toBe(binding.operationKey);
      await expect(f.consume(opening.reference, binding, headers)).rejects.toThrow();
      const own = f.stage(human, human);
      const approved = await f.approve(headers, own);
      expect((await f.consume(approved.reference, own, headers)).authorization.operatorAccountId).toBeNull();
      await expect(f.consume(approved.reference, own, headers)).rejects.toThrow();
    },
  });
  expect(report.samples.map((s) => s.scale)).toEqual([1, 8, 64]);
  for (const sample of report.samples)
    expect(sample.cost.relations?.['access.operator_opening_receipt']?.rows).toBeGreaterThan(0);
}, 60000);
