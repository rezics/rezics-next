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
    const native = (await pool.query('SELECT * FROM core.agent_identity_work WHERE workflow_id=$1', [source.workflowId]))
      .rows[0];
    const inputs = (await pool.query('SELECT inputs FROM dbos.workflow_input WHERE workflow_uuid=$1', [source.workflowId]))
      .rows[0].inputs;
    const erased = (
      await pool.query('INSERT INTO access.erasure(route,account_id,version,at) VALUES($1,$2,1,now()) RETURNING version,at::text', [
        accountRoute, account.id,
      ])
    ).rows[0];
    const barrier = { accountId: account.id, accountRoute, version: erased.version, at: erased.at };
    const reference = {
      receipt, job, barrier, erasedRole: 'subject' as const,
      source: { partition: source.partition, epoch: source.epoch, position: source.position, transactionId: source.transactionId },
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
    const verify = (candidate = stage) => runCommand(pool, { partition: source.partition }, async (tx) =>
      noEffect(await verifyAgentIdentityRetirementStage(tx, candidate)),
    );
    expect((await verify()).value).toEqual({ state: 'pending', gap: 'identity-source-consumer-custody-pending' });
    expect((await verify({ ...stage, handoff: { ...stage.handoff, generation: '0' } })).value.gap)
      .toBe('identity-sdk-retirement-source-fence-changed');
    await expect(runCommand(pool, { partition: 0 }, async (tx) =>
      noEffect(await verifyAgentIdentityRetirementStage(tx, stage)),
    )).rejects.toThrow('SAME native source home');
    const artifact = {
      partition: 0,
      locator: { artifactType: 'durable-work/v1' as const, workId: native.custody_id },
      accounts: native.accounts,
    };
    expect((await runCommand(pool, { partition: 0 }, async (tx) =>
      noEffect(await agentIdentityRetirementReadiness(tx, artifact, barrier)),
    )).value).toEqual({ ready: false, gap: AGENT_IDENTITY_SDK_RETIREMENT.gap });
    expect((await runCommand(pool, { partition: 0 }, async (tx) =>
      noEffect(await agentIdentityRetirementReadiness(tx, { ...artifact, accounts: [] }, barrier)),
    )).value).toEqual({ ready: false, gap: 'identity-sdk-retirement-role-scope-changed' });
    const registry = new HistoryRegistry();
    registry.registerOwner({ name: AGENT_IDENTITY_WORK_OWNER, artifactType: 'durable-work/v1', version: 1,
      readiness: agentIdentityRetirementReadiness });
    expect(await minimizeHistoryWork(pool, client,
      { partition_no: 0, account_route: accountRoute, account_id: account.id },
      Buffer.from(encodeLocator(artifact.locator)), registry, barrier,
    )).toBe(AGENT_IDENTITY_SDK_RETIREMENT.gap);
    expect(await readAgentIdentitySDKRetirementGap(pool, receipt, { deadline: Date.now() + 5000 }))
      .toBe(AGENT_IDENTITY_SDK_RETIREMENT.gap);
    expect(await readAgentIdentitySDKRetirementGap(pool, { ...receipt, receipt: randomUUID() }, { deadline: Date.now() + 5000 }))
      .toBe('agent-identity-sdk-recording-port-unavailable');
    // Core rejects a caller's ready flag as well as deletion of permanent native custody.
    await expect(pool.query('UPDATE core.history_work SET owner_ready=true WHERE partition_no=0 AND work_id=$1', [native.custody_id]))
      .rejects.toThrow('durable source transfer and permanent native writer fence');
    await expect(pool.query('DELETE FROM core.history_work WHERE partition_no=0 AND work_id=$1', [native.custody_id]))
      .rejects.toThrow('retirement custody is permanent');
    await expect(pool.query(`UPDATE core.agent_identity_sdk_obligation SET future_writer_state='closed'
      WHERE partition_no=$1 AND source_route=$2 AND source_account_id=$3 AND source_direction=$4 AND source_receipt_id=$5`,
      [partitionOf(accountRoute), accountRoute, account.id, receipt.kind, receipt.receipt],
    )).rejects.toThrow();
    expect((await pool.query('SELECT owner_ready,state,absence_verified FROM core.history_work WHERE partition_no=0 AND work_id=$1', [native.custody_id])).rows[0])
      .toEqual({ owner_ready: false, state: 'pending', absence_verified: false });
    expect((await pool.query('SELECT inputs FROM dbos.workflow_input WHERE workflow_uuid=$1', [source.workflowId])).rows[0].inputs).toBe(inputs);
    expect((await client.getWorkflow(source.workflowId))?.status).toBe('ENQUEUED');
    expect((await pool.query(`SELECT minimized FROM access.agent_identity_intent
      WHERE route=$1 AND account_id=$2 AND direction=$3 AND receipt_id=$4`,
      [accountRoute, account.id, receipt.kind, receipt.receipt],
    )).rows[0].minimized).toBe(false);
  } finally {
    await client.close();
  }
}, 60_000);
