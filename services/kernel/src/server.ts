import { createWriteRateLimiter, type WriteRateLimiter } from './access/write-rate.ts';
import { createWriteRateStage, type WriteRateStageOptions } from './access/write-rate-stage.ts';
import { createPool } from './database/pool.ts';
import { createKernel } from './http/kernel.ts';
import type { KeyRing } from './tokens/seal.ts';
import { startRelays } from './events/relays.ts';
import { effectsRelay, launchWork, registerEffects, shutdownWork, type Effect } from './events/effects.ts';
import { ConfigError, readCommerceConfig, type CommerceConfig } from './commerce/config.ts';
import { createStripePort } from './commerce/stripe.ts';
import { createCommerceWork } from './commerce/enqueue.ts';
import { createWorkClient } from './work/client.ts';

export { ConfigError } from './commerce/config.ts';
import { bundledRelease } from '@rezics/definitions/bundled';
import { setupSemantic } from './semantic/setup.ts';

export type ServerConfig = {
  databaseUrl: string;
  hostname: string;
  port: number;
  routeKey: Uint8Array;
  tokens: KeyRing;
  commerce: CommerceConfig;
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
  return {
    databaseUrl,
    hostname,
    port,
    routeKey,
    tokens: { current, keys },
    commerce: readCommerceConfig(env),
    writeRate,
    rateAttribution,
  };
}

export async function startServer(config: ServerConfig, options: { effects?: Effect[] } = {}) {
  const pool = createPool(config.databaseUrl);
  await setupSemantic(pool, bundledRelease);
  const registeredEffects = registerEffects(options.effects ?? []);
  let relays: ReturnType<typeof startRelays> | undefined;
  const work = launchWork({ databaseUrl: config.databaseUrl }).then(() => {
    relays = startRelays(pool, [effectsRelay(pool, registeredEffects)]);
  });
  const workClient = createWorkClient(config.databaseUrl);
  // Observe startup rejection immediately; the webhook and stop still receive it.
  void workClient.catch(() => {});
  const peers = new WeakMap<Request, string>();
  const app = createKernel({
    pool,
    routeKey: config.routeKey,
    tokens: config.tokens,
    ...(config.writeRate === undefined ? {} : { writeRate: config.writeRate }),
    ...(config.rateAttribution === undefined ? {} : { rateAttribution: config.rateAttribution }),
    ratePeer: (request) => peers.get(request),
    commerce: {
      stripe: createStripePort({ ...config.commerce.stripe, clock: () => new Date() }),
      successUrl: config.commerce.successUrl,
      cancelUrl: config.commerce.cancelUrl,
      webhookSecrets: config.commerce.webhookSecrets,
      work: {
        async enqueueStripeEvent(ref) {
          await createCommerceWork(await workClient).enqueueStripeEvent(ref);
        },
      },
    },
  });
  const server = Bun.serve({
    hostname: config.hostname,
    port: config.port,
    fetch(request, transport) {
      const address = transport.requestIP(request)?.address;
      if (address) peers.set(request, address);
      return app.fetch(request);
    },
  });
  return {
    url: server.url,
    async stop(): Promise<void> {
      try {
        await server.stop(true);
      } finally {
        try {
          await work;
        } finally {
          try {
            await relays?.stop();
          } finally {
            try {
              await shutdownWork();
            } finally {
              try {
                await (await workClient).close();
              } finally {
                await pool.end();
              }
            }
          }
        }
      }
    },
  };
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
