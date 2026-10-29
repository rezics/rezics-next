import { trustedAccessPorts } from './support/trusted-access.ts';
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { randomBytes } from 'node:crypto';
import { Pool } from 'pg';
import { exportJWK, generateKeyPair } from 'jose';
import { testDatabase } from '../scripts/database.ts';
import { createAuthService, type AuthService } from '../src/index.ts';
import { createAccountWorkflows, type AccountWorkflowPorts } from '../src/workflows.ts';

const issuer = 'https://signup.auth.test';
const hostname = new URL(issuer).hostname;
const password = `signup-turnstile-password-${randomBytes(18).toString('hex')}`;
const stagingKey = randomBytes(32);
let fixture: ReturnType<typeof testDatabase>;
let pool: Pool;
let system: Pool;
let auth: AuthService;
let workflows: ReturnType<typeof createAccountWorkflows>;
let options: Parameters<typeof createAccountWorkflows>[0];
let verifyPayload: unknown = { success: true, action: 'signup', hostname };
let verifyFailure: Error | undefined;
let verifyNeverResolves = false;
let verifyHook: (() => Promise<void>) | undefined;
let siteverifyCalls = 0;
let registrationCalls = 0;
let registrationOrder: string[] = [];
const takenHandles = new Set<string>();
const accounts = new Map<
  string,
  {
    accountId: string;
    kind: 'actor';
    state: 'pending' | 'active' | 'deleted';
    automated: false;
    authnEpoch: number;
    fenced: boolean;
  }
>();

const siteverifyFetch: typeof fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  siteverifyCalls += 1;
  expect(String(input)).toBe('https://challenges.cloudflare.com/turnstile/v0/siteverify');
  expect(init?.method).toBe('POST');
  const form = new URLSearchParams(init?.body as URLSearchParams);
  const posted = Object.fromEntries(form.entries());
  verificationForms.push(posted);
  await verifyHook?.();
  if (verifyFailure) throw verifyFailure;
  if (verifyNeverResolves) return new Promise<Response>(() => {});
  return Response.json(verifyPayload);
}) as typeof fetch;
const verificationForms: Record<string, string>[] = [];

const ports: AccountWorkflowPorts = {
  async readAccount(id) {
    const account = accounts.get(id) ?? null;
    return (
      account && {
        accountId: account.accountId,
        handle: null,
        operatorAccountId: null,
        state: account.state,
        fenced: account.fenced ?? false,
      }
    );
  },
  registrationTarget(key) {
    registrationCalls += 1;
    registrationOrder.push('registration-target');
    return `signup-account-${key}`;
  },
  async reserveHandle(input) {
    registrationCalls += 1;
    registrationOrder.push('reserve-handle');
    if (takenHandles.has(input.handle)) {
      const error = new Error('handle unavailable');
      // Native workflow ports expose the translated refusal status to Auth.
      throw Object.assign(error, { status: 403 });
    }
    return {
      value: {
        handle: input.handle,
        accountId: input.accountId,
        reservationId: `signup-reservation-${input.accountId}`,
        expiresAt: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
      },
    };
  },
  async createPending(input) {
    accounts.set(input.accountId, {
      accountId: input.accountId,
      kind: 'actor',
      state: 'pending',
      automated: false,
      authnEpoch: 1,
      fenced: false,
    });
    return {
      value: {
        accountId: input.accountId,
        registrationId: input.reservationId,
        expiresAt: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
      },
    };
  },
  async claimHandle(input) {
    return { value: { accountId: input.accountId, handle: input.handle } };
  },
  async activate(input) {
    const account = accounts.get(input.accountId);
    if (account) account.state = 'active';
    return { value: { accountId: input.accountId } };
  },
  async expireRegistration(input) {
    const account = accounts.get(input.accountId);
    if (account) {
      account.state = 'deleted';
      account.fenced = true;
    }
    return { value: { accountId: input.accountId } };
  },
  async releaseExpiredRegistrationHandle(input) {
    return { value: { accountId: input.accountId, handle: input.handle } };
  },
  async provisioningReference(input) {
    return input.accountId;
  },
  async provisioningEvidence(input) {
    return {
      accountId: input.accountId,
      registrationId: input.reservationId,
      authIdentityId: input.accountId,
      authnEpoch: 1,
    };
  },
  async raiseFence(input) {
    return {
      value: {
        accountId: input.accountId,
        receiptId: `${input.key}:receipt`,
        minimumAuthnEpoch: '2',
        kind: 'fence',
        priorOperatorAccountId: null,
      },
    };
  },
};

function resetSiteverify() {
  verifyPayload = { success: true, action: 'signup', hostname };
  verifyFailure = undefined;
  verifyNeverResolves = false;
  verifyHook = undefined;
  siteverifyCalls = 0;
  registrationCalls = 0;
  registrationOrder = [];
  verificationForms.length = 0;
}

function body(key: string, extra: Record<string, unknown> = {}) {
  return {
    key,
    handle: `handle-${key}`,
    email: `${key}@example.test`,
    password,
    turnstile_token: `token-${key}`,
    ...extra,
  };
}

function signup(value: unknown, ip = '198.51.100.17') {
  return workflows.handler(
    new Request(`${issuer}/signup`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        origin: issuer,
        'cf-connecting-ip': ip,
      },
      body: JSON.stringify(value),
    }),
  );
}

async function stageCount(key: string): Promise<number> {
  const result = await pool.query('SELECT registration_id FROM auth_registration_stage WHERE request_key=$1', [key]);
  return result.rowCount ?? 0;
}

beforeAll(async () => {
  fixture = testDatabase();
  pool = new Pool({ connectionString: fixture.url });
  await pool.query('CREATE DATABASE auth_signup_turnstile_system');
  const systemUrl = new URL(fixture.url);
  systemUrl.pathname = '/auth_signup_turnstile_system';
  system = new Pool({ connectionString: systemUrl.href });
  const signing = await generateKeyPair('ES256', { extractable: true });
  auth = await createAuthService({
    database: pool,
    issuer,
    audience: 'https://signup.api.test',
    secret: randomBytes(48).toString('hex'),
    signing: {
      activeKid: 'signup-turnstile-signer',
      privateKeys: [{ ...(await exportJWK(signing.privateKey)), kid: 'signup-turnstile-signer', alg: 'ES256' }],
    },
    trustedAccess: trustedAccessPorts({
      async readFencedAccount(id) {
        return this.readAccount(id);
      },
      readAccount: async (id) => accounts.get(id) ?? null,
      authorizeProvisioning: async (id) => ({ accountId: id }),
    }),
  });
  options = {
    database: pool,
    systemDatabaseUrl: systemUrl.href,
    stagingKey,
    turnstile: { secret: 'signup-turnstile-secret', fetch: siteverifyFetch },
    auth,
    access: ports,
  };
  workflows = createAccountWorkflows(options);
  await workflows.start();
}, 60000);

afterAll(async () => {
  await workflows?.close();
  await system?.end();
  await pool?.end();
  fixture?.close();
});

test('signup verifies the turnstile token before any registration work and posts the sanitized verification fields', async () => {
  resetSiteverify();
  const key = 'siteverify-first';
  verifyHook = async () => {
    registrationOrder.push('siteverify');
    expect(await stageCount(key)).toBe(0);
    expect(registrationCalls).toBe(0);
  };
  const response = await signup(body(key));
  expect(response.status).toBe(201);
  expect(registrationOrder[0]).toBe('siteverify');
  expect(registrationOrder).toContain('registration-target');
  expect(verificationForms).toHaveLength(1);
  expect(verificationForms[0]).toMatchObject({
    secret: 'signup-turnstile-secret',
    response: `token-${key}`,
    remoteip: '198.51.100.17',
  });
  expect(Object.keys(verificationForms[0]!).sort()).toEqual(['idempotency_key', 'remoteip', 'response', 'secret']);
  expect(verificationForms[0]!.idempotency_key).toMatch(/^[0-9a-f-]{36}$/);
}, 30000);

test('a refused or missing turnstile token answers 400 and registers nothing', async () => {
  resetSiteverify();
  const refusedKey = 'refused-token';
  verifyPayload = { success: false, 'error-codes': ['invalid-input-response'] };
  const refused = await signup(body(refusedKey));
  expect(refused.status).toBe(400);
  expect(await refused.json()).toEqual({ error: 'registration_denied' });
  expect(await stageCount(refusedKey)).toBe(0);

  for (const [key, proof] of [
    ['wrong-action-token', { success: true, action: 'login', hostname }],
    ['wrong-hostname-token', { success: true, action: 'signup', hostname: 'other.auth.test' }],
  ] as const) {
    verifyPayload = proof;
    const response = await signup(body(key));
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: 'registration_denied' });
    expect(await stageCount(key)).toBe(0);
  }

  const missingKey = 'missing-token';
  const missing = await signup(body(missingKey, { turnstile_token: undefined }));
  expect(missing.status).toBe(400);
  expect(await missing.json()).toEqual({ error: 'registration_denied' });
  expect(siteverifyCalls).toBe(3);
  expect(registrationCalls).toBe(0);
  expect(await stageCount(missingKey)).toBe(0);
});

test('siteverify unavailable answers 503 and registers nothing', async () => {
  resetSiteverify();
  const key = 'siteverify-unavailable';
  verifyFailure = new Error('network unavailable');
  const response = await signup(body(key));
  expect(response.status).toBe(503);
  expect(await response.json()).toEqual({ error: 'registration_denied' });
  expect(siteverifyCalls).toBe(1);
  expect(registrationCalls).toBe(0);
  expect(await stageCount(key)).toBe(0);
});

test('siteverify parsing is bounded and its request has a five-second deadline', async () => {
  resetSiteverify();
  const oversizedKey = 'siteverify-oversized';
  verifyPayload = 'x'.repeat(9000);
  const oversized = await signup(body(oversizedKey));
  expect(oversized.status).toBe(503);
  expect(await stageCount(oversizedKey)).toBe(0);

  resetSiteverify();
  const timeoutKey = 'siteverify-timeout';
  verifyNeverResolves = true;
  const startedAt = Date.now();
  const timedOut = await signup(body(timeoutKey));
  const elapsed = Date.now() - startedAt;
  expect(elapsed).toBeGreaterThanOrEqual(4900);
  expect(elapsed).toBeLessThan(8000);
  expect(timedOut.status).toBe(503);
  expect(registrationCalls).toBe(0);
  expect(await stageCount(timeoutKey)).toBe(0);
}, 15000);

test('a taken handle answers 409 handle_unavailable', async () => {
  resetSiteverify();
  const key = 'taken-handle';
  takenHandles.add(`handle-${key}`);
  try {
    const response = await signup(body(key));
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: 'handle_unavailable' });
  } finally {
    takenHandles.delete(`handle-${key}`);
  }
});

test('an email already in use answers 409 registration_denied without naming the field', async () => {
  resetSiteverify();
  const email = 'already-registered@example.test';
  await pool.query('INSERT INTO "user" (id,name,email,"emailVerified",image) VALUES ($1,\'\',$2,false,NULL)', [
    'signup-existing-email',
    email,
  ]);
  const response = await signup(body('duplicate-email', { email }));
  expect(response.status).toBe(409);
  const result = await response.json();
  expect(result).toEqual({ error: 'registration_denied' });
  expect(JSON.stringify(result)).not.toContain('email');
});

test('a retry with the same key and a new token returns the same account', async () => {
  resetSiteverify();
  const key = 'retry-same-account';
  const original = body(key);
  await signup(original); // The caller loses the response and retries with a fresh challenge token.
  const retry = await signup({ ...original, turnstile_token: 'fresh-retry-token' });
  expect(retry.status).toBe(201);
  expect(await retry.json()).toEqual({ accountId: `signup-account-${key}` });
  expect(verificationForms.map((form) => form.response)).toEqual([`token-${key}`, 'fresh-retry-token']);
  expect(verificationForms[0]!.idempotency_key).not.toBe(verificationForms[1]!.idempotency_key);
  expect((await pool.query('SELECT id FROM "user" WHERE id=$1', [`signup-account-${key}`])).rows).toHaveLength(1);
});

test('signup answers 503 when Turnstile configuration is absent', async () => {
  resetSiteverify();
  const configured = options.turnstile;
  delete options.turnstile;
  try {
    const response = await signup(body('no-turnstile-config'));
    expect(response.status).toBe(503);
    expect(siteverifyCalls).toBe(0);
    expect(registrationCalls).toBe(0);
    expect(await stageCount('no-turnstile-config')).toBe(0);
  } finally {
    if (configured) options.turnstile = configured;
  }
});

test('a taken handle refuses promptly after Turnstile without account effects or retained credentials', async () => {
  resetSiteverify();
  const key = 'taken-handle-without-effects';
  const input = body(key);
  takenHandles.add(input.handle);
  try {
    const startedAt = Date.now();
    const response = await signup(input);
    expect(Date.now() - startedAt).toBeLessThan(5000);
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: 'handle_unavailable' });
    expect(siteverifyCalls).toBe(1);
    expect(registrationOrder).toEqual(['registration-target', 'reserve-handle']);
    const accountId = `signup-account-${key}`;
    expect(accounts.has(accountId)).toBe(false);
    expect((await pool.query('SELECT id FROM "user" WHERE id=$1', [accountId])).rows).toHaveLength(0);
    expect((await pool.query('SELECT id FROM session WHERE "userId"=$1', [accountId])).rows).toHaveLength(0);
    const staged = (
      await pool.query(
        'SELECT ciphertext,expired_at,completed_at FROM auth_registration_stage WHERE request_key=$1',
        [key],
      )
    ).rows;
    expect(staged).toHaveLength(1);
    expect(staged[0]).toMatchObject({ ciphertext: null, completed_at: null });
    expect(staged[0].expired_at).not.toBeNull();
  } finally {
    takenHandles.delete(input.handle);
  }
});
