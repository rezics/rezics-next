import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import type { HttpResponse } from '../../../../../specs/semantic-driver.ts';
import type { createKernel } from '../../../src/http/kernel.ts';
import { rebuildSubjects } from '../../../src/search/generations.ts';
import { subjectGenerations, subjectIndexName } from '../../../src/search/indices.ts';
import { createOpenSearch, OpenSearchError } from '../../../src/search/opensearch.ts';
import { SEARCH_TEMPLATE, SUGGEST_TEMPLATE, FACET_TEMPLATE } from '../../../src/search/query.ts';
import { createSearchService } from '../../../src/search/service.ts';
import { subjectSource } from '../../../src/semantic/search-source.ts';
import { startWorker } from '../../../src/worker.ts';
import { KERNEL_WORK_MODULES } from '../../../src/work/modules.ts';
import type { WorkContext } from '../../../src/work/registry.ts';
import type { SemanticOutcomeDriver } from '../../semantic/outcome-driver.ts';
import type { CreatedSubject } from '../../support/released-discovery.ts';
import { workerTestEnv } from '../../support/worker-env.ts';
import { createSearchRunnerSlot } from './runner-slot.ts';

type Request = (path: string, body?: unknown) => Promise<HttpResponse>;
export interface ReleasedDiscoveryRuntime {
  indexing(state: 'paused' | 'running'): Promise<void>;
  converge(subjects: readonly CreatedSubject[]): Promise<void>;
  rebuild(): Promise<{ generation: number; previous: number | null }>;
}

/** One native prefix and default SDK composition, in the same process as the supplied runtime pools. */
export function releasedDiscoveryRuntime(kernelPool?: (url: string) => Pool | Promise<Pool>) {
  const url = process.env.OPENSEARCH_URL;
  if (!url) throw new Error('OPENSEARCH_URL must name the native Search node');
  const search = createOpenSearch(url);
  const prefix = `discovery-${randomUUID().replaceAll('-', '').slice(0, 20)}-`;
  const slot = createSearchRunnerSlot();
  let worker: Awaited<ReturnType<typeof startWorker>> | undefined;
  let context: WorkContext | undefined;
  let request: Request | undefined;
  let routeKey: Uint8Array | undefined;
  let closing: Promise<void> | undefined;
  let starting: Promise<void> | undefined;
  let sealed = false;
  const operations = new Set<Promise<unknown>>();
  function operation<T>(run: () => Promise<T>): Promise<T> {
    if (sealed) return Promise.reject(new Error('Released discovery runtime is closed'));
    if (!worker) return Promise.reject(new Error('Released discovery runtime has not started'));
    const pending = run();
    operations.add(pending);
    void pending.finally(() => operations.delete(pending)).catch(() => {});
    return pending;
  }
  const control: ReleasedDiscoveryRuntime = {
    indexing: (state) => operation(() => (state === 'paused' ? slot.pause() : slot.resume())),
    converge: (subjects) =>
      operation(async () => {
        for (const subject of subjects) {
          const read = await request!(`/v1/subjects/${subject.id}`);
          if (read.status !== 200) throw new Error(`Read convergence witness: ${JSON.stringify(read.body)}`);
          const label = (read.body.subject as { labels: Record<string, string> }).labels.en;
          if (!label) throw new Error(`Convergence witness ${subject.id} has no English label`);
          const deadline = Date.now() + 15_000;
          let last: unknown;
          for (;;) {
            const result = await request!('/v1/subjects:search', { text: JSON.stringify(label), limit: 100 });
            last = result;
            if (result.status === 200) {
              const subjects = result.body.subjects as { id: string }[];
              if (subjects.some(({ id }) => id === subject.id)) break;
            } else if (
              result.status !== 503 ||
              !['index_not_ready', 'semantic_not_ready'].includes(String(result.body.code))
            ) {
              throw new Error(`Search convergence failed: ${JSON.stringify(result.body)}`);
            }
            if (Date.now() >= deadline)
              throw new Error(`Search did not converge for ${subject.id}: ${JSON.stringify(last)}`);
            await Bun.sleep(25);
          }
        }
      }),
    rebuild: () =>
      operation(() =>
        slot.withRunner((runner) =>
          rebuildSubjects({
            pool: context!.pool,
            search,
            prefix,
            source: subjectSource(context!.pool, routeKey!),
            runner,
          }),
        ),
      ),
  };
  return {
    control,
    service(config: Parameters<typeof createKernel>[0]) {
      if (!config.tokens) throw new Error('Shared fixture must supply its actual session keys');
      return createSearchService({
        pool: config.pool,
        client: search,
        prefix,
        source: subjectSource(config.pool, config.routeKey),
        cursors: config.tokens,
      });
    },
    start(runtime: SemanticOutcomeDriver['fixtures']['runtime'], send: Request): Promise<void> {
      if (sealed || starting)
        return Promise.reject(new Error('Released discovery runtime start already attempted or closed'));
      return (starting = (async () => {
        request = send;
        routeKey = Buffer.from(runtime.routeKey, 'base64url');
        const env = workerTestEnv({
          DATABASE_URL: runtime.databaseUrl,
          KERNEL_ROUTE_KEY: runtime.routeKey,
          KERNEL_SESSION_KEYS: runtime.sessionKeys,
          AUTH_ISSUER: runtime.authIssuer,
          AUTH_AUDIENCE: runtime.authAudience,
          AUTH_JWKS_URL: runtime.authJwksUrl,
          OPENSEARCH_URL: url,
          KERNEL_SEARCH_PREFIX: prefix,
        });
        const registered: string[] = [];
        let searchStarts = 0;
        const modules = KERNEL_WORK_MODULES.map((module) => ({
          name: module.name,
          async register(original: WorkContext) {
            registered.push(module.name);
            await module.register({
              ...original,
              addService(start) {
                if (module.name !== 'search') return original.addService(start);
                if (context) throw new Error('Default Search must register exactly one service');
                context = original;
                const observed = async () => {
                  searchStarts += 1;
                  return start();
                };
                original.addService(async () => slot.adopt(await observed(), observed));
              },
            });
          },
        }));
        worker = await startWorker(
          { databaseUrl: runtime.databaseUrl, poolSize: 10, ...(kernelPool ? { kernelPool } : {}) },
          modules,
          env,
        );
        if (
          JSON.stringify(registered) !== JSON.stringify(KERNEL_WORK_MODULES.map(({ name }) => name)) ||
          searchStarts !== 1
        )
          throw new Error(
            'Actual default registration or Search starter execution differs from the imported composition',
          );
      })());
    },
    close(): Promise<void> {
      sealed = true;
      return (closing ??= (async () => {
        await starting?.catch(() => {});
        await Promise.allSettled([...operations]);
        // A failed drain must never permit deleting the running worker's index.
        if (worker) await worker.stop();
        else await slot.stop();
        const errors: unknown[] = [];
        const attempt = async (run: () => Promise<unknown>) => {
          try {
            await run();
          } catch (error) {
            errors.push(error);
          }
        };
        await attempt(async () => {
          const { generations } = await subjectGenerations(search, prefix);
          for (const generation of generations)
            await attempt(() => search.request('DELETE', `/${subjectIndexName(prefix, generation)}`));
        });
        for (const template of [SEARCH_TEMPLATE, SUGGEST_TEMPLATE, FACET_TEMPLATE])
          await attempt(async () => {
            try {
              await search.request('DELETE', `/_scripts/${prefix}${template}`);
            } catch (error) {
              if (!(error instanceof OpenSearchError && error.status === 404)) throw error;
            }
          });
        if (errors.length) throw new AggregateError(errors, 'Released discovery native Search cleanup failed');
      })());
    },
  };
}
