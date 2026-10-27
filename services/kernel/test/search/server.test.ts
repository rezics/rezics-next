import { afterAll, expect, test } from 'bun:test';
import { randomBytes } from 'node:crypto';
import { createPool } from '../../src/database/pool.ts';
import { subjectGenerations, subjectIndexName } from '../../src/search/indices.ts';
import { createOpenSearch } from '../../src/search/opensearch.ts';
import { readSearchConfig, searchWorkModule } from '../../src/search/work.ts';
import { ConfigError, readConfig, startServer } from '../../src/server.ts';
import type { WorkContext, WorkService } from '../../src/work/registry.ts';

const databaseUrl = process.env.DATABASE_URL;
const searchUrl = process.env.OPENSEARCH_URL;
if (!databaseUrl || !searchUrl)
  throw new Error('DATABASE_URL and OPENSEARCH_URL must name the check database and node');
const pool = createPool(databaseUrl);
const search = createOpenSearch(searchUrl);
const kernelDirectory = new URL('../..', import.meta.url).pathname;
const key = () => randomBytes(32).toString('base64url');
const env = { DATABASE_URL: databaseUrl, KERNEL_ROUTE_KEY: key(), KERNEL_SESSION_KEYS: `1:${key()}`, KERNEL_PORT: '0' };
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

/** Registers the search work module against a context that records its services. */
async function registered(moduleEnv: Record<string, string>) {
  const services: (() => WorkService | Promise<WorkService>)[] = [];
  const context = {
    pool,
    env: moduleEnv,
    addService(start: () => WorkService | Promise<WorkService>) {
      services.push(start);
    },
  } as unknown as WorkContext;
  await searchWorkModule.register(context);
  return services;
}

/** The worker's indexing runner on its own prefix, once it has created generation 1. */
async function indexing(prefix: string): Promise<WorkService> {
  const services = await registered({ OPENSEARCH_URL: searchUrl!, KERNEL_SEARCH_PREFIX: prefix });
  expect(services).toHaveLength(1);
  const running = await services[0]!();
  await eventually(async () => (await subjectGenerations(search, prefix)).active === 1);
  return running;
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
  expect(await registered({})).toEqual([]);
  const prefix = freshPrefix();
  const running = await indexing(prefix);
  await running.stop();
  expect(await subjectGenerations(search, prefix)).toEqual({ generations: [1], active: 1 });
}, 30_000);

test('a server answers search and suggest from the index the worker feeds', async () => {
  const prefix = freshPrefix();
  const running = await indexing(prefix);
  const server = startServer(readConfig({ ...env, OPENSEARCH_URL: searchUrl, KERNEL_SEARCH_PREFIX: prefix }));
  const origin = server.url.href.replace(/\/$/, '');
  try {
    const searched = await searchRequest(origin, { text: 'kokoro' });
    expect(searched.status).toBe(200);
    expect(await searched.json()).toMatchObject({ subjects: [], total: { value: 0, relation: 'exact' }, next: null });
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
