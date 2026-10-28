import { spawn, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { resolve } from 'node:path';
import { createSemanticDriver, type SemanticOutcomeDriver } from '../../../../services/kernel/test/semantic/outcome-driver.ts';

export type NativeCredentials = { authorization: string };
export type NativeWebStack = {
  kernelOrigin: string;
  web: string;
  kernel(path: string, init?: RequestInit, persona?: string): Promise<Response>;
  request(url: string, persona?: string, headers?: Record<string, string>): Promise<Response>;
  credentials(persona: string): Promise<NativeCredentials>;
  restartWeb(options: { publicOrigin: string }): Promise<void>;
  stop(): Promise<void>;
};

const webRoot = resolve(import.meta.dir, '../..');
const repositoryRoot = resolve(webRoot, '../..');

async function startWeb(origin: string, kernelOrigin: string, publicOrigin: string): Promise<ChildProcess> {
  const child = spawn('bun', ['run', 'dev', '--host', '127.0.0.1', '--port', new URL(origin).port, '--strictPort'], {
    cwd: webRoot,
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      KERNEL_ORIGIN: kernelOrigin,
      PUBLIC_ORIGIN: publicOrigin,
      WEB_TEST_STATE_DIR: `${repositoryRoot}/.temp/native-web-${randomBytes(8).toString('hex')}`,
    },
  });
  let output = '';
  for (const stream of [child.stdout, child.stderr]) stream?.on('data', (chunk: Buffer) => { output = (output + chunk).slice(-12000); });
  const exited = new Promise<void>((resolve) => child.once('exit', resolve));
  const deadline = Date.now() + 150_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) throw new Error(`web Worker exited during startup: ${output}`);
    try {
      const response = await fetch(`${origin}/en/subjects/00000000-0000-4000-8000-000000000000`, { signal: AbortSignal.timeout(5000) });
      await response.arrayBuffer();
      if (response.status === 404) return child;
    } catch { /* listener not ready */ }
    await Bun.sleep(250);
  }
  child.kill('SIGTERM');
  await Promise.race([exited, Bun.sleep(5000)]);
  throw new Error(`web Worker startup timed out: ${output}`);
}

async function stopChild(child: ChildProcess | undefined): Promise<void> {
  if (!child?.pid) return;
  try { process.kill(-child.pid, 'SIGTERM'); } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
    return;
  }
  const exited = new Promise<void>((resolve) => child.once('close', () => resolve()));
  if (child.exitCode === null && child.signalCode === null) await Promise.race([exited, Bun.sleep(10_000)]);
  if (child.exitCode === null && child.signalCode === null) {
    try { process.kill(-child.pid, 'SIGKILL'); } catch {}
    await exited;
    throw new Error('web Worker did not stop gracefully');
  }
}

export async function startNativeWebStack(): Promise<NativeWebStack> {
  let kernelServer: ReturnType<typeof Bun.serve> | undefined;
  let child: ChildProcess | undefined;
  let stopped: Promise<void> | undefined;
  const accounts = new Map<string, Promise<{ accountId: string; bearer: string }>>();
  let driver: SemanticOutcomeDriver | undefined;
  const getAccount = (persona: string) => {
    let account = accounts.get(persona);
    if (!account) {
      account = driver!.fixtures.person(`native-web-${persona}`);
      accounts.set(persona, account);
    }
    return account;
  };
  try {
    const { createKernel } = await import('../../../../services/kernel/src/http/kernel.ts');
    let kernel: ReturnType<typeof createKernel> | undefined;
    driver = await createSemanticDriver((dependencies) => {
      kernel = createKernel(dependencies);
      return kernel;
    });
    const sourceApp = kernel!;
    const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: (request) => sourceApp.handle(request) });
    kernelServer = server;
    const kernelOrigin = server.url.origin;
    const webOrigin = `http://127.0.0.1:${await freePort()}`;
    let publicOrigin = 'https://rezics.example.test';
    const launch = async () => startWeb(webOrigin, kernelOrigin, publicOrigin);
    child = await launch();
    const stop = () => (stopped ??= (async () => {
      await stopChild(child);
      child = undefined;
      kernelServer?.stop(true);
      await driver!.close();
    })());
    return {
      kernelOrigin,
      web: webOrigin,
      async kernel(path, init = {}, persona) {
        const headers = new Headers(init.headers);
        if (persona) headers.set('authorization', (await getAccount(persona)).bearer);
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
      async restartWeb(options) {
        await stopChild(child);
        publicOrigin = options.publicOrigin;
        child = await launch();
      },
      stop,
    };
  } catch (error) {
    await stopChild(child).catch(() => {});
    kernelServer?.stop(true);
    await driver?.close().catch(() => {});
    throw error;
  }
}

async function freePort(): Promise<number> {
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response() });
  const port = server.port;
  server.stop(true);
  return port;
}
