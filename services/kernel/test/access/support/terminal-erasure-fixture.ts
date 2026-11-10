import { randomUUID } from 'node:crypto';
import { Pool, type PoolClient, type QueryResultRow } from 'pg';
import { bundledRelease } from '@rezics/definitions/bundled';
import { createCurrentConsentReader } from '@rezics/auth/current-consent';
import { bootstrapLocalShowcaseBoardCreation } from '../../../src/access/bootstrap-governance.ts';
import { createWriteRateLimiter } from '../../../src/access/write-rate.ts';
import { bindExecutionContract } from '../../../src/command/execution-contract.ts';
import { createPool } from '../../../src/database/pool.ts';
import { historyExecutionPort } from '../../../src/history/application/index.ts';
import { bindCanonicalSourceWork } from '../../../src/library/canonical-source-store.ts';
import { GLOBAL_CONTEXT, bootstrapRelease } from '../../../src/semantic/definitions.ts';
import { partitionOf, routeOf } from '../../../src/route/route.ts';
import { createWorkClient } from '../../../src/work/client.ts';
import { WORK_QUEUES } from '../../../src/work/queues.ts';
import type { WorkContext } from '../../../src/work/registry.ts';
import { workExecutionPort } from '../../../src/work/selected-runtime.ts';
import { prepareCollectionSource } from '../../library/support/collection-source-preparation.ts';
import {
  createNativeEditionFixture,
  type NativeEditionRequest,
} from '../../commerce/support/native-edition-fixture.ts';
import { drainEffects, readLiveAccountHandle } from '../../support/account-deletion.ts';
import { dropTestDatabase } from '../../support/drop-test-database.ts';
import { createPersonas, type Persona } from '../../support/personas.ts';
import { testKernel } from '../../support/test-kernel.ts';
import { workerTestEnv } from '../../support/worker-env.ts';
import { startTerminalErasureWorker, TERMINAL_ERASURE_BARRIER_TABLE } from './terminal-erasure-worker.ts';
import { nativeFixture } from '../native-account-bindings-fixture.ts';
export {
  inspectNativeRetainedOrder,
  prepareNativeRetainedOrder,
  NATIVE_TEST_ORDER_RETENTION_FIELDS,
  NATIVE_TEST_ORDER_RETENTION_PURPOSE,
  ORDER_RETENTION_STORE,
} from '../../commerce/support/order-retention-fixture.ts';

type NativeAuth = Awaited<ReturnType<typeof nativeFixture>>;
type NativeWorker = Awaited<ReturnType<typeof startTerminalErasureWorker>>;
type WorkerBoundary = { held: boolean; active: number; steps: Record<string, number> };

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
  const editionSubjectWrites: Array<WorkerBoundary & { sellerAccountId: string; subjectType: string }> = [];

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
    work = bindExecutionContract(await createWorkClient(databaseUrl, pool), workExecutionPort(), historyExecutionPort);
    await work.registerQueue('maintenance', WORK_QUEUES.maintenance);
    const service = auth.host.service;
    const consent = createCurrentConsentReader({ database: auth.authPool });
    const kernel = testKernel({
      pool,
      workClient: work,
      requestDeadlineMs: 120_000,
      auth: { ...service.verifier, fetch: (url, init) => service.handler(new Request(url, init)) },
      content: {
        readConsent: ({ actorAccountId, clientId }) => consent.readCurrentConsent({ actorAccountId, clientId }),
      },
      writeRate: createWriteRateLimiter({
        secret: 'terminal-erasure-native-write-rate-secret',
        overrides: JSON.stringify({
          'new-account': { write: { maximum: 100000, seconds: 86400 }, upload: { maximum: 10000, seconds: 86400 } },
        }),
      }),
    });
    const people = await createPersonas(kernel, { version: 1, pool, auth });
    const sourceContext: WorkContext = {
      pool,
      client: work,
      queues: WORK_QUEUES,
      env: workerTestEnv(),
      clock: () => new Date(),
      getAuthorization: () => ({
        access: kernel.testAccess,
        readConsent: ({ actorAccountId, clientId }) => consent.readCurrentConsent({ actorAccountId, clientId }),
      }),
      addEffects() {},
      addService() {},
    };
    bindCanonicalSourceWork(sourceContext);

    async function command(
      actor: Persona,
      method: string,
      path: string,
      body?: unknown,
      headers?: Readonly<Record<string, string>>,
    ) {
      return kernel.handle(
        new Request(`https://kernel.test${path}`, {
          method,
          headers: {
            authorization: `Bearer ${actor.bearer}`,
            'idempotency-key': JSON.stringify(randomUUID()),
            ...(body === undefined ? {} : { 'content-type': 'application/json' }),
            ...headers,
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
    await bootstrapLocalShowcaseBoardCreation(pool, people.staff.accountId);

    async function editions(actor: Persona) {
      await json(people.staff, 'POST', '/v1/grants', {
        resource: { route: 0, id: GLOBAL_CONTEXT },
        subject: { kind: 'account', id: actor.accountId },
        actions: ['subject:create', 'board:create'],
        valid: '(,)',
      });
      const request: NativeEditionRequest = async (method, path, body, headers) => {
        const write = () => command(actor, method, path, body, headers);
        if (method !== 'POST' || path !== '/v1/subjects' || !worker) return write();
        // Observe the competing native steps before draining them. Never report the
        // post-hold idle state as evidence of what was live at subject admission.
        const [boundary] = await readOnly<WorkerBoundary>(
          `SELECT held,active,steps FROM ${TERMINAL_ERASURE_BARRIER_TABLE} WHERE singleton=true`,
        );
        const evidence = {
          ...boundary!,
          sellerAccountId: actor.accountId,
          subjectType: (body as { type: string }).type,
        };
        editionSubjectWrites.push(evidence);
        console.info('Terminal erasure Edition subject-write boundary:', JSON.stringify(evidence));
        return withWorkerHeld(write, boundary!);
      };
      return createNativeEditionFixture(request);
    }

    await pool.query(
      `CREATE TABLE ${TERMINAL_ERASURE_BARRIER_TABLE} (
         singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton),
         held boolean NOT NULL DEFAULT false,
         active integer NOT NULL DEFAULT 0 CHECK(active >= 0),
         steps jsonb NOT NULL DEFAULT '{}'::jsonb
       )`,
    );
    await pool.query(`INSERT INTO ${TERMINAL_ERASURE_BARRIER_TABLE} (singleton) VALUES (true)`);

    const accountHandle = async (persona: Persona): Promise<string> => {
      const handle = await readLiveAccountHandle(pool!, persona.accountId);
      if (!handle) throw new Error(`No live handle for ${persona.accountId}`);
      return handle;
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

    async function withWorkerHeld<T>(action: () => Promise<T>, boundary?: WorkerBoundary): Promise<T> {
      const nativeWorker = worker;
      if (!nativeWorker) return action();
      const [prior] = boundary
        ? [boundary]
        : await readOnly<WorkerBoundary>(
            `SELECT held,active,steps FROM ${TERMINAL_ERASURE_BARRIER_TABLE} WHERE singleton=true`,
          );
      try {
        await nativeWorker.hold(pool!);
        return await action();
      } finally {
        if (!prior!.held) await nativeWorker.release(pool!);
      }
    }

    return {
      pool,
      auth,
      work,
      kernel,
      people,
      databaseUrl,
      accountHandle,
      command,
      json,
      subject,
      editions,
      editionSubjectWrites,
      readOnly,
      async prepareSource(actor: Persona, collectionId: string) {
        // Canonical Source continuation and scope repair share this native owner.
        await withWorkerHeld(() => prepareCollectionSource(sourceContext, actor.accountId, collectionId));
      },
      async prepareAccountAgent(actor: Persona) {
        const partition = partitionOf(routeOf(actor.accountId)!);
        const deadline = Date.now() + 45_000;
        try {
          await drainEffects(pool!, partition, { deadlineMs: 45_000 });
          // The relay checkpoint proves enqueue, not completion of the native account-agent effect.
          for (;;) {
            const pending = await readOnly<{ workflow_id: string }>(
              `SELECT consumer.workflow_id
               FROM core.history_event_consumer consumer
               JOIN core.outbox event USING(partition_no,position,event_seq)
               WHERE consumer.partition_no=$1 AND consumer.consumer='account_agent'
                 AND event.subject=$2 AND consumer.state='open'`,
              [partition, actor.accountId],
            );
            if (pending.length === 0) return;
            for (const row of pending) {
              const status = await work!.getWorkflow(row.workflow_id);
              if (status?.status === 'ERROR' || status?.status === 'CANCELLED')
                await work!.retrieveWorkflow(row.workflow_id).getResult();
            }
            if (Date.now() >= deadline)
              throw new Error(`Account agent effects did not complete within 45000ms: ${actor.accountId}`);
            await Bun.sleep(15);
          }
        } catch (error) {
          console.error('Terminal erasure account-agent preparation failed:', worker?.output);
          throw error;
        }
      },
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
