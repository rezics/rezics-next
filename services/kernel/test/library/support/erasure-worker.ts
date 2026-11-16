import type { Pool } from 'pg';
import type { WorkClient } from '../../../src/work/client.ts';
import { WORK_QUEUES } from '../../../src/work/queues.ts';
import { workerTestEnv } from '../../support/worker-env.ts';

/** DBOS reports retried failures as a list. Surface the original native step stack when present. */
export async function readLibraryWorkerResult(client: WorkClient, workflowId: string) {
  try {
    return await client.retrieveWorkflow(workflowId).getResult();
  } catch (error) {
    if (!(error instanceof Error) || !('errors' in error) || !Array.isArray(error.errors)) throw error;
    const [first] = error.errors;
    if (!first || typeof first.stack !== 'string') throw error;
    throw new Error(`${error.message}\n${first.stack}`, { cause: error });
  }
}

async function readEnqueuedEffect(
  client: WorkClient,
  effect: NonNullable<Awaited<ReturnType<WorkClient['getWorkflow']>>>,
) {
  const queueName = effect.queueName;
  if (effect.status !== 'ENQUEUED' || !queueName) return undefined;
  const observed = { queueName, loadInput: false, loadOutput: false, sortDesc: true };
  const [queues, pending, [lastCompleted]] = await Promise.all([
    client.listQueues(),
    client.listWorkflows({ ...observed, status: 'PENDING', limit: WORK_QUEUES.effects.workerConcurrency + 1 }),
    client.listWorkflows({ ...observed, status: 'SUCCESS', limit: 1 }),
  ]);
  const queue = queues.find(({ name }) => name === queueName);
  return {
    queue: {
      name: queueName,
      application: queue?.applicationName,
      workerConcurrency: queue?.workerConcurrency,
      partitionConcurrency: queue?.partitionConcurrency,
    },
    application: effect.applicationName,
    version: effect.applicationVersion,
    partition: effect.queuePartitionKey,
    dequeuedAt: effect.dequeuedAt,
    pending: pending.map((item) => ({
      workflow: item.workflowID,
      partition: item.queuePartitionKey,
      executor: item.executorId,
      version: item.applicationVersion,
    })),
    lastCompleted: lastCompleted && {
      executor: lastCompleted.executorId,
      version: lastCompleted.applicationVersion,
      dequeuedAt: lastCompleted.dequeuedAt,
    },
  };
}

/** Read only the admitted job and its exact outbox position before the fixture tears down. */
export async function readLibraryMergeDispatch(pool: Pool, client: WorkClient, jobId: string) {
  const { partitionOf, routeOf } = await import('../../../src/route/route.ts');
  const { identityEpochStore } = await import('../../../src/semantic/identity-adapters/index.ts');
  const { identityEpochWorkflowId } = await import('../../../src/semantic/core/identity-epoch-sequence.ts');
  const { IDENTITY_EPOCH_ADMITTED } = await import('../../../src/semantic/events.ts');
  const home = partitionOf(routeOf(jobId)!);
  const [admission] = (
    await pool.query<{ epoch: string; workflowId: string | null }>(
      `SELECT j.epoch::text,c.position::text AS "admissionPosition",e.type AS event,
              ck.position::text AS "checkpointPosition",d.state AS delivery,d.workflow_id AS "workflowId"
       FROM semantic.identity_epoch_job j
       LEFT JOIN semantic.identity_epoch_native_commit c
         ON (c.partition_no,c.transaction_id)=(j.partition_no,j.recorded_transaction_id) AND c.purpose='admission'
       LEFT JOIN core.outbox e
         ON (e.partition_no,e.position)=(c.partition_no,c.position) AND e.type=$3
       LEFT JOIN core.consumer_checkpoint ck ON ck.partition_no=j.partition_no AND ck.consumer='effects'
       LEFT JOIN core.history_event_consumer d
         ON (d.partition_no,d.position,d.event_seq)=(e.partition_no,e.position,e.event_seq)
         AND d.consumer='identity_epoch_admission'
       WHERE j.partition_no=$1 AND j.job_id=$2`,
      [home, jobId, IDENTITY_EPOCH_ADMITTED],
    )
  ).rows;
  if (!admission) throw new Error('Admitted Subject merge has no persisted identity job');
  const job = await identityEpochStore().readJob(pool, { jobId, epoch: BigInt(admission.epoch) });
  const effect = admission.workflowId ? await client.getWorkflow(admission.workflowId) : null;
  const [workflow] = await client.listWorkflows({
    workflow_id_prefix: identityEpochWorkflowId({ jobId, epoch: admission.epoch }),
    limit: 1,
    sortDesc: true,
    loadInput: false,
    loadOutput: false,
  });
  for (const current of [effect, workflow])
    if (current?.status === 'ERROR') await readLibraryWorkerResult(client, current.workflowID);
  return {
    admission,
    job: job?.state ?? 'unreadable',
    mapping: job?.mapping?.state,
    participants: Object.fromEntries(
      Object.entries(job?.participants ?? {}).map(([name, evidence]) => [name, evidence?.state]),
    ),
    effect: effect?.status ?? 'absent',
    enqueuedEffect: effect ? await readEnqueuedEffect(client, effect) : undefined,
    workflow: workflow?.status ?? 'absent',
  };
}

/** The fixture owns this child and its two pipes, never the Auth executor. */
export async function startErasureWorker(
  url: string,
  client: WorkClient,
  environment: NodeJS.ProcessEnv = {},
) {
  let output = '';
  let ready!: () => void;
  const readiness = new Promise<void>((resolve) => {
    ready = resolve;
  });
  const worker = Bun.spawn([process.execPath, new URL('../../../src/worker.ts', import.meta.url).pathname], {
    env: workerTestEnv({
      ...process.env,
      DATABASE_URL: url,
      STRIPE_SECRET_KEY: 'sk_test_library_erasure',
      STRIPE_MANAGED_PAYMENTS: 'false',
      CHECKOUT_SUCCESS_URL: 'https://web.example.test/success',
      CHECKOUT_CANCEL_URL: 'https://web.example.test/cancel',
      ...environment,
    }),
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const read = async (stream: ReadableStream<Uint8Array>) => {
    const decoder = new TextDecoder();
    for await (const chunk of stream) {
      output = (output + decoder.decode(chunk, { stream: true })).slice(-4096);
      if (output.includes('Worker ready')) ready();
    }
  };
  const reading = Promise.all([read(worker.stdout), read(worker.stderr)]);
  try {
    await Promise.race([
      readiness,
      worker.exited.then(async (code) => {
        await reading;
        throw new Error(`Default worker exited ${code}: ${output}`);
      }),
    ]);
    for (const queue of await client.listQueues()) await queue.setMinPollingIntervalMs(5);
  } catch (error) {
    worker.kill('SIGKILL');
    await worker.exited;
    await reading;
    throw error;
  }
  return {
    get output() {
      return output;
    },
    async close() {
      // Pending erasure coordinators are deliberate long-running workflows. The
      // production graceful drain waits for them; fixture teardown owns no such
      // service lifetime. Reap only this spawned child after recording assertions.
      worker.kill('SIGKILL');
      await worker.exited;
      await reading;
    },
  };
}

// The same real Auth provisioning and governance path as the terminal participant
// fixture, shared by owned-graph and native command growth cases.
export async function createOwnedErasureFixture() {
  const { bundledRelease } = await import('@rezics/definitions/bundled');
  const { createWriteRateLimiter } = await import('../../../src/access/write-rate.ts');
  const { bootstrapRelease, GLOBAL_CONTEXT } = await import('../../../src/semantic/definitions.ts');
  const { createWorkClient } = await import('../../../src/work/client.ts');
  const { bindExecutionContract } = await import('../../../src/command/execution-contract.ts');
  const { historyExecutionPort } = await import('../../../src/history/application/index.ts');
  const { workExecutionPort } = await import('../../../src/work/selected-runtime.ts');
  const { nativeFixture } = await import('../../access/native-account-bindings-fixture.ts');
  const { openGrowthDatabase } = await import('../../support/growth.ts');
  const { createPersonas } = await import('../../support/personas.ts');
  const { testKernel } = await import('../../support/test-kernel.ts');
  const db = await openGrowthDatabase();
  await bootstrapRelease(db.pool, bundledRelease);
  const auth = await nativeFixture(db.pool);
  const service = auth.host.service;
  const kernel = testKernel({
    pool: db.pool,
    auth: { ...service.verifier, fetch: (url, init) => service.handler(new Request(url, init)) },
    writeRate: createWriteRateLimiter({
      secret: 'library-owned-native-write-rate-secret',
      overrides: JSON.stringify({ 'new-account': { write: { maximum: 100000, seconds: 86400 } } }),
    }),
  });
  const options = { version: 1 as const, pool: db.pool, auth };
  const people = await createPersonas(kernel, options);
  type Persona = typeof people.alice;
  async function request(as: Persona | null, method: string, path: string, body?: unknown) {
    return kernel.handle(
      new Request(`http://kernel.test${path}`, {
        method,
        headers: {
          ...(as ? { authorization: `Bearer ${as.bearer}` } : {}),
          'idempotency-key': JSON.stringify(crypto.randomUUID()),
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
    );
  }
  async function json(as: Persona | null, method: string, path: string, status: number, body?: unknown) {
    const response = await request(as, method, path, body);
    const value = await response.json();
    if (response.status !== status) throw new Error(`${method} ${path}: ${response.status} ${JSON.stringify(value)}`);
    return value;
  }
  for (const group of ['collections', 'personal_library', 'reading_progress'])
    await json(people.staff, 'POST', `/v1/platform/exposure/${group}:open`, 200);
  await json(people.staff, 'POST', '/v1/grants', 201, {
    resource: { route: 0, id: GLOBAL_CONTEXT },
    subject: { kind: 'account', id: people.staff.accountId },
    actions: ['subject:create'],
    valid: '(,)',
  });
  async function subject() {
    return (
      await json(people.staff, 'POST', '/v1/subjects', 201, {
        type: 'schema:Book',
        labels: { en: 'Native owned erasure' },
      })
    ).subject.id as string;
  }
  const client = bindExecutionContract(await createWorkClient(db.url), workExecutionPort(), historyExecutionPort);
  let worker: Awaited<ReturnType<typeof startErasureWorker>> | undefined;
  return {
    db,
    auth,
    kernel,
    options,
    people,
    client,
    request,
    json,
    subject,
    async start(environment?: Record<string, string>) {
      worker = await startErasureWorker(db.url, client, environment);
    },
    async close() {
      await worker?.close();
      await client.close();
      await auth.close();
      await db.close();
    },
  };
}
