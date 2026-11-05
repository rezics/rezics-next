import { afterAll, beforeAll, expect, test } from 'bun:test';
import { createHash, randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import type { TSchema } from 'typebox';
import { Value } from 'typebox/value';
import { bundledDigest, bundledRelease } from '@rezics/definitions/bundled';
import { createPool } from '../../src/database/pool.ts';
import { bootstrapGovernance } from '../../src/access/bootstrap-governance.ts';
import { accountAgentId, AccountAgentVerificationError } from '../../src/semantic/agents.ts';
import { ensureAccountAgent } from '../../src/semantic/account-agents.ts';
import { bootstrapRelease } from '../../src/semantic/definitions.ts';
import { createSubject } from '../../src/semantic/subject.ts';
import {
  clearPendingAgentVerification,
  completeAgentVerification,
  failAgentVerification,
  finishAgentVerification,
  mergeVerifiedAgent,
  readAgentVerificationWorkflowRequest,
  readAgentVerificationStatus,
  readLatestAgentVerificationRequest,
  recordPendingAgentVerification,
} from '../../src/access/agent-verification.ts';
import { newId } from '../../src/route/route.ts';
import { createKernel } from '../../src/http/kernel.ts';
import { actionCatalogue, IDEMPOTENCY_HEADER } from '../../src/http/request.ts';
import { EVENT_TYPES } from '../../src/events/log.ts';
import { migrate } from '../../scripts/database.ts';
import { dropTestDatabase } from '../support/drop-test-database.ts';
import { accountToken, admittedAccess, authenticateAccount } from '../support/admitted-access.ts';
import { runCommand } from '../../src/command/command.ts';
import { loadAccountIdentitySource } from '../../src/access/agent-verification-identity.ts';
import { ORIGINAL_IDENTITY_SOURCE_REQUIRED } from '../../src/access/agent-verification-identity-recovery.ts';
import { nativeMinimization, nativeStoreBlocker } from '../../src/access/erasure-native-stores.ts';
import { AccessUnavailableError } from '../../src/access/index.ts';

const sourceUrl = process.env.DATABASE_URL;
if (!sourceUrl) throw new Error('DATABASE_URL must name the migrated test database');
const accountRoute = 0x5234;
const catalogueRoute = 0x6543;
const routeKey = new Uint8Array(32).fill(31);
const tokens = { current: 1, keys: new Map([[1, new Uint8Array(32).fill(32)]]) };
const clock = () => new Date();
const links = [{ label: 'Website', url: 'https://example.test/profile' }];
const eventNames = [
  'com.rezics.access.agent-verification.requested.v1',
  'com.rezics.access.agent-verification.withdrawn.v1',
  'com.rezics.access.agent-verification.approved.v1',
  'com.rezics.access.agent-verification.rejected.v1',
  'com.rezics.access.agent-verification.failed.v1',
  'com.rezics.access.agent-verification.verified.v1',
] as const;

type Seeded = { id: string; handle: string; kind: 'actor' | 'organization'; displayName: string };
let admin: Pool;
let databaseName: string;
let databaseUrl: string;
let pool: ReturnType<typeof createPool>;
let access: ReturnType<typeof admittedAccess>;
let kernel: ReturnType<typeof createKernel>;
let staff: Seeded;
let person: Seeded;
let manager: Seeded;
let organization: Seeded;
let automated: Seeded;
let otherAccount: Seeded;
let personCatalogue: string;
let organizationCatalogue: string;

function key(): string {
  return randomUUID();
}

function tracedPool(
  source: Pool,
  observe: (
    connection: number,
    text: string,
    args: string,
    run: (query?: unknown, values?: unknown[]) => Promise<unknown>,
  ) => unknown,
): Pool {
  let nextConnection = 0;
  return new Proxy(source, {
    get(target, property) {
      if (property === 'connect')
        return async () => {
          const connection = nextConnection++;
          const client = await target.connect();
          return new Proxy(client, {
            get(current, key) {
              if (key === 'query')
                return (query: unknown, values?: unknown[]) => {
                  const text =
                    typeof query === 'string'
                      ? query
                      : typeof query === 'object' && query !== null && 'text' in query && typeof query.text === 'string'
                        ? query.text
                        : '';
                  const run = (replacement = query, replacementValues = values) =>
                    Reflect.apply(
                      current.query,
                      current,
                      replacementValues === undefined ? [replacement] : [replacement, replacementValues],
                    ) as Promise<unknown>;
                  return observe(connection, text, JSON.stringify([query, values]) ?? '', run);
                };
              const value = Reflect.get(current, key, current);
              return typeof value === 'function' ? value.bind(current) : value;
            },
          });
        };
      const value = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  }) as Pool;
}

function transactionCommands(queries: readonly string[]): string[] {
  return queries.flatMap((query) => {
    const command = query.trim().match(/^(BEGIN|COMMIT|ROLLBACK)\b/i)?.[1];
    return command ? [command.toUpperCase()] : [];
  });
}

function expectOpaqueCursor(token: string, after: readonly string[]) {
  expect(token).toMatch(/^[A-Za-z0-9_-]+$/);
  const decoded = Buffer.from(token, 'base64url').toString('utf8');
  for (const value of after) {
    expect(token).not.toContain(value);
    expect(decoded).not.toContain(value);
  }
  const serialized = JSON.stringify(after);
  expect(token).not.toContain(serialized);
  expect(decoded).not.toContain(serialized);
}

async function seedAccount(
  handle: string,
  options: { kind?: 'actor' | 'organization'; automatedBy?: string } = {},
): Promise<Seeded> {
  const id = newId(accountRoute);
  const kind = options.kind ?? 'actor';
  const displayName = handle.replaceAll('_', ' ');
  await pool.query(
    `INSERT INTO access.account
      (route, account_id, kind, handle, display_name, state, operator_account_id, transaction_id)
     VALUES ($1, $2, $3, $4, $5, 'active', $6, $2)`,
    [accountRoute, id, kind, handle, displayName, options.automatedBy ?? null],
  );
  if (kind === 'actor') {
    await pool.query(
      `INSERT INTO access.resource_grant(route, resource_id, subject_id, action, valid, transaction_id)
       VALUES ($1, $2, $2, 'account:update', '(,)', $2),
              ($1, $2, $2, 'account:read', '(,)', $2)`,
      [accountRoute, id],
    );
  }
  return { id, handle, kind, displayName };
}

async function bearer(
  account: Seeded,
  scopes = [...actionCatalogue(kernel).keys(), 'account:manage', 'gate:any'],
): Promise<string> {
  return accountToken({ accountId: account.id, clientId: 'agent-verification-test', scopes });
}

async function request(
  account: Seeded,
  subject: string,
  token: string,
  body: { statement?: string; links?: typeof links } = {},
) {
  return post(`/v1/accounts/${account.id}:requestVerification`, token, {
    subject,
    statement: body.statement ?? `I represent ${account.handle}`,
    links: body.links ?? links,
  });
}

async function get(path: string, token?: string) {
  const response = await kernel.handle(
    new Request(`https://kernel.test${path}`, {
      ...(token ? { headers: { authorization: `Bearer ${token}` } } : {}),
    }),
  );
  return { response, body: (await response.json()) as Record<string, any> };
}

async function post(path: string, token: string | undefined, body?: unknown, idempotencyKey = key()) {
  const headers: Record<string, string> = { [IDEMPOTENCY_HEADER]: JSON.stringify(idempotencyKey) };
  if (token) headers.authorization = `Bearer ${token}`;
  const init: RequestInit = { method: 'POST', headers };
  if (body !== undefined) {
    headers['content-type'] = 'application/json';
    init.body = JSON.stringify(body);
  }
  const response = await kernel.handle(new Request(`https://kernel.test${path}`, init));
  return { response, body: (await response.json()) as Record<string, any> };
}

async function catalogueSubject(type: 'schema:Person' | 'schema:Organization', label: string): Promise<string> {
  const id = newId(catalogueRoute);
  const resource = { route: catalogueRoute, id };
  await createSubject(pool, {
    actor: {
      kind: 'account',
      accountId: staff.id,
      clientId: 'fixture',
      requestedBy: null,
      scopes: ['subject:create'],
      authnEpoch: 1,
    },
    target: resource,
    idempotencyKey: key(),
    digest: createHash('sha256').update(key()).digest(),
    item: { type, labels: { en: label } },
    release: { digest: bundledDigest, release: bundledRelease },
    authorization: {
      action: 'subject:create',
      resource,
      denied: () => new Error('Fixture subject authorization denied'),
      async authorize() {
        return 'execute';
      },
    },
  });
  return id;
}

async function accountState(id: string) {
  const { rows } = await pool.query(
    `SELECT agent_verified, agent_subject_id::text, agent_verification_receipt_id::text,
            pending_agent_subject_id::text, pending_agent_receipt_id::text
     FROM access.account WHERE route=$1 AND account_id=$2`,
    [accountRoute, id],
  );
  return rows[0];
}

beforeAll(async () => {
  const source = new URL(sourceUrl!);
  admin = new Pool({ connectionString: sourceUrl, max: 1 });
  databaseName = `agent_verification_${process.pid}_${randomUUID().replaceAll('-', '')}`;
  const target = new URL(source);
  target.pathname = `/${databaseName}`;
  databaseUrl = target.toString();
  await admin.query(`CREATE DATABASE "${databaseName}"`);
  migrate(databaseUrl);
  pool = createPool(databaseUrl);
  await bootstrapRelease(pool, bundledRelease);

  const catalogueKernel = createKernel({
    pool,
    routeKey,
    tokens,
    clock,
    writeRate: {
      async spend() {
        return { allowed: true };
      },
    },
  });
  const actions = new Map(actionCatalogue(catalogueKernel));
  access = admittedAccess({ actions });
  kernel = createKernel({
    pool,
    routeKey,
    tokens,
    clock,
    access: () => access,
    writeRate: {
      async spend() {
        return { allowed: true };
      },
    },
  });
  staff = await seedAccount('verification_staff');
  person = await seedAccount('verification_person');
  manager = await seedAccount('verification_manager');
  organization = await seedAccount('verification_org', { kind: 'organization' });
  automated = await seedAccount('verification_automated', { automatedBy: staff.id });
  otherAccount = await seedAccount('verification_other');
  await pool.query(
    `INSERT INTO access.resource_grant(route, resource_id, subject_id, action, valid, transaction_id)
     VALUES ($1, $2, $3, 'account:manage', '(,)', $3)`,
    [accountRoute, organization.id, manager.id],
  );
  await bootstrapGovernance(pool, staff.id);

  for (const [account, kind] of [
    [person, 'person'],
    [organization, 'organization'],
    [automated, 'person'],
    [otherAccount, 'person'],
  ] as const)
    await ensureAccountAgent(pool, {
      account: account.id,
      kind,
      name: account.displayName,
      language: 'en',
    });

  personCatalogue = await catalogueSubject('schema:Person', 'Catalogue Person');
  organizationCatalogue = await catalogueSubject('schema:Organization', 'Catalogue Organization');
  const handleRoute = createHash('sha256').update(person.handle).digest().readUInt16BE(0);
  await pool.query(
    `INSERT INTO access.handle_claim(route, normalized_handle, account_id, state, transaction_id)
     VALUES ($1, $2, $3, 'active', $3)`,
    [handleRoute, person.handle, person.id],
  );
}, 60_000);

afterAll(async () => {
  try {
    await pool?.end();
  } finally {
    try {
      if (databaseName) await dropTestDatabase(admin, databaseName);
    } finally {
      await admin?.end();
    }
  }
}, 30_000);

test('all six verification routes are gated while the public handle identity read remains open', async () => {
  const routes = new Map<string, string>([
    ['account.request_verification', 'gate:agent_verification'],
    ['account.read_verification_request', 'gate:agent_verification'],
    ['account.withdraw_verification', 'gate:agent_verification'],
    ['verification_request.list_pending', 'gate:agent_verification'],
    ['verification_request.approve', 'gate:agent_verification'],
    ['verification_request.reject', 'gate:agent_verification'],
  ]);
  const mounted = kernel.routes.filter((route) => routes.has(String(route.hooks.detail?.operationId)));
  expect(mounted).toHaveLength(6);
  for (const route of mounted)
    expect(route.hooks.detail?.['x-exposure']).toBe(routes.get(String(route.hooks.detail?.operationId)));
  const identityRoute = kernel.routes.find(
    (route) => route.hooks.detail?.operationId === 'account.read_public_identity',
  );
  expect(identityRoute?.hooks.detail?.['x-exposure']).toBe('public');

  const personBearer = await bearer(person);
  const sampleRequest = `/v1/accounts/${person.id}:requestVerification`;
  const closed = [
    { path: sampleRequest, method: 'POST', body: { subject: personCatalogue, statement: 'I am this person', links } },
    { path: `/v1/accounts/${person.id}/verification`, method: 'GET' },
    { path: `/v1/accounts/${person.id}:withdrawVerification`, method: 'POST', body: {} },
    { path: '/v1/verification-requests?state=pending', method: 'GET' },
    { path: `/v1/verification-requests/${newId(0)}:approve`, method: 'POST', body: {} },
    { path: `/v1/verification-requests/${newId(0)}:reject`, method: 'POST', body: {} },
  ];
  for (const route of closed) {
    const anonymous = route.method === 'GET' ? await get(route.path) : await post(route.path, undefined, route.body);
    const ungranted =
      route.method === 'GET' ? await get(route.path, personBearer) : await post(route.path, personBearer, route.body);
    for (const result of [anonymous, ungranted]) {
      expect(result.response.status).toBe(403);
      expect(result.body).toMatchObject({ code: 'platform_closed' });
    }
  }
  const handle = await get(`/v1/accounts?handle=${person.handle}`);
  expect(handle.response.status).toBe(200);
  expect(handle.body.accounts[0]).toMatchObject({ id: person.id, verified: false });

  const opened = await post('/v1/platform/exposure/agent_verification:open', await bearer(staff), undefined);
  expect(opened.response.status).toBe(200);
  expect(opened.body).toMatchObject({ exposure: { group: 'agent_verification', open: true, changed: true } });
});

test('person and organization manager requests, withdrawal, pending page, rejection and approval replay', async () => {
  const personBearer = await bearer(person);
  const managerBearer = await bearer(manager);
  const staffBearer = await bearer(staff);
  const managerActor = await authenticateAccount(
    access,
    { pool, deadline: Date.now() + 10_000 },
    {
      accountId: manager.id,
      clientId: 'agent-verification-test',
      scopes: [...actionCatalogue(kernel).keys(), 'account:manage', 'gate:any'],
    },
  );
  const managerResource = { route: accountRoute, id: organization.id };
  const managerEvidence = await access.prepare!(managerActor, 'account:manage', managerResource, {
    pool,
    deadline: Date.now() + 10_000,
  });
  expect(await access.authorize(pool, managerActor, 'account:manage', managerResource, managerEvidence)).toBe(true);

  const created = await request(person, personCatalogue, personBearer);
  expect(created.body).toMatchObject({ verificationRequest: { state: 'pending' } });
  expect(created.response.status).toBe(201);
  expect(created.body.verificationRequest).toMatchObject({
    accountId: person.id,
    accountKind: 'actor',
    catalogueSubjectId: personCatalogue,
    state: 'pending',
    statement: `I represent ${person.handle}`,
    links,
  });
  const duplicate = await request(person, personCatalogue, personBearer);
  expect(duplicate.response.status).toBe(409);
  expect(duplicate.body).toMatchObject({ code: 'conflict' });
  const ownLatest = await get(`/v1/accounts/${person.id}/verification`, personBearer);
  expect(ownLatest.response.status).toBe(200);
  expect(ownLatest.body.verificationRequest.id).toBe(created.body.verificationRequest.id);
  expect(ownLatest.body.viewerActions).toEqual([
    { action: 'account:update', operations: ['account.withdraw_verification'] },
  ]);

  const withdrawn = await post(`/v1/accounts/${person.id}:withdrawVerification`, personBearer, {});
  expect(withdrawn.response.status).toBe(200);
  expect(withdrawn.body.verificationRequest.state).toBe('withdrawn');
  const organizationRequest = await request(organization, organizationCatalogue, managerBearer);
  expect(organizationRequest.body).toMatchObject({ verificationRequest: { state: 'pending' } });
  expect(organizationRequest.response.status).toBe(201);
  expect(organizationRequest.body.verificationRequest).toMatchObject({
    accountId: organization.id,
    accountKind: 'organization',
    requestedBy: manager.id,
    catalogueSubjectId: organizationCatalogue,
    state: 'pending',
  });
  const organizationLatest = await get(`/v1/accounts/${organization.id}/verification`, managerBearer);
  expect(organizationLatest.response.status).toBe(200);
  expect(organizationLatest.body.verificationRequest.id).toBe(organizationRequest.body.verificationRequest.id);
  expect(organizationLatest.body.viewerActions).toEqual([
    { action: 'account:manage', operations: ['account.withdraw_verification'] },
  ]);

  const resubmitted = await request(person, personCatalogue, personBearer);
  expect(resubmitted.response.status).toBe(201);
  const firstPage = await get('/v1/verification-requests?state=pending&limit=1', staffBearer);
  expect(firstPage.response.status).toBe(200);
  expect(firstPage.body.verificationRequests).toHaveLength(1);
  expect(firstPage.body.next).toEqual(expect.any(String));
  const after = [firstPage.body.verificationRequests[0].createdAt, firstPage.body.verificationRequests[0].id];
  expectOpaqueCursor(firstPage.body.next, after);
  const differentViewer = await get(
    `/v1/verification-requests?state=pending&limit=1&cursor=${encodeURIComponent(firstPage.body.next)}`,
    personBearer,
  );
  expect(differentViewer.response.status).toBe(400);
  expect(differentViewer.body).toMatchObject({ code: 'invalid_cursor' });
  const anonymous = await get(
    `/v1/verification-requests?state=pending&limit=1&cursor=${encodeURIComponent(firstPage.body.next)}`,
  );
  expect(anonymous.response.status).toBe(401);
  const changedLimit = await get(
    `/v1/verification-requests?state=pending&limit=2&cursor=${encodeURIComponent(firstPage.body.next)}`,
    staffBearer,
  );
  expect(changedLimit.response.status).toBe(400);
  const secondPage = await get(
    `/v1/verification-requests?state=pending&limit=1&cursor=${encodeURIComponent(firstPage.body.next)}`,
    staffBearer,
  );
  expect(secondPage.response.status).toBe(200);
  expect(secondPage.body.verificationRequests).toHaveLength(1);
  expect(new Set([firstPage.body.verificationRequests[0].id, secondPage.body.verificationRequests[0].id])).toEqual(
    new Set([organizationRequest.body.verificationRequest.id, resubmitted.body.verificationRequest.id]),
  );

  for (const action of ['approve', 'reject'] as const) {
    const denied = await post(
      `/v1/verification-requests/${organizationRequest.body.verificationRequest.id}:${action}`,
      personBearer,
      {},
    );
    expect(denied.response.status).toBe(403);
    expect(denied.body).toMatchObject({ code: 'forbidden' });
  }

  const organizationBefore = await accountState(organization.id);
  const rejected = await post(
    `/v1/verification-requests/${organizationRequest.body.verificationRequest.id}:reject`,
    staffBearer,
    { reason: 'The provided evidence did not establish this identity.' },
  );
  expect(rejected.response.status).toBe(200);
  expect(rejected.body.verificationRequest).toMatchObject({
    state: 'rejected',
    reason: 'The provided evidence did not establish this identity.',
  });
  expect(await accountState(organization.id)).toEqual(organizationBefore);

  const approvalKey = key();
  const approvePath = `/v1/verification-requests/${resubmitted.body.verificationRequest.id}:approve`;
  const approved = await post(approvePath, staffBearer, {}, approvalKey);
  const approvalReplay = await post(approvePath, staffBearer, {}, approvalKey);
  expect(approved.response.status).toBe(200);
  expect(approved.body.verificationRequest.state).toBe('approving');
  expect(approvalReplay.body).toEqual(approved.body);
  const decision = await readAgentVerificationWorkflowRequest(pool, resubmitted.body.verificationRequest.id);
  expect(decision).toMatchObject({
    state: 'approving',
    decisionReceiptId: approved.body.verificationRequest.decisionReceiptId,
  });

  const workflow = { ...decision!, receiptId: decision!.decisionReceiptId! };
  // A worker loss after the account marker commits is recovered by replaying the same durable steps.
  await recordPendingAgentVerification(pool, workflow, clock);
  expect(await accountState(person.id)).toMatchObject({
    agent_verified: false,
    pending_agent_subject_id: personCatalogue,
    pending_agent_receipt_id: workflow.receiptId,
  });
  const recovered = await readAgentVerificationWorkflowRequest(pool, workflow.id);
  await recordPendingAgentVerification(pool, { ...recovered!, receiptId: workflow.receiptId }, clock);
  await mergeVerifiedAgent(pool, workflow);
  await mergeVerifiedAgent(pool, workflow);
  await completeAgentVerification(pool, workflow, clock);
  await completeAgentVerification(pool, workflow, clock);
  await finishAgentVerification(pool, workflow, clock);
  await finishAgentVerification(pool, workflow, clock);

  expect(await accountState(person.id)).toMatchObject({
    agent_verified: true,
    agent_subject_id: personCatalogue,
    agent_verification_receipt_id: workflow.receiptId,
    pending_agent_subject_id: null,
    pending_agent_receipt_id: null,
  });
  const mergeRevision = await pool.query(
    `SELECT count(*)::integer AS count FROM semantic.revision
     WHERE subject_id=$1 AND verification_receipt_id=$2`,
    [accountAgentId(person.id), workflow.receiptId],
  );
  expect(mergeRevision.rows[0]!.count).toBe(1);
  const publicIdentity = await get(`/v1/accounts?handle=${person.handle}`);
  expect(publicIdentity.response.status).toBe(200);
  expect(publicIdentity.body.accounts[0]).toMatchObject({
    subject: { id: personCatalogue, label: 'Catalogue Person', type: 'schema:Person' },
    verified: true,
  });
});

test('A retained terminal organization verification request with an erased requester remains readable by another currently authorized manager and serializes requestedBy as null', async () => {
  const retainedOrganization = await seedAccount(`retained_org_${randomUUID().slice(0, 8)}`, {
    kind: 'organization',
  });
  const successor = await seedAccount(`successor_${randomUUID().slice(0, 8)}`);
  await pool.query(
    `INSERT INTO access.resource_grant(route, resource_id, subject_id, action, valid, transaction_id)
     VALUES ($1, $2, $3, 'account:manage', '(,)', $3),
            ($1, $2, $4, 'account:manage', '(,)', $4)`,
    [accountRoute, retainedOrganization.id, manager.id, successor.id],
  );
  const created = await request(retainedOrganization, organizationCatalogue, await bearer(manager));
  expect(created.response.status).toBe(201);
  const requestId = created.body.verificationRequest.id as string;
  expect(created.body.verificationRequest.requestedBy).toBe(manager.id);
  const rejected = await post(`/v1/verification-requests/${requestId}:reject`, await bearer(staff), {
    reason: 'Representation evidence is insufficient.',
  });
  expect(rejected.response.status).toBe(200);
  expect(rejected.body.verificationRequest.state).toBe('rejected');

  // Exercise the native terminal guard and requester minimizer on a real rejected
  // request. No approved identity or published undo custody is needed for rejection.
  const tx = await pool.connect();
  try {
    await tx.query('BEGIN');
    expect(await nativeStoreBlocker(tx, 'agent_verification_request', ['0', requestId], manager.id)).toBeNull();
    const minimize = nativeMinimization('agent_verification_request', 'requested_by');
    expect(minimize).toBe('requested_by=NULL');
    const erased = await tx.query(
      `UPDATE access.agent_verification_request SET ${minimize}
       WHERE route=0 AND request_id=$1 AND requested_by=$2 RETURNING requested_by`,
      [requestId, manager.id],
    );
    expect(erased.rows).toEqual([{ requested_by: null }]);
    await tx.query('COMMIT');
  } catch (error) {
    await tx.query('ROLLBACK');
    throw error;
  } finally {
    tx.release();
  }

  const path = `/v1/accounts/${retainedOrganization.id}/verification`;
  const successorBearer = await bearer(successor);
  const actor = await authenticateAccount(
    access,
    { pool, deadline: Date.now() + 10_000 },
    {
      accountId: successor.id,
      clientId: 'agent-verification-test',
      scopes: [...actionCatalogue(kernel).keys(), 'account:manage', 'gate:any'],
    },
  );
  const native = await readLatestAgentVerificationRequest(
    pool,
    access,
    { pool, actor, deadline: Date.now() + 10_000 },
    retainedOrganization.id,
  );
  expect(native).toEqual({ ...rejected.body.verificationRequest, requestedBy: null });
  const nativeStatus = await readAgentVerificationStatus(
    pool,
    access,
    { pool, actor, deadline: Date.now() + 10_000 },
    retainedOrganization.id,
  );
  const read = await get(path, successorBearer);
  expect(read.response.status).toBe(200);
  expect(read.body).toEqual(nativeStatus);
  expect(nativeStatus.verificationRequest).toEqual(native);
  expect(Object.hasOwn(read.body.verificationRequest, 'requestedBy')).toBe(true);
  expect(read.body.verificationRequest.requestedBy).toBeNull();

  const route = kernel.routes.find((route) => route.hooks.detail?.operationId === 'account.read_verification_request');
  const schema = (route!.hooks.response as Record<number, TSchema>)[200]!;
  expect(Value.Check(schema, read.body)).toBe(true);
  expect(
    Value.Check(schema, {
      verificationRequest: { ...native, requestedBy: manager.id },
      viewerActions: read.body.viewerActions,
    }),
  ).toBe(true);
  expect(Value.Check(schema, { verificationRequest: native })).toBe(false);
  for (const requestedBy of ['not-a-uuid', '', 42, false, {}, [], undefined])
    expect(Value.Check(schema, { verificationRequest: { ...native, requestedBy }, viewerActions: [] })).toBe(false);
  const missingRequester = { ...read.body.verificationRequest };
  delete missingRequester.requestedBy;
  expect(Value.Check(schema, { verificationRequest: missingRequester, viewerActions: [] })).toBe(false);

  const outsider = await get(path, await bearer(otherAccount));
  expect(outsider.response.status).toBe(403);
  expect(outsider.body).toMatchObject({ code: 'forbidden' });
  await pool.query(
    `DELETE FROM access.resource_grant
     WHERE route=$1 AND resource_id=$2 AND subject_id=$3 AND action='account:manage'`,
    [accountRoute, retainedOrganization.id, successor.id],
  );
  const revoked = await get(path, successorBearer);
  expect(revoked.response.status).toBe(403);
  expect(revoked.body).toMatchObject({ code: 'forbidden' });
});

test('private verification status projects request and withdraw advice across unrelated request histories', async () => {
  const applicant = await seedAccount('status_applicant');
  const orgManager = await seedAccount('status_org_manager');
  const org = await seedAccount('status_org', { kind: 'organization' });
  const reviewer = await seedAccount('status_reviewer');
  await pool.query(
    `INSERT INTO access.resource_grant(route, resource_id, subject_id, action, valid, transaction_id)
     VALUES ($1, $2, $3, 'account:manage', '(,)', $3)`,
    [accountRoute, org.id, orgManager.id],
  );
  for (const [account, kind] of [
    [applicant, 'person'],
    [org, 'organization'],
    [reviewer, 'person'],
  ] as const)
    await ensureAccountAgent(pool, {
      account: account.id,
      kind,
      name: account.displayName,
      language: 'en',
    });
  const personSubject = await catalogueSubject('schema:Person', 'Status Person');
  const orgSubject = await catalogueSubject('schema:Organization', 'Status Organization');
  const otherSubject = await catalogueSubject('schema:Person', 'Status Other');

  const applicantBearer = await bearer(applicant);
  const empty = await get(`/v1/accounts/${applicant.id}/verification`, applicantBearer);
  expect(empty.response.status).toBe(200);
  expect(empty.body.verificationRequest).toBeNull();
  expect(empty.body.viewerActions).toEqual([
    { action: 'account:update', operations: ['account.request_verification'] },
  ]);

  const created = await request(applicant, personSubject, applicantBearer);
  expect(created.response.status).toBe(201);
  const pending = await get(`/v1/accounts/${applicant.id}/verification`, applicantBearer);
  expect(pending.body.verificationRequest.state).toBe('pending');
  expect(pending.body.viewerActions).toEqual([
    { action: 'account:update', operations: ['account.withdraw_verification'] },
  ]);

  const readOnly = await get(
    `/v1/accounts/${applicant.id}/verification`,
    await bearer(applicant, ['account:read', 'gate:any']),
  );
  expect(readOnly.response.status).toBe(200);
  expect(readOnly.body.verificationRequest.id).toBe(pending.body.verificationRequest.id);
  expect(readOnly.body.viewerActions).toEqual([]);

  const statusActor = await authenticateAccount(
    access,
    { pool, deadline: Date.now() + 10_000 },
    {
      accountId: applicant.id,
      clientId: 'agent-verification-test',
      scopes: [...actionCatalogue(kernel).keys(), 'account:manage', 'gate:any'],
    },
  );
  const statusContext = { pool, actor: statusActor, deadline: Date.now() + 10_000 };
  const unavailableQueries: string[] = [];
  let adviceUnavailable = false;
  const fallbackStatus = await readAgentVerificationStatus(
    tracedPool(pool, (_connection, text, args, run) => {
      unavailableQueries.push(text);
      if (!adviceUnavailable && args.includes('account:update')) {
        adviceUnavailable = true;
        throw new AccessUnavailableError('overloaded');
      }
      return run();
    }),
    access,
    statusContext,
    applicant.id,
  );
  expect(adviceUnavailable).toBe(true);
  expect(fallbackStatus.verificationRequest).toMatchObject({
    id: pending.body.verificationRequest.id,
    state: 'pending',
  });
  expect(fallbackStatus.viewerActions).toEqual([]);
  expect(transactionCommands(unavailableQueries).slice(0, 2)).toEqual(['BEGIN', 'ROLLBACK']);

  for (const failureKind of ['binding', 'statement'] as const) {
    const failureQueries: string[] = [];
    let injected = false;
    const bindingFailure = new RangeError('Invalid read decision binding');
    let failure: unknown;
    try {
      await readAgentVerificationStatus(
        tracedPool(pool, (_connection, text, args, run) => {
          failureQueries.push(text);
          if (!injected && args.includes('account:update')) {
            injected = true;
            if (failureKind === 'binding') throw bindingFailure;
            return run('SELECT 1 / 0', []);
          }
          return run();
        }),
        access,
        { ...statusContext, deadline: Date.now() + 10_000 },
        applicant.id,
      );
    } catch (error) {
      failure = error;
    }
    expect(injected).toBe(true);
    if (failureKind === 'binding') expect(failure).toBe(bindingFailure);
    else expect(failure).toMatchObject({ code: '22012' });
    expect(transactionCommands(failureQueries)).toEqual(['BEGIN', 'ROLLBACK']);
  }

  const expiredQueries: string[] = [];
  await expect(
    readAgentVerificationStatus(
      tracedPool(pool, (_connection, text, _args, run) => {
        expiredQueries.push(text);
        return run();
      }),
      access,
      { ...statusContext, deadline: Date.now() - 1 },
      applicant.id,
    ),
  ).rejects.toBeInstanceOf(AccessUnavailableError);
  expect(expiredQueries).toEqual([]);

  const managerBearer = await bearer(orgManager);
  const orgCreated = await request(org, orgSubject, managerBearer);
  expect(orgCreated.response.status).toBe(201);
  const withdrawn = await post(`/v1/accounts/${org.id}:withdrawVerification`, managerBearer, {});
  expect(withdrawn.response.status).toBe(200);
  const terminal = await get(`/v1/accounts/${org.id}/verification`, managerBearer);
  expect(terminal.body.verificationRequest.state).toBe('withdrawn');
  expect(terminal.body.viewerActions).toEqual([
    { action: 'account:manage', operations: ['account.request_verification'] },
  ]);

  const reviewerBearer = await bearer(reviewer);
  const otherCreated = await request(reviewer, otherSubject, reviewerBearer);
  expect(otherCreated.response.status).toBe(201);
  await pool.query(
    `UPDATE access.agent_verification_request SET state = 'approving', updated_at = statement_timestamp()
     WHERE request_id = $1`,
    [otherCreated.body.verificationRequest.id],
  );
  const approving = await get(`/v1/accounts/${reviewer.id}/verification`, reviewerBearer);
  expect(approving.body.verificationRequest.state).toBe('approving');
  expect(approving.body.viewerActions).toEqual([]);
});

test('automated accounts cannot request verification and a refused semantic merge leaves the account unverified', async () => {
  const staffBearer = await bearer(staff);
  const automatedBearer = await bearer(automated);
  const automatedResult = await request(automated, personCatalogue, automatedBearer);
  expect(automatedResult.response.status).toBe(403);
  expect(automatedResult.body).toMatchObject({ code: 'forbidden' });

  const requester = { ...otherAccount, id: otherAccount.id };
  const requesterBearer = await bearer(requester);
  const linkedCatalogue = accountAgentId(otherAccount.id);
  const requestResult = await request(otherAccount, linkedCatalogue, requesterBearer);
  expect(requestResult.response.status).toBe(201);
  const approval = await post(
    `/v1/verification-requests/${requestResult.body.verificationRequest.id}:approve`,
    staffBearer,
    {},
  );
  expect(approval.response.status).toBe(200);
  const decision = await readAgentVerificationWorkflowRequest(pool, requestResult.body.verificationRequest.id);
  const workflow = { ...decision!, receiptId: decision!.decisionReceiptId! };
  await recordPendingAgentVerification(pool, workflow, clock);
  let problem: { type: string; detail: string };
  try {
    await mergeVerifiedAgent(pool, workflow);
    throw new Error('The semantic merge unexpectedly accepted a linked account agent');
  } catch (error) {
    expect(error).toBeInstanceOf(AccountAgentVerificationError);
    problem = { type: (error as Error).name, detail: (error as Error).message };
  }
  await clearPendingAgentVerification(pool, workflow, clock);
  await failAgentVerification(pool, { ...workflow, problem }, clock);
  const failed = await readLatestAgentVerificationRequest(
    pool,
    access,
    {
      pool,
      actor: await authenticateAccount(
        access,
        { pool, deadline: Date.now() + 10_000 },
        {
          accountId: otherAccount.id,
          clientId: 'agent-verification-test',
          scopes: [...actionCatalogue(kernel).keys(), 'account:manage', 'gate:any'],
        },
      ),
      deadline: Date.now() + 10_000,
    },
    otherAccount.id,
  );
  expect(failed).toMatchObject({ state: 'failed', problem: { type: 'AccountAgentVerificationError' } });
  expect(await accountState(otherAccount.id)).toMatchObject({
    agent_verified: false,
    agent_subject_id: null,
    pending_agent_subject_id: null,
    pending_agent_receipt_id: null,
  });
});

test('verification workflow event payloads remain registered and every required event is emitted', async () => {
  const { rows } = await pool.query<{ type: string; data: unknown }>(
    'SELECT type, data FROM core.outbox WHERE type = ANY($1::text[])',
    [eventNames],
  );
  const seen = new Set(rows.map(({ type }) => type));
  for (const type of eventNames) {
    expect(EVENT_TYPES()[type]).toBeDefined();
    expect(seen.has(type)).toBe(true);
  }
  for (const row of rows) expect(Value.Check(EVENT_TYPES()[row.type]!, row.data)).toBe(true);
});

test('original in-flight verification requires its retained pending receipt and original accepted release without fabricating either', async () => {
  const account = await seedAccount(`original_${randomUUID().slice(0, 8)}`);
  const subject = await catalogueSubject('schema:Person', 'Original verification');
  const applied = await request(account, subject, await bearer(account));
  expect(applied.response.status).toBe(201);
  const requestId = applied.body.verificationRequest.id as string;
  const approved = await post(`/v1/verification-requests/${requestId}:approve`, await bearer(staff), {});
  expect(approved.response.status).toBe(200);
  const decision = (await readAgentVerificationWorkflowRequest(pool, requestId))!;
  const receipt = { kind: 'account-agent.verify' as const, account: account.id, receipt: decision.decisionReceiptId! };
  // A mutable pending marker is insufficient: the exact original native command has not committed yet.
  await expect(loadAccountIdentitySource(pool, receipt)).rejects.toThrow('Accounts pending source required');
  // Execute the original pre-intent-table pending body through the real executor, retaining its real receipt.
  const original = await runCommand(
    pool,
    {
      partition: accountRoute >>> 4,
      receipt: {
        actorAccountId: account.id,
        kind: 'access.agent-verification.pending',
        key: `${requestId}:pending`,
        digest: createHash('sha256')
          .update(JSON.stringify([requestId, account.id, 'actor', subject, receipt.receipt]))
          .digest(),
      },
    },
    async (tx, { transactionId }) => {
      await tx.query(
        `UPDATE access.account SET pending_agent_subject_id=$3,pending_agent_receipt_id=$4,transaction_id=$5
      WHERE route=$1 AND account_id=$2`,
        [accountRoute, account.id, subject, receipt.receipt, transactionId],
      );
      return {
        value: { requestId, accountId: account.id },
        events: [
          { type: 'com.rezics.access.account-updated.v1', subject: account.id, data: { accountId: account.id } },
        ],
      };
    },
  );
  for (let attempt = 0; attempt < 2; attempt++)
    await expect(loadAccountIdentitySource(pool, receipt)).rejects.toThrow(ORIGINAL_IDENTITY_SOURCE_REQUIRED);
  expect(await accountState(account.id)).toMatchObject({
    pending_agent_receipt_id: receipt.receipt,
    agent_verified: false,
  });
  expect(
    (
      await pool.query('SELECT * FROM access.agent_identity_intent WHERE route=$1 AND account_id=$2', [
        accountRoute,
        account.id,
      ])
    ).rows,
  ).toEqual([]);
  expect(
    (
      await pool.query('SELECT * FROM access.agent_identity_recovery WHERE route=$1 AND account_id=$2', [
        accountRoute,
        account.id,
      ])
    ).rows,
  ).toEqual([]);
  expect(
    (
      await pool.query(
        `SELECT transaction_id FROM core.receipt WHERE partition_no=$1 AND principal_id=$2
    AND command_kind='access.agent-verification.pending'`,
        [accountRoute >>> 4, account.id],
      )
    ).rows,
  ).toEqual([{ transaction_id: original.transactionId }]);
  // Purged native receipt data stays pending under the precise Accounts source owner, never today's release.
  await pool.query(
    `UPDATE core.receipt SET payload_state='minimized',response='null'::jsonb
    WHERE partition_no=$1 AND principal_id=$2 AND command_kind='access.agent-verification.pending'`,
    [accountRoute >>> 4, account.id],
  );
  await expect(loadAccountIdentitySource(pool, receipt)).rejects.toThrow('Accounts pending source required');
});

test('Original native accepted Source input recovery consumes actual read and same-home verifier while independently validating original Account decision pending or reversal receipt and preserving distinct original versus recovery native provenance', async () => {
  const { identityEpochStore: storeGetter } = await import('../../src/semantic/identity-epoch-store.ts');
  const store = storeGetter();
  const { stepIdentityEpochAdmission } = await import('../../src/semantic/identity-epoch-admission.ts');
  const { readOriginalAccountAgentIdentity, verifyOriginalAccountAgentIdentity } =
    await import('../../src/semantic/account-agent-identity-recovery.ts');
  const { noEffect } = await import('../../src/command/command.ts');
  const { writeAgentVerificationPage } = await import('../../src/access/agent-verification.ts');
  const { deliverAccountIdentity, probeAccountIdentityPublication } =
    await import('../../src/access/agent-verification-identity.ts');
  const account = await seedAccount(`accepted_${randomUUID().slice(0, 8)}`);
  const subject = await catalogueSubject('schema:Person', 'Accepted original verification');
  await ensureAccountAgent(pool, { account: account.id, kind: 'person', name: account.displayName });
  const applied = await request(account, subject, await bearer(account));
  const requestId = applied.body.verificationRequest.id as string;
  expect((await post(`/v1/verification-requests/${requestId}:approve`, await bearer(staff), {})).response.status).toBe(
    200,
  );
  const decision = (await readAgentVerificationWorkflowRequest(pool, requestId))!;
  const workflow = { ...decision, receiptId: decision.decisionReceiptId! };
  const receipt = { kind: 'account-agent.verify' as const, account: account.id, receipt: workflow.receiptId };
  await recordPendingAgentVerification(pool, workflow, clock);
  const before = await loadAccountIdentitySource(pool, receipt);
  const job = await store.prepareAdmission(pool, {}, before.input);
  for (let page = 0; page < 512; page++) {
    const progress = await stepIdentityEpochAdmission(pool, job);
    if (progress.state === 'pending') break;
    expect(progress.state).toBe('preparing');
    if (page === 511) throw new Error('Original Source admission did not finish');
  }
  const selection = { account: account.id, direction: receipt.kind, receipt: receipt.receipt };
  const original = (await readOriginalAccountAgentIdentity(pool, selection))!;
  expect(original.input).toEqual(before.input);
  expect(original.job).toEqual(job);
  expect(original.native.transactionId).not.toBe(before.transactionId);
  await runCommand(pool, { partition: accountRoute >>> 4 }, async (tx) => {
    expect(await verifyOriginalAccountAgentIdentity(tx, selection, { ...original })).toBe(false);
    expect(await verifyOriginalAccountAgentIdentity(tx, selection, original)).toBe(true);
    return noEffect(null);
  });
  await runCommand(pool, { partition: (accountRoute >>> 4) + 1 }, async (tx) => {
    expect(await verifyOriginalAccountAgentIdentity(tx, selection, original)).toBe(false);
    return noEffect(null);
  });
  // Model a restored old Accounts image that lost only its newer source table.
  // All original commands, Source admission, job and native components are real.
  const restore = await pool.connect();
  try {
    await restore.query('BEGIN');
    await restore.query("SET LOCAL session_replication_role='replica'");
    await restore.query(
      `DELETE FROM access.agent_identity_intent WHERE route=$1 AND account_id=$2
      AND direction=$3 AND receipt_id=$4`,
      [accountRoute, account.id, receipt.kind, receipt.receipt],
    );
    await restore.query('COMMIT');
  } finally {
    restore.release();
  }
  const recovered = await loadAccountIdentitySource(pool, receipt);
  expect(recovered.input).toEqual(before.input);
  expect(recovered.digest).toBe(before.digest);
  expect(recovered.transactionId).toBe(before.transactionId);
  expect(recovered.epoch).toBe(before.epoch);
  expect(recovered.position).toBe(before.position);
  const association = (
    await pool.query(
      `SELECT * FROM access.agent_identity_recovery
    WHERE route=$1 AND account_id=$2 AND direction=$3 AND receipt_id=$4`,
      [accountRoute, account.id, receipt.kind, receipt.receipt],
    )
  ).rows[0]!;
  expect(association.original_source.native.transactionId).toBe(original.native.transactionId);
  expect(association.original_source.job).toEqual({ jobId: job.jobId, epoch: job.epoch.toString() });
  expect(association.source_transaction_id).toBe(before.transactionId);
  expect(association.recovery_transaction_id).not.toBe(before.transactionId);
  expect(association.recovery_transaction_id).not.toBe(original.native.transactionId);
  expect((await accountState(account.id)).pending_agent_receipt_id).toBe(receipt.receipt);
  await expect(probeAccountIdentityPublication(pool, receipt)).rejects.toThrow();
  expect(await deliverAccountIdentity(pool, receipt)).toEqual(job);
  await writeAgentVerificationPage(pool, workflow);
  await completeAgentVerification(pool, workflow, clock);
  await finishAgentVerification(pool, workflow, clock);
  expect((await loadAccountIdentitySource(pool, receipt)).input).toEqual(before.input);
  const copies = (
    await pool.query(
      `SELECT artifact_type,source_transaction_id FROM core.agent_identity_history_copy
    WHERE partition_no=$1 AND source_account_id=$2 AND source_receipt_id=$3 AND source_transaction_id=$4`,
      [accountRoute >>> 4, account.id, receipt.receipt, association.recovery_transaction_id],
    )
  ).rows;
  expect(copies.map((copy) => copy.artifact_type).sort()).toEqual(['command-receipt/v1', 'outbox-event/v1']);
  await expect(
    pool.query(
      `UPDATE access.agent_identity_recovery SET original_source='{}'::jsonb
    WHERE route=$1 AND account_id=$2`,
      [accountRoute, account.id],
    ),
  ).rejects.toThrow('Immutable account identity source');
  // Model another old-image loss, then permanently minimize the actual original
  // payload. Published Source data cannot recreate a purged Account receipt.
  const lost = await pool.connect();
  try {
    await lost.query('BEGIN');
    await lost.query("SET LOCAL session_replication_role='replica'");
    await lost.query('DELETE FROM access.agent_identity_recovery WHERE route=$1 AND account_id=$2', [
      accountRoute,
      account.id,
    ]);
    await lost.query('DELETE FROM access.agent_identity_intent WHERE route=$1 AND account_id=$2', [
      accountRoute,
      account.id,
    ]);
    await lost.query('COMMIT');
  } finally {
    lost.release();
  }
  await pool.query(
    `UPDATE core.receipt SET payload_state='minimized',response='null'::jsonb
    WHERE partition_no=$1 AND transaction_id=$2`,
    [accountRoute >>> 4, before.transactionId],
  );
  expect(
    await readOriginalAccountAgentIdentity(pool, {
      account: account.id,
      direction: receipt.kind,
      receipt: receipt.receipt,
    }),
  ).not.toBeNull();
  await expect(loadAccountIdentitySource(pool, receipt)).rejects.toThrow('Accounts pending source required');
  expect(
    (
      await pool.query('SELECT 1 FROM access.agent_identity_recovery WHERE route=$1 AND account_id=$2', [
        accountRoute,
        account.id,
      ])
    ).rows,
  ).toEqual([]);
});

test('accepted original Source cannot recover verification without the independent original Global decision write basis', async () => {
  const { identityEpochStore: storeGetter } = await import('../../src/semantic/identity-epoch-store.ts');
  const store = storeGetter();
  const { stepIdentityEpochAdmission } = await import('../../src/semantic/identity-epoch-admission.ts');
  const { readOriginalAccountAgentIdentity } = await import('../../src/semantic/account-agent-identity-recovery.ts');
  const account = await seedAccount(`no_basis_${randomUUID().slice(0, 8)}`);
  const subject = await catalogueSubject('schema:Person', 'Original decision custody');
  await ensureAccountAgent(pool, { account: account.id, kind: 'person', name: account.displayName });
  const applied = await request(account, subject, await bearer(account));
  const requestId = applied.body.verificationRequest.id as string;
  expect((await post(`/v1/verification-requests/${requestId}:approve`, await bearer(staff), {})).response.status).toBe(
    200,
  );
  const decision = (await readAgentVerificationWorkflowRequest(pool, requestId))!;
  const receipt = { kind: 'account-agent.verify' as const, account: account.id, receipt: decision.decisionReceiptId! };
  await recordPendingAgentVerification(pool, { ...decision, receiptId: receipt.receipt }, clock);
  const source = await loadAccountIdentitySource(pool, receipt);
  const job = await store.prepareAdmission(pool, {}, source.input);
  for (let page = 0; page < 512; page++) {
    const progress = await stepIdentityEpochAdmission(pool, job);
    if (progress.state === 'pending') break;
    expect(progress.state).toBe('preparing');
    if (page === 511) throw new Error('Original Source admission did not finish');
  }
  expect(
    await readOriginalAccountAgentIdentity(pool, {
      account: account.id,
      direction: receipt.kind,
      receipt: receipt.receipt,
    }),
  ).not.toBeNull();
  const restore = await pool.connect();
  try {
    await restore.query('BEGIN');
    await restore.query("SET LOCAL session_replication_role='replica'");
    await restore.query('DELETE FROM access.agent_identity_intent WHERE route=$1 AND account_id=$2', [
      accountRoute,
      account.id,
    ]);
    await restore.query('DELETE FROM editorial.write_basis WHERE partition_no=0 AND transaction_id=$1', [
      receipt.receipt,
    ]);
    await restore.query('COMMIT');
  } finally {
    restore.release();
  }
  await expect(loadAccountIdentitySource(pool, receipt)).rejects.toThrow('missing original Global decision');
  expect(
    (
      await pool.query('SELECT 1 FROM access.agent_identity_recovery WHERE route=$1 AND account_id=$2', [
        accountRoute,
        account.id,
      ])
    ).rows,
  ).toEqual([]);
  expect((await accountState(account.id)).pending_agent_receipt_id).toBe(receipt.receipt);
});
