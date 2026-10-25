import { createPool } from './database/pool.ts';
import { createKernel } from './http/kernel.ts';
import type { KeyRing } from './tokens/seal.ts';

export type ServerConfig = {
  databaseUrl: string;
  hostname: string;
  port: number;
  routeKey: Uint8Array;
  tokens: KeyRing;
};

export class ConfigError extends Error {
  constructor(variable: string) {
    super(`Invalid or missing ${variable}`);
    this.name = 'ConfigError';
  }
}

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

  return { databaseUrl, hostname, port, routeKey, tokens: { current, keys } };
}

export function startServer(config: ServerConfig) {
  const pool = createPool(config.databaseUrl);
  const app = createKernel({ pool, routeKey: config.routeKey, tokens: config.tokens });
  const server = Bun.serve({
    hostname: config.hostname,
    port: config.port,
    fetch: app.fetch,
  });
  return {
    url: server.url,
    async stop(): Promise<void> {
      try {
        await server.stop(true);
      } finally {
        await pool.end();
      }
    },
  };
}

if (import.meta.main) {
  try {
    const server = startServer(readConfig(process.env));
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
