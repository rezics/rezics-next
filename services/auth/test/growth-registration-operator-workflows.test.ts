import { expect, spyOn, test } from 'bun:test';
import { DBOS } from '@dbos-inc/dbos-sdk';
import { randomBytes } from 'node:crypto';
import { exportJWK, generateKeyPair } from 'jose';
import { testDatabase } from '../scripts/database.ts';
import { createAuthService, type AccessAccount, type EffectAuthorization } from '../src/index.ts';
import { createAccountWorkflows, type AccountWorkflowPorts } from '../src/workflows.ts';
import { AUTH_WORKFLOW_APPLICATION } from '../src/retention.ts';
import { trustedAccessPorts } from './support/trusted-access.ts';
import {
  capture,
  checkGrowth,
  GrowthBoundError,
  openGrowthDatabase,
  seed,
  type Population,
} from '../../kernel/test/support/growth.ts';

const issuer = 'https://growth-workflows.auth.test';
const password = 'native workflow growth password';
const at = new Date('2000-01-01T00:00:00Z');
const future = new Date('2099-01-01T00:00:00Z');
const bounds = { rows: 'constant', blocks: 'logarithmic', statements: 'constant' } as const;
const repetitions = 2;

async function fixture() {
  const database = testDatabase();
  const db = await openGrowthDatabase(database.url);
  const accounts = new Map<string, AccessAccount>();
  const openings = new Map<string, EffectAuthorization>();
  const released = new Set<string>();
  let instant = Date.now() + 86400000;
  const pair = await generateKeyPair('ES256', { extractable: true });
  const key = { ...(await exportJWK(pair.privateKey)), kid: 'growth-workflows' };
  // Access is an external port here. Exercise the actual Auth host, proof lookup,
  // receipt consumption and issuance; these callbacks assert the port bindings.
  const auth = await createAuthService({
    database: db.pool,
    issuer,
    audience: 'https://growth-workflows.api.test',
    secret: 'growth-workflows-persistent-secret-at-least-32-bytes',
    signing: { activeKid: key.kid, privateKeys: [key] },
    trustedAccess: trustedAccessPorts({
      readAccount: async (id) => accounts.get(id) ?? null,
      authorizeProvisioning: async (accountId) => ({ accountId }),
      async consumeAuthorization({ authorization, subjectAccountId, human, purpose }) {
        const opening = openings.get(authorization)!;
        expect(opening.subjectAccountId).toBe(subjectAccountId);
        expect(opening.actingHumanId).toBe(human.account_id);
        expect(purpose).toBe('session');
        openings.delete(authorization);
        return opening;
      },
    }),
  });
  await auth.internal.registerClient({ clientId: 'workflow-web', firstParty: true, scopes: ['read'] });
  const ports: AccountWorkflowPorts = {
    async readAccount(accountId) {
      const account = accounts.get(accountId);
      return account
        ? { accountId, handle: null, operatorAccountId: null, state: account.state, fenced: account.fenced ?? false }
        : null;
    },
    registrationTarget: (key) => `account-${key}`,
    reserveHandle: async (input) => ({
      value: { ...input, reservationId: input.accountId, expiresAt: new Date(instant + 1800000).toISOString() },
    }),
    async createPending(input) {
      accounts.set(input.accountId, {
        accountId: input.accountId,
        kind: 'actor',
        state: 'pending',
        automated: false,
        authnEpoch: 1,
      });
      return {
        value: {
          accountId: input.accountId,
          registrationId: input.reservationId,
          expiresAt: new Date(instant + 1800000).toISOString(),
        },
      };
    },
    provisioningReference: async ({ accountId }) => accountId,
    provisioningEvidence: async ({ accountId }) => ({ accountId }),
    claimHandle: async (input) => ({ value: { accountId: input.accountId, handle: input.handle } }),
    activate: async ({ accountId }) => ({ value: { accountId } }),
    async expireRegistration({ accountId }) {
      Object.assign(accounts.get(accountId)!, { state: 'deleted', fenced: true });
      return { value: { accountId } };
    },
    async releaseExpiredRegistrationHandle({ accountId }) {
      expect(accounts.get(accountId)?.state).toBe('deleted');
      released.add(accountId);
      return { value: { accountId } };
    },
    async raiseFence() {
      throw new Error('Unexpected fence');
    },
    async authorizeOperation(reference, operation) {
      if (operation.kind !== 'opening') throw new Error('Unexpected operation');
      expect(reference).toBe(`approval:${'operationKey' in operation ? operation.operationKey : ''}`);
      return { actor: { accountId: operation.operatorAccountId } };
    },
    async authorizeOpening(_context, input) {
      expect(input.purpose).toBe('session');
      const receiptId = input.key;
      const receipt: EffectAuthorization = {
        receiptId,
        subjectAccountId: input.subjectAccountId,
        actingHumanId: input.operatorAccountId,
        operatorAccountId: input.operatorAccountId,
        purpose: 'session',
        clientId: 'workflow-web',
        scopes: ['read'],
        humanEpoch: 1,
        subjectEpoch: 1,
        expiresAt: new Date(Date.now() + 600000).toISOString(),
      };
      openings.set(receiptId, receipt);
      return { value: receipt };
    },
  };
  const workflows = createAccountWorkflows({
    database: db.pool,
    systemDatabaseUrl: database.url,
    systemDatabasePool: db.pool,
    stagingKey: randomBytes(32),
    auth,
    access: ports,
    clock: () => new Date(instant),
  });
  await workflows.start();
  return {
    db,
    auth,
    workflows,
    ports,
    accounts,
    released,
    openings,
    setClock(value: number) {
      instant = value;
    },
    getClock: () => instant,
    async close() {
      await workflows.close();
      await db.close();
      database.close();
    },
  };
}

function history(name: string): Population {
  return {
    name,
    hotPartition: 0,
    async finish(admin, { from, to }) {
      for (const table of ['oauthRefreshToken', 'oauthAccessToken'])
        await admin.query(
          `INSERT INTO "${table}" (id,token,"clientId","userId","expiresAt","createdAt",scopes)
          SELECT $1||'-'||i,$1||'-token-'||i,$1||'-'||i,$1||'-'||i,'2099-01-01','2000-01-01','["read"]'::jsonb
          FROM generate_series($2::integer,$3::integer) i`,
          [name, from, to - 1],
        );
    },
    rows({ ordinal, hot }) {
      const id = `${name}-${ordinal}`;
      const client = hot ? 'workflow-web' : id;
      // Auth tables are unpartitioned. Grow the selected client/workflow family
      // and other client/workflow families in the same physical relations.
      return {
        'public.user': [{ id, name: '', emailVerified: false }],
        'public.auth_client': [{ client_id: id, first_party: true, scopes: ['read'] }],
        'public.auth_client_coverage': [{ client_id: id, ready: true }],
        'public.auth_client_reduction': [{ client_id: id, operation_id: id, scopes: ['read'], first_party: true }],
        'public.account': [{ id, userId: id, accountId: id, providerId: 'credential', updatedAt: at }],
        'public.session': [
          {
            id,
            token: id,
            userId: id,
            clientId: client,
            updatedAt: at,
            expiresAt: ordinal % 2 ? at : future,
            grantedScope: 'read',
            authnEpoch: 1,
            authTime: 1,
            authMethods: 'pwd',
          },
        ],
        'public.auth_consent': [{ account_id: id, client_id: client, scopes: ['read'] }],
        'public.auth_public_key': [{ account_id: id, kid: id, public_jwk: { alg: 'ES256' } }],
        'public.auth_key_assertion': [{ account_id: id, jti: id, expires_at: future }],
        'public.auth_recovery': [{ proof_hash: id, account_id: id, authn_epoch: 1, expires_at: future }],
        'public.auth_session_opening': [
          {
            session_id: id,
            subject_account_id: id,
            acting_human_id: id,
            operator_account_id: id,
            receipt_id: id,
          },
        ],
        'public.auth_effect_receipt': [{ receipt_id: id, account_id: id, purpose: 'session', minimum_authn_epoch: 1 }],
        'public.auth_consent_erasure': [{ account_id: id, due_at: future }],
        'public.auth_provisioning_receipt': [
          {
            idempotency_key: id,
            account_id: id,
            digest: Buffer.alloc(32),
            owner_id: id,
            credential_id: id,
            registration_id: id,
            reservation_id: id,
            authn_epoch: 1,
            expires_at: at,
            provisioning_kind: 'credentialless',
          },
        ],
        'public.passkey': [
          {
            id,
            userId: id,
            publicKey: 'retained',
            credentialID: id,
            counter: 0,
            deviceType: 'singleDevice',
            backedUp: false,
            createdAt: at,
          },
        ],
        'public.auth_barrier_proof': [
          {
            reference: ordinal.toString(16).padStart(64, '0'),
            account_id: id,
            purpose: 'recovery',
            previous_epoch: 1,
            operation_key: id,
            digest: '0'.repeat(64),
            evidence: [],
            created_at: at,
            expires_at: new Date(at.getTime() + 60000),
          },
        ],

        'public.auth_registration_stage': [
          {
            registration_id: id,
            request_key: id,
            handle: id,
            account_id: id,
            request_digest: Buffer.alloc(32),
            expires_at: ordinal % 2 ? at : future,
            completed_at: ordinal % 2 ? at : null,
          },
        ],
        'public.auth_workflow_request': [
          {
            workflow_id: id,
            digest: Buffer.alloc(32),
            request: {
              kind: hot ? 'automated' : 'revoke',
              registrationId: id,
              operatorAccountId: hot ? 'operator' : id,
            },
          },
        ],
        'auth_dbos.workflow_status': [
          {
            workflow_uuid: id,
            status: 'SUCCESS',
            name: hot ? 'accounts.registration' : 'accounts.operation',
            application_name: hot ? AUTH_WORKFLOW_APPLICATION : 'unrelated-application',
          },
        ],
        'auth_dbos.workflow_input': [{ workflow_uuid: id, inputs: '[]' }],
        'auth_dbos.workflow_output': [{ workflow_uuid: id, output: '{}' }],
        'auth_dbos.workflow_events': [{ workflow_uuid: id, key: 'pending', value: '{}' }],
        'auth_dbos.notifications': [{ message_uuid: id, destination_uuid: id, topic: 'credential', message: '{}' }],
        'auth_dbos.operation_outputs': [
          { workflow_uuid: id, function_id: 0, function_name: 'accounts.read-registration' },
        ],
      };
    },
  };
}

type Fixture = Awaited<ReturnType<typeof fixture>>;
async function pending(f: Fixture, key: string) {
  const ref = await f.workflows.beginRegistration({ key, handle: key });
  await f.workflows.installRegistrationCredential({
    registrationId: ref.registrationId,
    email: `${key}@example.test`,
    password,
  });
  return ref;
}

test('Auth expired registration release stays within its bound as stage, request and workflow history grows', async () => {
  const f = await fixture();
  const population = history('release-history');
  let candidates: Awaited<ReturnType<typeof pending>>[] = [];
  try {
    // B=1 due registration, one credential, and a fixed number of durable steps:
    // R,S=O(1), indexed blocks O(log N); B never grows with retained history.
    await checkGrowth(f.db, {
      name: 'native Auth expired registration release',
      bounds,
      repetitions,
      async grow(db, scale, previous) {
        await seed(db, population, { from: previous * 512, to: scale * 512 });
        const start = f.getClock();
        candidates = [];
        for (let i = 0; i <= repetitions; i++) {
          const ref = await pending(f, `release-${scale}-${i}`);
          candidates.push(ref);
          f.setClock(Date.parse(ref.expiresAt) + 1);
        }
        f.setClock(start);
      },
      async operation() {
        const ref = candidates.shift()!;
        f.setClock(Date.parse(ref.expiresAt) + 1);
        await f.workflows.expireDueRegistrations();
        expect(f.released.has(ref.accountId)).toBe(true);
        expect((await f.db.admin.query('SELECT id FROM "user" WHERE id=$1', [ref.accountId])).rows).toHaveLength(0);
        expect(
          (
            await f.db.admin.query(
              'SELECT expired_at,ciphertext FROM auth_registration_stage WHERE registration_id=$1',
              [ref.registrationId],
            )
          ).rows[0],
        ).toMatchObject({ expired_at: expect.any(Date), ciphertext: null });
      },
    });
  } finally {
    await f.close();
  }
}, 600000);

test('Expired registration pages seek through equal expiry times and send both manual messages exactly once', async () => {
  const f = await fixture();
  const send = spyOn(DBOS, 'send');
  try {
    await seed(f.db, history('release-page-history'), { from: 0, to: 512 });
    const registrations = [];
    for (let i = 0; i < 67; i++)
      registrations.push(await f.workflows.beginRegistration({ key: `page-${i}`, handle: `page-${i}` }));
    // Random registration IDs must use the database's collation for both the
    // deadline anchors and the expected order within the tied deadlines.
    const orderedIds = (
      await f.db.admin.query<{ registration_id: string }>(
        'SELECT registration_id FROM auth_registration_stage WHERE registration_id=ANY($1::text[]) ORDER BY registration_id',
        [registrations.map((ref) => ref.registrationId)],
      )
    ).rows;
    const rank = new Map(orderedIds.map((row, index) => [row.registration_id, index]));
    registrations.sort((a, b) => rank.get(a.registrationId)! - rank.get(b.registrationId)!);
    const expiry = Date.parse(registrations[0]!.expiresAt);
    // Put the smallest ID last and the largest first. The other 65 deadlines
    // coincide, spanning the page boundary; timestamp precision must survive it.
    await f.db.admin.query(
      `UPDATE auth_registration_stage SET expires_at=$2::timestamptz + interval '0.000123 seconds'
       WHERE registration_id=ANY($1::text[])`,
      [registrations.map((ref) => ref.registrationId), new Date(expiry)],
    );
    await f.db.admin.query('UPDATE auth_registration_stage SET expires_at=$2 WHERE registration_id=$1', [
      registrations[0]!.registrationId,
      new Date(expiry + 1),
    ]);
    await f.db.admin.query('UPDATE auth_registration_stage SET expires_at=$2 WHERE registration_id=$1', [
      registrations.at(-1)!.registrationId,
      new Date(expiry - 1),
    ]);
    await f.db.admin.query('VACUUM (ANALYZE)');
    f.setClock(expiry + 2);
    const measured = await capture(f.db, () => f.workflows.expireDueRegistrations());
    const expected = [registrations.at(-1)!, ...registrations.slice(1, -1), registrations[0]!];
    expect(send.mock.calls).toEqual(
      expected.flatMap((ref) => [
        [ref.workflowId, 'expire', 'credential', `${ref.workflowId}:expire-credential`],
        [ref.workflowId, 'expire', 'activation', `${ref.workflowId}:expire-activation`],
      ]),
    );
    expect(f.released).toEqual(new Set(registrations.map((ref) => ref.accountId)));
    expect(
      (
        await f.db.admin.query(
          'SELECT count(*)::integer AS n FROM auth_registration_stage WHERE registration_id=ANY($1::text[]) AND expired_at IS NOT NULL',
          [registrations.map((ref) => ref.registrationId)],
        )
      ).rows,
    ).toEqual([{ n: 67 }]);
    const pages = measured.capture.plans.filter((plan) => {
      const text = JSON.stringify(plan);
      return text.includes('auth_registration_stage') && text.includes('LIMIT 64');
    });
    expect(pages).toHaveLength(2);
    for (const plan of pages) {
      const text = JSON.stringify(plan);
      expect(text).toContain('"Index Name":"auth_registration_stage_due"');
      expect(text).toContain('"Index Cond":');
      expect(text).not.toContain('"Node Type":"Sort"');
    }
    const lookups = measured.capture.plans.filter((plan) =>
      JSON.stringify(plan).includes('SELECT workflow_id FROM auth_workflow_request WHERE'),
    );
    expect(lookups).toHaveLength(67);
    for (const plan of lookups) {
      const text = JSON.stringify(plan);
      expect(text).toContain('"Index Name":"auth_workflow_request_automated_registration"');
      expect(text).toContain('"Index Cond":');
    }
  } finally {
    send.mockRestore();
    await f.close();
  }
}, 600000);

test('Expired automated registration resumes its stored request without manual expiry messages', async () => {
  const f = await fixture();
  const send = spyOn(DBOS, 'send');
  const rewind = spyOn(DBOS, 'rewindWorkflow');
  try {
    f.ports.authorizeOperation = async (reference, operation) => {
      expect(reference).toBe('approval:automated-expiry');
      expect(operation.kind).toBe('automated');
      return { actor: { accountId: 'operator' } };
    };
    f.ports.reserveResponsibility = async (input) => ({ value: { ...input, reservationId: 'operator-reservation' } });
    f.ports.recordOperatorRelation = async (input) => ({ value: { ...input, version: '1' } });
    f.ports.retireResponsibility = async (input) => ({ value: input });
    f.ports.releaseResponsibility = async (input) => ({ value: input });
    f.ports.provisioningReference = async () => {
      throw new Error('Provisioning interrupted');
    };
    await expect(
      f.workflows.createAutomated({
        key: 'automated-expiry',
        authorization: 'approval:automated-expiry',
        operatorAccountId: 'operator',
        handle: 'automated-expiry',
        credential: { email: 'automated-expiry@example.test', password },
      }),
    ).rejects.toThrow();
    const stage = (
      await f.db.admin.query<{ registration_id: string; account_id: string; expires_at: Date }>(
        'SELECT registration_id,account_id,expires_at FROM auth_registration_stage',
      )
    ).rows[0]!;
    const request = (
      await f.db.admin.query<{ workflow_id: string }>(
        "SELECT workflow_id FROM auth_workflow_request WHERE request->>'registrationId'=$1",
        [stage.registration_id],
      )
    ).rows[0]!;
    f.setClock(stage.expires_at.getTime() + 1);
    // Native expiry completes cleanup and retains the existing registration refusal.
    await expect(f.workflows.expireDueRegistrations()).rejects.toThrow();
    expect(send).not.toHaveBeenCalled();
    expect(rewind.mock.calls.map(([id]) => id)).toEqual([request.workflow_id]);
    expect(f.released.has(stage.account_id)).toBe(true);
    expect(
      (
        await f.db.admin.query('SELECT expired_at,ciphertext FROM auth_registration_stage WHERE registration_id=$1', [
          stage.registration_id,
        ])
      ).rows[0],
    ).toMatchObject({ expired_at: expect.any(Date), ciphertext: null });
  } finally {
    send.mockRestore();
    rewind.mockRestore();
    await f.close();
  }
}, 60000);

async function operatorInput(f: Fixture, key: string) {
  const human = `${key}-human`;
  const subject = `${key}-subject`;
  for (const [accountId, automated] of [
    [human, false],
    [subject, true],
  ] as const) {
    f.accounts.set(accountId, { accountId, kind: 'actor', state: 'pending', automated, authnEpoch: 1 });
    if (automated) await f.auth.internal.provisionCredentialless({ authorization: accountId });
    else
      await f.auth.internal.provisionPassword({
        authorization: accountId,
        email: `${accountId}@example.test`,
        password,
      });
    f.accounts.get(accountId)!.state = 'active';
  }
  const login = await f.auth.handler(
    new Request(`${issuer}/signin`, {
      method: 'POST',
      headers: { origin: issuer, 'content-type': 'application/json' },
      body: JSON.stringify({ account_id: human, password, client_id: 'workflow-web', scope: ['read'] }),
    }),
  );
  expect(login.status).toBe(200);
  const headers = new Headers({
    cookie: login.headers
      .getSetCookie()
      .map((cookie) => cookie.split(';')[0])
      .join('; '),
  });
  // Fixed admitted subject neighborhood: 63 old rows plus one new session.
  await f.db.admin.query(
    `INSERT INTO session
    (id,token,"userId","clientId","expiresAt","updatedAt","grantedScope","authnEpoch","authTime","authMethods")
    SELECT $1||'-old-'||i,$1||'-old-'||i,$1,'workflow-web','2000-01-01',now(),'read',1,1,'operator'
    FROM generate_series(1,63) i`,
    [subject],
  );
  return { key, authorization: `approval:${key}`, operatorAccountId: human, subjectAccountId: subject, headers };
}

test('Operator session workflows stay within their bound as stage, request and workflow history grows', async () => {
  const f = await fixture();
  const population = history('opening-history');
  let candidates: Awaited<ReturnType<typeof operatorInput>>[] = [];
  try {
    // One approval and receipt consumption, human proof reads, a fixed <=64
    // session neighborhood and one native insertion: R,S=O(1), blocks O(log N).
    // Current production openOperatorSession does not enqueue a DBOS workflow.
    const report = await checkGrowth(f.db, {
      name: 'native Auth operator session authorization and issuance',
      bounds,
      repetitions,
      async grow(db, scale, previous) {
        await seed(db, population, { from: previous * 512, to: scale * 512 });
        candidates = [];
        for (let i = 0; i <= repetitions; i++) candidates.push(await operatorInput(f, `opening-${scale}-${i}`));
      },
      async operation() {
        const input = candidates.shift()!;
        const response = await f.workflows.openOperatorSession(input);
        expect(response.status).toBe(200);
        expect(await response.json()).toMatchObject({ account_id: input.subjectAccountId, amr: ['operator'] });
        expect(f.openings.size).toBe(0);
        const sessions = await f.db.admin.query('SELECT count(*)::integer AS n FROM session WHERE "userId"=$1', [
          input.subjectAccountId,
        ]);
        expect(sessions.rows[0].n).toBe(64);
      },
    });
    for (const { cost } of report.samples) {
      expect(cost.relations['public.session']?.rows).toBeGreaterThan(0);
      expect(cost.relations['public.auth_effect_receipt']?.blocks).toBeGreaterThan(0);
      expect(cost.relations['public.auth_session_opening']?.blocks).toBeGreaterThan(0);
    }
    console.info('Operator session workflow growth:', JSON.stringify(report.samples));
  } catch (error) {
    if (error instanceof GrowthBoundError) {
      const input = await operatorInput(f, 'opening-diagnostic');
      const measured = await capture(f.db, () => f.workflows.openOperatorSession(input));
      console.info(
        'Operator session workflow growth defect:',
        JSON.stringify({ samples: error.samples, capture: measured.capture }),
      );
    }
    throw error;
  } finally {
    await f.close();
  }
}, 600000);
