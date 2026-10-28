import { spawn, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createSemanticDriver, type SemanticOutcomeDriver } from '../../../../services/kernel/test/semantic/outcome-driver.ts';
import { workerTestEnv } from '../../../../services/kernel/test/support/worker-env.ts';

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

type WebProcess = { child: ChildProcess; stateDirectory: string };

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
  const child = spawn('bun', ['run', 'dev', '--host', '127.0.0.1', '--port', new URL(origin).port, '--strictPort'], {
    cwd: webRoot,
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      KERNEL_ORIGIN: kernelOrigin,
      PUBLIC_ORIGIN: publicOrigin,
      WEB_TEST_STATE_DIR: stateDirectory,
    },
  });
  let output = '';
  for (const stream of [child.stdout, child.stderr])
    stream?.on('data', (chunk: Buffer) => { output = (output + chunk).slice(-12_000); });
  let spawnError: Error | undefined;
  child.once('error', (error) => { spawnError = error; });
  let ended = false;
  const exited = new Promise<void>((resolve) => child.once('close', resolve).once('error', () => resolve()));
  const failIfExited = () => {
    if (spawnError) throw new Error(`web Worker could not start: ${spawnError.message}\n${output}`, { cause: spawnError });
    if (ended || child.exitCode !== null || child.signalCode !== null)
      throw new Error(`web Worker exited during startup: ${output}`);
  };
  child.once('close', () => { ended = true; });
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
        if (response.status === 404) return { child, stateDirectory };
      } catch {
        if (spawnError || ended || child.exitCode !== null || child.signalCode !== null) failIfExited();
      }
      await Bun.sleep(250);
    }
    throw new Error(`web Worker startup timed out: ${output}`);
  } catch (error) {
    await stopWeb({ child, stateDirectory }, exited).catch(() => {});
    throw error;
  }
}

async function stopWeb(web: WebProcess | undefined, exited?: Promise<void>): Promise<void> {
  if (!web) return;
  const { child, stateDirectory } = web;
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
    if (child.exitCode === null && child.signalCode === null) await exited;
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
        try { process.kill(-processGroup!, 'SIGKILL'); } catch {}
        await waitForGroup(10_000);
        throw new Error('web Worker did not stop gracefully');
      }
    }
  } finally {
    await rm(stateDirectory, { recursive: true, force: true });
  }
}

export async function startNativeWebStack(): Promise<NativeWebStack> {
  let kernelServer: ReturnType<typeof Bun.serve> | undefined;
  let durableWorker: Awaited<ReturnType<typeof import('../../../../services/kernel/src/worker.ts').startWorker>> | undefined;
  let webProcess: WebProcess | undefined;
  let driver: SemanticOutcomeDriver | undefined;
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
  try {
    const { createKernel } = await import('../../../../services/kernel/src/http/kernel.ts');
    const { readWorkerConfig, startWorker } = await import('../../../../services/kernel/src/worker.ts');
    let kernel: ReturnType<typeof createKernel> | undefined;
    driver = await createSemanticDriver((dependencies) => {
      kernel = createKernel(dependencies);
      return kernel;
    }, { linkProjection: 'external', strictCleanup: true });

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
    durableWorker = await startWorker(readWorkerConfig(workerEnv), undefined, workerEnv);

    const sourceApp = kernel!;
    const server = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      fetch: (request) => {
        const url = new URL(request.url);
        requests.push({ method: request.method, url: `${url.pathname}${url.search}`, authorization: request.headers.get('authorization') });
        return sourceApp.handle(request);
      },
    });
    kernelServer = server;
    const kernelOrigin = server.url.origin;
    const webOrigin = `http://127.0.0.1:${await freePort()}`;
    let publicOrigin = 'https://rezics.example.test';
    const launch = async () => startWeb(webOrigin, kernelOrigin, publicOrigin);
    webProcess = await launch();

    const stop = () => (stopped ??= (async () => {
      const errors: unknown[] = [];
      const attempt = async (close: () => unknown | Promise<unknown>) => {
        try { await close(); } catch (error) { errors.push(error); }
      };
      await attempt(() => stopWeb(webProcess));
      webProcess = undefined;
      clearInterval(memorySampler);
      await attempt(() => kernelServer?.stop(true));
      kernelServer = undefined;
      await attempt(() => durableWorker?.stop());
      durableWorker = undefined;
      await attempt(() => driver!.close());
      if (errors.length) throw new AggregateError(errors, 'Native web stack cleanup failed');
    })());

    return {
      kernelOrigin,
      web: webOrigin,
      async kernel(path, init = {}, persona) {
        const headers = new Headers(init.headers);
        if (persona) headers.set('authorization', `Bearer ${(await getAccount(persona)).bearer}`);
        return fetch(new URL(path, kernelOrigin), { ...init, headers, redirect: 'manual' });
      },
      async request(url, persona, headers = {}) {
        const requested = new URL(url, webOrigin);
        const target = new URL(requested.pathname + requested.search, webOrigin);
        const outgoing = new Headers(headers);
        if (persona) outgoing.set('authorization', `Bearer ${(await getAccount(persona)).bearer}`);
        return fetch(target, { headers: outgoing, redirect: 'manual' });
      },
      async credentials(persona) { return { authorization: `Bearer ${(await getAccount(persona)).bearer}` }; },
      kernelRequests() { return requests.slice(); },
      peakMemoryBytes() { sampleMemory(); return peakMemory; },
      async restartWeb(options) {
        await stopWeb(webProcess);
        webProcess = undefined;
        publicOrigin = options.publicOrigin;
        webProcess = await launch();
      },
      stop,
    };
  } catch (error) {
    clearInterval(memorySampler);
    await stopWeb(webProcess).catch(() => {});
    kernelServer?.stop(true);
    await durableWorker?.stop().catch(() => {});
    await driver?.close().catch(() => {});
    throw error;
  }
}
