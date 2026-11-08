import { trustedAccessPorts } from './support/trusted-access.ts';
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { createHmac } from 'node:crypto';
import { exportJWK, generateKeyPair } from 'jose';
import { Pool } from 'pg';
import { testDatabase } from '../scripts/database.ts';
import { createAuthService, type AuthService, type AccessAccount, type AuthServiceOptions } from '../src/index.ts';

const issuer = 'https://completion.auth.test';
const password = 'original completion password';
const replacement = 'replacement completion password';
let fixture: ReturnType<typeof testDatabase>;
let database: Pool;
let service: AuthService;
let options: AuthServiceOptions;
let token = '';
let failCompletion = false;
let calls = 0;
let clears = 0;
let expectedFence = { accountId: 'human', receiptId: '', minimumAuthnEpoch: 7 };
let current: AccessAccount = {
  accountId: 'human',
  kind: 'actor' as const,
  state: 'pending',
  automated: false,
  authnEpoch: 7,
  fenced: false,
};
let lastReference: string | undefined;
const request = (path: string, body: unknown) =>
  service.handler(
    new Request(issuer + path, {
      method: 'POST',
      headers: { origin: issuer, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
  );
const start = async () => {
  const mailKey = createHmac('sha256', 'persistent-completion-test-secret-at-least-32-bytes')
    .update(JSON.stringify(['auth-recovery-mail-v1', 'human']))
    .digest('hex');
  await database.query('DELETE FROM auth_attempt_counter WHERE key=$1', [mailKey]);
  const previous = token;
  expect((await request('/recovery/start', { email: 'human@completion.test' })).status).toBe(200);
  const deadline = Date.now() + 5_000;
  while (token === previous && Date.now() < deadline) await Bun.sleep(10);
  expect(token).not.toBe(previous);
};
const complete = (newPassword = replacement, value = token) =>
  request('/recovery/complete', {
    account_id: 'human',
    token: value,
    new_password: newPassword,
  });
const projected = async (response: Response) => [response.status, await response.text()] as const;
const snapshot = async () => ({
  credential: (await database.query(`SELECT id,password,"updatedAt" FROM account WHERE "userId"='human'`)).rows,
  source: (await database.query(`SELECT * FROM auth_recovery WHERE account_id='human' ORDER BY proof_hash`)).rows,
  witnesses: (
    await database.query(`SELECT * FROM auth_recovery_establishment WHERE account_id='human' ORDER BY reference`)
  ).rows,
  effects: (await database.query(`SELECT * FROM auth_effect_receipt WHERE account_id='human' ORDER BY receipt_id`))
    .rows,
});

beforeAll(async () => {
  fixture = testDatabase();
  database = new Pool({ connectionString: fixture.url, max: 1, connectionTimeoutMillis: 2000 });
  const key = {
    ...(await exportJWK((await generateKeyPair('ES256', { extractable: true })).privateKey)),
    kid: 'completion',
  };
  options = {
    database,
    issuer,
    audience: 'https://api.test',
    secret: 'persistent-completion-test-secret-at-least-32-bytes',
    signing: { activeKid: key.kid, privateKeys: [key] },
    recoveryDelivery: {
      async deliver(value) {
        token = value.token;
      },
    },
    trustedAccess: trustedAccessPorts({
      async readFencedAccount(id) {
        return (await this.readAccount(id)) ?? (await this.readRecoveryAccount!(id));
      },
      async readAccount(id) {
        return id === current.accountId && !current.fenced ? current : null;
      },
      async readRecoveryAccount(id) {
        return id === current.accountId ? current : null;
      },
      async authorizeProvisioning() {
        return { accountId: current.accountId };
      },
      async authorizeRecovery(input) {
        if (input.accountId !== current.accountId || input.proofEpoch !== current.authnEpoch)
          throw new Error('Stale recovery');
        calls++;
        current.authnEpoch++;
        current.fenced = true;
        expectedFence = {
          accountId: current.accountId,
          receiptId: input.operationKey!,
          minimumAuthnEpoch: current.authnEpoch,
        };
        return expectedFence;
      },
      async completeRecovery(reference) {
        // A max=1 Auth pool makes any callback before release fail to progress.
        const witness = await service.internal.resolveRecoveryEstablishment(reference);
        if (
          !witness ||
          witness.accountId !== current.accountId ||
          witness.receiptId !== expectedFence.receiptId ||
          witness.authnEpoch !== current.authnEpoch ||
          witness.minimumAuthnEpoch !== String(expectedFence.minimumAuthnEpoch) ||
          current.state !== 'active' ||
          current.automated
        )
          throw new Error('Completion denied');
        expect(witness.expiresAt).toBeString();
        if (failCompletion) throw new Error('Completion unavailable after committed witness');
        if (current.fenced) clears++;
        current.fenced = false;
        lastReference = reference;
      },
    }),
  };
  service = await createAuthService(options);
  await service.internal.provisionPassword({ authorization: 'pending', email: 'human@completion.test', password });
  current.state = 'active';
  await service.internal.registerClient({ clientId: 'completion-client', firstParty: true, scopes: ['read'] });
}, 60000);
afterAll(async () => {
  await database?.end();
  fixture?.close();
});

test('missing completion is unavailable and invalid Auth never invokes the trusted callback', async () => {
  await start();
  const saved = await snapshot();
  const missingCompletion = { ...options.trustedAccess };
  delete missingCompletion.completeRecovery;
  service = await createAuthService({ ...options, trustedAccess: missingCompletion });
  expect(await projected(await complete())).toEqual([503, '{"error":"authentication_denied"}']);
  expect(await snapshot()).toEqual(saved);
  service = await createAuthService(options);
  expect(await projected(await complete(replacement, 'wrong token'))).toEqual([
    401,
    '{"error":"authentication_denied"}',
  ]);
  expect(await projected(await complete('short'))).toEqual([400, '{"error":"authentication_denied"}']);
  expect(calls).toBe(0);
  expect(clears).toBe(0);
});

test('cross-service failure retains committed witness and exact resume never mutates credentials or consumes proof again', async () => {
  // Keep this targeted recovery selector independent of the preceding test's setup.
  await start();
  failCompletion = true;
  expect(await projected(await complete())).toEqual([503, '{"error":"authentication_denied"}']);
  expect(current.fenced).toBe(true);
  expect(current.authnEpoch).toBe(8);
  const saved = await snapshot();
  expect(saved.witnesses).toHaveLength(1);
  expect(saved.effects).toHaveLength(1);
  expect(saved.source.every((row) => row.consumed_operation !== null)).toBe(true);
  expect((await complete('different intended password')).status).toBe(401);
  expect(
    (
      await request('/signin', {
        account_id: 'human',
        password: replacement,
        client_id: 'completion-client',
        scope: ['read'],
      })
    ).status,
  ).toBe(401);
  service = await createAuthService(options);
  failCompletion = false;
  expect(await projected(await complete())).toEqual([200, '{"success":true}']);
  expect(current.fenced).toBe(false);
  expect(current.authnEpoch).toBe(8);
  expect(calls).toBe(1);
  expect(clears).toBe(1);
  expect(lastReference).toBe(saved.witnesses[0]!.reference);
  expect(await snapshot()).toEqual(saved);
  expect(await projected(await complete())).toEqual([200, '{"success":true}']);
  expect(clears).toBe(1);
  expect(await snapshot()).toEqual(saved);
  expect(
    (
      await request('/signin', {
        account_id: 'human',
        password: replacement,
        client_id: 'completion-client',
        scope: ['read'],
      })
    ).status,
  ).toBe(200);
  current.authnEpoch++;
  expect(await projected(await complete())).toEqual([401, '{"error":"authentication_denied"}']);
  expect(clears).toBe(1);
});

test('original witness expiry denies completion without maintenance or a renewed source', async () => {
  await start();
  await database.query(`UPDATE auth_recovery SET expires_at=statement_timestamp()+interval '2 seconds'
    WHERE account_id='human' AND consumed_operation IS NULL`);
  expect((await complete()).status).toBe(200);
  const reference = lastReference!;
  const witness = (await service.internal.resolveRecoveryEstablishment(reference))!;
  expect(witness).not.toBeNull();
  await Bun.sleep(Math.max(0, Date.parse(witness.expiresAt) - Date.now() + 20));
  expect(await service.internal.resolveRecoveryEstablishment(reference)).toBeNull();
  expect((await complete()).status).toBe(401);
  expect(
    (await database.query('SELECT reference FROM auth_recovery_establishment WHERE reference=$1', [reference]))
      .rowCount,
  ).toBe(1);
});

test('native completion validation and rate-limit refusals keep their admitted status envelope', async () => {
  await database.query('DELETE FROM auth_attempt_counter');
  for (let attempt = 0; attempt < 3; attempt++)
    expect(await projected(await complete('short'))).toEqual([400, '{"error":"authentication_denied"}']);
  const limited = await request('/recovery/complete', {
    account_id: 'human',
    token,
    new_password: 'short',
  });
  expect(await projected(limited)).toEqual([429, '{"error":"authentication_denied"}']);
  expect(limited.headers.get('retry-after')).toMatch(/^\d+$/);
});
