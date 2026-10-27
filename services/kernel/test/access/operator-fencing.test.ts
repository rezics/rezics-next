import { randomBytes, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import {
  createAuthHost,
  createBarrierProofVerifier,
  createNativeWorkflowProofPorts,
  createProvisioningEvidenceVerifier,
  type AuthService,
} from '@rezics/auth';
import { exportJWK, generateKeyPair } from 'jose';
import { Pool } from 'pg';
import { migrate as migrateAuth } from '../../../auth/scripts/database.ts';
import { createPool } from '../../src/database/pool.ts';
import { createAccess } from '../../src/access/index.ts';
import { createKernel } from '../../src/http/kernel.ts';
import { createWriteRateLimiter } from '../../src/access/write-rate.ts';
import { createNativeAccountBindings } from '../../src/access/native-account-bindings.ts';
import { bootstrapGovernance } from '../../src/access/bootstrap-governance.ts';
import {
  COMMITTED_CONTINUATION_ACTIONS,
  createCommittedContinuations,
} from '../../src/access/committed-continuations.ts';
import { LIFECYCLE_ACTIONS } from '../../src/access/lifecycle.ts';
import { WORKFLOW_APPROVAL_ACTIONS } from '../../src/access/workflow-approvals.ts';
import { newId, routeOf, partitionOf } from '../../src/route/route.ts';
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { accountsWorkModule } from '../../src/access/membership-work.ts';
import { startWorker } from '../../src/worker.ts';
import { encodeListCursor } from '../../src/tokens/list-cursor.ts';
import { dropTestDatabase } from '../support/drop-test-database.ts';

const password = 'continuation-password';
const scopes = [
  'account:manage',
  'account:read',
  'account:update',
  'account:delete',
  'account:renew_cleanup',
  'account:suspend',
  ...WORKFLOW_APPROVAL_ACTIONS.keys(),
].sort();
const source = new URL(process.env.DATABASE_URL ?? '');
if (!source.protocol) throw new Error('DATABASE_URL must name a migrated isolated kernel database');
const suffix = randomUUID().replaceAll('-', '');
const authName = `continuation_auth_${suffix}`;
const connection = (name: string) => {
  const url = new URL(source.href);
  url.pathname = `/${name}`;
  return url.href;
};
const kernelUrl = source.href;
const authUrl = connection(authName);
const issuer = `https://continuation-${suffix}.auth.test`;
const audience = 'https://continuation.api.test';
const loginClient = 'continuation-login';
const appClient = 'continuation-app';
const routeKey = randomBytes(32);
const referenceKeys = { current: 1, keys: new Map([[1, randomBytes(32)]]) };
const stagingKey = randomBytes(32);
const secret = randomBytes(48).toString('base64url');
const actions = new Map([
  ...LIFECYCLE_ACTIONS,
  ...COMMITTED_CONTINUATION_ACTIONS,
  ...scopes.map((scope) => [scope, { anonymous: false }] as const),
]);
let frozen: Date | null = null;
const clock = () => frozen ?? new Date();
const admin = new Pool({ connectionString: connection('postgres') });
const kernel = createPool(kernelUrl);
const facts = new Pool({ connectionString: kernelUrl });
let authPool: Pool | undefined;
/** Proofs outlive host.stop(), which ends only the pool handed to the Auth host. */
let proofsPool: Pool | undefined;
let host: Awaited<ReturnType<typeof createAuthHost>> | undefined;
let service: AuthService | undefined;
let bindings: ReturnType<typeof createNativeAccountBindings> | undefined;
let approvals: ReturnType<typeof import('../../src/access/workflow-approvals.ts').createWorkflowApprovals> | undefined;
const executorId = `continuation-${suffix}`;
const callers = new Map<string, Headers>();

const required = <T>(value: T | null | undefined, description: string): T => {
  if (value == null) throw new Error(description);
  return value;
};
const cookies = (response: Response) =>
  new Headers({
    cookie: response.headers
      .getSetCookie()
      .map((cookie) => cookie.split(';')[0])
      .join('; '),
  });
const workflows = () => required(host, 'Auth host is stopped').workflows;
const authService = () => required(service, 'Auth service is stopped');
const readyBindings = () => required(bindings, 'Account bindings are not ready');
const readyApprovals = () => required(approvals, 'Workflow approvals are not ready');
async function request(path: string, body: unknown, caller?: string) {
  const response = await required(host, 'Auth host is stopped').handler(
    new Request(`${issuer}${path}`, {
      method: 'POST',
      headers: {
        origin: issuer,
        'content-type': 'application/json',
        cookie: caller ? (callers.get(caller)?.get('cookie') ?? '') : '',
      },
      body: JSON.stringify(body),
    }),
  );
  if (!response.ok) throw new Error(`${path} failed: ${response.status} ${await response.text()}`);
  return response;
}
async function login(email: string, clientId = appClient) {
  const response = await request('/signin', { email, password, client_id: clientId, scope: scopes });
  const handle = randomUUID();
  callers.set(handle, cookies(response));
  return handle;
}
async function bearer(caller: string) {
  const response = await request('/token', {}, caller);
  return (await response.json()).access_token as string;
}
async function person() {
  const id = randomUUID().replaceAll('-', '');
  const email = `${id}@example.test`;
  const handle = `human_${id}`;
  const registered = await workflows().register({ key: id, handle, email, password });
  const session = await login(email, loginClient);
  await request('/consent', { client_id: appClient, scope: scopes }, session);
  const caller = await login(email);
  return { accountId: registered.accountId, email, handle, caller };
}
async function startHost() {
  authPool = new Pool({ connectionString: authUrl });
  proofsPool ??= new Pool({ connectionString: authUrl });
  if (!bindings) {
    const proofs = createNativeWorkflowProofPorts({ database: proofsPool });
    bindings = createNativeAccountBindings({
      pool: kernel,
      access,
      actions,
      routeKey,
      clock,
      referenceKeys,
      auth: () => authService(),
      proofs: {
        workflow: proofs,
        provisioning: createProvisioningEvidenceVerifier({ database: proofsPool }),
        barriers: createBarrierProofVerifier({ database: proofsPool }),
      },
    });
    approvals = (await import('../../src/access/workflow-approvals.ts')).createWorkflowApprovals({
      pool: kernel,
      access,
      actions,
      referenceKeys,
      creationBinding: (input: {
        registrationId: string;
        operationKey: string;
        accountId?: string;
        reservationId?: string;
      }) => proofs.creationBinding(input),
    });
  }
  host = await createAuthHost({
    database: authPool,
    systemDatabasePool: authPool,
    issuer,
    audience,
    secret,
    signing: { activeKid: signingKey.kid, privateKeys: [signingKey] },
    siteActions: actions,
    trustedAccess: bindings.trustedAccess,
    access: bindings.workflowPorts,
    stagingKey,
    maintenanceSchedule: '0 0 1 1 *',
    executorId,
  });
  service = host.service;
  await host.start();
}
const pair = await generateKeyPair('ES256', { extractable: true });
const signingKey = { ...(await exportJWK(pair.privateKey)), kid: 'continuation-host' };
const access = createAccess({
  actions,
  auth: {
    issuer,
    audience,
    jwksUrl: `${issuer}/.well-known/jwks.json`,
    fetch: async () => authService().handler(new Request(`${issuer}/.well-known/jwks.json`)),
  },
});
const kernelHttp = createKernel({
  pool: kernel,
  routeKey,
  tokens: referenceKeys,
  access: () => access,
  writeRate: createWriteRateLimiter({ secret }),
});

let worker: ReturnType<typeof Bun.spawn> | undefined;
let workerLog = '';
let governor: Awaited<ReturnType<typeof person>>;
async function startKernelWorker() {
  const child = Bun.spawn(['bun', fileURLToPath(import.meta.url)], {
    env: {
      ...process.env,
      OPERATOR_FENCE_WORKER: '1',
      KERNEL_ROUTE_KEY: routeKey.toString('base64url'),
      KERNEL_SESSION_KEYS: `1:${Buffer.from(referenceKeys.keys.get(1)!).toString('base64url')}`,
      AUTH_ISSUER: issuer,
      AUTH_AUDIENCE: audience,
      AUTH_JWKS_URL: `${issuer}/.well-known/jwks.json`,
    },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  worker = child;
  void new Response(child.stderr).text().then((value) => {
    workerLog += value;
  });
  const reader = child.stdout.getReader();
  let output = '';
  while (!output.includes('Worker ready')) {
    const value = await reader.read();
    if (value.done) throw new Error(`Worker exited: ${workerLog}`);
    output += new TextDecoder().decode(value.value);
  }
  workerLog += output;
  void (async () => {
    while (true) {
      const value = await reader.read();
      if (value.done) return;
      workerLog += new TextDecoder().decode(value.value);
    }
  })();
}
async function stopKernelWorker() {
  if (!worker) return;
  worker.kill('SIGTERM');
  await worker.exited;
  worker = undefined;
}
async function waitFor(work: () => Promise<boolean>) {
  const until = Date.now() + 25_000;
  do {
    if (await work()) return;
    await Bun.sleep(50);
  } while (Date.now() < until);
  throw new Error(`Worker did not finish: ${workerLog}`);
}
async function link(operatorAccountId: string, subjectAccountId: string) {
  const held = (
    await readyBindings().operators.reserveResponsibility({ operatorAccountId, subjectAccountId, key: randomUUID() })
  ).value;
  await readyBindings().operators.recordOperatorRelation({
    ...held,
    expectedOperatorAccountId: null,
    expectedVersion: '0',
    key: randomUUID(),
  });
  return held;
}
async function seedUnrelatedSubjects(operatorAccountId: string, subjects: string[]) {
  if (subjects.length === 0) return;
  const links = subjects.map((accountId) => ({
    accountId,
    route: routeOf(accountId)!,
    reservationId: newId(routeOf(operatorAccountId)!),
    reservationTransactionId: randomUUID(),
    relationTransactionId: randomUUID(),
  }));
  const accounts = await facts.query(
    `INSERT INTO access.account(route,account_id,kind,state,transaction_id,membership_inverse_complete)
     SELECT route,account_id,'actor','active',account_id,true
     FROM unnest($1::integer[],$2::uuid[]) AS rows(route,account_id)`,
    [links.map((link) => link.route), links.map((link) => link.accountId)],
  );
  await facts.query(
    `INSERT INTO access.lifecycle_coordination
       (route,account_id,reservation_id,related_account_id,purpose,transaction_id)
     SELECT $1, $2, reservation_id, subject_account_id, 'operator', transaction_id
     FROM unnest($3::uuid[],$4::uuid[],$5::uuid[]) AS rows(reservation_id,subject_account_id,transaction_id)`,
    [
      routeOf(operatorAccountId),
      operatorAccountId,
      links.map((link) => link.reservationId),
      links.map((link) => link.accountId),
      links.map((link) => link.reservationTransactionId),
    ],
  );
  await facts.query(
    `INSERT INTO access.operator_relation_slot
       (route,subject_account_id,reservation_id,operator_account_id,terminal,transaction_id)
     SELECT route,subject_account_id,reservation_id,$1,false,transaction_id
     FROM unnest($2::integer[],$3::uuid[],$4::uuid[],$5::uuid[])
       AS rows(route,subject_account_id,reservation_id,transaction_id)`,
    [
      operatorAccountId,
      links.map((link) => link.route),
      links.map((link) => link.accountId),
      links.map((link) => link.reservationId),
      links.map((link) => link.relationTransactionId),
    ],
  );
  const linked = await facts.query(
    `WITH input AS MATERIALIZED (
       SELECT * FROM unnest($1::integer[],$2::uuid[],$3::uuid[],$4::uuid[])
         AS rows(route,account_id,reservation_id,transaction_id)
     ), counter_time AS MATERIALIZED (
       SELECT set_config('rezics.operator_at', transaction_timestamp()::text, true)
     )
     UPDATE access.account a
     SET operator_account_id=$5,operator_reservation_id=i.reservation_id,transaction_id=i.transaction_id
     FROM input i CROSS JOIN counter_time
     WHERE a.account_id=i.account_id AND a.route=i.route`,
    [
      links.map((link) => link.route),
      links.map((link) => link.accountId),
      links.map((link) => link.reservationId),
      links.map((link) => link.relationTransactionId),
      operatorAccountId,
    ],
  );
  if (accounts.rowCount !== subjects.length || linked.rowCount !== subjects.length)
    throw new Error(`Bulk fixture mismatch: accounts=${accounts.rowCount}, links=${linked.rowCount}`);
}
async function fixture() {
  const operator = await person();
  const credentials = [await person(), await person()];
  const credentialTokens = await Promise.all(credentials.map((value) => bearer(value.caller)));
  const subjects = credentials.map((value) => value.accountId);
  // The two credential-bearing subjects use native commands; unrelated fixture
  // accounts and their persisted responsibility rows are seeded in bulk.
  for (const subject of subjects) await link(operator.accountId, subject);
  const unrelated = Array.from({ length: 203 }, () => newId(0x7432));
  await seedUnrelatedSubjects(operator.accountId, unrelated);
  subjects.push(...unrelated);
  const pending = await readyBindings().operators.reserveResponsibility({
    operatorAccountId: operator.accountId,
    subjectAccountId: newId(0x7432),
    key: randomUUID(),
  });
  return { operator, credentials, credentialTokens, subjects, pending: pending.value };
}
async function suspended(accountId: string) {
  return (
    await facts.query(
      'SELECT state,authn_fenced AS fenced,minimum_authn_epoch::text AS epoch FROM access.account WHERE route=$1 AND account_id=$2',
      [routeOf(accountId), accountId],
    )
  ).rows[0];
}
async function suspensionRoute(accountId: string, caller = governor.caller) {
  return kernelHttp.fetch(
    new Request(`${audience}/v1/accounts/${accountId}:suspend`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${await bearer(caller)}`,
        'content-type': 'application/json',
        'idempotency-key': JSON.stringify(randomUUID()),
      },
      body: '{}',
    }),
  );
}
async function rootFor(accountId: string) {
  const row = (
    await facts.query('SELECT operation_key FROM access.committed_continuation WHERE route=$1 AND account_id=$2', [
      routeOf(accountId),
      accountId,
    ])
  ).rows[0];
  return required(await readyBindings().continuations.read(row.operation_key, accountId), 'Missing root');
}
if (process.env.OPERATOR_FENCE_CRASH_PAGE) {
  const input = JSON.parse(process.env.OPERATOR_FENCE_CRASH_PAGE) as { reference: string; key: string };
  const port = createCommittedContinuations({
    pool: kernel,
    access,
    referenceKeys: { current: 1, keys: new Map([[1, Buffer.from(input.key, 'base64url')]]) },
  });
  console.log(JSON.stringify(await port.continueCommittedPage(input.reference)));
  // Abrupt process loss after the page's commits, before scheduling a child.
  process.exit(71);
} else if (process.env.OPERATOR_FENCE_WORKER) {
  await startWorker({ databaseUrl: kernelUrl, executorId: `fencing-${randomUUID()}`, poolSize: 10 }, [
    accountsWorkModule,
  ]);
  console.log('Worker ready');
} else {
  beforeAll(async () => {
    await admin.query(`CREATE DATABASE "${authName}"`);
    migrateAuth(authUrl, fileURLToPath(new URL('../../../auth/db/migrations', import.meta.url)));
    await startHost();
    await authService().internal.registerClient({ clientId: loginClient, firstParty: true, scopes });
    await authService().internal.registerClient({ clientId: appClient, firstParty: false, scopes });
    governor = await person();
    await bootstrapGovernance(kernel, governor.accountId);
  });
  afterAll(async () => {
    await stopKernelWorker();
    await host?.stop();
    await proofsPool?.end();
    await authPool?.end().catch(() => {});
    await kernel.end();
    await facts.end();
    await dropTestDatabase(admin, authName);
    await admin.end();
  });
  test('platform staff suspend an operator through its approval and the worker fences 205 subjects with independent credentials', async () => {
    const f = await fixture();
    const operation = { kind: 'fence-operator' as const, accountId: f.operator.accountId, authorization: 'input' };
    // A manager's rights on the operator never authorize Global Context governance.
    for (const action of ['account:manage', 'account:suspend'])
      await facts.query(
        `INSERT INTO access.resource_grant(route,resource_id,subject_id,action,valid,transaction_id)
        VALUES ($1,$2,$3,$4,'(,)',$3)`,
        [routeOf(f.operator.accountId), f.operator.accountId, f.credentials[0]!.accountId, action],
      );
    for (const caller of [f.operator.caller, ...f.credentials.map((value) => value.caller)]) {
      await expect(
        readyApprovals().approve(
          await bearer(caller),
          { operationKey: randomUUID(), operation },
          { pool: kernel, deadline: Date.now() + 10_000 },
        ),
      ).rejects.toThrow();
      expect((await suspensionRoute(f.operator.accountId, caller)).status).toBe(403);
    }
    const key = randomUUID();
    const approval = await readyApprovals().approve(
      await bearer(governor.caller),
      { operationKey: key, operation },
      { pool: kernel, deadline: Date.now() + 10_000 },
    );
    const result = await workflows().fenceOperator({
      key,
      accountId: f.operator.accountId,
      authorization: approval.reference,
    });
    expect(result).toMatchObject({ accountId: f.operator.accountId, state: 'suspended' });
    expect(result).toHaveProperty('receiptId');
    expect(
      await workflows().fenceOperator({ key, accountId: f.operator.accountId, authorization: approval.reference }),
    ).toEqual(result);
    expect((await suspended(f.operator.accountId)).state).toBe('suspended');
    expect((await authPool!.query('SELECT id FROM session WHERE "userId"=$1', [f.operator.accountId])).rowCount).toBe(
      0,
    );
    const root = await rootFor(f.operator.accountId);
    expect(root.barrierReceiptId).toBe(result.receiptId);
    expect(root.allowlist.map((value) => value.step)).toEqual(['revoke-auth-sessions', 'operator-responsibility-page']);
    await startKernelWorker();
    try {
      await waitFor(
        async () =>
          (
            await facts.query(
              'SELECT count(*)::integer AS n FROM access.account WHERE account_id=ANY($1::uuid[]) AND authn_fenced',
              [f.subjects],
            )
          ).rows[0].n === 205,
      );
    } catch (error) {
      const diagnostic = await facts.query(
        `SELECT count(*)::integer AS total,
          count(*) FILTER (WHERE a.authn_fenced)::integer AS fenced,
          count(*) FILTER (WHERE a.operator_account_id=$2)::integer AS operated,
          count(*) FILTER (WHERE a.operator_relation_version=1)::integer AS versioned,
          (SELECT count(*)::integer FROM access.operator_relation_slot s WHERE s.subject_account_id=ANY($1::uuid[])) AS slots,
          (SELECT count(*)::integer FROM access.lifecycle_coordination c WHERE c.related_account_id=ANY($1::uuid[]) AND c.account_id=$2 AND c.purpose='operator') AS holds
        FROM access.account a WHERE a.account_id=ANY($1::uuid[])`,
        [f.subjects, f.operator.accountId],
      );
      await Bun.sleep(50);
      throw new Error(
        `${error instanceof Error ? error.message : String(error)}\n${JSON.stringify(diagnostic.rows[0])}\n${workerLog}`,
      );
    }
    expect(
      (
        await facts.query(
          'SELECT count(*)::integer AS n FROM access.operator_fence_page WHERE continuation_id=(SELECT continuation_id FROM access.committed_continuation WHERE route=$1 AND account_id=$2)',
          [routeOf(f.operator.accountId), f.operator.accountId],
        )
      ).rows[0].n,
    ).toBe(3);
    for (const token of f.credentialTokens) {
      const refused = await kernelHttp.fetch(
        new Request(`${audience}/v1/accounts?ids=${f.operator.accountId}`, {
          headers: { authorization: `Bearer ${token}` },
        }),
      );
      expect(refused.status).toBe(401);
    }
    for (const credential of f.credentials) {
      const response = await host!.handler(
        new Request(`${issuer}/token`, {
          method: 'POST',
          headers: {
            origin: issuer,
            'content-type': 'application/json',
            cookie: callers.get(credential.caller)!.get('cookie')!,
          },
          body: '{}',
        }),
      );
      expect(response.status).not.toBe(200);
      expect(
        (await authPool!.query('SELECT id FROM session WHERE "userId"=$1', [credential.accountId])).rowCount,
      ).toBeGreaterThan(0);
    }
    expect(
      (
        await facts.query(
          'SELECT reservation_id FROM access.lifecycle_coordination WHERE route=$1 AND account_id=$2 AND reservation_id=$3',
          [routeOf(f.operator.accountId), f.operator.accountId, f.pending.reservationId],
        )
      ).rowCount,
    ).toBe(1);
    await stopKernelWorker();
    const steps = await facts.query(`SELECT s.workflow_uuid, count(*)::integer AS n
      FROM dbos.workflow_status w JOIN dbos.operation_outputs s ON s.workflow_uuid=w.workflow_uuid
      WHERE w.name='accounts.operator-fence-page' AND s.function_name='accounts.operator-fence-page.run'
      GROUP BY s.workflow_uuid`);
    expect(steps.rows).toHaveLength(3);
    expect(steps.rows.every((row) => row.n === 1)).toBe(true);
    // Trusted recovery is idempotent with completed worker pages.
    await readyBindings().continuations.continueCommitted(root.reference);
    expect((await suspended(f.subjects[0]!)).epoch).toBe('2');
  }, 60_000);

  test('the suspension route commits recovery before dispatch, skips a transferred subject, and resumes after a crash between pages', async () => {
    const f = await fixture();
    const response = await suspensionRoute(f.operator.accountId);
    expect(response.status).toBe(200);
    const result = (await response.json()).suspension;
    const root = await rootFor(f.operator.accountId);
    expect(root.barrierReceiptId).toBe(result.receiptId);
    const crashed = Bun.spawn(['bun', fileURLToPath(import.meta.url)], {
      env: {
        ...process.env,
        OPERATOR_FENCE_CRASH_PAGE: JSON.stringify({
          reference: root.reference,
          key: Buffer.from(referenceKeys.keys.get(1)!).toString('base64url'),
        }),
      },
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const [output, errors] = await Promise.all([
      new Response(crashed.stdout).text(),
      new Response(crashed.stderr).text(),
    ]);
    expect(await crashed.exited).toBe(71);
    expect(errors).toBe('');
    const first = JSON.parse(output) as { next: string; pageKey: string };
    expect(first.next).toBeString();
    const late = await readyBindings().operators.responsibilityWorkPage({
      operatorAccountId: f.operator.accountId,
      limit: 100,
      cursor: first.next!,
    });
    const transferred = late.operators[0]!;
    const nextOperator = await person();
    const held = (
      await readyBindings().operators.reserveResponsibility({
        operatorAccountId: nextOperator.accountId,
        subjectAccountId: transferred.subjectAccountId,
        key: randomUUID(),
      })
    ).value;
    await readyBindings().operators.recordOperatorRelation({
      ...held,
      expectedOperatorAccountId: f.operator.accountId,
      expectedVersion: '1',
      key: randomUUID(),
    });
    // Restart the trusted continuation port. Its first page receipts survive.
    const restarted = createCommittedContinuations({ pool: kernel, access, referenceKeys });
    await restarted.continueCommitted(root.reference);
    expect((await suspended(transferred.subjectAccountId)).fenced).toBe(false);
    for (const subject of f.subjects.filter((id) => id !== transferred.subjectAccountId)) {
      expect((await suspended(subject)).epoch).toBe('2');
    }
    await startKernelWorker();
    await waitFor(
      async () =>
        (
          await facts.query(
            "SELECT count(*)::integer AS n FROM dbos.workflow_status WHERE name='accounts.operator-fence-page' AND status='SUCCESS'",
            [],
          )
        ).rows[0].n >= 6,
    );
    await stopKernelWorker();
    expect((await suspended(transferred.subjectAccountId)).epoch).toBe('1');
    expect((await suspended(f.subjects[0]!)).epoch).toBe('2');
  }, 60_000);

  test('opaque responsibility pages refuse altered, foreign, stale and invalid-limit cursors before scanning', async () => {
    const operator = await person();
    const operatorId = operator.accountId;
    for (let i = 0; i < 3; i++)
      await readyBindings().operators.reserveResponsibility({
        operatorAccountId: operatorId,
        subjectAccountId: newId(0x7432),
        key: randomUUID(),
      });
    const f = { operator };
    const page = await readyBindings().operators.responsibilityPage({
      operatorAccountId: f.operator.accountId,
      limit: 1,
    });
    for (const limit of [0, 101, 1.5])
      await expect(
        readyBindings().operators.responsibilityPage({ operatorAccountId: f.operator.accountId, limit }),
      ).rejects.toThrow();
    const cursor = page.next!;
    const changed = `${cursor.slice(0, 12)}${cursor[12] === 'A' ? 'B' : 'A'}${cursor.slice(13)}`;
    for (const bad of [
      changed,
      await encodeListCursor(
        referenceKeys,
        { route: 'wrong-purpose', viewer: null, query: {} },
        { epoch: 1, after: [newId(1)] },
        new Date(),
      ),
    ]) {
      await expect(
        readyBindings().operators.responsibilityPage({
          operatorAccountId: f.operator.accountId,
          limit: 1,
          cursor: bad,
        }),
      ).rejects.toThrow();
    }
    await expect(
      readyBindings().operators.responsibilityPage({ operatorAccountId: governor.accountId, limit: 1, cursor }),
    ).rejects.toThrow();
    const partition = partitionOf(routeOf(f.operator.accountId)!);
    await facts.query('UPDATE core.partition SET epoch=epoch+1 WHERE partition_no=$1', [partition]);
    try {
      await expect(
        readyBindings().operators.responsibilityPage({ operatorAccountId: f.operator.accountId, limit: 1, cursor }),
      ).rejects.toThrow();
    } finally {
      await facts.query('UPDATE core.partition SET epoch=epoch-1 WHERE partition_no=$1', [partition]);
    }
  }, 60_000);
}
