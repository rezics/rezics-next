import { readCommerceMoneyPolicy, type CommerceMoneyPolicy } from './commerce/money.ts';
import type { WriteRateLimiter } from './access/write-rate.ts';
import { createWriteRateStage, type WriteRateStageOptions } from './access/write-rate-stage.ts';
import { createPool, KERNEL_POOL_MAX, readPoolAcquireTimeoutMillis } from './database/pool.ts';
import type { Pool } from 'pg';
import { createKernel } from './http/kernel.ts';
import type { KeyRing } from './tokens/seal.ts';
import { ConfigError, readCommerceConfig, type CommerceConfig } from './commerce/config.ts';
import { createStripePort } from './commerce/stripe.ts';
import { createCommerceWork } from './commerce/enqueue.ts';
import { createWorkClient } from './work/client.ts';
import { readContentConfig } from './content/config.ts';
import type { ContentRuntime } from './content/runtime.ts';
import type { NativeAuthorErasureWorkflows } from './content/operation-contract.ts';
import { configureReceiptKeys, readReceiptKeyRing } from './command/receipt-key.ts';
import { createKernelRuntimeDefaults, decodeKey, required } from './work/runtime-defaults.ts';

export { ConfigError } from './commerce/config.ts';
import { bundledRelease } from '@rezics/definitions/bundled';
import { setupPresentation } from './presentation/setup.ts';
import { createRatedSubjectSource } from './search/rated-source.ts';
import { createRealmRatingNativeSource } from './search/realm-rating-native.ts';
import { setupSemantic } from './semantic/setup.ts';
import { setupContent } from './content/setup.ts';
import { createOpenSearch } from './search/opensearch.ts';
import { createSearchService } from './search/service.ts';
import { readSearchConfig, type SearchConfig } from './search/work.ts';
import type { AuthenticationConfig } from './access/authenticate.ts';
import { createDefaultPublicFilterRuntime, type DefaultPublicFilterRuntime } from './search/public-runtime.ts';
import { createPublicPreparationStore } from './search/public-preparation-store.ts';
import { createDefaultDiscoverySearch, type DefaultDiscoverySearch } from './search/default-discovery.ts';
import { createDiscoveryProducerEntry } from './composition/discovery.ts';
import { MAX_HTTP_BODY_LIMIT } from './http/body.ts';

export { createKernelRuntimeDefaults };
export type { KernelRuntimeDefaults, KernelRuntimeOverrides } from './work/runtime-defaults.ts';

export type ServerConfig = {
  moneyPolicy?: CommerceMoneyPolicy;
  databaseUrl: string;
  poolAcquireTimeoutMillis: number;
  /** Test override for verifying that the server pool survives its idle eviction interval. */
  poolIdleTimeoutMillis?: number;
  hostname: string;
  port: number;
  routeKey: Uint8Array;
  tokens: KeyRing;
  receiptKeys?: KeyRing;
  commerce: CommerceConfig | null;
  content: ContentRuntime;
  search?: SearchConfig;
  writeRate?: WriteRateLimiter;
  rateAttribution?: WriteRateStageOptions;
  auth?: AuthenticationConfig;
};

export function readConfig(env: NodeJS.ProcessEnv): ServerConfig {
  const databaseUrl = required(env, 'DATABASE_URL');
  const poolAcquireTimeoutMillis = readPoolAcquireTimeoutMillis(env);
  const routeKey = decodeKey(required(env, 'KERNEL_ROUTE_KEY'), 'KERNEL_ROUTE_KEY', 32);
  const defaults = createKernelRuntimeDefaults({ env });
  createWriteRateStage(defaults.writeRate, defaults.rateAttribution); // Validate trusted transport configuration at startup.

  const hostname = env.KERNEL_HOSTNAME ?? '127.0.0.1';
  const portValue = env.KERNEL_PORT ?? '4100';
  if (!/^\d+$/.test(portValue)) throw new ConfigError('KERNEL_PORT');
  const port = Number(portValue);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new ConfigError('KERNEL_PORT');

  const search = readSearchConfig(env);
  const commerce = readCommerceConfig(env);
  return {
    databaseUrl,
    poolAcquireTimeoutMillis,
    hostname,
    port,
    routeKey,
    tokens: defaults.tokens,
    receiptKeys: defaults.receiptKeys,
    writeRate: defaults.writeRate,
    rateAttribution: defaults.rateAttribution,
    ...(defaults.auth === undefined ? {} : { auth: defaults.auth }),
    commerce,
    moneyPolicy: readCommerceMoneyPolicy(env),
    content: readContentConfig(env),
    ...(search === undefined ? {} : { search }),
  };
}

type RunningServer = {
  url: URL;
  pool: Readonly<{
    totalCount: number;
    idleCount: number;
    max: number;
    idleTimeoutMillis: number;
  }>;
  stop(): Promise<void>;
};

async function fillPool(pool: Pool): Promise<void> {
  const results = await Promise.allSettled(Array.from({ length: pool.options.max }, () => pool.connect()));
  for (const result of results) {
    if (result.status === 'fulfilled') result.value.release();
  }
  const failure = results.find((result) => result.status === 'rejected');
  if (failure?.status === 'rejected') throw failure.reason;
}

export function startServer(config: ServerConfig): Promise<RunningServer> & RunningServer {
  const defaults = createKernelRuntimeDefaults({
    tokens: config.tokens,
    ...(config.receiptKeys === undefined ? {} : { receiptKeys: config.receiptKeys }),
    ...(config.writeRate === undefined ? {} : { writeRate: config.writeRate }),
    ...(config.rateAttribution === undefined ? {} : { rateAttribution: config.rateAttribution }),
    ...(config.auth === undefined ? {} : { auth: config.auth }),
  });
  const pool = createPool(config.databaseUrl, {
    connectionTimeoutMillis: config.poolAcquireTimeoutMillis,
    min: KERNEL_POOL_MAX,
    ...(config.poolIdleTimeoutMillis === undefined ? {} : { idleTimeoutMillis: config.poolIdleTimeoutMillis }),
  });
  if (defaults.receiptKeys) configureReceiptKeys(pool, defaults.receiptKeys);
  const peers = new WeakMap<Request, string>();
  const searchConfig = config.search;
  const commerce = config.commerce;
  const moneyPolicy = config.moneyPolicy ?? readCommerceMoneyPolicy(process.env);
  // One client for the process. The server enqueues no index work and runs no relay.
  const openSearch = searchConfig === undefined ? undefined : createOpenSearch(searchConfig.url);
  let app: ReturnType<typeof createKernel> | undefined;
  let publicFilters: DefaultPublicFilterRuntime | undefined;
  let discovery: DefaultDiscoverySearch | undefined;
  let workClient: ReturnType<typeof createWorkClient> | undefined;
  let contentWorkflows: Promise<NativeAuthorErasureWorkflows> | undefined;
  const workflows = (): Promise<NativeAuthorErasureWorkflows> =>
    (contentWorkflows ??= (async () => {
      // Keep Sharp and the worker implementation out of API startup. This
      // status/enqueue adapter is loaded only if an operation route uses it.
      const [{ createContentOperationClient }, client] = await Promise.all([import('./content/work.ts'), workClient!]);
      return createContentOperationClient({ pool, client, clock: defaults.clock });
    })());
  const operationWorkflows: NativeAuthorErasureWorkflows = {
    async enqueue(input, context) {
      await (await workflows()).enqueue(input, context);
    },
    async status(operationId, context) {
      return (await workflows()).status(operationId, context);
    },
  };
  const activeRequests = new Set<Promise<void>>();
  const boot = (async () => {
    await fillPool(pool);
    await setupSemantic(pool, bundledRelease);
    await setupContent(pool);
    await setupPresentation(pool);
    workClient = createWorkClient(config.databaseUrl);
    // Observe startup rejection immediately; the webhook and stop still receive it.
    void workClient.catch(() => {});
    const client = workClient;
    await client;
    const rated = searchConfig === undefined ? undefined : createRatedSubjectSource(pool, config.routeKey);
    app = createKernel({
      moneyPolicy,
      pool,
      routeKey: config.routeKey,
      tokens: defaults.tokens,
      receiptKeys: defaults.receiptKeys,
      writeRate: defaults.writeRate,
      rateAttribution: defaults.rateAttribution,
      clock: defaults.clock,
      access: defaults.access,
      onAccessReady(access, viewerActions) {
        if (openSearch && searchConfig) {
          if (!rated) throw new Error('Discovery Subject source composition is incomplete');
          publicFilters = createDefaultPublicFilterRuntime({
            pool,
            routeKey: config.routeKey,
            access,
            search: openSearch,
            prefix: searchConfig.prefix,
            clock: defaults.clock,
          });
          const producers = createDiscoveryProducerEntry({
            pool,
            routeKey: config.routeKey,
            access,
            tokens: config.tokens,
            clock: defaults.clock,
            subjects: rated.source,
          });
          discovery = createDefaultDiscoverySearch(
            {
              spaceEntryActions: viewerActions,
              pool,
              routeKey: config.routeKey,
              access,
              search: openSearch,
              prefix: searchConfig.prefix,
              keys: config.tokens,
              clock: defaults.clock,
            },
            producers,
          );
        }
      },
      content: { ...config.content, workflows: operationWorkflows },
      ratePeer: (request) => peers.get(request),
      ...(openSearch === undefined || searchConfig === undefined || rated === undefined
        ? {}
        : {
            discovery: (principal, request, context) => {
              if (!discovery) throw new Error('Discovery Access composition is incomplete');
              return discovery.search(principal, request, context);
            },
            search: createSearchService({
              pool,
              client: openSearch,
              prefix: searchConfig.prefix,
              source: rated.source,
              ratings: rated.ratings,
              realmRatings: createRealmRatingNativeSource({
                pool,
                search: openSearch,
                prefix: searchConfig.prefix,
                tokens: config.tokens,
              }),
              cursors: config.tokens,
              clock: defaults.clock,
              publicFilters: () => {
                if (!publicFilters) throw new Error('Public Search Access composition is incomplete');
                return publicFilters;
              },
              async preparePublic(job) {
                await createPublicPreparationStore(pool, await client, searchConfig.prefix).retain(
                  {
                    kind: 'repair',
                    key: JSON.stringify(job),
                    job,
                  },
                  Date.now() + 24 * 60 * 60 * 1000,
                );
              },
            }),
          }),
      ...(commerce === null
        ? {}
        : {
            commerce: {
              stripe: createStripePort({ ...commerce.stripe, clock: defaults.clock }),
              successUrl: commerce.successUrl,
              cancelUrl: commerce.cancelUrl,
              webhookSecrets: commerce.webhookSecrets,
              work: {
                async enqueueStripeEvent(ref) {
                  await createCommerceWork(await client).enqueueStripeEvent(ref);
                },
              },
            },
          }),
    });
  })();
  // The socket is listening before setup finishes. Requests wait for that setup.
  const server = Bun.serve({
    hostname: config.hostname,
    port: config.port,
    maxRequestBodySize: MAX_HTTP_BODY_LIMIT,
    async fetch(request, transport) {
      let finish!: () => void;
      const active = new Promise<void>((resolve) => (finish = resolve));
      activeRequests.add(active);
      try {
        await boot;
        if (!app) throw new Error('Kernel server is not ready');
        const address = transport.requestIP(request)?.address;
        if (address) peers.set(request, address);
        return await app.fetch(request);
      } finally {
        activeRequests.delete(active);
        finish();
      }
    },
  });
  let stopping: Promise<void> | undefined;
  const running: RunningServer = {
    url: server.url,
    pool: Object.freeze({
      get totalCount() {
        return pool.totalCount;
      },
      get idleCount() {
        return pool.idleCount;
      },
      get max() {
        return pool.options.max;
      },
      get idleTimeoutMillis() {
        return pool.options.idleTimeoutMillis ?? 30_000;
      },
    }),
    stop() {
      return (stopping ??= (async () => {
        try {
          // Stop accepting requests but let active handlers finish before their
          // database clients are closed below.
          await server.stop(false);
          await Promise.all([...activeRequests]);
        } finally {
          try {
            await boot.catch(() => {});
            try {
              await discovery?.close();
            } finally {
              try {
                await publicFilters?.close();
              } finally {
                if (workClient) await (await workClient).close();
              }
            }
          } finally {
            await pool.end();
          }
        }
      })());
    },
  };
  const pending = boot.then(
    () => running,
    async (error: unknown) => {
      await running.stop().catch(() => {});
      throw error;
    },
  );
  return Object.assign(pending, running);
}

if (import.meta.main) {
  try {
    const server = await startServer(readConfig(process.env));
    console.info(server.url.href);
    const stop = () => {
      void server.stop().finally(() => process.exit(0));
    };
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
  } catch (error) {
    if (error instanceof ConfigError) console.error(error.message);
    else console.error(error);
    process.exitCode = 1;
  }
}
