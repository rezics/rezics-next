import { DBOS } from '@dbos-inc/dbos-sdk';
import { createCurrentConsentReader } from '@rezics/auth/current-consent';
import type { CurrentConsentReader } from '../../src/request/auth-consent.ts';
import { once } from 'node:events';
import { createHash, randomUUID } from 'node:crypto';
import { appendFileSync, mkdirSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { Pool, type PoolClient } from 'pg';
import permissionRead from '../../src/access/permission-check.sql';
import { createContentOperationClient, createContentWork } from '../../src/content/work.ts';
import { createContentWorkAccess } from '../../src/content/register.ts';
import { contentEffects } from '../../src/content/relays.ts';
import { R2Storage } from '../../src/content/r2-storage.ts';
import type {
  ErasureOperationDriver,
  Fixture,
  GrowthResult,
  Inspection,
  Operation,
  Persona,
  Reply,
  Trace,
} from '../../../../specs/erasure-operation-driver.ts';
import { authoritativeTimeValue } from '../../src/command/command.ts';
import { effectsRelay } from '../../src/events/effects.ts';
import { startRelays } from '../../src/events/relays.ts';
import { linkProjection } from '../../src/semantic/links.ts';
import { createWorkClient, DBOS_SCHEMA, type WorkClient } from '../../src/work/client.ts';
import { WORK_QUEUES } from '../../src/work/queues.ts';
import { composeWork, type WorkModule } from '../../src/work/registry.ts';
import { newId, partitionOf, routeOf } from '../../src/route/route.ts';
import type { Cost, GrowthDatabase, GrowthSample, Population } from '../support/growth.ts';
import type { FixtureResources, SeededBoard } from './support/erasure-operation-fixtures.ts';
import type { SqlObserver } from './support/sql-observer.ts';

const phaseLog = fileURLToPath(new URL('../../../../.temp/erasure-phases.log', import.meta.url));
mkdirSync(dirname(phaseLog), { recursive: true });
function mark(phase: string): void {
  appendFileSync(phaseLog, `${Date.now()} ${phase}\n`);
}

type NativeCheck = {
  workflowId: string;
  operationId: string;
  step: string;
  postId: string;
  action: string;
  partition: number;
  at: string;
  allowed: boolean;
};
type StepEvent = { serial: number; name: string };
type StoredFixture = SeededBoard;
type NativeWorkerCost = { serial: number; cost: Cost };
type WorkerProcess = ReturnType<typeof Bun.spawn> & {
  stdin: Bun.FileSink;
  stdout: ReadableStream<Uint8Array>;
  stderr: ReadableStream<Uint8Array>;
};

const BARRIER_TABLE = 'content.erasure_operation_test_barrier';

function makeReply<T>(response: Response, value?: T): Reply<T> {
  return value === undefined ? { response } : { response, value };
}

function operationId(name: string): string {
  const match = /^operations\/([^/]+)$/.exec(name);
  if (!match) throw new TypeError('Invalid native operation name');
  return match[1]!;
}

function erasureGrowthPopulation(
  seedValue: number,
  fixture: StoredFixture,
  actor: FixtureResources['system']['actors']['author']['actor'],
): Population {
  return {
    name: `erasure-outcome-growth-${seedValue}`,
    hotPartition: fixture.partition,
    hotShare: 1,
    rows({ route, ordinal }) {
      const entries = Array.from({ length: 16 }, () => {
        const account = newId(route);
        const organization = newId(route);
        const thread = newId(route);
        const post = newId(route);
        const revision = newId(route);
        const media = newId(route);
        const operation = newId(route);
        const body = Buffer.alloc(256, ordinal % 251);
        return { account, organization, thread, post, revision, media, operation, body };
      });
      const hash = (body: Buffer) => createHash('sha256').update(body).digest();
      return {
        'access.account': entries.flatMap(({ account, organization }) => [
          { route, account_id: account, kind: 'actor', state: 'active', transaction_id: account },
          { route, account_id: organization, kind: 'organization', state: 'active', transaction_id: organization },
        ]),
        // Keep the acting account's neighbourhood fixed while the native inverse,
        // forward membership and delegation indexes grow with unrelated accounts.
        'access.membership_inverse': entries.map(({ account, organization }) => ({
          route,
          account_id: account,
          kind: 'organization',
          group_id: organization,
          reservation_id: organization,
          transaction_id: organization,
        })),
        'access.organization_member': entries.map(({ account, organization }) => ({
          route,
          organization_id: organization,
          member_account_id: account,
          role: 'member',
          valid: '(,)',
          transaction_id: organization,
        })),
        'access.principal_assignment': entries.map(({ account, organization, post }) => ({
          route,
          principal_id: organization,
          request_id: post,
          assigned_actor_id: account,
          creator_principal_id: organization,
          valid: '(,)',
          issued_valid: '(,)',
          transaction_id: post,
        })),
        'content.thread': entries.map(({ account, thread }) => ({
          route,
          thread_id: thread,
          board_id: fixture.board,
          author_account_id: account,
          title: 'Unrelated growth thread',
          security_revision: 1,
          visibility: 'published',
          recorded_transaction_id: thread,
        })),
        'content.post': entries.map(({ account, thread, post, revision }) => ({
          route,
          thread_id: thread,
          post_id: post,
          author_account_id: account,
          head_revision_id: revision,
          security_revision: 1,
          visibility: 'published',
          recorded_transaction_id: post,
        })),
        'content.revision': entries.map(({ thread, post, revision, body }) => ({
          route,
          thread_id: thread,
          post_id: post,
          revision_id: revision,
          body,
          body_sha256: hash(body),
          search_text: 'Unrelated growth content',
          licence: 'MIT',
          subject_ids: [],
          board_id: fixture.board,
          availability: 'available',
          recorded_transaction_id: post,
        })),
        'content.media': entries.map(({ account, thread, media }) => ({
          route,
          media_id: media,
          container_id: thread,
          uploader_id: account,
          reservation_request_id: `erasure-growth-${ordinal}-${media}`,
          purpose: 'post-image',
          media_type: 'image/png',
          byte_count: 256,
          state: 'reserved',
          key: `m/${media}/original`,
          transaction_id: media,
        })),
        'access.resource_grant': entries.map(({ post, account }) => ({
          route,
          resource_id: post,
          subject_id: account,
          action: 'post:erase',
          valid: '(,)',
          transaction_id: post,
        })),
        'access.resource_denial': entries.map(({ post, account }) => ({
          route,
          resource_id: post,
          subject_id: account,
          action: 'post:erase',
          reason: 'resource',
          valid: '(,)',
          transaction_id: post,
        })),
        'access.resource_role_grant': entries.map(({ post, account }) => ({
          route,
          resource_id: post,
          subject_id: account,
          grant_role: 'content.post.owner',
          valid: '(,)',
          transaction_id: post,
        })),
        'content.operation': entries.map(({ account, operation, post, thread }) => ({
          route,
          operation_id: operation,
          initiator_account_id: actor.accountId,
          author_account_id: account,
          thread_id: thread,
          actor_kind: 'account',
          actor_account_id: actor.accountId,
          actor_client_id: actor.clientId,
          actor_scopes: actor.scopes,
          actor_requested_by: null,
          actor_authn_epoch: actor.authnEpoch,
          empty_scope: true,
          requested_at: new Date(),
          recorded_transaction_id: post,
          anchor_post_id: post,
        })),
        // Retained, unrelated history grows too. None of these identities or
        // events belongs to an erasure under test; its progress stays DBOS-owned.
        'dbos.workflow_status': entries.map(({ operation }) => ({
          workflow_uuid: `erasure-growth-history:${operation}`,
          status: 'SUCCESS',
          name: 'erasure.growth.history',
        })),
        'dbos.workflow_input': entries.map(({ operation }) => ({
          workflow_uuid: `erasure-growth-history:${operation}`,
          inputs: '[]',
        })),
        'dbos.workflow_output': entries.map(({ operation }) => ({
          workflow_uuid: `erasure-growth-history:${operation}`,
          output: '{}',
        })),
        'dbos.workflow_events': entries.map(({ operation }) => ({
          workflow_uuid: `erasure-growth-history:${operation}`,
          key: 'baseline',
          value: '{}',
        })),
        'dbos.workflow_events_history': entries.map(({ operation }) => ({
          workflow_uuid: `erasure-growth-history:${operation}`,
          function_id: 0,
          key: 'baseline',
          value: '{}',
        })),
        'dbos.operation_outputs': entries.map(({ operation }) => ({
          workflow_uuid: `erasure-growth-history:${operation}`,
          function_id: 0,
          function_name: 'erasure.growth.history',
        })),
      };
    },
  };
}

function workerLine(line: string): void {
  writeSync(1, `${line}\n`);
}

type WorkerProcessConfig = {
  databaseUrl: string;
  authDatabaseUrl: string;
  routeKey: string;
  executorId: string;
  initialMode: 'hold' | 'run';
  growthMode: boolean;
};

export async function runOperationWorkerProcess(): Promise<void> {
  workerLine('ERASURE_WORKER_PHASE process');
  // The parent spawns this process before the cloned database exists, so the
  // connection settings arrive after the module graph has loaded.
  const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
  const [configLine] = (await once(input, 'line')) as [string];
  if (!configLine.startsWith('config ')) throw new Error('Native worker config is missing');
  const config = JSON.parse(configLine.slice('config '.length)) as WorkerProcessConfig;
  workerLine('ERASURE_WORKER_PHASE configured');
  const databaseUrl = config.databaseUrl;
  const authDatabaseUrl = config.authDatabaseUrl;
  const routeKey = Buffer.from(config.routeKey, 'base64url');
  if (!databaseUrl || !authDatabaseUrl || routeKey.length !== 32 || !config.executorId)
    throw new Error('Native erasure worker configuration is incomplete');
  const authPool = new Pool({ connectionString: authDatabaseUrl, max: 4 });
  const { readCurrentConsent } = createCurrentConsentReader({ database: authPool });
  // Auth's reader rejects any key beyond the account and client. The product
  // also passes its deadline, which would otherwise erase current consent.
  const readConsent: CurrentConsentReader = (input) =>
    readCurrentConsent({ actorAccountId: input.actorAccountId, clientId: input.clientId });
  const access = createContentWorkAccess(() => new Date());
  const originalAuthorize = access.authorize.bind(access);
  const active = new Map<string, { step: string; serial: number; checks: NativeCheck[] }>();
  access.authorize = async (client, actor, action, resource, evidence, time) => {
    const allowed = await originalAuthorize(client, actor, action, resource, evidence, time);
    const workflowId = DBOS.workflowID;
    const current = workflowId ? active.get(workflowId) : undefined;
    if (workflowId && current && action === 'post:erase' && actor.kind === 'account' && time) {
      const operation = /^wf:([^:]+):/.exec(current.step)?.[1];
      if (operation)
        current.checks.push({
          workflowId,
          operationId: operation,
          step: current.step,
          postId: resource.id,
          action,
          partition: partitionOf(resource.route),
          at: authoritativeTimeValue(time),
          allowed,
        });
    }
    return allowed;
  };
  const originalAuthorizePage = access.authorizePage!.bind(access);
  access.authorizePage = async (client, actor, action, page, evidence, time) => {
    const workflowId = DBOS.workflowID;
    const current = workflowId ? active.get(workflowId) : undefined;
    const operation = current && /^wf:([^:]+):/.exec(current.step)?.[1];
    if (!workflowId || !current || !operation || action !== 'post:erase' || actor.kind !== 'account' || !time)
      return originalAuthorizePage(client, actor, action, page, evidence, time);
    // The page port returns an aggregate decision. Observe the unchanged native
    // formula's individual rows instead of assigning that aggregate to each post.
    const observed = Object.create(client) as typeof client;
    observed.query = (async (query: string | { text?: string; values?: unknown[] }, values?: unknown[]) => {
      const result = await client.query(query as string, values);
      const statement = typeof query === 'string' ? query : query.text;
      if (statement === permissionRead.sql) {
        const parameters = typeof query === 'string' ? values : query.values;
        const at = parameters?.[permissionRead.params.indexOf('at')];
        if (typeof at !== 'string' || at !== authoritativeTimeValue(time))
          throw new Error('Native page formula used a different attempt time');
        for (const row of result.rows) {
          if (
            typeof row.resourceId !== 'string' ||
            typeof row.allowed !== 'boolean' ||
            !page.ids.includes(row.resourceId)
          )
            throw new Error('Native page formula returned an invalid per-post decision');
          current.checks.push({
            workflowId,
            operationId: operation,
            step: current.step,
            postId: row.resourceId,
            action,
            partition: partitionOf(page.route),
            at,
            allowed: row.allowed,
          });
        }
      }
      return result;
    }) as typeof client.query;
    return originalAuthorizePage(observed, actor, action, page, evidence, time);
  };

  let barrierMode: 'run' | 'hold' = config.initialMode === 'hold' ? 'hold' : 'run';
  let measureStep: (<T>(action: () => Promise<T>) => Promise<{ value: T; cost: Cost }>) | undefined;
  // setEvent and recv are illegal inside a DBOS step. The logical page is that step,
  // so the barrier is a row the parent releases, not a workflow event.
  const barrierPool = new Pool({ connectionString: databaseUrl, max: 2 });
  const originalSetConfig = DBOS.setConfig.bind(DBOS);
  DBOS.setConfig = ((configuration) =>
    originalSetConfig({ ...configuration, logLevel: 'info' })) as typeof DBOS.setConfig;
  const originalRegisterStep = DBOS.registerStep.bind(DBOS);
  DBOS.registerStep = ((func: (...args: any[]) => any, configuration?: { name?: string; [key: string]: unknown }) => {
    if (configuration?.name !== 'content.authorErase.step') return originalRegisterStep(func, configuration as never);
    mark('register-author-step');
    const wrapped = async (name: string, action: () => Promise<unknown>) => {
      const match = /^wf:([^:]+):erase:/.exec(name);
      const workflowId = DBOS.workflowID;
      const parked = Boolean(match && workflowId);
      mark(`worker-step ${JSON.stringify(name)} wf=${workflowId ?? 'none'} park=${parked} mode=${barrierMode}`);
      workerLine(`ERASURE_WORKER_STEP ${JSON.stringify(name)} mode=${barrierMode} park=${parked}`);
      if (!match || !workflowId) return func(name, action);
      try {
        const previous = await barrierPool.query<{ serial: number; name: string }>(
          `SELECT serial, name FROM ${BARRIER_TABLE} WHERE workflow_id=$1 ORDER BY serial DESC LIMIT 1`,
          [workflowId],
        );
        const prior = previous.rows[0];
        const serial = prior?.name === name ? prior.serial : (prior?.serial ?? 0) + 1;
        await barrierPool.query(
          `INSERT INTO ${BARRIER_TABLE} (workflow_id, serial, name, released)
         VALUES ($1,$2,$3,$4)
         ON CONFLICT (workflow_id, serial) DO NOTHING`,
          [workflowId, serial, name, barrierMode !== 'hold'],
        );
        while (barrierMode === 'hold') {
          const gate = await barrierPool.query<{ released: boolean }>(
            `SELECT released FROM ${BARRIER_TABLE} WHERE workflow_id=$1 AND serial=$2`,
            [workflowId, serial],
          );
          if (gate.rows[0]?.released) break;
          await new Promise((resolve) => setTimeout(resolve, 15));
        }
        const current = { step: name, serial, checks: [] as NativeCheck[] };
        active.set(workflowId, current);
        let failure: string | null = null;
        try {
          if (captureNextStep && measureStep) {
            captureNextStep = false;
            const measured = await measureStep(() => func(name, action));
            workerLine(`ERASURE_WORKER_COST ${JSON.stringify({ serial, cost: measured.cost })}`);
            return measured.value;
          }
          return await func(name, action);
        } catch (error) {
          failure = error instanceof Error ? (error.stack ?? error.message) : String(error);
          throw error;
        } finally {
          await barrierPool.query(
            `UPDATE ${BARRIER_TABLE} SET checks=$3::jsonb, error=$4 WHERE workflow_id=$1 AND serial=$2`,
            [workflowId, serial, JSON.stringify(current.checks), failure],
          );
          active.delete(workflowId);
        }
      } catch (error) {
        const detail = error instanceof Error ? (error.stack ?? error.message) : String(error);
        workerLine(`ERASURE_WORKER_BARRIER_FAILED ${detail.replaceAll('\n', ' | ')}`);
        throw error;
      }
    };
    return originalRegisterStep(wrapped, configuration as never);
  }) as typeof DBOS.registerStep;

  const storage = new R2Storage({
    endpoint: 'http://127.0.0.1:1',
    bucket: 'erasure-operation-unused-media',
    accessKeyId: 'native-test-unused',
    secretAccessKey: 'native-test-unused',
    maxObjectBytes: 20 * 1024 * 1024,
    fetch,
  });
  const content = createContentWork({
    storage,
    access,
    readConsent,
    routeKey,
    fetchConfig: { allowedHosts: [] },
  });
  const module: WorkModule = {
    name: 'content',
    async register(context) {
      await content.register(context);
      context.addEffects(contentEffects(context.pool, context.client));
    },
  };
  const growthMode = config.growthMode;
  let growth: GrowthDatabase | undefined;
  let growthSystemPool: Pool | undefined;
  let workerClient: WorkClient | undefined;
  let work: Awaited<ReturnType<typeof composeWork>> | undefined;
  let relays: ReturnType<typeof startRelays> | undefined;
  let worker: { stop(): Promise<void> } | undefined;
  let captureNextStep = false;
  try {
    if (growthMode) {
      const growthApi = await import('../support/growth.ts');
      growth = await growthApi.openGrowthDatabase(databaseUrl);
      const growthDatabase = growth;
      measureStep = async (action) => {
        const measured = await growthApi.capture(growthDatabase, action);
        return { value: measured.value, cost: growthApi.costOf(measured.capture) };
      };
      growthSystemPool = new Pool({ connectionString: databaseUrl, max: 12 });
      workerClient = await createWorkClient(databaseUrl, growthSystemPool);
      const growthModule: WorkModule = {
        name: 'content',
        async register(context) {
          await content.register({ ...context, pool: growth!.pool });
          context.addEffects(contentEffects(growth!.pool, context.client));
        },
      };
      work = await composeWork([growthModule], {
        databaseUrl,
        executorId: config.executorId,
        pool: growthSystemPool,
        client: workerClient,
        env: process.env,
      });
      await work.launch();
      relays = startRelays(growth.pool, [effectsRelay(growth.pool, work.effects), linkProjection(growth.pool)]);
      worker = {
        async stop() {
          const failures: unknown[] = [];
          for (const close of [
            () => relays!.stop(),
            () => work!.shutdown(),
            () => workerClient!.close(),
            () => growthSystemPool!.end(),
            () => growth!.close(),
          ]) {
            try {
              await close();
            } catch (error) {
              failures.push(error);
            }
          }
          if (failures.length) throw new AggregateError(failures, 'Native growth worker cleanup failed');
        },
      };
    } else {
      // Same composition as the production worker, without importing every other
      // work module. HTTP does not launch a second worker.
      workerLine('ERASURE_WORKER_PHASE starting');
      growthSystemPool = new Pool({ connectionString: databaseUrl, max: 12 });
      growthSystemPool.on('error', () => {});
      workerClient = await createWorkClient(databaseUrl, growthSystemPool);
      work = await composeWork([module], {
        databaseUrl,
        executorId: config.executorId,
        pool: growthSystemPool,
        client: workerClient,
        env: process.env,
      });
      await work.launch();
      relays = startRelays(growthSystemPool, [
        effectsRelay(growthSystemPool, work.effects),
        linkProjection(growthSystemPool),
      ]);
      const pool = growthSystemPool;
      const launched = work;
      const client = workerClient;
      const running = relays;
      worker = {
        async stop() {
          const failures: unknown[] = [];
          for (const close of [
            () => running.stop(),
            () => launched.shutdown(),
            () => client.close(),
            () => pool.end(),
          ]) {
            try {
              await close();
            } catch (error) {
              failures.push(error);
            }
          }
          if (failures.length) throw new AggregateError(failures, 'Native erasure worker cleanup failed');
        },
      };
      workerLine('ERASURE_WORKER_PHASE started');
    }
    for (const name of Object.keys(WORK_QUEUES)) {
      const queue = await DBOS.retrieveQueue(name);
      if (!queue) throw new Error(`Native worker did not register queue ${name}`);
      await queue.setMinPollingIntervalMs(1);
    }
  } finally {
    DBOS.setConfig = originalSetConfig as typeof DBOS.setConfig;
    DBOS.registerStep = originalRegisterStep as typeof DBOS.registerStep;
  }
  workerLine('ERASURE_WORKER_READY');
  for await (const line of input) {
    if (line === 'hold' || line === 'run') {
      barrierMode = line;
      if (line === 'run') await barrierPool.query(`UPDATE ${BARRIER_TABLE} SET released=true WHERE released=false`);
      workerLine(`ERASURE_WORKER_CONTROL ${line}`);
    } else if (line === 'capture-step' && growthMode) {
      captureNextStep = true;
      workerLine('ERASURE_WORKER_CONTROL capture-step');
    } else if (line === 'pause-relays') {
      await relays!.pause();
      workerLine('ERASURE_WORKER_CONTROL pause-relays');
    } else if (line === 'resume-relays') {
      relays!.resume();
      workerLine('ERASURE_WORKER_CONTROL resume-relays');
    } else if (line === 'stop') {
      await worker!.stop();
      await authPool.end();
      await barrierPool.end();
      workerLine('ERASURE_WORKER_STOPPED');
      input.close();
      process.exit(0);
    }
  }
  await worker!.stop();
  await authPool.end();
  await barrierPool.end();
}

type WorkerSource = { appUrl: string; authUrl: string; routeKey: Uint8Array };
type WorkerWaiter = { startsWith: string; resolve(value: string): void; reject(error: Error): void };
type WorkerLane = {
  child: WorkerProcess;
  output: string;
  stderr: string;
  pending: string;
  lines: string[];
  waiters: WorkerWaiter[];
  stdoutTask: Promise<void>;
  stderrTask: Promise<void>;
};

const workerModule = process.env.ERASURE_OPERATION_WORKER_BUNDLE ?? import.meta.url;
const workerProgram = `import { writeSync } from 'node:fs';
writeSync(1, 'ERASURE_WORKER_PHASE spawn\\n');
try {
  const module = await import(${JSON.stringify(workerModule)});
  writeSync(1, 'ERASURE_WORKER_PHASE imported\\n');
  await module.runOperationWorkerProcess();
} catch (error) {
  console.error(error);
  const detail = error instanceof Error ? (error.stack ?? error.message) : String(error);
  writeSync(1, 'ERASURE_WORKER_FAILED ' + detail.replaceAll('\\n', ' | ') + '\\n');
  process.exit(1);
}`;

function createWorkerLane(): WorkerLane {
  const lane: WorkerLane = {
    child: undefined as never,
    output: '',
    stderr: '',
    pending: '',
    lines: [],
    waiters: [],
    stdoutTask: Promise.resolve(),
    stderrTask: Promise.resolve(),
  };
  const accept = (line: string) => {
    mark(`child ${line.slice(0, 240)}`);
    lane.output += `${line}\n`;
    for (let index = 0; index < lane.waiters.length; index++) {
      const waiter = lane.waiters[index]!;
      if (line.startsWith(waiter.startsWith)) {
        lane.waiters.splice(index, 1);
        waiter.resolve(line);
        return;
      }
    }
    lane.lines.push(line);
  };
  lane.child = Bun.spawn([process.execPath, '-e', workerProgram], {
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'pipe',
    env: {
      ...process.env,
      // The cloned database does not exist yet. Its URL arrives on stdin.
      DATABASE_URL: '',
      ERASURE_OPERATION_WORKER: '1',
    },
  }) as WorkerProcess;
  const launched = lane.child;
  lane.stdoutTask = (async () => {
    const reader = launched.stdout.getReader();
    const decoder = new TextDecoder();
    for (;;) {
      const result = await reader.read();
      if (result.done) break;
      lane.pending += decoder.decode(result.value, { stream: true });
      const split = lane.pending.split('\n');
      lane.pending = split.pop() ?? '';
      for (const line of split) accept(line.replace(/\r$/, ''));
    }
  })();
  lane.stderrTask = (async () => {
    const reader = launched.stderr.getReader();
    const decoder = new TextDecoder();
    for (;;) {
      const result = await reader.read();
      if (result.done) break;
      const text = decoder.decode(result.value, { stream: true });
      lane.stderr += text;
      for (const line of text.split('\n')) if (line.trim()) mark(`stderr ${line.slice(0, 400)}`);
    }
  })();
  return lane;
}

// The outcome wrapper starts these before this module's imports compile.
// A direct load still creates them here.
const prefetchedLanes: WorkerLane[] =
  (globalThis as { __erasureWorkerLanes?: WorkerLane[] }).__erasureWorkerLanes ?? [];
function warmWorkerLane(): void {
  if (process.env.ERASURE_OPERATION_WORKER === '1') return;
  if (prefetchedLanes.length === 0) prefetchedLanes.push(createWorkerLane());
}
function takeWorkerLane(): WorkerLane {
  warmWorkerLane();
  const lane = prefetchedLanes.shift();
  if (!lane) throw new Error('Native worker lane was not prepared');
  return lane;
}
warmWorkerLane();

function openNativeWorker() {
  let lane: WorkerLane | undefined;
  let child: WorkerProcess | undefined;
  let source: WorkerSource | undefined;
  let client: WorkClient | undefined;
  // DBOS recovers PENDING workflows only for the executor that claimed them.
  // A restart must launch that same executor, or the parked erasure stays on the dead process.
  const executorId = `erasure-${randomUUID()}`;
  let held = false;
  let configured = false;
  let retired = false;
  let closing: Promise<void> | undefined;
  let lines: string[] = [];
  let waiters: WorkerWaiter[] = [];
  let stdoutTask: Promise<void> | undefined;
  let stderrTask: Promise<void> | undefined;

  function waitForLine(startsWith: string, timeoutMs = 60_000): Promise<string> {
    const cachedIndex = lines.findIndex((line) => line.startsWith(startsWith));
    if (cachedIndex >= 0) return Promise.resolve(lines.splice(cachedIndex, 1)[0]!);
    return new Promise((resolve, reject) => {
      const waiter = { startsWith, resolve, reject };
      waiters.push(waiter);
      const timer = setTimeout(() => {
        const index = waiters.indexOf(waiter);
        if (index >= 0) waiters.splice(index, 1);
        reject(
          new Error(
            `Timed out waiting for native worker output ${startsWith}; stdout=${lane?.output ?? ''}; stderr=${lane?.stderr ?? ''}`,
          ),
        );
      }, timeoutMs);
      const originalResolve = waiter.resolve;
      waiter.resolve = (value) => {
        clearTimeout(timer);
        originalResolve(value);
      };
      waiter.reject = (error) => {
        clearTimeout(timer);
        reject(error);
      };
    });
  }

  function rejectWaiters(): void {
    for (const waiter of waiters.splice(0)) waiter.reject(new Error('Native worker stopped'));
  }

  function spawnProcess(): void {
    configured = false;
    lane = takeWorkerLane();
    child = lane.child;
    lines = lane.lines;
    waiters = lane.waiters;
    stdoutTask = lane.stdoutTask;
    stderrTask = lane.stderrTask;
  }

  function writeConfig(growthMode: boolean): void {
    if (!child || !source) throw new Error('Native worker is not running');
    child.stdin.write(
      `config ${JSON.stringify({
        databaseUrl: source.appUrl,
        authDatabaseUrl: source.authUrl,
        routeKey: Buffer.from(source.routeKey).toString('base64url'),
        executorId,
        initialMode: held ? 'hold' : 'run',
        growthMode,
      })}\n`,
    );
    child.stdin.flush();
    configured = true;
  }

  async function ensureRunning(growthMode = false): Promise<void> {
    if (!source || !client) throw new Error('Native worker database is not ready');
    if (!child) spawnProcess();
    if (configured) return;
    writeConfig(growthMode);
    try {
      const ready = await Promise.race([waitForLine('ERASURE_WORKER_READY'), waitForLine('ERASURE_WORKER_FAILED')]);
      if (ready.startsWith('ERASURE_WORKER_FAILED')) {
        await kill();
        throw new Error(ready.slice('ERASURE_WORKER_FAILED '.length));
      }
    } catch (error) {
      await kill();
      throw error;
    }
  }

  async function sendControl(value: 'hold' | 'run'): Promise<void> {
    if (!child) throw new Error('Native worker is not running');
    child.stdin.write(`${value}\n`);
    child.stdin.flush();
    await waitForLine(`ERASURE_WORKER_CONTROL ${value}`);
  }

  async function kill(): Promise<void> {
    const current = child;
    if (!current) return;
    child = undefined;
    configured = false;
    try {
      current.kill('SIGKILL');
    } catch {
      // The worker can exit between the child check and the signal.
    }
    await current.exited;
    await Promise.allSettled([stdoutTask, stderrTask]);
    rejectWaiters();
  }

  async function stop(): Promise<void> {
    const current = child;
    if (!current) return;
    if (!configured) {
      configured = false;
      await kill();
      return;
    }
    current.stdin.write('stop\n');
    current.stdin.flush();
    try {
      await waitForLine('ERASURE_WORKER_STOPPED', 5_000);
      let timer: ReturnType<typeof setTimeout> | undefined;
      const exit = await Promise.race([
        current.exited.then((code) => ({ code })),
        new Promise<{ timeout: true }>((resolve) => {
          timer = setTimeout(() => resolve({ timeout: true }), 5_000);
        }),
      ]);
      if (timer) clearTimeout(timer);
      if ('timeout' in exit) {
        await kill();
      } else {
        child = undefined;
        await Promise.allSettled([stdoutTask, stderrTask]);
        rejectWaiters();
      }
    } catch {
      await kill();
    }
  }

  const api = {
    async pause() {
      await stop();
    },
    async pauseRelays() {
      if (!child) throw new Error('Native worker is not running');
      child.stdin.write('pause-relays\n');
      child.stdin.flush();
      await waitForLine('ERASURE_WORKER_CONTROL pause-relays');
    },
    async resumeRelays() {
      if (!child) throw new Error('Native worker is not running');
      child.stdin.write('resume-relays\n');
      child.stdin.flush();
      await waitForLine('ERASURE_WORKER_CONTROL resume-relays');
    },
    async restart(growthMode = false) {
      await stop();
      if (retired) return;
      configured = false;
      try {
        await ensureRunning(growthMode);
      } finally {
        // A timed-out seed can reach this restart after close() has retired the worker.
        if (retired) await stop();
      }
    },
    async close() {
      return (closing ??= (async () => {
        retired = true;
        await stop();
      })());
    },
    async hold() {
      held = true;
      await sendControl('hold');
    },
    async resume() {
      held = false;
      await sendControl('run');
    },
    async captureNextStep() {
      if (!child) throw new Error('Native worker is not running');
      child.stdin.write('capture-step\n');
      child.stdin.flush();
      await waitForLine('ERASURE_WORKER_CONTROL capture-step');
    },
    async waitCost(): Promise<NativeWorkerCost> {
      const line = await waitForLine('ERASURE_WORKER_COST');
      const value = JSON.parse(line.slice('ERASURE_WORKER_COST '.length)) as {
        serial: number;
        cost: Cost;
      };
      return value;
    },
    diagnostics() {
      return `${lane?.output ?? ''}\n${lane?.stderr ?? ''}`.slice(-4_000);
    },
    async waitResult(workflowId: string) {
      if (!client) throw new Error('Native worker is not running');
      try {
        await client.retrieveWorkflow(workflowId).getResult();
      } catch {
        // A terminal PERMISSION_DENIED is expected in the revocation scenario.
      }
    },
  };
  return {
    preload() {
      if (child) return;
      mark('worker-preload');
      spawnProcess();
    },
    activate(next: WorkerSource, nextClient: WorkClient) {
      source = next;
      client = nextClient;
      return ensureRunning(false).then(() => api);
    },
    close() {
      return api.close();
    },
  };
}
type NativeWorker = Awaited<ReturnType<ReturnType<typeof openNativeWorker>['activate']>>;

export async function createErasureOperationDriver(): Promise<ErasureOperationDriver> {
  const started = performance.now();
  let readyAt: number | undefined;
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error('DATABASE_URL must name a migrated kernel database');
  let ownedResources: FixtureResources | undefined;
  let ownedGrowth: GrowthDatabase | undefined;
  let ownedReadPool: Pool | undefined;
  let ownedWorkPool: Pool | undefined;
  let ownedAppPool: Pool | undefined;
  let ownedWorkClient: WorkClient | undefined;
  let ownedMeasuredClient: WorkClient | undefined;
  let ownedStatusGrowth: GrowthDatabase | undefined;
  let ownedStatusClient: WorkClient | undefined;
  let ownedControlClient: WorkClient | undefined;
  let ownedObserver: SqlObserver | undefined;
  let worker: NativeWorker | undefined;
  let pendingWorker: ReturnType<typeof openNativeWorker> | undefined;
  try {
    mark('driver-enter');
    // Spawn before the fixture so the child compiles its graph while Auth and
    // governance bootstrap run. Connection settings follow on stdin.
    pendingWorker = openNativeWorker();
    pendingWorker.preload();
    const [
      { createWriteRateLimiter },
      { createKernel },
      { fromPlainText },
      { runCommand },
      { observeSql },
      { buildBoardAndThreads, createFixtureResources, request, revokeAuthorAccessGrant, revokeGrant, setupRequest },
      { endResourceDenial, recordResourceDenial },
      { resourceAuthorization },
      { openGrowthDatabase },
    ] = await Promise.all([
      import('../../src/access/write-rate.ts'),
      import('../../src/http/kernel.ts'),
      import('@rezics/document'),
      import('../../src/command/command.ts'),
      import('./support/sql-observer.ts'),
      import('./support/erasure-operation-fixtures.ts'),
      import('../../src/access/resource-denials.ts'),
      import('../../src/access/resource-authorization.ts'),
      import('../support/growth.ts'),
    ]);
    const resources = (ownedResources = await createFixtureResources(
      databaseUrl,
      async (system) => {
        const appUrl = system.database.pool.options.connectionString;
        const authUrl = system.database.authPool.options.connectionString;
        if (!appUrl || !authUrl) throw new Error('Native content system has no database URL');
        await system.database.pool.query(
          `CREATE TABLE IF NOT EXISTS ${BARRIER_TABLE} (
           workflow_id text NOT NULL,
           serial integer NOT NULL,
           name text NOT NULL,
           released boolean NOT NULL DEFAULT false,
           checks jsonb,
           error text,
           PRIMARY KEY (workflow_id, serial)
         )`,
        );
        const controlClient = (ownedControlClient = await createWorkClient(appUrl));
        mark('worker-start');
        worker = await pendingWorker!.activate({ appUrl, authUrl, routeKey: system.routeKey }, controlClient);
        mark('worker-ready');
      },
      async () => {
        await (worker ?? pendingWorker)?.close();
        await ownedControlClient?.close();
      },
    ));
    mark('resources-ready');
    const databaseName = (
      await resources.system.database.pool.query<{ name: string }>('SELECT current_database() AS name')
    ).rows[0]?.name;
    if (!databaseName || !/^[a-z_][a-z0-9_]*$/.test(databaseName))
      throw new Error('Native content database has no usable name');
    // This database exists only for the test. Waiting for a durable WAL flush on every
    // same-partition command dominates seeding under host IO pressure.
    await resources.system.database.pool.query(`ALTER DATABASE ${databaseName} SET synchronous_commit = off`);
    const growth = (ownedGrowth = await openGrowthDatabase(resources.appUrl));
    // These attempts are serial. Keep one explained backend across catalogue
    // growth so a new connection's SQL-function cache is not a different variable
    // at each scale. The native statements and their plans are unchanged.
    growth.pool.options.max = 1;
    growth.pool.options.idleTimeoutMillis = 0;
    // The growth pool explains every statement. Functional traffic stays on the
    // plain application pool; only a measured checkGrowth attempt uses it.
    const readPool = (ownedReadPool = new Pool({ connectionString: resources.appUrl, max: 4 }));
    const workPool = (ownedWorkPool = new Pool({ connectionString: resources.appUrl, max: 4 }));
    const appPool = (ownedAppPool = new Pool({
      connectionString: resources.appUrl,
      max: 16,
      connectionTimeoutMillis: 1_000,
      idleTimeoutMillis: 0,
    }));
    const appCheckouts = new Map<PoolClient, string>();
    appPool.on('acquire', (client) => appCheckouts.set(client, new Error('Application pool checkout').stack ?? ''));
    appPool.on('release', (_error, client) => appCheckouts.delete(client));
    resources.pool = appPool;
    const workClient = (ownedWorkClient = await createWorkClient(resources.appUrl, workPool));
    const controlClient = ownedControlClient!;
    const workflows = createContentOperationClient({
      pool: resources.pool,
      client: workClient,
      clock: () => new Date(),
    });
    // Setup statements retain authored parameters and are not part of the
    // scenario's command trace. Observe only once the scenario starts.
    let observer: SqlObserver | undefined;
    const observeCommands = () => (observer ??= ownedObserver = observeSql(resources.pool));
    const checks: NativeCheck[] = [];
    const fixtureData = new Map<string, StoredFixture>();
    const serialByOperation = new Map<string, number>();
    const workflowByOperation = new Map<string, string>();
    const observedCheckEvents = new Set<string>();
    const bearerHistory = new Map<Persona, string>();
    const accountReadValidity = new Map<string, string[]>();
    let authorityAt: string | undefined;
    let closing = false;
    const receiptBaselines = new Map<number, Set<string>>();
    const preparedStock: Fixture[] = [];
    const inspectionCache = new Map<string, { token: string; value: Inspection }>();
    const commandQueries: { key: string; statements: string[] }[] = [];
    const system = resources.system;
    const kernelOptions = {
      pool: resources.pool,
      routeKey: system.routeKey,
      tokens: system.tokenKeys,
      clock: () => new Date(),
      access: () => system.access,
      content: { cursorNow: () => Date.now(), workflows },
      writeRate: createWriteRateLimiter({
        secret: `erasure-operation-${randomUUID()}-${randomUUID()}`,
        overrides: '{"new-account":{"write":{"maximum":100000,"seconds":60}}}',
      }),
      ratePeer: () => '127.0.0.1',
      workClient,
    };
    const driverKernel = createKernel(kernelOptions);
    let measuredKernel: ReturnType<typeof createKernel> | undefined;
    Object.assign(resources, { kernel: driverKernel });
    // The explained pool is only for the captured attempts. Building it during
    // ordinary setup leaves too little of the suite's time budget for seeding.
    const useMeasuredKernel = async (active: boolean) => {
      if (!active) {
        resources.kernel = driverKernel;
        return;
      }
      if (!measuredKernel) {
        const measuredWorkClient = (ownedMeasuredClient = await createWorkClient(resources.appUrl, growth.pool));
        const measuredWorkflows = createContentOperationClient({
          pool: growth.pool,
          client: measuredWorkClient,
          clock: () => new Date(),
        });
        measuredKernel = createKernel({
          ...kernelOptions,
          pool: growth.pool,
          content: { cursorNow: () => Date.now(), workflows: measuredWorkflows },
          workClient: measuredWorkClient,
        });
      }
      resources.kernel = measuredKernel;
    };

    async function jsonReply<T>(response: Response): Promise<Reply<T>> {
      if (!response.ok) return makeReply(response);
      const value = await response.clone().json();
      return makeReply(response, value as T);
    }

    async function workflowIdFor(name: string): Promise<string> {
      const id = operationId(name);
      const cached = workflowByOperation.get(id);
      if (cached) return cached;
      const route = routeOf(id);
      if (route === null) throw new TypeError('Invalid operation route');
      const deadline = Date.now() + 30_000;
      let workflowId: string | null | undefined;
      while (!closing && Date.now() < deadline) {
        const result = await readPool.query<{ native_workflow_id: string | null }>(
          'SELECT native_workflow_id FROM content.operation WHERE route=$1 AND operation_id=$2',
          [route, id],
        );
        workflowId = result.rows[0]?.native_workflow_id;
        if (workflowId) break;
        await new Promise((resolve) => setTimeout(resolve, 15));
      }
      if (!workflowId) {
        const relayState = await readPool.query(
          `SELECT o.source_partition,o.source_position::text,p.position::text AS head,
             c.position::text AS checkpoint,
             (SELECT count(*)::integer FROM core.outbox e
               WHERE e.partition_no=$3 AND e.data->>'operationId'=o.operation_id::text) AS events
           FROM content.operation o
           LEFT JOIN core.partition p ON p.partition_no=$3
           LEFT JOIN core.consumer_checkpoint c
             ON c.partition_no=$3 AND c.consumer='effects'
           WHERE o.route=$1 AND o.operation_id=$2`,
          [route, id, partitionOf(route)],
        );
        const events = await readPool.query<{
          epoch: number;
          partition_no: number;
          position: string;
          event_seq: number;
        }>(
          `SELECT epoch,partition_no,position::text,event_seq
           FROM core.outbox
           WHERE partition_no=$1 AND type='com.rezics.content.author-erasure.requested.v1'
             AND data->>'operationId'=$2
           ORDER BY position,event_seq`,
          [partitionOf(route), id],
        );
        const effectWorkflowIds = events.rows.map(
          (event) =>
            `fx:${event.epoch}:${event.partition_no}:${event.position}:${event.event_seq}:content_author_erasure`,
        );
        const effectStatus =
          effectWorkflowIds.length === 0
            ? { rows: [] }
            : await readPool.query(
                `SELECT workflow_uuid,status,error,queue_name,executor_id,application_version,
                        recovery_attempts,created_at,updated_at
                 FROM ${DBOS_SCHEMA}.workflow_status
                 WHERE workflow_uuid=ANY($1::text[])
                 ORDER BY workflow_uuid`,
                [effectWorkflowIds],
              );
        const effectOutputs =
          effectWorkflowIds.length === 0
            ? { rows: [] }
            : await readPool.query(
                `SELECT workflow_uuid,function_name,error
                 FROM ${DBOS_SCHEMA}.operation_outputs
                 WHERE workflow_uuid=ANY($1::text[])
                 ORDER BY workflow_uuid,function_id`,
                [effectWorkflowIds],
              );
        const operationRow = await readPool.query(
          'SELECT * FROM content.operation WHERE route=$1 AND operation_id=$2',
          [route, id],
        );
        const queueState = await readPool.query(`SELECT * FROM ${DBOS_SCHEMA}.queues ORDER BY name`);
        const applicationVersions = await readPool.query(
          `SELECT * FROM ${DBOS_SCHEMA}.application_versions ORDER BY version_timestamp`,
        );
        const partitionQueueState = await readPool.query(
          `SELECT workflow_uuid,status,name,error,queue_partition_key,created_at,updated_at
           FROM ${DBOS_SCHEMA}.workflow_status
           WHERE queue_name='effects' AND queue_partition_key=$1 AND status<>'SUCCESS'
           ORDER BY created_at,workflow_uuid
           LIMIT 20`,
          [String(events.rows[0]?.partition_no)],
        );
        throw new Error(
          `Committed operation has not been bound to native DBOS; relay=${JSON.stringify(relayState.rows[0] ?? null)}; effectWorkflows=${JSON.stringify(effectWorkflowIds)}; effectStatus=${JSON.stringify(effectStatus.rows)}; effectOutputs=${JSON.stringify(effectOutputs.rows)}; operation=${JSON.stringify(operationRow.rows[0] ?? null)}; queues=${JSON.stringify(queueState.rows)}; applicationVersions=${JSON.stringify(applicationVersions.rows)}; partitionQueue=${JSON.stringify(partitionQueueState.rows)}; worker=${worker!.diagnostics()}`,
        );
      }
      workflowByOperation.set(id, workflowId);
      return workflowId;
    }

    async function barrierRow(workflowId: string, serial: number) {
      const result = await readPool.query<{
        name: string;
        serial: number;
        checks: NativeCheck[] | null;
        error: string | null;
      }>(`SELECT serial, name, checks, error FROM ${BARRIER_TABLE} WHERE workflow_id=$1 AND serial=$2`, [
        workflowId,
        serial,
      ]);
      return result.rows[0];
    }

    async function nativeStepFailure(workflowId: string, serial: number, error: string): Promise<Error> {
      const status = await readPool.query(
        `SELECT workflow_uuid,status,error,queue_name,executor_id,application_version,
                recovery_attempts,created_at,updated_at
         FROM ${DBOS_SCHEMA}.workflow_status WHERE workflow_uuid=$1`,
        [workflowId],
      );
      const outputs = await readPool.query(
        `SELECT function_name,error FROM ${DBOS_SCHEMA}.operation_outputs
         WHERE workflow_uuid=$1 ORDER BY function_id`,
        [workflowId],
      );
      const operation = await readPool.query('SELECT * FROM content.operation WHERE native_workflow_id=$1', [
        workflowId,
      ]);
      return new Error(
        `Native erasure step ${serial} failed: ${error}; status=${JSON.stringify(status.rows)}; outputs=${JSON.stringify(outputs.rows)}; operation=${JSON.stringify(operation.rows)}; worker=${worker!.diagnostics()}`,
      );
    }

    async function waitForBarrier(workflowId: string, serial: number): Promise<StepEvent> {
      const deadline = Date.now() + 60_000;
      while (!closing && Date.now() < deadline) {
        const row = await barrierRow(workflowId, serial);
        if (row) return { serial: row.serial, name: row.name };
        const status = await readPool.query<{ status: string; error: string | null }>(
          `SELECT s.status, o.error
           FROM ${DBOS_SCHEMA}.workflow_status s
           LEFT JOIN ${DBOS_SCHEMA}.workflow_output o ON o.workflow_uuid = s.workflow_uuid
           WHERE s.workflow_uuid=$1`,
          [workflowId],
        );
        const current = status.rows[0];
        if (current && ['ERROR', 'CANCELLED', 'MAX_RECOVERY_ATTEMPTS_EXCEEDED'].includes(current.status)) {
          const outputs = await readPool.query(
            `SELECT function_name, error FROM ${DBOS_SCHEMA}.operation_outputs
             WHERE workflow_uuid=$1 AND error IS NOT NULL ORDER BY function_id`,
            [workflowId],
          );
          mark(`workflow-ended ${current.status} ${current.error ?? ''} outputs=${JSON.stringify(outputs.rows)}`);
          throw new Error(
            `Native erasure workflow ended ${current.status}: ${current.error ?? ''} outputs=${JSON.stringify(outputs.rows)}`,
          );
        }
        await new Promise((resolve) => setTimeout(resolve, 15));
      }
      throw new Error(`Native erasure step ${serial} did not reach its barrier`);
    }

    async function waitForChecks(workflowId: string, serial: number): Promise<NativeCheck[]> {
      const deadline = Date.now() + 60_000;
      while (!closing && Date.now() < deadline) {
        const row = await barrierRow(workflowId, serial);
        if (row?.error) throw await nativeStepFailure(workflowId, serial, row.error);
        if (row?.checks) return row.checks;
        await new Promise((resolve) => setTimeout(resolve, 15));
      }
      throw new Error(`Native erasure step ${serial} did not persist actual Access checks`);
    }

    async function waitForNativeResult(workflowId: string): Promise<void> {
      let waiting = true;
      const failure = (async () => {
        while (waiting && !closing) {
          const rows = await readPool.query<{ serial: number; error: string }>(
            `SELECT serial,error FROM ${BARRIER_TABLE}
             WHERE workflow_id=$1 AND error IS NOT NULL ORDER BY serial LIMIT 1`,
            [workflowId],
          );
          const row = rows.rows[0];
          if (row) throw await nativeStepFailure(workflowId, row.serial, row.error);
          await new Promise((resolve) => setTimeout(resolve, 15));
        }
      })();
      try {
        await Promise.race([worker!.waitResult(workflowId), failure]);
      } finally {
        waiting = false;
        await failure.catch(() => undefined);
      }
    }

    async function waitForOperationBarrier(name: string, serial: number): Promise<void> {
      await waitForBarrier(await workflowIdFor(name), serial);
    }

    async function releaseLogicalPage(name: string, expectNext: boolean): Promise<string[]> {
      const id = operationId(name);
      const workflowId = await workflowIdFor(name);
      const serial = (serialByOperation.get(id) ?? 0) + 1;
      const event = await waitForBarrier(workflowId, serial);
      // Preserve logical-before-physical inspection by holding the actual relay.
      await worker!.pauseRelays();
      await readPool.query(`UPDATE ${BARRIER_TABLE} SET released=true WHERE workflow_id=$1 AND serial=$2`, [
        workflowId,
        serial,
      ]);
      const entries = await waitForChecks(workflowId, serial);
      if (expectNext) await waitForBarrier(workflowId, serial + 1);
      serialByOperation.set(id, serial);
      checks.push(...entries);
      observedCheckEvents.add(`${workflowId}:${serial}`);
      if (entries.some((entry) => entry.step !== event.name))
        throw new Error('Native Access trace does not match the barrier step');
      const ids = [...new Set(entries.map((entry) => entry.postId))];
      if (ids.length === 0) throw new Error('Native erasure page completed without real Access checks');
      mark(`step ${ids.length}`);
      return ids;
    }

    async function mutateAuthority(persona: Persona, axis: string, operation: 'allow' | 'revoke'): Promise<void> {
      if (persona !== 'author') throw new Error('Only the initiating author has mutable authority axes');
      const accountId = resources.accountIds.author;
      if (axis === 'account:read-scope') {
        const credential = await system.auth.issue({
          accountId,
          clientId: system.auth.ordinaryClient.id,
          scopes:
            operation === 'revoke'
              ? system.actors.author.actor.scopes.filter((scope) => scope !== 'account:read')
              : system.actors.author.actor.scopes,
        });
        resources.updateBearer('author', credential.bearer);
        bearerHistory.set('author', credential.bearer);
        return;
      }
      if (axis === 'suspension') {
        if (operation === 'revoke') {
          await setupRequest(
            resources,
            'governance',
            'POST',
            `/v1/accounts/${accountId}:suspend`,
            { reason: 'Erasure operation authority test' },
            200,
          );
        } else {
          await setupRequest(
            resources,
            'governance',
            'POST',
            `/v1/accounts/${accountId}:reinstate`,
            { reason: 'Erasure operation authority restored' },
            200,
          );
          const credential = await system.auth.issue({
            accountId,
            clientId: system.auth.ordinaryClient.id,
            scopes: system.actors.author.actor.scopes,
          });
          resources.updateBearer('author', credential.bearer);
          bearerHistory.set('author', credential.bearer);
        }
        return;
      }
      if (axis === 'account:read') {
        const route = routeOf(accountId)!;
        if (operation === 'revoke') {
          for (const valid of accountReadValidity.get(accountId) ?? ['(,)'])
            await revokeGrant(resources, 'author', {
              resource: { route, id: accountId },
              subject: { kind: 'account', id: accountId },
              actions: ['account:read'],
              valid,
            });
        } else {
          await runCommand(resources.pool, { partition: partitionOf(route) }, async (tx, command) => {
            await tx.query(
              `INSERT INTO access.resource_grant
                 (route,resource_id,subject_id,subject_role,action,valid,transaction_id)
               VALUES ($1,$2,$2,'','account:read',tstzrange($3::timestamptz,NULL,'[)'),$4)`,
              [route, accountId, authoritativeTimeValue(command.time), command.transactionId],
            );
            const valid = `[${authoritativeTimeValue(command.time)},)`;
            return {
              value: null,
              events: [
                {
                  type: 'com.rezics.access.grant.create.v1',
                  subject: accountId,
                  data: {
                    resource: { route, id: accountId },
                    subject: { kind: 'account', id: accountId },
                    actions: ['account:read'],
                    valid,
                  },
                },
              ],
            };
          });
        }
        return;
      }
      if (axis === 'post:erase') {
        const f = [...fixtureData.values()].at(-1);
        if (!f) throw new Error('No native author-erasure fixture is available');
        const route = routeOf(f.thread)!;
        const governanceBearer = resources.bearer('governance');
        if (!governanceBearer) throw new Error('Governance bearer is missing');
        const deadline = Date.now() + 60_000;
        const governor = await system.access.authenticate(governanceBearer, { pool: resources.pool, deadline });
        if (governor.kind !== 'account') throw new Error('Governance bearer did not authenticate an account');
        const write = operation === 'revoke' ? recordResourceDenial : endResourceDenial;
        const started = performance.now();
        for (let start = 0; start < f.targeted.length; start += 16) {
          const batch = f.targeted.slice(start, start + 16);
          const times = await Promise.all(
            batch.map(async (post) => {
              const resource = { route, id: post.id };
              const authorization = resourceAuthorization({
                access: system.access,
                actor: governor,
                action: 'post:erase',
                anchor: {
                  resource,
                  async validate(client) {
                    const row = await client.query('SELECT 1 FROM content.post WHERE route=$1 AND post_id=$2', [
                      route,
                      post.id,
                    ]);
                    return row.rows.length === 1;
                  },
                },
                context: { pool: resources.pool, deadline: Date.now() + 30_000, partition: partitionOf(route) },
              });
              try {
                const outcome = await runCommand(
                  resources.pool,
                  {
                    partition: partitionOf(route),
                    deadline: Date.now() + 30_000,
                    authorization,
                    basis: {
                      actorAccountId: governor.accountId,
                      clientId: governor.clientId,
                      requestedBy: governor.requestedBy,
                    },
                  },
                  async (tx, command) => {
                    await write(tx, {
                      resource,
                      subjectId: accountId,
                      subjectRole: '',
                      action: 'post:erase',
                      reason: 'resource',
                      at: command.time,
                    });
                    const at = authoritativeTimeValue(command.time);
                    return {
                      value: at,
                      events: [
                        {
                          type: 'com.rezics.access.grant.create.v1',
                          subject: post.id,
                          data: {
                            resource,
                            subject: { kind: 'account', id: accountId },
                            actions: ['post:erase'],
                            valid: `[${at},)`,
                          },
                        },
                      ],
                    };
                  },
                );
                return outcome.value;
              } catch (error) {
                const detail = error instanceof Error ? error.message : String(error);
                throw new Error(`Access refused post:erase ${operation} on ${post.id}: ${detail}`, { cause: error });
              }
            }),
          );
          for (const at of times) if (!authorityAt || Date.parse(at) >= Date.parse(authorityAt)) authorityAt = at;
        }
        console.log(
          `erasure-setup authority post:erase ${operation} ${f.targeted.length} ${Math.round(performance.now() - started)}ms`,
        );
        return;
      }
      throw new Error(`Unsupported author authority axis: ${axis}`);
    }

    async function captureReceiptBaseline(partition: number): Promise<void> {
      const baseline = await readPool.query<{ idempotency_key: string }>(
        'SELECT idempotency_key FROM core.receipt WHERE partition_no=$1',
        [partition],
      );
      receiptBaselines.set(partition, new Set(baseline.rows.map((row) => row.idempotency_key)));
    }

    async function seedFixture(
      posts: number,
      revisions: number,
      marker: string,
      targetPartition?: number,
      tail = true,
    ): Promise<Fixture> {
      if (targetPartition === undefined) {
        const index = preparedStock.findIndex(
          (item) => item.targeted.length === posts && item.targeted[0]?.revisions.length === revisions,
        );
        const stocked = index < 0 ? undefined : preparedStock.splice(index, 1)[0];
        if (stocked) {
          mark(`seed-stock ${posts}`);
          return stocked;
        }
      }
      // Board projection reads the same partition log the publish command writes.
      // Stop the relays without recycling DBOS; a second launch does not fit the hook.
      await worker!.pauseRelays();
      let data: Awaited<ReturnType<typeof buildBoardAndThreads>> | undefined;
      try {
        data = await buildBoardAndThreads(resources, posts, revisions, marker, targetPartition);
      } finally {
        // History writes share the partition log the board projection reads.
        // Leave the relays paused until seed resumes them.
        if (!data || tail) await worker!.resumeRelays();
      }
      if (!data) throw new Error('Board setup produced no thread');
      const fixture: Fixture = {
        thread: data.thread,
        partition: data.partition,
        authorId: data.authorId,
        marker,
        targeted: data.targeted,
      };
      fixtureData.set(fixture.thread, data);
      const owners = await readPool.query<{ resource_id: string }>(
        `SELECT resource_id::text FROM access.resource_role_grant
         WHERE route=$1 AND resource_id = ANY($2::uuid[]) AND subject_kind='identity' AND subject_id=$3
           AND subject_role='' AND grant_role='content.post.owner' AND upper_inf(valid)`,
        [data.route, data.targeted.map((post) => post.id), data.authorId],
      );
      if (owners.rows.length !== data.targeted.length)
        throw new Error('Published targets are missing native owner grants');
      const direct = await readPool.query<{ valid: string }>(
        `SELECT valid::text FROM access.resource_grant
         WHERE route=$1 AND resource_id=$2 AND subject_kind='identity' AND subject_id=$3
           AND subject_role='' AND action='account:read'`,
        [routeOf(data.authorId)!, data.authorId, data.authorId],
      );
      if (direct.rows.length === 0) throw new Error('Activated author is missing the native self account:read grant');
      accountReadValidity.set(
        data.authorId,
        direct.rows.map((row) => row.valid),
      );
      // Creation grants are in place. Scenarios must not keep the author's temporary administration grant.
      await revokeAuthorAccessGrant(resources);
      if (tail) {
        await request(
          resources,
          'anonymous',
          'GET',
          `/v1/boards/${data.board}/threads?query=${encodeURIComponent(marker)}`,
        );
        await drainEffects(data.partition);
        await captureReceiptBaseline(data.partition);
      }
      return fixture;
    }

    const driver: ErasureOperationDriver = {
      async close() {
        closing = true;
        const closingAt = performance.now();
        const failures: unknown[] = [];
        resources.stopBootstrap();
        const cleanup: [string, () => Promise<unknown>][] = [
          ['bootstrap', () => resources.bootstrap.catch(() => undefined)],
          ['worker', () => worker!.close()],
          ['observer', () => observer?.close() ?? Promise.resolve()],
          ['control-client', () => controlClient.close()],
          ['measured-client', () => ownedMeasuredClient?.close() ?? Promise.resolve()],
          ['status-client', () => ownedStatusClient?.close() ?? Promise.resolve()],
          ['work-client', () => workClient.close()],
          ['work-pool', () => workPool.end()],
          [
            'app-pool',
            async () => {
              console.log(
                'erasure-cleanup-pool',
                JSON.stringify({
                  total: appPool.totalCount,
                  idle: appPool.idleCount,
                  waiting: appPool.waitingCount,
                  ending: appPool.ending,
                  ended: appPool.ended,
                  checkouts: appCheckouts.size,
                }),
              );
              if (appCheckouts.size) {
                const sessions = [...appCheckouts].map(([client, stack]) => ({
                  pid: (client as PoolClient & { processID: number }).processID,
                  stack,
                }));
                const activity = await readPool.query(
                  `SELECT pid, state, wait_event_type, wait_event, query
                   FROM pg_stat_activity WHERE pid=ANY($1::integer[])`,
                  [sessions.map(({ pid }) => pid)],
                );
                console.error('erasure-cleanup-checkouts', JSON.stringify({ sessions, activity: activity.rows }));
              }
              await appPool.end();
            },
          ],
          ['read-pool', () => readPool.end()],
          ['growth', () => growth.close()],
          ['status-growth', () => ownedStatusGrowth?.close() ?? Promise.resolve()],
          ['system', () => system.close()],
        ];
        for (const [name, close] of cleanup) {
          console.log(`erasure-cleanup start=${name}`);
          try {
            await close();
          } catch (error) {
            failures.push(error);
          }
        }
        console.log(
          `erasure-phases setup=${Math.round((readyAt ?? closingAt) - started)}ms scenario=${Math.round(closingAt - (readyAt ?? closingAt))}ms cleanup=${Math.round(performance.now() - closingAt)}ms`,
        );
        if (failures.length) throw new AggregateError(failures, 'Native erasure operation fixture cleanup failed');
      },
      async seed(input): Promise<Fixture> {
        mark(`seed-start ${input.posts}`);
        const marker = `erasure-${randomUUID().replaceAll('-', '')}`;
        const fixture = await seedFixture(input.posts, input.revisions, marker, undefined, false);
        const data = fixtureData.get(fixture.thread);
        if (!data) throw new Error('Seeded thread has no stored board');
        // Projection stays paused through publish and grants. Resume it now so the
        // erasure effect can be bound, after those writes have committed.
        await worker!.resumeRelays();
        await request(
          resources,
          'anonymous',
          'GET',
          `/v1/boards/${data.board}/threads?query=${encodeURIComponent(fixture.marker)}`,
        );
        mark('drain-start');
        await drainEffects(data.partition);
        mark('drain-done');
        await captureReceiptBaseline(data.partition);
        mark(`seed-done ${input.posts}`);
        return fixture;
      },
      async erase(actor, thread, authorId, key) {
        const records = observeCommands().records;
        const mark = records.length;
        const response = await request(resources, actor, 'POST', `/v1/threads/${thread}:erase`, { authorId }, key);
        commandQueries.push({ key, statements: records.slice(mark).map((entry) => entry.statement) });
        return jsonReply<Operation>(response);
      },
      async status(actor, name) {
        const response = await request(resources, actor, 'GET', `/v1/operations/${operationId(name)}`);
        return jsonReply<Operation>(response);
      },
      unknownOperation() {
        const f = [...fixtureData.values()].at(-1);
        if (!f) throw new Error('No native fixture has been seeded');
        return `operations/${newId(routeOf(f.thread)!)}`;
      },
      async readRevision(actor, postId, revisionId) {
        const response = await request(resources, actor, 'GET', `/v1/posts/${postId}/revisions/${revisionId}`);
        if (!response.ok) return makeReply(response);
        const wire = (await response.clone().json()) as {
          post: { revisionId: string; sha256: string | null; body: unknown; availability: 'available' | 'erased' };
        };
        return makeReply(response, {
          id: wire.post.revisionId,
          digest: wire.post.sha256,
          body: wire.post.body,
          availability: wire.post.availability,
        } as unknown as import('../../../../specs/erasure-operation-driver.ts').Revision);
      },
      async edit(actor, postId, body, key) {
        return jsonReply(
          await request(
            resources,
            actor,
            'POST',
            `/v1/posts/${postId}/revisions`,
            {
              body: fromPlainText(body),
              licence: 'CC0-1.0',
              subjectIds: [],
            },
            key,
          ),
        );
      },
      async erasePost(actor, postId, key) {
        const records = observeCommands().records;
        const mark = records.length;
        const result = await jsonReply(
          await request(resources, actor, 'POST', `/v1/posts/${postId}:erase`, { reason: 'Point erase' }, key),
        );
        commandQueries.push({ key, statements: records.slice(mark).map((entry) => entry.statement) });
        const data = [...fixtureData.values()].find((fixture) => fixture.targeted.some((post) => post.id === postId));
        if (result.response.ok && data) {
          await drainEffects(data.partition);
          await waitPostCleanup(data, [postId]);
          await waitBodiesNull(data);
        }
        return result;
      },
      async takedown(actor, postId, key) {
        const records = observeCommands().records;
        const mark = records.length;
        const result = await jsonReply(
          await request(resources, actor, 'POST', `/v1/posts/${postId}:takeDown`, { reason: 'Point takedown' }, key),
        );
        commandQueries.push({ key, statements: records.slice(mark).map((entry) => entry.statement) });
        return result;
      },
      async barrier(next) {
        if (next !== 'hold') throw new RangeError('Unsupported native test barrier mode');
        await worker!.hold();
      },
      async step(name) {
        return releaseLogicalPage(name, true);
      },
      async finish(name) {
        mark('finish-start');
        const id = operationId(name);
        const workflowId = await workflowIdFor(name);
        await worker!.resumeRelays();
        await worker!.resume();
        await waitForNativeResult(workflowId);
        mark('finish-result');
        const route = routeOf(id);
        if (route === null) throw new TypeError('Invalid operation route');
        const operationRow = await readPool.query<{ thread_id: string }>(
          'SELECT thread_id::text FROM content.operation WHERE route=$1 AND operation_id=$2',
          [route, id],
        );
        const f = fixtureData.get(operationRow.rows[0]?.thread_id ?? '');
        if (!f) throw new Error('Native operation has no matching content fixture');
        const stored = await readPool.query<{ serial: number; checks: NativeCheck[] | null }>(
          `SELECT serial, checks FROM ${BARRIER_TABLE} WHERE workflow_id=$1 ORDER BY serial`,
          [workflowId],
        );
        for (const row of stored.rows) {
          const eventKey = `${workflowId}:${row.serial}`;
          if (observedCheckEvents.has(eventKey) || !row.checks) continue;
          checks.push(...row.checks);
          observedCheckEvents.add(eventKey);
        }
        await drainEffects(f.partition);
        const erased = await readPool.query<{ post_id: string }>(
          `SELECT post_id::text FROM content.post
           WHERE route=$1 AND thread_id=$2 AND availability='erased' AND post_id = ANY($3::uuid[])`,
          [routeOf(f.thread), f.thread, f.targeted.map((post) => post.id)],
        );
        // Denial stops later targets. Their rows stay available and emit no cleanup.
        await waitPostCleanup(
          f,
          erased.rows.map((row) => row.post_id),
        );
        await waitBodiesNull(f);
        mark('finish-done');
      },
      async restart() {
        const started = performance.now();
        await worker!.restart();
        console.log(`erasure-setup restart ${Math.round(performance.now() - started)}ms`);
      },
      async authority(actor, axis, operation) {
        mark(`authority-start ${axis} ${operation}`);
        await mutateAuthority(actor, axis, operation);
        mark(`authority-done ${axis} ${operation}`);
      },
      async authorityTime() {
        if (authorityAt) return authorityAt;
        const result = await readPool.query<{ at: string }>('SELECT clock_timestamp()::text AS at');
        return result.rows[0]!.at;
      },
      async inspect(fixture) {
        const data = fixtureData.get(fixture.thread);
        if (!data) throw new Error('Inspection fixture identity is unknown');
        const sentinelRoute = routeOf(data.sentinelPost)!;
        const partitions = [...new Set([data.partition, partitionOf(sentinelRoute)])];
        const tokenResult = await readPool.query<{ partition_no: number; epoch: string; position: string }>(
          `SELECT partition_no, epoch::text, position::text
           FROM core.partition WHERE partition_no = ANY($1::int[]) ORDER BY partition_no`,
          [partitions],
        );
        const token = tokenResult.rows.map((row) => `${row.partition_no}:${row.epoch}:${row.position}`).join('|');
        const cached = inspectionCache.get(fixture.thread);
        if (cached?.token === token) return cached.value;
        mark('inspect-load');
        const mainRoute = data.route;
        const postRows = await readPool.query<{
          post_id: string;
          availability: string;
          visibility: string;
        }>(
          `SELECT post_id::text,availability,visibility FROM content.post
         WHERE (route=$1 AND thread_id=$2) OR (route=$3 AND post_id=$4)
         ORDER BY route,post_id`,
          [mainRoute, data.thread, sentinelRoute, data.sentinelPost],
        );
        const revisionRows = await readPool.query<{
          revision_id: string;
          post_id: string;
          body: Buffer | null;
          availability: string;
          digest: string | null;
        }>(
          `SELECT revision_id::text,post_id::text,body,availability,encode(body_sha256,'hex') AS digest
         FROM content.revision
         WHERE (route=$1 AND thread_id=$2) OR (route=$3 AND post_id=$4)
         ORDER BY route,post_id,revision_id`,
          [mainRoute, data.thread, sentinelRoute, data.sentinelPost],
        );
        const operations = await readPool.query<{ operation_id: string }>(
          'SELECT operation_id::text FROM content.operation WHERE route=$1 AND thread_id=$2 ORDER BY operation_id',
          [mainRoute, data.thread],
        );
        const postIds = [data.firstPost, data.sentinelPost, ...data.targeted.map((post) => post.id)];
        const erasedEffects = await readPool.query<{ position: string; event_seq: number; data: unknown }>(
          `SELECT position::text,event_seq,data FROM core.outbox
         WHERE partition_no=$1 AND type='com.rezics.content.post.erased.v1'
         ORDER BY position,event_seq`,
          [data.partition],
        );
        const receipts = await readPool.query<{ response: unknown }>(
          'SELECT response FROM core.receipt WHERE partition_no=$1 ORDER BY position,idempotency_key',
          [data.partition],
        );
        const outbox = await readPool.query<{ type: string; subject: string | null; data: unknown }>(
          'SELECT type,subject,data FROM core.outbox WHERE partition_no=$1 ORDER BY position,event_seq',
          [data.partition],
        );
        const targetIds = new Set(postIds);
        const value: Inspection = {
          posts: postRows.rows.map((row) => ({
            id: row.post_id,
            erased: row.availability === 'erased',
            visibility: row.visibility,
          })),
          revisions: revisionRows.rows.map((row) => ({
            id: row.revision_id,
            postId: row.post_id,
            body: row.body === null ? null : row.body.toString('utf8'),
            erased: row.availability === 'erased',
            digest: row.digest as string,
          })),
          operations: operations.rows.map((row) => ({ name: `operations/${row.operation_id}` })),
          effects: erasedEffects.rows.flatMap((row) => {
            const data = row.data as { postId?: string };
            return data.postId && targetIds.has(data.postId)
              ? [{ id: `${row.position}:${row.event_seq}`, postId: data.postId }]
              : [];
          }),
          receipts: receipts.rows.map((row) => row.response),
          outbox: outbox.rows.map((row) => ({ type: row.type, subject: row.subject, data: row.data })),
        };
        inspectionCache.set(fixture.thread, { token, value });
        return value;
      },
      async trace(): Promise<Trace> {
        const rows = await readPool.query<{ command_kind: string; partition_no: number; idempotency_key: string }>(
          `SELECT command_kind,partition_no,idempotency_key FROM core.receipt
         WHERE command_kind IN ('content.author-erasure','content.author-erasure.page','content.author-erasure.cleanup',
           'content.post:erase','content.moderation:takedown') ORDER BY partition_no,idempotency_key`,
        );
        const commands = rows.rows
          .filter((row) => !receiptBaselines.get(row.partition_no)?.has(row.idempotency_key))
          .filter((row) => receiptBaselines.has(row.partition_no))
          .map((row) => {
            const execution = commandQueries.find((item) => row.idempotency_key === item.key);
            const threadScanRows =
              execution?.statements.filter(
                (statement) =>
                  /\b(?:FROM|UPDATE|DELETE\s+FROM)\s+content\.post\b/i.test(statement) &&
                  /\bthread_id\b/i.test(statement) &&
                  !/\bpost_id\b/i.test(statement),
              ).length ?? 0;
            return { writePartitions: [row.partition_no], threadScanRows };
          });
        const groups = new Map<string, NativeCheck[]>();
        for (const check of checks.filter((entry) => entry.step.includes(':erase:'))) {
          const key = `${check.workflowId}\n${check.step}`;
          const group = groups.get(key) ?? [];
          group.push(check);
          groups.set(key, group);
        }
        const steps = [...groups.values()].map((group) => {
          // Initiator restoration repeats post:erase on the page's first post inside this step.
          // The logical page is one current-formula check per post.
          const byPost = new Map<string, NativeCheck>();
          for (const entry of group) byPost.set(entry.postId, entry);
          const page = [...byPost.values()];
          const first = page[0]!;
          return {
            postIds: page.map((entry) => entry.postId),
            at: first.at,
            checks: page.map((entry) => ({
              postId: entry.postId,
              action: entry.action,
              partition: entry.partition,
              at: entry.at,
              allowed: entry.allowed,
            })),
          };
        });
        return { commands, steps };
      },
      async search(query) {
        const data = [...fixtureData.values()].at(-1);
        if (!data) throw new Error('No native fixture has been seeded');
        const response = await request(
          resources,
          'anonymous',
          'GET',
          `/v1/boards/${data.board}/threads?query=${encodeURIComponent(query)}&limit=100`,
        );
        if (!response.ok) throw new Error(`Native board search failed (${response.status})`);
        const value = (await response.json()) as { threads: { id: string }[] };
        return value.threads.map((thread) => thread.id);
      },
      async checkGrowth(input): Promise<GrowthResult[]> {
        const { capture, costOf } = await import('../support/growth.ts');
        // A second instrumented connection set separates the status capture from
        // initiation's enclosing checkGrowth capture on the same native database.
        const statusGrowth = (ownedStatusGrowth = await openGrowthDatabase(resources.appUrl));
        statusGrowth.pool.options.max = 1;
        statusGrowth.pool.options.idleTimeoutMillis = 0;
        const statusClient = (ownedStatusClient = await createWorkClient(resources.appUrl, statusGrowth.pool));
        const statusKernel = createKernel({
          ...kernelOptions,
          pool: statusGrowth.pool,
          content: {
            cursorNow: () => Date.now(),
            workflows: createContentOperationClient({
              pool: statusGrowth.pool,
              client: statusClient,
              clock: () => new Date(),
            }),
          },
          workClient: statusClient,
        });
        return checkGrowthActual(this, {
          growth,
          statusGrowth,
          worker: worker!,
          seedFixture,
          getStoredFixture(fixture) {
            const data = fixtureData.get(fixture.thread);
            if (!data) throw new Error('Native growth fixture identity is unknown');
            return data;
          },
          actor: system.actors.author.actor,
          useMeasuredKernel,
          async measureStatus(name) {
            const measured = await capture(statusGrowth, async () => {
              resources.kernel = statusKernel;
              try {
                const reply = await driver.status('author', name);
                if (reply.response.status !== 200 || !reply.value)
                  throw new Error(`Native erasure status returned ${reply.response.status}`);
              } finally {
                resources.kernel = driverKernel;
              }
            });
            return costOf(measured.capture);
          },
          waitForOperationBarrier,
          releaseFinalPage: (name) => releaseLogicalPage(name, false),
          input,
        });
      },
    };

    async function drainEffects(partition: number): Promise<void> {
      const deadline = Date.now() + 30_000;
      while (!closing && Date.now() < deadline) {
        const result = await readPool.query<{ position: string; checkpoint: string | null }>(
          `SELECT p.position::text, c.position::text AS checkpoint
         FROM core.partition p LEFT JOIN core.consumer_checkpoint c
           ON c.partition_no=p.partition_no AND c.consumer='effects'
         WHERE p.partition_no=$1`,
          [partition],
        );
        const head = BigInt(result.rows[0]?.position ?? 0);
        const checkpoint = BigInt(result.rows[0]?.checkpoint ?? 0);
        if (checkpoint >= head) return;
        await new Promise((resolve) => setTimeout(resolve, 15));
      }
      throw new Error(`Native effects relay did not reach partition ${partition}; worker=${worker!.diagnostics()}`);
    }

    async function waitBodiesNull(f: StoredFixture): Promise<void> {
      const ids = f.targeted.map((post) => post.id);
      const deadline = Date.now() + 30_000;
      while (!closing && Date.now() < deadline) {
        const result = await readPool.query<{ remaining: number }>(
          `SELECT count(*)::integer AS remaining FROM content.revision r
         JOIN content.post p USING(route,thread_id,post_id)
         WHERE r.route=$1 AND r.post_id=ANY($2::uuid[]) AND r.body IS NOT NULL AND p.availability='erased'`,
          [routeOf(f.thread), ids],
        );
        if (result.rows[0]?.remaining === 0) return;
        await new Promise((resolve) => setTimeout(resolve, 15));
      }
      throw new Error('Native erasure workflow did not finish physical revision cleanup');
    }

    async function waitPostCleanup(f: StoredFixture, postIds: string[]): Promise<void> {
      const deadline = Date.now() + 30_000;
      let events: { id: string; post_id: string }[] = [];
      while (!closing && Date.now() < deadline) {
        const result = await readPool.query<{ id: string; post_id: string }>(
          `SELECT id::text, data->>'postId' AS post_id FROM core.outbox
           WHERE partition_no=$1 AND type='com.rezics.content.post.erased.v1'
             AND data->>'postId'=ANY($2::text[])
           ORDER BY position,event_seq`,
          [f.partition, postIds],
        );
        events = result.rows;
        if (new Set(events.map((event) => event.post_id)).size === postIds.length) break;
        await new Promise((resolve) => setTimeout(resolve, 15));
      }
      const found = new Set(events.map((event) => event.post_id));
      const missing = postIds.filter((postId) => !found.has(postId));
      if (missing.length > 0) throw new Error(`Erased-post cleanup events are missing for ${missing.length} posts`);
      for (let start = 0; start < events.length; start += 16) {
        await Promise.all(
          events
            .slice(start, start + 16)
            .map((event) => workClient.retrieveWorkflow(`content.erasePost:${event.id}`).getResult()),
        );
      }
    }

    // The hook has its own budget. Publish the corpus the scenarios ask for before
    // the test body starts.
    mark('stock-start');
    const [stockedFixture] = await Promise.all([
      seedFixture(205, 3, `erasure-${randomUUID().replaceAll('-', '')}`, undefined, false),
      resources.bootstrap,
    ]);
    preparedStock.push(stockedFixture);
    mark('stock-ready');
    readyAt = performance.now();
    return driver;
  } catch (error) {
    const cleanup: Promise<unknown>[] = [];
    if (worker) cleanup.push(worker.close());
    else if (pendingWorker) cleanup.push(pendingWorker.close());
    if (ownedObserver) cleanup.push(ownedObserver.close());
    if (ownedControlClient) cleanup.push(ownedControlClient.close());
    if (ownedMeasuredClient) cleanup.push(ownedMeasuredClient.close());
    if (ownedStatusClient) cleanup.push(ownedStatusClient.close());
    if (ownedWorkClient) cleanup.push(ownedWorkClient.close());
    if (ownedWorkPool) cleanup.push(ownedWorkPool.end());
    if (ownedAppPool) cleanup.push(ownedAppPool.end());
    if (ownedReadPool) cleanup.push(ownedReadPool.end());
    if (ownedGrowth) cleanup.push(ownedGrowth.close());
    if (ownedStatusGrowth) cleanup.push(ownedStatusGrowth.close());
    if (ownedResources) {
      ownedResources.stopBootstrap();
      cleanup.push(ownedResources.bootstrap.catch(() => undefined));
    }
    const results = await Promise.allSettled(cleanup);
    if (ownedResources) results.push(...(await Promise.allSettled([ownedResources.system.close()])));
    const failures = results.filter((result): result is PromiseRejectedResult => result.status === 'rejected');
    if (failures.length)
      throw new AggregateError(
        [error, ...failures.map((failure) => failure.reason)],
        'Native driver setup and cleanup failed',
      );
    throw error;
  }
}

async function checkGrowthActual(
  driver: ErasureOperationDriver,
  dependencies: {
    growth: GrowthDatabase;
    statusGrowth: GrowthDatabase;
    worker: NativeWorker;
    seedFixture(posts: number, revisions: number, marker: string, targetPartition?: number): Promise<Fixture>;
    getStoredFixture(fixture: Fixture): StoredFixture;
    actor: FixtureResources['system']['actors']['author']['actor'];
    useMeasuredKernel(active: boolean): Promise<void>;
    measureStatus(name: string): Promise<Cost>;
    waitForOperationBarrier(name: string, serial: number): Promise<void>;
    releaseFinalPage(name: string): Promise<string[]>;
    input: {
      seed: number;
      scales: [32, 256, 2048];
      measurements: ['initiation', 'status', 'native-step'];
    };
  },
): Promise<GrowthResult[]> {
  const { assertGrowth, checkGrowth, seed } = await import('../support/growth.ts');
  const { growth, statusGrowth, worker, input } = dependencies;
  const fixtures = new Map<number, { measured: Fixture; warmup: Fixture }>();
  const changedFixtures = new Map<number, Fixture>();
  const changedSamples: GrowthSample[] = [];
  const statusSamples: GrowthSample[] = [];
  const nativeSamples: GrowthSample[] = [];
  let targetPartition: number | undefined;
  let targetBytes: string | undefined;
  await worker.restart(true);
  for (const scale of input.scales) {
    const marker = `erasure-growth-${input.seed}-${String(scale).padStart(4, '0')}-${randomUUID().replaceAll('-', '')}`;
    const fixture = await dependencies.seedFixture(101, 1, marker, targetPartition);
    targetPartition ??= fixture.partition;
    if (fixture.partition !== targetPartition) throw new Error('Native growth fixtures did not share one partition');
    if (fixture.targeted.length !== 101)
      throw new Error('Native growth fixture does not contain its fixed 101-post neighbourhood');
    const bytes = await growth.admin.query<{ bytes: string }>(
      `SELECT sum(octet_length(body))::text AS bytes FROM content.revision
       WHERE route=$1 AND post_id=ANY($2::uuid[])`,
      [routeOf(fixture.thread)!, fixture.targeted.map((post) => post.id)],
    );
    const actualBytes = bytes.rows[0]?.bytes;
    if (!actualBytes || (targetBytes !== undefined && actualBytes !== targetBytes))
      throw new Error('Native growth targets do not retain a fixed canonical byte count');
    targetBytes = actualBytes;
    const warmup = await dependencies.seedFixture(
      101,
      1,
      marker.replace('erasure-growth', 'erasure-warmup'),
      targetPartition,
    );
    if (warmup.partition !== targetPartition || warmup.targeted.length !== 101)
      throw new Error('Native growth warmup does not match the fixed neighbourhood');
    fixtures.set(scale, { measured: fixture, warmup });
  }
  // Catalogue growth keeps the logical page fixed at 100 posts. Independently
  // vary the changed rows against one catalogue to prove work follows the page.
  for (const posts of [1, 8, 64]) {
    const fixture = await dependencies.seedFixture(
      posts,
      1,
      `erasure-changed-${posts}-${randomUUID().replaceAll('-', '')}`,
      targetPartition,
    );
    if (fixture.partition !== targetPartition || fixture.targeted.length !== posts)
      throw new Error('Native changed-row fixture does not match its logical page');
    changedFixtures.set(posts, fixture);
  }
  const firstFixture = fixtures.get(input.scales[0])!.measured;
  const population = erasureGrowthPopulation(
    input.seed,
    dependencies.getStoredFixture(firstFixture),
    dependencies.actor,
  );
  const populatedRelations = Object.keys(
    population.rows!({
      ordinal: 0,
      route: routeOf(firstFixture.thread)!,
      partition: firstFixture.partition,
      hot: true,
    }),
  );
  let seedCalls = 0;
  const bounds = { rows: 'constant' as const, statements: 'constant' as const, blocks: 'logarithmic' as const };
  // All three measurements observe each scale before the next seed grows the
  // database. Status must not label three reads of the largest population as
  // measurements of three different populations.
  await dependencies.useMeasuredKernel(true);
  await dependencies.useMeasuredKernel(false);
  let scaleAtCapture: number | undefined;
  const nativePlans: { scale: number; query: string; blocks: number; nodes: unknown[] }[] = [];
  const listeners = new Map<PoolClient, (notice: { message?: string | undefined }) => void>();
  const observePlans = (client: PoolClient) => {
    if (listeners.has(client)) return;
    const onNotice = (notice: { message?: string | undefined }) => {
      if (scaleAtCapture === undefined || !notice.message?.includes('plan:\n')) return;
      const document = JSON.parse(notice.message.split('plan:\n')[1]!) as {
        'Query Text': string;
        Plan: Record<string, any>;
      };
      const root = document.Plan;
      if (!root) return;
      const blocks = (root['Shared Hit Blocks'] ?? 0) + (root['Shared Read Blocks'] ?? 0);
      if (blocks < 32) return;
      const nodes: unknown[] = [];
      const visit = (node: Record<string, any>) => {
        if (node['Relation Name'])
          nodes.push({
            type: node['Node Type'],
            relation: `${node.Schema}.${node['Relation Name']}`,
            index: node['Index Name'],
            rows: node['Actual Rows'],
            loops: node['Actual Loops'],
            blocks: (node['Shared Hit Blocks'] ?? 0) + (node['Shared Read Blocks'] ?? 0),
            condition: node['Index Cond'],
          });
        for (const child of node.Plans ?? []) visit(child);
      };
      visit(root);
      nativePlans.push({ scale: scaleAtCapture, query: document['Query Text'], blocks, nodes });
    };
    client.on('notice', onNotice);
    listeners.set(client, onNotice);
  };
  growth.pool.on('acquire', observePlans);
  statusGrowth.pool.on('acquire', observePlans);
  const initiation = await checkGrowth(growth, {
    name: 'native author erasure initiation',
    scales: input.scales,
    repetitions: 1,
    warmups: 1,
    bounds,
    async grow(database, scale, previous) {
      await seed(database, population, { from: previous, to: scale });
      seedCalls++;
      if (previous === 0) {
        for (const relation of populatedRelations) {
          const count = await database.admin.query<{ count: number }>(`SELECT count(*)::int AS count FROM ${relation}`);
          if ((count.rows[0]?.count ?? 0) < 500)
            throw new Error(`Native growth relation ${relation} has fewer than 500 rows at its smallest scale`);
        }
      }
    },
    async warmup(_database, scale) {
      const fixture = fixtures.get(scale)!.warmup;
      await dependencies.useMeasuredKernel(true);
      try {
        // Warm the actual write/status paths on spare state, as checkGrowth's
        // normal warmup does. Every workflow still completes its native cleanup.
        await worker.hold();
        const reply = await driver.erase('author', fixture.thread, fixture.authorId, randomUUID());
        if (reply.response.status !== 202 || !reply.value)
          throw new Error(`Native erasure warmup returned ${reply.response.status}`);
        await driver.finish(reply.value.name);
        await dependencies.measureStatus(reply.value.name);
      } finally {
        await dependencies.useMeasuredKernel(false);
      }
    },
    async operation(_database, scale) {
      scaleAtCapture = scale;
      await dependencies.useMeasuredKernel(true);
      try {
        const fixture = fixtures.get(scale)?.measured;
        if (!fixture) throw new Error(`Missing fixed native growth fixture at scale ${scale}`);
        // The governance queue runs two workflows. Complete each real operation
        // before parking the next scale; retain its actual first-page capture.
        await worker.hold();
        const reply = await driver.erase('author', fixture.thread, fixture.authorId, randomUUID());
        if (reply.response.status !== 202 || !reply.value)
          throw new Error(`Native erasure initiation returned ${reply.response.status}`);
        await dependencies.waitForOperationBarrier(reply.value.name, 1);
        await worker.captureNextStep();
        const [measured] = await Promise.all([worker.waitCost(), driver.step(reply.value.name)]);
        if (measured.serial !== 1)
          throw new Error('Native growth step did not capture the first persisted logical batch');
        nativeSamples.push({ scale, cost: measured.cost });
        await driver.finish(reply.value.name);
        statusSamples.push({ scale, cost: await dependencies.measureStatus(reply.value.name) });
      } finally {
        scaleAtCapture = undefined;
        await dependencies.useMeasuredKernel(false);
      }
    },
  })
    .catch((error: unknown) => {
      console.error('erasure-growth-native-plans', JSON.stringify(nativePlans));
      console.error('erasure-growth-status-samples', JSON.stringify(statusSamples));
      console.error('erasure-growth-step-samples', JSON.stringify(nativeSamples));
      if (error && typeof error === 'object' && 'samples' in error)
        console.error('erasure-growth-initiation-samples', JSON.stringify(error.samples));
      throw error;
    })
    .finally(() => {
      growth.pool.off('acquire', observePlans);
      statusGrowth.pool.off('acquire', observePlans);
      for (const [client, listener] of listeners) client.off('notice', listener);
    });
  if (seedCalls !== 3) throw new Error(`Native growth seeded ${seedCalls} times instead of once at each scale`);
  try {
    assertGrowth(statusSamples, bounds);
    assertGrowth(nativeSamples, bounds);
    for (const samples of [initiation.samples, statusSamples, nativeSamples]) {
      for (const { scale, cost } of samples) {
        for (const [relation, actual] of Object.entries(cost.relations ?? {})) {
          if (relation.startsWith('content.') && (actual.sequentialScans ?? 0) > 0)
            throw new Error(`Native erasure scanned ${relation} sequentially at scale ${scale}`);
        }
      }
    }
    for (const [posts, fixture] of changedFixtures) {
      await worker.hold();
      const reply = await driver.erase('author', fixture.thread, fixture.authorId, randomUUID());
      if (reply.response.status !== 202 || !reply.value)
        throw new Error(`Native changed-row erasure returned ${reply.response.status}`);
      await dependencies.waitForOperationBarrier(reply.value.name, 1);
      await worker.captureNextStep();
      const [measured, changed] = await Promise.all([
        worker.waitCost(),
        dependencies.releaseFinalPage(reply.value.name),
      ]);
      if (measured.serial !== 1 || changed.length !== posts)
        throw new Error('Native changed-row capture did not cover its complete logical page');
      changedSamples.push({ scale: posts, cost: measured.cost });
      await driver.finish(reply.value.name);
    }
    assertGrowth(changedSamples, { rows: 'linear', statements: 'linear', blocks: 'linear' });
    console.log('erasure-growth-changed-samples', JSON.stringify(changedSamples));
  } catch (error) {
    console.error('erasure-growth-native-plans', JSON.stringify(nativePlans));
    console.error('erasure-growth-status-samples', JSON.stringify(statusSamples));
    console.error('erasure-growth-step-samples', JSON.stringify(nativeSamples));
    console.error('erasure-growth-changed-samples', JSON.stringify(changedSamples));
    throw error;
  }
  const samplesByMeasurement = {
    initiation: initiation.samples,
    status: statusSamples,
    'native-step': nativeSamples,
  };
  const results: GrowthResult[] = input.measurements.map((measurement) => ({
    measurement,
    scales: [...input.scales],
    seedCalls,
    rows: 'constant',
    statements: 'constant',
    buffers: 'logarithmic',
    passed: true,
    samples: samplesByMeasurement[measurement].map(({ scale, cost }) => ({
      scale,
      rows: cost.rows,
      statements: cost.statements,
      buffers: cost.blocks,
    })),
  }));
  console.log('erasure-growth-samples', JSON.stringify(results));
  return results;
}

if (import.meta.main && process.env.ERASURE_OPERATION_WORKER === '1') {
  try {
    await runOperationWorkerProcess();
  } catch (error) {
    console.error(error);
    const detail = error instanceof Error ? (error.stack ?? error.message) : String(error);
    process.stdout.write(`ERASURE_WORKER_FAILED ${detail.replaceAll('\n', ' | ')}\n`);
    process.exitCode = 1;
  }
}
