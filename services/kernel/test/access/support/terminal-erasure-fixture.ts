import { randomUUID } from 'node:crypto';
import { Pool, type PoolClient, type QueryResultRow } from 'pg';
import { bundledRelease } from '@rezics/definitions/bundled';
import { createWriteRateLimiter } from '../../../src/access/write-rate.ts';
import { createPool } from '../../../src/database/pool.ts';
import { GLOBAL_CONTEXT, bootstrapRelease } from '../../../src/semantic/definitions.ts';
import { createWorkClient } from '../../../src/work/client.ts';
import { dropTestDatabase } from '../../support/drop-test-database.ts';
import { createPersonas, type Persona } from '../../support/personas.ts';
import { testKernel } from '../../support/test-kernel.ts';
import { startTerminalErasureWorker, TERMINAL_ERASURE_BARRIER_TABLE } from './terminal-erasure-worker.ts';
import { nativeFixture } from '../native-account-bindings-fixture.ts';
import { routeOf } from '../../../src/route/route.ts';

type NativeAuth = Awaited<ReturnType<typeof nativeFixture>>;
type NativeWorker = Awaited<ReturnType<typeof startTerminalErasureWorker>>;

/** Owns the isolated native Auth, Access, kernel and production worker resources for terminal erasure. */
export async function createTerminalErasureFixture() {
  const source = new URL(process.env.DATABASE_URL ?? '');
  const template = source.pathname.slice(1);
  if (!/^[a-zA-Z0-9_]+$/.test(template)) throw new Error('DATABASE_URL must name a migrated kernel template');
  const databaseName = `terminal_erasure_${randomUUID().replaceAll('-', '')}`;
  const adminUrl = new URL(source);
  adminUrl.pathname = '/postgres';
  const admin = new Pool({ connectionString: adminUrl.href, max: 1 });
  let created = false;
  let pool: ReturnType<typeof createPool> | undefined;
  let readPool: Pool | undefined;
  let auth: NativeAuth | undefined;
  let work: Awaited<ReturnType<typeof createWorkClient>> | undefined;
  let worker: NativeWorker | undefined;
  let closing: Promise<void> | undefined;

  const close = () =>
    (closing ??= (async () => {
      try {
        await worker?.close();
      } finally {
        try {
          await work?.close();
        } finally {
          try {
            await auth?.close();
          } finally {
            try {
              await readPool?.end();
            } finally {
              try {
                await pool?.end();
              } finally {
                try {
                  if (created) await dropTestDatabase(admin, databaseName);
                } finally {
                  await admin.end();
                }
              }
            }
          }
        }
      }
    })());

  try {
    await admin.query(`CREATE DATABASE "${databaseName}" TEMPLATE "${template}"`);
    created = true;
    source.pathname = `/${databaseName}`;
    const databaseUrl = source.href;
    pool = createPool(databaseUrl);
    readPool = new Pool({ connectionString: databaseUrl, max: 4 });
    await bootstrapRelease(pool, bundledRelease);
    auth = await nativeFixture(pool);
    work = await createWorkClient(databaseUrl, pool);
    const service = auth.host.service;
    const kernel = testKernel({
      pool,
      workClient: work,
      requestDeadlineMs: 120_000,
      auth: { ...service.verifier, fetch: (url, init) => service.handler(new Request(url, init)) },
      writeRate: createWriteRateLimiter({
        secret: 'terminal-erasure-native-write-rate-secret',
        overrides: JSON.stringify({
          'new-account': { write: { maximum: 100000, seconds: 86400 }, upload: { maximum: 10000, seconds: 86400 } },
        }),
      }),
    });
    const people = await createPersonas(kernel, { version: 1, pool, auth });

    async function command(actor: Persona, method: string, path: string, body?: unknown) {
      return kernel.handle(
        new Request(`https://kernel.test${path}`, {
          method,
          headers: {
            authorization: `Bearer ${actor.bearer}`,
            'idempotency-key': JSON.stringify(randomUUID()),
            ...(body === undefined ? {} : { 'content-type': 'application/json' }),
          },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        }),
      );
    }
    async function json<T>(actor: Persona, method: string, path: string, body?: unknown): Promise<T> {
      const response = await command(actor, method, path, body);
      if (!response.ok) throw new Error(`${method} ${path}: ${response.status} ${await response.clone().text()}`);
      return (await response.json()) as T;
    }

    for (const group of ['collections', 'personal_library', 'reading_progress'])
      await json(people.staff, 'POST', `/v1/platform/exposure/${group}:open`);
    await json(people.staff, 'POST', '/v1/grants', {
      resource: { route: 0, id: GLOBAL_CONTEXT },
      subject: { kind: 'account', id: people.staff.accountId },
      actions: ['subject:create'],
      valid: '(,)',
    });

    await pool.query(
      `CREATE TABLE ${TERMINAL_ERASURE_BARRIER_TABLE} (
         singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton),
         held boolean NOT NULL DEFAULT false,
         active integer NOT NULL DEFAULT 0 CHECK(active >= 0)
       )`,
    );
    await pool.query(`INSERT INTO ${TERMINAL_ERASURE_BARRIER_TABLE} (singleton) VALUES (true)`);

    const accountHandle = async (persona: Persona): Promise<string> => {
      const route = routeOf(persona.accountId)!;
      const result = await pool!.query<{ normalized_handle: string }>(
        `SELECT normalized_handle FROM access.handle_claim
         WHERE route=$1 AND account_id=$2 AND state='active' ORDER BY normalized_handle LIMIT 1`,
        [route, persona.accountId],
      );
      return result.rows[0]!.normalized_handle;
    };

    async function subject(label: string) {
      return json<{ subject: { id: string } }>(people.staff, 'POST', '/v1/subjects', {
        type: 'schema:Book',
        labels: { en: label },
      });
    }

    async function readOnly<T extends QueryResultRow>(query: string, values: readonly unknown[] = []) {
      const client: PoolClient = await readPool!.connect();
      try {
        await client.query('BEGIN READ ONLY');
        const result = await client.query<T>(query, [...values]);
        await client.query('COMMIT');
        return result.rows;
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      } finally {
        client.release();
      }
    }

    return {
      pool,
      auth,
      work,
      kernel,
      people,
      accountHandle,
      command,
      json,
      subject,
      readOnly,
      async startWorker() {
        if (worker) throw new Error('Terminal erasure worker is already running');
        worker = await startTerminalErasureWorker(databaseUrl);
        const queues = await work!.listQueues();
        for (const queue of queues) await queue.setMinPollingIntervalMs(5);
        return worker;
      },
      async close() {
        await close();
      },
    };
  } catch (error) {
    await close();
    throw error;
  }
}

type QueryResultRow = Record<string, unknown>;
