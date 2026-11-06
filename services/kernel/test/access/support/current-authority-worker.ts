import type { Pool, PoolClient } from 'pg';
import { resourceRoleCatalogue } from '../../../src/access/resource-roles.ts';
import { readAccount } from '../../../src/access/account-data.ts';
import { accessCheck, AuthenticationError, type Access, type Resource } from '../../../src/request/access.ts';
import { routeOf } from '../../../src/route/route.ts';
import type { Evidence } from '../../../../../specs/permission-driver.ts';

export type AuthorityWorkerConfig = {
  databaseUrl: string;
  issuer: string;
  audience: string;
  authRelay: string;
  routeKey: string;
  referenceKeys: { current: number; keys: [number, string][] };
  authDatabaseUrl?: string;
  instant?: string;
};
export type AuthorityRequest =
  | { kind: 'http'; url: string; method: string; headers: [string, string][]; body?: string; instant?: string }
  | { kind: 'check'; bearer: string; action: string; resource: Resource; instant?: string }
  | { kind: 'operands'; bearer: string; resource: Resource; instant?: string }
  | { kind: 'failure'; source: Evidence; failure: 'missing' | 'unavailable' }
  | { kind: 'sale'; editionId: string; instant?: string }
  | { kind: 'stop' };
export type AuthorityReply = { status: number; body: string };

/** Evidence for a comparison, never an alternate evaluator. Queries use full
 * actor/principal and resource keys, and omit private account/profile fields.
 */
export async function currentAuthorityOperands(pool: Pool, access: Access, bearer: string, resource: Resource) {
  const context = { pool, deadline: Date.now() + 10_000 };
  const actor = await access.authenticate(bearer, context);
  const principal = actor.kind === 'account' ? actor.requestedBy?.split(':')[3] : undefined;
  const ids = actor.kind === 'account' ? [...new Set([actor.accountId, ...(principal ? [principal] : [])])] : [];
  const accounts = await Promise.all(
    ids.map(async (id) => {
      const account = await readAccount(pool, routeOf(id)!, id);
      return (
        account && {
          id: account.accountId,
          kind: account.kind,
          state: account.state,
          fenced: account.fenced,
          operator: account.operatorAccountId,
          floor: String(account.minimumAuthnEpoch),
        }
      );
    }),
  );
  const roles = resourceRoleCatalogue(access);
  const grants = await pool.query(
    `SELECT subject_kind,subject_id,subject_role,grant_role,valid::text
     FROM access.resource_role_grant WHERE route=$1 AND resource_id=$2 AND subject_id=ANY($3::uuid[])
     ORDER BY subject_kind,subject_id,subject_role,grant_role,valid`,
    [resource.route, resource.id, ids],
  );
  const database = await pool.query<{ name: string }>('SELECT current_database() AS name');
  const direct = await pool.query(
    `SELECT subject_kind,subject_id,subject_role,action,valid::text FROM access.resource_grant
     WHERE route=$1 AND resource_id=$2 AND subject_id=ANY($3::uuid[])
     ORDER BY subject_kind,subject_id,subject_role,action,valid`,
    [resource.route, resource.id, ids],
  );
  const denials = await pool.query(
    `SELECT subject_id,subject_role,action,reason,valid::text FROM access.resource_denial
     WHERE route=$1 AND resource_id=$2 AND subject_id=ANY($3::uuid[])
     ORDER BY subject_id,subject_role,action,reason,valid`,
    [resource.route, resource.id, ids],
  );
  return {
    database: database.rows[0]!.name,
    actor,
    accounts,
    resource,
    roles: [...(roles?.roles ?? [])],
    grants: grants.rows,
    direct: direct.rows,
    denials: denials.rows,
  };
}

/** The same fault boundary as the original permission driver: below Access at
 * the actual pg connection, including the child's independent Pool.
 */
function instrument(client: PoolClient, failures: Map<Evidence, 'missing' | 'unavailable'>) {
  const tables: Partial<Record<Evidence, RegExp>> = {
    accounts: /\baccess\.account\b/,
    resources: /\bcontent\.board\b/,
    grants: /\baccess\.resource_(?:role_)?grant\b|\baccess\.resource_denial\b/,
    delegatedRequests: /\baccess\.(?:principal_)?assignment\b/,
    memberships: /\baccess\.(?:organization_member|membership_inverse)\b/,
  };
  const query = client.query.bind(client) as (...args: unknown[]) => unknown;
  client.query = ((...args: unknown[]) => {
    const first = args[0];
    const sql = typeof first === 'string' ? first : ((first as { text?: string })?.text ?? '');
    for (const [source, failure] of failures) {
      if (!tables[source]?.test(sql)) continue;
      const error =
        failure === 'unavailable'
          ? Object.assign(new Error(`${source} evidence unavailable`), { code: '08006' })
          : null;
      const result = { rows: [], rowCount: 0, command: 'SELECT', oid: 0, fields: [] };
      const callback = args.find((arg) => typeof arg === 'function') as
        | ((error: Error | null, result?: unknown) => void)
        | undefined;
      if (callback) {
        queueMicrotask(() => callback(error, error ? undefined : result));
        return;
      }
      return error ? Promise.reject(error) : Promise.resolve(result);
    }
    return query(...args);
  }) as PoolClient['query'];
}

export async function startCurrentAuthorityWorker(config: AuthorityWorkerConfig) {
  let serial = 0;
  let errors = '';
  const pending = new Map<number, { resolve(value: AuthorityReply): void; reject(error: Error): void }>();
  const child = Bun.spawn(
    [process.execPath, '--preload', 'reylo/register', import.meta.filename, '--authority-worker'],
    {
      cwd: process.cwd(),
      stdin: 'ignore',
      stdout: 'ignore',
      stderr: 'pipe',
      ipc(message: unknown) {
        const reply = message as { id: number; value?: AuthorityReply; error?: string };
        const call = pending.get(reply.id);
        if (!call) return;
        pending.delete(reply.id);
        if (reply.error) call.reject(new Error(reply.error));
        else call.resolve(reply.value!);
      },
    },
  );
  const stderr = (async () => {
    for await (const chunk of child.stderr) errors = (errors + new TextDecoder().decode(chunk)).slice(-16_000);
  })();
  void child.exited.then(async (code) => {
    await stderr;
    for (const call of pending.values()) call.reject(new Error(`Authority worker exited ${code}: ${errors}`));
    pending.clear();
  });
  async function send(
    input: AuthorityRequest | { kind: 'init'; config: AuthorityWorkerConfig },
  ): Promise<AuthorityReply> {
    const id = ++serial;
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      child.send({ id, input });
    });
  }
  try {
    await send({ kind: 'init', config });
  } catch (error) {
    child.kill();
    await child.exited;
    throw error;
  }
  return {
    send,
    async close() {
      if (child.exitCode !== null) return;
      const timeout = setTimeout(() => child.kill(), 10_000);
      try {
        await send({ kind: 'stop' });
        await child.exited;
      } finally {
        clearTimeout(timeout);
      }
    },
  };
}

async function runWorker() {
  const { Pool } = await import('pg');
  const { createWorkerAuthorization } = await import('../../../src/work/authorization.ts');
  const { createWorkClient } = await import('../../../src/work/client.ts');
  const { createKernel } = await import('../../../src/http/kernel.ts');
  const { workerTestEnv } = await import('../../support/worker-env.ts');
  const { testReceiptKeys } = await import('../../support/receipt-keys.ts');
  const { createWriteRateLimiter } = await import('../../../src/access/write-rate.ts');
  let runtime:
    | {
        pool: Pool;
        client: Awaited<ReturnType<typeof createWorkClient>>;
        access: Access;
        kernel: ReturnType<typeof createKernel>;
        instant: string | undefined;
        authPool?: Pool;
      }
    | undefined;
  const failures = new Map<Evidence, 'missing' | 'unavailable'>();
  const fetch = globalThis.fetch;
  async function dispatch(
    input: AuthorityRequest | { kind: 'init'; config: AuthorityWorkerConfig },
  ): Promise<AuthorityReply> {
    if (input.kind === 'init') {
      const config = input.config;
      // Only the public JWKS transport is relayed. Auth still issues tokens and
      // verifies credentials in its own database in the fixture parent.
      globalThis.fetch = ((url: Parameters<typeof fetch>[0], init?: RequestInit) => {
        const target = new URL(typeof url === 'string' || url instanceof URL ? url : url.url);
        if (target.origin === config.issuer) return fetch(`${config.authRelay}${target.pathname}`, init);
        return fetch(url, init);
      }) as typeof fetch;
      const pool = new Pool({ connectionString: config.databaseUrl, max: 2 });
      pool.on('error', () => {});
      pool.on('connect', (connection) => instrument(connection, failures));
      const client = await createWorkClient(config.databaseUrl, pool);
      try {
        const clock = () => new Date(runtime?.instant ?? config.instant ?? Date.now());
        const env = workerTestEnv({
          AUTH_ISSUER: config.issuer,
          AUTH_AUDIENCE: config.audience,
          KERNEL_ROUTE_KEY: config.routeKey,
          KERNEL_SESSION_KEYS: config.referenceKeys.keys.map(([id, key]) => `${id}:${key}`).join(','),
          AUTH_JWKS_URL: `${config.issuer}/.well-known/jwks.json`,
        });
        const { access } = createWorkerAuthorization({ pool, client, env, clock, receiptKeys: testReceiptKeys() });
        const kernel = createKernel({
          pool,
          workClient: client,
          routeKey: Buffer.from(config.routeKey, 'base64url'),
          tokens: {
            current: config.referenceKeys.current,
            keys: new Map(config.referenceKeys.keys.map(([id, key]) => [id, Buffer.from(key, 'base64url')])),
          },
          receiptKeys: testReceiptKeys(),
          clock,
          access,
          requestDeadlineMs: 30_000,
          writeRate: createWriteRateLimiter({ secret: 'current-authority-native-worker-rate-secret' }),
        });
        runtime = {
          pool,
          client,
          access,
          kernel,
          instant: undefined,
          ...(config.authDatabaseUrl
            ? { authPool: new Pool({ connectionString: config.authDatabaseUrl, max: 1 }) }
            : {}),
        };
        return { status: 200, body: '' };
      } catch (error) {
        try {
          await client.close();
        } finally {
          await pool.end();
        }
        throw error;
      }
    }
    if (!runtime) throw new Error('Authority worker is not initialized');
    if (input.kind === 'stop') {
      try {
        await runtime.client.close();
      } finally {
        await runtime.authPool?.end();
        await runtime.pool.end();
      }
      return { status: 200, body: '' };
    }
    if (input.kind === 'failure') {
      failures.set(input.source, input.failure);
      return { status: 200, body: '' };
    }
    runtime.instant = input.instant;
    if (input.kind === 'operands') {
      return {
        status: 200,
        body: JSON.stringify(
          await currentAuthorityOperands(runtime.pool, runtime.access, input.bearer, input.resource),
        ),
      };
    }
    if (input.kind === 'sale') {
      const { createCurrentConsentReader } = await import('@rezics/auth/current-consent');
      const { readContentEditionMechanicalSaleAuthority } = await import('../../../src/content/edition-sale.ts');
      if (!runtime.authPool) throw new Error('Native Auth current-consent database was not supplied');
      const consent = createCurrentConsentReader({ database: runtime.authPool });
      const dependencies = {
        pool: runtime.pool,
        access: runtime.access,
        clock: () => new Date(runtime?.instant ?? Date.now()),
        readConsent: ({ actorAccountId, clientId }: { actorAccountId: string; clientId: string }) =>
          consent.readCurrentConsent({ actorAccountId, clientId }),
      };
      const result = await readContentEditionMechanicalSaleAuthority(dependencies, input.editionId, {
        deadline: Date.now() + 10_000,
      });
      return { status: 200, body: JSON.stringify(result) };
    }
    if (input.kind === 'http') {
      const response = await runtime.kernel.handle(
        new Request(input.url, {
          method: input.method,
          headers: input.headers,
          ...(input.body === undefined ? {} : { body: input.body }),
        }),
      );
      return { status: response.status, body: await response.text() };
    }
    const context = { pool: runtime.pool, deadline: Date.now() + 20_000 };
    try {
      const actor = await runtime.access.authenticate(input.bearer, context);
      const check = await accessCheck(runtime.access, actor, input.action, input.resource, context);
      return { status: (await check(runtime.pool)) ? 200 : 403, body: '' };
    } catch (error) {
      if (error instanceof AuthenticationError) return { status: 401, body: '' };
      throw error;
    }
  }
  // Ordered RPC prevents a clock/fault transition overtaking the preceding read.
  let sequence = Promise.resolve();
  process.on(
    'message',
    (message: { id: number; input: AuthorityRequest | { kind: 'init'; config: AuthorityWorkerConfig } }) => {
      sequence = sequence.then(async () => {
        try {
          const value = await dispatch(message.input);
          process.send!({ id: message.id, value });
          if (message.input.kind === 'stop') process.disconnect!();
        } catch (error) {
          process.send!({
            id: message.id,
            error: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
          });
        }
      });
    },
  );
}

if (import.meta.main && process.argv.includes('--authority-worker')) await runWorker();
