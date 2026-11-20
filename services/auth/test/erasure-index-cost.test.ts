import { expect, test } from 'bun:test';
import { createHash, randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import type { AccessAccount } from '../src/index.ts';
import { issuer, nativeErasureFixtures, password } from './support/erasure-native.ts';

const startFixture = nativeErasureFixtures();

test('native account erasure preserves authorization, invalidation order and unrelated rows without resurrection', async () => {
  const events: string[] = [];
  let observedAccountId: string | undefined;
  const f = await startFixture({
    async openPool(url) {
      const pool = new Pool({ connectionString: url });
      pool.on('connect', (client) => {
        const query = client.query.bind(client);
        client.query = ((...args: Parameters<typeof query>) => {
          if (args[0] === 'DELETE FROM "user" WHERE id=$1' && args[1]?.[0] === observedAccountId)
            events.push('native-delete');
          return query(...args);
        }) as typeof client.query;
      });
      return pool;
    },
  });
  const { pool } = f;
  const { service, workflows } = f.host;
  const { trustedAccess, workflowPorts } = f.bindings;
  const originalQuery = pool.query.bind(pool);
  let inflight = 0;
  pool.query = ((...args: Parameters<Pool['query']>) => {
    if (typeof args.at(-1) === 'function') return originalQuery(...args);
    inflight++;
    return Promise.resolve(originalQuery(...args)).finally(() => {
      inflight--;
    });
  }) as Pool['query'];
  const drain = async () => {
    for (;;) {
      await new Promise((resolve) => setImmediate(resolve));
      if (inflight === 0) {
        await new Promise((resolve) => setImmediate(resolve));
        if (inflight === 0) return;
      }
    }
  };
  const key = await generateKeyPair('ES256', { extractable: true });
  const publicJwk = { ...(await exportJWK(key.publicKey)), kid: 'erase-key', alg: 'ES256' };
  const references = [
    ['user', 'id'],
    ['account', 'userId'],
    ['session', 'userId'],
    ['auth_consent', 'account_id'],
    ['auth_public_key', 'account_id'],
    ['auth_key_assertion', 'account_id'],
    ['auth_recovery', 'account_id'],
    ['auth_session_opening', 'subject_account_id'],
  ] as const;
  async function snapshot(owner?: string) {
    return Promise.all(
      references.map(async ([table, column]) => ({
        table,
        rows: (
          await pool.query(
            `SELECT to_jsonb(t) AS value FROM "${table}" t ${owner ? `WHERE "${column}"=$1` : ''} ORDER BY to_jsonb(t)::text`,
            owner ? [owner] : [],
          )
        ).rows.map(({ value }) => value),
      })),
    );
  }
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
  const provisioned = new Map<string, string>();
  const provisioningReference = workflowPorts.provisioningReference;
  workflowPorts.provisioningReference = async (input) => {
    const reference = await provisioningReference(input);
    provisioned.set(input.accountId, reference);
    return reference;
  };
  await service.internal.registerClient({ clientId: 'erase-external', firstParty: false, scopes: ['account:read'] });
  const subject = await f.person('erase-human');
  const peer = await f.person('retained-human');
  const automatedKey = randomUUID();
  const automatedOperation = {
    kind: 'automated' as const,
    registrationId: '',
    operatorAccountId: peer.accountId,
    handle: `erase_${automatedKey.replaceAll('-', '')}`,
    operationKey: automatedKey,
    authorization: 'approval-request',
  };
  const automatedApproval = await f.approvals.approve(
    peer.bearer,
    { operationKey: automatedKey, operation: automatedOperation },
    f.context(),
  );
  const { accountId: automatedId } = await workflows.createAutomated({
    key: automatedKey,
    handle: automatedOperation.handle,
    operatorAccountId: peer.accountId,
    authorization: automatedApproval.reference,
  });
  workflowPorts.provisioningReference = provisioningReference;
  expect(provisioned.get(subject.accountId)).toBeString();
  expect(provisioned.get(automatedId)).toBeString();
  const { cookie } = subject;
  expect((await request('/consent', { client_id: 'erase-external', scope: ['account:read'] }, cookie)).status).toBe(
    200,
  );
  const stagedKey = await service.internal.stageCredentialEffect({
    key: 'add-erasure-key',
    subjectAccountId: subject.accountId,
    headers: new Headers({ cookie }),
    credential: { kind: 'key', kid: publicJwk.kid, publicJwk },
  });
  const keyApproval = await service.internal.approveCredentialEffect({
    effectRef: stagedKey.effectRef,
    key: stagedKey.key,
    subjectAccountId: subject.accountId,
    headers: new Headers({ cookie }),
  });
  await service.internal.applyCredentialEffect({
    authorization: keyApproval.reference,
    effectRef: stagedKey.effectRef,
    key: stagedKey.key,
    subjectAccountId: subject.accountId,
    headers: new Headers({ cookie }),
  });
  const assertion = (jti: string) => {
    const now = Math.floor(Date.now() / 1000);
    return new SignJWT({
      iss: subject.accountId,
      sub: subject.accountId,
      aud: `${issuer}/token`,
      iat: now,
      exp: now + 60,
      jti,
    })
      .setProtectedHeader({ alg: 'ES256', kid: publicJwk.kid })
      .sign(key.privateKey);
  };
  expect(
    (
      await request('/signin/key', {
        account_id: subject.accountId,
        assertion: await assertion('before-erasure'),
        client_id: 'erasure-web',
        scope: ['account:read'],
      })
    ).status,
  ).toBe(200);
  expect((await request('/recovery/start', { email: subject.email })).status).toBe(200);
  const deliveryDeadline = Date.now() + 5_000;
  while (!f.deliveries.some(({ accountId }) => accountId === subject.accountId) && Date.now() < deliveryDeadline)
    await Bun.sleep(10);
  await drain();
  const recoveryToken = f.deliveries.find(({ accountId }) => accountId === subject.accountId)?.token;
  expect(recoveryToken).toBeString();
  const verification = () =>
    pool.query('SELECT value FROM verification WHERE identifier=$1', [`reset-password:${recoveryToken}`]);
  const keyReceipt = () =>
    pool.query('SELECT account_id FROM auth_effect_receipt WHERE account_id=$1 AND operation_key=$2', [
      subject.accountId,
      stagedKey.key,
    ]);
  expect((await verification()).rows).toEqual([{ value: subject.accountId }]);
  expect((await keyReceipt()).rows).toEqual([{ account_id: subject.accountId }]);
  const openingKey = randomUUID();
  const openingOperation = {
    kind: 'opening' as const,
    operatorAccountId: peer.accountId,
    subjectAccountId: automatedId,
    authorization: 'approval-request',
  };
  const openingApproval = await f.approvals.approve(
    peer.bearer,
    { operationKey: openingKey, operation: openingOperation },
    f.context(),
  );
  const { receiptId: openingReference } = await workflows.authorizeOperatorOpening({
    ...openingOperation,
    key: openingKey,
    authorization: openingApproval.reference,
  });
  const openingInput = {
    subjectAccountId: automatedId,
    authorization: openingReference,
    headers: new Headers({ cookie: peer.cookie }),
  };
  const opening = await service.internal.openAutomatedSession(openingInput);
  expect(opening.status).toBe(200);
  const automatedCookie = cookieOf(opening);
  expect((await snapshot(automatedId)).find(({ table }) => table === 'auth_session_opening')!.rows).toHaveLength(1);
  // Historical native opening rows have only a subject FK, independent of session lifetime.
  await pool.query(
    'INSERT INTO auth_session_opening (session_id,subject_account_id,acting_human_id,operator_account_id,receipt_id) VALUES ($1,$2,$3,$3,$4)',
    ['historical-session', subject.accountId, peer.accountId, 'historical-opening'],
  );
  // Many OTHER owners, each with actual native references. Compare complete retained rows below.
  await pool.query(
    `INSERT INTO "user" (id,name,"emailVerified") SELECT 'unrelated-'||i,'',false FROM generate_series(1,128) i`,
  );
  await pool.query(
    `INSERT INTO account (id,"accountId","providerId","userId",password,"updatedAt") SELECT 'credential-'||id,id,'credential',id,'unrelated-hash',now() FROM "user" WHERE id LIKE 'unrelated-%'`,
  );
  await pool.query(
    `INSERT INTO session (id,token,"userId","expiresAt","updatedAt","clientId","grantedScope","authnEpoch","authTime","authMethods") SELECT 'session-'||id,'token-'||id,id,now()+interval '1 day',now(),'erasure-web','account:read',1,1,'pwd' FROM "user" WHERE id LIKE 'unrelated-%'`,
  );
  await pool.query(
    `INSERT INTO auth_consent SELECT id,'erase-external',ARRAY['account:read'] FROM "user" WHERE id LIKE 'unrelated-%'`,
  );
  await pool.query(`INSERT INTO auth_public_key SELECT id,'key',$1::jsonb FROM "user" WHERE id LIKE 'unrelated-%'`, [
    publicJwk,
  ]);
  await pool.query(
    `INSERT INTO auth_key_assertion SELECT id,'assertion',now()+interval '1 day' FROM "user" WHERE id LIKE 'unrelated-%'`,
  );
  await pool.query(
    `INSERT INTO auth_recovery SELECT id||'-'||n,id,1,now()+interval '1 day' FROM "user" CROSS JOIN generate_series(1,4) n WHERE id LIKE 'unrelated-%'`,
  );
  await pool.query(
    `INSERT INTO auth_session_opening (session_id,subject_account_id,acting_human_id,operator_account_id,receipt_id) SELECT id||'-'||n,id,$1,$1,'receipt-'||id||'-'||n FROM "user" CROSS JOIN generate_series(1,4) n WHERE id LIKE 'unrelated-%'`,
    [peer.accountId],
  );
  const baseline = await snapshot();
  const selected = await snapshot(subject.accountId);
  expect(selected.every(({ rows }) => rows.length > 0)).toBe(true);
  observedAccountId = subject.accountId;
  const readErasureAccount = trustedAccess.readErasureAccount!;
  const active = (await trustedAccess.readAccount(subject.accountId))!;
  expect(active).toMatchObject({ accountId: subject.accountId, state: 'active' });
  await expect(service.internal.eraseAccount(subject.accountId)).rejects.toThrow('Authentication denied');
  // Probe Auth's gate even for invalid or missing Access projections of an owner with native rows.
  let projection: AccessAccount | null = active;
  trustedAccess.readErasureAccount = async () => projection;
  for (const state of ['pending', 'active', 'suspended', 'deleted'] as const) {
    for (const fenced of [false, true]) {
      if (state === 'deleted' && fenced) continue;
      projection = { ...active, state, fenced };
      await expect(service.internal.eraseAccount(subject.accountId)).rejects.toThrow('Authentication denied');
      expect(await snapshot()).toEqual(baseline);
    }
  }
  projection = null;
  await expect(service.internal.eraseAccount(subject.accountId)).rejects.toThrow('Authentication denied');
  trustedAccess.readErasureAccount = async () => {
    throw new Error('Access unavailable');
  };
  await expect(service.internal.eraseAccount(subject.accountId)).rejects.toThrow('Access unavailable');
  trustedAccess.readErasureAccount = readErasureAccount;
  expect(await snapshot()).toEqual(baseline);
  expect(events).toEqual([]);

  const beforeErasure = (await pool.query<{ at: Date }>('SELECT clock_timestamp() AS at')).rows[0]!.at;
  const readSource = trustedAccess.readAuthErasureSource!;
  const deleteAccount = workflows.deleteAccount;
  async function observeDeletion(accountId: string, oldCookie: string, erase: () => Promise<Response>) {
    const prior = (await trustedAccess.readAccount(accountId))!;
    const before = await snapshot();
    observedAccountId = accountId;
    events.length = 0;
    let observation:
      | {
          source: Awaited<ReturnType<typeof readSource>>;
          receiptId: string;
          account: AccessAccount | null;
          session: number;
          token: number;
          rows: Awaited<ReturnType<typeof snapshot>>;
        }
      | undefined;
    let deletionError: unknown;
    workflows.deleteAccount = async (input) => {
      try {
        return await deleteAccount(input);
      } catch (error) {
        deletionError = error;
        throw error;
      }
    };
    trustedAccess.readAuthErasureSource = async (input) => {
      const source = await readSource(input);
      if (input.accountId === accountId && events.length === 0) {
        events.push('access-invalidation-committed');
        // The old session fails while every native row is still present.
        observation = {
          source,
          receiptId: input.receiptId,
          account: await readErasureAccount(accountId),
          session: (await request('/session', undefined, oldCookie)).status,
          token: (await request('/token', {}, oldCookie)).status,
          rows: await snapshot(),
        };
      }
      return source;
    };
    try {
      const response = await erase();
      if (!response.ok && deletionError) throw deletionError;
      expect({ status: response.status, body: await response.json() }).toEqual({ status: 200, body: { accountId } });
    } finally {
      trustedAccess.readAuthErasureSource = readSource;
      workflows.deleteAccount = deleteAccount;
    }
    expect(observation).toMatchObject({
      source: { accountId, receiptId: observation?.receiptId, continuationId: expect.any(String) },
      account: { state: 'deleted', fenced: true, authnEpoch: prior.authnEpoch + 1 },
      session: 401,
      token: 401,
    });
    expect(observation?.rows).toEqual(before);
    // The call can stop on a held native consumer. Drive the same bounded pages as maintenance.
    const deadline = Date.now() + 15_000;
    let progress;
    do {
      progress = (
        await pool.query('SELECT user_deleted_at, pending_code, phase FROM auth_erasure WHERE account_id=$1', [
          accountId,
        ])
      ).rows[0];
      if (progress?.user_deleted_at) break;
      await workflows.redriveNativeErasure();
    } while (Date.now() < deadline);
    expect(progress).toMatchObject({ user_deleted_at: expect.any(Date) });
    expect(events).toEqual(['access-invalidation-committed', 'native-delete']);
  }
  await observeDeletion(subject.accountId, cookie, () => f.delete(subject));
  const erased = await snapshot(subject.accountId);
  expect(erased.find(({ table }) => table === 'user')!.rows).toEqual([]);
  const scheduled = await pool.query<{ due_at: Date; at: Date }>(
    'SELECT due_at, clock_timestamp() AS at FROM auth_consent_erasure WHERE account_id=$1',
    [subject.accountId],
  );
  expect(scheduled.rows).toHaveLength(1);
  expect(scheduled.rows[0]!.due_at.getTime()).toBeGreaterThanOrEqual(beforeErasure.getTime() + 310_000);
  expect(scheduled.rows[0]!.due_at.getTime()).toBeLessThanOrEqual(scheduled.rows[0]!.at.getTime() + 310_000);
  expect(erased.find(({ table }) => table === 'auth_consent')!.rows).toEqual(
    selected.find(({ table }) => table === 'auth_consent')!.rows,
  );
  expect(erased.every(({ table, rows }) => table === 'auth_consent' || rows.length === 0)).toBe(true);
  const retained = baseline.map(({ table, rows }, index) => ({
    table,
    rows:
      table === 'auth_consent'
        ? rows
        : rows.filter((row) => !selected[index]!.rows.some((target) => JSON.stringify(row) === JSON.stringify(target))),
  }));
  expect(await snapshot()).toEqual(retained);
  // Native owner attribution also removes the verification value and credential receipt.
  expect((await verification()).rows).toEqual([]);
  expect((await keyReceipt()).rows).toEqual([]);
  expect(
    (
      await pool.query('SELECT proof_hash FROM auth_recovery WHERE proof_hash=$1', [
        createHash('sha256').update(recoveryToken!).digest('hex'),
      ])
    ).rows,
  ).toEqual([]);
  expect(
    (
      await request('/signin', {
        email: subject.email,
        password,
        client_id: 'erasure-web',
        scope: ['account:read'],
      })
    ).status,
  ).toBe(401);
  expect(
    (
      await request('/signin/key', {
        account_id: subject.accountId,
        assertion: await assertion('after-erasure'),
        client_id: 'erasure-web',
        scope: ['account:read'],
      })
    ).status,
  ).toBe(401);
  const deliveredBefore = f.deliveries.length;
  expect((await request('/recovery/start', { email: subject.email })).status).toBe(200);
  await drain();
  expect(f.deliveries.length).toBe(deliveredBefore);
  expect(
    (await pool.query('SELECT proof_hash FROM auth_recovery WHERE account_id=$1', [subject.accountId])).rows,
  ).toEqual([]);
  expect(
    (
      await request('/recovery/complete', {
        account_id: subject.accountId,
        token: recoveryToken,
        new_password: password,
      })
    ).status,
  ).toBe(401);
  await expect(
    service.internal.provisionPassword({
      authorization: provisioned.get(subject.accountId)!,
      email: subject.email,
      password,
    }),
  ).rejects.toThrow('Auth binding denied');
  await expect(
    service.internal.stageCredentialEffect({
      key: 'replay-credential',
      subjectAccountId: subject.accountId,
      headers: new Headers({ cookie }),
      credential: { kind: 'password', password },
    }),
  ).rejects.toThrow('Authentication denied');
  await service.internal.eraseAccount(subject.accountId); // retry is idempotent
  expect(await snapshot()).toEqual(retained);
  expect(events).toEqual(['access-invalidation-committed', 'native-delete']);
  expect(
    (await pool.query('SELECT due_at FROM auth_consent_erasure WHERE account_id=$1', [subject.accountId])).rows,
  ).toEqual([{ due_at: scheduled.rows[0]!.due_at }]);

  const reservation = (
    await f.kernel.query<{ operator_reservation_id: string }>(
      'SELECT operator_reservation_id FROM access.account WHERE route=$1 AND account_id=$2',
      [f.routeOf(automatedId), automatedId],
    )
  ).rows[0]!;
  expect(reservation.operator_reservation_id).toBeString();
  const deletionKey = randomUUID();
  const deletion = {
    kind: 'delete' as const,
    accountId: automatedId,
    responsibility: {
      operatorAccountId: peer.accountId,
      subjectAccountId: automatedId,
      reservationId: reservation.operator_reservation_id,
    },
  };
  const approved = await f.call(
    '/account-operations/approve',
    { operationKey: deletionKey, operation: deletion },
    peer.cookie,
  );
  expect(approved.status).toBe(200);
  const { reference } = (await approved.json()) as { reference: string };
  await observeDeletion(automatedId, automatedCookie, () =>
    f.call(
      '/account-operations/execute',
      { operationKey: deletionKey, operation: deletion, reference, confirmation: automatedOperation.handle },
      peer.cookie,
    ),
  );
  await expect(
    service.internal.provisionCredentialless({ authorization: provisioned.get(automatedId)! }),
  ).rejects.toMatchObject({ status: 403 });
  await expect(service.internal.openAutomatedSession(openingInput)).rejects.toThrow('Authentication denied');
  expect((await snapshot(automatedId)).every(({ table, rows }) => table === 'auth_consent' || rows.length === 0)).toBe(
    true,
  );
  expect(await snapshot()).toEqual(
    retained.map(({ table, rows }, index) => ({
      table,
      rows: table === 'auth_consent' ? rows : rows.filter((row) => row[references[index]![1]] !== automatedId),
    })),
  );
}, 120_000);
