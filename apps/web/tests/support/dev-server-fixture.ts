import { readFileSync, writeFileSync } from 'node:fs';

export const sharedDevServerEnvName = 'WEB_TEST_DEV_SERVER';

export const workerFixtureKeys = [
  'KERNEL_ORIGIN',
  'AUTH_ISSUER',
  'AUTH_TEST_LOOPBACK_ORIGIN',
  'AUTH_MANAGEMENT_PAGE_ROUTES',
  'WEBSITE_CLIENT_ID',
  'WEBSITE_CLIENT_KEY',
  'API_RESOURCE',
  'WEBSITE_SCOPES',
  'PUBLIC_ORIGIN',
  'SITE_ORIGINS',
  'TURNSTILE_SITE_KEY',
  'TURNSTILE_SCRIPT_URL',
  'NATIVE_MEDIA_STORAGE_TOKEN',
  'WORKER_INSPECTOR_PORT',
] as const;

export type SharedDevServerRecord = {
  origin: string;
  pid: number;
  workerBindings: WorkerFixtureOverlay;
  cacheDirectory?: string;
  lockHash?: string;
};

export type WorkerFixtureOverlay = Record<string, string>;

export function workerFixtureOverlay(env?: NodeJS.ProcessEnv): WorkerFixtureOverlay | undefined {
  if (!env) return undefined;
  const overlay: WorkerFixtureOverlay = {};
  let present = false;
  for (const key of workerFixtureKeys) {
    if (Object.prototype.hasOwnProperty.call(env, key)) {
      overlay[key] = env[key] ?? '';
      present = true;
    }
  }
  return present ? overlay : undefined;
}

export function bindWorkerFixtureOrigins(overlay: WorkerFixtureOverlay, origin: string): WorkerFixtureOverlay {
  const bound = { ...overlay };
  for (const key of ['PUBLIC_ORIGIN', 'SITE_ORIGINS'] as const) {
    const value = bound[key];
    if (value !== undefined)
      bound[key] = value.replace(/https?:\/\/(?:127\.0\.0\.1|localhost):(?:undefined|\$\{port\}|\d+)/g, origin);
  }
  return bound;
}

/** A shared server is safe only when every requested override matches its startup snapshot. */
export function workerFixtureBindingsCompatible(
  requested: WorkerFixtureOverlay | undefined,
  startup: WorkerFixtureOverlay,
): boolean {
  return Object.entries(requested ?? {}).every(([key, value]) => startup[key] === value);
}

export function readSharedDevServer(path = process.env[sharedDevServerEnvName]): SharedDevServerRecord | undefined {
  if (!path) return undefined;
  const record = JSON.parse(readFileSync(path, 'utf8')) as Partial<SharedDevServerRecord>;
  if (
    typeof record.origin !== 'string' ||
    typeof record.pid !== 'number' ||
    !record.workerBindings ||
    typeof record.workerBindings !== 'object' ||
    Array.isArray(record.workerBindings) ||
    Object.values(record.workerBindings).some((value) => typeof value !== 'string')
  )
    return undefined;
  return record as SharedDevServerRecord;
}

export function writeSharedDevServer(path: string, record: SharedDevServerRecord): void {
  writeFileSync(path, `${JSON.stringify(record)}\n`);
}
