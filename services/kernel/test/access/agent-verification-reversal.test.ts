import { afterAll, beforeAll, expect, test } from 'bun:test';
import { createHash, randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { Value } from 'typebox/value';
import { bundledDigest, bundledRelease } from '@rezics/definitions/bundled';
import { createPool } from '../../src/database/pool.ts';
import { bootstrapGovernance } from '../../src/access/bootstrap-governance.ts';
import { accountAgentId } from '../../src/semantic/agents.ts';
import { ensureAccountAgent } from '../../src/semantic/account-agents.ts';
import { bootstrapRelease } from '../../src/semantic/definitions.ts';
import { createSubject } from '../../src/semantic/subject.ts';
import {
  completeAgentVerification,
  finishAgentVerification,
  mergeVerifiedAgent,
  readAgentVerificationWorkflowRequest,
  recordPendingAgentVerification,
  writeAgentVerificationPage,
  unmergeVerifiedAgent,
  removeAgentVerificationPage,
  finishAgentVerificationReversal,
  type AgentVerificationReversal,
} from '../../src/access/agent-verification.ts';
import { applyAccountAgentEffect } from '../../src/access/account-agent-effect.ts';
import { createLifecycleCommands, LIFECYCLE_ACTIONS } from '../../src/access/lifecycle.ts';
import { authenticateAccount } from '../support/admitted-access.ts';
import { newId } from '../../src/route/route.ts';
import { createKernel } from '../../src/http/kernel.ts';
import { actionCatalogue, IDEMPOTENCY_HEADER } from '../../src/http/request.ts';
import { EVENT_TYPES } from '../../src/events/log.ts';
import { migrate } from '../../scripts/database.ts';
import { dropTestDatabase } from '../support/drop-test-database.ts';
import { accountToken, admittedAccess } from '../support/admitted-access.ts';

const sourceUrl = process.env.DATABASE_URL;
if (!sourceUrl) throw new Error('DATABASE_URL must name the migrated test database');
const accountRoute = 0x5274;
const catalogueRoute = 0x6573;
const routeKey = new Uint8Array(32).fill(31);
const tokens = { current: 1, keys: new Map([[1, new Uint8Array(32).fill(32)]]) };
const clock = () => new Date();
const links = [{ label: 'Website', url: 'https://example.test/profile' }];
type Seeded = { id: string; handle: string; kind: 'actor' | 'organization'; displayName: string };
let admin: Pool;
let databaseName: string;
let databaseUrl: string;
let pool: ReturnType<typeof createPool>;
let access: ReturnType<typeof admittedAccess>;
let kernel: ReturnType<typeof createKernel>;
let staff: Seeded;
let manager: Seeded;

function key(): string {
  return randomUUID();
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
  admin = new Pool({ connectionString: sourceUrl, max: 1 });
  databaseName = `verification_reversal_${process.pid}_${randomUUID().replaceAll('-', '')}`;
  const target = new URL(sourceUrl!);
  target.pathname = `/${databaseName}`;
  databaseUrl = target.toString();
  await admin.query(`CREATE DATABASE "${databaseName}"`);
  migrate(databaseUrl);
  pool = createPool(databaseUrl);
  await bootstrapRelease(pool, bundledRelease);
  const initial = createKernel({ pool, routeKey, tokens, clock });
  const actions = new Map(actionCatalogue(initial));
  for (const [action, value] of LIFECYCLE_ACTIONS) actions.set(action, value);
  actions.set('account:manage', { anonymous: false });
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
  staff = await seedAccount('reversal_staff');
  manager = await seedAccount('reversal_manager');
  await bootstrapGovernance(pool, staff.id);
  const opened = await post('/v1/platform/exposure/agent_verification:open', await bearer(staff));
  expect(opened.response.status).toBe(200);
}, 60_000);

afterAll(async () => {
  await pool?.end();
  try {
    if (databaseName) await dropTestDatabase(admin, databaseName);
  } finally {
    await admin?.end();
  }
}, 30_000);

async function verified(kind: 'actor' | 'organization' = 'actor') {
  const account = await seedAccount(`reversal_${randomUUID().slice(0, 8)}`, { kind });
  if (kind === 'organization')
    await pool.query(
      `INSERT INTO access.resource_grant(route,resource_id,subject_id,action,valid,transaction_id)
     VALUES($1,$2,$3,'account:manage','(,)',$3)`,
      [accountRoute, account.id, manager.id],
    );
  const token = await bearer(kind === 'organization' ? manager : account);
  await ensureAccountAgent(pool, {
    account: account.id,
    kind: kind === 'actor' ? 'person' : 'organization',
    name: account.displayName,
    language: 'en',
  });
  const subject = await catalogueSubject(kind === 'actor' ? 'schema:Person' : 'schema:Organization', 'Catalogue');
  const handleRoute = createHash('sha256').update(account.handle).digest().readUInt16BE(0);
  await pool.query(
    `INSERT INTO access.handle_claim(route,normalized_handle,account_id,state,transaction_id)
    VALUES($1,$2,$3,'active',$3)`,
    [handleRoute, account.handle, account.id],
  );
  const applied = await request(account, subject, token);
  expect(applied.response.status).toBe(201);
  const approved = await post(
    `/v1/verification-requests/${applied.body.verificationRequest.id}:approve`,
    await bearer(staff),
    {},
  );
  expect(approved.response.status).toBe(200);
  const decision = (await readAgentVerificationWorkflowRequest(pool, applied.body.verificationRequest.id))!;
  const workflow = { ...decision, receiptId: decision.decisionReceiptId! };
  await recordPendingAgentVerification(pool, workflow, clock);
  await mergeVerifiedAgent(pool, workflow);
  await writeAgentVerificationPage(pool, workflow);
  await completeAgentVerification(pool, workflow, clock);
  await finishAgentVerification(pool, workflow, clock);
  expect((await get(`/v1/accounts?agent=${subject}`)).body.accounts).toHaveLength(1);
  return { account, subject, token };
}

async function finish(decision: AgentVerificationReversal) {
  await unmergeVerifiedAgent(pool, decision);
  await removeAgentVerificationPage(pool, decision);
  await finishAgentVerificationReversal(pool, decision, clock);
}

async function expectHidden(account: Seeded, subject: string) {
  const handle = await get(`/v1/accounts?handle=${account.handle}`);
  expect(handle.response.status).toBe(200);
  expect(handle.body.accounts[0]).toMatchObject({ verified: false, subject: { id: accountAgentId(account.id) } });
  const inverse = await get(`/v1/accounts?agent=${subject}`);
  expect(inverse.response.status).toBe(200);
  expect(inverse.body).toEqual({ accounts: [], next: null });
}

async function pointer(subject: string) {
  return (
    await pool.query('SELECT * FROM access.agent_page WHERE route=$1 AND subject_id=$2', [catalogueRoute, subject])
  ).rows;
}

test('the account releases its own verification through the same workflow and both lookups stop at the first step', async () => {
  const { account, subject, token } = await verified();
  const idempotency = key();
  const released = await post(`/v1/accounts/${account.id}:releaseVerification`, token, undefined, idempotency);
  expect(released.response.status).toBe(200);
  const decision = released.body.reversal as AgentVerificationReversal;
  expect(decision).toMatchObject({ kind: 'released', reason: null, accountId: account.id });
  await expectHidden(account, subject);
  expect(await pointer(subject)).toHaveLength(1);
  const repeated = await post(`/v1/accounts/${account.id}:releaseVerification`, token, undefined, idempotency);
  expect(repeated.response.status).toBe(200);
  expect(repeated.body).toEqual(released.body);
  await finish(decision);
  expect(await pointer(subject)).toHaveLength(0);
  await expectHidden(account, subject);
  await finish(decision);
  const events = await pool.query('SELECT data FROM core.outbox WHERE type=$1 AND subject=$2', [
    'com.rezics.access.agent-verification.reversed.v1',
    account.id,
  ]);
  expect(events.rows).toHaveLength(1);
  expect(events.rows[0].data).toEqual(decision);
  expect(Value.Check(EVENT_TYPES['com.rezics.access.agent-verification.reversed.v1']!, events.rows[0].data)).toBe(true);
});

test('governance reverses a verification, preserves its reason and allows a new reviewed application', async () => {
  const { account, subject, token } = await verified();
  const revoked = await post(`/v1/accounts/${account.id}:revokeVerification`, await bearer(staff), {
    reason: 'Impersonation',
  });
  expect(revoked.response.status).toBe(200);
  expect(revoked.body.reversal).toMatchObject({ kind: 'revoked', reason: 'Impersonation' });
  await expectHidden(account, subject);
  expect((await request(account, subject, token)).response.status).toBe(403);
  await finish(revoked.body.reversal);
  expect(await pointer(subject)).toEqual([]);
  await expectHidden(account, subject);
  expect((await accountState(account.id)).pending_agent_receipt_id).toBeNull();
  expect((await request(account, subject, token)).response.status).toBe(201);
  const receipt = await pool.query('SELECT response FROM core.receipt WHERE transaction_id=$1', [
    revoked.body.reversal.receiptId,
  ]);
  expect(JSON.stringify(receipt.rows)).toContain('Impersonation');
});

test('nobody without account:verify_agent on the Global Context revokes; owner release follows profile authority', async () => {
  const { account, subject, token } = await verified();
  for (const unauthorized of [
    undefined,
    token,
    await bearer(manager),
    await bearer(staff, ['account:update', 'gate:any']),
  ]) {
    const result = await post(`/v1/accounts/${account.id}:revokeVerification`, unauthorized, {});
    expect([401, 403]).toContain(result.response.status);
  }
  // A grant on the account is insufficient: the decision requires the Global Context.
  await pool.query(
    `INSERT INTO access.resource_grant(route,resource_id,subject_id,action,valid,transaction_id)
    VALUES($1,$2,$3,'account:verify_agent','(,)',$3)`,
    [accountRoute, account.id, manager.id],
  );
  expect((await post(`/v1/accounts/${account.id}:revokeVerification`, await bearer(manager), {})).response.status).toBe(
    403,
  );
  expect((await post(`/v1/accounts/${account.id}:releaseVerification`, await bearer(manager))).response.status).toBe(
    403,
  );
  expect(
    (await post(`/v1/accounts/${account.id}:revokeVerification`, await bearer(staff), { reason: 'x'.repeat(501) }))
      .response.status,
  ).toBe(400);
  expect((await get(`/v1/accounts?agent=${subject}`)).body.accounts).toHaveLength(1);
  const revoked = await post(`/v1/accounts/${account.id}:revokeVerification`, await bearer(staff), {});
  expect(revoked.response.status).toBe(200);
  await finish(revoked.body.reversal);
});

test('an organization owner releases through account:manage and loses that authority when its grant is removed', async () => {
  const { account } = await verified('organization');
  const token = await bearer(manager, ['account:manage', 'gate:any']);
  await pool.query('DELETE FROM access.resource_grant WHERE route=$1 AND resource_id=$2 AND subject_id=$3', [
    accountRoute,
    account.id,
    manager.id,
  ]);
  expect((await post(`/v1/accounts/${account.id}:releaseVerification`, token)).response.status).toBe(403);
  await pool.query(
    `INSERT INTO access.resource_grant(route,resource_id,subject_id,action,valid,transaction_id)
    VALUES($1,$2,$3,'account:manage','(,)',$3)`,
    [accountRoute, account.id, manager.id],
  );
  const released = await post(`/v1/accounts/${account.id}:releaseVerification`, token);
  expect(released.response.status).toBe(200);
  await finish(released.body.reversal);
});

test('deleting a verified account commits the same reversal through the account agent effect', async () => {
  const { account, subject } = await verified();
  await pool.query(
    `INSERT INTO access.resource_grant(route,resource_id,subject_id,action,valid,transaction_id)
    VALUES($1,$2,$2,'account:delete','(,)',$2)`,
    [accountRoute, account.id],
  );
  const actor = await authenticateAccount(
    access,
    { pool, deadline: Date.now() + 10_000 },
    {
      accountId: account.id,
      clientId: 'delete-test',
      scopes: ['account:delete'],
    },
  );
  const lifecycle = createLifecycleCommands({ pool, access, clock });
  await lifecycle.tombstone({ actor, deadline: Date.now() + 10_000 }, { accountId: account.id, key: key() });
  const { readBatch } = await import('../../src/events/log.ts');
  const events: import('../../src/events/log.ts').CloudEvent[] = [];
  for (
    let page = 0;
    page < 10 && !events.some((e) => e.subject === account.id && e.type === 'com.rezics.access.account-tombstoned.v1');
    page++
  )
    await readBatch(pool, {
      consumer: 'verification_reversal_deletion',
      partition: Math.floor(accountRoute / 16),
      envelopes: 64,
      async apply(envelopes) {
        events.push(...envelopes.flatMap((e) => e.events));
      },
    });
  const event = events.find((e) => e.type === 'com.rezics.access.account-tombstoned.v1' && e.subject === account.id)!;
  expect(event).toBeDefined();
  await applyAccountAgentEffect(pool, event);
  const decision = (
    await pool.query('SELECT data FROM core.outbox WHERE type=$1 AND subject=$2', [
      'com.rezics.access.agent-verification.reversing.v1',
      account.id,
    ])
  ).rows[0].data as AgentVerificationReversal;
  expect(decision).toMatchObject({ kind: 'revoked', reason: 'Account deleted' });
  await finish(decision);
  await applyAccountAgentEffect(pool, event);
  expect(await pointer(subject)).toEqual([]);
  const mapping = await pool.query(
    'SELECT verified FROM semantic.account_agent_subject WHERE account_route=$1 AND account_id=$2',
    [accountRoute, account.id],
  );
  expect(mapping.rows[0].verified).toBe(false);
});

test('both reversal routes declare x-exposure gate:agent_verification and client declarations are regenerated', async () => {
  for (const operation of ['account.revoke_verification', 'account.release_verification']) {
    const route = kernel.routes.find((r) => r.hooks.detail?.operationId === operation);
    expect(route?.hooks.detail?.['x-exposure']).toBe('gate:agent_verification');
  }
  const declarations = await Bun.file(
    new URL('../../../../packages/client/src/kernel/access/routes.d.ts', import.meta.url),
  ).text();
  expect(declarations).toContain('$releaseVerification');
  expect(declarations).toContain('$revokeVerification');
});

test('a crash after semantic reversal and before pointer removal converges through the registered durable workflow', async () => {
  const { account, subject, token } = await verified();
  const released = await post(`/v1/accounts/${account.id}:releaseVerification`, token);
  expect(released.response.status).toBe(200);
  const decision = released.body.reversal as AgentVerificationReversal;
  const program = `
    import { Pool } from 'pg';
    import { createWorkClient } from './src/work/client.ts';
    import { composeWork } from './src/work/registry.ts';
    import { registerAgentVerificationWork } from './src/access/agent-verification-work.ts';
    const pool = new Pool({ connectionString: process.env.DATABASE_URL });
    const decision = JSON.parse(process.env.REVERSAL);
    const query = pool.query.bind(pool);
    pool.query = (...args) => {
      const sql = typeof args[0] === 'string' ? args[0] : args[0]?.text;
      if (process.env.PAUSE_REVERSAL === '1' && sql?.includes('DELETE FROM access.agent_page')) {
        console.log('reversal-paused');
        return new Promise(() => {});
      }
      return query(...args);
    };
    const client = await createWorkClient(process.env.DATABASE_URL, pool);
    const work = await composeWork([{ name: 'accounts', register: registerAgentVerificationWork }], {
      pool, client, databaseUrl: process.env.DATABASE_URL, executorId: 'reversal-recovery-test',
    });
    try {
      await work.launch();
      const row = (await pool.query('SELECT * FROM core.outbox WHERE type=$1 AND subject=$2', [
        'com.rezics.access.agent-verification.reversing.v1', decision.accountId,
      ])).rows[0];
      await work.effects.enqueue([{ partition: row.partition_no, epoch: row.epoch, position: BigInt(row.position), events: [{
        specversion: '1.0', id: row.id, source: 'urn:rezics:log:'+row.partition_no+'.'+row.epoch,
        type: row.type, subject: row.subject, time: row.recorded_at.toISOString(),
        datacontenttype: 'application/json', sequence: String(row.position).padStart(19,'0'), data: row.data,
      }] }]);
      if (process.env.PAUSE_REVERSAL === '1') await new Promise(() => {});
      const handle = await client.enqueue({ workflowName: 'accounts.agent-verification-reversal', queueName: 'workflows',
        workflowID: 'accounts.agent-verification-reversal:'+decision.accountId+':'+decision.receiptId,
        workflowIDReusePolicy: 'return-existing' }, decision);
      await handle.getResult();
    } finally { await work.shutdown(); await client.close(); await pool.end(); }
  `;
  const spawn = (pause: boolean) =>
    Bun.spawn([process.execPath, '-e', program], {
      cwd: new URL('../..', import.meta.url).pathname,
      env: {
        ...process.env,
        DATABASE_URL: databaseUrl,
        REVERSAL: JSON.stringify(decision),
        PAUSE_REVERSAL: pause ? '1' : '0',
      },
      stdout: 'pipe',
      stderr: 'pipe',
    });
  const first = spawn(true);
  const firstErrors = new Response(first.stderr).text();
  const firstDeadline = setTimeout(() => first.kill('SIGKILL'), 45_000);
  let output = '';
  try {
    for await (const chunk of first.stdout) {
      output += new TextDecoder().decode(chunk);
      if (output.includes('reversal-paused')) break;
    }
  } finally {
    clearTimeout(firstDeadline);
    first.kill('SIGKILL');
    await first.exited;
  }
  const firstLog = await firstErrors;
  expect(output, firstLog).toContain('reversal-paused');
  expect(firstLog).not.toContain('error:');
  // The semantic transaction committed, while both the page pointer and Access marker remain.
  expect(await pointer(subject)).toHaveLength(1);
  const mapping = await pool.query(
    'SELECT verified FROM semantic.account_agent_subject WHERE account_route=$1 AND account_id=$2',
    [accountRoute, account.id],
  );
  expect(mapping.rows[0].verified).toBe(false);
  await expectHidden(account, subject);
  const restarted = spawn(false);
  const restartDeadline = setTimeout(() => restarted.kill('SIGKILL'), 45_000);
  const [, errors, status] = await Promise.all([
    new Response(restarted.stdout).text(),
    new Response(restarted.stderr).text(),
    restarted.exited,
  ]);
  clearTimeout(restartDeadline);
  expect(status, errors).toBe(0);
  expect(await pointer(subject)).toEqual([]);
  expect((await accountState(account.id)).pending_agent_receipt_id).toBeNull();
  await expectHidden(account, subject);
}, 120_000);

test('old reversal deliveries cannot undo a newer reviewed verification', async () => {
  const { account, subject, token } = await verified();
  const released = await post(`/v1/accounts/${account.id}:releaseVerification`, token);
  expect(released.response.status).toBe(200);
  const reversal = released.body.reversal as AgentVerificationReversal;
  await finish(reversal);
  const applied = await request(account, subject, token);
  expect(applied.response.status).toBe(201);
  const approved = await post(
    `/v1/verification-requests/${applied.body.verificationRequest.id}:approve`,
    await bearer(staff),
    {},
  );
  expect(approved.response.status).toBe(200);
  const decision = (await readAgentVerificationWorkflowRequest(pool, applied.body.verificationRequest.id))!;
  const workflow = { ...decision, receiptId: decision.decisionReceiptId! };
  await recordPendingAgentVerification(pool, workflow, clock);
  await mergeVerifiedAgent(pool, workflow);
  await writeAgentVerificationPage(pool, workflow);
  await completeAgentVerification(pool, workflow, clock);
  await finishAgentVerification(pool, workflow, clock);
  await finish(reversal);
  expect((await get(`/v1/accounts?agent=${subject}`)).body.accounts).toHaveLength(1);
  expect((await get(`/v1/accounts?handle=${account.handle}`)).body.accounts[0]).toMatchObject({
    verified: true,
    subject: { id: subject },
  });
  expect(await pointer(subject)).toHaveLength(1);
});
