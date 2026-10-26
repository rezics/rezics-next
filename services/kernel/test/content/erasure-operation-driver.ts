import { DBOS } from '@dbos-inc/dbos-sdk';
import { createCurrentConsentReader } from '@rezics/auth/current-consent';
import { fromPlainText } from '@rezics/document';
import { createHash, randomUUID } from 'node:crypto';
import { createInterface } from 'node:readline';
import { Pool } from 'pg';
import { createWriteRateLimiter } from '../../src/access/write-rate.ts';
import { createContentOperationClient, createContentWork } from '../../src/content/work.ts';
import { createContentWorkAccess } from '../../src/content/register.ts';
import { contentEffects } from '../../src/content/relays.ts';
import { R2Storage } from '../../src/content/r2-storage.ts';
import type {
  ErasureOperationDriver,
  Fixture,
  GrowthResult,
  Operation,
  Persona,
  Reply,
  Trace,
} from '../../../../specs/erasure-operation-driver.ts';
import { authoritativeTimeValue } from '../../src/command/command.ts';
import { effectsRelay } from '../../src/events/effects.ts';
import { startRelays } from '../../src/events/relays.ts';
import { createKernel } from '../../src/http/kernel.ts';
import { linkProjection } from '../../src/semantic/links.ts';
import { createWorkClient, type WorkClient } from '../../src/work/client.ts';
import { startWorker } from '../../src/worker.ts';
import { composeWork, type WorkModule } from '../../src/work/registry.ts';
import { newId, partitionOf, routeOf } from '../../src/route/route.ts';
import {
  assertGrowth,
  capture as captureGrowth,
  checkGrowth,
  costOf,
  openGrowthDatabase,
  seed,
  type Cost,
  type GrowthDatabase,
  type GrowthReport,
  type GrowthSample,
  type Population,
} from '../support/growth.ts';
import {
  buildBoardAndThreads,
  createFixtureResources,
  grant,
  request,
  revokeGrant,
  setupRequest,
  type FixtureResources,
} from './support/erasure-operation-fixtures.ts';
import { observeSql, type SqlObserver } from './support/sql-observer.ts';

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
type StoredFixture = ReturnType<typeof buildBoardAndThreads> extends Promise<infer T> ? T : never;
type NativeWorkerCost = { serial: number; cost: Cost };
type WorkerProcess = ReturnType<typeof Bun.spawn> & {
  stdin: Bun.FileSink;
  stdout: ReadableStream<Uint8Array>;
  stderr: ReadableStream<Uint8Array>;
};

const TEST_BARRIER_TOPIC = 'erasure-operation-test-continue';
const BARRIER_STATE = 'erasure-operation-test-barrier-state';

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
        const thread = newId(route);
        const post = newId(route);
        const revision = newId(route);
        const media = newId(route);
        const operation = newId(route);
        const body = Buffer.alloc(256, ordinal % 251);
        return { account, thread, post, revision, media, operation, body };
      });
      const hash = (body: Buffer) => createHash('sha256').update(body).digest();
      return {
        'access.account': entries.map(({ account }) => ({
          route: routeOf(account)!,
          account_id: account,
          kind: 'actor',
          state: 'active',
          transaction_id: account,
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
        })),
      };
    },
  };
}

function combineCost(left: GrowthSample['cost'], right: Cost): GrowthSample['cost'] {
  const relations: Record<string, { rows: number; blocks: number; sequentialScans?: number }> = {
    ...left.relations,
  };
  for (const [name, value] of Object.entries(right.relations)) {
    const previous = relations[name];
    relations[name] = previous
      ? {
          rows: previous.rows + value.rows,
          blocks: previous.blocks + value.blocks,
          sequentialScans: (previous.sequentialScans ?? 0) + value.sequentialScans,
        }
      : { rows: value.rows, blocks: value.blocks, sequentialScans: value.sequentialScans };
  }
  return {
    rows: left.rows + right.rows,
    blocks: left.blocks + right.blocks,
    statements: left.statements + right.statements,
    relations,
  };
}

async function runOperationWorkerProcess(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL;
  const authDatabaseUrl = process.env.ERASURE_AUTH_DATABASE_URL;
  const routeKey = Buffer.from(process.env.ERASURE_ROUTE_KEY ?? '', 'base64url');
  if (!databaseUrl || !authDatabaseUrl || routeKey.length !== 32)
    throw new Error('Native erasure worker configuration is incomplete');
  const authPool = new Pool({ connectionString: authDatabaseUrl, max: 4 });
  const { readCurrentConsent } = createCurrentConsentReader({ database: authPool });
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

  let barrierMode: 'run' | 'hold' = process.env.ERASURE_OPERATION_INITIAL_MODE === 'hold' ? 'hold' : 'run';
  const originalRegisterStep = DBOS.registerStep.bind(DBOS);
  DBOS.registerStep = ((func: (...args: any[]) => any, configuration: { name?: string; [key: string]: unknown }) => {
    if (configuration.name !== 'content.authorErase.step') return originalRegisterStep(func, configuration as never);
    const wrapped = async (name: string, action: () => Promise<unknown>) => {
      const match = /^wf:([^:]+):erase:/.exec(name);
      const workflowId = DBOS.workflowID;
      if (!match || !workflowId) return func(name, action);
      const previous = await DBOS.getEvent<StepEvent>(workflowId, BARRIER_STATE, 0);
      const serial = previous?.name === name ? previous.serial : (previous?.serial ?? 0) + 1;
      const event = { serial, name } satisfies StepEvent;
      await DBOS.setEvent(BARRIER_STATE, event);
      if (barrierMode === 'hold') {
        await DBOS.setEvent(`erasure-operation-test-barrier:${serial}`, event);
        const resumed = await DBOS.recv<{ serial: number }>(TEST_BARRIER_TOPIC, 300);
        if (!resumed || resumed.serial !== serial)
          throw new Error('Native erasure barrier received an invalid continuation');
      }
      const current = { step: name, serial, checks: [] as NativeCheck[] };
      active.set(workflowId, current);
      try {
        if (captureNextStep && growth) {
          captureNextStep = false;
          const measured = await captureGrowth(growth, () => func(name, action));
          const cost = costOf(measured.capture);
          process.stdout.write(`ERASURE_WORKER_COST ${JSON.stringify({ serial, cost })}\n`);
          return measured.value;
        }
        return await func(name, action);
      } finally {
        await DBOS.setEvent(`erasure-operation-test-checks:${serial}`, current.checks);
        active.delete(workflowId);
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
    readConsent: readCurrentConsent,
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
  const growthMode = process.env.ERASURE_GROWTH_MODE === '1';
  let growth: GrowthDatabase | undefined;
  let growthSystemPool: Pool | undefined;
  let workerClient: WorkClient | undefined;
  let work: Awaited<ReturnType<typeof composeWork>> | undefined;
  let relays: ReturnType<typeof startRelays> | undefined;
  let worker: { stop(): Promise<void> } | undefined;
  let captureNextStep = false;
  try {
    if (growthMode) {
      growth = await openGrowthDatabase(databaseUrl);
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
        executorId: `erasure-${randomUUID()}`,
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
      worker = await startWorker({ databaseUrl, executorId: `erasure-${randomUUID()}`, poolSize: 12 }, [module]);
    }
  } finally {
    DBOS.registerStep = originalRegisterStep as typeof DBOS.registerStep;
  }
  process.stdout.write('ERASURE_WORKER_READY\n');
  const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
  for await (const line of input) {
    if (line === 'hold' || line === 'run') {
      barrierMode = line;
      process.stdout.write(`ERASURE_WORKER_CONTROL ${line}\n`);
    } else if (line === 'capture-step' && growthMode) {
      captureNextStep = true;
      process.stdout.write('ERASURE_WORKER_CONTROL capture-step\n');
    } else if (line === 'stop') {
      await worker!.stop();
      await authPool.end();
      process.stdout.write('ERASURE_WORKER_STOPPED\n');
      return;
    }
  }
  await worker!.stop();
  await authPool.end();
}

type NativeWorker = Awaited<ReturnType<typeof nativeWorker>>;
async function nativeWorker(resources: FixtureResources, client: WorkClient) {
  let child: WorkerProcess | undefined;
  let held = false;
  let closing: Promise<void> | undefined;
  let output = '';
  let stderr = '';
  let pending = '';
  const lines: string[] = [];
  const waiters: { startsWith: string; resolve(value: string): void; reject(error: Error): void }[] = [];
  let stdoutTask: Promise<void> | undefined;
  let stderrTask: Promise<void> | undefined;

  function acceptLine(line: string): void {
    output += `${line}\n`;
    for (let index = 0; index < waiters.length; index++) {
      const waiter = waiters[index]!;
      if (line.startsWith(waiter.startsWith)) {
        waiters.splice(index, 1);
        waiter.resolve(line);
        return;
      }
    }
    lines.push(line);
  }

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
          new Error(`Timed out waiting for native worker output ${startsWith}; stdout=${output}; stderr=${stderr}`),
        );
      }, timeoutMs);
      const originalResolve = waiter.resolve;
      waiter.resolve = (value) => {
        clearTimeout(timer);
        originalResolve(value);
      };
    });
  }

  async function start(growthMode = false): Promise<void> {
    const authUrl = resources.system.database.authPool.options.connectionString;
    if (!authUrl) throw new Error('Native Auth database has no connection URL');
    child = Bun.spawn([process.execPath, import.meta.path], {
      stdin: 'pipe',
      stdout: 'pipe',
      stderr: 'pipe',
      env: {
        ...process.env,
        DATABASE_URL: resources.appUrl,
        ERASURE_AUTH_DATABASE_URL: authUrl,
        ERASURE_ROUTE_KEY: Buffer.from(resources.system.routeKey).toString('base64url'),
        ERASURE_OPERATION_WORKER: '1',
        ERASURE_OPERATION_INITIAL_MODE: held ? 'hold' : 'run',
        ERASURE_GROWTH_MODE: growthMode ? '1' : '0',
      },
    }) as WorkerProcess;
    const launched = child;
    stdoutTask = (async () => {
      const reader = launched.stdout.getReader();
      const decoder = new TextDecoder();
      for (;;) {
        const result = await reader.read();
        if (result.done) break;
        pending += decoder.decode(result.value, { stream: true });
        const split = pending.split('\n');
        pending = split.pop() ?? '';
        for (const line of split) acceptLine(line.replace(/\r$/, ''));
      }
    })();
    stderrTask = (async () => {
      const reader = launched.stderr.getReader();
      const decoder = new TextDecoder();
      for (;;) {
        const result = await reader.read();
        if (result.done) break;
        stderr += decoder.decode(result.value, { stream: true });
      }
    })();
    try {
      await waitForLine('ERASURE_WORKER_READY');
    } catch (error) {
      await kill();
      throw error;
    }
  }

  async function sendControl(value: 'hold' | 'run'): Promise<void> {
    if (!child) throw new Error('Native worker is not running');
    child.stdin.write(`${value}\n`);
    await waitForLine(`ERASURE_WORKER_CONTROL ${value}`);
  }

  async function kill(): Promise<void> {
    const current = child;
    if (!current) return;
    child = undefined;
    try {
      current.kill('SIGKILL');
    } catch {
      // The worker can exit between the child check and the signal.
    }
    await current.exited;
    await Promise.allSettled([stdoutTask, stderrTask]);
  }

  async function stop(): Promise<void> {
    const current = child;
    if (!current) return;
    current.stdin.write('stop\n');
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
      }
    } catch {
      await kill();
    }
  }

  await start();
  return {
    async restart(growthMode = false) {
      await stop();
      await start(growthMode);
    },
    async close() {
      return (closing ??= (async () => {
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
      return `${output}\n${stderr}`.slice(-4_000);
    },
    async send(workflowId: string, serial: number) {
      await client.send(workflowId, { serial }, TEST_BARRIER_TOPIC, `erasure-operation-${workflowId}-${serial}`);
    },
    async waitBarrier(workflowId: string, serial: number) {
      const event = await client.getEvent<StepEvent>(workflowId, `erasure-operation-test-barrier:${serial}`, 60);
      if (!event || event.serial !== serial) throw new Error(`Native erasure step ${serial} did not reach its barrier`);
      return event;
    },
    async waitChecks(workflowId: string, serial: number) {
      const checks = await client.getEvent<NativeCheck[]>(workflowId, `erasure-operation-test-checks:${serial}`, 60);
      if (!checks) throw new Error(`Native erasure step ${serial} did not persist actual Access checks`);
      return checks;
    },
    async waitState(workflowId: string) {
      return client.getEvent<StepEvent>(workflowId, BARRIER_STATE, 60);
    },
    async waitResult(workflowId: string) {
      try {
        await client.retrieveWorkflow(workflowId).getResult();
      } catch {
        // A terminal PERMISSION_DENIED is expected in the revocation scenario.
      }
    },
  };
}

export async function createErasureOperationDriver(): Promise<ErasureOperationDriver> {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error('DATABASE_URL must name a migrated kernel database');
  let ownedResources: FixtureResources | undefined;
  let ownedGrowth: GrowthDatabase | undefined;
  let ownedReadPool: Pool | undefined;
  let ownedWorkClient: WorkClient | undefined;
  let ownedObserver: SqlObserver | undefined;
  let worker: NativeWorker | undefined;
  try {
    const resources = (ownedResources = await createFixtureResources(databaseUrl));
    const growth = (ownedGrowth = await openGrowthDatabase(resources.appUrl));
    resources.pool = growth.pool;
    const readPool = (ownedReadPool = new Pool({ connectionString: resources.appUrl, max: 4 }));
    const workClient = (ownedWorkClient = await createWorkClient(resources.appUrl, growth.pool));
    const workflows = createContentOperationClient({
      pool: resources.pool,
      client: workClient,
      clock: () => new Date(),
    });
    const observer: SqlObserver = (ownedObserver = observeSql(resources.pool));
    const checks: NativeCheck[] = [];
    const fixtureData = new Map<string, StoredFixture>();
    const serialByOperation = new Map<string, number>();
    const workflowByOperation = new Map<string, string>();
    const observedCheckEvents = new Set<string>();
    const bearerHistory = new Map<Persona, string>();
    const ownerValidity = new Map<string, string>();
    const accountReadValidity = new Map<string, string[]>();
    const receiptBaselines = new Map<number, Set<string>>();
    const commandQueries: { key: string; statements: string[] }[] = [];
    const system = resources.system;
    worker = await nativeWorker(resources, workClient);
    const driverKernel = createKernel({
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
    });
    Object.assign(resources, { kernel: driverKernel });

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
      while (Date.now() < deadline) {
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
        throw new Error(
          `Committed operation has not been bound to native DBOS; relay=${JSON.stringify(relayState.rows[0] ?? null)}; worker=${worker!.diagnostics()}`,
        );
      }
      workflowByOperation.set(id, workflowId);
      return workflowId;
    }

    async function waitForOperationBarrier(name: string, serial: number): Promise<void> {
      await worker!.waitBarrier(await workflowIdFor(name), serial);
    }

    async function waitForCheckpoint(workflowId: string, serial: number): Promise<StepEvent> {
      return worker!.waitBarrier(workflowId, serial);
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
            await revokeGrant(resources, 'governance', {
              resource: { route, id: accountId },
              subject: { kind: 'account', id: accountId },
              actions: ['account:read'],
              valid,
            });
        } else {
          await grant(resources, 'governance', {
            resource: { route, id: accountId },
            subject: { kind: 'account', id: accountId },
            actions: ['account:read'],
          });
        }
        return;
      }
      if (axis === 'post:erase') {
        const f = [...fixtureData.values()].at(-1);
        if (!f) throw new Error('No native author-erasure fixture is available');
        const route = routeOf(f.thread)!;
        for (const post of f.targeted) {
          if (operation === 'revoke') {
            const valid = ownerValidity.get(post.id);
            if (!valid) throw new Error(`Missing native owner grant for ${post.id}`);
            await setupRequest(
              resources,
              'governance',
              'POST',
              '/v1/roleGrants:revoke',
              {
                resource: { route, id: post.id },
                subject: { kind: 'account', id: accountId },
                role: 'content.post.owner',
                valid,
              },
              200,
            );
          } else {
            await grant(resources, 'governance', {
              resource: { route, id: post.id },
              subject: { kind: 'account', id: accountId },
              actions: ['post:erase'],
            });
          }
        }
        return;
      }
      throw new Error(`Unsupported author authority axis: ${axis}`);
    }

    async function seedFixture(
      posts: number,
      revisions: number,
      marker: string,
      targetPartition?: number,
    ): Promise<Fixture> {
      const data = await buildBoardAndThreads(resources, posts, revisions, marker, targetPartition);
      const fixture: Fixture = {
        thread: data.thread,
        partition: data.partition,
        authorId: data.authorId,
        marker,
        targeted: data.targeted,
      };
      fixtureData.set(fixture.thread, data);
      await Promise.all(
        data.targeted.map(async (post) => {
          const row = await readPool.query<{ valid: string }>(
            `SELECT valid::text FROM access.resource_role_grant
           WHERE route=$1 AND resource_id=$2 AND subject_kind='identity' AND subject_id=$3
             AND subject_role='' AND grant_role='content.post.owner'`,
            [data.route, post.id, data.authorId],
          );
          const valid = row.rows[0]?.valid;
          if (!valid) throw new Error(`Published target ${post.id} has no native owner grant`);
          ownerValidity.set(post.id, valid);
        }),
      );
      const direct = await readPool.query<{ valid: string }>(
        `SELECT valid::text FROM access.resource_grant
         WHERE route=$1 AND resource_id=$2 AND subject_kind='identity' AND subject_id=$3
           AND subject_role='' AND action='account:read'`,
        [routeOf(data.authorId)!, data.authorId, data.authorId],
      );
      if (direct.rows.length === 0) {
        await setupRequest(resources, 'author', 'POST', '/v1/grants', {
          resource: { route: routeOf(data.authorId)!, id: data.authorId },
          subject: { kind: 'account', id: data.authorId },
          actions: ['account:read'],
          valid: '(,)',
        });
        direct.rows.push({ valid: '(,)' });
      }
      accountReadValidity.set(
        data.authorId,
        direct.rows.map((row) => row.valid),
      );
      await request(
        resources,
        'anonymous',
        'GET',
        `/v1/boards/${data.board}/threads?query=${encodeURIComponent(marker)}`,
      );
      await drainEffects(data.partition);
      const baseline = await readPool.query<{ idempotency_key: string }>(
        'SELECT idempotency_key FROM core.receipt WHERE partition_no=$1',
        [data.partition],
      );
      receiptBaselines.set(data.partition, new Set(baseline.rows.map((row) => row.idempotency_key)));
      return fixture;
    }

    const driver: ErasureOperationDriver = {
      async close() {
        const failures: unknown[] = [];
        for (const close of [
          () => worker!.close(),
          () => observer.close(),
          () => workClient.close(),
          () => readPool.end(),
          () => growth.close(),
          () => system.close(),
        ]) {
          try {
            await close();
          } catch (error) {
            failures.push(error);
          }
        }
        if (failures.length) throw new AggregateError(failures, 'Native erasure operation fixture cleanup failed');
      },
      async seed(input): Promise<Fixture> {
        const marker = `erasure-${randomUUID().replaceAll('-', '')}`;
        return seedFixture(input.posts, input.revisions, marker);
      },
      async erase(actor, thread, authorId, key) {
        const mark = observer.records.length;
        const response = await request(resources, actor, 'POST', `/v1/threads/${thread}:erase`, { authorId }, key);
        commandQueries.push({ key, statements: observer.records.slice(mark).map((entry) => entry.statement) });
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
        const mark = observer.records.length;
        const result = await jsonReply(
          await request(resources, actor, 'POST', `/v1/posts/${postId}:erase`, { reason: 'Point erase' }, key),
        );
        commandQueries.push({ key, statements: observer.records.slice(mark).map((entry) => entry.statement) });
        const data = [...fixtureData.values()].find((fixture) => fixture.targeted.some((post) => post.id === postId));
        if (result.response.ok && data) {
          await drainEffects(data.partition);
          await waitPostCleanup(data, [postId]);
          await waitBodiesNull(data);
        }
        return result;
      },
      async takedown(actor, postId, key) {
        const mark = observer.records.length;
        const result = await jsonReply(
          await request(resources, actor, 'POST', `/v1/posts/${postId}:takeDown`, { reason: 'Point takedown' }, key),
        );
        commandQueries.push({ key, statements: observer.records.slice(mark).map((entry) => entry.statement) });
        return result;
      },
      async barrier(next) {
        if (next !== 'hold') throw new RangeError('Unsupported native test barrier mode');
        await worker!.hold();
      },
      async step(name) {
        const id = operationId(name);
        const workflowId = await workflowIdFor(name);
        const serial = (serialByOperation.get(id) ?? 0) + 1;
        const event = await waitForCheckpoint(workflowId, serial);
        await worker!.send(workflowId, serial);
        await waitForCheckpoint(workflowId, serial + 1);
        serialByOperation.set(id, serial);
        const entries = await worker!.waitChecks(workflowId, serial);
        checks.push(...entries);
        observedCheckEvents.add(`${workflowId}:${serial}`);
        if (entries.some((entry) => entry.step !== event.name))
          throw new Error('Native Access trace does not match the barrier step');
        const ids = [...new Set(entries.map((entry) => entry.postId))];
        if (ids.length === 0) throw new Error('Native erasure page completed without real Access checks');
        return ids;
      },
      async finish(name) {
        const id = operationId(name);
        const workflowId = await workflowIdFor(name);
        await worker!.resume();
        const first = (serialByOperation.get(id) ?? 0) + 1;
        for (let serial = first; serial <= first + 5; serial++) await worker!.send(workflowId, serial);
        await worker!.waitResult(workflowId);
        const route = routeOf(id);
        if (route === null) throw new TypeError('Invalid operation route');
        const operationRow = await readPool.query<{ thread_id: string }>(
          'SELECT thread_id::text FROM content.operation WHERE route=$1 AND operation_id=$2',
          [route, id],
        );
        const f = fixtureData.get(operationRow.rows[0]?.thread_id ?? '');
        if (!f) throw new Error('Native operation has no matching content fixture');
        const last = await worker!.waitState(workflowId);
        for (let serial = 1; serial <= (last?.serial ?? 0); serial++) {
          const eventKey = `${workflowId}:${serial}`;
          if (observedCheckEvents.has(eventKey)) continue;
          checks.push(...(await worker!.waitChecks(workflowId, serial)));
          observedCheckEvents.add(eventKey);
        }
        await drainEffects(f.partition);
        await waitPostCleanup(
          f,
          f.targeted.map((post) => post.id),
        );
        await waitBodiesNull(f);
      },
      async restart() {
        await worker!.restart();
      },
      async authority(actor, axis, operation) {
        await mutateAuthority(actor, axis, operation);
      },
      async authorityTime() {
        const result = await readPool.query<{ at: string }>('SELECT clock_timestamp()::text AS at');
        return new Date(result.rows[0]!.at).toISOString();
      },
      async inspect(fixture) {
        const data = fixtureData.get(fixture.thread);
        if (!data) throw new Error('Inspection fixture identity is unknown');
        const mainRoute = data.route;
        const sentinelRoute = routeOf(data.sentinelPost)!;
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
        return {
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
      },
      async trace(): Promise<Trace> {
        const rows = await readPool.query<{ command_kind: string; partition_no: number; idempotency_key: string }>(
          `SELECT command_kind,partition_no,idempotency_key FROM core.receipt
         WHERE command_kind IN ('content.author-erasure','content.author-erasure.page','content.author-erasure.cleanup',
           'content.post.erase','content.post.takedown') ORDER BY partition_no,idempotency_key`,
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
          const first = group[0]!;
          return {
            postIds: group.map((entry) => entry.postId),
            at: first.at,
            checks: group.map((entry) => ({
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
        return checkGrowthActual(this, {
          growth,
          worker: worker!,
          seedFixture,
          getStoredFixture(fixture) {
            const data = fixtureData.get(fixture.thread);
            if (!data) throw new Error('Native growth fixture identity is unknown');
            return data;
          },
          actor: system.actors.author.actor,
          waitForOperationBarrier,
          input,
        });
      },
    };

    async function drainEffects(partition: number): Promise<void> {
      const deadline = Date.now() + 30_000;
      while (Date.now() < deadline) {
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
      while (Date.now() < deadline) {
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
      while (Date.now() < deadline) {
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

    return driver;
  } catch (error) {
    const cleanup: Promise<unknown>[] = [];
    if (worker) cleanup.push(worker.close());
    if (ownedObserver) cleanup.push(ownedObserver.close());
    if (ownedWorkClient) cleanup.push(ownedWorkClient.close());
    if (ownedReadPool) cleanup.push(ownedReadPool.end());
    if (ownedGrowth) cleanup.push(ownedGrowth.close());
    if (ownedResources) cleanup.push(ownedResources.system.close());
    const results = await Promise.allSettled(cleanup);
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
    worker: NativeWorker;
    seedFixture(posts: number, revisions: number, marker: string, targetPartition?: number): Promise<Fixture>;
    getStoredFixture(fixture: Fixture): StoredFixture;
    actor: FixtureResources['system']['actors']['author']['actor'];
    waitForOperationBarrier(name: string, serial: number): Promise<void>;
    input: {
      seed: number;
      scales: [32, 256, 2048];
      measurements: ['initiation', 'status', 'native-step'];
    };
  },
): Promise<GrowthResult[]> {
  const { growth, worker, input } = dependencies;
  const fixtures = new Map<number, Fixture>();
  const operations = new Map<number, Operation>();
  const workerCosts: Cost[] = [];
  const fixtureScales = input.scales;
  let targetPartition: number | undefined;
  await worker.restart(true);
  for (const [index, scale] of fixtureScales.entries()) {
    const marker = `erasure-growth-${input.seed}-${scale}-${randomUUID().replaceAll('-', '')}`;
    const fixture = await dependencies.seedFixture(101, 1, marker, targetPartition);
    targetPartition ??= fixture.partition;
    if (fixture.partition !== targetPartition) throw new Error('Native growth fixtures did not share one partition');
    fixtures.set(scale, fixture);
    if (index === 0 && fixture.targeted.length !== 101)
      throw new Error('Native growth fixture does not contain its fixed 101-post neighbourhood');
  }
  const firstFixture = fixtures.get(fixtureScales[0])!;
  const population = erasureGrowthPopulation(
    input.seed,
    dependencies.getStoredFixture(firstFixture),
    dependencies.actor,
  );
  await driver.barrier('hold');

  let seedCalls = 0;
  const bounds = { rows: 'constant' as const, statements: 'constant' as const, blocks: 'logarithmic' as const };
  const reports = new Map<GrowthResult['measurement'], GrowthReport>();

  for (const measurement of input.measurements) {
    const report = await checkGrowth(growth, {
      name: `native author erasure ${measurement}`,
      scales: input.scales,
      repetitions: 1,
      warmups: 0,
      bounds,
      async grow(database, scale, previous) {
        if (measurement !== 'initiation') return;
        await seed(database, population, { from: previous, to: scale });
        seedCalls++;
      },
      async operation(_database, scale) {
        const fixture = fixtures.get(scale);
        if (!fixture) throw new Error(`Missing fixed native growth fixture at scale ${scale}`);
        if (measurement === 'initiation') {
          const reply = await driver.erase('author', fixture.thread, fixture.authorId, randomUUID());
          if (reply.response.status !== 202 || !reply.value)
            throw new Error(`Native erasure initiation returned ${reply.response.status}`);
          operations.set(scale, reply.value);
          await dependencies.waitForOperationBarrier(reply.value.name, 1);
          return;
        }
        const operation = operations.get(scale);
        if (!operation) throw new Error(`Native growth operation at scale ${scale} was not initiated`);
        if (measurement === 'status') {
          const reply = await driver.status('author', operation.name);
          if (reply.response.status !== 200 || !reply.value)
            throw new Error(`Native erasure status returned ${reply.response.status}`);
          return;
        }
        await worker.captureNextStep();
        const postIds = await driver.step(operation.name);
        if (postIds.length !== 100)
          throw new Error(`Native growth step changed ${postIds.length} posts instead of 100`);
        const measured = await worker.waitCost();
        if (measured.serial !== 1)
          throw new Error('Native growth step did not capture the first persisted logical batch');
        workerCosts.push(measured.cost);
      },
    });
    reports.set(measurement, report);
  }

  if (seedCalls !== 3) throw new Error(`Native growth seeded ${seedCalls} times instead of once at each scale`);
  const nativeReport = reports.get('native-step');
  if (!nativeReport) throw new Error('Native growth harness omitted its worker measurement');
  if (workerCosts.length !== nativeReport.samples.length)
    throw new Error('Native growth did not return one actual worker cost per scale');
  const nativeSamples = nativeReport.samples.map((sample, index) => ({
    scale: sample.scale,
    cost: combineCost(sample.cost, workerCosts[index]!),
  }));
  assertGrowth(nativeSamples, nativeReport.bounds);

  for (const scale of fixtureScales) {
    const operation = operations.get(scale);
    if (!operation) throw new Error(`Native growth operation at scale ${scale} was not initiated`);
    await driver.finish(operation.name);
  }

  return input.measurements.map((measurement) => {
    const report = reports.get(measurement);
    if (!report) throw new Error(`Native growth harness omitted ${measurement}`);
    const samples =
      measurement === 'native-step'
        ? nativeSamples
        : report.samples.map((sample) => ({ scale: sample.scale, cost: sample.cost }));
    return {
      measurement,
      scales: [...input.scales],
      seedCalls,
      rows: 'constant',
      statements: 'constant',
      buffers: 'logarithmic',
      passed: true,
      samples: samples.map(({ scale, cost }) => ({
        scale,
        rows: cost.rows,
        statements: cost.statements,
        buffers: cost.blocks,
      })),
    };
  });
}

if (import.meta.main && process.env.ERASURE_OPERATION_WORKER === '1') {
  await runOperationWorkerProcess();
}
