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
import { actionCatalogue, IDEMPOTENCY_HEADER, requestDigest } from '../../src/http/request.ts';
import { EVENT_TYPES } from '../../src/events/log.ts';
import { migrate } from '../../scripts/database.ts';
import { dropTestDatabase } from '../support/drop-test-database.ts';
import { accountToken, admittedAccess } from '../support/admitted-access.ts';
import { runCommand, noEffect } from '../../src/command/command.ts';
import {
  loadAccountIdentitySource,
  deliverAccountIdentity,
  probeAccountIdentityPublication,
  assertAccountIdentitySource,
} from '../../src/access/agent-verification-identity.ts';

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

/** Original native pre-intent-table reversal body; no trigger disabling or fabricated historical receipt. */
async function originalReversal(account: Seeded, withBasis = true) {
  const actor = await authenticateAccount(
    access,
    { pool, deadline: Date.now() + 10_000 },
    {
      accountId: account.id,
      clientId: 'original-reversal',
      scopes: ['account:update'],
    },
  );
  return runCommand(
    pool,
    {
      partition: accountRoute >>> 4,
      ...(withBasis
        ? { basis: { actorAccountId: account.id, clientId: actor.clientId, requestedBy: actor.requestedBy } }
        : {}),
      receipt: {
        actorAccountId: account.id,
        kind: 'access.agent-verification.released',
        key: key(),
        digest: requestDigest('account.reverse_agent_verification', actor, {
          accountId: account.id,
          kind: 'released',
          reason: null,
        }),
      },
    },
    async (tx, { transactionId }) => {
      const previous = (
        await tx.query<{ catalogue: string; verification: string }>(
          `
      WITH previous AS MATERIALIZED (
        SELECT * FROM access.account WHERE route=$1 AND account_id=$2 AND agent_verified FOR UPDATE
      ) UPDATE access.account a SET agent_verified=false,agent_subject_id=NULL,agent_verification_receipt_id=NULL,
        pending_agent_subject_id=p.agent_subject_id,pending_agent_receipt_id=$3,transaction_id=$3
      FROM previous p WHERE a.route=p.route AND a.account_id=p.account_id
      RETURNING p.agent_subject_id AS catalogue,p.agent_verification_receipt_id AS verification`,
          [accountRoute, account.id, transactionId],
        )
      ).rows[0]!;
      const value: AgentVerificationReversal = {
        accountId: account.id,
        receiptId: transactionId,
        requestedBy: account.id,
        kind: 'released',
        reason: null,
        catalogueSubjectId: previous.catalogue,
        verificationReceiptId: previous.verification,
      };
      return {
        value,
        events: [{ type: 'com.rezics.access.agent-verification.reversing.v1', subject: account.id, data: value }],
      };
    },
  );
}

test('original in-flight reversal recovers real original custody with a distinct recovery transaction before publication and success', async () => {
  const { account, subject } = await verified();
  const original = await originalReversal(account);
  const receipt = { kind: 'account-agent.unverify' as const, account: account.id, receipt: original.transactionId };
  const source = await loadAccountIdentitySource(pool, receipt);
  // A serialized recovery association or a copied source object conveys no native admission proof.
  expect(() => assertAccountIdentitySource({ ...source }, receipt)).toThrow('actual released native source custody');
  expect(source.transactionId).toBe(original.transactionId);
  expect(source.epoch).toBe(original.epoch);
  expect(source.position).toBe(original.position);
  expect(source.input.intent).toMatchObject({
    kind: 'unmerge',
    verificationReceipt: original.value.verificationReceiptId,
    release: bundledDigest,
  });
  expect(source.workflowId).toBe(`accounts.agent-verification-reversal:${account.id}:${original.transactionId}`);
  const association = (
    await pool.query(
      `SELECT * FROM access.agent_identity_recovery
    WHERE route=$1 AND account_id=$2 AND direction=$3 AND receipt_id=$4`,
      [accountRoute, account.id, receipt.kind, receipt.receipt],
    )
  ).rows[0];
  expect(association.source_transaction_id).toBe(original.transactionId);
  expect(association.recovery_transaction_id).not.toBe(original.transactionId);
  const recoveredNative = (
    await pool.query(
      `SELECT transaction_id,epoch,position FROM core.receipt
    WHERE partition_no=$1 AND principal_id=$2 AND command_kind='access.agent-identity.recover'`,
      [accountRoute >>> 4, account.id],
    )
  ).rows;
  expect(recoveredNative).toEqual([
    {
      transaction_id: association.recovery_transaction_id,
      epoch: association.recovery_epoch,
      position: association.recovery_position,
    },
  ]);
  // Recovering source data has not published or cleared the original account marker/page.
  await expect(probeAccountIdentityPublication(pool, receipt)).rejects.toThrow();
  expect(await pointer(subject)).toHaveLength(1);
  expect((await accountState(account.id)).pending_agent_receipt_id).toBe(original.transactionId);
  const job = await deliverAccountIdentity(pool, receipt);
  const { identityEpochStore, identityJobPartition } = await import('../../src/semantic/identity-epoch-store.ts');
  const published = (
    await runCommand(pool, { partition: identityJobPartition(job) }, async (tx) =>
      noEffect(await identityEpochStore.readJob(tx, job)),
    )
  ).value;
  expect(published).toMatchObject({
    state: 'published',
    mapping: { state: 'complete' },
    participants: {
      'search-canonical-index': { state: 'complete' },
      'library-private-follow-counts': { state: 'complete' },
    },
  });
  await finish(original.value);
  expect(await pointer(subject)).toEqual([]);
  expect((await accountState(account.id)).pending_agent_receipt_id).toBeNull();
  expect((await loadAccountIdentitySource(pool, receipt)).digest).toBe(source.digest);
  expect(await deliverAccountIdentity(pool, receipt)).toEqual(job);
  expect(
    (
      await pool.query(
        `SELECT transaction_id FROM core.receipt WHERE partition_no=$1 AND principal_id=$2
    AND command_kind='access.agent-identity.recover'`,
        [accountRoute >>> 4, account.id],
      )
    ).rows,
  ).toEqual([{ transaction_id: association.recovery_transaction_id }]);
  await expect(
    pool.query(
      `UPDATE access.agent_identity_recovery SET intent_digest=repeat('0',64)
    WHERE route=$1 AND account_id=$2`,
      [accountRoute, account.id],
    ),
  ).rejects.toThrow('Immutable account identity source');
});

test('a retained reversal payload without the original native write basis cannot recover from mutable account state', async () => {
  const { account, subject } = await verified();
  const original = await originalReversal(account, false);
  const receipt = { kind: 'account-agent.unverify' as const, account: account.id, receipt: original.transactionId };
  await expect(loadAccountIdentitySource(pool, receipt)).rejects.toThrow(
    'original native reversal receipt/write_basis',
  );
  expect(
    (
      await pool.query('SELECT * FROM access.agent_identity_recovery WHERE route=$1 AND account_id=$2', [
        accountRoute,
        account.id,
      ])
    ).rows,
  ).toEqual([]);
  expect(await pointer(subject)).toHaveLength(1);
  expect((await accountState(account.id)).pending_agent_receipt_id).toBe(original.transactionId);
});

test('Original native Account identity writers enroll actual generated receipt outbox and durable copies at serialization before data loss with real full role union and native receiving custody, preserving unknown historical association as pending', async () => {
  const { readAgentIdentityCopies, readAgentIdentityCopyReceiving } =
    await import('../../src/history/agent-identity-source.ts');
  const { AGENT_IDENTITY_DURABLE_ASSOCIATION } = await import('../../src/history/durable.ts');
  const { ACCOUNT_ROLE_BITS } = await import('../../src/history/contracts.ts');
  const { encodeLocator } = await import('../../src/history/locator.ts');
  const { commandHistoryKind } = await import('../../src/history/record.ts');
  const account = await seedAccount(`copy_${randomUUID().slice(0, 8)}`, { kind: 'organization' });
  await pool.query(
    `INSERT INTO access.resource_grant(route,resource_id,subject_id,action,valid,transaction_id)
     VALUES($1,$2,$3,'account:manage','(,)',$3)`,
    [accountRoute, account.id, manager.id],
  );
  const subject = await catalogueSubject('schema:Organization', 'Original identity copies');
  const applied = await request(account, subject, await bearer(manager));
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
  const source = (
    await pool.query(
      `SELECT * FROM access.agent_identity_intent WHERE route=$1 AND account_id=$2
     AND direction='account-agent.verify' AND receipt_id=$3`,
      [accountRoute, account.id, workflow.receiptId],
    )
  ).rows[0];
  const key = {
    route: accountRoute,
    accountId: account.id,
    direction: 'account-agent.verify' as const,
    receiptId: workflow.receiptId,
  };
  const copies = (
    await pool.query(
      `SELECT * FROM core.agent_identity_history_copy WHERE partition_no=$1 AND source_route=$2 AND source_account_id=$3
     AND source_direction=$4 AND source_receipt_id=$5 ORDER BY artifact_type,locator`,
      [source.source_partition, key.route, key.accountId, key.direction, key.receiptId],
    )
  ).rows;
  expect(copies.map((copy) => copy.artifact_type)).toEqual(['command-receipt/v1', 'outbox-event/v1']);
  for (const copy of copies) {
    expect(copy.source_digest).toBe(source.intent_digest);
    expect(copy.source_epoch).toBe(source.source_epoch);
    expect(String(copy.source_position)).toBe(String(source.source_position));
    expect(copy.source_transaction_id).toBe(source.source_transaction_id);
    expect(copy.receiver_epoch).toBe(source.source_epoch);
    expect(copy.writer_version).toBe(1);
  }
  const first = await readAgentIdentityCopies(pool, [key], { deadline: Date.now() + 5000 });
  expect(first.state).toBe('sealed');
  expect(first.artifact?.accounts).toEqual(
    expect.arrayContaining([
      { accountRoute, accountId: account.id, roles: ACCOUNT_ROLE_BITS.subject },
      { accountRoute, accountId: manager.id, roles: ACCOUNT_ROLE_BITS.actor | ACCOUNT_ROLE_BITS.principal },
      { accountRoute, accountId: staff.id, roles: ACCOUNT_ROLE_BITS.reviewer },
    ]),
  );
  const receiptLocator = first.artifact!.locator;
  if (receiptLocator.artifactType !== 'command-receipt/v1') throw new Error('Expected the actual native receipt');
  const actualToken = `rk1.${receiptLocator.keyVersion}.${Buffer.from(receiptLocator.keyToken, 'hex').toString('base64url')}`;
  expect(actualToken).toBe(source.native_receipt_key);
  expect(commandHistoryKind(receiptLocator.commandKindId)).toBe(source.native_command_kind);
  expect(Buffer.from(encodeLocator(receiptLocator))).toEqual(copies[0].locator);
  const receipt = (
    await pool.query(
      `SELECT transaction_id,position FROM core.receipt WHERE partition_no=$1 AND principal_kind=$2
     AND principal_id=$3 AND command_kind=$4 AND idempotency_key=$5`,
      [
        source.source_partition,
        receiptLocator.principalKind,
        receiptLocator.principalId,
        source.native_command_kind,
        actualToken,
      ],
    )
  ).rows[0];
  expect(receipt.transaction_id).toBe(source.source_transaction_id);
  const second = await readAgentIdentityCopies(pool, [key], { deadline: Date.now() + 5000 }, first.cursor!);
  expect(second.artifact?.accounts).toEqual(first.artifact!.accounts);
  const outbox = second.artifact!.locator;
  if (outbox.artifactType !== 'outbox-event/v1') throw new Error('Expected the actual native outbox slot');
  expect(outbox.position).toBe(BigInt(receipt.position));
  expect(outbox.eventSeq).toBe(0);
  expect(Buffer.from(encodeLocator(outbox))).toEqual(copies[1].locator);
  // The genuine native ORIGINAL writer cut seals independently of this unverified receiving
  // read or page EOF. It is not a receiving receipt, SDK future-writer closure, Source terminal
  // discharge or erasure ACK.
  const receiving = await readAgentIdentityCopyReceiving(
    { pool },
    {
      accountRoute,
      accountId: account.id,
      version: 1,
      at: clock().toISOString(),
    },
    [key],
    { deadline: Date.now() + 5000 },
  );
  expect(receiving.receipt).toBeNull();
  expect(receiving.state).toBe('sealed');
  const end = await readAgentIdentityCopies(pool, [key], { deadline: Date.now() + 5000 }, second.cursor!);
  expect(end.artifact).toBeNull();
  expect(end.gap).toBeNull();
  expect(end.state).toBe('sealed');
  const unknown = await readAgentIdentityCopies(pool, [{ ...key, receiptId: randomUUID() }], {
    deadline: Date.now() + 5000,
  });
  expect(unknown.artifact).toBeNull();
  expect(unknown.state).toBe('pending');
  expect(AGENT_IDENTITY_DURABLE_ASSOCIATION.gap).toBe('agent-identity-sdk-recording-port-unavailable');
  // Receipt replay does not rebind the original source or add guessed copies.
  await recordPendingAgentVerification(pool, workflow, clock);
  expect(
    (
      await pool.query(
        'SELECT count(*)::integer AS n FROM core.agent_identity_history_copy WHERE partition_no=$1 AND source_account_id=$2',
        [source.source_partition, account.id],
      )
    ).rows[0].n,
  ).toBe(2);
});

test('identity source declaration rejects foreign live commands and post-serialization keys without enrolling copies', async () => {
  const { declareAgentIdentitySource, readAgentIdentityCopies } =
    await import('../../src/history/agent-identity-source.ts');
  const { beginRecordHistorySerialization } = await import('../../src/history/record-source.ts');
  const { runCommand, noEffect } = await import('../../src/command/command.ts');
  const { partitionOf } = await import('../../src/route/route.ts');
  const key = {
    route: accountRoute,
    accountId: manager.id,
    direction: 'account-agent.verify' as const,
    receiptId: randomUUID(),
  };
  await expect(
    runCommand(pool, { partition: partitionOf(accountRoute) }, async (tx) => {
      await declareAgentIdentitySource(tx, key, 'a'.repeat(64));
      return noEffect(null);
    }),
  ).rejects.toThrow('actual original source writer');
  await expect(
    runCommand(pool, { partition: partitionOf(accountRoute) }, async (tx) => {
      beginRecordHistorySerialization(tx);
      await declareAgentIdentitySource(tx, key, 'a'.repeat(64));
      return noEffect(null);
    }),
  ).rejects.toThrow('late Agent identity');
  await expect(
    readAgentIdentityCopies(
      pool,
      Array.from({ length: 9 }, () => ({ ...key, receiptId: randomUUID() })),
      {
        deadline: Date.now() + 5000,
      },
    ),
  ).rejects.toThrow('one to eight');
  expect((await readAgentIdentityCopies(pool, [key], { deadline: Date.now() + 5000 })).artifact).toBeNull();
});

test('original reversal serializers enroll both actual outbox slots and preserve the genuine undo role union', async () => {
  const { readAgentIdentityCopies } = await import('../../src/history/agent-identity-source.ts');
  const { ACCOUNT_ROLE_BITS: roles } = await import('../../src/history/contracts.ts');
  const { account, token } = await verified('organization');
  const released = await post(`/v1/accounts/${account.id}:releaseVerification`, token);
  expect(released.response.status).toBe(200);
  const reversal = released.body.reversal as AgentVerificationReversal;
  const key = {
    route: accountRoute,
    accountId: account.id,
    direction: 'account-agent.unverify' as const,
    receiptId: reversal.receiptId,
  };
  const copies = (
    await pool.query(
      `SELECT artifact_type,locator,source_transaction_id,source_receipt_id FROM core.agent_identity_history_copy
     WHERE partition_no=$1 AND source_route=$2 AND source_account_id=$3 AND source_direction=$4 AND source_receipt_id=$5
     ORDER BY artifact_type,locator`,
      [accountRoute >> 4, key.route, key.accountId, key.direction, key.receiptId],
    )
  ).rows;
  expect(copies.map((row) => row.artifact_type)).toEqual(['command-receipt/v1', 'outbox-event/v1', 'outbox-event/v1']);
  expect(
    copies.every(
      (row) => row.source_transaction_id === reversal.receiptId && row.source_receipt_id === reversal.receiptId,
    ),
  ).toBe(true);
  const receipt = await readAgentIdentityCopies(pool, [key], { deadline: Date.now() + 5000 });
  const role = (accountId: string) => receipt.artifact!.accounts.find((ref) => ref.accountId === accountId)!.roles;
  expect(role(account.id) & roles.subject).toBe(roles.subject);
  expect(role(manager.id) & (roles.actor | roles.principal)).toBe(roles.actor | roles.principal);
  expect(role(staff.id) & roles.reviewer).toBe(roles.reviewer);
  const event0 = await readAgentIdentityCopies(pool, [key], { deadline: Date.now() + 5000 }, receipt.cursor!);
  const event1 = await readAgentIdentityCopies(pool, [key], { deadline: Date.now() + 5000 }, event0.cursor!);
  expect(event0.artifact!.accounts).toEqual(receipt.artifact!.accounts);
  expect(event1.artifact!.accounts).toEqual(receipt.artifact!.accounts);
  expect(event0.artifact!.locator).toMatchObject({ artifactType: 'outbox-event/v1', eventSeq: 0 });
  expect(event1.artifact!.locator).toMatchObject({ artifactType: 'outbox-event/v1', eventSeq: 1 });
});

test('New fully converted original identity source has a genuine sealed finite generated-copy inventory and every current receiving copy is independently verified before source minimization while unknown old copies stay pending', async () => {
  const { readAgentIdentityNativeInventory, readAgentIdentityInventory, verifyAgentIdentityInventory } =
    await import('../../src/history/agent-identity-inventory.ts');
  const { readAgentIdentityCopies } = await import('../../src/history/agent-identity-source.ts');
  const { partitionOf } = await import('../../src/route/route.ts');
  const { encodeLocator } = await import('../../src/history/locator.ts');
  const { withConnection } = await import('../../src/database/pool.ts');
  const { sealHistoryAccount } = await import('../../src/history/gates.ts');
  const { recordHistoryReceivingProof } = await import('../../src/history/receiving.ts');
  const { ACCOUNT_ROLE_BITS } = await import('../../src/history/contracts.ts');
  const account = await seedAccount(`inventory_${randomUUID().slice(0, 8)}`, { kind: 'organization' });
  await pool.query(
    `INSERT INTO access.resource_grant(route,resource_id,subject_id,action,valid,transaction_id)
     VALUES($1,$2,$3,'account:manage','(,)',$3)`,
    [accountRoute, account.id, manager.id],
  );
  const subject = await catalogueSubject('schema:Organization', 'Original inventory');
  const applied = await request(account, subject, await bearer(manager));
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
  const sourceKey = {
    route: accountRoute,
    accountId: account.id,
    direction: 'account-agent.verify' as const,
    receiptId: workflow.receiptId,
  };
  const context = () => ({ deadline: Date.now() + 5000 });
  const inventory = await readAgentIdentityNativeInventory(pool, sourceKey, context());
  expect(inventory.state).toBe('sealed');
  if (inventory.state !== 'sealed') throw new Error('Expected genuine original native cut');
  const proof = inventory.proof;
  const source = (
    await pool.query(
      `SELECT * FROM access.agent_identity_intent WHERE route=$1 AND account_id=$2 AND direction=$3 AND receipt_id=$4`,
      [sourceKey.route, sourceKey.accountId, sourceKey.direction, sourceKey.receiptId],
    )
  ).rows[0];
  expect(proof.original).toEqual({
    key: sourceKey,
    partition: source.source_partition,
    epoch: source.source_epoch,
    position: BigInt(source.source_position),
    transactionId: source.source_transaction_id,
    digest: source.intent_digest,
  });
  expect(proof.artifacts.map((artifact) => artifact.locator.artifactType)).toEqual([
    'command-receipt/v1',
    'outbox-event/v1',
  ]);
  for (const artifact of proof.artifacts)
    expect(artifact.accounts).toEqual(
      expect.arrayContaining([
        { accountRoute, accountId: account.id, roles: ACCOUNT_ROLE_BITS.subject },
        { accountRoute, accountId: manager.id, roles: ACCOUNT_ROLE_BITS.actor | ACCOUNT_ROLE_BITS.principal },
        { accountRoute, accountId: staff.id, roles: ACCOUNT_ROLE_BITS.reviewer },
      ]),
    );
  // A real source cut exists independently of page cardinality, including after page EOF.
  const first = await readAgentIdentityCopies(pool, [sourceKey], context());
  const second = await readAgentIdentityCopies(pool, [sourceKey], context(), first.cursor!);
  const end = await readAgentIdentityCopies(pool, [sourceKey], context(), second.cursor!);
  expect(end.state).toBe('sealed');
  expect(end.artifact).toBeNull();
  const unknown = { ...sourceKey, receiptId: randomUUID() };
  expect(await readAgentIdentityNativeInventory(pool, unknown, context())).toMatchObject({ state: 'pending' });
  expect(await readAgentIdentityCopies(pool, [unknown], context())).toMatchObject({
    state: 'pending',
    gap: 'agent-identity-original-inventory-unsealed',
    artifact: null,
  });
  // Replay preserves the exact original generation, tuple, obligation and copy membership.
  await recordPendingAgentVerification(pool, workflow, clock);
  expect(await readAgentIdentityNativeInventory(pool, sourceKey, context())).toEqual(inventory);
  const erased = (
    await pool.query(
      'INSERT INTO access.erasure(route,account_id,version,at) VALUES($1,$2,1,now()) RETURNING version,at::text',
      [accountRoute, account.id],
    )
  ).rows[0];
  const barrier = { accountRoute, accountId: account.id, version: erased.version, at: erased.at };
  const verify = (candidate = proof) =>
    runCommand(pool, { partition: partitionOf(accountRoute) }, async (tx) =>
      noEffect(await verifyAgentIdentityInventory(tx, barrier, sourceKey, candidate)),
    );
  expect((await verify()).value.native).toBe('pending');
  // Existing fixture models the physical owners' committed dispositions, then invokes the real
  // receiving recorder. Each receipt remains independently mandatory; source payload is retained.
  for (let index = 0; index < proof.artifacts.length; index++) {
    const artifact = proof.artifacts[index]!;
    await withConnection(pool, async (tx) => {
      await tx.query('BEGIN');
      try {
        await sealHistoryAccount(tx, artifact.partition, accountRoute, account.id);
        if (artifact.locator.artifactType === 'command-receipt/v1') {
          await tx.query(
            `UPDATE core.receipt SET response='null'::jsonb,payload_state='minimized'
            WHERE partition_no=$1 AND transaction_id=$2 AND command_kind=$3 AND idempotency_key=$4`,
            [artifact.partition, source.source_transaction_id, source.native_command_kind, source.native_receipt_key],
          );
        } else if (artifact.locator.artifactType === 'outbox-event/v1') {
          await tx.query(
            `UPDATE core.outbox SET data='{}'::jsonb,subject=NULL,payload_state='minimized'
            WHERE partition_no=$1 AND position=$2 AND event_seq=$3`,
            [artifact.partition, artifact.locator.position.toString(), artifact.locator.eventSeq],
          );
        }
        await tx.query(
          `UPDATE core.history_locator SET state='minimized',proof_barrier=$2
          WHERE partition_no=$1 AND account_id=$2 AND artifact_type=$3 AND locator=$4`,
          [artifact.partition, account.id, artifact.locator.artifactType, Buffer.from(encodeLocator(artifact.locator))],
        );
        expect(await recordHistoryReceivingProof(tx, barrier, artifact.partition, artifact.locator)).toBeNull();
        await tx.query('COMMIT');
      } catch (error) {
        await tx.query('ROLLBACK');
        throw error;
      }
    });
    const current = (await verify()).value;
    expect(current.native).toBe(index === proof.artifacts.length - 1 ? 'verified' : 'pending');
  }
  expect((await verify()).value).toEqual({
    state: 'pending',
    native: 'verified',
    gap: 'agent-identity-sdk-recording-port-unavailable',
  });
  expect(await readAgentIdentityInventory({ pool }, barrier, sourceKey, context())).toMatchObject({
    state: 'pending',
    native: 'sealed',
    gap: 'agent-identity-sdk-recording-port-unavailable',
  });
  expect((await verify({ ...proof, artifacts: proof.artifacts.slice(0, 1) })).value.native).toBe('pending');
  expect(
    (
      await pool.query(
        `SELECT minimized FROM access.agent_identity_intent
    WHERE route=$1 AND account_id=$2 AND direction=$3 AND receipt_id=$4`,
        [sourceKey.route, sourceKey.accountId, sourceKey.direction, sourceKey.receiptId],
      )
    ).rows[0].minimized,
  ).toBe(false);
  // Later enrollment serializes with holds and invalidates the old cut even without adding a copy.
  await pool.query(
    `UPDATE core.agent_identity_sdk_obligation SET generation=generation+1
    WHERE partition_no=$1 AND source_route=$2 AND source_account_id=$3 AND source_direction=$4 AND source_receipt_id=$5`,
    [proof.original.partition, sourceKey.route, sourceKey.accountId, sourceKey.direction, sourceKey.receiptId],
  );
  expect((await verify()).value.gap).toBe('agent-identity-native-cut-stale');
  const refreshed = await readAgentIdentityNativeInventory(pool, sourceKey, context());
  if (refreshed.state !== 'sealed') throw new Error('Expected refreshed native inventory');
  await pool.query(
    `UPDATE core.history_locator SET roles=roles | $5
    WHERE partition_no=$1 AND account_id=$2 AND artifact_type=$3 AND locator=$4`,
    [
      proof.original.partition,
      staff.id,
      proof.artifacts[0]!.locator.artifactType,
      Buffer.from(encodeLocator(proof.artifacts[0]!.locator)),
      ACCOUNT_ROLE_BITS.actor,
    ],
  );
  expect((await verify(refreshed.proof)).value.gap).toBe('agent-identity-native-cut-stale');
});

test('identity inventory rejects foreign source declarations and late native enrollment', async () => {
  const { declareAgentIdentitySource } = await import('../../src/history/agent-identity-source.ts');
  const { beginRecordHistorySerialization } = await import('../../src/history/record-source.ts');
  const { partitionOf } = await import('../../src/route/route.ts');
  const sourceKey = {
    route: accountRoute,
    accountId: manager.id,
    direction: 'account-agent.verify' as const,
    receiptId: randomUUID(),
  };
  await expect(
    runCommand(pool, { partition: partitionOf(accountRoute) }, async (tx) => {
      await declareAgentIdentitySource(tx, sourceKey, 'a'.repeat(64));
      return noEffect(null);
    }),
  ).rejects.toThrow('actual original source writer');
  await expect(
    runCommand(pool, { partition: partitionOf(accountRoute) }, async (tx) => {
      beginRecordHistorySerialization(tx);
      await declareAgentIdentitySource(tx, sourceKey, 'a'.repeat(64));
      return noEffect(null);
    }),
  ).rejects.toThrow('late Agent identity');
});

test('Actual original account identity SDK enqueue and all retained workflow-step copies receive native original-source association before source loss while original IDs steps retry and publication remain unchanged', async () => {
  const { createWorkClient } = await import('../../src/work/client.ts');
  const { enqueueAgentIdentityVerification } = await import('../../src/history/agent-identity-work.ts');
  const { lookupAgentIdentityReceivingCopies } = await import('../../src/history/agent-identity-source.ts');
  const { ACCOUNT_ROLE_BITS } = await import('../../src/history/contracts.ts');
  const account = await seedAccount(`sdk_custody_${randomUUID().slice(0, 8)}`);
  const token = await bearer(account);
  await ensureAccountAgent(pool, { account: account.id, kind: 'person', name: account.displayName, language: 'en' });
  const subject = await catalogueSubject('schema:Person', 'Original SDK custody');
  const applied = await request(account, subject, token);
  expect(applied.response.status).toBe(201);
  const requestId = applied.body.verificationRequest.id as string;
  expect((await post(`/v1/verification-requests/${requestId}:approve`, await bearer(staff), {})).response.status).toBe(
    200,
  );
  const original = (await readAgentVerificationWorkflowRequest(pool, requestId))!;
  const receiptId = original.decisionReceiptId!;
  const workflowId = `accounts.agent-verification:${requestId}:${receiptId}`;
  const client = await createWorkClient(databaseUrl, pool);
  try {
    await client.registerQueue('workflows', {});
    expect(await enqueueAgentIdentityVerification(pool, client, requestId, receiptId)).toBe('admitted');
    const initial = (
      await pool.query('SELECT *,receiver_xid::text AS creation FROM core.agent_identity_work WHERE workflow_id=$1', [
        workflowId,
      ])
    ).rows[0];
    expect(initial.source).toBeNull();
    expect(initial.approval.transactionId).toBe(receiptId);
    expect(initial.approval.requestId).toBe(requestId);
    expect(initial.creation_captured).toBe(true);
    expect(initial.custody_id).not.toBe(workflowId);
    expect(initial.accounts).toEqual(
      expect.arrayContaining([
        {
          accountRoute,
          accountId: account.id,
          roles: ACCOUNT_ROLE_BITS.subject | ACCOUNT_ROLE_BITS.actor | ACCOUNT_ROLE_BITS.principal,
        },
        { accountRoute, accountId: staff.id, roles: ACCOUNT_ROLE_BITS.reviewer | ACCOUNT_ROLE_BITS.principal },
      ]),
    );
    expect(
      (
        await pool.query(
          'SELECT 1 FROM access.agent_identity_intent WHERE route=$1 AND account_id=$2 AND receipt_id=$3',
          [accountRoute, account.id, receiptId],
        )
      ).rows,
    ).toHaveLength(0);
    const sdkInput = (await pool.query('SELECT inputs FROM dbos.workflow_input WHERE workflow_uuid=$1', [workflowId]))
      .rows[0].inputs;
    expect(sdkInput).toContain(requestId);
    expect(sdkInput).toContain(receiptId);

    const program = `
      import { createPool } from './src/database/pool.ts';
      import { createWorkClient } from './src/work/client.ts';
      import { composeWork } from './src/work/registry.ts';
      import { registerAgentVerificationWork } from './src/access/agent-verification-work.ts';
      const pool = createPool(process.env.DATABASE_URL);
      const client = await createWorkClient(process.env.DATABASE_URL, pool);
      const work = await composeWork([{ name: 'accounts', register: registerAgentVerificationWork }], {
        pool, client, databaseUrl: process.env.DATABASE_URL, executorId: 'identity-sdk-custody-test',
      });
      try {
        await work.launch();
        await client.retrieveWorkflow(process.env.IDENTITY_WORKFLOW).getResult();
      } finally { await work.shutdown(); await client.close(); await pool.end(); }
    `;
    const child = Bun.spawn([process.execPath, '-e', program], {
      cwd: new URL('../..', import.meta.url).pathname,
      env: { ...process.env, DATABASE_URL: databaseUrl, IDENTITY_WORKFLOW: workflowId },
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const deadline = setTimeout(() => child.kill('SIGKILL'), 60_000);
    try {
      const [status, errors] = await Promise.all([
        child.exited,
        new Response(child.stderr).text(),
        new Response(child.stdout).text(),
      ]);
      expect(status, errors).toBe(0);
    } finally {
      clearTimeout(deadline);
    }

    const bound = (
      await pool.query('SELECT *,receiver_xid::text AS creation FROM core.agent_identity_work WHERE workflow_id=$1', [
        workflowId,
      ])
    ).rows[0];
    expect(bound.custody_id).toBe(initial.custody_id);
    expect(bound.creation).toBe(initial.creation);
    expect(bound.approval).toEqual(initial.approval);
    const source = await loadAccountIdentitySource(pool, {
      kind: 'account-agent.verify',
      account: account.id,
      receipt: receiptId,
    });
    expect(bound.source).toMatchObject({
      transactionId: source.transactionId,
      partition: source.partition,
      epoch: source.epoch,
      position: source.position.toString(),
      digest: source.digest,
      release: source.input.intent.release,
      workflowId,
    });
    expect(bound.source.transactionId).not.toBe(receiptId);
    const steps = (
      await pool.query('SELECT function_name FROM dbos.operation_outputs WHERE workflow_uuid=$1 ORDER BY function_id', [
        workflowId,
      ])
    ).rows.map((row) => row.function_name);
    expect([...new Set(steps.filter((name) => name.startsWith('accounts.agent-verification.')))]).toEqual([
      'accounts.agent-verification.read-decision',
      'accounts.agent-verification.record-pending',
      'accounts.agent-verification.merge',
      'accounts.agent-verification.write-page',
      'accounts.agent-verification.complete',
      'accounts.agent-verification.finish',
      'accounts.agent-verification.publication',
    ]);
    expect(await probeAccountIdentityPublication(pool, source.input.receipt)).toBeDefined();
    expect(await lookupAgentIdentityReceivingCopies(pool, [source.input.receipt])).toEqual([
      {
        state: 'associated',
        artifact: {
          partition: 0,
          locator: { artifactType: 'durable-work/v1', workId: initial.custody_id },
          accounts: initial.accounts,
        },
      },
    ]);
    const retained = (
      await pool.query('SELECT owner_ready,state FROM core.history_work WHERE partition_no=0 AND work_id=$1', [
        initial.custody_id,
      ])
    ).rows[0];
    expect(retained).toEqual({ owner_ready: false, state: 'pending' });
    expect(await enqueueAgentIdentityVerification(pool, client, requestId, receiptId)).toBe('admitted');
    expect(
      (await pool.query('SELECT inputs FROM dbos.workflow_input WHERE workflow_uuid=$1', [workflowId])).rows[0].inputs,
    ).toBe(sdkInput);
    await expect(
      pool.query('DELETE FROM access.agent_identity_intent WHERE route=$1 AND account_id=$2 AND receipt_id=$3', [
        accountRoute,
        account.id,
        receiptId,
      ]),
    ).rejects.toThrow('receiving erasure custody');
  } finally {
    await client.close();
  }
}, 90_000);

test('original reversal SDK custody binds the existing exact source and rejects changed native arguments while uncovered older SDK creation stays pending', async () => {
  const { createWorkClient } = await import('../../src/work/client.ts');
  const { enqueueAgentIdentityReversal } = await import('../../src/history/agent-identity-work.ts');
  const { lookupAgentIdentityReceivingCopies } = await import('../../src/history/agent-identity-source.ts');
  const { account, token } = await verified();
  const released = await post(`/v1/accounts/${account.id}:releaseVerification`, token);
  const decision = released.body.reversal as AgentVerificationReversal;
  const source = await loadAccountIdentitySource(pool, {
    kind: 'account-agent.unverify',
    account: account.id,
    receipt: decision.receiptId,
  });
  const client = await createWorkClient(databaseUrl, pool);
  try {
    await client.registerQueue('workflows', {});
    await expect(
      enqueueAgentIdentityReversal(pool, client, { ...decision, reason: 'foreign replacement' }),
    ).rejects.toThrow('mismatched');
    expect(await enqueueAgentIdentityReversal(pool, client, decision)).toBe('admitted');
    const native = (
      await pool.query('SELECT * FROM core.agent_identity_work WHERE workflow_id=$1', [source.workflowId])
    ).rows[0];
    expect(native.source).toMatchObject({
      digest: source.digest,
      transactionId: source.transactionId,
      workflowId: source.workflowId,
    });
    expect(native.approval).toBeNull();
    expect(native.creation_captured).toBe(true);
    expect((await lookupAgentIdentityReceivingCopies(pool, [source.input.receipt]))[0]?.state).toBe('associated');

    const other = await verified();
    const legacy = (await post(`/v1/accounts/${other.account.id}:releaseVerification`, other.token)).body
      .reversal as AgentVerificationReversal;
    const legacyId = `accounts.agent-verification-reversal:${legacy.accountId}:${legacy.receiptId}`;
    await client.enqueue(
      { workflowName: 'accounts.agent-verification-reversal', queueName: 'workflows', workflowID: legacyId },
      legacy,
    );
    await enqueueAgentIdentityReversal(pool, client, legacy);
    expect(
      (
        await lookupAgentIdentityReceivingCopies(pool, [
          { kind: 'account-agent.unverify', account: legacy.accountId, receipt: legacy.receiptId },
        ])
      )[0]?.state,
    ).toBe('pending');
  } finally {
    await client.close();
  }
});

test('accepted original reversal Source recovers without the old Accounts verification source and keeps its current job distinct from prior undo', async () => {
  const { identityEpochStore: store } = await import('../../src/semantic/identity-epoch-store.ts');
  const { stepIdentityEpochAdmission } = await import('../../src/semantic/identity-epoch-admission.ts');
  const { readOriginalAccountAgentIdentity } = await import('../../src/semantic/account-agent-identity-recovery.ts');
  const { account, subject, token } = await verified();
  const released = await post(`/v1/accounts/${account.id}:releaseVerification`, token);
  expect(released.response.status).toBe(200);
  const reversal = released.body.reversal as AgentVerificationReversal;
  const receipt = { kind: 'account-agent.unverify' as const, account: account.id, receipt: reversal.receiptId };
  const before = await loadAccountIdentitySource(pool, receipt);
  const job = await store.prepareAdmission(pool, {}, before.input);
  for (let page = 0; page < 512; page++) {
    const progress = await stepIdentityEpochAdmission(pool, job);
    if (progress.state === 'pending') break;
    expect(progress.state).toBe('preparing');
    if (page === 511) throw new Error('Original Source admission did not finish');
  }
  const original = (await readOriginalAccountAgentIdentity(pool, {
    account: account.id,
    direction: receipt.kind,
    receipt: receipt.receipt,
  }))!;
  expect(original).not.toBeNull();
  expect(original.job).toEqual(job);
  expect(original.priorVerification!.verificationReceipt).toBe(reversal.verificationReceiptId);
  expect(original.input.intent.kind).toBe('unmerge');
  if (original.input.intent.kind !== 'unmerge') throw new Error('Expected original reversal');
  expect(original.input.intent.undoJob).toEqual(original.priorVerification!.job);
  expect(job.jobId).not.toBe(original.priorVerification!.job.jobId);
  const restore = await pool.connect();
  try {
    await restore.query('BEGIN');
    await restore.query("SET LOCAL session_replication_role='replica'");
    await restore.query('DELETE FROM access.agent_identity_intent WHERE route=$1 AND account_id=$2', [
      accountRoute,
      account.id,
    ]);
    await restore.query('COMMIT');
  } finally {
    restore.release();
  }
  const recovered = await loadAccountIdentitySource(pool, receipt);
  expect(recovered.input).toEqual(before.input);
  expect(recovered.transactionId).toBe(before.transactionId);
  expect(recovered.position).toBe(before.position);
  const association = (
    await pool.query(
      `SELECT * FROM access.agent_identity_recovery
    WHERE route=$1 AND account_id=$2 AND direction=$3 AND receipt_id=$4`,
      [accountRoute, account.id, receipt.kind, receipt.receipt],
    )
  ).rows[0]!;
  expect(association.verification_intent_digest).toBe(original.priorVerification!.digest);
  expect(association.original_source.native.transactionId).toBe(original.native.transactionId);
  expect(association.original_source.job.jobId).toBe(job.jobId);
  expect(association.original_source.priorVerification.job.jobId).toBe(original.priorVerification!.job.jobId);
  expect(association.recovery_transaction_id).not.toBe(original.native.transactionId);
  expect(association.recovery_transaction_id).not.toBe(before.transactionId);
  await expect(probeAccountIdentityPublication(pool, receipt)).rejects.toThrow();
  expect(await pointer(subject)).toHaveLength(1);
  expect((await accountState(account.id)).pending_agent_receipt_id).toBe(reversal.receiptId);
  expect(await deliverAccountIdentity(pool, receipt)).toEqual(job);
  await finish(reversal);
  expect(await pointer(subject)).toEqual([]);
  expect((await accountState(account.id)).pending_agent_receipt_id).toBeNull();
  expect((await loadAccountIdentitySource(pool, receipt)).digest).toBe(before.digest);
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
  await expect(loadAccountIdentitySource(pool, receipt)).rejects.toThrow(
    'original native reversal receipt/write_basis',
  );
  expect(
    (
      await pool.query('SELECT 1 FROM access.agent_identity_recovery WHERE route=$1 AND account_id=$2', [
        accountRoute,
        account.id,
      ])
    ).rows,
  ).toEqual([]);
});

test('Close genuine identity SDK future writers and receiving retirement', async () => {
  const { createWorkClient } = await import('../../src/work/client.ts');
  const { enqueueAgentIdentityReversal, AGENT_IDENTITY_WORK_OWNER } =
    await import('../../src/history/agent-identity-work.ts');
  const {
    AGENT_IDENTITY_SDK_RETIREMENT,
    readAgentIdentityRetirementStage,
    verifyAgentIdentityRetirementStage,
    agentIdentityRetirementReadiness,
    readAgentIdentitySDKRetirementGap,
  } = await import('../../src/history/agent-identity-retirement.ts');
  const { minimizeHistoryWork } = await import('../../src/history/durable.ts');
  const { HistoryRegistry } = await import('../../src/history/registry.ts');
  const { encodeLocator } = await import('../../src/history/locator.ts');
  const { partitionOf } = await import('../../src/route/route.ts');
  const { account, token } = await verified();
  const released = await post(`/v1/accounts/${account.id}:releaseVerification`, token);
  expect(released.response.status).toBe(200);
  const decision = released.body.reversal as AgentVerificationReversal;
  await finish(decision);
  const receipt = { kind: 'account-agent.unverify' as const, account: account.id, receipt: decision.receiptId };
  const source = await loadAccountIdentitySource(pool, receipt);
  const job = await probeAccountIdentityPublication(pool, receipt);
  const client = await createWorkClient(databaseUrl, pool);
  try {
    await client.registerQueue('workflows', {});
    expect(await enqueueAgentIdentityReversal(pool, client, decision)).toBe('admitted');
    const native = (
      await pool.query('SELECT * FROM core.agent_identity_work WHERE workflow_id=$1', [source.workflowId])
    ).rows[0];
    const inputs = (
      await pool.query('SELECT inputs FROM dbos.workflow_input WHERE workflow_uuid=$1', [source.workflowId])
    ).rows[0].inputs;
    const erased = (
      await pool.query(
        'INSERT INTO access.erasure(route,account_id,version,at) VALUES($1,$2,1,now()) RETURNING version,at::text',
        [accountRoute, account.id],
      )
    ).rows[0];
    const barrier = { accountId: account.id, accountRoute, version: erased.version, at: erased.at };
    const reference = {
      receipt,
      job,
      barrier,
      erasedRole: 'subject' as const,
      source: {
        partition: source.partition,
        epoch: source.epoch,
        position: source.position,
        transactionId: source.transactionId,
      },
      sourceDigest: source.digest,
    };
    // Real Source/participant publication is already complete. Semantic's retained receipt
    // is still not exhaustive terminal/technical-undo transfer and issues no cleanup proof.
    const stage = await readAgentIdentityRetirementStage(pool, reference, { deadline: Date.now() + 10_000 });
    expect(stage).not.toBeNull();
    if (!stage) throw new Error('Expected original native retirement staging');
    expect(stage.handoff.custodyId).toBe(native.custody_id);
    expect(stage.handoff.source).toEqual(native.source);
    expect(stage.consumer).toBeNull();
    const verify = (candidate = stage) =>
      runCommand(pool, { partition: source.partition }, async (tx) =>
        noEffect(await verifyAgentIdentityRetirementStage(tx, candidate)),
      );
    expect((await verify()).value).toEqual({ state: 'pending', gap: 'identity-source-consumer-custody-pending' });
    expect((await verify({ ...stage, handoff: { ...stage.handoff, generation: '0' } })).value.gap).toBe(
      'identity-sdk-retirement-source-fence-changed',
    );
    await expect(
      runCommand(pool, { partition: 0 }, async (tx) => noEffect(await verifyAgentIdentityRetirementStage(tx, stage))),
    ).rejects.toThrow('SAME native source home');
    const artifact = {
      partition: 0,
      locator: { artifactType: 'durable-work/v1' as const, workId: native.custody_id },
      accounts: native.accounts,
    };
    expect(
      (
        await runCommand(pool, { partition: 0 }, async (tx) =>
          noEffect(await agentIdentityRetirementReadiness(tx, artifact, barrier)),
        )
      ).value,
    ).toEqual({ ready: false, gap: AGENT_IDENTITY_SDK_RETIREMENT.gap });
    expect(
      (
        await runCommand(pool, { partition: 0 }, async (tx) =>
          noEffect(await agentIdentityRetirementReadiness(tx, { ...artifact, accounts: [] }, barrier)),
        )
      ).value,
    ).toEqual({ ready: false, gap: 'identity-sdk-retirement-role-scope-changed' });
    const registry = new HistoryRegistry();
    registry.registerOwner({
      name: AGENT_IDENTITY_WORK_OWNER,
      artifactType: 'durable-work/v1',
      version: 1,
      readiness: agentIdentityRetirementReadiness,
    });
    expect(
      await minimizeHistoryWork(
        pool,
        client,
        { partition_no: 0, account_route: accountRoute, account_id: account.id },
        Buffer.from(encodeLocator(artifact.locator)),
        registry,
        barrier,
      ),
    ).toBe(AGENT_IDENTITY_SDK_RETIREMENT.gap);
    expect(await readAgentIdentitySDKRetirementGap(pool, receipt, { deadline: Date.now() + 5000 })).toBe(
      AGENT_IDENTITY_SDK_RETIREMENT.gap,
    );
    expect(
      await readAgentIdentitySDKRetirementGap(
        pool,
        { ...receipt, receipt: randomUUID() },
        { deadline: Date.now() + 5000 },
      ),
    ).toBe('agent-identity-sdk-recording-port-unavailable');
    // Core rejects a caller's ready flag as well as deletion of permanent native custody.
    await expect(
      pool.query('UPDATE core.history_work SET owner_ready=true WHERE partition_no=0 AND work_id=$1', [
        native.custody_id,
      ]),
    ).rejects.toThrow('durable source transfer and permanent native writer fence');
    await expect(
      pool.query('DELETE FROM core.history_work WHERE partition_no=0 AND work_id=$1', [native.custody_id]),
    ).rejects.toThrow('retirement custody is permanent');
    await expect(
      pool.query(
        `UPDATE core.agent_identity_sdk_obligation SET future_writer_state='closed'
      WHERE partition_no=$1 AND source_route=$2 AND source_account_id=$3 AND source_direction=$4 AND source_receipt_id=$5`,
        [partitionOf(accountRoute), accountRoute, account.id, receipt.kind, receipt.receipt],
      ),
    ).rejects.toThrow();
    expect(
      (
        await pool.query(
          'SELECT owner_ready,state,absence_verified FROM core.history_work WHERE partition_no=0 AND work_id=$1',
          [native.custody_id],
        )
      ).rows[0],
    ).toEqual({ owner_ready: false, state: 'pending', absence_verified: false });
    expect(
      (await pool.query('SELECT inputs FROM dbos.workflow_input WHERE workflow_uuid=$1', [source.workflowId])).rows[0]
        .inputs,
    ).toBe(inputs);
    expect((await client.getWorkflow(source.workflowId))?.status).toBe('ENQUEUED');
    expect(
      (
        await pool.query(
          `SELECT minimized FROM access.agent_identity_intent
      WHERE route=$1 AND account_id=$2 AND direction=$3 AND receipt_id=$4`,
          [accountRoute, account.id, receipt.kind, receipt.receipt],
        )
      ).rows[0].minimized,
    ).toBe(false);
  } finally {
    await client.close();
  }
}, 60_000);

test('Compose genuine SDK permanent fence into identity receiving retirement', async () => {
  const { createWorkClient } = await import('../../src/work/client.ts');
  const { enqueueAgentIdentityReversal } = await import('../../src/history/agent-identity-work.ts');
  const { readAgentIdentityRetirementStage } = await import('../../src/history/agent-identity-retirement.ts');
  const { AGENT_IDENTITY_SDK_FENCE_CONSUMER, readAgentIdentitySDKReceivingBinding, retireAgentIdentitySDKWork } =
    await import('../../src/history/agent-identity-sdk-fence.ts');
  const { account, token } = await verified();
  const released = await post(`/v1/accounts/${account.id}:releaseVerification`, token);
  expect(released.response.status).toBe(200);
  const decision = released.body.reversal as AgentVerificationReversal;
  await finish(decision);
  const receipt = { kind: 'account-agent.unverify' as const, account: account.id, receipt: decision.receiptId };
  const source = await loadAccountIdentitySource(pool, receipt);
  const job = await probeAccountIdentityPublication(pool, receipt);
  const client = await createWorkClient(databaseUrl, pool);
  try {
    await client.registerQueue('workflows', {});
    expect(await enqueueAgentIdentityReversal(pool, client, decision)).toBe('admitted');
    const native = (
      await pool.query('SELECT * FROM core.agent_identity_work WHERE workflow_id=$1', [source.workflowId])
    ).rows[0];
    const input = (
      await pool.query('SELECT inputs FROM dbos.workflow_input WHERE workflow_uuid=$1', [source.workflowId])
    ).rows[0].inputs;
    const erased = (
      await pool.query(
        'INSERT INTO access.erasure(route,account_id,version,at) VALUES($1,$2,1,now()) RETURNING version,at::text',
        [accountRoute, account.id],
      )
    ).rows[0];
    const barrier = { accountId: account.id, accountRoute, version: erased.version, at: erased.at };
    const artifact = {
      partition: 0,
      locator: { artifactType: 'durable-work/v1' as const, workId: native.custody_id },
      accounts: native.accounts,
    };
    const observe = (candidate = artifact, fence = barrier) =>
      runCommand(pool, { partition: 0 }, async (tx) =>
        noEffect(await readAgentIdentitySDKReceivingBinding(tx, candidate, fence)),
      );
    expect((await observe()).value).toEqual({
      state: 'observed',
      binding: {
        kind: AGENT_IDENTITY_SDK_FENCE_CONSUMER.binding,
        custodyId: native.custody_id,
        workflowId: source.workflowId,
        requestDigest: native.request_digest.toString('hex'),
        source: native.source,
        receiver: {
          partition: 0,
          epoch: native.receiver_epoch,
          generation: String(native.receiver_generation),
          writerVersion: 1,
        },
        barrier,
      },
    });
    expect((await observe({ ...artifact, accounts: [] })).value).toEqual({
      state: 'pending',
      gap: 'identity-sdk-retirement-role-scope-changed',
    });
    expect((await observe(artifact, { ...barrier, version: barrier.version + 1 })).value).toEqual({
      state: 'pending',
      gap: 'identity-sdk-retirement-barrier-changed',
    });
    expect((await observe({ ...artifact, locator: { ...artifact.locator, workId: randomUUID() } })).value).toEqual({
      state: 'pending',
      gap: 'identity-sdk-native-binding-unavailable',
    });
    await expect(
      runCommand(pool, { partition: source.partition }, async (tx) =>
        noEffect(await readAgentIdentitySDKReceivingBinding(tx, artifact, barrier)),
      ),
    ).rejects.toThrow('SAME receiving home');
    const stage = await readAgentIdentityRetirementStage(
      pool,
      {
        receipt,
        job,
        barrier,
        erasedRole: 'subject',
        source: {
          partition: source.partition,
          epoch: source.epoch,
          position: source.position,
          transactionId: source.transactionId,
        },
        sourceDigest: source.digest,
      },
      { deadline: Date.now() + 10_000 },
    );
    if (!stage) throw new Error('Expected genuine original source staging');
    expect(await retireAgentIdentitySDKWork(pool, client, stage, { deadline: Date.now() + 10_000 })).toEqual({
      state: 'pending',
      gap: 'identity-source-consumer-custody-pending',
    });
    expect(
      await retireAgentIdentitySDKWork(
        pool,
        client,
        {
          ...stage,
          handoff: { ...stage.handoff, generation: '0' },
        },
        { deadline: Date.now() + 10_000 },
      ),
    ).toEqual({
      state: 'pending',
      gap: 'identity-sdk-retirement-source-fence-changed',
    });
    // An observed receiver is not the missing Semantic durable transfer or native SDK receipt.
    expect((await client.getWorkflow(source.workflowId))?.status).toBe('ENQUEUED');
    expect(
      (await pool.query('SELECT inputs FROM dbos.workflow_input WHERE workflow_uuid=$1', [source.workflowId])).rows[0]
        .inputs,
    ).toBe(input);
    expect(
      (
        await pool.query(
          'SELECT owner_ready,state,absence_verified FROM core.history_work WHERE partition_no=0 AND work_id=$1',
          [native.custody_id],
        )
      ).rows[0],
    ).toEqual({ owner_ready: false, state: 'pending', absence_verified: false });
  } finally {
    await client.close();
  }
}, 60_000);

test('A copied SDK fence cannot discharge a retained original identity consumer', async () => {
  const { createWorkClient } = await import('../../src/work/client.ts');
  const {
    enqueueAgentIdentityReversal,
    readAgentIdentityRetirementStage,
    readAgentIdentitySDKReceivingBinding,
    readAgentIdentitySDKFence,
    retireAgentIdentitySDKWork,
  } = await import('../../src/history/agent-identity-work.ts');
  const { account, token } = await verified();
  const released = await post(`/v1/accounts/${account.id}:releaseVerification`, token);
  expect(released.response.status).toBe(200);
  const decision = released.body.reversal as AgentVerificationReversal;
  await finish(decision);
  const receipt = { kind: 'account-agent.unverify' as const, account: account.id, receipt: decision.receiptId };
  const source = await loadAccountIdentitySource(pool, receipt);
  const job = await probeAccountIdentityPublication(pool, receipt);
  const client = await createWorkClient(databaseUrl, pool);
  try {
    await client.registerQueue('workflows', {});
    expect(await enqueueAgentIdentityReversal(pool, client, decision)).toBe('admitted');
    const native = (
      await pool.query('SELECT * FROM core.agent_identity_work WHERE workflow_id=$1', [source.workflowId])
    ).rows[0];
    const input = (
      await pool.query('SELECT inputs FROM dbos.workflow_input WHERE workflow_uuid=$1', [source.workflowId])
    ).rows[0].inputs;
    const erased = (
      await pool.query(
        'INSERT INTO access.erasure(route,account_id,version,at) VALUES($1,$2,1,now()) RETURNING version,at::text',
        [accountRoute, account.id],
      )
    ).rows[0];
    const barrier = { accountId: account.id, accountRoute, version: erased.version, at: erased.at };
    const binding = (
      await runCommand(pool, { partition: 0 }, async (tx) =>
        noEffect(
          await readAgentIdentitySDKReceivingBinding(
            tx,
            {
              partition: 0,
              locator: { artifactType: 'durable-work/v1', workId: native.custody_id },
              accounts: native.accounts,
            },
            barrier,
          ),
        ),
      )
    ).value;
    if (binding.state !== 'observed') throw new Error('Expected original receiving binding');
    // A portable receipt with another restore generation is refused before native SDK I/O.
    // No guessed Semantic terminal locator or public verifier result is introduced.
    expect(
      await readAgentIdentitySDKFence(
        pool,
        client,
        {
          binding: binding.binding,
          sourceGeneration: '0',
          fence: { workflowID: source.workflowId, generation: '2', closureID: randomUUID(), closedAt: Date.now() },
        },
        { deadline: Date.now() + 10_000 },
      ),
    ).toEqual({
      state: 'pending',
      gap: 'identity-sdk-retirement-source-fence-changed',
    });
    const stage = await readAgentIdentityRetirementStage(
      pool,
      {
        receipt,
        job,
        barrier,
        erasedRole: 'subject',
        source: {
          partition: source.partition,
          epoch: source.epoch,
          position: source.position,
          transactionId: source.transactionId,
        },
        sourceDigest: source.digest,
      },
      { deadline: Date.now() + 10_000 },
    );
    if (!stage) throw new Error('Expected native source staging');
    expect(await retireAgentIdentitySDKWork(pool, client, stage, { deadline: Date.now() + 10_000 })).toEqual({
      state: 'pending',
      gap: 'identity-source-consumer-custody-pending',
    });
    expect(
      (
        await pool.query('SELECT sdk_retirement_receipt FROM core.agent_identity_work WHERE custody_id=$1', [
          native.custody_id,
        ])
      ).rows[0].sdk_retirement_receipt,
    ).toBeNull();
    expect(
      (await pool.query('SELECT inputs FROM dbos.workflow_input WHERE workflow_uuid=$1', [source.workflowId])).rows[0]
        .inputs,
    ).toBe(input);
    expect((await client.getWorkflow(source.workflowId))?.status).toBe('ENQUEUED');
    expect(
      (
        await pool.query(
          'SELECT state,owner_ready,absence_verified FROM core.history_work WHERE partition_no=0 AND work_id=$1',
          [native.custody_id],
        )
      ).rows[0],
    ).toEqual({ state: 'pending', owner_ready: false, absence_verified: false });
  } finally {
    await client.close();
  }
}, 60_000);

async function acceptedTechnicalFixture(kind: 'actor' | 'organization' = 'actor') {
  const { readAccountIdentityUndo } = await import('../../src/semantic/identity-epoch-binding.ts');
  const { account, token } = await verified(kind);
  const receipt = {
    kind: 'account-agent.verify' as const,
    account: account.id,
    receipt: (await accountState(account.id)).agent_verification_receipt_id as string,
  };
  const original = await readAccountIdentityUndo(pool, receipt);
  const erased = (
    await pool.query(
      'INSERT INTO access.erasure(route,account_id,version,at) VALUES($1,$2,1,now()) RETURNING version,at::text',
      [accountRoute, account.id],
    )
  ).rows[0];
  const reference: import('../../src/semantic/identity-source-consumer-custody.ts').IdentitySourceConsumerReference = {
    receipt,
    job: original.job,
    source: {
      partition: original.source.partition,
      epoch: original.source.epoch,
      position: original.source.position,
      transactionId: original.source.transactionId,
    },
    sourceDigest: original.source.digest,
    barrier: { accountId: account.id, accountRoute, version: erased.version, at: erased.at },
    erasedRole: 'subject',
  };
  return { account, token, original, reference };
}

const technicalWake = (accountId: string) => [
  {
    type: 'com.rezics.access.account-updated.v1',
    subject: accountId,
    data: { accountId },
  },
];

test('Native Account identity technical receiver retains indispensable accepted undo custody after original personal source minimization', async () => {
  const { acceptAccountIdentityTechnicalSource, verifyAccountIdentityTechnicalSource, readAccountIdentitySource } =
    await import('../../src/access/agent-verification-identity.ts');
  const { readAccountIdentityUndo } = await import('../../src/semantic/identity-epoch-binding.ts');
  const { identityEpochStore } = await import('../../src/semantic/identity-epoch-store.ts');
  const { account, original, reference } = await acceptedTechnicalFixture();
  const accepted = await runCommand(pool, { partition: original.source.partition }, async (tx) => {
    const receipt = await acceptAccountIdentityTechnicalSource(tx, reference);
    expect(receipt).not.toBeNull();
    if (!receipt) throw new Error('Original accepted native binding reader must produce technical custody');
    expect(await verifyAccountIdentityTechnicalSource(tx, reference, receipt)).toBe(true);
    return { value: receipt, events: technicalWake(account.id) };
  });
  const receiving = accepted.value;
  expect(receiving).toEqual({
    partition: accepted.partition,
    epoch: accepted.epoch,
    position: accepted.position,
    transactionId: accepted.transactionId,
  });
  expect(receiving.transactionId).not.toBe(original.source.transactionId);
  const replay = await runCommand(pool, { partition: original.source.partition }, async (tx) =>
    noEffect(await acceptAccountIdentityTechnicalSource(tx, reference)),
  );
  expect(replay.value).toEqual(receiving);
  expect(replay.position).toBe(accepted.position);
  const technical = (
    await pool.query(
      `SELECT * FROM access.agent_identity_technical_source
     WHERE route=$1 AND account_id=$2 AND direction=$3 AND receipt_id=$4`,
      [accountRoute, account.id, reference.receipt.kind, reference.receipt.receipt],
    )
  ).rows[0];
  expect(technical.intent).toEqual(original.source.input.intent);
  expect(technical.source_digest).toBe(original.source.digest);
  expect(technical.accepted_job_id).toBe(original.job.jobId);
  for (const field of ['reason', 'requested_by', 'decided_by', 'barrier', 'requester', 'roles'])
    expect(Object.hasOwn(technical, field)).toBe(false);
  const inventory = (
    await pool.query(
      `SELECT role_account_id::text,roles FROM access.agent_identity_technical_role
     WHERE route=$1 AND account_id=$2 AND direction=$3 AND receipt_id=$4`,
      [accountRoute, account.id, reference.receipt.kind, reference.receipt.receipt],
    )
  ).rows;
  expect(inventory).toEqual([{ role_account_id: account.id, roles: 32 }]);

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
      clientId: 'technical-undo-test',
      scopes: ['account:delete'],
    },
  );
  await createLifecycleCommands({ pool, access, clock }).tombstone(
    { actor, deadline: Date.now() + 10_000 },
    { accountId: account.id, key: key() },
  );

  // Use the existing old-image loss fixture: remove the actual personal source bytes and
  // minimize its real native command response. No Source terminal state or ACK is seeded.
  // This proves technical read independence, not the separately owned minimizer's authority.
  const loss = await pool.connect();
  try {
    await loss.query('BEGIN');
    await loss.query("SET LOCAL session_replication_role='replica'");
    await loss.query(
      'DELETE FROM access.agent_identity_recovery WHERE route=$1 AND account_id=$2 AND direction=$3 AND receipt_id=$4',
      [accountRoute, account.id, reference.receipt.kind, reference.receipt.receipt],
    );
    await loss.query(
      'DELETE FROM access.agent_identity_intent WHERE route=$1 AND account_id=$2 AND direction=$3 AND receipt_id=$4',
      [accountRoute, account.id, reference.receipt.kind, reference.receipt.receipt],
    );
    await loss.query('COMMIT');
  } catch (error) {
    await loss.query('ROLLBACK');
    throw error;
  } finally {
    loss.release();
  }
  await pool.query(
    `UPDATE core.receipt SET response='null'::jsonb,payload_state='minimized'
     WHERE partition_no=$1 AND transaction_id=$2`,
    [original.source.partition, original.source.transactionId],
  );
  const undo = await readAccountIdentityUndo(
    pool,
    reference.receipt as Extract<typeof reference.receipt, { kind: 'account-agent.verify' }>,
  );
  expect(undo.job).toEqual(original.job);
  expect(undo.source).toEqual({
    ...original.source,
    roles: [{ account_id: account.id, role: 'subject' }],
  });
  // This account was genuinely the original requester. That personal actor role is
  // gone from technical custody; replay/verification need only the retained identity.
  const requesterReference = { ...reference, erasedRole: 'requester' as const };
  const beforeReplay = (
    await pool.query('SELECT position FROM core.partition WHERE partition_no=$1', [original.source.partition])
  ).rows[0].position;
  const minimizedReplay = await runCommand(pool, { partition: original.source.partition }, async (tx) => {
    expect(await verifyAccountIdentityTechnicalSource(tx, requesterReference, receiving)).toBe(true);
    return noEffect(await acceptAccountIdentityTechnicalSource(tx, requesterReference));
  });
  expect(minimizedReplay.value).toEqual(receiving);
  expect(minimizedReplay.position).toBe(BigInt(beforeReplay));
  expect(() => assertAccountIdentitySource(undo.source, reference.receipt)).toThrow();
  await expect(loadAccountIdentitySource(pool, reference.receipt)).rejects.toThrow();
  await expect(identityEpochStore.prepareAdmission(pool, {}, undo.source.input)).rejects.toThrow();
  expect(
    (
      await runCommand(pool, { partition: original.source.partition }, async (tx) =>
        noEffect(await verifyAccountIdentityTechnicalSource(tx, reference, receiving)),
      )
    ).value,
  ).toBe(true);
  await expect(
    runCommand(pool, { partition: original.source.partition }, async (tx) =>
      noEffect(await readAccountIdentitySource(tx, { ...reference.receipt, receipt: randomUUID() }, undefined, true)),
    ),
  ).rejects.toThrow('missing original');
}, 60_000);

test('Native technical identity receiver retains no requester or decider copies after accepted source transfer', async () => {
  const { acceptAccountIdentityTechnicalSource } = await import('../../src/access/agent-verification-identity.ts');
  const { readAccountIdentityTechnicalSource } =
    await import('../../src/access/agent-verification-identity-retention.ts');
  const { nativeStoreBlocker } = await import('../../src/access/erasure-native-stores.ts');
  const { account, original, reference } = await acceptedTechnicalFixture('organization');
  expect(original.source.roles).toContainEqual({ account_id: manager.id, role: 'actor' });
  expect(original.source.roles).toContainEqual({ account_id: staff.id, role: 'editor' });
  await runCommand(pool, { partition: original.source.partition }, async (tx) => {
    expect(await acceptAccountIdentityTechnicalSource(tx, reference)).not.toBeNull();
    return { value: null, events: technicalWake(account.id) };
  });
  const retained = await runCommand(pool, { partition: original.source.partition }, async (tx) =>
    noEffect(await readAccountIdentityTechnicalSource(tx, reference.receipt)),
  );
  expect(retained.value).toEqual({ ...original.source, roles: [{ account_id: account.id, role: 'subject' }] });
  const rows = await pool.query(
    `SELECT role_account_id::text,roles FROM access.agent_identity_technical_role
     WHERE route=$1 AND account_id=$2 AND direction=$3 AND receipt_id=$4`,
    [accountRoute, account.id, reference.receipt.kind, reference.receipt.receipt],
  );
  expect(rows.rows).toEqual([{ role_account_id: account.id, roles: 32 }]);
  const client = await pool.connect();
  try {
    for (const id of [manager.id, staff.id]) {
      // A saved native page for a removed historical association cannot keep it pending.
      expect(
        await nativeStoreBlocker(
          client,
          'agent_identity_technical_role',
          [String(accountRoute), account.id, reference.receipt.kind, reference.receipt.receipt, id],
          id,
        ),
      ).toBeNull();
      await expect(
        client.query(
          `INSERT INTO access.agent_identity_technical_role(route,account_id,direction,receipt_id,role_account_id,roles)
         VALUES($1,$2,$3,$4,$5,32)`,
          [accountRoute, account.id, reference.receipt.kind, reference.receipt.receipt, id],
        ),
      ).rejects.toThrow('identity_technical_retained_subject');
    }
  } finally {
    client.release();
  }
}, 60_000);

test('technical identity receiver rejects mismatched originals without callbacks or inventory and rolls back a failed local post-write verification', async () => {
  const { acceptAccountIdentityTechnicalSource, verifyAccountIdentityTechnicalSource } =
    await import('../../src/access/agent-verification-identity.ts');
  const { account, original, reference } = await acceptedTechnicalFixture();
  const candidates = [
    { ...reference, erasedRole: 'decider' as const }, // The source Account was never the original decider.
    {
      ...reference,
      erasedRole: 'requester' as const,
      barrier: { ...reference.barrier, accountId: newId(accountRoute) },
    },
    { ...reference, sourceDigest: '0'.repeat(64) },
    { ...reference, source: { ...reference.source, position: reference.source.position + 1n } },
    { ...reference, source: { ...reference.source, epoch: reference.source.epoch + 1 } },
    { ...reference, source: { ...reference.source, transactionId: randomUUID() } },
    { ...reference, job: { ...reference.job, epoch: reference.job.epoch + 1n } },
    { ...reference, receipt: { ...reference.receipt, receipt: randomUUID() } },
  ];
  for (const candidate of candidates)
    expect(
      (
        await runCommand(pool, { partition: original.source.partition }, async (tx) =>
          noEffect(await acceptAccountIdentityTechnicalSource(tx, candidate)),
        )
      ).value,
    ).toBeNull();
  const rows = async () =>
    (
      await pool.query(
        `SELECT (SELECT count(*)::int FROM access.agent_identity_technical_source WHERE route=$1 AND account_id=$2) AS sources,
            (SELECT count(*)::int FROM access.agent_identity_technical_role WHERE route=$1 AND account_id=$2) AS roles`,
        [accountRoute, account.id],
      )
    ).rows[0];
  expect(await rows()).toEqual({ sources: 0, roles: 0 });
  for (const mismatch of [
    { ...reference, receipt: { ...reference.receipt, receipt: randomUUID() } },
    { ...reference, job: { ...reference.job, epoch: reference.job.epoch + 1n } },
  ]) {
    await expect(
      runCommand(pool, { partition: original.source.partition }, async (tx) => {
        const receipt = await acceptAccountIdentityTechnicalSource(tx, reference);
        if (!receipt) throw new Error('Expected real native technical receiving acceptance');
        await verifyAccountIdentityTechnicalSource(tx, mismatch, receipt);
        return { value: null, events: technicalWake(account.id) };
      }),
    ).rejects.toThrow('technical receiver mismatch after write');
    expect(await rows()).toEqual({ sources: 0, roles: 0 });
  }
});

test('accepted reversal technical custody binds its current accepted job independently of intent undoJob', async () => {
  const { acceptAccountIdentityTechnicalSource, verifyAccountIdentityTechnicalSource } =
    await import('../../src/access/agent-verification-identity.ts');
  const { account, token } = await verified();
  const released = await post(`/v1/accounts/${account.id}:releaseVerification`, token);
  expect(released.response.status).toBe(200);
  const reversal = released.body.reversal as AgentVerificationReversal;
  await finish(reversal);
  const receipt = { kind: 'account-agent.unverify' as const, account: account.id, receipt: reversal.receiptId };
  const source = await loadAccountIdentitySource(pool, receipt);
  const job = await probeAccountIdentityPublication(pool, receipt);
  if (source.input.intent.kind !== 'unmerge') throw new Error('Expected actual closed reversal input');
  const priorJob = source.input.intent.undoJob;
  expect(job.jobId).not.toBe(priorJob.jobId);
  const erased = (
    await pool.query(
      'INSERT INTO access.erasure(route,account_id,version,at) VALUES($1,$2,1,now()) RETURNING version,at::text',
      [accountRoute, account.id],
    )
  ).rows[0];
  const reference = {
    receipt,
    job,
    source: {
      partition: source.partition,
      epoch: source.epoch,
      position: source.position,
      transactionId: source.transactionId,
    },
    sourceDigest: source.digest,
    barrier: { accountId: account.id, accountRoute, version: erased.version, at: erased.at },
    erasedRole: 'subject' as const,
  };
  expect(
    (
      await runCommand(pool, { partition: source.partition }, async (tx) =>
        noEffect(await acceptAccountIdentityTechnicalSource(tx, { ...reference, job: priorJob })),
      )
    ).value,
  ).toBeNull();
  const native = (
    await runCommand(pool, { partition: source.partition }, async (tx) => {
      const accepted = await acceptAccountIdentityTechnicalSource(tx, reference);
      expect(accepted).not.toBeNull();
      return { value: accepted, events: technicalWake(account.id) };
    })
  ).value;
  if (!native) throw new Error('Expected actual reversal receiving custody');
  expect(
    (
      await pool.query(
        `SELECT role_account_id::text,roles FROM access.agent_identity_technical_role
     WHERE route=$1 AND account_id=$2 AND direction=$3 AND receipt_id=$4`,
        [accountRoute, account.id, receipt.kind, receipt.receipt],
      )
    ).rows,
  ).toEqual([{ role_account_id: account.id, roles: 32 }]);
  expect(
    (
      await runCommand(pool, { partition: source.partition }, async (tx) =>
        noEffect(await verifyAccountIdentityTechnicalSource(tx, reference, native)),
      )
    ).value,
  ).toBe(true);
  expect(
    (
      await runCommand(pool, { partition: source.partition }, async (tx) =>
        noEffect(await verifyAccountIdentityTechnicalSource(tx, { ...reference, job: priorJob }, native)),
      )
    ).value,
  ).toBe(false);
});

test('Default History maintenance passes one genuinely funded Source native and Library work frame through released identity consumer staging', async () => {
  const { spyOn } = await import('bun:test');
  const { existsSync } = await import('node:fs');
  const { createWorkClient } = await import('../../src/work/client.ts');
  const { enqueueAgentIdentityReversal } = await import('../../src/history/agent-identity-work.ts');
  const retirement = await import('../../src/history/agent-identity-retirement.ts');
  const sourceConsumer = await import('../../src/semantic/identity-source-consumer-custody.ts');
  const { admitSharedHistory, advanceSharedHistory } = await import('../../src/access/shared-history.ts');
  const { HistoryRegistry } = await import('../../src/history/registry.ts');
  const { account, token } = await verified();
  const released = await post(`/v1/accounts/${account.id}:releaseVerification`, token);
  expect(released.response.status).toBe(200);
  const decision = released.body.reversal as AgentVerificationReversal;
  await finish(decision);
  const receipt = { kind: 'account-agent.unverify' as const, account: account.id, receipt: decision.receiptId };
  const native = await loadAccountIdentitySource(pool, receipt);
  const identityJob = await probeAccountIdentityPublication(pool, receipt);
  const client = await createWorkClient(databaseUrl, pool);
  const readConsumer = sourceConsumer.readIdentitySourceConsumerCustody;
  const verifyStage = retirement.verifyAgentIdentityRetirementStage;
  const readSpy = spyOn(sourceConsumer, 'readIdentitySourceConsumerCustody');
  const verifySpy = spyOn(retirement, 'verifyAgentIdentityRetirementStage');
  let frameSpy: { mockRestore(): void } | undefined;
  try {
    await client.registerQueue('workflows', {});
    expect(await enqueueAgentIdentityReversal(pool, client, decision)).toBe('admitted');
    const receiving = (
      await pool.query('SELECT * FROM core.agent_identity_work WHERE workflow_id=$1', [native.workflowId])
    ).rows[0];
    const inputs = (
      await pool.query('SELECT inputs FROM dbos.workflow_input WHERE workflow_uuid=$1', [native.workflowId])
    ).rows[0].inputs;
    const erased = (
      await pool.query(
        'INSERT INTO access.erasure(route,account_id,version,at) VALUES($1,$2,1,now()) RETURNING version,at::text',
        [accountRoute, account.id],
      )
    ).rows[0];
    const barrier = { accountId: account.id, accountRoute, version: erased.version, at: erased.at };
    const reference = {
      receipt,
      job: identityJob,
      source: {
        partition: native.partition,
        epoch: native.epoch,
        position: native.position,
        transactionId: native.transactionId,
      },
      sourceDigest: native.digest,
      barrier,
      erasedRole: 'subject' as const,
    };
    const unbacked = await retirement.readAgentIdentityRetirementStage(pool, reference, {
      deadline: Date.now() + 10_000,
    });
    expect(unbacked?.handoff.custodyId).toBe(receiving.custody_id);
    expect(unbacked?.consumer).toBeNull();
    expect(readSpy).not.toHaveBeenCalled();

    const jobId = randomUUID();
    await runCommand(pool, { partition: accountRoute >>> 4 }, async (tx) => {
      await admitSharedHistory(tx, account.id, jobId);
      return noEffect(null);
    });
    // Fixture positioning uses the existing native cursor, immediately before durable work.
    // The actual default entry still selects and releases the original locator itself.
    await pool.query(
      "UPDATE core.preference_history_job SET scan_type='command-receipt/v1',scan_locator=$2 WHERE job_id=$1",
      [jobId, Buffer.from([255])],
    );
    const registry = new HistoryRegistry();
    const env = process.env;
    const deps = { pool, client, registry, env, clock };
    const cursor = async () =>
      (
        await pool.query(
          'SELECT phase,scan_partition,scan_type,scan_locator FROM core.preference_history_job WHERE job_id=$1',
          [jobId],
        )
      ).rows[0];
    const before = await cursor();
    const path = new URL('../../src/semantic/identity-source-consumer-maintenance.ts', import.meta.url);
    if (!existsSync(path)) {
      expect(await advanceSharedHistory(deps, jobId)).toEqual({
        state: 'more',
        gap: retirement.IDENTITY_SOURCE_MAINTENANCE_UNAVAILABLE,
      });
      expect(await cursor()).toEqual(before);
      expect(readSpy).not.toHaveBeenCalled();
    }
    // This outcome requires the original funded producer after integration. No skip,
    // mock frame, allowance snapshot or success fallback stands in for its native body.
    expect(existsSync(path)).toBe(true);
    const producer: import('../../src/history/agent-identity-retirement.ts').IdentitySourceConsumerMaintenanceModule =
      await import(path.href);
    const withFrame = producer.withIdentitySourceConsumerMaintenance;
    type Funded = import('../../src/history/agent-identity-retirement.ts').IdentitySourceConsumerMaintenanceContext;
    let active: Funded | null = null;
    const contexts: Funded[] = [];
    let entries = 0;
    frameSpy = spyOn(producer, 'withIdentitySourceConsumerMaintenance').mockImplementation(async function <T>(
      frameDeps: Parameters<typeof withFrame>[0],
      context: Parameters<typeof withFrame>[1],
      body: (funded: Funded) => Promise<T>,
    ): Promise<T> {
      entries++;
      expect(frameDeps.pool).toBe(pool);
      expect(frameDeps.env).toBe(env);
      expect(frameDeps.clock).toBe(clock);
      return withFrame(frameDeps, context, async (funded) => {
        expect(active).toBeNull();
        expect(funded.identityConsumerWork).toBeDefined();
        expect(funded.deadline).toBe(context.deadline);
        contexts.push(funded);
        active = funded;
        try {
          return await body(funded);
        } finally {
          active = null;
        }
      });
    });
    const failure = new Error('Maintenance fixture failure after actual Source work');
    let failAfterRead = false;
    readSpy.mockImplementation(async (selectedPool, selected, context) => {
      expect(selectedPool).toBe(pool);
      if (!active) throw new Error('Source staging must remain inside its original live callback');
      expect(context).toBe(active);
      expect(selected).toEqual(reference);
      const answer = await readConsumer(selectedPool, selected, context);
      if (failAfterRead) throw failure;
      return answer;
    });
    verifySpy.mockImplementation(async (tx, stage) => {
      expect(active).not.toBeNull();
      expect(stage.reference).toEqual(reference);
      return verifyStage(tx, stage);
    });
    expect(await advanceSharedHistory(deps, jobId)).toEqual({
      state: 'more',
      gap: 'identity-source-consumer-custody-pending',
    });
    expect(entries).toBe(1);
    expect(contexts).toHaveLength(1);
    expect(readSpy).toHaveBeenCalledTimes(1);
    expect(verifySpy).toHaveBeenCalledTimes(1);
    expect(active).toBeNull();
    expect(await cursor()).toEqual(before);
    expect(
      (await pool.query('SELECT next_run>now() AS delayed FROM core.preference_history_job WHERE job_id=$1', [jobId]))
        .rows[0].delayed,
    ).toBe(true);
    // Reusing a callback context after completion cannot dispatch Source again.
    expect((await retirement.readAgentIdentityRetirementStage(pool, reference, contexts[0]!))?.consumer).toBeNull();
    expect(readSpy).toHaveBeenCalledTimes(1);
    failAfterRead = true;
    await expect(advanceSharedHistory(deps, jobId)).rejects.toBe(failure);
    expect(entries).toBe(2);
    expect(contexts).toHaveLength(2);
    expect(readSpy).toHaveBeenCalledTimes(2);
    expect(active).toBeNull();
    expect(await cursor()).toEqual(before);
    expect(
      (await pool.query('SELECT inputs FROM dbos.workflow_input WHERE workflow_uuid=$1', [native.workflowId])).rows[0]
        .inputs,
    ).toEqual(inputs);
    expect(
      (
        await pool.query('SELECT state,owner_ready FROM core.history_work WHERE partition_no=0 AND work_id=$1', [
          receiving.custody_id,
        ])
      ).rows[0],
    ).toEqual({ state: 'pending', owner_ready: false });
  } finally {
    frameSpy?.mockRestore();
    readSpy.mockRestore();
    verifySpy.mockRestore();
    await client.destroy();
  }
});

test("Original Account reversal writer publishes exact native reversal settlement and its same-home validator refuses stale or incomplete Account source obligations without claiming other owners' closure", async () => {
  const { readAccountIdentityReversalSettlement, verifyAccountIdentityReversalSettlement } =
    await import('../../src/access/agent-verification-identity.ts');
  const { readIdentitySourceConsumerCustody } = await import('../../src/semantic/identity-source-consumer-custody.ts');
  const { withIdentitySourceConsumerMaintenance } =
    await import('../../src/semantic/identity-source-consumer-maintenance.ts');
  const { account, token } = await verified();
  const released = await post(`/v1/accounts/${account.id}:releaseVerification`, token);
  expect(released.response.status).toBe(200);
  const decision = released.body.reversal as AgentVerificationReversal;
  const receipt = { kind: 'account-agent.unverify' as const, account: account.id, receipt: decision.receiptId };
  await unmergeVerifiedAgent(pool, decision);
  await removeAgentVerificationPage(pool, decision);
  const source = await loadAccountIdentitySource(pool, receipt);
  const job = await probeAccountIdentityPublication(pool, receipt);
  // A genuine lifecycle tombstone, rather than a fabricated barrier/terminal row.
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
      clientId: 'reversal-settlement',
      scopes: ['account:delete'],
    },
  );
  await createLifecycleCommands({ pool, access, clock }).tombstone(
    { actor, deadline: Date.now() + 10_000 },
    { accountId: account.id, key: key() },
  );
  const erased = (
    await pool.query('SELECT version,at::text FROM access.erasure WHERE route=$1 AND account_id=$2', [
      accountRoute,
      account.id,
    ])
  ).rows[0];
  const reference: import('../../src/semantic/identity-source-consumer-custody.ts').IdentitySourceConsumerReference = {
    receipt,
    job,
    source: {
      partition: source.partition,
      epoch: source.epoch,
      position: source.position,
      transactionId: source.transactionId,
    },
    sourceDigest: source.digest,
    barrier: { accountId: account.id, accountRoute, version: erased.version, at: erased.at },
    erasedRole: 'subject' as const,
  };
  const frame = <T>(
    body: (
      context: import('../../src/semantic/identity-source-consumer-maintenance.ts').IdentitySourceConsumerMaintenanceContext,
    ) => Promise<T>,
  ) =>
    withIdentitySourceConsumerMaintenance({ pool, env: process.env, clock }, { deadline: Date.now() + 10_000 }, body);
  // Publication alone is insufficient, even though the real reverse job is published.
  expect(await frame((context) => readAccountIdentityReversalSettlement(pool, reference, context))).toBeNull();
  await finishAgentVerificationReversal(pool, decision, clock);
  const persisted = (
    await pool.query(
      `SELECT * FROM access.agent_identity_reversal_settlement
    WHERE route=$1 AND account_id=$2 AND reversal_receipt_id=$3`,
      [accountRoute, account.id, decision.receiptId],
    )
  ).rows[0];
  expect(persisted).toBeDefined();
  expect(persisted.verified.receipt.receipt).toBe(decision.verificationReceiptId);
  expect(persisted.reversed.receipt).toEqual(receipt);
  expect(persisted.reversed.binding.job).toEqual({ jobId: job.jobId, epoch: job.epoch.toString() });
  expect(persisted.verified.binding.job).toEqual({
    jobId: (source.input.intent as Extract<typeof source.input.intent, { kind: 'unmerge' }>).undoJob.jobId,
    epoch: (source.input.intent as Extract<typeof source.input.intent, { kind: 'unmerge' }>).undoJob.epoch.toString(),
  });
  expect(persisted.reversed.binding.job).not.toEqual(persisted.verified.binding.job);
  expect(persisted.reversed.source).toEqual({
    partition: source.partition,
    epoch: source.epoch,
    position: source.position.toString(),
    transactionId: source.transactionId,
  });
  expect((await accountState(account.id)).pending_agent_receipt_id).toBeNull();
  // Replaying the ordinary final writer retains its original settlement and event.
  await finishAgentVerificationReversal(pool, decision, clock);
  expect(
    (
      await pool.query(
        `SELECT * FROM access.agent_identity_reversal_settlement
    WHERE route=$1 AND account_id=$2 AND reversal_receipt_id=$3`,
        [accountRoute, account.id, decision.receiptId],
      )
    ).rows[0],
  ).toEqual(persisted);
  await expect(finishAgentVerificationReversal(pool, { ...decision, reason: 'substituted' }, clock)).rejects.toThrow();
  expect(
    (
      await pool.query('SELECT 1 FROM core.outbox WHERE type=$1 AND subject=$2', [
        'com.rezics.access.agent-verification.reversed.v1',
        account.id,
      ])
    ).rows,
  ).toHaveLength(1);
  const terminal = (
    await pool.query(
      `SELECT * FROM core.receipt WHERE partition_no=$1 AND transaction_id=$2
    AND command_kind='access.agent-verification.reversed'`,
      [source.partition, persisted.transaction_id],
    )
  ).rows[0];
  expect(terminal.position.toString()).toBe(persisted.position.toString());
  expect(terminal.epoch).toBe(persisted.owner_epoch);
  expect(terminal.idempotency_key).toBe(persisted.native_receipt_key);

  // Stage the real original Source reference with its existing default producer.
  // This grants no permission to bypass Library, History/SDK or root proof.
  await frame((context) => readIdentitySourceConsumerCustody(pool, reference, context));
  const independent = async () =>
    (
      await pool.query(
        `SELECT r.*,p.* FROM semantic.identity_epoch_source_consumer_custody r
    LEFT JOIN semantic.identity_epoch_source_consumer_terminal p ON p.partition_no=r.partition_no AND p.custody_key=r.erasure_key
    WHERE r.partition_no=$1 AND r.receipt_key=$2`,
        [source.partition, JSON.stringify([receipt.kind, receipt.account, receipt.receipt])],
      )
    ).rows;
  const before = await independent();
  expect(before.length).toBeGreaterThan(0);
  const proof = await frame((context) => readAccountIdentityReversalSettlement(pool, reference, context));
  expect(proof).not.toBeNull();
  if (!proof) throw new Error('Expected the actual original Account settlement');
  const verify = (candidate = reference, evidence = proof, home = source.partition) =>
    frame((context) =>
      runCommand(pool, { partition: home, deadline: context.deadline }, async (tx) =>
        noEffect(await verifyAccountIdentityReversalSettlement(tx, candidate, evidence)),
      ).then((result) => result.value),
    );
  expect(await verify()).toBe(true);
  expect(await verify({ ...reference, job: { ...reference.job, epoch: reference.job.epoch + 1n } })).toBe(false);
  expect(await verify({ ...reference, sourceDigest: '0'.repeat(64) })).toBe(false);
  expect(await verify({ ...reference, source: { ...reference.source, position: source.position + 1n } })).toBe(false);
  expect(await verify({ ...reference, barrier: { ...reference.barrier, version: erased.version + 1 } })).toBe(false);
  expect(await verify({ ...reference, erasedRole: 'requester' })).toBe(false);
  expect(await verify(reference, {} as typeof proof)).toBe(false);
  expect(await verify(reference, proof, 0)).toBe(false);
  expect(await independent()).toEqual(before);
  // Original owner restoration invalidates both the read and a previously issued proof.
  await pool.query('UPDATE core.partition SET epoch=epoch+1 WHERE partition_no=$1', [source.partition]);
  try {
    expect(await verify()).toBe(false);
    expect(await frame((context) => readAccountIdentityReversalSettlement(pool, reference, context))).toBeNull();
  } finally {
    await pool.query('UPDATE core.partition SET epoch=epoch-1 WHERE partition_no=$1', [source.partition]);
  }
  expect(await verify()).toBe(true);
  // Existing old-image-loss fixture: no synthetic terminal flags or fake receiver.
  const loss = await pool.connect();
  try {
    await loss.query('BEGIN');
    await loss.query("SET LOCAL session_replication_role='replica'");
    await loss.query(
      `DELETE FROM access.agent_identity_technical_role WHERE route=$1 AND account_id=$2
      AND direction=$3 AND receipt_id=$4`,
      [accountRoute, account.id, receipt.kind, receipt.receipt],
    );
    await loss.query(
      `DELETE FROM access.agent_identity_technical_source WHERE route=$1 AND account_id=$2
      AND direction=$3 AND receipt_id=$4`,
      [accountRoute, account.id, receipt.kind, receipt.receipt],
    );
    await loss.query('COMMIT');
  } catch (error) {
    await loss.query('ROLLBACK');
    throw error;
  } finally {
    loss.release();
  }
  expect(await verify()).toBe(false);
  expect(await frame((context) => readAccountIdentityReversalSettlement(pool, reference, context))).toBeNull();
  expect(await independent()).toEqual(before);
});

test('original identity SDK receiving observation rejects wrong sources and a native fence without Source transfer', async () => {
  const { createWorkClient } = await import('../../src/work/client.ts');
  const { enqueueAgentIdentityReversal } = await import('../../src/history/agent-identity-work.ts');
  const { readAgentIdentityNativeInventory } = await import('../../src/history/agent-identity-inventory.ts');
  const { readAgentIdentitySDKRetirement, readAgentIdentitySDKRetirementGap, AGENT_IDENTITY_SDK_RETIREMENT } =
    await import('../../src/history/agent-identity-retirement.ts');
  const { retireSdkWorkflowWriters, readSdkWorkflowRetirement } =
    await import('../../src/work/sdk-retirement-fence.ts');
  const { account, token } = await verified();
  const released = await post(`/v1/accounts/${account.id}:releaseVerification`, token);
  expect(released.response.status).toBe(200);
  const decision = released.body.reversal as AgentVerificationReversal;
  await finish(decision);
  const receipt = { kind: 'account-agent.unverify' as const, account: account.id, receipt: decision.receiptId };
  const key = { route: accountRoute, accountId: account.id, direction: receipt.kind, receiptId: receipt.receipt };
  const context = () => ({ deadline: Date.now() + 10_000 });
  const cut = await readAgentIdentityNativeInventory(pool, key, context());
  if (cut.state !== 'sealed') throw new Error('Expected actual original native inventory');
  const original = cut.proof.original;
  const client = await createWorkClient(databaseUrl, pool);
  try {
    await client.registerQueue('workflows', {});
    expect(await enqueueAgentIdentityReversal(pool, client, decision)).toBe('admitted');
    const native = (
      await pool.query('SELECT custody_id,workflow_id FROM core.agent_identity_work WHERE source_key=$1', [
        JSON.stringify([receipt.kind, receipt.account, receipt.receipt]),
      ])
    ).rows[0];
    const inputs = (
      await pool.query('SELECT inputs FROM dbos.workflow_input WHERE workflow_uuid=$1', [native.workflow_id])
    ).rows[0].inputs;
    const erased = (
      await pool.query(
        'INSERT INTO access.erasure(route,account_id,version,at) VALUES($1,$2,1,now()) RETURNING version,at::text',
        [accountRoute, account.id],
      )
    ).rows[0];
    const barrier = { accountId: account.id, accountRoute, version: erased.version, at: erased.at };
    for (const changed of [
      { ...original, digest: '0'.repeat(64) },
      { ...original, epoch: original.epoch + 1 },
      { ...original, position: original.position + 1n },
      { ...original, transactionId: randomUUID() },
      { ...original, partition: original.partition + 1 },
    ]) {
      expect(await readAgentIdentitySDKRetirement(pool, client, changed, barrier, context())).toEqual({
        state: 'pending',
        gap: 'identity-sdk-source-native-binding-changed',
      });
    }
    expect(
      await readAgentIdentitySDKRetirement(
        pool,
        client,
        { ...original, key: { ...key, receiptId: randomUUID() } },
        barrier,
        context(),
      ),
    ).toEqual({ state: 'pending', gap: 'agent-identity-sdk-recording-port-unavailable' });
    expect(
      await readAgentIdentitySDKRetirementGap(pool, { ...receipt, receipt: randomUUID() }, context(), {
        client,
        original,
        barrier,
      }),
    ).toBe('identity-sdk-source-native-binding-changed');
    // This is the actual SDK owner API and its unmodified durable receipt, not a fixture
    // retirement flag. A permanent writer fence alone must retain Source and SDK payloads.
    const fence = await retireSdkWorkflowWriters(native.workflow_id, client);
    expect(await readSdkWorkflowRetirement(native.workflow_id, client)).toEqual(fence);
    expect(await readAgentIdentitySDKRetirement(pool, client, original, barrier, context())).toEqual({
      state: 'pending',
      gap: AGENT_IDENTITY_SDK_RETIREMENT.gap,
    });
    expect(await readAgentIdentitySDKRetirementGap(pool, receipt, context(), { client, original, barrier })).toBe(
      AGENT_IDENTITY_SDK_RETIREMENT.gap,
    );
    expect(
      (await pool.query('SELECT inputs FROM dbos.workflow_input WHERE workflow_uuid=$1', [native.workflow_id])).rows[0]
        .inputs,
    ).toBe(inputs);
    expect(
      (
        await pool.query(
          `SELECT w.owner_ready,w.state,w.absence_verified,m.sdk_retirement_receipt
         FROM core.history_work w JOIN core.agent_identity_work m ON m.custody_id=w.work_id
         WHERE w.partition_no=0 AND w.work_id=$1`,
          [native.custody_id],
        )
      ).rows[0],
    ).toEqual({ owner_ready: false, state: 'pending', absence_verified: false, sdk_retirement_receipt: null });
  } finally {
    await client.close();
  }
}, 60_000);

test('Genuine current source and SDK fences guard distinct History readiness and exact receiving closure', async () => {
  const { createWorkClient } = await import('../../src/work/client.ts');
  const { enqueueAgentIdentityReversal } = await import('../../src/history/agent-identity-work.ts');
  const {
    readAgentIdentitySDKWriterState,
    lockAgentIdentitySDKWriterState,
    readAgentIdentitySDKReceivingBinding,
    IDENTITY_HISTORY_HANDOFF_UNAVAILABLE,
  } = await import('../../src/history/agent-identity-sdk-fence.ts');
  const { withIdentitySourceConsumerMaintenance, identitySourceConsumerNativeWork } =
    await import('../../src/semantic/identity-source-consumer-maintenance.ts');
  const { readAgentIdentityRetirementStage, agentIdentityRetirementReadiness } =
    await import('../../src/history/agent-identity-retirement.ts');
  const { readSdkWorkflowWriterState, retireSdkWorkflowWriters } =
    await import('../../src/work/sdk-retirement-fence.ts');
  const { account, token } = await verified();
  const released = await post(`/v1/accounts/${account.id}:releaseVerification`, token);
  expect(released.response.status).toBe(200);
  const decision = released.body.reversal as AgentVerificationReversal;
  await finish(decision);
  const receipt = { kind: 'account-agent.unverify' as const, account: account.id, receipt: decision.receiptId };
  const source = await loadAccountIdentitySource(pool, receipt);
  const job = await probeAccountIdentityPublication(pool, receipt);
  const client = await createWorkClient(databaseUrl, pool);
  const independent = await createWorkClient(databaseUrl);
  const contender = await pool.connect();
  try {
    await client.registerQueue('workflows', {});
    expect(await enqueueAgentIdentityReversal(pool, client, decision)).toBe('admitted');
    const native = (
      await pool.query('SELECT custody_id,accounts FROM core.agent_identity_work WHERE workflow_id=$1', [
        source.workflowId,
      ])
    ).rows[0];
    const erased = (
      await pool.query(
        'INSERT INTO access.erasure(route,account_id,version,at) VALUES($1,$2,1,now()) RETURNING version,at::text',
        [accountRoute, account.id],
      )
    ).rows[0];
    const barrier = { accountId: account.id, accountRoute, version: erased.version, at: erased.at };
    const reference = {
      receipt,
      job,
      barrier,
      erasedRole: 'subject' as const,
      source: {
        partition: source.partition,
        epoch: source.epoch,
        position: source.position,
        transactionId: source.transactionId,
      },
      sourceDigest: source.digest,
    };
    const deadline = Date.now() + 10_000;
    const live = await readSdkWorkflowWriterState(source.workflowId, client);
    if (!live) throw new Error('Expected original native writer state');
    expect(live.generation).toBe('1');
    // No caller allowance, deadline or copied state creates a live funding frame.
    expect(await readAgentIdentitySDKWriterState(pool, client, source.workflowId, { deadline })).toEqual({
      state: 'pending',
      gap: 'identity-sdk-current-fence-funding-unavailable',
    });
    await withIdentitySourceConsumerMaintenance({ pool, env: {} }, { deadline }, async (context) => {
      const balance = () => identitySourceConsumerNativeWork(pool, context.identityConsumerWork, deadline)!;
      const before = balance();
      expect(await readAgentIdentitySDKWriterState(pool, client, source.workflowId, context)).toEqual({
        state: 'observed',
        writer: live,
      });
      expect(balance()).toEqual({
        rows: before.rows - 3,
        points: before.points - 2,
        statements: before.statements - 1,
        bytes: before.bytes - 8192,
        engineRequests: 0,
      });
      const check = (expected = live, phase: 'readiness' | 'closure' = 'readiness', sdk = client) =>
        runCommand(pool, { partition: source.partition, deadline }, async (tx) =>
          noEffect(await lockAgentIdentitySDKWriterState(tx, sdk, source.workflowId, expected, phase)),
        ).then((result) => result.value);
      const spent = balance();
      await runCommand(pool, { partition: source.partition, deadline }, async (tx) => {
        expect(await lockAgentIdentitySDKWriterState(tx, client, source.workflowId, live, 'readiness')).toEqual({
          state: 'observed',
          writer: live,
        });
        // The helper has returned, but the SDK's actual row is still locked through Source COMMIT.
        await contender.query('BEGIN');
        await expect(
          contender.query('SELECT 1 FROM dbos.workflow_writer_fences WHERE workflow_uuid=$1 FOR UPDATE NOWAIT', [
            source.workflowId,
          ]),
        ).rejects.toMatchObject({ code: '55P03' });
        await contender.query('ROLLBACK');
        return noEffect(null);
      });
      expect(balance()).toEqual({
        rows: spent.rows - 4,
        points: spent.points - 2,
        statements: spent.statements - 4,
        bytes: spent.bytes - 8192,
        engineRequests: 0,
      });
      await contender.query('BEGIN');
      await contender.query('SELECT 1 FROM dbos.workflow_writer_fences WHERE workflow_uuid=$1 FOR UPDATE NOWAIT', [
        source.workflowId,
      ]);
      await contender.query('ROLLBACK');
      expect(await check(live, 'closure')).toEqual({ state: 'pending', gap: 'identity-sdk-permanent-closure-pending' });
      const beforeMismatch = balance();
      expect(await check(live, 'readiness', independent)).toEqual({
        state: 'pending',
        gap: 'identity-sdk-source-pool-mismatch',
      });
      expect(balance()).toEqual({
        rows: beforeMismatch.rows - 4,
        points: beforeMismatch.points - 2,
        statements: beforeMismatch.statements - 4,
        bytes: beforeMismatch.bytes - 8192,
        engineRequests: 0,
      });
      for (const changed of [
        { ...live, restoreGeneration: randomUUID() },
        { ...live, workflowID: `missing:${randomUUID()}` },
      ]) {
        const beforeFailure = balance();
        if (changed.workflowID !== source.workflowId) {
          expect(await check(changed)).toEqual({ state: 'pending', gap: 'identity-sdk-original-writer-changed' });
          expect(balance()).toEqual(beforeFailure);
        } else {
          await expect(check(changed)).rejects.toThrow('writer restore generation changed');
          expect(balance()).toEqual({
            rows: beforeFailure.rows - 4,
            points: beforeFailure.points - 2,
            statements: beforeFailure.statements - 4,
            bytes: beforeFailure.bytes - 8192,
            engineRequests: 0,
          });
        }
      }
    });
    // Native technical closure is real; it cannot create missing History/Source authority.
    const fence = await retireSdkWorkflowWriters(source.workflowId, client);
    const closed = await readSdkWorkflowWriterState(source.workflowId, client);
    if (!closed) throw new Error('Expected permanent native writer closure');
    expect(closed).toEqual({ ...fence, restoreGeneration: live.restoreGeneration });
    await withIdentitySourceConsumerMaintenance({ pool, env: {} }, { deadline }, async () => {
      const check = (expected = closed) =>
        runCommand(pool, { partition: source.partition, deadline }, async (tx) =>
          noEffect(await lockAgentIdentitySDKWriterState(tx, client, source.workflowId, expected, 'closure')),
        ).then((result) => result.value);
      expect(await check()).toEqual({ state: 'observed', writer: closed });
      for (const changed of [
        { ...closed, closureID: randomUUID() },
        { ...closed, closedAt: closed.closedAt! + 1 },
        { ...closed, restoreGeneration: randomUUID() },
      ])
        await expect(check(changed)).rejects.toThrow(/writer (state|restore generation) changed/);
    });
    await withIdentitySourceConsumerMaintenance(
      {
        pool,
        env: {
          KERNEL_IDENTITY_SOURCE_MAINTENANCE_NATIVE_BYTES: '8192',
        },
      },
      { deadline },
      async (context) => {
        expect((await readAgentIdentitySDKWriterState(pool, client, source.workflowId, context)).state).toBe(
          'observed',
        );
        const exhausted = identitySourceConsumerNativeWork(pool, context.identityConsumerWork, deadline);
        expect(exhausted?.bytes).toBe(0);
        expect(await readAgentIdentitySDKWriterState(pool, client, source.workflowId, context)).toEqual({
          state: 'pending',
          gap: 'identity-sdk-current-fence-funding-unavailable',
        });
        expect(
          (
            await runCommand(pool, { partition: source.partition, deadline }, async (tx) =>
              noEffect(await lockAgentIdentitySDKWriterState(tx, client, source.workflowId, closed, 'closure')),
            )
          ).value,
        ).toEqual({ state: 'pending', gap: 'identity-sdk-current-fence-funding-unavailable' });
        expect(identitySourceConsumerNativeWork(pool, context.identityConsumerWork, deadline)).toEqual(exhausted);
      },
    );
    const artifact = {
      partition: 0,
      locator: { artifactType: 'durable-work/v1' as const, workId: native.custody_id },
      accounts: native.accounts,
    };
    const binding = (
      await runCommand(pool, { partition: 0, deadline }, async (tx) =>
        noEffect(await readAgentIdentitySDKReceivingBinding(tx, artifact, barrier)),
      )
    ).value;
    if (binding.state !== 'observed') throw new Error('Expected current original receiving binding');
    // Genuine SDK evidence may be retained as metadata. Even this exact receipt is not
    // the missing original-owner durable readiness or receiving-copy authority.
    await pool.query('UPDATE core.agent_identity_work SET sdk_retirement_receipt=$2 WHERE custody_id=$1', [
      native.custody_id,
      { binding: binding.binding, sourceGeneration: binding.binding.receiver.generation, fence },
    ]);
    expect(
      (
        await runCommand(pool, { partition: 0, deadline }, async (tx) =>
          noEffect(await agentIdentityRetirementReadiness(tx, artifact, barrier)),
        )
      ).value,
    ).toEqual({ ready: false, gap: IDENTITY_HISTORY_HANDOFF_UNAVAILABLE });
    const stage = await readAgentIdentityRetirementStage(pool, reference, { deadline });
    if (!stage) throw new Error('Expected genuine native original Source stage');
    const { retireAgentIdentitySDKWork } = await import('../../src/history/agent-identity-sdk-fence.ts');
    expect(await retireAgentIdentitySDKWork(pool, client, stage, { deadline })).toEqual({
      state: 'pending',
      gap: 'identity-source-consumer-custody-pending',
    });
    expect(
      (
        await runCommand(pool, { partition: 0, deadline }, async (tx) =>
          noEffect(
            await agentIdentityRetirementReadiness(
              tx,
              {
                partition: 0,
                locator: { artifactType: 'durable-work/v1', workId: native.custody_id },
                accounts: native.accounts,
              },
              barrier,
            ),
          ),
        )
      ).value.ready,
    ).toBe(false);
    await expect(
      pool.query("UPDATE core.history_work SET owner_ready=true,state='ready' WHERE partition_no=0 AND work_id=$1", [
        native.custody_id,
      ]),
    ).rejects.toThrow('requires durable source transfer');
    expect(
      (
        await pool.query(
          'SELECT state,owner_ready,absence_verified FROM core.history_work WHERE partition_no=0 AND work_id=$1',
          [native.custody_id],
        )
      ).rows[0],
    ).toEqual({ state: 'pending', owner_ready: false, absence_verified: false });
    expect(
      (await pool.query('SELECT inputs FROM dbos.workflow_input WHERE workflow_uuid=$1', [source.workflowId])).rows,
    ).toHaveLength(1);
    await contender.query('BEGIN ISOLATION LEVEL SERIALIZABLE');
    await expect(
      client.enqueueInTransaction(
        contender,
        {
          workflowID: source.workflowId,
          workflowName: 'accounts.agent-verification-reversal',
          queueName: 'workflows',
        },
        decision,
      ),
    ).rejects.toThrow('permanently retired');
    await contender.query('ROLLBACK');
  } finally {
    await contender.query('ROLLBACK');
    contender.release();
    await independent.close();
    await client.close();
  }
}, 60_000);

// A fresh home-zero subject exercises the supported preserved native custody path.
// Existing cross-home fixtures and their refusal assertions remain unchanged.
async function verifiedHistoryHomeZero() {
  const account: Seeded = {
    id: newId(0),
    handle: `history_${randomUUID().slice(0, 8)}`,
    kind: 'actor',
    displayName: 'History account',
  };
  await pool.query(
    `INSERT INTO access.account(route,account_id,kind,handle,display_name,state,transaction_id)
    VALUES(0,$1,'actor',$2,$3,'active',$1)`,
    [account.id, account.handle, account.displayName],
  );
  await pool.query(
    `INSERT INTO access.resource_grant(route,resource_id,subject_id,action,valid,transaction_id)
    VALUES(0,$1,$1,'account:update','(,)',$1),(0,$1,$1,'account:read','(,)',$1)`,
    [account.id],
  );
  const token = await bearer(account);
  await ensureAccountAgent(pool, { account: account.id, kind: 'person', name: account.displayName, language: 'en' });
  const subject = await catalogueSubject('schema:Person', 'History catalogue');
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
  return { account, token };
}

test('The real default selected identity unit records guarded readiness retires its exact SDK writer and closes physical and receiving copies under current Source and SDK authority in one original frame', async () => {
  const { spyOn } = await import('bun:test');
  const { createWorkClient } = await import('../../src/work/client.ts');
  const { enqueueAgentIdentityReversal, agentIdentityRetirementReadiness } =
    await import('../../src/history/agent-identity-work.ts');
  const source = await import('../../src/semantic/identity-source-consumer-maintenance.ts');
  const sdk = await import('../../src/work/sdk-retirement-fence.ts');
  const { HistoryRegistry } = await import('../../src/history/registry.ts');
  const { admitSharedHistory, advanceSharedHistory } = await import('../../src/access/shared-history.ts');
  const { encodeLocator } = await import('../../src/history/locator.ts');
  const { account, token } = await verifiedHistoryHomeZero();
  const released = await post(`/v1/accounts/${account.id}:releaseVerification`, token);
  expect(released.response.status).toBe(200);
  const decision = released.body.reversal as AgentVerificationReversal;
  await finish(decision);
  const native = await loadAccountIdentitySource(pool, {
    kind: 'account-agent.unverify',
    account: account.id,
    receipt: decision.receiptId,
  });
  expect(native.partition).toBe(0);
  const client = await createWorkClient(databaseUrl, pool);
  let frames = 0;
  let active = false;
  let originalDeadline: number | undefined;
  const actions: string[] = [];
  const enter = source.withIdentitySourceConsumerMaintenance;
  const frameSpy = spyOn(source, 'withIdentitySourceConsumerMaintenance').mockImplementation(
    async (deps, context, body) => {
      frames++;
      return enter(deps, context, async (funded) => {
        expect(active).toBe(false);
        active = true;
        originalDeadline = funded.deadline;
        try {
          return await body(funded);
        } finally {
          active = false;
        }
      });
    },
  );
  const maintain = sdk.maintainSdkWorkflowOnce;
  const sdkSpy = spyOn(sdk, 'maintainSdkWorkflowOnce').mockImplementation(async (...args) => {
    expect(active).toBe(true);
    expect(args[0]).toBe(pool);
    expect(args[1]).toBe(client);
    expect(args[2].workflowID).toBe(native.workflowId);
    if (originalDeadline === undefined) throw new Error('Expected actual original Source callback');
    expect(args[4]).toBe(originalDeadline);
    actions.push(args[3]);
    if (args[3] === 'retire') {
      const row = (
        await pool.query(
          `SELECT m.sdk_readiness,m.history_authority,w.owner_ready
        FROM core.agent_identity_work m JOIN core.history_work w ON w.work_id=m.custody_id AND w.partition_no=0
        WHERE m.workflow_id=$1`,
          [native.workflowId],
        )
      ).rows[0];
      expect(row.owner_ready).toBe(true);
      expect(row.history_authority).not.toBeNull();
      expect(row.sdk_readiness.writer.generation).toBe('1');
    }
    return maintain(...args);
  });
  try {
    await client.registerQueue('workflows', {});
    expect(await enqueueAgentIdentityReversal(pool, client, decision)).toBe('admitted');
    const mapping = (
      await pool.query('SELECT custody_id FROM core.agent_identity_work WHERE workflow_id=$1', [native.workflowId])
    ).rows[0];
    // Payload clearing cannot bypass readiness by leaving the state pending.
    await expect(
      pool.query('UPDATE core.history_work SET request=NULL WHERE partition_no=0 AND work_id=$1', [mapping.custody_id]),
    ).rejects.toThrow('requires durable source transfer');
    await pool.query('INSERT INTO access.erasure(route,account_id,version,at) VALUES(0,$1,1,now())', [account.id]);
    const job = randomUUID();
    await runCommand(pool, { partition: 0 }, async (tx) => {
      await admitSharedHistory(tx, account.id, job);
      return noEffect(null);
    });
    // Select this original unit with the ordinary cursor; never supply a workflow ID to maintenance.
    await pool.query(
      "UPDATE core.preference_history_job SET scan_type='command-receipt/v1',scan_locator=$2 WHERE job_id=$1",
      [job, Buffer.from([255])],
    );
    const registry = new HistoryRegistry();
    registry.registerOwner({
      name: 'access.agent-identity',
      artifactType: 'durable-work/v1',
      version: 1,
      readiness: agentIdentityRetirementReadiness,
    });
    expect(await advanceSharedHistory({ pool, client, registry, env: process.env, clock }, job)).toEqual({
      state: 'more',
      gap: null,
    });
    expect(frames).toBe(1);
    expect(active).toBe(false);
    expect(actions).toEqual(['retire', 'delete']);
    const row = (
      await pool.query(
        `SELECT m.*,w.state,w.owner_ready,w.absence_verified,w.request,w.scope
      FROM core.agent_identity_work m JOIN core.history_work w ON w.work_id=m.custody_id AND w.partition_no=0
      WHERE m.custody_id=$1`,
        [mapping.custody_id],
      )
    ).rows[0];
    expect(row.sdk_readiness.writer.generation).toBe('1');
    expect(row.sdk_closure.generation).toBe('2');
    expect(row.sdk_closure.restoreGeneration).toBe(row.sdk_readiness.writer.restoreGeneration);
    expect(row.state).toBe('retired');
    expect(row.owner_ready).toBe(true);
    expect(row.absence_verified).toBe(true);
    expect(row.request).toBeNull();
    expect(row.scope).toBeNull();
    const encoded = Buffer.from(encodeLocator({ artifactType: 'durable-work/v1', workId: mapping.custody_id }));
    expect(
      (
        await pool.query(
          `SELECT state,proof_barrier FROM core.history_locator WHERE partition_no=0
      AND account_id=$1 AND artifact_type='durable-work/v1' AND locator=$2`,
          [account.id, encoded],
        )
      ).rows[0],
    ).toEqual({ state: 'minimized', proof_barrier: account.id });
    expect(
      (
        await pool.query(
          `SELECT count(*)::integer n FROM core.history_receiving_proof WHERE partition_no=0
      AND account_id=$1 AND artifact_type='durable-work/v1' AND locator=$2`,
          [account.id, encoded],
        )
      ).rows[0].n,
    ).toBe(1);
    expect(
      (await pool.query('SELECT scan_locator FROM core.preference_history_job WHERE job_id=$1', [job])).rows[0]
        .scan_locator,
    ).toEqual(encoded);
    for (const [table, key] of [
      ['workflow_status', 'workflow_uuid'],
      ['workflow_input', 'workflow_uuid'],
      ['workflow_output', 'workflow_uuid'],
      ['operation_outputs', 'workflow_uuid'],
      ['workflow_events', 'workflow_uuid'],
      ['workflow_events_history', 'workflow_uuid'],
      ['notifications', 'destination_uuid'],
      ['streams', 'workflow_uuid'],
    ]) {
      expect(
        (await pool.query(`SELECT 1 FROM dbos.${table} WHERE ${key}=$1 LIMIT 1`, [native.workflowId])).rows,
      ).toHaveLength(0);
    }
    const check = (binding: unknown, authority: unknown, writer: unknown) =>
      pool.query("SELECT core.check_agent_identity_history($1,$2,$3,$4,'closure')", [
        mapping.custody_id,
        binding,
        authority,
        writer,
      ]);
    await check(row.sdk_readiness.binding, row.history_authority, row.sdk_closure);
    // Each independent stale axis is tested against a genuine successful native baseline.
    await expect(
      check(
        { ...row.sdk_readiness.binding, source: { ...row.source, digest: '0'.repeat(64) } },
        row.history_authority,
        row.sdk_closure,
      ),
    ).rejects.toThrow('original binding changed');
    await expect(
      check(
        { ...row.sdk_readiness.binding, receiver: { ...row.sdk_readiness.binding.receiver, epoch: 0 } },
        row.history_authority,
        row.sdk_closure,
      ),
    ).rejects.toThrow('original binding changed');
    await expect(
      check(row.sdk_readiness.binding, { ...row.history_authority, sequence: '0' }, row.sdk_closure),
    ).rejects.toThrow();
    await expect(
      check(row.sdk_readiness.binding, row.history_authority, { ...row.sdk_closure, restoreGeneration: randomUUID() }),
    ).rejects.toThrow('restore generation changed');
    await expect(
      check(row.sdk_readiness.binding, row.history_authority, { ...row.sdk_closure, closureID: randomUUID() }),
    ).rejects.toThrow('writer state changed');
    await expect(
      client.enqueue(
        { workflowID: native.workflowId, workflowName: 'accounts.agent-verification-reversal', queueName: 'workflows' },
        decision,
      ),
    ).rejects.toThrow('permanently retired');
    expect(await enqueueAgentIdentityReversal(pool, client, decision)).toBe('retired');
  } finally {
    sdkSpy.mockRestore();
    frameSpy.mockRestore();
    await client.destroy();
  }
});

test('Native identity source roles retain original proof until exact real consumer custody is discharged or transferred and minimize under current native erasure barrier with receiving-copy closure without deleting live surviving obligations', async () => {
  const { minimizeDiscoveredAgentIdentitySources } = await import('../../src/access/erasure-progress.ts');
  const { account } = await verified();
  const before = (
    await pool.query(
      'SELECT * FROM access.agent_identity_intent WHERE route=$1 AND account_id=$2 ORDER BY direction,receipt_id',
      [accountRoute, account.id],
    )
  ).rows;
  expect(before.length).toBeGreaterThan(0);
  const keys = before.map((row) => [String(row.route), row.account_id, row.direction, row.receipt_id] as string[]);

  // Genuine current tombstone/obligation, rather than an inserted proof or caller authorization flag.
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
      clientId: 'identity-retention-test',
      scopes: ['account:delete'],
    },
  );
  await createLifecycleCommands({ pool, access, clock }).tombstone(
    { actor, deadline: Date.now() + 10_000 },
    { accountId: account.id, key: key() },
  );
  const root = (
    await pool.query<{ version: number; at: string }>(
      'SELECT version,at::text FROM access.erasure WHERE route=$1 AND account_id=$2',
      [accountRoute, account.id],
    )
  ).rows[0]!;
  const barrier = { accountId: account.id, accountRoute, ...root };
  const pending = await minimizeDiscoveredAgentIdentitySources(pool, { barrier, role: 'account_id', keys });
  expect(pending).toHaveLength(before.length);
  for (const item of pending) {
    expect(item).toMatchObject({ state: 'pending', gap: 'semantic.identity-epoch.account-source-terminal-custody' });
    expect(item.copies.gaps).toEqual([
      'agent-identity-original-inventory-unsealed',
      'agent-identity-sdk-recording-port-unavailable',
    ]);
  }
  expect(
    (
      await pool.query(
        'SELECT * FROM access.agent_identity_intent WHERE route=$1 AND account_id=$2 ORDER BY direction,receipt_id',
        [accountRoute, account.id],
      )
    ).rows,
  ).toEqual(before);

  // A subject root cannot erase the living decider's role or certify an absent source as consumed.
  const foreign = await minimizeDiscoveredAgentIdentitySources(pool, { barrier, role: 'decided_by', keys });
  expect(foreign.every((item) => item.gap === 'native-source-role-unavailable')).toBe(true);
  const missing = await minimizeDiscoveredAgentIdentitySources(pool, {
    barrier,
    role: 'account_id',
    keys: [[String(accountRoute), account.id, 'account-agent.verify', randomUUID()]],
  });
  expect(missing[0]?.gap).toBe('native-source-missing');
  const stale = await minimizeDiscoveredAgentIdentitySources(pool, {
    barrier: { ...barrier, version: barrier.version + 1 },
    role: 'account_id',
    keys,
  });
  expect(stale.every((item) => item.gap === 'native-erasure-root-unavailable')).toBe(true);
  const survivingDecider = (
    await pool.query('SELECT state FROM access.account WHERE route=$1 AND account_id=$2', [accountRoute, staff.id])
  ).rows[0];
  expect(survivingDecider.state).toBe('active');
  expect(() =>
    minimizeDiscoveredAgentIdentitySources(pool, {
      barrier,
      role: 'account_id',
      keys: Array.from({ length: 9 }, () => keys[0]!),
    }),
  ).toThrow();
});

test('native identity retention reads actual original copy associations and preserves their unsealed boundary', async () => {
  const { prepareAgentIdentityCopyRetention, agentIdentityCopyRetention } =
    await import('../../src/access/shared-history-agent-identity.ts');
  const { account } = await verified();
  const source = (
    await pool.query(
      `SELECT route,account_id,direction,receipt_id FROM access.agent_identity_intent
     WHERE route=$1 AND account_id=$2 AND direction='account-agent.verify'`,
      [accountRoute, account.id],
    )
  ).rows[0]!;
  // No committed erasure exists: actual associated bytes are observable but cannot have a receipt.
  const copy = await prepareAgentIdentityCopyRetention(
    pool,
    {
      accountId: account.id,
      accountRoute,
      version: 1,
      at: new Date().toISOString(),
    },
    { route: source.route, accountId: source.account_id, direction: source.direction, receiptId: source.receipt_id },
    Date.now() + 5000,
  );
  expect(copy.artifact?.locator.artifactType).toBe('command-receipt/v1');
  expect(copy.artifact?.accounts.some((role) => role.accountId === account.id)).toBe(true);
  expect(copy.receipt).toBeNull();
  expect(copy.gap).toBe('agent-identity-original-inventory-unsealed');
  expect(agentIdentityCopyRetention().gaps).toEqual([
    'agent-identity-original-inventory-unsealed',
    'agent-identity-sdk-recording-port-unavailable',
  ]);
});

test('native identity retention refuses a foreign root on a source-home command before source or root disclosure', async () => {
  const { prepareAgentIdentityRetention } = await import('../../src/access/agent-verification-identity-retention.ts');
  const { account } = await verified();
  const before = (
    await pool.query(
      'SELECT * FROM access.agent_identity_intent WHERE route=$1 AND account_id=$2 ORDER BY direction,receipt_id',
      [accountRoute, account.id],
    )
  ).rows;
  const otherRoute = 0x5274 ^ 0x10;
  const answer = (
    await runCommand(pool, { partition: accountRoute >>> 4 }, async (tx) =>
      noEffect(
        await prepareAgentIdentityRetention(tx, {
          barrier: { accountId: newId(otherRoute), accountRoute: otherRoute, version: 1, at: new Date().toISOString() },
          role: 'requested_by',
          keys: [
            {
              route: accountRoute,
              accountId: account.id,
              direction: before[0]!.direction,
              receiptId: before[0]!.receipt_id,
            },
          ],
        }),
      ),
    )
  ).value;
  expect(answer).toHaveLength(1);
  expect(answer[0]?.gap).toBe('native-erasure-source-home-root-custody-unavailable');
  expect(
    (
      await pool.query(
        'SELECT * FROM access.agent_identity_intent WHERE route=$1 AND account_id=$2 ORDER BY direction,receipt_id',
        [accountRoute, account.id],
      )
    ).rows,
  ).toEqual(before);
});

test('default native identity cleanup refuses incomplete copies then minimizes the exact original source under real receiving closure while preserving surviving attribution and technical undo', async () => {
  const { createWorkClient } = await import('../../src/work/client.ts');
  const { enqueueAgentIdentityVerification, enqueueAgentIdentityReversal, agentIdentityRetirementReadiness } =
    await import('../../src/history/agent-identity-work.ts');
  const { reverseDeletedAccountAgent } = await import('../../src/access/agent-verification.ts');
  const { openNativeErasure, advanceNativeErasure, NATIVE_ERASURE_GROUPS } =
    await import('../../src/access/erasure-native.ts');
  const { admitSharedHistory, advanceSharedHistory } = await import('../../src/access/shared-history.ts');
  const { HistoryRegistry } = await import('../../src/history/registry.ts');
  const { readAccountIdentityUndo } = await import('../../src/semantic/identity-epoch-binding.ts');
  const { account } = await verifiedHistoryHomeZero();
  const original = (
    await pool.query(
      `SELECT * FROM access.agent_identity_intent WHERE route=0 AND account_id=$1 AND direction='account-agent.verify'`,
      [account.id],
    )
  ).rows[0]!;
  const client = await createWorkClient(databaseUrl, pool);
  try {
    await client.registerQueue('workflows', {});
    expect(await enqueueAgentIdentityVerification(pool, client, original.request_id, original.receipt_id)).toBe(
      'admitted',
    );
    await pool.query(
      `INSERT INTO access.resource_grant(route,resource_id,subject_id,action,valid,transaction_id)
       VALUES(0,$1,$1,'account:delete','(,)',$1)`,
      [account.id],
    );
    const actor = await authenticateAccount(
      access,
      { pool, deadline: Date.now() + 10_000 },
      {
        accountId: account.id,
        clientId: 'native-identity-cleanup-test',
        scopes: ['account:delete'],
      },
    );
    await createLifecycleCommands({ pool, access, clock }).tombstone(
      { actor, deadline: Date.now() + 10_000 },
      { accountId: account.id, key: key() },
    );
    await reverseDeletedAccountAgent(pool, account.id);
    const reversal = (
      await pool.query(
        `SELECT data FROM core.outbox WHERE partition_no=0 AND subject=$1
       AND type='com.rezics.access.agent-verification.reversing.v1'`,
        [account.id],
      )
    ).rows[0]!.data as AgentVerificationReversal;
    await finish(reversal);
    expect(await enqueueAgentIdentityReversal(pool, client, reversal)).toBe('admitted');
    const sources = (
      await pool.query(
        'SELECT * FROM access.agent_identity_intent WHERE route=0 AND account_id=$1 ORDER BY direction,receipt_id',
        [account.id],
      )
    ).rows;
    expect(sources).toHaveLength(2);
    const progress = await openNativeErasure(pool, account.id);
    const phase = NATIVE_ERASURE_GROUPS.findIndex(
      ([store, role]) => store === 'agent_identity_intent' && role === 'account_id',
    );
    expect(phase).toBeGreaterThanOrEqual(0);
    // Select an ordinary scalar page, never install a Source/SDK/receiving verdict.
    const select = () =>
      pool.query('UPDATE access.erasure_native_progress SET phase=$2,page=0 WHERE progress_id=$1', [progress, phase]);
    await select();
    await advanceNativeErasure(pool, progress, {
      client,
      env: process.env,
      clock,
    });
    expect(
      (
        await pool.query(
          'SELECT * FROM access.agent_identity_intent WHERE route=0 AND account_id=$1 ORDER BY direction,receipt_id',
          [account.id],
        )
      ).rows,
    ).toEqual(sources);
    expect(
      (
        await pool.query('SELECT reason FROM access.erasure_native_blocked WHERE progress_id=$1 AND phase=$2', [
          progress,
          phase,
        ])
      ).rows[0]?.reason,
    ).toBe('verification-source-custody');

    const history = randomUUID();
    await runCommand(pool, { partition: 0 }, async (tx) => {
      await admitSharedHistory(tx, account.id, history);
      return noEffect(null);
    });
    const registry = new HistoryRegistry();
    registry.registerOwner({
      name: 'access.agent-identity',
      artifactType: 'durable-work/v1',
      version: 1,
      readiness: agentIdentityRetirementReadiness,
    });
    // Exercise the installed default selected unit and native physical minimizers.
    // This regression intentionally runs only with final-frame funding installed.
    for (let step = 0; step < 32; step++) {
      await advanceSharedHistory({ pool, client, registry, env: process.env, clock }, history);
      const remaining = (
        await pool.query(
          `SELECT count(*)::integer n FROM core.history_locator WHERE partition_no=0 AND account_id=$1
         AND state<>'minimized'`,
          [account.id],
        )
      ).rows[0]!.n;
      if (remaining === 0) break;
    }
    expect(
      (
        await pool.query(
          `SELECT count(*)::integer n FROM core.history_locator WHERE partition_no=0 AND account_id=$1
       AND state<>'minimized'`,
          [account.id],
        )
      ).rows[0]!.n,
    ).toBe(0);
    await select();
    await advanceNativeErasure(pool, progress, {
      client,
      env: process.env,
      clock,
    });
    const minimized = (
      await pool.query(
        'SELECT * FROM access.agent_identity_intent WHERE route=0 AND account_id=$1 ORDER BY direction,receipt_id',
        [account.id],
      )
    ).rows;
    expect(minimized).toHaveLength(sources.length);
    for (let i = 0; i < sources.length; i++) {
      expect(minimized[i]).toMatchObject({
        minimized: true,
        intent: {},
        decided_by: sources[i].decided_by === account.id ? null : sources[i].decided_by,
        requested_by: sources[i].requested_by === account.id ? null : sources[i].requested_by,
        intent_digest: sources[i].intent_digest,
        source_transaction_id: sources[i].source_transaction_id,
      });
    }
    expect(
      (await pool.query('SELECT state FROM access.account WHERE route=$1 AND account_id=$2', [accountRoute, staff.id]))
        .rows[0]!.state,
    ).toBe('active');
    const undo = await readAccountIdentityUndo(pool, {
      kind: 'account-agent.verify',
      account: account.id,
      receipt: original.receipt_id,
    });
    expect(undo.source.digest).toBe(original.intent_digest);
    // A retry cannot delete the technical skeleton or surviving decider attribution.
    await select();
    await advanceNativeErasure(pool, progress, {
      client,
      env: process.env,
      clock,
    });
    expect(
      (
        await pool.query(
          'SELECT * FROM access.agent_identity_intent WHERE route=0 AND account_id=$1 ORDER BY direction,receipt_id',
          [account.id],
        )
      ).rows,
    ).toEqual(minimized);
  } finally {
    await client.destroy();
  }
});

test('identity History reuses the original Source frame without replenishing it and rejects foreign or ended frames before dispatch', async () => {
  const source = await import('../../src/semantic/identity-source-consumer-maintenance.ts');
  const { withAgentIdentityHistoryUnit, currentAgentIdentityHistoryUnit } =
    await import('../../src/history/agent-identity-retirement.ts');
  const { reserveIdentityHistoryWork, nativeWork } = await import('../../src/history/agent-identity-inventory-work.ts');
  const otherPool = new Pool({ connectionString: databaseUrl });
  const deadline = Date.now() + 5000;
  let ended: import('../../src/history/receiving.ts').HistoryReceivingContext | undefined;
  let calls = 0;
  try {
    await source.withIdentitySourceConsumerMaintenance({ pool, env: {} }, { deadline }, async (funded) => {
      ended = funded;
      const before = source.identitySourceConsumerNativeWork(pool, funded.identityConsumerWork, deadline)!;
      await withAgentIdentityHistoryUnit({ pool, env: {} }, { deadline }, async (nested) => {
        expect(nested.identityConsumerWork).toBe(funded.identityConsumerWork);
        expect(nested.deadline).toBe(deadline);
        expect(currentAgentIdentityHistoryUnit()?.context).toBe(nested);
        await reserveIdentityHistoryWork(pool, nativeWork(1, 1, 1, 0), nested);
        calls++;
        await expect(withAgentIdentityHistoryUnit({ pool, env: {} }, nested, async () => calls++)).rejects.toThrow(
          'cannot replace its Source frame',
        );
      });
      expect(source.identitySourceConsumerNativeWork(pool, funded.identityConsumerWork, deadline)).toEqual({
        ...before,
        rows: before.rows - 1,
        points: before.points - 1,
        statements: before.statements - 1,
      });
      await expect(
        withAgentIdentityHistoryUnit({ pool: otherPool, env: {} }, { deadline }, async () => calls++),
      ).rejects.toThrow('identity-history-native-funding-unavailable');
      expect(currentAgentIdentityHistoryUnit()).toBeUndefined();
    });
    await expect(withAgentIdentityHistoryUnit({ pool, env: {} }, ended!, async () => calls++)).rejects.toThrow(
      'identity-history-native-funding-unavailable',
    );
    expect(calls).toBe(1);
  } finally {
    await otherPool.end();
  }
});

test('released original receipt receiving uses a real command and rechecks current barrier and role union without closing source or SDK custody', async () => {
  const { readAgentIdentityNativeInventory, verifyAgentIdentityInventory } =
    await import('../../src/history/agent-identity-inventory.ts');
  const {
    readHistoryReceivingReceipt,
    recordHistoryReceivingProof,
    verifyHistoryReceivingReceipt,
    historyReceivingGap,
  } = await import('../../src/history/receiving.ts');
  const { withConnection } = await import('../../src/database/pool.ts');
  const { sealHistoryAccount } = await import('../../src/history/gates.ts');
  const { encodeLocator } = await import('../../src/history/locator.ts');
  const { account, token } = await verifiedHistoryHomeZero();
  const released = await post(`/v1/accounts/${account.id}:releaseVerification`, token);
  expect(released.response.status).toBe(200);
  const decision = released.body.reversal as AgentVerificationReversal;
  await finish(decision);
  const key = {
    route: 0,
    accountId: account.id,
    direction: 'account-agent.unverify' as const,
    receiptId: decision.receiptId,
  };
  const inventory = await readAgentIdentityNativeInventory(pool, key, { deadline: Date.now() + 5000 });
  expect(inventory.state).toBe('sealed');
  if (inventory.state !== 'sealed') throw new Error('Original serializer did not seal its native inventory');
  const artifact = inventory.proof.artifacts.find((copy) => copy.locator.artifactType === 'command-receipt/v1')!;
  const root = (
    await pool.query(
      'INSERT INTO access.erasure(route,account_id,version,at) VALUES(0,$1,1,now()) RETURNING version,at::text',
      [account.id],
    )
  ).rows[0];
  const barrier = { accountRoute: 0, accountId: account.id, version: root.version, at: root.at };
  expect(await withConnection(pool, (tx) => historyReceivingGap(tx, 0, artifact.locator, barrier, pool))).toBe(
    'history-receiving-command-resources-unavailable',
  );
  // Independently committed physical-owner disposition, using the original generated
  // receipt and exact locator. No SDK or Source closure is fabricated by this fixture.
  await runCommand(pool, { partition: 0 }, async (tx) => {
    await sealHistoryAccount(tx, 0, 0, account.id);
    await tx.query(
      `UPDATE core.receipt SET response='null'::jsonb,payload_state='minimized'
       WHERE partition_no=0 AND transaction_id=$1 AND position=$2 AND epoch=$3`,
      [
        inventory.proof.original.transactionId,
        inventory.proof.original.position.toString(),
        inventory.proof.original.epoch,
      ],
    );
    await tx.query(
      `UPDATE core.history_locator SET state='minimized',proof_barrier=$1
       WHERE partition_no=0 AND account_route=0 AND account_id=$1 AND artifact_type='command-receipt/v1' AND locator=$2`,
      [account.id, Buffer.from(encodeLocator(artifact.locator))],
    );
    expect(await recordHistoryReceivingProof(tx, barrier, 0, artifact.locator, pool)).toBeNull();
    return noEffect(null);
  });
  const receipt = await readHistoryReceivingReceipt({ pool }, barrier, artifact, { deadline: Date.now() + 5000 });
  expect(receipt).not.toBeNull();
  expect(
    (
      await runCommand(pool, { partition: 0 }, async (tx) =>
        noEffect(await verifyHistoryReceivingReceipt(tx, barrier, artifact, receipt!)),
      )
    ).value,
  ).toBe(true);
  expect(
    await readHistoryReceivingReceipt({ pool }, { ...barrier, version: barrier.version + 1 }, artifact, {
      deadline: Date.now() + 5000,
    }),
  ).toBeNull();
  expect(
    (
      await runCommand(pool, { partition: 0 }, async (tx) =>
        noEffect(
          await verifyHistoryReceivingReceipt(
            tx,
            barrier,
            { ...artifact, accounts: artifact.accounts.slice(1) },
            receipt!,
          ),
        ),
      )
    ).value,
  ).toBe(false);
  expect(
    (
      await runCommand(pool, { partition: 0 }, async (tx) =>
        noEffect(await verifyAgentIdentityInventory(tx, barrier, key, inventory.proof)),
      )
    ).value.state,
  ).toBe('pending');
  expect(
    (
      await pool.query(
        'SELECT minimized FROM access.agent_identity_intent WHERE route=0 AND account_id=$1 AND direction=$2 AND receipt_id=$3',
        [account.id, key.direction, key.receiptId],
      )
    ).rows[0].minimized,
  ).toBe(false);
});

test('SDK identity observations reject an ended explicit token and a foreign Account barrier', async () => {
  const owner = await import('../../src/semantic/identity-source-consumer-maintenance.ts');
  const { readAgentIdentitySDKWriterState, readAgentIdentitySDKReceivingBinding } =
    await import('../../src/history/agent-identity-sdk-fence.ts');
  const { createWorkClient } = await import('../../src/work/client.ts');
  const { recordHistoryReceivingProof, historyReceivingGap } = await import('../../src/history/receiving.ts');
  const client = await createWorkClient(databaseUrl, pool);
  const deadline = Date.now() + 5000;
  let ended: import('../../src/history/receiving.ts').HistoryReceivingContext | undefined;
  try {
    await owner.withIdentitySourceConsumerMaintenance({ pool, env: {} }, { deadline }, async (context) => {
      ended = context;
    });
    await owner.withIdentitySourceConsumerMaintenance({ pool, env: {} }, { deadline }, async (context) => {
      const before = owner.identitySourceConsumerNativeWork(pool, context.identityConsumerWork, deadline);
      expect(await readAgentIdentitySDKWriterState(pool, client, randomUUID(), ended!)).toEqual({
        state: 'pending',
        gap: 'identity-sdk-current-fence-funding-unavailable',
      });
      // An ambient live balance must neither replace the supplied token nor pay for its SDK read.
      expect(owner.identitySourceConsumerNativeWork(pool, context.identityConsumerWork, deadline)).toEqual(before);
    });
    const foreign = newId(accountRoute);
    const observed = await runCommand(pool, { partition: 0, deadline }, async (tx) =>
      noEffect(
        await readAgentIdentitySDKReceivingBinding(
          tx,
          {
            partition: 0,
            locator: { artifactType: 'durable-work/v1', workId: randomUUID() },
            accounts: [],
          },
          { accountRoute, accountId: foreign, version: 1, at: new Date().toISOString() },
        ),
      ),
    );
    expect(observed.value).toEqual({ state: 'pending', gap: 'agent-identity-source-barrier-home-unavailable' });
    const homes = await runCommand(pool, { partition: 0, deadline }, async (tx) => {
      const locator = { artifactType: 'durable-work/v1' as const, workId: randomUUID() };
      const barrier = { accountRoute, accountId: foreign, version: 1, at: new Date().toISOString() };
      return noEffect({
        foreignBarrier: await recordHistoryReceivingProof(tx, barrier, 0, locator, pool),
        foreignArtifact: await historyReceivingGap(tx, 1, locator, barrier, pool),
      });
    });
    expect(homes.value).toEqual({
      foreignBarrier: 'history-receiving-barrier-home-unavailable',
      foreignArtifact: 'history-receiving-artifact-home-unavailable',
    });
  } finally {
    await client.destroy();
  }
});

test('recovery snapshot controls and direct Account preparation spend the inherited original balance before their SQL', async () => {
  const owner = await import('../../src/semantic/identity-source-consumer-maintenance.ts');
  const { readAgentIdentityRecoveryInventory, AGENT_IDENTITY_RECOVERY_INVENTORY_SNAPSHOT_COST } =
    await import('../../src/history/agent-identity-inventory.ts');
  const { prepareAgentIdentityRetention } = await import('../../src/access/agent-verification-identity-retention.ts');
  const key = { route: 0, accountId: newId(0), direction: 'account-agent.verify' as const, receiptId: randomUUID() };
  const barrier = { accountRoute: 0, accountId: key.accountId, version: 1, at: new Date().toISOString() };
  const deadline = Date.now() + 5000;
  expect(AGENT_IDENTITY_RECOVERY_INVENTORY_SNAPSHOT_COST).toEqual({
    rows: 136,
    points: 135,
    statements: 10,
    bytes: 32896,
    engineRequests: 0,
  });
  await owner.withIdentitySourceConsumerMaintenance(
    { pool, env: { KERNEL_IDENTITY_SOURCE_MAINTENANCE_NATIVE_STATEMENTS: '9' } },
    { deadline },
    async (context) => {
      const before = owner.identitySourceConsumerNativeWork(pool, context.identityConsumerWork, deadline);
      await expect(readAgentIdentityRecoveryInventory({ pool }, barrier, key, context)).rejects.toThrow(
        'identity-history-native-funding-unavailable',
      );
      expect(owner.identitySourceConsumerNativeWork(pool, context.identityConsumerWork, deadline)).toEqual(before);
    },
  );
  await owner.withIdentitySourceConsumerMaintenance(
    { pool, env: { KERNEL_IDENTITY_SOURCE_MAINTENANCE_NATIVE_STATEMENTS: '4' } },
    { deadline },
    async (context) => {
      const before = owner.identitySourceConsumerNativeWork(pool, context.identityConsumerWork, deadline);
      await expect(
        runCommand(pool, { partition: 0, deadline }, async (tx) =>
          noEffect(await prepareAgentIdentityRetention(tx, { barrier, role: 'account_id', keys: [key] })),
        ),
      ).rejects.toThrow('identity-history-native-funding-unavailable');
      expect(owner.identitySourceConsumerNativeWork(pool, context.identityConsumerWork, deadline)).toEqual(before);
    },
  );
});

test('released identity physical inventory refuses insufficient original funding before checkout', async () => {
  const { spyOn } = await import('bun:test');
  const owner = await import('../../src/semantic/identity-source-consumer-maintenance.ts');
  const { readAgentIdentityReceivingArtifact, AGENT_IDENTITY_RECEIVING_ARTIFACT_COST } =
    await import('../../src/history/agent-identity-sdk-fence.ts');
  const deadline = Date.now() + 5000;
  expect(AGENT_IDENTITY_RECEIVING_ARTIFACT_COST).toEqual({
    rows: 69,
    points: 69,
    statements: 4,
    bytes: 24576,
    engineRequests: 0,
  });
  const checkout = spyOn(pool, 'connect');
  try {
    await owner.withIdentitySourceConsumerMaintenance(
      { pool, env: { KERNEL_IDENTITY_SOURCE_MAINTENANCE_NATIVE_STATEMENTS: '3' } },
      { deadline },
      async (context) => {
        const before = owner.identitySourceConsumerNativeWork(pool, context.identityConsumerWork, deadline);
        await expect(readAgentIdentityReceivingArtifact(pool, randomUUID(), context)).rejects.toThrow(
          'identity-history-native-funding-unavailable',
        );
        expect(checkout).not.toHaveBeenCalled();
        expect(owner.identitySourceConsumerNativeWork(pool, context.identityConsumerWork, deadline)).toEqual(before);
      },
    );
  } finally {
    checkout.mockRestore();
  }
});
