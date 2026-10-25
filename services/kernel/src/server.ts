import { createWriteRateLimiter, type WriteRateLimiter } from './access/write-rate.ts';
import { createWriteRateStage, type WriteRateStageOptions } from './access/write-rate-stage.ts';
import { createPool } from './database/pool.ts';
import { createKernel } from './http/kernel.ts';
import type { KeyRing } from './tokens/seal.ts';
import { ConfigError, readCommerceConfig, type CommerceConfig } from './commerce/config.ts';
import { createStripePort } from './commerce/stripe.ts';
import { createCommerceWork } from './commerce/enqueue.ts';
import { createWorkClient } from './work/client.ts';
import { readContentConfig } from './content/config.ts';
import type { ContentRuntime } from './content/runtime.ts';
import type { NativeAuthorErasureWorkflows } from './content/operation-contract.ts';
import { systemClock } from './clock.ts';

export { ConfigError } from './commerce/config.ts';
import { bundledRelease } from '@rezics/definitions/bundled';
import { setupPresentation } from './presentation/setup.ts';
import { subjectSource } from './semantic/search-source.ts';
import { setupSemantic } from './semantic/setup.ts';
import { createOpenSearch } from './search/opensearch.ts';
import { createSearchService } from './search/service.ts';
import { readSearchConfig, type SearchConfig } from './search/work.ts';

export type ServerConfig = {
  databaseUrl: string;
  hostname: string;
  port: number;
  routeKey: Uint8Array;
  tokens: KeyRing;
  commerce: CommerceConfig | null;
  content: ContentRuntime;
  search?: SearchConfig;
  writeRate?: WriteRateLimiter;
  rateAttribution?: WriteRateStageOptions;
};

function required(env: NodeJS.ProcessEnv, variable: string): string {
  const value = env[variable];
  if (!value) throw new ConfigError(variable);
  return value;
}

function decodeKey(value: string, variable: string, exactLength?: number): Uint8Array {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new ConfigError(variable);
  const decoded = Buffer.from(value, 'base64url');
  if (decoded.toString('base64url') !== value || decoded.byteLength < (exactLength ?? 32)) {
    throw new ConfigError(variable);
  }
  if (exactLength !== undefined && decoded.byteLength !== exactLength) throw new ConfigError(variable);
  return new Uint8Array(decoded);
}

export function readConfig(env: NodeJS.ProcessEnv): ServerConfig {
  const databaseUrl = required(env, 'DATABASE_URL');
  const routeKey = decodeKey(required(env, 'KERNEL_ROUTE_KEY'), 'KERNEL_ROUTE_KEY', 32);
  const entries = required(env, 'KERNEL_SESSION_KEYS').split(',');
  const keys = new Map<number, Uint8Array>();
  for (const entry of entries) {
    const match = /^(\d+):([A-Za-z0-9_-]+)$/.exec(entry);
    const id = match?.[1] === undefined ? NaN : Number(match[1]);
    const encoded = match?.[2];
    if (!Number.isInteger(id) || id < 0 || id > 255 || encoded === undefined || keys.has(id)) {
      throw new ConfigError('KERNEL_SESSION_KEYS');
    }
    keys.set(id, decodeKey(encoded, 'KERNEL_SESSION_KEYS'));
  }
  const current = keys.keys().next().value as number | undefined;
  if (current === undefined) throw new ConfigError('KERNEL_SESSION_KEYS');

  const hostname = env.KERNEL_HOSTNAME ?? '127.0.0.1';
  const portValue = env.KERNEL_PORT ?? '4100';
  if (!/^\d+$/.test(portValue)) throw new ConfigError('KERNEL_PORT');
  const port = Number(portValue);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new ConfigError('KERNEL_PORT');

  const writeRate = createWriteRateLimiter({
    ...(env.KERNEL_WRITE_RATE_SECRET === undefined ? {} : { secret: env.KERNEL_WRITE_RATE_SECRET }),
    ...(env.KERNEL_WRITE_RATE_OVERRIDES === undefined ? {} : { overrides: env.KERNEL_WRITE_RATE_OVERRIDES }),
  });
  const rateAttribution: WriteRateStageOptions = {
    trustedProxyPeers: env.KERNEL_RATE_TRUSTED_PROXY_PEERS?.split(',') ?? [],
    clientIpHeader: env.KERNEL_RATE_CLIENT_IP_HEADER ?? 'cf-connecting-ip',
  };
  createWriteRateStage(writeRate, rateAttribution); // Validate trusted transport configuration at startup.
  const search = readSearchConfig(env);
  const commerce = readCommerceConfig(env);
  return {
    databaseUrl,
    hostname,
    port,
    routeKey,
    tokens: { current, keys },
    writeRate,
    rateAttribution,
    commerce,
    content: readContentConfig(env),
    ...(search === undefined ? {} : { search }),
  };
}

type RunningServer = {
  url: URL;
  stop(): Promise<void>;
};

export function startServer(config: ServerConfig): Promise<RunningServer> & RunningServer {
  const pool = createPool(config.databaseUrl);
  const peers = new WeakMap<Request, string>();
  const searchConfig = config.search;
  const commerce = config.commerce;
  // One client for the process. The server enqueues no index work and runs no relay.
  const openSearch = searchConfig === undefined ? undefined : createOpenSearch(searchConfig.url);
  let app: ReturnType<typeof createKernel> | undefined;
  let workClient: ReturnType<typeof createWorkClient> | undefined;
  let contentWorkflows: Promise<NativeAuthorErasureWorkflows> | undefined;
  const workflows = (): Promise<NativeAuthorErasureWorkflows> =>
    (contentWorkflows ??= (async () => {
      // Keep Sharp and the worker implementation out of API startup. This
      // status/enqueue adapter is loaded only if an operation route uses it.
      const [{ createContentOperationClient }, client] = await Promise.all([import('./content/work.ts'), workClient!]);
      return createContentOperationClient({ pool, client, clock: systemClock });
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
    await setupSemantic(pool, bundledRelease);
    await setupPresentation(pool);
    workClient = createWorkClient(config.databaseUrl);
    // Observe startup rejection immediately; the webhook and stop still receive it.
    void workClient.catch(() => {});
    const client = workClient;
    await client;
    app = createKernel({
      pool,
      routeKey: config.routeKey,
      tokens: config.tokens,
      clock: systemClock,
      content: { ...config.content, workflows: operationWorkflows },
      ...(config.writeRate === undefined ? {} : { writeRate: config.writeRate }),
      ...(config.rateAttribution === undefined ? {} : { rateAttribution: config.rateAttribution }),
      ratePeer: (request) => peers.get(request),
      ...(openSearch === undefined || searchConfig === undefined
        ? {}
        : {
            search: createSearchService({
              pool,
              client: openSearch,
              prefix: searchConfig.prefix,
              source: subjectSource(pool),
              cursors: config.tokens,
            }),
          }),
      ...(commerce === null
        ? {}
        : {
            commerce: {
              stripe: createStripePort({ ...commerce.stripe, clock: () => new Date() }),
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
    stop() {
      return (stopping ??= (async () => {
        try {
          await server.stop(true);
          await Promise.all([...activeRequests]);
        } finally {
          try {
            await boot.catch(() => {});
            if (workClient) await (await workClient).close();
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
