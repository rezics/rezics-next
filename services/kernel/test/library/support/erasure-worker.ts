import type { Pool } from 'pg';
import type { EffectsRelayProgress } from '../../../src/events/effects.ts';
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
export async function readLibraryMergeDispatch(pool: Pool, client: WorkClient, jobId: string, queueWarning?: string) {
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
    queueWarning,
    workflow: workflow?.status ?? 'absent',
  };
}

/** Trace the ordinary tombstone through the Library effect and the owned terminal work it starts. */
export async function readLibraryErasureDispatch(pool: Pool, client: WorkClient, accountId: string) {
  const { partitionOf, routeOf } = await import('../../../src/route/route.ts');
  const { libraryErasureWorkflowId } = await import('../../../src/library/erasure-workflow-id.ts');
  const route = routeOf(accountId)!;
  const [tombstone] = (
    await pool.query<{ workflowId: string | null }>(
      `SELECT e.at::text AS "erasureAt", b.position::text AS "tombstonePosition",
              o.id::text AS "eventId", ck.position::text AS "checkpointPosition",
              d.state AS delivery, d.workflow_id AS "workflowId"
       FROM access.erasure e
       LEFT JOIN access.lifecycle_fence_receipt f
         ON (f.route,f.account_id)=(e.route,e.account_id) AND f.kind='tombstone'
       LEFT JOIN editorial.write_basis b ON b.partition_no=$3 AND b.transaction_id=f.transaction_id
       LEFT JOIN core.outbox o
         ON (o.partition_no,o.epoch,o.position)=(b.partition_no,b.epoch,b.position)
         AND o.type='com.rezics.access.account-tombstoned.v1' AND o.subject=e.account_id::text
       LEFT JOIN core.consumer_checkpoint ck ON ck.partition_no=$3 AND ck.consumer='effects'
       LEFT JOIN core.history_event_consumer d
         ON (d.partition_no,d.position,d.event_seq)=(o.partition_no,o.position,o.event_seq)
         AND d.consumer='library_account_erasure'
       WHERE e.route=$1 AND e.account_id=$2`,
      [route, accountId, partitionOf(route)],
    )
  ).rows;
  const effect = tombstone?.workflowId ? await client.getWorkflow(tombstone.workflowId) : null;
  const [workflow] = await client.listWorkflows({
    workflow_id_prefix: libraryErasureWorkflowId(accountId),
    limit: 1,
    sortDesc: true,
    loadInput: false,
    loadOutput: true,
  });
  for (const current of [effect, workflow])
    if (current?.status === 'ERROR') await readLibraryWorkerResult(client, current.workflowID);
  const steps = workflow && (await client.listWorkflowSteps(workflow.workflowID, { limit: 100 }));
  return {
    tombstone,
    effect: effect?.status ?? 'absent',
    enqueuedEffect: effect ? await readEnqueuedEffect(client, effect) : undefined,
    workflow: workflow?.status ?? 'absent',
    lastStep: steps?.at(-1)?.name,
    terminalResult: workflow?.status === 'SUCCESS' ? workflow.output : undefined,
  };
}

const RELAY_PROGRESS = 'Effects relay progress ';

function observeEffectsRelay(partition: number) {
  type Released = Extract<EffectsRelayProgress, { stage: 'released' }>;
  type Failed = Extract<EffectsRelayProgress, { stage: 'failed' }>;
  let last: Exclude<EffectsRelayProgress, Failed> | undefined;
  let error: Failed | undefined;
  let firstReleased: Released | undefined;
  let lastReleased: Released | undefined;
  let firstStop: string | undefined;
  let firstFailure: { line: string; progress: typeof last; error: typeof error } | undefined;
  let lastFailure: typeof firstFailure;
  let scanFailed = false;
  const stop = new RegExp(`^Relay effects stopped at partition ${partition} position \\d+: \\w+`);
  const failure = new RegExp(`^Relay effects failed on partition ${partition}(?!\\d)`);
  return {
    read(line: string) {
      if (line.startsWith(RELAY_PROGRESS)) {
        let progress: EffectsRelayProgress;
        try {
          progress = JSON.parse(line.slice(RELAY_PROGRESS.length)) as EffectsRelayProgress;
        } catch {
          return;
        }
        if (progress.stage === 'failed') {
          error = progress;
          return;
        }
        error = undefined;
        last = progress;
        if (last.stage === 'released' && last.first) {
          if (firstReleased?.checkpoint !== last.checkpoint) firstReleased = last;
          lastReleased = last;
        }
      } else {
        firstStop ??= stop.exec(line)?.[0];
        const failed = failure.exec(line)?.[0];
        if (failed) {
          lastFailure = { line: failed, progress: last, error };
          firstFailure ??= lastFailure;
        }
        scanFailed ||= line.startsWith('Relay partition scan failed');
      }
    },
    snapshot: () => ({
      partition,
      last,
      firstReleased,
      lastReleased,
      firstStop,
      firstFailure,
      lastFailure,
      scanFailed,
    }),
  };
}

/** The fixture owns this child and its two pipes, never the Auth executor. */
export async function startErasureWorker(
  url: string,
  client: WorkClient,
  environment: NodeJS.ProcessEnv = {},
  effectsPartition?: number,
) {
  let output = '';
  let effectsQueueWarning: string | undefined;
  const effectsRelay = effectsPartition === undefined ? undefined : observeEffectsRelay(effectsPartition);
  let ready!: () => void;
  const readiness = new Promise<void>((resolve) => {
    ready = resolve;
  });
  const entry =
    effectsPartition === undefined
      ? [new URL('../../../src/worker.ts', import.meta.url).pathname]
      : [import.meta.path, String(effectsPartition)];
  const worker = Bun.spawn([process.execPath, ...entry], {
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
  const read = async (stream: ReadableStream<Uint8Array>, inspectRelay = false) => {
    const decoder = new TextDecoder();
    let fragment = '';
    for await (const chunk of stream) {
      const text = decoder.decode(chunk, { stream: true });
      output = (output + text).slice(-4096);
      effectsQueueWarning ??= output.match(/Error getting startable workflows for queue effects: ([^\r\n]+)\r?\n/)?.[1];
      if (output.includes('Worker ready')) ready();
      if (inspectRelay && effectsRelay) {
        const lines = (fragment + text).split(/\r?\n/);
        fragment = lines.pop()!.slice(-4096);
        for (const line of lines) effectsRelay.read(line);
      }
    }
  };
  const reading = Promise.all([read(worker.stdout), read(worker.stderr, true)]);
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
    get effectsQueueWarning() {
      return effectsQueueWarning;
    },
    get effectsRelayProgress() {
      return effectsRelay?.snapshot();
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
    get effectsQueueWarning() {
      return worker?.effectsQueueWarning;
    },
    get effectsRelayProgress() {
      return worker?.effectsRelayProgress;
    },
    async start(environment?: Record<string, string>, effectsPartition?: number) {
      worker = await startErasureWorker(db.url, client, environment, effectsPartition);
    },
    async close() {
      await worker?.close();
      await client.close();
      await auth.close();
      await db.close();
    },
  };
}

if (import.meta.main) {
  const { readWorkerConfig, startWorker } = await import('../../../src/worker.ts');
  await startWorker({
    ...readWorkerConfig(process.env),
    effectsRelayProbe: {
      partition: Number(process.argv[2]),
      report: (progress) => console.error(RELAY_PROGRESS + JSON.stringify(progress)),
    },
  });
  console.info('Worker ready');
}
