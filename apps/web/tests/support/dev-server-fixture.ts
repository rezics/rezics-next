import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const sharedDevServerEnvName = 'WEB_TEST_DEV_SERVER';
export const workerFixtureEnvFile = 'dev-fixture-env.json';
export const workerFixtureLockDirectory = 'dev-fixture.lock';

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
  'LOCAL_MEDIA_ORIGIN',
  'LOCAL_MEDIA_TOKEN',
  'WORKER_INSPECTOR_PORT',
] as const;

export type SharedDevServerRecord = {
  origin: string;
  pid: number;
  fixtureDirectory: string;
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

export function readSharedDevServer(path = process.env[sharedDevServerEnvName]): SharedDevServerRecord | undefined {
  if (!path) return undefined;
  return JSON.parse(readFileSync(path, 'utf8')) as SharedDevServerRecord;
}

export function writeSharedDevServer(path: string, record: SharedDevServerRecord): void {
  writeFileSync(path, `${JSON.stringify(record)}\n`);
}

export async function acquireWorkerFixture(
  fixtureDirectory: string,
  overlay: WorkerFixtureOverlay | undefined,
  options: { pollIntervalMs?: number; waitMs?: number } = {},
): Promise<() => void> {
  const lockDirectory = join(fixtureDirectory, workerFixtureLockDirectory);
  const envFile = join(fixtureDirectory, workerFixtureEnvFile);
  const pollIntervalMs = options.pollIntervalMs ?? 25;
  const waitMs = options.waitMs ?? 120_000;
  const deadline = Date.now() + waitMs;
  mkdirSync(fixtureDirectory, { recursive: true });
  for (;;) {
    try {
      mkdirSync(lockDirectory);
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      if (Date.now() >= deadline)
        throw new Error(`Web test fixture lock ${lockDirectory} did not release for a per-file overlay`);
      await Bun.sleep(pollIntervalMs);
    }
  }
  writeFileSync(envFile, `${JSON.stringify(overlay ?? {})}\n`);
  return () => {
    rmSync(envFile, { force: true });
    rmSync(lockDirectory, { recursive: true, force: true });
  };
}

export function readWorkerFixtureOverlay(fixtureDirectory: string): WorkerFixtureOverlay | undefined {
  const path = join(fixtureDirectory, workerFixtureEnvFile);
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as WorkerFixtureOverlay;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}
