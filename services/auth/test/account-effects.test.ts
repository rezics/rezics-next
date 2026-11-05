import { trustedAccessPorts } from './support/trusted-access.ts';
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { Pool, type PoolClient } from 'pg';
import { createLocalJWKSet, decodeJwt, exportJWK, generateKeyPair, jwtVerify, SignJWT } from 'jose';
import { testDatabase } from '../scripts/database.ts';
import {
  createAuthService,
  type AccessAccount,
  type AuthService,
  type AuthServiceOptions,
  type CredentialEffectAuthorization,
  type CredentialEffectBinding,
  type EffectAuthorization,
  type SessionProof,
} from '../src/index.ts';

const issuer = 'https://effects.auth.test';
const password = 'correct horse battery staple';
const accounts = new Map<string, AccessAccount>();
const deliveries = new Map<string, string>();
let pool: Pool;
let drain = async () => {};
function trackQueries(target: Pool) {
  let inflight = 0;
  const query = target.query.bind(target);
  const connect = target.connect.bind(target) as {
    (): Promise<PoolClient>;
    (...args: unknown[]): void;
  };
  const tracked = (run: () => unknown) => {
    inflight++;
    try {
      return Promise.resolve(run()).finally(() => {
        inflight--;
      });
    } catch (error) {
      inflight--;
      throw error;
    }
  };
  // node-pg Pool.query checks out through callback connect. Replacing that
  // path with a promise leaves the callback uncalled and the query pending.
  const hasCallback = (args: unknown[]) => typeof args.at(-1) === 'function';
  const trackClient = (client: PoolClient) => {
    if (Object.hasOwn(client, 'trackedQuery')) return client;
    const clientQuery = client.query.bind(client);
    Object.defineProperty(client, 'trackedQuery', { value: true });
    client.query = ((...args: unknown[]) =>
      hasCallback(args)
        ? clientQuery(...(args as [string]))
        : tracked(() => clientQuery(...(args as [string])))) as PoolClient['query'];
    return client;
  };
  target.query = ((...args: unknown[]) =>
    hasCallback(args) ? query(...(args as [string])) : tracked(() => query(...(args as [string])))) as Pool['query'];
  target.connect = ((...args: unknown[]) =>
    hasCallback(args) ? connect(...args) : connect().then(trackClient)) as Pool['connect'];
  return async function settled() {
    for (;;) {
      await new Promise((resolve) => setImmediate(resolve));
      if (inflight === 0) {
        await new Promise((resolve) => setImmediate(resolve));
        if (inflight === 0) return;
      }
    }
  };
}
let service: AuthService;
let options: AuthServiceOptions;
let fixture: ReturnType<typeof testDatabase> | undefined;
let outage = false;
let fence = false;
let sequence = 0;
let recoveryReceipt: { receiptId: string; accountId: string; minimumAuthnEpoch: number } | undefined;
const completedRecoveries = new Set<string>();
const credentialApprovals = new Map<string, { stage: CredentialEffectBinding; expiresAt: string; consumed: boolean }>();
async function recoverySnapshot() {
  return {
    credential: (await pool.query(`SELECT id,password,"updatedAt" FROM account WHERE "userId"='effects-human'`)).rows,
    witness: (await pool.query(`SELECT * FROM auth_recovery_establishment WHERE account_id='effects-human'`)).rows,
    proof: (await pool.query(`SELECT * FROM auth_recovery WHERE account_id='effects-human'`)).rows,
    effects: (
      await pool.query(`SELECT * FROM auth_effect_receipt WHERE account_id='effects-human' ORDER BY receipt_id`)
    ).rows,
    floor: accounts.get('effects-human')!.authnEpoch,
    sequence,
    clears: completedRecoveries.size,
  };
}
const credentialKey = await generateKeyPair('ES256', { extractable: true });
const publicJwk = { ...(await exportJWK(credentialKey.publicKey)), kid: 'own-key', alg: 'ES256' as const };

function actor(id: string, automated = false) {
  const account: AccessAccount = { accountId: id, kind: 'actor', state: 'active', automated, authnEpoch: 1 };
  accounts.set(id, account);
  return account;
}
function request(path: string, body?: unknown, cookie = '', target = service) {
  return target.handler(
    new Request(`${issuer}${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { origin: issuer, 'content-type': 'application/json', cookie },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
  );
}
function cookie(response: Response) {
  return response.headers
    .getSetCookie()
    .map((value) => value.split(';')[0])
    .join('; ');
}
async function login(id: string, target = service) {
  const response = await request(
    '/signin',
    { email: `${id}@example.test`, password, client_id: 'effects-web', scope: ['read', 'write'] },
    '',
    target,
  );
  expect(response.status).toBe(200);
  return cookie(response);
}
async function provision(id: string, automated = false) {
  const account = actor(id, automated);
  account.state = 'pending';
  await service.internal.provisionPassword({ authorization: id, email: `${id}@example.test`, password });
  account.state = 'active';
}
async function proof(headers: Headers): Promise<SessionProof> {
  const response = await request('/session', undefined, headers.get('cookie') ?? '');
  expect(response.status).toBe(200);
  return response.json() as Promise<SessionProof>;
}
async function authorization(subjectAccountId: string, purpose: 'session', headers: Headers, invalidates = false) {
  const human = await proof(headers);
  const subject = accounts.get(subjectAccountId)!;
  const receipt: EffectAuthorization = {
    receiptId: `effect-${++sequence}`,
    subjectAccountId,
    purpose,
    actingHumanId: human.account_id,
    operatorAccountId: subject.automated ? 'effects-human' : null,
    clientId: human.client_id,
    scopes: human.scope,
    humanEpoch: human.authn_epoch,
    subjectEpoch: subject.authnEpoch,
    expiresAt: new Date(Date.now() + 60000).toISOString(),
  };
  await pool.query('INSERT INTO test_effect_receipt VALUES ($1,$2,$3)', [receipt.receiptId, receipt, invalidates]);
  return receipt.receiptId;
}
async function credential(
  subjectAccountId: string,
  headers: Headers,
  value: Parameters<AuthService['internal']['stageCredentialEffect']>[0]['credential'],
) {
  const key = `credential-${subjectAccountId}-${++sequence}`;
  const stage = await service.internal.stageCredentialEffect({ key, subjectAccountId, headers, credential: value });
  const approval = await service.internal.approveCredentialEffect({
    effectRef: stage.effectRef,
    key,
    subjectAccountId,
    headers,
  });
  return service.internal.applyCredentialEffect({
    authorization: approval.reference,
    effectRef: stage.effectRef,
    key,
    subjectAccountId,
    headers,
  });
}
async function assertion(id: string, overrides: Record<string, unknown> = {}, kid = 'own-key') {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({
    iss: id,
    sub: id,
    aud: `${issuer}/token`,
    iat: now,
    exp: now + 60,
    jti: `assertion-${++sequence}`,
    ...overrides,
  })
    .setProtectedHeader({ alg: 'ES256', kid })
    .sign(credentialKey.privateKey);
}
async function keySignin(id: string, jwt: string, target = service) {
  return request(
    '/signin/key',
    { account_id: id, assertion: jwt, client_id: 'effects-web', scope: ['read'] },
    '',
    target,
  );
}
async function startRecovery(email: string) {
  await pool.query('DELETE FROM auth_attempt_counter');
  const response = await request('/recovery/start', { email });
  await drain();
  return response;
}
async function issued(cookieValue: string) {
  const response = await request('/token', {}, cookieValue);
  expect(response.status).toBe(200);
  return ((await response.json()) as { access_token: string }).access_token;
}
async function kernelAccepts(token: string) {
  // Models the existing cached-JWKS/floor verifier boundary; final Goal suites
  // must bind actual Access commands and kernel verification instead of this fixture.
  const jwks = await (await request('/.well-known/jwks.json')).json();
  const { payload } = await jwtVerify(token, createLocalJWKSet(jwks), {
    issuer,
    audience: 'https://effects.api.test',
    algorithms: ['ES256'],
  });
  const account = accounts.get(payload.sub!)!;
  return !fence && account.state === 'active' && Number(payload.authn_epoch) >= account.authnEpoch;
}

beforeAll(async () => {
  fixture = testDatabase();
  pool = new Pool({ connectionString: fixture.url });
  drain = trackQueries(pool);
  await pool.query(
    'CREATE TABLE test_effect_receipt (id text PRIMARY KEY, value jsonb NOT NULL, invalidates boolean NOT NULL)',
  );
  const key = await generateKeyPair('ES256', { extractable: true });
  const signingKey = { ...(await exportJWK(key.privateKey)), kid: 'effects-signer', alg: 'ES256' };
  options = {
    database: pool,
    issuer,
    audience: 'https://effects.api.test',
    secret: 'effects-better-auth-secret-with-at-least-32-bytes',
    signing: { activeKid: signingKey.kid, privateKeys: [signingKey] },
    recoveryDelivery: {
      async deliver(input) {
        deliveries.set(input.accountId, input.token);
      },
    },
    trustedAccess: trustedAccessPorts({
      async readFencedAccount(id) {
        return (await this.readAccount(id)) ?? (await this.readRecoveryAccount!(id));
      },
      async readAccount(id) {
        if (outage) throw new Error('Access unavailable');
        const account = fence ? null : (accounts.get(id) ?? null);
        return account ? { ...account } : null;
      },
      async readRecoveryAccount(id) {
        if (outage) throw new Error('Access unavailable');
        return accounts.get(id) ?? null;
      },
      async authorizeProvisioning(id) {
        return { accountId: id };
      },
      async approveCredentialEffect({ stage }) {
        if (outage) throw new Error('Access unavailable');
        const reference = `credential-approval-${++sequence}`;
        const expiresAt = new Date(Date.now() + 60000).toISOString();
        credentialApprovals.set(reference, { stage, expiresAt, consumed: false });
        return { reference, expiresAt };
      },
      async consumeAuthorization(input) {
        if (outage) throw new Error('Access unavailable');
        if (input.purpose !== 'session') {
          const opening = credentialApprovals.get(input.authorization);
          const stage = opening?.stage;
          const subject = accounts.get(input.subjectAccountId);
          if (
            !opening ||
            opening.consumed ||
            !stage ||
            !subject ||
            stage.purpose !== input.purpose ||
            stage.operationKey !== input.operationKey ||
            stage.effectReference !== input.effectReference ||
            stage.subjectAccountId !== input.subjectAccountId ||
            stage.actingHumanId !== input.human.account_id ||
            stage.clientId !== input.human.client_id ||
            JSON.stringify(stage.scopes) !== JSON.stringify(input.human.scope)
          )
            throw new Error('Access denied');
          opening.consumed = true;
          const receipt: CredentialEffectAuthorization = {
            ...stage,
            receiptId: input.authorization,
            actingHumanId: input.human.account_id,
            operatorAccountId: subject.automated ? 'effects-human' : null,
            purpose: stage.purpose,
            clientId: input.human.client_id,
            scopes: input.human.scope,
            humanEpoch: input.human.authn_epoch,
            subjectEpoch: subject.authnEpoch,
            expiresAt: opening.expiresAt,
          };
          return receipt;
        }
        const result = await pool.query('DELETE FROM test_effect_receipt WHERE id=$1 RETURNING value, invalidates', [
          input.authorization,
        ]);
        const receipt = result.rows[0]?.value as EffectAuthorization | undefined;
        const subject = accounts.get(input.subjectAccountId);
        if (
          !receipt ||
          !subject ||
          receipt.purpose !== input.purpose ||
          receipt.subjectAccountId !== input.subjectAccountId ||
          receipt.actingHumanId !== input.human.account_id ||
          receipt.clientId !== input.human.client_id ||
          receipt.humanEpoch !== input.human.authn_epoch ||
          receipt.subjectEpoch !== subject.authnEpoch ||
          JSON.stringify(receipt.scopes) !== JSON.stringify(input.human.scope) ||
          Date.parse(receipt.expiresAt) <= Date.now() ||
          (subject.automated
            ? receipt.operatorAccountId !== 'effects-human' || input.human.account_id !== 'effects-human'
            : input.human.account_id !== subject.accountId)
        )
          throw new Error('Access denied');
        if (result.rows[0].invalidates) {
          subject.authnEpoch++;
          receipt.subjectEpoch = subject.authnEpoch;
          receipt.invalidation = {
            receiptId: `floor-${sequence}`,
            accountId: subject.accountId,
            minimumAuthnEpoch: subject.authnEpoch,
          };
        }
        return receipt;
      },
      async revalidateCredentialEffect({ stage, authorization }) {
        if (outage) throw new Error('Access unavailable');
        const opening = credentialApprovals.get(authorization);
        if (!opening || JSON.stringify(opening.stage) !== JSON.stringify(stage)) throw new Error('Access denied');
      },
      async advanceCredentialFloor({ stage, consumedOpening, expectedPreviousFloor }) {
        if (outage) throw new Error('Access unavailable');
        const subject = accounts.get(stage.subjectAccountId);
        if (!subject || subject.authnEpoch !== expectedPreviousFloor) throw new Error('Access denied');
        subject.authnEpoch++;
        return {
          receiptId: `credential-floor-${++sequence}`,
          accountId: stage.subjectAccountId,
          minimumAuthnEpoch: subject.authnEpoch,
          operationKey: stage.operationKey,
          effectReference: stage.effectReference,
          effectDigest: stage.effectDigest,
          purpose: stage.purpose,
          openingReceiptId: consumedOpening.receiptId,
          previousFloor: expectedPreviousFloor,
          fenced: !!subject.fenced,
        };
      },
      async invalidateAccount(input) {
        if (outage) throw new Error('Access unavailable');
        const subject = accounts.get(input.accountId)!;
        subject.authnEpoch++;
        return {
          receiptId: `floor-${++sequence}`,
          accountId: subject.accountId,
          minimumAuthnEpoch: subject.authnEpoch,
        };
      },
      async completeRecovery(reference) {
        const witness = await service.internal.resolveRecoveryEstablishment(reference);
        const current = witness && accounts.get(witness.accountId);
        if (
          outage ||
          !witness ||
          !current ||
          current.state !== 'active' ||
          current.kind !== 'actor' ||
          current.automated ||
          current.authnEpoch !== witness.authnEpoch ||
          recoveryReceipt?.receiptId !== witness.receiptId ||
          recoveryReceipt.accountId !== witness.accountId ||
          recoveryReceipt.minimumAuthnEpoch !== witness.authnEpoch
        )
          throw new Error('Invalid completion');
        if (fence) {
          expect(await options.trustedAccess.readAccount(witness.accountId)).toBeNull();
          expect(
            (
              await request('/signin', {
                email: 'effects-human@example.test',
                password,
                client_id: 'effects-web',
                scope: ['read'],
              })
            ).status,
          ).toBeGreaterThanOrEqual(400);
        }
        fence = false;
        completedRecoveries.add(reference);
      },
      async authorizeRecovery(input) {
        if (outage) throw new Error('Access unavailable');
        const account = accounts.get(input.accountId)!;
        if (input.proofEpoch !== account.authnEpoch || account.automated) throw new Error('Stale recovery');
        account.authnEpoch++;
        recoveryReceipt = {
          receiptId: `recovery-${++sequence}`,
          accountId: account.accountId,
          minimumAuthnEpoch: account.authnEpoch,
        };
        return recoveryReceipt;
      },
    }),
  };
  service = await createAuthService(options);
  await service.internal.registerClient({ clientId: 'effects-web', firstParty: true, scopes: ['read', 'write'] });
  await service.internal.registerClient({ clientId: 'effects-external', firstParty: false, scopes: ['read', 'write'] });
  await provision('effects-human');
}, 30000);
afterAll(async () => {
  await pool?.end();
  fixture?.close();
}, 30000);

test('automated opening consumes its own durable purpose-bound Access receipt before a real Better Auth session', async () => {
  actor('effects-agent', true);
  const headers = new Headers({ cookie: await login('effects-human') });
  const ref = await authorization('effects-agent', 'session', headers);
  const response = await service.internal.openAutomatedSession({
    subjectAccountId: 'effects-agent',
    authorization: ref,
    headers,
  });
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({ account_id: 'effects-agent', amr: ['operator'], authn_epoch: 1 });
  const token = await issued(cookie(response));
  expect(decodeJwt(token)).toMatchObject({ sub: 'effects-agent', amr: ['operator'] });
  expect(decodeJwt(token)).not.toHaveProperty('act');
  expect(decodeJwt(token)).not.toHaveProperty('actingHumanId');
  const rows = await pool.query('SELECT "userId" FROM session WHERE "userId"=$1', ['effects-agent']);
  expect(rows.rows).toEqual([{ userId: 'effects-agent' }]);
  expect((await pool.query('SELECT email FROM "user" WHERE id=$1', ['effects-agent'])).rows).toEqual([{ email: null }]);
  expect(
    (
      await pool.query(
        'SELECT acting_human_id, operator_account_id FROM auth_session_opening WHERE subject_account_id=$1',
        ['effects-agent'],
      )
    ).rows,
  ).toEqual([{ acting_human_id: 'effects-human', operator_account_id: 'effects-human' }]);
  await expect(
    service.internal.openAutomatedSession({ subjectAccountId: 'effects-agent', authorization: ref, headers }),
  ).rejects.toThrow();
});

test('opening denies missing forged expired wrong-subject wrong-purpose and invalid operator evidence without session effects', async () => {
  const headers = new Headers({ cookie: await login('effects-human') });
  actor('effects-other-agent', true);
  for (const mode of [
    'missing',
    'forged',
    'expired',
    'subject',
    'purpose',
    'operator',
    'inactive',
    'human',
    'organization',
    'outage',
  ]) {
    const ref = await authorization('effects-agent', 'session', headers);
    if (mode === 'expired')
      await pool.query(
        "UPDATE test_effect_receipt SET value=jsonb_set(value,'{expiresAt}',to_jsonb('2000-01-01T00:00:00Z'::text)) WHERE id=$1",
        [ref],
      );
    if (mode === 'purpose')
      await pool.query(
        "UPDATE test_effect_receipt SET value=jsonb_set(value,'{purpose}',to_jsonb('add-key'::text)) WHERE id=$1",
        [ref],
      );
    if (mode === 'operator')
      await pool.query(
        "UPDATE test_effect_receipt SET value=jsonb_set(value,'{operatorAccountId}',to_jsonb('other'::text)) WHERE id=$1",
        [ref],
      );
    if (mode === 'inactive') accounts.get('effects-agent')!.state = 'suspended';
    if (mode === 'outage') outage = true;
    if (mode === 'organization')
      accounts.set('effects-org', {
        ...accounts.get('effects-agent')!,
        accountId: 'effects-org',
        kind: 'organization',
      });
    const before = (await pool.query('SELECT count(*) FROM session')).rows;
    await expect(
      service.internal.openAutomatedSession({
        subjectAccountId:
          mode === 'subject'
            ? 'effects-other-agent'
            : mode === 'human'
              ? 'effects-human'
              : mode === 'organization'
                ? 'effects-org'
                : 'effects-agent',
        authorization: mode === 'missing' ? '' : mode === 'forged' ? 'forged' : ref,
        headers,
      }),
    ).rejects.toThrow();
    expect((await pool.query('SELECT count(*) FROM session')).rows).toEqual(before);
    outage = false;
    accounts.get('effects-agent')!.state = 'active';
  }
});

test('own public keys authenticate people and automation through native sessions and durable concurrent replay protection', async () => {
  for (const id of ['effects-human', 'effects-agent']) {
    let headers = new Headers({ cookie: await login('effects-human') });
    await credential(id, headers, { kind: 'key', publicJwk, kid: 'own-key' });
    const signed = await assertion(id);
    const response = await keySignin(id, signed);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ account_id: id, amr: ['private_key_jwt'] });
    expect(decodeJwt(await issued(cookie(response))).sub).toBe(id);
    const reloaded = await createAuthService(options);
    expect((await keySignin(id, signed, reloaded)).status).toBeGreaterThanOrEqual(400);
    const concurrent = await assertion(id);
    const results = await Promise.all([keySignin(id, concurrent), keySignin(id, concurrent, reloaded)]);
    expect(results.filter((result) => result.status === 200)).toHaveLength(1);
    expect(
      (await pool.query('SELECT public_jwk FROM auth_public_key WHERE account_id=$1', [id])).rows[0].public_jwk,
    ).not.toHaveProperty('d');
    headers = new Headers({ cookie: await login('effects-human') });
    await expect(
      credential(id, headers, { kind: 'key', publicJwk: { ...publicJwk, d: 'secret' }, kid: 'private' }),
    ).rejects.toThrow();
  }
});

test('key assertion unknown key owner audience lifetime algorithm and unsigned confusions reject', async () => {
  for (const jwt of [
    await assertion('effects-agent', {}, 'unknown'),
    await assertion('effects-human'),
    await assertion('effects-agent', { aud: issuer }),
    await assertion('effects-agent', { exp: 1 }),
    await assertion('effects-agent', { exp: Math.floor(Date.now() / 1000) + 3600 }),
    await assertion('effects-agent', { jti: '' }),
    `${Buffer.from(JSON.stringify({ alg: 'none', kid: 'own-key' })).toString('base64url')}.${Buffer.from('{}').toString('base64url')}.`,
    await new SignJWT({ iss: 'effects-agent', sub: 'effects-agent' })
      .setProtectedHeader({ alg: 'HS256', kid: 'own-key' })
      .sign(new TextEncoder().encode('forged-secret')),
  ])
    expect((await keySignin('effects-agent', jwt)).status).toBeGreaterThanOrEqual(400);
  expect(
    (
      await request('/signin/key', {
        account_id: 'effects-agent',
        assertion: await assertion('effects-agent'),
        client_id: 'effects-web',
        scope: ['read'],
        operator: true,
      })
    ).status,
  ).toBe(400);
});

test('approved credential effects toggle independent automated signin and enforce owner and organization guards', async () => {
  let headers = new Headers({ cookie: await login('effects-human') });
  await credential('effects-agent', headers, { kind: 'password', password });
  const sign = () =>
    request('/signin', { account_id: 'effects-agent', password, client_id: 'effects-web', scope: ['read'] });
  const signed = await sign();
  expect(signed.status).toBe(200);
  expect(await signed.json()).toMatchObject({ account_id: 'effects-agent', amr: ['pwd'] });
  const old = await issued(cookie(signed));
  headers = new Headers({ cookie: await login('effects-human') });
  await credential('effects-agent', headers, { kind: 'password', password: null });
  expect(await kernelAccepts(old)).toBe(false);
  expect((await sign()).status).toBeGreaterThanOrEqual(400);
  await credential('effects-agent', headers, { kind: 'key', kid: 'own-key', remove: true });
  expect((await keySignin('effects-agent', await assertion('effects-agent'))).status).toBeGreaterThanOrEqual(400);
  expect(service.internal).not.toHaveProperty('setCredential');
  await expect(credential('effects-org', headers, { kind: 'password', password })).rejects.toThrow();
  expect((await pool.query('SELECT id FROM "user" WHERE id=$1', ['effects-org'])).rows).toEqual([]);
  const noPorts = await createAuthService({
    ...options,
    trustedAccess: trustedAccessPorts({
      readFencedAccount: options.trustedAccess.readFencedAccount,
      readAccount: options.trustedAccess.readAccount,
      authorizeProvisioning: options.trustedAccess.authorizeProvisioning,
    }),
  });
  await expect(
    noPorts.internal.openAutomatedSession({ subjectAccountId: 'effects-agent', authorization: 'unused', headers }),
  ).rejects.toThrow();
});

test('native human recovery delivers short lived one-use proof and requires Access invalidation before resetting credentials', async () => {
  const old = await issued(await login('effects-human'));
  expect((await startRecovery('effects-human@example.test')).status).toBe(200);
  const token = deliveries.get('effects-human')!;
  expect(token.length).toBeGreaterThan(10);
  const response = await request('/recovery/complete', { account_id: 'effects-human', token, new_password: password });
  expect(response.status).toBe(200);
  expect(await kernelAccepts(old)).toBe(false);
  const saved = await recoverySnapshot();
  expect(
    (await request('/recovery/complete', { account_id: 'effects-human', token, new_password: password })).status,
  ).toBe(200);
  expect(await recoverySnapshot()).toEqual(saved);
  expect(saved.proof.every((row) => row.consumed_operation !== null)).toBe(true);
  expect((await login('effects-human')).length).toBeGreaterThan(0);
  expect((await startRecovery('effects-agent@example.test')).status).toBe(200);
  expect(deliveries.has('effects-agent')).toBe(false);
  const native = await pool.query('SELECT identifier FROM verification');
  expect(JSON.stringify(native.rows)).not.toContain(token);
});

test('stale expired wrong-owner recovery and Access outage cannot clear a newer floor or fence', async () => {
  await startRecovery('effects-human@example.test');
  const stale = deliveries.get('effects-human')!;
  accounts.get('effects-human')!.authnEpoch++;
  fence = true;
  const floor = accounts.get('effects-human')!.authnEpoch;
  expect(
    (await request('/recovery/complete', { account_id: 'effects-human', token: stale, new_password: password })).status,
  ).toBeGreaterThanOrEqual(400);
  expect(accounts.get('effects-human')!.authnEpoch).toBe(floor);
  expect(fence).toBe(true);
  await startRecovery('effects-human@example.test');
  const fresh = deliveries.get('effects-human')!;
  outage = true;
  expect(
    (await request('/recovery/complete', { account_id: 'effects-human', token: fresh, new_password: password })).status,
  ).toBeGreaterThanOrEqual(400);
  outage = false;
  expect(accounts.get('effects-human')!.authnEpoch).toBe(floor);
  expect(fence).toBe(true);
  await startRecovery('effects-human@example.test');
  const expired = deliveries.get('effects-human')!;
  await pool.query('UPDATE auth_recovery SET expires_at=$1', [new Date(0)]);
  expect(
    (await request('/recovery/complete', { account_id: 'effects-human', token: expired, new_password: password }))
      .status,
  ).toBeGreaterThanOrEqual(400);
  await startRecovery('effects-human@example.test');
  const current = deliveries.get('effects-human')!;
  expect(
    (await request('/recovery/complete', { account_id: 'effects-agent', token: current, new_password: password }))
      .status,
  ).toBeGreaterThanOrEqual(400);
  expect(
    (await request('/recovery/complete', { account_id: 'effects-human', token: current, new_password: password }))
      .status,
  ).toBe(200);
  expect(fence).toBe(false);
  expect(accounts.get('effects-human')!.authnEpoch).toBe(floor + 1);
  expect((await login('effects-human')).length).toBeGreaterThan(0);
});

test('consent reductions invalidate already-issued signed authority through Access before Auth changes and outages fail closed', async () => {
  let human = await login('effects-human');
  expect((await request('/consent', { client_id: 'effects-external', scope: ['read', 'write'] }, human)).status).toBe(
    200,
  );
  const before = accounts.get('effects-human')!.authnEpoch;
  const external = await request('/signin', {
    email: 'effects-human@example.test',
    password,
    client_id: 'effects-external',
    scope: ['write'],
  });
  expect(external.status).toBe(200);
  const old = await issued(cookie(external));
  expect(await kernelAccepts(old)).toBe(true);
  outage = true;
  expect(
    (await request('/consent', { client_id: 'effects-external', scope: ['read'] }, human)).status,
  ).toBeGreaterThanOrEqual(400);
  outage = false;
  expect(accounts.get('effects-human')!.authnEpoch).toBe(before);
  const noInvalidation = await createAuthService({
    ...options,
    trustedAccess: trustedAccessPorts({ ...options.trustedAccess, invalidateAccount: undefined }),
  });
  expect(
    (await request('/consent', { client_id: 'effects-external', scope: ['read'] }, human, noInvalidation)).status,
  ).toBeGreaterThanOrEqual(400);
  expect(await kernelAccepts(old)).toBe(true);
  expect((await request('/consent', { client_id: 'effects-external', scope: ['read'] }, human)).status).toBe(200);
  expect(await kernelAccepts(old)).toBe(false);
  expect((await request('/token', {}, cookie(external))).status).toBeGreaterThanOrEqual(400);
  expect((await pool.query('SELECT id FROM session WHERE "userId"=$1', ['effects-human'])).rows).toEqual([]);
  human = await login('effects-human');
  const after = accounts.get('effects-human')!.authnEpoch;
  expect((await request('/consent', { client_id: 'effects-external', scope: ['read', 'write'] }, human)).status).toBe(
    200,
  );
  expect(accounts.get('effects-human')!.authnEpoch).toBe(after);
});

test('registered-client shrink refuses unsupported cross-account revocation and preserves old configuration', async () => {
  const old = await issued(await login('effects-human'));
  await expect(
    service.internal.registerClient({ clientId: 'effects-web', firstParty: true, scopes: ['read'] }),
  ).rejects.toThrow();
  expect(await kernelAccepts(old)).toBe(true);
  expect((await pool.query('SELECT scopes FROM auth_client WHERE client_id=$1', ['effects-web'])).rows).toEqual([
    { scopes: ['read', 'write'] },
  ]);
});
