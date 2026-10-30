import { suspendAccount, reinstateAccount } from '../support/native-suspension-driver.ts';
import { createAuthService, type AuthService, type SessionProof } from '@rezics/auth';
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
  const capability = createOperatorSessionCapability({
    pool,
    access,
    operators,
    referenceKeys,
    accessTokenForProof: (proof) => service.internal.accessTokenForProof(proof),
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
    trustedAccess: createAuthBindings({ pool, ...registration, ...capability }),
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
    return { outcome, reference: capability.createOpeningReference(outcome.value) };
  }
  const open = (authorization: string, subjectAccountId: string, headers: Headers) =>
    service.internal.openAutomatedSession({ authorization, subjectAccountId, headers });
  return {
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
import { createPool } from '../../src/database/pool.ts';
import { Pool as AuthPool } from 'pg';
import { seal, unseal } from '../../src/tokens/seal.ts';

const url = process.env.DATABASE_URL!;
const pool = createPool(url);
const authPool = new AuthPool({ connectionString: url });
let f: Awaited<ReturnType<typeof fixture>>;
let human: string;
let subject: string;
let headers: Headers;
let failQuery: ((sql: string, client: PoolClient) => 'before' | 'after' | undefined) | undefined;
for (const target of [pool, authPool])
  target.on('connect', (client) => {
    const query = client.query.bind(client);
    client.query = ((...args: Parameters<typeof query>) => {
      const input = args[0] as string | { text: string };
      const failure = failQuery?.(typeof input === 'string' ? input : input.text, client);
      if (failure) failQuery = undefined;
      if (failure === 'before') {
        const error = new Error('injected boundary failure');
        const callback = args.at(-1);
        if (typeof callback === 'function') {
          (callback as (error: Error) => void)(error);
          return;
        }
        return Promise.reject(error);
      }
      const result = (query as (...input: unknown[]) => Promise<unknown>)(...args);
      return failure === 'after'
        ? result.then(() => {
            throw new Error('lost acknowledgement');
          })
        : result;
    }) as typeof client.query;
  });
beforeAll(async () => {
  f = await fixture(pool, authPool, url);
  human = await f.person();
  subject = await f.automate(human);
  headers = await f.login(human);
});
afterAll(async () => {
  await Promise.all([pool.end(), authPool.end()]);
});
const counts = async () =>
  (
    await authPool.query(
      `SELECT
  (SELECT count(*)::int FROM session WHERE "userId"=$1) AS sessions,
  (SELECT count(*)::int FROM auth_effect_receipt WHERE account_id=$1) AS effects,
  (SELECT count(*)::int FROM auth_session_opening WHERE subject_account_id=$1) AS openings`,
      [subject],
    )
  ).rows[0];

test('real operator opening and live human Auth proof establish exactly one native automated session and Access JWT', async () => {
  const { reference, outcome } = await f.opening(headers, human, subject);
  const before = await counts();
  const attempts = await Promise.allSettled([f.open(reference, subject, headers), f.open(reference, subject, headers)]);
  const successful = attempts.filter((a): a is PromiseFulfilledResult<Response> => a.status === 'fulfilled');
  expect(successful).toHaveLength(1);
  expect(successful[0]!.value.status).toBe(200);
  const robotHeaders = cookies(successful[0]!.value);
  const proof = await (await f.request('/session', undefined, robotHeaders)).json();
  expect(proof).toMatchObject({
    account_id: subject,
    client_id: 'operator-web',
    scope: ['account:manage'],
    amr: ['operator'],
  });
  const robot = await f.context(robotHeaders);
  expect(robot.actor.accountId).toBe(subject);
  expect(robot.actor.requestedBy).toBeNull();
  expect(await counts()).toEqual({
    sessions: before.sessions + 1,
    effects: before.effects + 1,
    openings: before.openings + 1,
  });
  const native = (
    await authPool.query('SELECT * FROM auth_session_opening WHERE receipt_id=$1', [outcome.value.receiptId])
  ).rows[0];
  expect(native).toMatchObject({ subject_account_id: subject, acting_human_id: human, operator_account_id: human });
  await expect(f.open(reference, subject, headers)).rejects.toThrow();
  await expect(f.open(reference, subject, robotHeaders)).rejects.toThrow();
  expect(await counts()).toEqual({
    sessions: before.sessions + 1,
    effects: before.effects + 1,
    openings: before.openings + 1,
  });
});

test('proof substitution, reference substitution and credential purposes preserve no-effect outcomes', async () => {
  const { reference } = await f.opening(headers, human, subject);
  const before = await counts();
  const other = await f.person();
  for (const wrongHeaders of [
    await f.login(other),
    await f.login(human, ['account:manage'], 'other-web'),
    await f.login(human, ['account:manage', 'read']),
  ])
    await expect(f.open(reference, subject, wrongHeaders)).rejects.toThrow();
  for (const wrongReference of [
    '',
    `${reference}x`,
    f.capability.createOpeningReference({
      operatorAccountId: human,
      subjectAccountId: subject,
      receiptId: newId(routeOf(human)!),
    }),
  ])
    await expect(f.open(wrongReference, subject, headers)).rejects.toThrow();
  const payload = unseal(f.referenceKeys, 'access.operator-session.v1', reference) as object;
  for (const patch of [{ subjectAccountId: other }, { operatorAccountId: other }])
    await expect(
      f.open(seal(f.referenceKeys, 'access.operator-session.v1', { ...payload, ...patch }), subject, headers),
    ).rejects.toThrow();
  const credential = await f.opening(headers, human, subject, 'credential-management');
  await expect(f.open(credential.reference, subject, headers)).rejects.toThrow();
  const proof = (await (await f.request('/session', undefined, headers)).json()) as SessionProof;
  const credentialAttempts = await Promise.allSettled(
    (['set-password', 'remove-password', 'add-key', 'remove-key'] as const).map((purpose) =>
      f.capability.consumeAuthAuthorization({
        authorization: reference,
        subjectAccountId: subject,
        purpose,
        operationKey: f.key(),
        effectReference: f.key(),
        human: proof,
      }),
    ),
  );
  expect(
    credentialAttempts.every(
      (attempt) =>
        attempt.status === 'rejected' &&
        attempt.reason instanceof Error &&
        attempt.reason.message.includes('unavailable'),
    ),
  ).toBe(true);
  // A public proof has identical JSON, but has no live Auth object capability.
  const publicProof = await (await f.request('/session', undefined, headers)).json();
  await expect(
    f.capability.consumeAuthAuthorization({
      authorization: reference,
      subjectAccountId: subject,
      purpose: 'session',
      human: publicProof,
    }),
  ).rejects.toThrow();
  expect(await counts()).toEqual(before);
  expect((await f.open(reference, subject, headers)).status).toBe(200);
});

test('current account barriers, native expiry/epochs/relation and revoked management authority deny', async () => {
  for (const [sql, restore, id] of [
    ["state='suspended'", "state='active'", human],
    ['authn_fenced=true', 'authn_fenced=false', human],
    ["state='suspended'", "state='active'", subject],
    ['authn_fenced=true', 'authn_fenced=false', subject],
    ["state='deleted'", "state='active'", subject],
  ]) {
    const opening = await f.opening(headers, human, subject);
    const before = await counts();
    if (sql === "state='suspended'") await suspendAccount(authPool, id!);
    else await authPool.query(`UPDATE access.account SET ${sql} WHERE account_id=$1`, [id]);
    try {
      await expect(f.open(opening.reference, subject, headers)).rejects.toThrow();
    } finally {
      if (sql === "state='suspended'") {
        await reinstateAccount(authPool, id!);
        if (id === human) headers = await f.login(human);
      } else await authPool.query(`UPDATE access.account SET ${restore} WHERE account_id=$1`, [id]);
    }
    expect(await counts()).toEqual(before);
  }
  human = await f.person();
  subject = await f.automate(human);
  headers = await f.login(human);
  for (const sql of [
    "expires_at=clock_timestamp()-interval '1 second'",
    'subject_epoch_floor=2',
    'operator_epoch_floor=2',
    'human_epoch_floor=2',
    "requested_by='urn:rezics:request:wrong'",
    'relation_version=relation_version+1',
  ]) {
    const opening = await f.opening(headers, human, subject);
    const before = await counts();
    await authPool.query(`UPDATE access.operator_opening_receipt SET ${sql} WHERE receipt_id=$1`, [
      opening.outcome.value.receiptId,
    ]);
    await expect(f.open(opening.reference, subject, headers)).rejects.toThrow();
    expect(await counts()).toEqual(before);
  }
  const opening = await f.opening(headers, human, subject);
  const before = await counts();
  await authPool.query("DELETE FROM access.resource_grant WHERE resource_id=$1 AND action='account:manage'", [human]);
  await expect(f.open(opening.reference, subject, headers)).rejects.toThrow();
  expect(await counts()).toEqual(before);
  await f.operators.provisionManagementDefaults({ operatorAccountId: human, key: f.key() });
  const nextOperator = await f.person();
  const held = await f.operators.reserveResponsibility({
    operatorAccountId: nextOperator,
    subjectAccountId: subject,
    key: f.key(),
  });
  await f.operators.recordOperatorRelation({
    ...held.value,
    expectedOperatorAccountId: human,
    expectedVersion: '1',
    key: f.key(),
  });
  await expect(f.open(opening.reference, subject, headers)).rejects.toThrow();
  expect(await counts()).toEqual(before);
  for (const target of ['human', 'subject']) {
    const h = await f.person();
    const s = await f.automate(h);
    const cookie = await f.login(h);
    const opening = await f.opening(cookie, h, s);
    await authPool.query('UPDATE access.account SET minimum_authn_epoch=2 WHERE account_id=$1', [
      target === 'human' ? h : s,
    ]);
    await expect(f.open(opening.reference, s, cookie)).rejects.toThrow();
    expect((await authPool.query('SELECT count(*)::int AS n FROM session WHERE "userId"=$1', [s])).rows[0].n).toBe(0);
  }
});

test('actual boundary rollback and lost committed acknowledgements never renew an opening', async () => {
  const human = await f.person();
  subject = await f.automate(human);
  const headers = await f.login(human);
  for (const boundary of [
    'access.operator_opening_receipt',
    'INSERT INTO auth_effect_receipt',
    'INSERT INTO auth_session_opening',
  ]) {
    const opening = await f.opening(headers, human, subject);
    const before = await counts();
    failQuery = (sql) => (sql.includes(boundary) ? 'before' : undefined);
    await expect(f.open(opening.reference, subject, headers)).rejects.toThrow();
    failQuery = undefined;
    expect((await counts()).sessions).toBe(before.sessions);
    if (boundary === 'access.operator_opening_receipt')
      expect((await f.open(opening.reference, subject, headers)).status).toBe(200);
    else await expect(f.open(opening.reference, subject, headers)).rejects.toThrow();
  }
  const opening = await f.opening(headers, human, subject);
  const before = await counts();
  let consumingClient: PoolClient | undefined;
  let lostConsumptionAcknowledgement = false;
  // Preparation commits a read-only clock transaction first. Lose the durable
  // consumption acknowledgement on the connection that updates the receipt.
  failQuery = (sql, client) => {
    if (sql.includes('UPDATE access.operator_opening_receipt')) consumingClient = client;
    if (client === consumingClient && sql === 'COMMIT') {
      lostConsumptionAcknowledgement = true;
      return 'after';
    }
  };
  await expect(f.open(opening.reference, subject, headers)).rejects.toThrow();
  failQuery = undefined;
  expect(lostConsumptionAcknowledgement).toBe(true);
  const native = (
    await authPool.query('SELECT consumed_at,expires_at FROM access.operator_opening_receipt WHERE receipt_id=$1', [
      opening.outcome.value.receiptId,
    ])
  ).rows[0];
  expect(native.consumed_at).not.toBeNull();
  await expect(f.open(opening.reference, subject, headers)).rejects.toThrow();
  expect(await counts()).toEqual(before);
  expect(new Date(native.expires_at).toISOString()).toBe(opening.outcome.value.expiresAt);
});
