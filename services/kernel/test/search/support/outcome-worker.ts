import { readWorkerConfig, startWorker, type WorkerConfig } from '../../../src/worker.ts';
import type { WorkContext, WorkModule } from '../../../src/work/registry.ts';
import { rebuildSubjects, RebuildError } from '../../../src/search/generations.ts';
import { createOpenSearch } from '../../../src/search/opensearch.ts';
import { discoveryTiming } from '../../../src/search/discovery-timing.ts';
import { readSearchConfig } from '../../../src/search/work.ts';
import { subjectGenerations } from '../../../src/search/indices.ts';
import { tree } from '../../../src/search/public-filter-codec.ts';
import { PUBLIC_PREPARATION_WORKFLOW } from '../../../src/search/public-preparation-store.ts';
import { createRatedSubjectSource } from '../../../src/search/rated-source.ts';
import { discoveryConsumer, subjectConsumer } from '../../../src/search/consumer-name.ts';
import { readMembershipRouteKey } from '../../../src/access/membership-work-config.ts';
import type { Pool } from 'pg';
import { workerTestEnv } from '../../support/worker-env.ts';
import { createOutcomeRpc, createOutcomeWorkerClock, OUTCOME_WORKER_READY_MESSAGE } from './outcome-rpc.ts';
import { createSearchRunnerSlot } from './runner-slot.ts';

/** Observations only: no credentials, source answers or inferred starter execution. */
export interface WorkerStats {
  defaultModules: string[];
  registeredModules: string[];
  registrationCounts: Record<string, number>;
  registeredEffects: Record<string, { name: string; types: readonly string[] }[]>;
  startedServices: Record<string, number>;
  searchStarterInvocations: number;
  stopped: boolean;
  /** Sampled from the actual WorkerConfig.clock; never readiness or Source lag evidence. */
  clockInstant: number;
  /** Requested only by the selected failure inspection; no execution or readiness claim. */
  preparation?: Record<string, unknown>;
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function noParams(params: unknown) {
  if (params !== undefined) throw new Error('This control takes no parameters');
}

type PublicationJobRow = {
  job: string;
  phase: string;
  home: number;
  pass: string;
  fenced_pass: boolean;
  family: string;
  physical_target: string;
  generation: string;
  revision: string;
  after_id: string | null;
  fenced: boolean;
  native_incarnation: string;
  source_sealed: boolean;
  source_bootstrap: string | null;
  source_observation: string | null;
  source_execution: string | null;
  source_repair_step: string | null;
  source_repair_root: string | null;
  source_ack_after: number | null;
};

/** Failure inspection only: current publication row, home witnesses, writer copies and relay checkpoints. */
async function inspectPublication(pool: Pool, prefix: string): Promise<Record<string, unknown>> {
  const nativeJobs = (
    await pool.query<PublicationJobRow & { consumer: unknown }>(
      `SELECT job::text, phase, home, pass::text, fenced_pass, family, physical_target,
              generation::text, revision::text, after_id::text,
              (fence IS NOT NULL) AS fenced, native_incarnation, j.consumer,
              seal.source_repair_root IS NOT NULL AS source_sealed, seal.*
       FROM search.generation_publication j
       LEFT JOIN LATERAL (
         SELECT b.bootstrap::text AS source_bootstrap, b.publication_observation AS source_observation,
                b.publication_execution AS source_execution, t.step::text AS source_repair_step,
                t.verified_root AS source_repair_root, t.ack_after AS source_ack_after
         FROM semantic.public_filter_bootstrap b
         JOIN semantic.public_filter_repair_step t
           ON (t.partition_no,t.bootstrap,t.execution)=(b.partition_no,b.bootstrap,b.publication_execution)
         WHERE (b.partition_no,b.publication_job)=(j.partition_no,j.job)
           AND '0:' || b.bootstrap::text=j.bootstrap
           AND b.publication_observation=j.observation AND b.publication_execution=j.execution
           AND b.state='adopted' AND b.coverage_sealed AND b.coverage_after=4096
           AND t.complete AND t.verified_root IS NOT NULL AND t.verified_next IS NULL AND t.ack_after=4096
       ) seal ON true
       WHERE j.partition_no=0 AND j.prefix=$1
       ORDER BY j.family, j.generation, j.job
       LIMIT 4`,
      [prefix],
    )
  ).rows;
  const jobs = nativeJobs.map(({ consumer: _consumer, ...job }) => job);
  const locators = (
    await pool.query<{
      id: string;
      revision: string;
      kind: string;
      phase: string | null;
      generation: number | null;
      publication: string | null;
      uuid: string | null;
      due_at: string;
      lease_until: string;
    }>(
      `SELECT id::text, revision::text, kind,
              locator->>'phase' AS phase,
              NULLIF(locator->>'generation','')::integer AS generation,
              locator->>'publication' AS publication,
              locator->>'uuid' AS uuid,
              due_at::text, lease_until::text
       FROM search.public_preparation
       WHERE partition_no=0 AND prefix=$1 AND kind='population'
       ORDER BY due_at, id
       LIMIT 4`,
      [prefix],
    )
  ).rows;
  if (jobs.length === 0) return { locators, jobs };
  const jobIds = jobs.map((job) => job.job);
  const homes = (
    await pool.query<{ job: string; pass: string; count: number; min_home: number; max_home: number }>(
      `SELECT job::text, pass::text, COUNT(*)::int AS count,
              MIN(partition_no) AS min_home, MAX(partition_no) AS max_home
       FROM search.generation_publication_home
       WHERE job=ANY($1::uuid[])
       GROUP BY job, pass`,
      [jobIds],
    )
  ).rows;
  const sourceCuts = (
    await pool.query(
      `SELECT j.job::text, b.bootstrap::text, b.state, b.account_after, b.coverage_after, b.coverage_sealed,
              b.publication_job::text, b.publication_observation, b.publication_execution,
              preparation.after_home AS receiver_after,
              prepared.observation AS native_prepared_observation, prepared.state AS native_prepared_state,
              verified.verified_ordinal::text AS source_repair_ordinal, verified.verified_home AS source_repair_home,
              verified.complete AS source_repair_complete, verified.ack_after AS source_repair_ack_after,
              EXISTS (
                SELECT 1 FROM search.public_filter_execution x
                WHERE (x.partition_no,x.observation,x.id)=(j.source_home,prepared.observation,j.job::text)
              ) AS native_execution_bound,
              p.epoch AS next_epoch,
              p.write_state AS next_write_state, p.position::text AS next_position,
              e.owner_epoch AS next_enrollment_epoch, e.complete AS next_enrollment_complete,
              (e.receipt IS NOT NULL) AS next_has_receipt, (e.key_after IS NOT NULL) AS next_has_key_cursor,
              (a.partition_no IS NOT NULL) AS next_has_account_head, h.owner_epoch AS next_source_owner_epoch,
              c.epoch AS next_pin_epoch, c.position::text AS next_pin_position
       FROM search.generation_publication j
       JOIN jsonb_to_recordset($2::jsonb) AS expected(job uuid, source_consumer text, search_consumer text)
         ON expected.job=j.job
       JOIN semantic.public_filter_bootstrap b
         ON b.partition_no=j.source_home AND b.read_definition::text=j.binding->>'readDefinition'
         AND b.consumer=expected.source_consumer AND (b.publication_job IS NULL OR b.publication_job=j.job)
       LEFT JOIN search.public_filter_coverage_preparation preparation
         ON (preparation.partition_no,preparation.bootstrap,preparation.definition)=(j.source_home,b.bootstrap,b.read_definition)
       LEFT JOIN search.public_filter_registration registration
         ON registration.partition_no=j.source_home AND registration.physical_target=j.physical_target
         AND registration.consumer IN (expected.search_consumer,expected.source_consumer)
         AND registration.state='active'
       LEFT JOIN LATERAL (
         SELECT o.observation,o.state FROM search.public_filter_observation o
         WHERE (o.partition_no,o.registration)=(registration.partition_no,registration.id)
         AND o.prepared_build='0:' || b.bootstrap::text
         ORDER BY o.observation LIMIT 1
       ) prepared ON true
       LEFT JOIN LATERAL (
         SELECT s.verified_ordinal,s.verified_home,s.complete,s.ack_after
         FROM semantic.public_filter_repair_step s
         WHERE (s.partition_no,s.bootstrap,s.execution)=(b.partition_no,b.bootstrap,b.publication_execution)
         AND s.verified_root IS NOT NULL AND s.verified_next IS NULL LIMIT 1
       ) verified ON true
       LEFT JOIN core.partition p ON p.partition_no=b.account_after
       LEFT JOIN semantic.public_filter_home_enrollment e ON (e.partition_no,e.bootstrap)=(b.account_after,b.bootstrap)
       LEFT JOIN access.account_discovery_population a ON a.partition_no=b.account_after
       LEFT JOIN semantic.public_filter_privacy_head h ON h.partition_no=b.account_after
       LEFT JOIN core.consumer_checkpoint c ON (c.partition_no,c.consumer)=(e.partition_no,e.creation_consumer)
       WHERE j.partition_no=0 AND j.job=ANY($1::uuid[])
       ORDER BY j.job,b.bootstrap
       LIMIT 4`,
      [
        jobIds,
        JSON.stringify(
          nativeJobs.map(({ job, consumer }) => ({
            job,
            source_consumer: JSON.stringify(tree(consumer, 'value')),
            search_consumer: JSON.stringify(tree(consumer)),
          })),
        ),
      ],
    )
  ).rows;
  const currentHomes = [...new Set(jobs.map((job) => job.home).filter((home) => home >= 0 && home < 4096))];
  const targets = [...new Set(jobs.map((job) => job.physical_target))];
  const visible =
    currentHomes.length === 0
      ? []
      : (
          await pool.query<{ partition: number; visible: string }>(
            `SELECT partition_no AS partition, visible::text
             FROM semantic.partition_subjects
             WHERE partition_no=ANY($1::integer[])`,
            [currentHomes],
          )
        ).rows;
  const writers =
    currentHomes.length === 0
      ? []
      : (
          await pool.query<{
            physical_target: string;
            partition: number;
            dispatch_state: string;
            copies: number;
            enrolled: number;
          }>(
            `SELECT physical_target, partition_no AS partition, dispatch_state,
                    COUNT(*)::int AS copies,
                    COUNT(*) FILTER (WHERE writer_token IS NOT NULL)::int AS enrolled
             FROM search.identity_writer
             WHERE physical_target=ANY($1::text[]) AND partition_no=ANY($2::integer[])
             GROUP BY physical_target, partition_no, dispatch_state`,
            [targets, currentHomes],
          )
        ).rows;
  const gates = (
    await pool.query<{
      physical_target: string;
      consumer: string;
      incarnation: string;
      publication_job: string | null;
      fenced: boolean;
      publication_home: number;
      closed: boolean;
    }>(
      `SELECT physical_target, consumer, incarnation, publication_job::text,
              (publication_fence IS NOT NULL) AS fenced, publication_home,
              (closed_token IS NOT NULL) AS closed
       FROM search.identity_writer_gate
       WHERE partition_no=0 AND physical_target=ANY($1::text[])`,
      [targets],
    )
  ).rows;
  const consumers = [
    ...new Set(
      jobs.flatMap((job) => {
        const generation = Number(job.generation);
        if (!Number.isSafeInteger(generation) || generation < 1) return [];
        return job.family === 'discovery'
          ? [discoveryConsumer(prefix, generation)]
          : [subjectConsumer(prefix, generation)];
      }),
    ),
  ];
  const checkpoints =
    consumers.length === 0
      ? []
      : (
          await pool.query<{
            consumer: string;
            partitions: number;
            min_position: string;
            max_position: string;
          }>(
            `SELECT consumer, COUNT(*)::int AS partitions,
                    MIN(position)::text AS min_position, MAX(position)::text AS max_position
             FROM core.consumer_checkpoint
             WHERE consumer=ANY($1::text[])
             GROUP BY consumer`,
            [consumers],
          )
        ).rows;
  return { observedAt: Date.now(), locators, jobs, homes, sourceCuts, visible, writers, gates, checkpoints };
}

function phase(name: string) {
  process.stderr.write(`outcome-worker phase=${name}\n`);
}

function initEnv(params: unknown): {
  env: Record<string, string | undefined>;
  searchDisabled: boolean;
} {
  if (
    !record(params) ||
    Object.keys(params).some((key) => key !== 'env' && key !== 'clock' && key !== 'searchDisabled') ||
    !record(params.env) ||
    ('searchDisabled' in params && typeof params.searchDisabled !== 'boolean')
  ) {
    throw new Error('init requires {env}, optional private clock state and optional Search-disabled mode');
  }
  const env: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(params.env)) {
    if (typeof value !== 'string' && value !== undefined) throw new Error('env values must be strings');
    env[key] = value;
  }
  return {
    env: { ...process.env, ...workerTestEnv(env) },
    searchDisabled: params.searchDisabled === true,
  };
}

/** One production SDK composition, shared by the child and explicit pool instrumentation. */
export function createOutcomeWorker(overrides: Pick<WorkerConfig, 'kernelPool' | 'clock'> = {}) {
  const workerClock = createOutcomeWorkerClock(overrides.clock);
  const slot = createSearchRunnerSlot();
  const observations: Omit<WorkerStats, 'clockInstant'> = {
    defaultModules: [],
    registeredModules: [],
    registrationCounts: {},
    registeredEffects: {},
    startedServices: {},
    searchStarterInvocations: 0,
    stopped: false,
  };
  const stats = (): WorkerStats => ({ ...structuredClone(observations), clockInstant: workerClock.clock().getTime() });
  let initialized = false;
  let ready = false;
  let closing = false;
  let starting: Promise<WorkerStats> | undefined;
  let stopping: Promise<WorkerStats> | undefined;
  let worker: Awaited<ReturnType<typeof startWorker>> | undefined;
  let searchContext: WorkContext | undefined;
  let searchServices = 0;
  let tail = Promise.resolve();

  function close(): Promise<WorkerStats> {
    closing = true; // Seal admission before awaiting any in-flight initialization or controls.
    return (stopping ??= (async () => {
      // Seal and drain Search immediately. Init may still be waiting for the actual worker to
      // finish registration; queuing this behind init prevents the owner from cancelling it.
      const failures: unknown[] = [];
      try {
        await slot.stop();
      } catch (error) {
        failures.push(error);
      }
      await starting?.catch(() => {});
      if (worker) {
        try {
          await worker.stop();
        } catch (error) {
          failures.push(error);
        }
      }
      observations.stopped = true;
      if (failures.length === 1) throw failures[0];
      if (failures.length > 1) throw new AggregateError(failures, 'Outcome worker shutdown failed');
      return stats();
    })());
  }

  async function init(env: Record<string, string | undefined>, searchDisabled: boolean): Promise<WorkerStats> {
    try {
      const timingStart = Number(env.REZICS_MIXED_HOME_STARTED_AT);
      if (Number.isFinite(timingStart)) {
        discoveryTiming.subscribe((message) => {
          const { at, ...timing } = message as { at: number };
          const elapsedMs = Math.round((at - timingStart) * 100) / 100;
          process.stderr.write(`Mixed Home timing ${JSON.stringify({ ...timing, elapsedMs })}\n`);
        });
      }
      phase('startWorker:start');
      worker = await startWorker(
        { ...readWorkerConfig(env), ...overrides, clock: workerClock.clock },
        (composed) => {
          observations.defaultModules = composed.map(({ name }) => name);
          return composed.map((module): WorkModule => {
            return {
              name: module.name,
              async register(context) {
                phase(`register:start module=${module.name}`);
                observations.registeredModules.push(module.name);
                observations.registrationCounts[module.name] = (observations.registrationCounts[module.name] ?? 0) + 1;
                observations.startedServices[module.name] = 0;
                observations.registeredEffects[module.name] = [];
                let serviceOrdinal = 0;
                // Observe effects without replacing them; only the runner starter is controlled.
                await module.register({
                  ...context,
                  addEffects(effects) {
                    observations.registeredEffects[module.name]!.push(
                      ...effects.map(({ name, types }) => ({ name, types: [...types] })),
                    );
                    context.addEffects(effects);
                  },
                  addService(original) {
                    // Search also owns retention/erasure services. Adopt only the actual
                    // runner returned by its post-launch starter, retaining every service.
                    const isRunner = (service: Awaited<ReturnType<typeof original>>) =>
                      module.name === 'search' && 'refresh' in service && typeof service.refresh === 'function';
                    const start = async () => {
                      const ordinal = ++serviceOrdinal;
                      phase(`service:start module=${module.name} service=${ordinal}`);
                      const service = await original();
                      observations.startedServices[module.name] = (observations.startedServices[module.name] ?? 0) + 1;
                      if (isRunner(service)) observations.searchStarterInvocations += 1;
                      phase(`service:ready module=${module.name} service=${ordinal}`);
                      return service;
                    };
                    context.addService(async () => {
                      const service = await start();
                      if (!isRunner(service)) return service;
                      searchServices += 1;
                      if (searchServices !== 1) {
                        await service.stop();
                        throw new Error('Default search must start exactly one runner');
                      }
                      searchContext = context;
                      return slot.adopt(service, start);
                    });
                  },
                });
                phase(`register:ready module=${module.name}`);
              },
            };
          });
        },
        env,
      );
      const searchModeReady = searchDisabled
        ? searchServices === 0 && observations.searchStarterInvocations === 0
        : searchServices === 1 && observations.searchStarterInvocations === 1;
      if (
        !searchModeReady ||
        !observations.defaultModules.includes('semantic') ||
        !(observations.startedServices.semantic! > 0)
      ) {
        throw new Error(
          'Integrated default worker must register the selected Search mode and real default semantic services',
        );
      }
      phase('startWorker:ready');
      ready = true;
      return stats();
    } catch (error) {
      // Missing integrated composition is a failed init, never a readiness reply.
      try {
        if (worker) await worker.stop();
        else await slot.stop();
      } catch (cleanup) {
        throw new AggregateError([error, cleanup], 'Outcome worker initialization and cleanup failed');
      }
      throw error;
    }
  }

  async function inspectPreparation(): Promise<Record<string, unknown>> {
    const context = searchContext!;
    const config = readSearchConfig(context.env);
    if (!config) throw new Error('Default search configuration is missing');
    const failure = (error: unknown) => String(error).slice(0, 1000);
    let runner: unknown;
    try {
      await slot.withRunner(async () => {});
      runner = { present: true };
    } catch (error) {
      runner = { present: false, error: failure(error) };
    }
    let generations: unknown;
    try {
      generations = await subjectGenerations(createOpenSearch(config.url), config.prefix);
    } catch (error) {
      generations = { error: failure(error) };
    }
    let workflows: unknown;
    try {
      const sample = await context.client.listWorkflows({
        workflowName: PUBLIC_PREPARATION_WORKFLOW,
        limit: 8,
        sortDesc: true,
        loadInput: true,
        loadOutput: false,
      });
      const matching = sample.filter((workflow) => {
        const input = workflow.input?.[0];
        return record(input) && input.prefix === config.prefix;
      });
      const entries = [];
      for (const workflow of matching) {
        let steps: unknown;
        try {
          steps = (await context.client.listWorkflowSteps(workflow.workflowID, { limit: 3 }))?.map((step) => ({
            functionID: step.functionID,
            name: step.name,
            startedAt: step.startedAtEpochMs,
            completedAt: step.completedAtEpochMs,
            error: step.error === null ? null : failure(step.error),
          }));
        } catch (error) {
          steps = { error: failure(error) };
        }
        entries.push({
          workflowID: workflow.workflowID,
          status: workflow.status,
          queueName: workflow.queueName,
          executorId: workflow.executorId,
          createdAt: workflow.createdAt,
          updatedAt: workflow.updatedAt,
          dequeuedAt: workflow.dequeuedAt,
          completedAt: workflow.completedAt,
          delayUntil: workflow.delayUntilEpochMS,
          recoveryAttempts: workflow.recoveryAttempts,
          error: workflow.error == null ? null : failure(workflow.error),
          steps,
        });
      }
      // A bounded empty sample cannot establish that preparation was never scheduled.
      workflows = { limit: 8, sampled: sample.length, mayBeTruncated: sample.length === 8, entries };
    } catch (error) {
      workflows = { error: failure(error) };
    }
    const maintenance = await Promise.all(
      (['PENDING', 'ENQUEUED'] as const).map(async (status) => {
        try {
          const sample = await context.client.listWorkflows({
            queueName: 'maintenance',
            status,
            limit: 4,
            sortDesc: false,
            loadInput: false,
            loadOutput: false,
          });
          return {
            status,
            mayBeTruncated: sample.length === 4,
            entries: sample.map((workflow) => ({
              name: workflow.workflowName,
              executorId: workflow.executorId,
              version: workflow.applicationVersion,
              priority: workflow.priority,
              createdAt: workflow.createdAt,
              dequeuedAt: workflow.dequeuedAt,
              delayUntil: workflow.delayUntilEpochMS,
            })),
          };
        } catch (error) {
          return { status, error: failure(error) };
        }
      }),
    );
    let publication: unknown;
    try {
      publication = await inspectPublication(context.pool, config.prefix);
    } catch (error) {
      publication = { error: failure(error) };
    }
    return { prefix: config.prefix, runner, generations, workflows, maintenance, publication };
  }

  function control(method: string, params: unknown): unknown | Promise<unknown> {
    if (closing) throw new Error('Outcome worker is closing');
    if (!['init', 'indexing', 'rebuild', 'requestRebuild', 'stats', 'clock', 'close'].includes(method))
      throw new Error(`Unknown control: ${method}`);
    if (method === 'init') {
      const options = initEnv(params);
      if (initialized) throw new Error('Outcome worker init already attempted');
      if (record(params) && 'clock' in params) workerClock.initialize(params.clock);
      initialized = true;
      return (starting = init(options.env, options.searchDisabled));
    }
    if (method === 'close') {
      noParams(params);
      return close();
    }
    if (!ready) throw new Error('Outcome worker is not initialized');
    if (method === 'clock') return workerClock.change(params);
    if (method === 'indexing') {
      if (
        !record(params) ||
        Object.keys(params).length !== 1 ||
        (params.state !== 'paused' && params.state !== 'running')
      ) {
        throw new Error('indexing requires state paused or running');
      }
      return (params.state === 'paused' ? slot.pause() : slot.resume()).then(stats);
    }
    if (method === 'stats') {
      if (params === undefined) return stats();
      if (!record(params) || Object.keys(params).length !== 1 || params.preparation !== true)
        throw new Error('Invalid failure inspection options');
      return inspectPreparation().then((preparation) => ({ ...stats(), preparation }));
    }
    noParams(params);
    return slot.withRunner(async (runner) => {
      const context = searchContext!;
      const config = readSearchConfig(context.env);
      if (!config) throw new Error('Default search configuration is missing');
      const routeKey = readMembershipRouteKey(context.env);
      const rebuilding = rebuildSubjects({
        publication: 'native',
        ...(method === 'requestRebuild' ? { timeoutMs: 0 } : {}),
        pool: context.pool,
        search: createOpenSearch(config.url),
        prefix: config.prefix,
        source: createRatedSubjectSource(context.pool, routeKey).source,
        runner,
      });
      if (method === 'requestRebuild') {
        try {
          const result = await rebuilding;
          return { generation: result.generation };
        } catch (error) {
          // The ordinary CLI timed out after allocation/refresh; maintenance retains its work.
          if (error instanceof RebuildError && error.reason === 'timeout') return { generation: error.generation };
          throw error;
        }
      }
      return rebuilding;
    });
  }

  return {
    close,
    request<T = unknown>(method: string, params?: unknown): Promise<T> {
      // Shutdown is an out-of-band control: it seals Search even if init has not settled.
      if (method === 'close') {
        noParams(params);
        return close() as Promise<T>;
      }
      // Admit init before a concurrently delivered close can overtake its queue microtask.
      let pending: Promise<unknown>;
      if (method === 'init') {
        try {
          pending = Promise.resolve(control(method, params));
        } catch (error) {
          pending = Promise.reject(error);
        }
      } else {
        pending = tail.then(() => control(method, params));
      }
      tail = pending.then(
        () => {},
        () => {},
      );
      return pending as Promise<T>;
    },
  };
}

// This executable owns one SDK for its entire lifetime. It never provisions Auth.
if (import.meta.main) {
  if (!process.send) throw new Error('Outcome worker requires a private IPC channel');
  phase('child:entry');
  const worker = createOutcomeWorker();
  // Install loss/failure handling before accepting init, including disconnect during startup.
  const lost = () => {
    void worker.close().catch((error) => {
      console.error('Outcome worker shutdown failed', error);
      process.exitCode = 1;
    });
  };
  process.on('disconnect', lost);
  process.on('error', lost);
  createOutcomeRpc(
    {
      send(packet) {
        return new Promise<void>((resolve, reject) => {
          process.send!(packet as object, (error: Error | null) => (error ? reject(error) : resolve()));
        });
      },
      subscribe(message, failure) {
        const disconnect = () => failure(new Error('Outcome parent disconnected'));
        process.on('message', message);
        process.on('disconnect', disconnect);
        process.on('error', failure);
        return () => {
          process.off('message', message);
          process.off('disconnect', disconnect);
          process.off('error', failure);
        };
      },
    },
    { onRequest: (method, params) => worker.request(method, params) },
  );
  phase('child:ipc-ready');
  process.send!({ type: OUTCOME_WORKER_READY_MESSAGE }, (error: Error | null) => {
    if (error) {
      console.error('Outcome worker could not announce IPC readiness');
      process.exitCode = 1;
    }
  });
  // The parent disconnects only after receiving the completed close reply; natural exit proves drain.
}
