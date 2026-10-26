import { randomBytes, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { createServer, request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import type { SearchDriver } from '../../../../specs/search-driver.ts';
import { systemClock } from '../../src/clock.ts';
import { createKernel } from '../../src/http/kernel.ts';
import { rebuildSubjects } from '../../src/search/generations.ts';
import { createOpenSearch } from '../../src/search/opensearch.ts';
import type { startSearchIndexing } from '../../src/search/runner.ts';
import { createSearchService } from '../../src/search/service.ts';
import { searchWorkModule } from '../../src/search/work.ts';
import { subjectSource } from '../../src/semantic/search-source.ts';
import { WORK_QUEUES } from '../../src/work/queues.ts';
import type { WorkContext, WorkService } from '../../src/work/registry.ts';
import { createSemanticDriver, type SemanticOutcomeDriver } from '../semantic/outcome-driver.ts';

/** Closing the listener also terminates keep-alive connections to the kernel. */
async function searchProxy(endpoint: string) {
  const target = new URL(endpoint);
  const forward = target.protocol === 'https:' ? httpsRequest : httpRequest;
  const server = createServer((incoming, outgoing) => {
    const upstream = forward(
      {
        protocol: target.protocol,
        hostname: target.hostname,
        port: target.port,
        method: incoming.method,
        path: incoming.url,
        headers: incoming.rawHeaders,
      },
      (response) => {
        outgoing.writeHead(response.statusCode!, response.statusMessage, response.rawHeaders);
        response.pipe(outgoing);
      },
    );
    upstream.on('error', () => {
      if (!outgoing.headersSent) outgoing.writeHead(502);
      outgoing.end();
    });
    incoming.pipe(upstream);
  });
  let port = 0;
  async function up() {
    if (server.listening) return;
    server.listen({ host: '127.0.0.1', port });
    await once(server, 'listening');
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Search proxy did not bind a TCP port');
    port = address.port;
  }
  async function down() {
    if (!server.listening) return;
    const stopped = new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
    server.closeAllConnections();
    await stopped;
  }
  await up();
  return { url: `http://127.0.0.1:${port}`, up, down };
}

type Runner = Awaited<ReturnType<typeof startSearchIndexing>>;

export async function createSearchDriver(): Promise<SearchDriver> {
  const endpoint = process.env.OPENSEARCH_URL;
  if (!endpoint) throw new Error('OPENSEARCH_URL must name the real test node');
  const prefix = `test-${randomBytes(4).toString('hex')}-`;
  const proxy = await searchProxy(endpoint);
  const client = createOpenSearch(proxy.url);
  let semantic: SemanticOutcomeDriver | undefined;
  let runner: Runner | undefined;
  let start: (() => WorkService | Promise<WorkService>) | undefined;
  let closing: Promise<void> | undefined;

  async function indexing(state: 'paused' | 'running') {
    if (state === 'paused') {
      await runner?.stop();
      runner = undefined;
    } else if (!runner) {
      if (!start) throw new Error('Search work module did not register its service');
      const service = await start();
      if (!('refresh' in service) || typeof service.refresh !== 'function') {
        await service.stop();
        throw new Error('Search work module service does not export refresh');
      }
      runner = service as Runner;
    }
  }

  function close(): Promise<void> {
    return (closing ??= (async () => {
      const failures: unknown[] = [];
      const attempt = async (action: () => Promise<unknown>) => {
        try {
          await action();
        } catch (error) {
          failures.push(error);
        }
      };
      await attempt(() => indexing('paused'));
      await attempt(async () => {
        await proxy.up();
        const { body } = await client.request<{ indices: { name: string }[] }>(
          'GET',
          `/_resolve/index/${prefix}*`,
          undefined,
          { query: { expand_wildcards: 'all' } },
        );
        for (const { name } of body.indices) {
          if (name.startsWith(prefix)) await attempt(() => client.request('DELETE', `/${name}`));
        }
      });
      await attempt(proxy.down);
      await attempt(async () => semantic?.close());
      if (failures.length) throw new AggregateError(failures, 'Search outcome fixture cleanup failed');
    })());
  }

  try {
    semantic = await createSemanticDriver((config) => {
      if (!config.tokens) throw new Error('Semantic fixtures must provide the session and cursor keys');
      return createKernel({
        ...config,
        search: createSearchService({
          pool: config.pool,
          client,
          prefix,
          source: subjectSource(config.pool),
          cursors: config.tokens,
        }),
      });
    });
    const fixtures = semantic.fixtures;
    const operator = await fixtures.person('search_operator');
    await fixtures.grantAccount(operator, ['moderation:hide', 'moderation:takedown']);

    const context: WorkContext = {
      pool: fixtures.pool,
      queues: WORK_QUEUES,
      clock: systemClock,
      get client(): WorkContext['client'] {
        throw new Error('Search work module must not enqueue workflows');
      },
      env: { OPENSEARCH_URL: proxy.url, KERNEL_SEARCH_PREFIX: prefix },
      addEffects() {
        throw new Error('Search work module must not register effects');
      },
      addService(service) {
        if (start) throw new Error('Search work module registered multiple services');
        start = service;
      },
    };
    await searchWorkModule.register(context);
    await indexing('running');

    return {
      globalContext: semantic.globalContext,
      request: semantic.request,
      async remove(subjectId, mode) {
        const response = await fixtures.send(
          operator,
          'POST',
          `/v1/subjects/${subjectId}:${mode === 'hidden' ? 'hide' : 'takedown'}`,
          mode === 'hidden'
            ? { reason: 'Search outcome moderation fixture' }
            : { notice: { complaint: 'Search outcome takedown fixture', received_at: new Date().toISOString() } },
          { 'Idempotency-Key': `"${randomUUID()}"` },
        );
        if (response.status !== 200)
          throw new Error(`Subject moderation failed: ${response.status}: ${JSON.stringify(response.body)}`);
      },
      indexing,
      async searchNode(state) {
        if (state === 'down') await proxy.down();
        else await proxy.up();
      },
      async rebuild() {
        if (!runner) throw new Error('Cannot rebuild while the indexing service is stopped');
        const { generation } = await rebuildSubjects({
          pool: fixtures.pool,
          search: client,
          source: subjectSource(fixtures.pool),
          prefix,
          runner,
        });
        return { generation };
      },
      close,
    };
  } catch (error) {
    try {
      await close();
    } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], 'Search outcome fixture setup and cleanup failed');
    }
    throw error;
  }
}
