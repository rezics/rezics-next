import { fork, spawn, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { Pool } from 'pg';
import { exportJWK, generateKeyPair } from 'jose';
import { resolveBunCommand } from '../../../../scripts/gate.ts';
import type { SemanticOutcomeDriver } from '../../../../services/kernel/test/semantic/outcome-driver.ts';

export type NativeCredentials = { authorization: string; cookie?: string };
export type NativeKernelRequest = {
  method: string;
  url: string;
  authorization: string | null;
  failure?: { status: number; body: string };
};
export type NativeWebStack = {
  kernelOrigin: string;
  authIssuer: string;
  web: string;
  /** Read fixture identity for form entry, without creating a website session. */
  authPersona(persona: string): Promise<{ accountId: string; email: string }>;
  /** Install the Auth page app on the issuer; undefined removes the page routing. */
  routeAuthPages(handler?: (request: Request) => Response | Promise<Response>): Promise<string>;
  kernel(path: string, init?: RequestInit, persona?: string): Promise<Response>;
  request(url: string, persona?: string, headers?: Record<string, string>): Promise<Response>;
  credentials(persona: string): Promise<NativeCredentials>;
  kernelRequests(): readonly NativeKernelRequest[];
  peakMemoryBytes(): number;
  restartWeb(options: { publicOrigin: string; authIssuer?: string }): Promise<void>;
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

async function startWeb(
  origin: string,
  kernelOrigin: string,
  publicOrigin: string,
  authEnvironment: NodeJS.ProcessEnv,
): Promise<WebProcess> {
  await mkdir(join(repositoryRoot, '.temp'), { recursive: true });
  const stateDirectory = await mkdtemp(join(repositoryRoot, '.temp', 'native-web-state-'));
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    ...authEnvironment,
    KERNEL_ORIGIN: kernelOrigin,
    PUBLIC_ORIGIN: publicOrigin,
    WEB_TEST_STATE_DIR: stateDirectory,
    WRANGLER_SEND_METRICS: 'false',
  };
  const child = spawn(
    process.execPath,
    ['run', 'dev', '--host', '127.0.0.1', '--port', new URL(origin).port, '--strictPort'],
    {
      cwd: webRoot,
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env,
    },
  );
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
          redirect: 'manual',
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
      // Durable workflows can remain asleep beyond the lifetime of a fixture.
      // Give production shutdown a grace period, then terminate only our worker
      // before dropping its database; never wait for scheduled work to wake up.
      const force = setTimeout(() => child.kill('SIGKILL'), 10_000);
      try {
        await exited;
      } finally {
        clearTimeout(force);
      }
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

async function startStack(): Promise<
  Omit<NativeWebStack, 'kernel' | 'request' | 'routeAuthPages'> & { routeAuthPages(origin?: string): Promise<string> }
> {
  let kernelServer: ReturnType<typeof Bun.serve> | undefined;
  let authServer: ReturnType<typeof Bun.serve> | undefined;
  const activeKernelRequests = new Set<Promise<Response>>();
  let durableWorker: { pid?: number; stop(): Promise<void> } | undefined;
  let webProcess: WebProcess | undefined;
  let driver: SemanticOutcomeDriver | undefined;
  let postgresContainer: string | undefined;
  let runtimeDirectory: string | undefined;
  let closeAuth: (() => Promise<void>) | undefined;
  let closePageWorkflows: (() => Promise<void>) | undefined;
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
      clearInterval(memorySampler);
      console.info('Native web stack cleanup: stopping listeners and durable worker');
      await Promise.all([
        attempt(() => stopWeb(webProcess)),
        attempt(() => authServer?.stop(true)),
        attempt(async () => {
          // Match the production HTTP host: drain handlers before closing the
          // pools they use, including requests whose clients disconnected.
          await kernelServer?.stop(false);
          await Promise.allSettled([...activeKernelRequests]);
          console.info('Native web stack cleanup: kernel HTTP handlers drained');
        }),
        attempt(() => durableWorker?.stop()),
      ]);
      webProcess = undefined;
      kernelServer = undefined;
      durableWorker = undefined;
      // Auth holds the harness's kernel Access and registration ports. Drain it
      // while those ports and their pool still exist, then release the kernel.
      console.info('Native web stack cleanup: closing Auth fixture');
      await attempt(() => closePageWorkflows?.());
      await attempt(() => closeAuth?.());
      console.info('Native web stack cleanup: closing kernel fixture');
      await attempt(() => driver?.close());
      console.info('Native web stack cleanup: kernel fixture closed');
      if (runtimeDirectory) await attempt(() => rm(runtimeDirectory!, { recursive: true, force: true }));
      if (postgresContainer) {
        console.info('Native web stack cleanup: removing owned PostgreSQL container');
        const removed = Bun.spawnSync(['docker', 'rm', '-fv', postgresContainer]);
        if (removed.exitCode !== 0)
          errors.push(new Error(`Could not remove owned PostgreSQL container: ${removed.stderr.toString()}`));
        postgresContainer = undefined;
      }
      if (originalDatabaseUrl === undefined) delete process.env.DATABASE_URL;
      else process.env.DATABASE_URL = originalDatabaseUrl;
      if (errors.length) throw new AggregateError(errors, 'Native web stack cleanup failed');
      console.info('Native web stack cleanup: complete');
    })());
  try {
    console.info('Native web stack startup: registering kernel SQL modules');
    // Match the kernel test preload before evaluating anything that imports SQL.
    await import(new URL('../../../../services/kernel/node_modules/reylo/src/register.js', import.meta.url).href);
    if (!process.env.DATABASE_URL) {
      console.info('Native web stack startup: starting PostgreSQL');
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
      console.info('Native web stack startup: migrating PostgreSQL');
      migrate(databaseUrl);
    }
    console.info('Native web stack startup: preparing SQL analysis');
    // Give Reylo an owned cache and the migrated template for SQL analysis.
    await mkdir(join(repositoryRoot, '.temp'), { recursive: true });
    runtimeDirectory = await mkdtemp(join(repositoryRoot, '.temp', 'native-kernel-runtime-'));
    const { writeReyloProject } = await import('../../../../services/kernel/scripts/check.ts');
    // PostgreSQL cannot clone a template while Reylo is connected to it. The
    // kernel runner also gives SQL analysis its own copy, separate from fixtures.
    const source = new URL(process.env.DATABASE_URL!);
    const template = decodeURIComponent(source.pathname.slice(1));
    const analysisDatabase = `native_web_analysis_${randomBytes(16).toString('hex')}`;
    const adminUrl = new URL(source);
    adminUrl.pathname = '/postgres';
    const admin = new Pool({ connectionString: adminUrl.href, max: 1 });
    try {
      // Inform the supervisor before allocation, so even failed setup is cleaned.
      process.send?.({ analysisDatabase } satisfies HostReply);
      await admin.query(`CREATE DATABASE "${analysisDatabase}" TEMPLATE "${template.replaceAll('"', '""')}"`);
    } finally {
      await admin.end();
    }
    source.pathname = `/${analysisDatabase}`;
    process.env.REYLO_CONFIG = writeReyloProject(runtimeDirectory, source.href);
    process.env.KERNEL_POOL_ACQUIRE_TIMEOUT_MS ??= '2000';
    await import('../../../../services/kernel/test/support/fixture-event-types.ts');
    const { workerTestEnv } = await import('../../../../services/kernel/test/support/worker-env.ts');
    const { sharedAuth, closeOwnedSemanticAuth } =
      await import('../../../../services/kernel/test/semantic/outcome-auth.ts');
    closeAuth = closeOwnedSemanticAuth;
    const auth = await sharedAuth(new URL(process.env.DATABASE_URL!), undefined, true);
    // Observe the harness's actual issuance, retaining its Auth cookie for the
    // website code flow. Never copy fixture passwords or manufacture sessions.
    const authCookies = new Map<string, string>();
    const authHandler = auth.service.handler.bind(auth.service);
    let pageOrigin: string | undefined;
    let signupHandler: ((request: Request) => Promise<Response>) | undefined;
    const pagePaths = new Set([
      '/login',
      '/signup',
      '/consent',
      '/recovery',
      '/security',
      '/step-up',
      '/account/delete',
      '/organizations/new',
    ]);
    auth.service.handler = async (request) => {
      const url = new URL(request.url);
      // The development app serves its source modules at Vite's standard paths.
      // Production bundles instead use only /auth-assets/.
      const asset =
        ['/auth-assets/', '/@vite/', '/@id/', '/@fs/', '/src/', '/node_modules/', '/_serverFn/'].some((prefix) =>
          url.pathname.startsWith(prefix),
        ) || url.pathname === '/@react-refresh';
      if (pageOrigin && ((['GET', 'HEAD'].includes(request.method) && pagePaths.has(url.pathname)) || asset)) {
        const target = new URL(url.pathname + url.search, pageOrigin);
        const forwarded = new Request(target, request);
        forwarded.headers.set('x-native-auth-url', request.url);
        return fetch(forwarded, { redirect: 'manual' });
      }
      if (pageOrigin && request.method === 'POST' && url.pathname === '/signup') return signupHandler!(request);
      const response = await authHandler(request);
      if (
        new URL(request.url).pathname === '/token' &&
        request.headers.get('content-type') === 'application/json' &&
        response.ok
      ) {
        const token = (await response.clone().json()) as { access_token: string };
        const cookie = request.headers.get('cookie');
        if (cookie) authCookies.set(token.access_token, cookie);
      }
      return response;
    };
    // The semantic harness reads DATABASE_URL during module evaluation.
    const { createSemanticDriver } = await import('../../../../services/kernel/test/semantic/outcome-driver.ts');
    const { createKernel } = await import('../../../../services/kernel/src/http/kernel.ts');
    let kernel: ReturnType<typeof createKernel> | undefined;
    console.info('Native web stack startup: creating native kernel and Auth fixtures');
    driver = await createSemanticDriver(
      (dependencies) => {
        kernel = createKernel(dependencies);
        return kernel;
      },
      {
        linkProjection: 'external',
        strictCleanup: true,
      },
    );

    authServer = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: (request) => auth.service.handler(request) });

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
    console.info('Native web stack startup: starting durable-work worker');
    durableWorker = await startDurableWorker(workerEnv);

    const sourceApp = kernel!;
    const server = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      fetch: async (request) => {
        const url = new URL(request.url);
        const observed: NativeKernelRequest = {
          method: request.method,
          url: `${url.pathname}${url.search}`,
          authorization: request.headers.get('authorization'),
        };
        requests.push(observed);
        const handling = (async () => {
          const response = await sourceApp.handle(request);
          if (!response.ok) observed.failure = { status: response.status, body: await response.clone().text() };
          return response;
        })();
        activeKernelRequests.add(handling);
        try {
          return await handling;
        } finally {
          activeKernelRequests.delete(handling);
        }
      },
    });
    kernelServer = server;
    const kernelOrigin = server.url.origin;
    const webOrigin = `http://127.0.0.1:${await freePort()}`;
    const { actionCatalogue } = await import('../../../../services/kernel/src/http/request.ts');
    const scopes = ['openid', 'offline_access', ...actionCatalogue(sourceApp).keys()];
    const key = await generateKeyPair('ES256', { extractable: true });
    const kid = `native-web-${randomBytes(8).toString('hex')}`;
    await auth.service.internal.registerWebsiteClient({
      publicJwks: {
        keys: [{ ...(await exportJWK(key.publicKey)), kid, alg: 'ES256', use: 'sig' }],
      } as Parameters<typeof auth.service.internal.registerWebsiteClient>[0]['publicJwks'],
      redirectUris: [`${webOrigin}/auth/callback`],
      postLogoutRedirectUris: [`${webOrigin}/`],
      scopes,
    });
    const authEnvironment = {
      AUTH_ISSUER: auth.issuer,
      API_RESOURCE: auth.audience,
      WEBSITE_CLIENT_ID: 'rezics-website',
      WEBSITE_CLIENT_KEY: JSON.stringify({ ...(await exportJWK(key.privateKey)), kid, alg: 'ES256', use: 'sig' }),
      WEBSITE_SCOPES: scopes.join(' '),
    };
    const webCookies = new Map<string, Promise<string | undefined>>();
    const responseCookie = (response: Response, name: string) => {
      const value = response.headers
        .getSetCookie()
        .find((line) => line.startsWith(`${name}=`))
        ?.split(';')[0];
      if (!value) throw new Error(`Native web sign-in did not issue ${name}: ${response.status}`);
      return value;
    };
    const websiteCookie = async (bearer: string) => {
      const cookie = authCookies.get(bearer);
      if (!cookie) throw new Error('The semantic harness did not issue an Auth session for this persona');
      const login = await fetch(`${webOrigin}/auth/sign-in`, { redirect: 'manual' });
      const authorize = new URL(login.headers.get('location')!, webOrigin);
      if (authorize.origin !== auth.issuer)
        throw new Error(`Native web sign-in left its Auth listener: ${login.status}`);
      const authorized = await fetch(authorize, { headers: { cookie }, redirect: 'manual' });
      // A revoked persona still carries its original bearer to the Worker. Auth
      // can refuse a new browser session; that must not replace the served read.
      if (authorized.status === 400 || authorized.status === 401 || authorized.status === 403) return undefined;
      const callback = new URL(authorized.headers.get('location')!, auth.issuer);
      if (callback.origin !== webOrigin || callback.pathname !== '/auth/callback')
        throw new Error(`Native Auth did not return to the owned web callback: ${authorized.status}`);
      const completed = await fetch(callback, {
        headers: { cookie: responseCookie(login, '__Host-rezics_login') },
        redirect: 'manual',
      });
      return responseCookie(completed, '__Host-rezics_session');
    };
    let publicOrigin = 'https://rezics.example.test';
    let authPageOrigin: string | undefined;
    const launch = async () =>
      startWeb(webOrigin, kernelOrigin, publicOrigin, {
        ...authEnvironment,
        ...(authPageOrigin ? { AUTH_ISSUER: authPageOrigin } : {}),
      });
    console.info('Native web stack startup: starting production web Worker');
    webProcess = await launch();

    return {
      kernelOrigin,
      authIssuer: authServer.url.origin,
      web: webOrigin,
      async authPersona(persona) {
        const { accountId } = await getAccount(persona);
        const result = await auth.database.query<{ email: string }>('SELECT email FROM "user" WHERE id=$1', [
          accountId,
        ]);
        if (!result.rows[0]?.email) throw new Error(`Native ${persona} has no sign-in email`);
        return { accountId, email: result.rows[0].email };
      },
      async routeAuthPages(origin) {
        if (origin && !signupHandler) {
          // Replace the fixture's workflow executor once, on the same database and
          // native registration ports, adding only public signup's Siteverify port.
          // Two Auth workflow executors cannot coexist in one process.
          const { createAccountWorkflows } = await import('../../../../services/auth/src/index.ts');
          const { createRegistrationPorts } =
            await import('../../../../services/kernel/test/support/registration-ports.ts');
          const runtime = driver!.fixtures.runtime;
          const keys = new Map(
            runtime.sessionKeys.split(',').map((entry) => {
              const [id, key] = entry.split(':');
              return [Number(id), Buffer.from(key!, 'base64url')] as const;
            }),
          );
          const { ports } = createRegistrationPorts({
            pool: driver!.fixtures.pool,
            authPool: auth.database,
            routeKey: Buffer.from(runtime.routeKey, 'base64url'),
            referenceKeys: { current: Math.max(...keys.keys()), keys },
          });
          await auth.host.workflows.close();
          const workflows = createAccountWorkflows({
            database: auth.database,
            systemDatabaseUrl: auth.database.options.connectionString!,
            systemDatabasePool: auth.database,
            stagingKey: randomBytes(32),
            auth: auth.service,
            access: ports,
            handleSignals: false,
            turnstile: {
              secret: '1x0000000000000000000000000000000AA',
              // An explicit test provider boundary, as in Auth's own signup tests.
              fetch: (async (_url, init) => {
                const form = new URLSearchParams(String(init?.body));
                return Response.json({
                  success: form.get('response') === 'native-test-token',
                  action: 'signup',
                  hostname: new URL(auth.issuer).hostname,
                });
              }) as typeof fetch,
            },
          });
          closePageWorkflows = () => workflows.close();
          await workflows.start();
          auth.host.workflows = workflows;
          signupHandler = workflows.handler;
        }
        pageOrigin = origin;
        return auth.issuer;
      },
      async credentials(persona) {
        const { bearer } = await getAccount(persona);
        let cookie = webCookies.get(persona);
        if (!cookie) {
          cookie = websiteCookie(bearer);
          webCookies.set(persona, cookie);
        }
        const session = await cookie;
        return { authorization: `Bearer ${bearer}`, ...(session ? { cookie: session } : {}) };
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
        webCookies.clear();
        publicOrigin = options.publicOrigin;
        authPageOrigin = options.authIssuer;
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
  | { ready: { kernelOrigin: string; authIssuer: string; web: string; databaseUrl: string }; observation: Observation }
  | { id: number; value?: unknown; error?: string; observation: Observation }
  | { startupError: string }
  | { analysisDatabase: string };
type HostCall = {
  id: number;
  method: 'credentials' | 'authPersona' | 'routeAuthPages' | 'restartWeb' | 'observe' | 'stop';
  argument?: string;
  options?: { publicOrigin: string; authIssuer?: string };
};

export async function startNativeWebStack(): Promise<NativeWebStack> {
  const originalDatabaseUrl = process.env.DATABASE_URL;
  let analysisDatabase: string | undefined;
  const host = fork(import.meta.filename, [], {
    execPath: resolveBunCommand(['bun'], repositoryRoot)[0]!,
    execArgv: [],
    cwd: repositoryRoot,
    env: { ...process.env, NATIVE_WEB_STACK_HOST: '1' },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  let pageBridge: ReturnType<typeof Bun.serve> | undefined;
  let output = '';
  for (const stream of [host.stdout, host.stderr])
    stream?.on('data', (chunk: Buffer) => {
      output = (output + chunk).slice(-12_000);
    });
  // Process exit is the ownership boundary. The stdio `close` event can wait
  // for inherited pipes even after the host itself has ended.
  const exited = new Promise<void>((resolve) => host.once('exit', () => resolve()).once('error', () => resolve()));
  const terminate = async () => {
    if (host.exitCode === null && host.signalCode === null) host.kill('SIGTERM');
    await exited;
    // Reylo's connection lives until its host exits. A borrowed cluster must
    // retain all of its other databases; an owned container was already removed.
    if (analysisDatabase && originalDatabaseUrl) {
      const adminUrl = new URL(originalDatabaseUrl);
      adminUrl.pathname = '/postgres';
      const admin = new Pool({ connectionString: adminUrl.href, max: 1 });
      try {
        await admin.query(`DROP DATABASE IF EXISTS "${analysisDatabase}" WITH (FORCE)`);
      } finally {
        await admin.end();
      }
      analysisDatabase = undefined;
    }
  };
  let serial = 0;
  let observation: Observation = { requests: [], peakMemory: 0 };
  let closed: Promise<void> | undefined;
  let dead: Error | undefined;
  const pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void }>();
  let ready!: (value: { kernelOrigin: string; authIssuer: string; web: string; databaseUrl: string }) => void;
  let failed!: (error: Error) => void;
  const startup = new Promise<{ kernelOrigin: string; authIssuer: string; web: string; databaseUrl: string }>(
    (resolve, reject) => {
      ready = resolve;
      failed = reject;
    },
  );
  const fail = (error: Error) => {
    dead = error;
    failed(error);
    for (const call of pending.values()) call.reject(error);
    pending.clear();
  };
  host.on('message', (reply: HostReply) => {
    if ('analysisDatabase' in reply) {
      analysisDatabase = reply.analysisDatabase;
      return;
    }
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
    const { kernelOrigin, authIssuer, web, databaseUrl } = await startup;
    // Retain the existing fixture's observable setup environment. The host has
    // its own environment, including Reylo config and pool timeout overrides.
    if (originalDatabaseUrl === undefined) process.env.DATABASE_URL = databaseUrl;
    const credentials = (persona: string) => call('credentials', persona) as Promise<NativeCredentials>;
    const authenticatedHeaders = async (input: HeadersInit | undefined, persona?: string) => {
      const headers = new Headers(input);
      if (persona && persona !== 'anonymous') {
        const issued = await credentials(persona);
        headers.set('authorization', issued.authorization);
        if (issued.cookie) headers.set('cookie', [headers.get('cookie'), issued.cookie].filter(Boolean).join('; '));
      }
      return headers;
    };
    const observe = async (response: Response) => {
      await call('observe');
      return response;
    };
    return {
      kernelOrigin,
      authIssuer,
      web,
      credentials,
      authPersona: (persona) => call('authPersona', persona) as Promise<{ accountId: string; email: string }>,
      async routeAuthPages(handler) {
        await pageBridge?.stop(true);
        pageBridge = handler
          ? Bun.serve({
              hostname: '127.0.0.1',
              port: 0,
              fetch(request) {
                const url = request.headers.get('x-native-auth-url');
                if (!url) return new Response('Missing issuer URL', { status: 400 });
                const forwarded = new Request(url, request);
                forwarded.headers.delete('x-native-auth-url');
                return handler(forwarded);
              },
            })
          : undefined;
        return (await call('routeAuthPages', pageBridge?.url.origin)) as string;
      },
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
        const target = new URL(web);
        // Assign the path rather than resolving it: a leading // is still a
        // document path, never authority to contact a different listener.
        target.pathname = requested.pathname;
        target.search = requested.search;
        const headers = await authenticatedHeaders(suppliedHeaders, persona);
        // Keep the HTTP Response itself: observing never reads its body, replaces
        // its headers, changes its status, or follows a Worker redirect.
        return observe(await fetch(target, { headers, redirect: 'manual' }));
      },
      async restartWeb(options) {
        const id = ++serial;
        await new Promise<void>((resolve, reject) => {
          pending.set(id, { resolve: () => resolve(), reject });
          host.send({ id, method: 'restartWeb', options } satisfies HostCall);
        });
      },
      stop() {
        return (closed ??= (async () => {
          const diagnostic = setTimeout(
            () =>
              console.error(
                `Native stack is still stopping (exit=${host.exitCode}, signal=${host.signalCode}):\n${output}`,
              ),
            60_000,
          );
          try {
            await call('stop');
          } finally {
            try {
              await pageBridge?.stop(true);
              await terminate();
              if (originalDatabaseUrl === undefined && process.env.DATABASE_URL === databaseUrl)
                delete process.env.DATABASE_URL;
            } finally {
              clearTimeout(diagnostic);
            }
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
  const send = (reply: HostReply, exitCode?: number) => {
    process.send!(reply, (error) => {
      // The process owns Reylo's analysis connection as well as the IPC channel.
      // Terminal cleanup ends both, after its result has reached the supervisor.
      if (exitCode !== undefined) process.exit(error ? 1 : exitCode);
    });
  };
  try {
    const stack = await startStack();
    let observedRequests = 0;
    const observation = (): Observation => {
      const requests = stack.kernelRequests();
      const next = { requests: requests.slice(observedRequests), peakMemory: stack.peakMemoryBytes() };
      observedRequests = requests.length;
      return next;
    };
    process.on('message', async ({ id, method, argument, options }: HostCall) => {
      try {
        let value: unknown;
        if (method === 'credentials') value = await stack.credentials(argument!);
        else if (method === 'authPersona') value = await stack.authPersona(argument!);
        else if (method === 'routeAuthPages') value = await stack.routeAuthPages(argument);
        else if (method === 'restartWeb') await stack.restartWeb(options!);
        else if (method === 'stop') await stack.stop();
        send({ id, value, observation: observation() } satisfies HostReply, method === 'stop' ? 0 : undefined);
      } catch (error) {
        send(
          {
            id,
            error: errorDetails(error),
            observation: observation(),
          } satisfies HostReply,
          method === 'stop' ? 1 : undefined,
        );
      }
    });
    send({
      ready: {
        kernelOrigin: stack.kernelOrigin,
        authIssuer: stack.authIssuer,
        web: stack.web,
        databaseUrl: process.env.DATABASE_URL!,
      },
      observation: observation(),
    } satisfies HostReply);
  } catch (error) {
    send(
      {
        startupError: errorDetails(error),
      } satisfies HostReply,
      1,
    );
  }
}
