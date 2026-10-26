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
import type { Pool } from 'pg';
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
  let approvalStage: CredentialEffectBinding;
  let pending: Omit<CredentialAuthorizationInput, 'human'>;
  let result: { authorization: CredentialEffectAuthorization };
  let mode: 'approve' | 'consume' | 'revalidate' = 'consume';
  let approved: { reference: string; expiresAt: string };
  let revalidation: Omit<Parameters<typeof capability.revalidateCredentialEffect>[0], 'human'>;
  const capability = createCredentialCapability({
    pool,
    access,
    operators,
    workflowApprovals: approvals,
    referenceKeys,
    accessTokenForProof: (proof) => service.internal.accessTokenForProof(proof),
    verifyCredentialEffect: (reference, expected) => service.internal.verifyCredentialEffect(reference, expected),
  });
  const registration = createRegistrationProofBindings({ pool, referenceKeys });
  const internal = createLifecycleInternals({
    pool,
    routeKey: new Uint8Array(32).fill(32),
    provisioningEvidence: async () => null,
    recoveryEvidence: async () => null,
  });
  const pair = await generateKeyPair('ES256', { extractable: true });
  const publicJwk = { ...(await exportJWK(pair.publicKey)), alg: 'ES256', kid: 'growth-removable-key' };
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
        if (mode === 'approve')
          approved = await capability.approveCredentialEffect({ stage: approvalStage, human: input.human });
        else if (mode === 'revalidate')
          await capability.revalidateCredentialEffect({ ...revalidation, human: input.human });
        else result = await capability.consumeAuthAuthorization({ ...pending, human: input.human });
        // Stop before the legacy Auth mutation: these tests prove kernel checks only.
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
    await authPool.query('INSERT INTO auth_public_key(account_id,kid,public_jwk) VALUES ($1,$2,$3)', [
      id,
      publicJwk.kid,
      publicJwk,
    ]);
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
    async stage(subjectAccountId: string, actingHumanId: string, purpose: 'add-key' | 'remove-key', headers: Headers) {
      const kid = purpose === 'remove-key' ? publicJwk.kid : key();
      const staged = await service.internal.stageCredentialEffect({
        key: key(),
        subjectAccountId,
        headers,
        credential:
          purpose === 'remove-key'
            ? { kind: 'key', kid, remove: true }
            : { kind: 'key', kid, publicJwk: { ...publicJwk, kid } },
      });
      const binding = await service.internal.verifyCredentialEffect(staged.effectRef, {
        operationKey: staged.key,
        subjectAccountId,
        purpose,
        actingHumanId,
        clientId: 'operator-web',
        scopes: ['account:manage'],
        effectDigest: staged.digest,
      });
      expect(binding).not.toBeNull();
      return binding!;
    },
    async approve(headers: Headers, binding: CredentialEffectBinding) {
      approvalStage = structuredClone(binding);
      mode = 'approve';
      try {
        await service.internal.applyCredentialEffect({
          authorization: 'live-proof-callback',
          effectRef: binding.effectReference,
          key: binding.operationKey,
          subjectAccountId: binding.subjectAccountId,
          headers,
        });
      } catch (error) {
        if (!(error instanceof Error) || error.message !== 'kernel-test-complete') throw error;
      } finally {
        mode = 'consume';
      }
      return approved;
    },
    async revalidate(input: typeof revalidation, headers: Headers) {
      mode = 'revalidate';
      revalidation = input;
      try {
        await service.internal.applyCredentialEffect({
          authorization: input.authorization,
          effectRef: input.stage.effectReference,
          key: input.stage.operationKey,
          subjectAccountId: input.stage.subjectAccountId,
          headers,
        });
      } catch (error) {
        if (!(error instanceof Error) || error.message !== 'kernel-test-complete') throw error;
      } finally {
        mode = 'consume';
      }
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
        await service.internal.applyCredentialEffect({
          authorization: reference,
          effectRef: binding.effectReference,
          key: binding.operationKey,
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
import { openGrowthDatabase, checkGrowth, type GrowthDatabase } from '../support/growth.ts';
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

const dimensions = ['consumed-openings', 'other-approvals', 'old-auth-effects', 'unrelated-owners'] as const;
const scales = [1, 8, 64] as const;
const repetitions = 3;
const warmups = 1;
// Each run exercises two stages, approvals, consumption/refusal, revalidation
// and a floor advance. Budget each native boundary's 3 s deadline, plus seeding.
const nativeBoundariesPerRun = 12;
const growthTimeout = dimensions.length * scales.length * (warmups + repetitions + 1) * nativeBoundariesPerRun * 3000;

test(
  'credential capability growth stays fixed at 1x/8x/64x',
  async () => {
    const initial = await f.stage(subject, human, 'add-key', headers);
    const opening = await f.approve(headers, initial);
    const template = (await f.consume(opening.reference, initial, headers)).authorization.receiptId;
    // Keep every measured point read beyond the small-table planner crossover.
    const baseline = Array.from({ length: 4096 }, () => newId(routeOf(human)!));
    await db.admin.query(
      `INSERT INTO access.account(route,account_id,kind,state,transaction_id) SELECT $1,id,'actor','active',id FROM unnest($2::uuid[]) id`,
      [routeOf(human)!, baseline],
    );
    await db.admin.query(
      `INSERT INTO access.resource_grant(route,resource_id,subject_id,action,valid,transaction_id) SELECT $1,id,id,'account:manage','(,)',id FROM unnest($2::uuid[]) id`,
      [routeOf(human)!, baseline],
    );
    await db.admin.query(
      `INSERT INTO core.receipt(partition_no,principal_kind,principal_id,command_kind,idempotency_key,request_digest,epoch,position,transaction_id,response) SELECT $1,'account',id,'old',id::text,decode(repeat('0',64),'hex'),1,1,id,'{}' FROM unnest($2::uuid[]) id`,
      [routeOf(human)! >>> 4, baseline],
    );
    await db.admin.query(
      `INSERT INTO access.workflow_approval(route,approval_id,actor_id,client_id,scopes,authn_epoch,operation_key,operation,digest,created_at,expires_at,jwt_expires_at,transaction_id) SELECT $1,id,id,'old','{}',1,id::text,'{}',repeat('0',64),'2000-01-01'::timestamptz,'2000-01-01 00:01:00'::timestamptz,'2000-01-01 00:01:00'::timestamptz,id FROM unnest($2::uuid[]) id`,
      [routeOf(human)!, baseline],
    );
    await db.admin.query(
      `INSERT INTO access.credential_floor_receipt(route,account_id,opening_receipt_id,receipt_id,operation_key,effect_reference,effect_digest,purpose,previous_floor,minimum_authn_epoch,fenced,transaction_id) SELECT $1,id,id,id,id::text,id::text,repeat('0',64),'remove-key',1,2,false,id FROM unnest($2::uuid[]) id`,
      [routeOf(human)!, baseline],
    );

    async function oldEffects(database: GrowthDatabase, ids: string[]) {
      await database.admin.query(
        `INSERT INTO auth_effect_receipt
       SELECT (jsonb_populate_record(NULL::auth_effect_receipt, to_jsonb(r) ||
         jsonb_build_object('receipt_id',id::text,'operation_key',id::text,'effect_reference',id::text))).*
       FROM auth_effect_receipt r CROSS JOIN unnest($2::uuid[]) id WHERE r.effect_reference=$1`,
        [initial.effectReference, ids],
      );
    }
    await oldEffects(db, baseline);

    // Independently grow each history dimension; the selected subject, human,
    // permission neighbourhood and exact fresh opening/approval remain fixed.
    for (const dimension of dimensions) {
      const report = await checkGrowth(db, {
        name: `credential capability ${dimension}`,
        bounds: { rows: 'constant', statements: 'constant', blocks: 'logarithmic' },
        scales,
        repetitions,
        warmups,
        grow: async (database, scale, previous) => {
          const ids = Array.from({ length: (scale - previous) * 512 }, () => newId(routeOf(human)!));
          if (dimension === 'consumed-openings')
            await database.admin.query(
              `
          INSERT INTO access.operator_opening_receipt
          SELECT (jsonb_populate_record(NULL::access.operator_opening_receipt,to_jsonb(r)||jsonb_build_object('receipt_id',id))).*
          FROM access.operator_opening_receipt r CROSS JOIN unnest($4::uuid[]) id
          WHERE r.route=$1 AND r.operator_account_id=$2 AND r.receipt_id=$3`,
              [routeOf(human)!, human, template, ids],
            );
          if (dimension === 'other-approvals')
            await database.admin.query(
              `
          INSERT INTO access.workflow_approval(route,approval_id,actor_id,client_id,scopes,authn_epoch,operation_key,operation,digest,created_at,expires_at,jwt_expires_at,transaction_id)
          SELECT $1,id,id,'old','{}',1,id::text,'{}',$3,clock_timestamp()-interval '1 day',clock_timestamp()-interval '1 day'+interval '60 seconds',clock_timestamp()+interval '1 day',id FROM unnest($2::uuid[]) id`,
              [routeOf(human)!, ids, 'a'.repeat(64)],
            );
          if (dimension === 'old-auth-effects') await oldEffects(database, ids);
          if (dimension === 'unrelated-owners') {
            await database.admin.query(
              `INSERT INTO access.account(route,account_id,kind,state,transaction_id) SELECT $1,id,'actor','active',id FROM unnest($2::uuid[]) id`,
              [routeOf(human)!, ids],
            );
            await database.admin.query(
              `INSERT INTO access.resource_grant(route,resource_id,subject_id,action,valid,transaction_id) SELECT $1,id,id,'account:manage','(,)',id FROM unnest($2::uuid[]) id`,
              [routeOf(human)!, ids],
            );
          }
          for (const table of [
            'core.receipt',
            'access.account',
            'access.resource_grant',
            'access.operator_opening_receipt',
            'access.workflow_approval',
            'access.credential_floor_receipt',
            'auth_effect_receipt',
          ])
            await database.admin.query(`VACUUM (ANALYZE) ${table}`);
        },
        operation: async () => {
          const binding = await f.stage(subject, human, 'remove-key', headers);
          const approval = await f.approve(headers, binding);
          const { authorization } = await f.consume(approval.reference, binding, headers);
          expect(authorization.operationKey).toBe(binding.operationKey);
          await f.revalidate(
            { stage: binding, authorization: approval.reference, consumedOpening: authorization, replay: false },
            headers,
          );
          await expect(f.consume(approval.reference, binding, headers)).rejects.toThrow();
          const floor = await f.capability.advanceCredentialFloor({
            stage: binding,
            consumedOpening: authorization,
            expectedPreviousFloor: authorization.subjectEpoch,
            key: binding.operationKey,
            purpose: binding.purpose,
          });
          expect(floor.minimumAuthnEpoch).toBe(authorization.subjectEpoch + 1);
          await f.revalidate(
            {
              stage: binding,
              authorization: approval.reference,
              consumedOpening: authorization,
              floorReceipt: floor,
              replay: false,
            },
            headers,
          );
          const own = await f.stage(human, human, 'add-key', headers);
          const approved = await f.approve(headers, own);
          const ownOpening = (await f.consume(approved.reference, own, headers)).authorization;
          expect(ownOpening.operatorAccountId).toBeNull();
          await f.revalidate(
            { stage: own, authorization: approved.reference, consumedOpening: ownOpening, replay: false },
            headers,
          );
          await expect(f.consume(approved.reference, own, headers)).rejects.toThrow();
        },
      });
      expect(report.samples.map((s) => s.scale)).toEqual([1, 8, 64]);
      for (const sample of report.samples) {
        expect(sample.cost.relations?.['access.operator_opening_receipt']?.rows).toBeGreaterThan(0);
        expect(sample.cost.relations?.['access.credential_floor_receipt']?.rows).toBeGreaterThan(0);
      }
    }
  },
  growthTimeout,
);
