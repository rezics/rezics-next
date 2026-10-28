import { afterAll, beforeAll, expect, test } from 'bun:test';
import { createHash, randomUUID } from 'node:crypto';
import { Pool } from 'pg';
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
    expect(EVENT_TYPES[type]).toBeDefined();
    expect(seen.has(type)).toBe(true);
  }
  for (const row of rows) expect(Value.Check(EVENT_TYPES[row.type]!, row.data)).toBe(true);
});
