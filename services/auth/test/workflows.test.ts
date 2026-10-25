import { afterAll, beforeAll, expect, test } from 'bun:test';
import { randomBytes } from 'node:crypto';
import { Pool } from 'pg';
import { exportJWK, generateKeyPair } from 'jose';
import { testDatabase } from '../scripts/database.ts';
import { createAuthService, type AuthService, type AccessAccount } from '../src/index.ts';
import { createAccountWorkflows, type AccountWorkflowPorts } from '../src/workflows.ts';

// Boundary evidence only: these journaled responses are not an Access policy
// implementation. workflow-handle.test.ts binds real Access handle commands.
const issuer = 'https://workflows.auth.test';
const password = `seeded-workflow-password-${randomBytes(18).toString('hex')}`;
const email = 'workflow-human@example.test';
const stagingKey = randomBytes(32);
let fixture: ReturnType<typeof testDatabase>;
let pool: Pool;
let system: Pool;
let auth: AuthService;
let workflows: ReturnType<typeof createAccountWorkflows>;
let options: Parameters<typeof createAccountWorkflows>[0];
let instant = Date.now();
let failRevoke = false;
let beforeRevoke: (() => Promise<void>) | undefined;
const accounts = new Map<string, AccessAccount>();
const calls: string[] = [];
const value = async <T>(kind: string, key: string, data: T) => {
  calls.push(kind);
  const result = await pool.query<{ value: T }>(
    'INSERT INTO test_workflow_command VALUES ($1,$2,$3) ON CONFLICT (key) DO UPDATE SET key=EXCLUDED.key RETURNING value',
    [key, kind, data],
  );
  return { value: result.rows[0]!.value, partition: 1, epoch: '1', position: '1', transactionId: key, replayed: false };
};
const ports: AccountWorkflowPorts = {
  registrationTarget: (key) => `workflow-account-${key}`,
  async reserveHandle(input) {
    return value('reserve-handle', input.key, { handle: input.handle.toLowerCase(), accountId: input.accountId, reservationId: `reservation-${input.accountId}`, expiresAt: new Date(instant + 1800000).toISOString() });
  },
  async createPending(input) {
    const result = await value('pending-account', input.key, { accountId: input.accountId, registrationId: input.reservationId, expiresAt: new Date(instant + 1800000).toISOString() });
    if (!accounts.has(input.accountId)) accounts.set(input.accountId, { accountId: input.accountId, kind: 'actor', state: 'pending', automated: false, authnEpoch: 1 });
    return result;
  },
  async claimHandle(input) { return value('claim-handle', input.key, { accountId: input.accountId, handle: input.handle }); },
  async activate(input) {
    const result = await value('activate', input.key, { accountId: input.accountId });
    accounts.get(input.accountId)!.state = 'active';
    return result;
  },
  async expireRegistration(input) {
    accounts.get(input.accountId)!.state = 'deleted';
    accounts.get(input.accountId)!.fenced = true;
    return value('expire-registration', input.key, { accountId: input.accountId });
  },
  async releaseExpiredRegistrationHandle(input) { return value('release-expired-handle', input.key, { accountId: input.accountId, handle: input.handle }); },
  async provisioningReference(input) { return input.accountId; },
  async provisioningEvidence(input) { return { accountId: input.accountId, registrationId: input.reservationId, authIdentityId: input.accountId, authnEpoch: 1 }; },
  async raiseFence(input) {
    const account = accounts.get(input.accountId)!;
    const result = await value('fence', input.key, { accountId: input.accountId, receiptId: `${input.key}:receipt`, minimumAuthnEpoch: String(account.authnEpoch + 1), kind: 'fence', priorOperatorAccountId: null });
    account.fenced = true;
    account.authnEpoch = Number(result.value.minimumAuthnEpoch);
    return result;
  },
};
function request(path: string, body: unknown) {
  return workflows.handler(new Request(`${issuer}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', origin: issuer }, body: JSON.stringify(body) }));
}
function signin(accountId: string, suppliedEmail = email) {
  return auth.handler(new Request(`${issuer}/signin`, { method: 'POST', headers: { 'content-type': 'application/json', origin: issuer }, body: JSON.stringify({ account_id: accountId, password, client_id: 'workflow-web', scope: ['read'], ...(suppliedEmail === email ? {} : {}) }) }));
}
async function restart() {
  await workflows.close();
  workflows = createAccountWorkflows(options);
  await workflows.start();
}
beforeAll(async () => {
  fixture = testDatabase();
  pool = new Pool({ connectionString: fixture.url });
  await pool.query('CREATE DATABASE auth_workflow_system');
  const systemUrl = new URL(fixture.url);
  systemUrl.pathname = '/auth_workflow_system';
  system = new Pool({ connectionString: systemUrl.href });
  await pool.query('CREATE TABLE test_workflow_command (key text PRIMARY KEY, kind text NOT NULL, value jsonb NOT NULL)');
  const signing = await generateKeyPair('ES256', { extractable: true });
  auth = await createAuthService({ database: pool, issuer, audience: 'https://workflows.api.test', secret: randomBytes(48).toString('hex'), signing: { activeKid: 'workflow-signer', privateKeys: [{ ...await exportJWK(signing.privateKey), kid: 'workflow-signer', alg: 'ES256' }] }, trustedAccess: { readAccount: async (id) => accounts.get(id) ?? null, authorizeProvisioning: async (id) => ({ accountId: id }) } });
  await auth.internal.registerClient({ clientId: 'workflow-web', firstParty: true, scopes: ['read'] });
  const effects = { ...auth.internal, async revokeSessions(id: string) { await beforeRevoke?.(); if (failRevoke) throw new Error('Injected Auth outage'); await auth.internal.revokeSessions(id); } };
  options = { database: pool, systemDatabaseUrl: systemUrl.href, stagingKey, auth: { ...auth, internal: effects }, access: ports, clock: () => new Date(instant) };
  workflows = createAccountWorkflows(options);
  await workflows.start();
}, 60000);
afterAll(async () => {
  await workflows?.close();
  await system?.end();
  await pool?.end();
  fixture?.close();
});

test('registration persists DBOS pending history and resumes same identity after both executor interruptions', async () => {
  const pending = await workflows.beginRegistration({ key: 'recover-human', handle: 'Recover_Human' });
  expect(pending).toMatchObject({ accountId: 'workflow-account-recover-human' });
  expect((await signin(pending.accountId)).status).toBeGreaterThanOrEqual(400);
  const history = await system.query('SELECT workflow_uuid, status, inputs FROM dbos.workflow_status WHERE workflow_uuid=$1', [pending.workflowId]);
  expect(history.rows).toHaveLength(1);
  expect(history.rows[0]!.status).toBe('PENDING');
  await restart();
  await workflows.installRegistrationCredential({ registrationId: pending.registrationId, email, password });
  expect((await pool.query('SELECT id FROM "user"')).rows).toEqual([{ id: pending.accountId }]);
  expect((await pool.query('SELECT "userId" FROM account')).rows).toEqual([{ userId: pending.accountId }]);
  expect((await signin(pending.accountId)).status).toBeGreaterThanOrEqual(400);
  await restart();
  const active = await workflows.activateRegistration(pending.registrationId);
  expect(active).toEqual({ accountId: pending.accountId });
  expect(await workflows.activateRegistration(pending.registrationId)).toEqual(active);
  expect((await signin(pending.accountId)).status).toBe(200);
  expect((await system.query('SELECT status FROM dbos.workflow_status WHERE workflow_uuid=$1', [pending.workflowId])).rows).toEqual([{ status: 'SUCCESS' }]);
  expect((await pool.query("SELECT kind FROM test_workflow_command WHERE kind='activate'")).rows).toHaveLength(1);
  await expect(workflows.beginRegistration({ key: 'recover-human', handle: 'different' })).rejects.toThrow();
}, 60000);

test('actual durable arguments, outputs, events, errors and logs never contain staged plaintext credentials', async () => {
  const tables = (await system.query<{ tablename: string }>("SELECT tablename FROM pg_tables WHERE schemaname='dbos'")).rows;
  let serialized = '';
  for (const { tablename } of tables) serialized += JSON.stringify((await system.query(`SELECT row_to_json(t) AS row FROM dbos."${tablename.replaceAll('"', '""')}" t`)).rows);
  expect(serialized).not.toContain(password);
  expect(serialized).not.toContain(email);
  expect(serialized).not.toContain(stagingKey.toString('hex'));
  const stages = JSON.stringify((await pool.query('SELECT * FROM auth_registration_stage')).rows);
  expect(stages).not.toContain(password);
  expect(stages).not.toContain(email);
  expect((await system.query('SELECT * FROM dbos.operation_outputs')).rows.length).toBeGreaterThan(0);
});

test('expired registration after credential and handle barrier releases failed claim and orphan credentials cannot signin', async () => {
  const pending = await workflows.beginRegistration({ key: 'expired-human', handle: 'expired-human' });
  await workflows.installRegistrationCredential({ registrationId: pending.registrationId, email: 'expired-workflow@example.test', password });
  expect(calls.indexOf('claim-handle')).toBeGreaterThan(calls.indexOf('pending-account'));
  instant += 1800001;
  await workflows.expireDueRegistrations();
  expect(accounts.get(pending.accountId)).toMatchObject({ state: 'deleted', fenced: true });
  expect((await signin(pending.accountId)).status).toBeGreaterThanOrEqual(400);
  await expect(workflows.activateRegistration(pending.registrationId)).rejects.toThrow();
  expect(calls.lastIndexOf('release-expired-handle')).toBeGreaterThan(calls.lastIndexOf('expire-registration'));
  expect((await pool.query('SELECT id FROM "user" WHERE id=$1', [pending.accountId])).rows).toEqual([]);
}, 30000);

test('revocation persists Access fence before first Auth side effect and outage recovery preserves exact receipt', async () => {
  const id = 'workflow-account-recover-human';
  const oldEpoch = accounts.get(id)!.authnEpoch;
  let observed = 0;
  beforeRevoke = async () => {
    observed++;
    expect(accounts.get(id)).toMatchObject({ fenced: true });
    expect(accounts.get(id)!.authnEpoch).toBeGreaterThan(oldEpoch);
    expect((await pool.query("SELECT value FROM test_workflow_command WHERE kind='fence'")).rows).toHaveLength(1);
  };
  failRevoke = true;
  await expect(workflows.revokeSessions({ accountId: id, key: 'revoke-human' })).rejects.toThrow();
  expect(observed).toBeGreaterThan(0);
  const fenced = { ...accounts.get(id)! };
  expect((await signin(id)).status).toBeGreaterThanOrEqual(400);
  failRevoke = false;
  await workflows.resumeOperation('revoke-human');
  expect(accounts.get(id)).toEqual(fenced);
  beforeRevoke = undefined;
}, 30000);

test('strict signup endpoint composes Auth while rejecting public account authority and raw Better Auth signup', async () => {
  expect((await request('/signup', { key: 'unsafe', handle: 'unsafe', email, password, account_id: 'chosen', kind: 'organization', authn_epoch: 100 })).status).toBe(400);
  const signup = await request('/signup', { key: 'http-human', handle: 'http-human', email: 'http-workflow@example.test', password });
  expect(signup.status).toBe(201);
  expect(await signup.json()).toEqual({ accountId: 'workflow-account-http-human' });
  const raw = await request('/api/auth/sign-up/email', { name: 'raw', email, password });
  expect(raw.status).toBe(404);
}, 30000);
