import { expect } from 'bun:test';
import { randomBytes, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { Pool, type PoolClient } from 'pg';
import { exportJWK, generateKeyPair } from 'jose';
import { kernelTestDatabase, testDatabase } from '../../scripts/database.ts';
import { configureTestReceiptKeys } from '../../../kernel/test/support/receipt-keys.ts';
import { workerTestEnv } from '../../../kernel/test/support/worker-env.ts';
import { createAuthHost } from '../../src/index.ts';
import { createNativeWorkflowProofPorts } from '../../src/native-workflow-proofs.ts';
import { createProvisioningEvidenceVerifier } from '../../src/provisioning-evidence.ts';
import { createBarrierProofVerifier } from '../../src/barrier-proofs.ts';

export const issuer = 'https://native-erasure.auth.test';
export const password = 'native erasure acceptance password';
export const scopes = ['account:read', 'account:update', 'account:delete', 'account:manage'];
export type Person = { accountId: string; cookie: string; email: string; bearer: string };

/** Fault a native transaction, preserving both pg checkout overloads. Restoring
 * the hook never changes product state or manufactures a completion marker. */
export function failNativeQueries(pool: Pool, fails: (sql: string) => boolean, timing: 'before' | 'after' = 'before') {
  const connect = pool.connect;
  const wrap = (client: PoolClient) =>
    new Proxy(client, {
      get(target, property) {
        const value = Reflect.get(target, property);
        if (property === 'query')
          return (...args: unknown[]) => {
            const failure = () => {
              if (fails(String(args[0]))) throw new Error('Injected native consumer interruption');
            };
            if (timing === 'before') failure();
            const result = Reflect.apply(value, target, args);
            return timing === 'after'
              ? Promise.resolve(result).then((reply) => {
                  failure();
                  return reply;
                })
              : result;
          };
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
  pool.connect = new Proxy(connect, {
    apply(target, thisArg, args) {
      const callback = args[0];
      if (typeof callback === 'function')
        return Reflect.apply(target, thisArg, [
          (error: Error | null, client: PoolClient | undefined, release: (error?: Error | boolean) => void) =>
            callback(error, client && wrap(client), release),
        ]);
      return (Reflect.apply(target, thisArg, args) as Promise<PoolClient>).then(wrap);
    },
  });
  return () => {
    pool.connect = connect;
  };
}

/** Bind operating-session evidence in the session's current producer transaction.
 * A later INSERT cannot rewrite session role custody from another xid. */
export async function attachOperatingOpening(
  pool: Pool,
  input: {
    sessionId: string;
    subjectAccountId: string;
    actingHumanId: string;
    operatorAccountId: string;
    receiptId: string;
  },
) {
  const connection = await pool.connect();
  try {
    await connection.query('BEGIN');
    await connection.query('UPDATE session SET erasure_role_xid=txid_current() WHERE id=$1', [input.sessionId]);
    await connection.query(
      `INSERT INTO auth_session_opening (session_id,subject_account_id,acting_human_id,operator_account_id,receipt_id)
      VALUES ($1,$2,$3,$4,$5)`,
      [input.sessionId, input.subjectAccountId, input.actingHumanId, input.operatorAccountId, input.receiptId],
    );
    await connection.query('COMMIT');
  } catch (error) {
    await connection.query('ROLLBACK');
    throw error;
  } finally {
    connection.release();
  }
}

/** Real Access composition is test-only. Production Auth receives ports and an
 * Auth-only pool, never a kernel module, pool, key or credential. */
export async function nativeFixture(options: { openPool?: (url: string) => Promise<Pool> } = {}) {
  const fixture = testDatabase();
  const kernelFixture = kernelTestDatabase();
  const kernel = new Pool({ connectionString: kernelFixture.url });
  // Dedicated receipt material, independent of this fixture's Access reference keys.
  process.env.KERNEL_RECEIPT_KEYS ??= workerTestEnv().KERNEL_RECEIPT_KEYS!;
  configureTestReceiptKeys(kernel);
  const pool = options.openPool ? await options.openPool(fixture.url) : new Pool({ connectionString: fixture.url });
  const previous = process.env.DATABASE_URL;
  process.env.DATABASE_URL = kernelFixture.url;
  let modules;
  try {
    // Reylo must compile Kernel .sql modules before History adapters or Access load. A static History import
    // evaluates those adapters first and fails with a missing `sql` export.
    await import(createRequire(new URL('../../../kernel/package.json', import.meta.url)).resolve('reylo/register'));
    const { installNativeHistoryPreload } = await import('../../../kernel/src/composition/preload.ts');
    installNativeHistoryPreload();
    modules = {
      ...(await import('../../../kernel/src/access/index.ts')),
      ...(await import('../../../kernel/src/access/native-account-bindings.ts')),
      ...(await import('../../../kernel/src/access/workflow-approvals.ts')),
      ...(await import('../../../kernel/src/access/lifecycle.ts')),
      ...(await import('../../../kernel/src/access/bootstrap-governance.ts')),
      ...(await import('../../../kernel/src/route/route.ts')),
    };
  } finally {
    if (previous === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = previous;
  }
  const actions = new Map(modules.LIFECYCLE_ACTIONS);
  actions.set('account:manage', { anonymous: false });
  actions.set('access:grant', { anonymous: false });
  actions.set('client:manage', { anonymous: false });
  let host: Awaited<ReturnType<typeof createAuthHost>>;
  const access = modules.createAccess({
    actions,
    auth: {
      issuer,
      audience: 'https://native-erasure.api.test',
      jwksUrl: `${issuer}/.well-known/jwks.json`,
      fetch: async () => host.service.handler(new Request(`${issuer}/.well-known/jwks.json`)),
    },
  });
  const proofs = createNativeWorkflowProofPorts({ database: pool });
  const referenceKeys = { current: 1, keys: new Map([[1, randomBytes(32)]]) };
  const bindings = modules.createNativeAccountBindings({
    pool: kernel,
    access,
    actions,
    routeKey: randomBytes(32),
    referenceKeys,
    auth: () => host.service,
    proofs: {
      workflow: proofs,
      provisioning: createProvisioningEvidenceVerifier({ database: pool }),
      barriers: createBarrierProofVerifier({ database: pool }),
    },
  });
  const approvals = modules.createWorkflowApprovals({
    pool: kernel,
    access,
    actions,
    referenceKeys,
    creationBinding: proofs.creationBinding,
  });
  const context = bindings.accountManagementReads.context;
  const deliveries: { accountId: string; token: string }[] = [];
  const key = {
    ...(await exportJWK((await generateKeyPair('ES256', { extractable: true })).privateKey)),
    kid: 'native-erasure',
    alg: 'ES256',
  };
  host = await createAuthHost({
    database: pool,
    systemDatabasePool: pool,
    issuer,
    audience: 'https://native-erasure.api.test',
    secret: randomBytes(48).toString('hex'),
    signing: { activeKid: key.kid, privateKeys: [key] },
    trustedAccess: bindings.trustedAccess,
    access: bindings.workflowPorts,
    accountOperations: bindings.accountOperations,
    accountManagementReads: bindings.accountManagementReads,
    recoveryDelivery: {
      async deliver(message) {
        deliveries.push(message);
      },
    },
    stagingKey: randomBytes(32),
    executorId: `erasure-${randomUUID()}`,
    maintenanceSchedule: '* * * * * *',
  });
  await host.start();
  await host.service.internal.registerClient({ clientId: 'erasure-web', firstParty: true, scopes });
  const call = (path: string, body: unknown, cookie = '') =>
    host.handler(
      new Request(`${issuer}${path}`, {
        method: 'POST',
        headers: { origin: issuer, 'content-type': 'application/json', cookie },
        body: JSON.stringify(body),
      }),
    );
  return {
    fixture,
    pool,
    kernel,
    host,
    key,
    bindings,
    access,
    bootstrapGovernance: (accountId: string) => modules.bootstrapGovernance(kernel, accountId),
    approvals,
    deliveries,
    context,
    call,
    async login(
      person: Pick<Person, 'accountId' | 'email'>,
      clientId = 'erasure-web',
      requested = scopes,
      secret = password,
    ): Promise<Person> {
      const response = await call('/signin', {
        email: person.email,
        password: secret,
        client_id: clientId,
        scope: requested,
      });
      expect(response.status).toBe(200);
      const cookie = response.headers
        .getSetCookie()
        .map((value) => value.split(';')[0])
        .join('; ');
      const token = await call('/token', {}, cookie);
      expect(token.status).toBe(200);
      return { ...person, cookie, bearer: ((await token.json()) as { access_token: string }).access_token };
    },
    routeOf: modules.routeOf,
    async person(name: string): Promise<Person> {
      const id = randomUUID();
      const requestKey = `${name}-${id}`;
      const email = `${requestKey}@native-erasure.test`;
      const { accountId } = await host.workflows.register({
        key: requestKey,
        handle: `native_${id.replaceAll('-', '')}`,
        email,
        password,
      });
      const response = await call('/signin', { email, password, client_id: 'erasure-web', scope: scopes });
      expect(response.status).toBe(200);
      const cookie = response.headers
        .getSetCookie()
        .map((value) => value.split(';')[0])
        .join('; ');
      const token = await call('/token', {}, cookie);
      expect(token.status).toBe(200);
      return { accountId, email, cookie, bearer: ((await token.json()) as { access_token: string }).access_token };
    },
    async delete(person: Person, key = randomUUID()) {
      const operation = { kind: 'delete', accountId: person.accountId };
      const approval = await call('/account-operations/approve', { operationKey: key, operation }, person.cookie);
      expect(approval.status).toBe(200);
      const { reference } = (await approval.json()) as { reference: string };
      const handle = (
        await kernel.query<{ handle: string | null }>(
          'SELECT handle FROM access.account WHERE route=$1 AND account_id=$2',
          [modules.routeOf(person.accountId), person.accountId],
        )
      ).rows[0]?.handle;
      return call(
        '/account-operations/execute',
        { operationKey: key, operation, reference, ...(handle ? { confirmation: handle } : {}) },
        person.cookie,
      );
    },
    async close(options: { keepPool?: boolean } = {}) {
      if (options.keepPool) await host.workflows.close();
      else await host.stop();
      await kernel.end();
      kernelFixture.close();
      fixture.close();
    },
  };
}

/** Execute the registered retention workflow with an explicit foreground identity.
 * Polling uses the uncaptured assertion pool; the SDK result is read exactly once.
 * The host's own workflow and step SQL remain in the original growth context.
 */
export async function runNativeRetentionTick(admin: Pool, id: string): Promise<void> {
  const { DBOS } = await import('@dbos-inc/dbos-sdk');
  const { WORKFLOW_RETENTION_SCHEDULE } = await import('../../src/retention.ts');
  const schedule = (await DBOS.getSchedule(WORKFLOW_RETENTION_SCHEDULE))!;
  const handle = await DBOS.enqueueWorkflowWithOptions(
    { workflowName: schedule.workflowName, queueName: schedule.queueName!, workflowID: id },
    new Date(0),
    schedule.context,
  );
  for (;;) {
    const status = (await admin.query('SELECT status FROM auth_dbos.workflow_status WHERE workflow_uuid=$1', [id]))
      .rows[0]?.status;
    if (['SUCCESS', 'ERROR', 'CANCELLED', 'MAX_RECOVERY_ATTEMPTS_EXCEEDED'].includes(status)) break;
    await Bun.sleep(10);
  }
  await handle.getResult();
}

/** Lose the caller's readiness write after a genuine registration committed its return.
 * Recovery must read that actual SDK result; no ready bit or commitment is fabricated.
 */
export async function unconsumedRegistration(f: Awaited<ReturnType<typeof nativeFixture>>, key: string) {
  let interrupted = false;
  const restore = failNativeQueries(f.pool, (sql) => {
    if (interrupted || !sql.includes('UPDATE auth_copy_work SET ready=true')) return false;
    interrupted = true;
    return true;
  });
  try {
    await expect(
      f.host.workflows.register({
        key,
        handle: `retained_${randomUUID().replaceAll('-', '')}`,
        email: `${key}@retention.test`,
        password,
      }),
    ).rejects.toThrow('Injected native consumer interruption');
  } finally {
    restore();
  }
  expect(interrupted).toBe(true);
  const work = (
    await f.pool.query<{ workflow_id: string; ready: boolean; result_finished_at: Date }>(
      `SELECT w.workflow_id,w.ready,w.result_finished_at FROM auth_copy_work w
     JOIN auth_registration_stage s ON s.registration_id=w.source_key WHERE s.request_key=$1`,
      [key],
    )
  ).rows[0]!;
  expect(work).toMatchObject({ ready: false, result_finished_at: expect.any(Date) });
  return work.workflow_id;
}

/** Produce an actual versioned request and its native terminal consumer through HTTP. */
export async function consumedRetentionRequest(f: Awaited<ReturnType<typeof nativeFixture>>, key: string) {
  const person = await f.person(key);
  const operation = { kind: 'revoke', accountId: person.accountId };
  const approval = await f.call('/account-operations/approve', { operationKey: key, operation }, person.cookie);
  expect(approval.status).toBe(200);
  const { reference } = (await approval.json()) as { reference: string };
  const response = await f.call(
    '/account-operations/execute',
    { operationKey: key, operation, reference },
    person.cookie,
  );
  expect(response.status).toBe(200);
  const rows = (
    await f.pool.query<{ workflow_id: string; name: string }>(
      `SELECT DISTINCT w.workflow_id,w.name FROM auth_copy_work w JOIN auth_copy_role r USING(workflow_id)
     WHERE r.account_id=$1 AND w.name IN ('accounts.registration','accounts.operation')`,
      [person.accountId],
    )
  ).rows;
  const request = rows.find((row) => row.name === 'accounts.operation')!.workflow_id;
  expect(
    (
      await f.pool.query(
        'SELECT request_party_version,request_context_version,terminal_at FROM auth_workflow_request WHERE workflow_id=$1',
        [request],
      )
    ).rows[0],
  ).toMatchObject({ request_party_version: 1, request_context_version: 1, terminal_at: expect.any(Date) });
  return { request, copies: rows.map((row) => row.workflow_id) };
}
