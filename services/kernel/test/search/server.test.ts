import { afterAll, expect, test } from 'bun:test';
import { randomBytes } from 'node:crypto';
import { createPool } from '../../src/database/pool.ts';
import { systemClock } from '../../src/clock.ts';
import { subjectGenerations, subjectIndexName } from '../../src/search/indices.ts';
import { createOpenSearch } from '../../src/search/opensearch.ts';
import { startSearchIndexing } from '../../src/search/runner.ts';
import { readSearchConfig, createSearchWorkModule } from '../../src/search/work.ts';
import { createDiscoveryProducerEntry } from '../../src/composition/discovery.ts';
import { createKernelRuntimeDefaults } from '../../src/composition/runtime-defaults.ts';
import { composeSearchNativeAccess, composeSearchNativePorts } from '../../src/composition/search-native.ts';
import { ConfigError, readConfig, startServer } from '../../src/server.ts';
import type { WorkContext, WorkService } from '../../src/work/registry.ts';
import { createWorkClient, type WorkClient } from '../../src/work/client.ts';
import { WORK_QUEUES } from '../../src/work/queues.ts';
import type { Effect } from '../../src/events/effects.ts';
import { testReceiptKeysEnv } from '../support/receipt-keys.ts';
import { workerTestEnv } from '../support/worker-env.ts';

const databaseUrl = process.env.DATABASE_URL;
const searchUrl = process.env.OPENSEARCH_URL;
if (!databaseUrl || !searchUrl)
  throw new Error('DATABASE_URL and OPENSEARCH_URL must name the check database and node');
const pool = createPool(databaseUrl);
const search = createOpenSearch(searchUrl);
const kernelDirectory = new URL('../..', import.meta.url).pathname;
const key = () => randomBytes(32).toString('base64url');
const env = {
  DATABASE_URL: databaseUrl,
  KERNEL_ROUTE_KEY: key(),
  KERNEL_SESSION_KEYS: `1:${key()}`,
  ...testReceiptKeysEnv(),
  KERNEL_PORT: '0',
};
const searchWorkModule = createSearchWorkModule(
  createDiscoveryProducerEntry,
  createKernelRuntimeDefaults,
  undefined,
  composeSearchNativePorts,
  composeSearchNativeAccess,
);
const prefixes: string[] = [];
afterAll(async () => {
  for (const prefix of prefixes) {
    const { generations } = await subjectGenerations(search, prefix);
    for (const generation of generations) await search.request('DELETE', `/${subjectIndexName(prefix, generation)}`);
  }
  await pool.end();
});

function freshPrefix(): string {
  const prefix = `test-${crypto.randomUUID().slice(0, 8)}-`;
  prefixes.push(prefix);
  return prefix;
}

function refusal(changes: Record<string, string>, variable: string) {
  let error: unknown;
  try {
    readSearchConfig(changes);
  } catch (caught) {
    error = caught;
  }
  expect(error).toBeInstanceOf(ConfigError);
  expect((error as Error).message).toContain(variable);
}

async function eventually(check: () => Promise<boolean>, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error('condition not reached in time');
    await Bun.sleep(50);
  }
}

type WorkServiceStart = Parameters<WorkContext['addService']>[0];
type SearchRunner = Awaited<ReturnType<typeof startSearchIndexing>>;
type SearchWorkHost = {
  context: WorkContext;
  services: WorkServiceStart[];
  effects: Effect[];
  close(): Promise<void>;
};

/** Complete direct host for module-registration acceptance; only the SDK lifecycle is omitted. */
async function workHost(moduleEnv: Record<string, string | undefined>): Promise<SearchWorkHost> {
  const client: WorkClient = await createWorkClient(databaseUrl!, pool);
  const services: WorkServiceStart[] = [];
  const effects: Effect[] = [];
  let closing: Promise<void> | undefined;
  const context: WorkContext = {
    pool,
    queues: WORK_QUEUES,
    client,
    env: { ...workerTestEnv(), ...env, ...moduleEnv },
    clock: systemClock,
    getAuthorization() {
      throw new Error('Search module registration does not consume worker authorization');
    },
    addEffects(registered) {
      effects.push(...registered);
    },
    addService(start) {
      services.push(start);
    },
  };
  return {
    context,
    services,
    effects,
    close() {
      return (closing ??= client.close());
    },
  };
}

/** Registers Search against the complete real pool/client/clock/effects host. */
async function registered(moduleEnv: Record<string, string | undefined>): Promise<SearchWorkHost> {
  const host = await workHost(moduleEnv);
  try {
    await searchWorkModule.register(host.context);
    return host;
  } catch (error) {
    await host.close();
    throw error;
  }
}

/** The worker's indexing runner on its own prefix, once it has created generation 1. */
async function indexing(prefix: string): Promise<SearchRunner> {
  const host = await registered({
    OPENSEARCH_URL: searchUrl!,
    KERNEL_SEARCH_PREFIX: prefix,
    KERNEL_ROUTE_KEY: env.KERNEL_ROUTE_KEY,
  });
  const running: WorkService[] = [];
  let runner: SearchRunner | undefined;
  let stopping: Promise<void> | undefined;
  const stop = () =>
    (stopping ??= (async () => {
      const errors: unknown[] = [];
      for (const service of [...running].reverse()) {
        try {
          await service.stop();
        } catch (error) {
          errors.push(error);
        }
      }
      try {
        await host.close();
      } catch (error) {
        errors.push(error);
      }
      if (errors.length) throw new AggregateError(errors, 'Search server-test services did not drain');
    })());
  try {
    for (const start of host.services) {
      const service = await start();
      running.push(service);
      if ('pause' in service && typeof service.pause === 'function') runner = service as SearchRunner;
    }
    if (!runner) throw new Error('Configured Search host did not start its indexing runner');
    await eventually(async () => (await subjectGenerations(search, prefix)).active === 1);
    return {
      pause: () => runner!.pause(),
      resume: () => runner!.resume(),
      refresh: () => runner!.refresh(),
      stop,
    };
  } catch (error) {
    await stop();
    throw error;
  }
}

const searchRequest = (origin: string, body: unknown) =>
  fetch(`${origin}/v1/subjects:search`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

test('search is configured by OPENSEARCH_URL and KERNEL_SEARCH_PREFIX', () => {
  expect(readSearchConfig({})).toBeUndefined();
  expect(readConfig(env).search).toBeUndefined();
  expect(readSearchConfig({ OPENSEARCH_URL: 'http://127.0.0.1:59200' })).toEqual({
    url: 'http://127.0.0.1:59200',
    prefix: 'rezics-',
  });
  expect(
    readConfig({ ...env, OPENSEARCH_URL: 'https://search.internal:9200', KERNEL_SEARCH_PREFIX: 'staging-' }).search,
  ).toEqual({ url: 'https://search.internal:9200', prefix: 'staging-' });
  refusal({ OPENSEARCH_URL: 'search.internal' }, 'OPENSEARCH_URL');
  refusal({ OPENSEARCH_URL: 'ftp://search.internal' }, 'OPENSEARCH_URL');
  refusal({ OPENSEARCH_URL: 'http://127.0.0.1:59200', KERNEL_SEARCH_PREFIX: 'Bad Prefix' }, 'KERNEL_SEARCH_PREFIX');
});

test('a server without search configured answers search with index_not_ready', async () => {
  const server = startServer(readConfig(env));
  try {
    const response = await searchRequest(server.url.href.replace(/\/$/, ''), {});
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ code: 'index_not_ready', retryable: true });
    expect(response.headers.get('retry-after')).toBe('1');
  } finally {
    await server.stop();
  }
});

test('the search work module starts the indexing runner only when search is configured', async () => {
  const disabled = await registered({});
  const disabledServices: WorkService[] = [];
  try {
    expect(disabled.services).toHaveLength(1);
    expect(disabled.effects.map(({ name }) => name)).toContain('search_erasure');
    for (const start of disabled.services) disabledServices.push(await start());
    expect(disabledServices.every((service) => !('pause' in service))).toBe(true);
  } finally {
    try {
      for (const service of [...disabledServices].reverse()) await service.stop();
    } finally {
      await disabled.close();
    }
  }
  const prefix = freshPrefix();
  const running = await indexing(prefix);
  await running.stop();
  expect(await subjectGenerations(search, prefix)).toEqual({ generations: [1], active: 1 });
}, 30_000);

test('a configured Search worker refuses a missing or malformed route key', async () => {
  const malformed = 'not-a-canonical-route-key';
  for (const routeKey of [undefined, malformed]) {
    const host = await workHost({
      OPENSEARCH_URL: searchUrl!,
      KERNEL_SEARCH_PREFIX: freshPrefix(),
      KERNEL_ROUTE_KEY: routeKey,
    });
    let error: unknown;
    try {
      await searchWorkModule.register(host.context);
    } catch (caught) {
      error = caught;
    } finally {
      await host.close();
    }
    expect(error).toBeInstanceOf(ConfigError);
    expect((error as Error).message).toBe('Invalid or missing KERNEL_ROUTE_KEY');
    expect((error as Error).message).not.toContain(malformed);
    expect(host.services).toEqual([]);
  }
});

test('a server answers search and suggest from the index the worker feeds', async () => {
  const prefix = freshPrefix();
  const running = await indexing(prefix);
  const server = startServer(readConfig({ ...env, OPENSEARCH_URL: searchUrl, KERNEL_SEARCH_PREFIX: prefix }));
  const origin = server.url.href.replace(/\/$/, '');
  try {
    const searched = await searchRequest(origin, { text: 'kokoro' });
    expect(searched.status).toBe(200);
    const body = await searched.json();
    expect(body).toMatchObject({ subjects: [], next: null });
    for (const field of ['total', 'count', 'counts', 'lower_bound', 'estimate']) expect(body).not.toHaveProperty(field);
    const suggested = await fetch(`${origin}/v1/subjects:suggest?q=Koko`);
    expect(suggested.status).toBe(200);
    expect(await suggested.json()).toMatchObject({ subjects: [] });
  } finally {
    await server.stop();
    await running.stop();
  }
}, 30_000);

test('the rebuild command builds the next generation and switches the alias', async () => {
  const prefix = freshPrefix();
  const running = await indexing(prefix);
  try {
    const run = Bun.spawn(['bun', 'scripts/search.ts', 'rebuild'], {
      cwd: kernelDirectory,
      env: {
        ...process.env,
        DATABASE_URL: databaseUrl,
        OPENSEARCH_URL: searchUrl,
        KERNEL_SEARCH_PREFIX: prefix,
        KERNEL_ROUTE_KEY: env.KERNEL_ROUTE_KEY,
      },
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const [exitCode, stdout, stderr] = await Promise.all([
      run.exited,
      new Response(run.stdout).text(),
      new Response(run.stderr).text(),
    ]);
    if (exitCode !== 0) throw new Error(`rebuild exited ${exitCode}: ${stderr}`);
    expect(JSON.parse(stdout)).toEqual({ generation: 2, previous: 1 });
    expect(await subjectGenerations(search, prefix)).toEqual({ generations: [1, 2], active: 2 });
  } finally {
    await running.stop();
  }
}, 60_000);
