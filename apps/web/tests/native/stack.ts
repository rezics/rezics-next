import { fork, spawn, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { Pool } from 'pg';
import type { SemanticOutcomeDriver } from '../../../../services/kernel/test/semantic/outcome-driver.ts';

export type NativeCredentials = { authorization: string };
export type NativeKernelRequest = {
  method: string;
  url: string;
  authorization: string | null;
};
export type NativeWebStack = {
  kernelOrigin: string;
  web: string;
  kernel(path: string, init?: RequestInit, persona?: string): Promise<Response>;
  request(url: string, persona?: string, headers?: Record<string, string>): Promise<Response>;
  credentials(persona: string): Promise<NativeCredentials>;
  kernelRequests(): readonly NativeKernelRequest[];
  peakMemoryBytes(): number;
  restartWeb(options: { publicOrigin: string }): Promise<void>;
  stop(): Promise<void>;
};

type WebProcess = { child: ChildProcess; stateDirectory: string; exited: Promise<void> };

const webRoot = resolve(import.meta.dir, '../..');
const repositoryRoot = resolve(webRoot, '../..');

async function freePort(): Promise<number> {
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response() });
  const port = server.port;
  server.stop(true);
  return port;
}

async function startWeb(origin: string, kernelOrigin: string, publicOrigin: string): Promise<WebProcess> {
  await mkdir(join(repositoryRoot, '.temp'), { recursive: true });
  const stateDirectory = await mkdtemp(join(repositoryRoot, '.temp', 'native-web-state-'));
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    KERNEL_ORIGIN: kernelOrigin,
    PUBLIC_ORIGIN: publicOrigin,
    WEB_TEST_STATE_DIR: stateDirectory,
    WRANGLER_SEND_METRICS: 'false',
  };
  for (const name of ['AUTH_ISSUER', 'WEBSITE_CLIENT_ID', 'WEBSITE_CLIENT_KEY', 'API_RESOURCE', 'WEBSITE_SCOPES'])
    delete env[name];
  const child = spawn('bun', ['run', 'dev', '--host', '127.0.0.1', '--port', new URL(origin).port, '--strictPort'], {
    cwd: webRoot,
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    env,
  });
  let output = '';
  for (const stream of [child.stdout, child.stderr])
    stream?.on('data', (chunk: Buffer) => {
      output = (output + chunk).slice(-12_000);
    });
  let spawnError: Error | undefined;
  child.once('error', (error) => {
    spawnError = error;
  });
  let ended = false;
  const exited = new Promise<void>((resolve) => child.once('close', resolve).once('error', () => resolve()));
  const failIfExited = () => {
    if (spawnError)
      throw new Error(`web Worker could not start: ${spawnError.message}\n${output}`, { cause: spawnError });
    if (ended || child.exitCode !== null || child.signalCode !== null)
      throw new Error(`web Worker exited during startup: ${output}`);
  };
  child.once('close', () => {
    ended = true;
  });
  const deadline = Date.now() + 150_000;
  try {
    while (Date.now() < deadline) {
      failIfExited();
      try {
        const response = await fetch(`${origin}/en/subjects/00000000-0000-4000-8000-000000000000`, {
          signal: AbortSignal.timeout(5000),
        });
        await response.arrayBuffer();
        failIfExited();
        if (response.status === 404) return { child, stateDirectory, exited };
      } catch {
        if (spawnError || ended || child.exitCode !== null || child.signalCode !== null) failIfExited();
      }
      await Bun.sleep(250);
    }
    throw new Error(`web Worker startup timed out: ${output}`);
  } catch (error) {
    await stopWeb({ child, stateDirectory, exited }).catch(() => {});
    throw error;
  }
}

async function stopWeb(web: WebProcess | undefined): Promise<void> {
  if (!web) return;
  const { child, stateDirectory, exited } = web;
  const processGroup = child.pid;
  const groupAlive = () => {
    if (!processGroup) return false;
    try {
      process.kill(-processGroup, 0);
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false;
      throw error;
    }
  };
  const waitForGroup = async (milliseconds: number) => {
    const deadline = Date.now() + milliseconds;
    while (groupAlive()) {
      if (Date.now() >= deadline) return false;
      await Bun.sleep(50);
    }
    await exited;
    return true;
  };
  try {
    if (groupAlive()) {
      try {
        process.kill(-processGroup!, 'SIGTERM');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
      }
      if (!(await waitForGroup(10_000))) {
        try {
          process.kill(-processGroup!, 'SIGKILL');
        } catch {}
        await waitForGroup(10_000);
        throw new Error('web Worker did not stop gracefully');
      }
    }
  } finally {
    await rm(stateDirectory, { recursive: true, force: true });
  }
}

function errorDetails(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  const details = [error.stack ?? error.message];
  if (error.cause) details.push(errorDetails(error.cause));
  if (error instanceof AggregateError) details.push(...error.errors.map(errorDetails));
  return details.join('\n');
}

async function startDurableWorker(environment: NodeJS.ProcessEnv): Promise<{ pid?: number; stop(): Promise<void> }> {
  const child = spawn(
    process.execPath,
    ['--preload', 'reylo/register', '--preload', './test/support/fixture-event-types.ts', 'src/worker.ts'],
    {
      cwd: resolve(repositoryRoot, 'services/kernel'),
      env: { ...process.env, ...environment },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  let output = '';
  let started!: () => void;
  let failed!: (error: Error) => void;
  const ready = new Promise<void>((resolve, reject) => {
    started = resolve;
    failed = reject;
  });
  const exited = new Promise<void>((resolve) => child.once('close', () => resolve()));
  for (const stream of [child.stdout, child.stderr])
    stream?.on('data', (chunk: Buffer) => {
      output = (output + chunk).slice(-12_000);
      if (output.includes('Worker ready')) started();
    });
  child.once('error', failed);
  child.once('exit', (code, signal) => failed(new Error(`Durable worker exited ${code ?? signal}: ${output}`)));
  const timer = setTimeout(() => failed(new Error(`Durable worker startup timed out: ${output}`)), 120_000);
  let stopping: Promise<void> | undefined;
  const stop = () =>
    (stopping ??= (async () => {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
      await exited;
    })());
  try {
    await ready;
    return { pid: child.pid, stop };
  } catch (error) {
    await stop();
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

async function startStack(): Promise<Omit<NativeWebStack, 'kernel' | 'request'>> {
  let kernelServer: ReturnType<typeof Bun.serve> | undefined;
  let durableWorker: { pid?: number; stop(): Promise<void> } | undefined;
  let webProcess: WebProcess | undefined;
  let driver: SemanticOutcomeDriver | undefined;
  let postgresContainer: string | undefined;
  let runtimeDirectory: string | undefined;
  let closeAuth: (() => Promise<void>) | undefined;
  const originalDatabaseUrl = process.env.DATABASE_URL;
  let stopped: Promise<void> | undefined;
  let peakMemory = process.memoryUsage().rss;
  const sampleMemory = () => {
    let bytes = process.memoryUsage().rss;
    if (webProcess?.child.pid) {
      const result = Bun.spawnSync(['ps', '-o', 'rss=', '-g', String(webProcess.child.pid)]);
      if (result.exitCode === 0) {
        const residentKilobytes = result.stdout.toString().trim().split(/\s+/).map(Number).filter(Number.isFinite);
        bytes += residentKilobytes.reduce((sum, value) => sum + value, 0) * 1024;
      }
    }
    if (durableWorker?.pid) {
      const result = Bun.spawnSync(['ps', '-o', 'rss=', '-p', String(durableWorker.pid)]);
      if (result.exitCode === 0) bytes += Number(result.stdout.toString().trim()) * 1024;
    }
    peakMemory = Math.max(peakMemory, bytes);
  };
  const memorySampler = setInterval(sampleMemory, 250);
  const accounts = new Map<string, Promise<{ accountId: string; bearer: string }>>();
  const requests: NativeKernelRequest[] = [];
  const getAccount = (persona: string) => {
    let account = accounts.get(persona);
    if (!account) {
      account = driver!.fixtures.person(persona);
      accounts.set(persona, account);
    }
    return account;
  };
  const stop = () =>
    (stopped ??= (async () => {
      const errors: unknown[] = [];
      const attempt = async (close: () => unknown | Promise<unknown>) => {
        try {
          await close();
        } catch (error) {
          errors.push(error);
        }
      };
      await attempt(() => stopWeb(webProcess));
      webProcess = undefined;
      clearInterval(memorySampler);
      await attempt(() => kernelServer?.stop(true));
      kernelServer = undefined;
      await attempt(() => durableWorker?.stop());
      durableWorker = undefined;
      await attempt(() => driver?.close());
      await attempt(() => closeAuth?.());
      if (runtimeDirectory) await attempt(() => rm(runtimeDirectory!, { recursive: true, force: true }));
      if (postgresContainer) {
        const removed = Bun.spawnSync(['docker', 'rm', '-fv', postgresContainer]);
        if (removed.exitCode !== 0)
          errors.push(new Error(`Could not remove owned PostgreSQL container: ${removed.stderr.toString()}`));
        postgresContainer = undefined;
      }
      if (originalDatabaseUrl === undefined) delete process.env.DATABASE_URL;
      else process.env.DATABASE_URL = originalDatabaseUrl;
      if (errors.length) throw new AggregateError(errors, 'Native web stack cleanup failed');
    })());
  try {
    // Match the kernel test preload before evaluating anything that imports SQL.
    await import(new URL('../../../../services/kernel/node_modules/reylo/src/register.js', import.meta.url).href);
    if (!process.env.DATABASE_URL) {
      const { startPostgresContainer } = await import('../../../../services/kernel/scripts/check.ts');
      const { migrate } = await import('../../../../services/kernel/scripts/database.ts');
      postgresContainer = startPostgresContainer();
      const portResult = Bun.spawnSync(['docker', 'port', postgresContainer, '5432/tcp']);
      if (portResult.exitCode !== 0)
        throw new Error(`Could not get owned PostgreSQL port: ${portResult.stderr.toString()}`);
      const port = Number(portResult.stdout.toString().match(/127\.0\.0\.1:(\d+)/)?.[1]);
      if (!Number.isInteger(port) || port <= 0)
        throw new Error(`Could not parse owned PostgreSQL port: ${portResult.stdout.toString()}`);
      const databaseUrl = `postgres://rezics:rezics@127.0.0.1:${port}/rezics?sslmode=disable`;
      const deadline = Date.now() + 60_000;
      while (true) {
        const probe = new Pool({ connectionString: databaseUrl, connectionTimeoutMillis: 1500, max: 1 });
        try {
          await probe.query('SELECT 1');
          break;
        } catch (error) {
          if (Date.now() >= deadline) throw new Error('Disposable PostgreSQL did not become ready.', { cause: error });
          await Bun.sleep(500);
        } finally {
          await probe.end();
        }
      }
      process.env.DATABASE_URL = databaseUrl;
      migrate(databaseUrl);
    }
    // Give Reylo an owned cache and the migrated template for SQL analysis.
    await mkdir(join(repositoryRoot, '.temp'), { recursive: true });
    runtimeDirectory = await mkdtemp(join(repositoryRoot, '.temp', 'native-kernel-runtime-'));
    const { writeReyloProject } = await import('../../../../services/kernel/scripts/check.ts');
    process.env.REYLO_CONFIG = writeReyloProject(runtimeDirectory, process.env.DATABASE_URL!);
    process.env.KERNEL_POOL_ACQUIRE_TIMEOUT_MS ??= '2000';
    await import('../../../../services/kernel/test/support/fixture-event-types.ts');
    const { workerTestEnv } = await import('../../../../services/kernel/test/support/worker-env.ts');
    ({ closeOwnedSemanticAuth: closeAuth } = await import('../../../../services/kernel/test/semantic/outcome-auth.ts'));
    // The semantic harness reads DATABASE_URL during module evaluation.
    const { createSemanticDriver } = await import('../../../../services/kernel/test/semantic/outcome-driver.ts');
    const { createKernel } = await import('../../../../services/kernel/src/http/kernel.ts');
    let kernel: ReturnType<typeof createKernel> | undefined;
    driver = await createSemanticDriver(
      (dependencies) => {
        kernel = createKernel(dependencies);
        return kernel;
      },
      { linkProjection: 'external', strictCleanup: true },
    );

    const workerEnv = {
      ...workerTestEnv({
        AUTH_ISSUER: driver.fixtures.runtime.authIssuer,
        AUTH_AUDIENCE: driver.fixtures.runtime.authAudience,
        AUTH_JWKS_URL: driver.fixtures.runtime.authJwksUrl,
        KERNEL_ROUTE_KEY: driver.fixtures.runtime.routeKey,
        KERNEL_SESSION_KEYS: driver.fixtures.runtime.sessionKeys,
      }),
      DATABASE_URL: driver.fixtures.runtime.databaseUrl,
      KERNEL_EXECUTOR_ID: `native-web-${randomBytes(8).toString('hex')}`,
    };
    durableWorker = await startDurableWorker(workerEnv);

    const sourceApp = kernel!;
    const server = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      fetch: (request) => {
        const url = new URL(request.url);
        requests.push({
          method: request.method,
          url: `${url.pathname}${url.search}`,
          authorization: request.headers.get('authorization'),
        });
        return sourceApp.handle(request);
      },
    });
    kernelServer = server;
    const kernelOrigin = server.url.origin;
    const webOrigin = `http://127.0.0.1:${await freePort()}`;
    let publicOrigin = 'https://rezics.example.test';
    const launch = async () => startWeb(webOrigin, kernelOrigin, publicOrigin);
    webProcess = await launch();

    return {
      kernelOrigin,
      web: webOrigin,
      async credentials(persona) {
        return { authorization: `Bearer ${(await getAccount(persona)).bearer}` };
      },
      kernelRequests() {
        return requests.slice();
      },
      peakMemoryBytes() {
        sampleMemory();
        return peakMemory;
      },
      async restartWeb(options) {
        await stopWeb(webProcess);
        webProcess = undefined;
        publicOrigin = options.publicOrigin;
        webProcess = await launch();
      },
      stop,
    };
  } catch (error) {
    try {
      await stop();
    } catch (cleanup) {
      throw new AggregateError([error, cleanup], 'Native web stack startup and cleanup failed', { cause: error });
    }
    throw error;
  }
}
// The semantic harness owns process-local Auth and can only dispose it terminally.
// Give every stack its own process so stop can close Auth as well as the kernel,
// and a second (or failed) stack never reuses an earlier stack's database or sessions.
type Observation = { requests: NativeKernelRequest[]; peakMemory: number };
type HostReply =
  | { ready: { kernelOrigin: string; web: string; databaseUrl: string }; observation: Observation }
  | { id: number; value?: unknown; error?: string; observation: Observation }
  | { startupError: string };
type HostCall = { id: number; method: 'credentials' | 'restartWeb' | 'observe' | 'stop'; argument?: string };

export async function startNativeWebStack(): Promise<NativeWebStack> {
  const originalDatabaseUrl = process.env.DATABASE_URL;
  const host = fork(import.meta.filename, [], {
    execPath: process.execPath,
    execArgv: [],
    cwd: repositoryRoot,
    env: { ...process.env, NATIVE_WEB_STACK_HOST: '1' },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  let output = '';
  for (const stream of [host.stdout, host.stderr])
    stream?.on('data', (chunk: Buffer) => {
      output = (output + chunk).slice(-12_000);
    });
  const exited = new Promise<void>((resolve) => host.once('close', () => resolve()));
  const terminate = async () => {
    if (host.exitCode === null && host.signalCode === null) host.kill('SIGTERM');
    await exited;
  };
  let serial = 0;
  let observation: Observation = { requests: [], peakMemory: 0 };
  let closed: Promise<void> | undefined;
  let dead: Error | undefined;
  const pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void }>();
  let ready!: (value: { kernelOrigin: string; web: string; databaseUrl: string }) => void;
  let failed!: (error: Error) => void;
  const startup = new Promise<{ kernelOrigin: string; web: string; databaseUrl: string }>((resolve, reject) => {
    ready = resolve;
    failed = reject;
  });
  const fail = (error: Error) => {
    dead = error;
    failed(error);
    for (const call of pending.values()) call.reject(error);
    pending.clear();
  };
  host.on('message', (reply: HostReply) => {
    if ('startupError' in reply) return fail(new Error(reply.startupError));
    observation.requests.push(...reply.observation.requests);
    observation.peakMemory = reply.observation.peakMemory;
    if ('ready' in reply) return ready(reply.ready);
    const call = pending.get(reply.id);
    pending.delete(reply.id);
    if (reply.error) call?.reject(new Error(reply.error));
    else call?.resolve(reply.value);
  });
  host.on('error', fail);
  host.on('exit', (code) => fail(new Error(`Native stack host exited ${code}\n${output}`)));
  const call = (method: HostCall['method'], argument?: string): Promise<unknown> => {
    if (dead) return Promise.reject(dead);
    const id = ++serial;
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      host.send({ id, method, argument } satisfies HostCall);
    });
  };
  try {
    const { kernelOrigin, web, databaseUrl } = await startup;
    // Retain the existing fixture's observable setup environment. The host has
    // its own environment, including Reylo config and pool timeout overrides.
    if (originalDatabaseUrl === undefined) process.env.DATABASE_URL = databaseUrl;
    const credentials = (persona: string) => call('credentials', persona) as Promise<NativeCredentials>;
    const authenticatedHeaders = async (input: HeadersInit | undefined, persona?: string) => {
      const headers = new Headers(input);
      if (persona && persona !== 'anonymous') headers.set('authorization', (await credentials(persona)).authorization);
      return headers;
    };
    const observe = async (response: Response) => {
      await call('observe');
      return response;
    };
    return {
      kernelOrigin,
      web,
      credentials,
      kernelRequests: () => observation.requests.slice(),
      peakMemoryBytes: () => observation.peakMemory,
      async kernel(path, init = {}, persona) {
        const url = new URL(path, kernelOrigin);
        if (url.origin !== kernelOrigin) throw new Error('Kernel request must use the owned listener');
        const headers = await authenticatedHeaders(init.headers, persona);
        return observe(await fetch(url, { ...init, headers, redirect: 'manual' }));
      },
      async request(url, persona, suppliedHeaders) {
        const requested = new URL(url, web);
        const target = new URL(requested.pathname + requested.search, web);
        const headers = await authenticatedHeaders(suppliedHeaders, persona);
        // Keep the HTTP Response itself: observing never reads its body, replaces
        // its headers, changes its status, or follows a Worker redirect.
        return observe(await fetch(target, { headers, redirect: 'manual' }));
      },
      async restartWeb({ publicOrigin }) {
        await call('restartWeb', publicOrigin);
      },
      stop() {
        return (closed ??= (async () => {
          try {
            await call('stop');
          } finally {
            await terminate();
            if (originalDatabaseUrl === undefined && process.env.DATABASE_URL === databaseUrl)
              delete process.env.DATABASE_URL;
          }
        })());
      },
    };
  } catch (error) {
    await terminate();
    throw error;
  }
}

if (process.env.NATIVE_WEB_STACK_HOST === '1' && process.send) {
  const send = (reply: HostReply) => process.send!(reply);
  try {
    const stack = await startStack();
    let observedRequests = 0;
    const observation = (): Observation => {
      const requests = stack.kernelRequests();
      const next = { requests: requests.slice(observedRequests), peakMemory: stack.peakMemoryBytes() };
      observedRequests = requests.length;
      return next;
    };
    process.on('message', async ({ id, method, argument }: HostCall) => {
      try {
        let value: unknown;
        if (method === 'credentials') value = await stack.credentials(argument!);
        else if (method === 'restartWeb') await stack.restartWeb({ publicOrigin: argument! });
        else if (method === 'stop') await stack.stop();
        send({ id, value, observation: observation() } satisfies HostReply);
      } catch (error) {
        send({
          id,
          error: errorDetails(error),
          observation: observation(),
        } satisfies HostReply);
      }
    });
    send({
      ready: { kernelOrigin: stack.kernelOrigin, web: stack.web, databaseUrl: process.env.DATABASE_URL! },
      observation: observation(),
    } satisfies HostReply);
  } catch (error) {
    send({
      startupError: errorDetails(error),
    } satisfies HostReply);
  }
}
